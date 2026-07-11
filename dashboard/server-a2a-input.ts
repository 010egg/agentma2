import type { Message } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError } from '@a2a-js/sdk/server';
import type {
  AskUserQuestionAnswer,
  PermissionDecision,
  PermissionRequest,
  RequestPermissionFn,
  RequestUserQuestionFn,
} from './server-agent.ts';
import type { A2ATaskScope } from './server-a2a-store.ts';

export type A2AInputDescriptor =
  | {
    type: 'permission';
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    description?: string;
  }
  | {
    type: 'questions';
    questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
  };

type PauseCallbacks = {
  onPause: (descriptor: A2AInputDescriptor) => void;
  onResume: () => void;
  onTimeout: () => void;
};

type PendingInput = {
  descriptor: A2AInputDescriptor;
  callbacks: PauseCallbacks;
  timer: NodeJS.Timeout;
  resolve: (value: PermissionDecision | AskUserQuestionAnswer) => void;
  reject: (error: Error) => void;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function configuredTimeoutMs() {
  const value = Number(process.env.AGENTMA_A2A_INPUT_TIMEOUT_MS);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function key(scope: A2ATaskScope, taskId: string) {
  return `${scope.tenantId}\0${scope.templateId}\0${scope.callerSub}\0${taskId}`;
}

function messageData(message: Message) {
  const data = message.parts.find((part) => part.content?.$case === 'data')?.content?.value;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  const text = message.parts
    .filter((part) => part.content?.$case === 'text')
    .map((part) => part.content?.value || '')
    .join('\n')
    .trim();
  return text ? { decision: text.toLocaleLowerCase('en-US') } : {};
}

function permissionDecision(data: Record<string, unknown>): PermissionDecision {
  if (data.decision !== 'allow' && data.decision !== 'deny') {
    throw new RequestMalformedError('Permission continuation requires decision "allow" or "deny".');
  }
  const updatedInput = data.updatedInput && typeof data.updatedInput === 'object' && !Array.isArray(data.updatedInput)
    ? data.updatedInput as Record<string, unknown>
    : undefined;
  return {
    decision: data.decision,
    reason: typeof data.reason === 'string' ? data.reason.slice(0, 1000) : undefined,
    updatedInput,
    rememberForSession: data.rememberForSession === true,
  };
}

function questionAnswer(data: Record<string, unknown>): AskUserQuestionAnswer {
  if (!data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) {
    throw new RequestMalformedError('Question continuation requires an answers object.');
  }
  const answers = Object.fromEntries(Object.entries(data.answers as Record<string, unknown>).flatMap(([question, answer]) => (
    typeof answer === 'string' && question.trim() ? [[question.trim(), answer.slice(0, 4000)] as const] : []
  )));
  if (!Object.keys(answers).length) throw new RequestMalformedError('Question continuation requires at least one string answer.');
  return { answers, reason: typeof data.reason === 'string' ? data.reason.slice(0, 1000) : undefined };
}

export class A2AInputRegistry {
  private readonly pending = new Map<string, PendingInput>();

  constructor(private readonly timeoutMs = configuredTimeoutMs()) {}

  private register<T extends PermissionDecision | AskUserQuestionAnswer>(
    scope: A2ATaskScope,
    taskId: string,
    descriptor: A2AInputDescriptor,
    callbacks: PauseCallbacks,
  ): Promise<T> {
    const registryKey = key(scope, taskId);
    if (this.pending.has(registryKey)) {
      return Promise.reject(new Error('An A2A input request is already pending for this task.'));
    }
    callbacks.onPause(descriptor);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(registryKey);
        if (!current) return;
        this.pending.delete(registryKey);
        current.callbacks.onTimeout();
        current.reject(Object.assign(new Error('A2A input request timed out.'), { name: 'A2AInputTimeoutError' }));
      }, this.timeoutMs);
      this.pending.set(registryKey, {
        descriptor,
        callbacks,
        timer,
        resolve: resolve as PendingInput['resolve'],
        reject,
      });
    });
  }

  requestPermission(
    scope: A2ATaskScope,
    taskId: string,
    callbacks: PauseCallbacks,
  ): RequestPermissionFn {
    return async (request: PermissionRequest) => await this.register<PermissionDecision>(scope, taskId, {
      type: 'permission',
      toolName: request.toolName,
      input: request.input,
      title: request.title || request.displayName,
      description: request.description,
    }, callbacks);
  }

  requestQuestions(
    scope: A2ATaskScope,
    taskId: string,
    callbacks: PauseCallbacks,
  ): RequestUserQuestionFn {
    return async (request) => await this.register<AskUserQuestionAnswer>(scope, taskId, {
      type: 'questions',
      questions: request.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options.map((option) => ({ label: option.label, description: option.description })),
        multiSelect: question.multiSelect,
      })),
    }, callbacks);
  }

  resume(scope: A2ATaskScope, taskId: string, message: Message, beforeResume?: () => void) {
    const registryKey = key(scope, taskId);
    const current = this.pending.get(registryKey);
    if (!current) throw new TaskNotFoundError('No input-required interaction is pending for this task.');
    const data = messageData(message);
    const value = current.descriptor.type === 'permission'
      ? permissionDecision(data)
      : questionAnswer(data);
    clearTimeout(current.timer);
    this.pending.delete(registryKey);
    beforeResume?.();
    current.callbacks.onResume();
    current.resolve(value);
    return current.descriptor;
  }

  cancel(scope: A2ATaskScope, taskId: string) {
    const registryKey = key(scope, taskId);
    const current = this.pending.get(registryKey);
    if (!current) return false;
    clearTimeout(current.timer);
    this.pending.delete(registryKey);
    current.reject(Object.assign(new Error('A2A input request canceled.'), { name: 'AbortError' }));
    return true;
  }

  has(scope: A2ATaskScope, taskId: string) {
    return this.pending.has(key(scope, taskId));
  }
}
