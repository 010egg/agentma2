import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/server';
import {
  runAgent,
  type AgentEvent,
  type AgentRunResult,
  type RunAgentOptions,
} from './server-agent.ts';
import {
  A2AStoreError,
  a2aTaskStateIsTerminal,
  appendA2AArtifact,
  appendA2AMessage,
  appendA2ATaskEvent,
  createA2ATask,
  findA2ATaskByMessageId,
  getA2ATask,
  listA2AArtifacts,
  listA2AMessages,
  listA2ATaskEvents,
  transitionA2ATask,
  type A2ATaskEventRecord,
  type A2ATaskRecord,
  type A2ATaskScope,
} from './server-a2a-store.ts';
import {
  checkUserRunQuota,
  getDataLocation,
  getMe,
  recordConversationStarted,
  recordUserRunTokens,
  resolveProviderProfileForModel,
  resolveQuotaUserId,
  type AuthIdentity,
} from './server-store.ts';
import type { RunOutcome } from './src/simulator/run-state.ts';
import {
  A2AInputRegistry,
  type A2AInputDescriptor,
} from './server-a2a-input.ts';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_PARTS = 64;
const MAX_LIVE_SUBSCRIBERS = 32;
const MAX_SUBSCRIBER_QUEUE = 256;
const EVENT_REPLAY_PAGE_SIZE = 1000;
const DELTA_FLUSH_BYTES = 512;
const DELTA_FLUSH_DELAY_MS = 40;

type RunAgentImplementation = (options: RunAgentOptions) => Promise<AgentRunResult>;

type PreparedRun = {
  model: string;
  apiKey: string;
  baseUrl?: string;
  quotaUserId: string | null;
  executionSub: string;
  executionRole: string | null;
};

type LiveRun = {
  key: string;
  scope: A2ATaskScope;
  taskId: string;
  contextId: string;
  template: Record<string, unknown>;
  prepared: PreparedRun;
  abortController: AbortController;
  subscribers: Set<EventQueue>;
  done: Promise<void>;
  resolveDone: () => void;
  doneResolved: boolean;
  outputText: string;
  deltaBuffer: string;
  deltaTimer: NodeJS.Timeout | null;
  textArtifactId: string;
  emittedTextArtifact: boolean;
  outcome: RunOutcome;
  errorMessage: string;
};

class EventQueue {
  private readonly items: A2ATaskEventRecord[] = [];
  private readonly waiters: Array<(value: IteratorResult<A2ATaskEventRecord>) => void> = [];
  private closed = false;

  push(item: A2ATaskEventRecord) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return true;
    }
    if (this.items.length >= MAX_SUBSCRIBER_QUEUE) {
      this.close();
      return false;
    }
    this.items.push(item);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<A2ATaskEventRecord>> {
    const item = this.items.shift();
    if (item) return { value: item, done: false };
    if (this.closed) return { value: undefined, done: true };
    return await new Promise((resolve) => this.waiters.push(resolve));
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((item) => {
    const text = typeof item === 'string' ? item.trim() : '';
    return text ? [text] : [];
  })));
}

function textPart(value: string) {
  return {
    content: { $case: 'text' as const, value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

function dataPart(value: unknown) {
  return {
    content: { $case: 'data' as const, value },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function statusEvent(
  taskId: string,
  contextId: string,
  state: TaskState,
  message?: Message,
): StreamResponse {
  const update: TaskStatusUpdateEvent = {
    taskId,
    contextId,
    status: { state, message, timestamp: new Date().toISOString() },
    metadata: undefined,
  };
  return { payload: { $case: 'statusUpdate', value: update } };
}

function artifactEvent(
  taskId: string,
  contextId: string,
  artifact: Artifact,
  append: boolean,
  lastChunk: boolean,
): StreamResponse {
  const update: TaskArtifactUpdateEvent = {
    taskId,
    contextId,
    artifact,
    append,
    lastChunk,
    metadata: undefined,
  };
  return { payload: { $case: 'artifactUpdate', value: update } };
}

function mapStoreError(error: unknown) {
  if (error instanceof A2AStoreError && (error.code === 'invalid_input' || error.code === 'invalid_cursor')) {
    return new RequestMalformedError(error.message);
  }
  return error;
}

function taskKey(scope: A2ATaskScope, taskId: string) {
  return `${scope.tenantId}\0${scope.templateId}\0${scope.callerSub}\0${taskId}`;
}

function isStreamResponse(value: unknown): value is StreamResponse {
  if (!value || typeof value !== 'object') return false;
  const payload = (value as StreamResponse).payload;
  return Boolean(payload && ['task', 'message', 'statusUpdate', 'artifactUpdate'].includes(payload.$case));
}

function safeSeedSegment(value: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return normalized || crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function resolveSeedDir(tenantId: string, template: Record<string, unknown>) {
  const templateId = typeof template.id === 'string' ? template.id.trim() : '';
  if (!templateId || typeof template.seedDir !== 'string' || !template.seedDir.trim()) return undefined;
  const directory = path.join(
    getDataLocation().dataDir,
    'agent-seeds',
    safeSeedSegment(tenantId),
    safeSeedSegment(templateId),
  );
  return fs.existsSync(directory) ? directory : undefined;
}

function promptFromMessage(message: Message) {
  if (!message.messageId.trim()) throw new RequestMalformedError('message.messageId is required.');
  if (message.role !== Role.ROLE_USER) throw new RequestMalformedError('message.role must be ROLE_USER.');
  if (!message.parts.length) throw new RequestMalformedError('message.parts must not be empty.');
  if (message.parts.length > MAX_PARTS) throw new RequestMalformedError(`message.parts supports at most ${MAX_PARTS} items.`);
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > MAX_MESSAGE_BYTES) {
    throw new RequestMalformedError(`message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
  }
  const values = message.parts.map((part, index) => {
    if (part.content?.$case === 'text') return part.content.value;
    if (part.content?.$case === 'data') return JSON.stringify(part.content.value);
    throw new RequestMalformedError(`message.parts[${index}] content type is not supported yet.`);
  }).filter(Boolean);
  const prompt = values.join('\n').trim();
  if (!prompt) throw new RequestMalformedError('message does not contain usable text or data.');
  return prompt;
}

export function a2aTaskToProtocol(
  scope: A2ATaskScope,
  record: A2ATaskRecord,
  historyLength?: number,
  includeArtifacts = true,
): Task {
  const limit = historyLength === undefined
    ? undefined
    : !Number.isFinite(historyLength) || historyLength <= 0
      ? 0
      : Math.min(1000, Math.floor(historyLength));
  return {
    id: record.id,
    contextId: record.contextId,
    status: {
      state: record.state,
      message: record.statusMessage || record.finalMessage || undefined,
      timestamp: new Date(record.updatedAt).toISOString(),
    },
    artifacts: includeArtifacts
      ? listA2AArtifacts(scope, record.id).map((item) => item.artifact)
      : [],
    history: listA2AMessages(scope, record.id, limit).map((item) => item.message),
    metadata: undefined,
  };
}

export class A2AExecutionManager {
  private readonly liveRuns = new Map<string, LiveRun>();

  constructor(
    private readonly runAgentImpl: RunAgentImplementation = runAgent,
    private readonly inputRegistry = new A2AInputRegistry(),
  ) {}

  private prepare(auth: AuthIdentity, template: Record<string, unknown>): PreparedRun {
    const model = typeof template.model === 'string' ? template.model.trim() : '';
    if (!model) throw new UnsupportedOperationError('The published Agent has no model configured.');
    const provider = resolveProviderProfileForModel(auth.tenantId, model);
    const overrides = template.providerOverrides && typeof template.providerOverrides === 'object'
      ? template.providerOverrides as Record<string, unknown>
      : {};
    const apiKey = provider?.ANTHROPIC_AUTH_TOKEN
      || (typeof overrides.ANTHROPIC_AUTH_TOKEN === 'string' ? overrides.ANTHROPIC_AUTH_TOKEN.trim() : '');
    const baseUrl = provider?.ANTHROPIC_BASE_URL
      || (typeof overrides.ANTHROPIC_BASE_URL === 'string' ? overrides.ANTHROPIC_BASE_URL.trim() : '');
    if (!apiKey) throw new UnsupportedOperationError(`No provider credential is configured for model ${model}.`);

    const quotaUserId = resolveQuotaUserId(auth);
    if (quotaUserId) {
      const quota = checkUserRunQuota(auth.tenantId, quotaUserId);
      if (!quota.ok) throw new UnsupportedOperationError(quota.message);
    }
    const executionIdentity = quotaUserId
      ? getMe({ ...auth, sub: quotaUserId, authType: 'jwt' })
      : null;
    return {
      model,
      apiKey,
      baseUrl: baseUrl || undefined,
      quotaUserId,
      executionSub: executionIdentity?.id || auth.sub,
      executionRole: executionIdentity?.role || auth.role || null,
    };
  }

  private publish(live: LiveRun, stored: A2ATaskEventRecord) {
    for (const subscriber of live.subscribers) {
      if (!subscriber.push(stored)) live.subscribers.delete(subscriber);
    }
  }

  private persistEvent(live: LiveRun, event: StreamResponse) {
    const stored = appendA2ATaskEvent(live.scope, live.taskId, event);
    this.publish(live, stored);
    return stored;
  }

  private transition(
    live: LiveRun,
    state: TaskState,
    message?: Message,
    finalMessage?: Message,
    error?: unknown,
  ) {
    const result = transitionA2ATask(live.scope, live.taskId, {
      state,
      statusMessage: message || null,
      ...(finalMessage ? { finalMessage } : {}),
      ...(error !== undefined ? { error } : {}),
      event: statusEvent(live.taskId, live.contextId, state, message),
    });
    this.publish(live, result.event);
    return result.task;
  }

  private resolveDone(live: LiveRun) {
    if (live.doneResolved) return;
    live.doneResolved = true;
    live.resolveDone();
  }

  private closeSubscribers(live: LiveRun) {
    for (const subscriber of live.subscribers) subscriber.close();
    live.subscribers.clear();
  }

  private flushDelta(live: LiveRun, lastChunk: boolean) {
    if (live.deltaTimer) {
      clearTimeout(live.deltaTimer);
      live.deltaTimer = null;
    }
    const current = getA2ATask(live.scope, live.taskId);
    if (!current || a2aTaskStateIsTerminal(current.state)) {
      live.deltaBuffer = '';
      return;
    }
    const chunk = live.deltaBuffer;
    live.deltaBuffer = '';
    if (!chunk && !(lastChunk && live.emittedTextArtifact)) return;
    const artifact: Artifact = {
      artifactId: live.textArtifactId,
      name: 'response',
      description: 'Agent response text',
      parts: [textPart(chunk)],
      metadata: undefined,
      extensions: [],
    };
    this.persistEvent(live, artifactEvent(
      live.taskId,
      live.contextId,
      artifact,
      live.emittedTextArtifact,
      lastChunk,
    ));
    live.emittedTextArtifact = true;
  }

  private handleAgentEvent(live: LiveRun, event: AgentEvent) {
    if (event.type === 'delta' && !event.thinking && event.text) {
      live.outputText += event.text;
      live.deltaBuffer += event.text;
      if (Buffer.byteLength(live.deltaBuffer, 'utf8') >= DELTA_FLUSH_BYTES) {
        this.flushDelta(live, false);
      } else if (!live.deltaTimer) {
        live.deltaTimer = setTimeout(() => this.flushDelta(live, false), DELTA_FLUSH_DELAY_MS);
      }
    } else if (event.type === 'run_outcome') {
      live.outcome = event.outcome;
      if (event.message) live.errorMessage = event.message;
    } else if (event.type === 'error') {
      live.errorMessage = event.message;
    }
  }

  private inputRequiredMessage(live: LiveRun, descriptor: A2AInputDescriptor) {
    const text = descriptor.type === 'permission'
      ? `Permission required for tool ${descriptor.toolName}. Continue with {"decision":"allow"} or {"decision":"deny"}.`
      : 'Additional answers are required. Continue with {"answers":{"question":"answer"}}.';
    return {
      ...agentMessage(live.taskId, live.contextId, text),
      parts: [textPart(text), dataPart(descriptor)],
    } satisfies Message;
  }

  private failInputTimeout(live: LiveRun) {
    const current = getA2ATask(live.scope, live.taskId);
    if (!current || a2aTaskStateIsTerminal(current.state)) return;
    if (!live.abortController.signal.aborted) live.abortController.abort();
    const message = agentMessage(live.taskId, live.contextId, 'The A2A input request timed out.');
    appendA2AMessage(live.scope, live.taskId, message);
    this.persistEvent(live, { payload: { $case: 'message', value: message } });
    this.transition(live, TaskState.TASK_STATE_FAILED, message, message, {
      code: 'A2A_INPUT_TIMEOUT',
      message: 'The A2A input request timed out.',
    });
    this.resolveDone(live);
    this.closeSubscribers(live);
  }

  private inputCallbacks(live: LiveRun) {
    return {
      onPause: (descriptor: A2AInputDescriptor) => {
        const message = this.inputRequiredMessage(live, descriptor);
        this.transition(live, TaskState.TASK_STATE_INPUT_REQUIRED, message);
      },
      onResume: () => {
        this.transition(live, TaskState.TASK_STATE_WORKING);
      },
      onTimeout: () => this.failInputTimeout(live),
    };
  }

  private finalState(live: LiveRun, result: AgentRunResult) {
    if (live.abortController.signal.aborted || live.outcome === 'stopped' || result.outcome === 'stopped') {
      return TaskState.TASK_STATE_CANCELED;
    }
    if (live.outcome === 'rejected' || result.outcome === 'rejected') return TaskState.TASK_STATE_REJECTED;
    if (live.outcome === 'completed' && result.outcome === 'completed') return TaskState.TASK_STATE_COMPLETED;
    return TaskState.TASK_STATE_FAILED;
  }

  private finalize(live: LiveRun, result: AgentRunResult) {
    const current = getA2ATask(live.scope, live.taskId);
    if (!current || a2aTaskStateIsTerminal(current.state)) return;
    if (!live.outputText && result.text) {
      live.outputText = result.text;
      live.deltaBuffer += result.text;
    }
    this.flushDelta(live, true);
    if (live.outputText) {
      appendA2AArtifact(live.scope, live.taskId, {
        artifactId: live.textArtifactId,
        name: 'response',
        description: 'Agent response text',
        parts: [textPart(live.outputText)],
        metadata: undefined,
        extensions: [],
      });
    }
    if (result.structuredOutput !== undefined) {
      const structuredArtifact: Artifact = {
        artifactId: crypto.randomUUID(),
        name: 'structured-output',
        description: 'Structured Agent output',
        parts: [dataPart(result.structuredOutput)],
        metadata: undefined,
        extensions: [],
      };
      appendA2AArtifact(live.scope, live.taskId, structuredArtifact);
      this.persistEvent(live, artifactEvent(live.taskId, live.contextId, structuredArtifact, false, true));
    }

    const state = this.finalState(live, result);
    const messageText = live.outputText
      || live.errorMessage
      || (state === TaskState.TASK_STATE_CANCELED ? 'Task canceled.' : 'Agent execution failed.');
    const message = agentMessage(live.taskId, live.contextId, messageText);
    appendA2AMessage(live.scope, live.taskId, message);
    this.persistEvent(live, { payload: { $case: 'message', value: message } });
    this.transition(
      live,
      state,
      message,
      message,
      state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED
        ? { code: 'AGENT_EXECUTION_FAILED', outcome: result.outcome, message: messageText }
        : undefined,
    );
  }

  private async execute(live: LiveRun, prompt: string) {
    let tokensRecorded = false;
    try {
      this.transition(live, TaskState.TASK_STATE_WORKING);
      if (live.prepared.quotaUserId) {
        recordConversationStarted(live.scope.tenantId, live.prepared.quotaUserId, {
          runId: live.taskId,
          model: live.prepared.model,
        });
      }
      const template = live.template;
      const result = await this.runAgentImpl({
        prompt,
        systemPrompt: typeof template.systemPrompt === 'string' ? template.systemPrompt : undefined,
        model: live.prepared.model,
        baseUrl: live.prepared.baseUrl,
        apiKey: live.prepared.apiKey,
        tools: stringArray(template.tools),
        subagents: template.subagents && typeof template.subagents === 'object' && !Array.isArray(template.subagents)
          ? template.subagents as RunAgentOptions['subagents']
          : undefined,
        skills: stringArray(template.skills),
        mcpServers: stringArray(template.mcpServers),
        a2aRemoteAgents: Array.isArray(template.a2aRemoteAgents)
          ? template.a2aRemoteAgents as RunAgentOptions['a2aRemoteAgents']
          : undefined,
        outputFormat: template.outputSchema && typeof template.outputSchema === 'object' && !Array.isArray(template.outputSchema)
          ? { type: 'json_schema', schema: template.outputSchema as Record<string, unknown> }
          : undefined,
        enableFileCheckpointing: template.enableFileCheckpointing === true || undefined,
        useKnowledge: template.useKnowledge === true || stringArray(template.knowledgeSourceIds).length > 0,
        knowledgeSourceIds: stringArray(template.knowledgeSourceIds),
        datasourceIds: stringArray(template.datasourceIds),
        maxTurns: Number(template.maxTurns) || 20,
        effort: typeof template.effort === 'string' ? template.effort as RunAgentOptions['effort'] : undefined,
        tenantId: live.scope.tenantId,
        sub: live.prepared.executionSub,
        role: live.prepared.executionRole,
        seedDir: resolveSeedDir(live.scope.tenantId, template),
        templateId: live.scope.templateId,
        emit: (event) => this.handleAgentEvent(live, event),
        requestPermission: this.inputRegistry.requestPermission(
          live.scope,
          live.taskId,
          this.inputCallbacks(live),
        ),
        requestUserQuestion: this.inputRegistry.requestQuestions(
          live.scope,
          live.taskId,
          this.inputCallbacks(live),
        ),
        abortController: live.abortController,
      });
      this.finalize(live, result);
      if (live.prepared.quotaUserId) {
        recordUserRunTokens(live.scope.tenantId, live.prepared.quotaUserId, {
          runId: live.taskId,
          model: live.prepared.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        tokensRecorded = true;
      }
    } catch (error) {
      const current = getA2ATask(live.scope, live.taskId);
      if (current && !a2aTaskStateIsTerminal(current.state)) {
        const message = agentMessage(
          live.taskId,
          live.contextId,
          live.abortController.signal.aborted ? 'Task canceled.' : ((error as Error).message || 'Agent execution failed.'),
        );
        appendA2AMessage(live.scope, live.taskId, message);
        this.persistEvent(live, { payload: { $case: 'message', value: message } });
        this.transition(
          live,
          live.abortController.signal.aborted ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
          message,
          message,
          live.abortController.signal.aborted
            ? undefined
            : { code: 'AGENT_EXECUTION_FAILED', message: (error as Error).message || String(error) },
        );
      }
    } finally {
      if (live.deltaTimer) clearTimeout(live.deltaTimer);
      if (live.prepared.quotaUserId && !tokensRecorded) {
        try {
          recordUserRunTokens(live.scope.tenantId, live.prepared.quotaUserId, {
            runId: live.taskId,
            model: live.prepared.model,
            totalTokens: 0,
          });
        } catch {
          // Usage accounting must not mask task cleanup.
        }
      }
      this.resolveDone(live);
      this.closeSubscribers(live);
      this.inputRegistry.cancel(live.scope, live.taskId);
      this.liveRuns.delete(live.key);
    }
  }

  submit(auth: AuthIdentity, template: Record<string, unknown>, params: SendMessageRequest) {
    const message = params.message;
    if (!message) throw new RequestMalformedError('message is required.');
    const prompt = promptFromMessage(message);
    const templateId = String(template.id || '').trim();
    const scope = { tenantId: auth.tenantId, templateId, callerSub: auth.sub };
    if (message.taskId) {
      const current = getA2ATask(scope, message.taskId);
      if (!current || current.contextId !== message.contextId) {
        throw new TaskNotFoundError('Input-required task not found.');
      }
      const duplicate = listA2AMessages(scope, current.id).some((item) => item.messageId === message.messageId);
      if (!duplicate) {
        this.inputRegistry.resume(scope, current.id, message, () => {
          appendA2AMessage(scope, current.id, { ...message, taskId: current.id, contextId: current.contextId });
        });
      }
      return { task: getA2ATask(scope, current.id)!, live: this.liveRuns.get(taskKey(scope, current.id)) || null };
    }
    const existing = findA2ATaskByMessageId(scope, message.messageId);
    if (existing) return { task: existing, live: this.liveRuns.get(taskKey(scope, existing.id)) || null };
    const prepared = this.prepare(auth, template);
    const taskId = crypto.randomUUID();
    const contextId = message.contextId || crypto.randomUUID();
    const submittedAt = Date.now();
    const submittedTask: Task = {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date(submittedAt).toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    const created = createA2ATask({
      ...scope,
      id: taskId,
      contextId,
      messageId: message.messageId,
      event: { payload: { $case: 'task', value: submittedTask } } satisfies StreamResponse,
      createdAt: submittedAt,
    });
    if (!created.created) {
      return { task: created.task, live: this.liveRuns.get(taskKey(scope, created.task.id)) || null };
    }
    appendA2AMessage(scope, taskId, { ...message, taskId, contextId });

    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const live: LiveRun = {
      key: taskKey(scope, taskId),
      scope,
      taskId,
      contextId,
      template,
      prepared,
      abortController: new AbortController(),
      subscribers: new Set(),
      done,
      resolveDone,
      doneResolved: false,
      outputText: '',
      deltaBuffer: '',
      deltaTimer: null,
      textArtifactId: crypto.randomUUID(),
      emittedTextArtifact: false,
      outcome: 'completed',
      errorMessage: '',
    };
    this.liveRuns.set(live.key, live);
    queueMicrotask(() => { void this.execute(live, prompt); });
    return { task: created.task, live };
  }

  async wait(scope: A2ATaskScope, taskId: string) {
    const live = this.liveRuns.get(taskKey(scope, taskId));
    if (live) await live.done;
    const task = getA2ATask(scope, taskId);
    if (!task) throw new TaskNotFoundError();
    return task;
  }

  async *stream(scope: A2ATaskScope, taskId: string): AsyncGenerator<StreamResponse, void, undefined> {
    const task = getA2ATask(scope, taskId);
    if (!task) throw new TaskNotFoundError();
    const live = this.liveRuns.get(taskKey(scope, taskId));
    const queue = new EventQueue();
    if (live) {
      if (live.subscribers.size >= MAX_LIVE_SUBSCRIBERS) {
        throw new UnsupportedOperationError('Too many live subscribers for this task.');
      }
      live.subscribers.add(queue);
    }
    let afterSeq = 0;
    try {
      while (true) {
        const page = listA2ATaskEvents(scope, taskId, { afterSeq, limit: EVENT_REPLAY_PAGE_SIZE });
        if (!page.length) break;
        for (const stored of page) {
          afterSeq = stored.seq;
          if (isStreamResponse(stored.event)) yield stored.event;
        }
        if (page.length < EVENT_REPLAY_PAGE_SIZE) break;
      }
      if (!live) return;
      while (true) {
        const next = await queue.next();
        if (next.done) return;
        if (next.value.seq <= afterSeq) continue;
        afterSeq = next.value.seq;
        if (isStreamResponse(next.value.event)) yield next.value.event;
      }
    } finally {
      if (live) live.subscribers.delete(queue);
      queue.close();
    }
  }

  cancel(scope: A2ATaskScope, taskId: string) {
    let current: A2ATaskRecord | null;
    try {
      current = getA2ATask(scope, taskId);
    } catch (error) {
      throw mapStoreError(error);
    }
    if (!current) throw new TaskNotFoundError();
    if (a2aTaskStateIsTerminal(current.state)) throw new TaskNotCancelableError();
    const live = this.liveRuns.get(taskKey(scope, taskId));
    if (live) {
      this.inputRegistry.cancel(scope, taskId);
      if (!live.abortController.signal.aborted) live.abortController.abort();
      if (live.deltaTimer) {
        clearTimeout(live.deltaTimer);
        live.deltaTimer = null;
      }
      live.deltaBuffer = '';
    }
    const message = agentMessage(taskId, current.contextId, 'Task canceled.');
    try {
      appendA2AMessage(scope, taskId, message);
      const messageEvent = appendA2ATaskEvent(scope, taskId, {
        payload: { $case: 'message', value: message },
      } satisfies StreamResponse);
      if (live) this.publish(live, messageEvent);
      const result = transitionA2ATask(scope, taskId, {
        state: TaskState.TASK_STATE_CANCELED,
        statusMessage: message,
        finalMessage: message,
        event: statusEvent(taskId, current.contextId, TaskState.TASK_STATE_CANCELED, message),
      });
      if (live) {
        this.publish(live, result.event);
        this.resolveDone(live);
        this.closeSubscribers(live);
      }
      return result.task;
    } catch (error) {
      if (error instanceof A2AStoreError) {
        if (error.code === 'not_found') throw new TaskNotFoundError();
        if (error.code === 'terminal' || error.code === 'invalid_transition') throw new TaskNotCancelableError();
      }
      throw mapStoreError(error);
    }
  }
}

export const a2aExecutionManager = new A2AExecutionManager();
