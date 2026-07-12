import crypto from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { guardedFetch, OutboundRequestError } from './server-outbound-url.ts';
import { resolveA2ACredential } from './server-store.ts';

export type A2ARemoteConfig = { name: string; agentCardUrl: string; credentialRef?: string };
type QuestionRequester = (request: {
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
  toolUseID: string;
  signal?: AbortSignal;
}) => Promise<{ answers: Record<string, string> }>;
type A2ALogger = (event: { level: 'info' | 'warn'; message: string }) => void;

export type A2ARemoteToolDescriptor = {
  config: A2ARemoteConfig;
  toolName: string;
  sdkToolName: string;
};

const CARD_TTL_MS = 5 * 60 * 1000;
const CARD_MAX_BYTES = 256 * 1024;
const RPC_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const cache = new Map<string, {
  expiresAt: number;
  name: string;
  description: string;
  rpcUrl: string;
}>();

function allowLoopbackHttp() {
  return process.env.AGENTMA_A2A_ALLOW_LOOPBACK_HTTP === '1';
}

function boundedEnv(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function pollIntervalMs() {
  return boundedEnv('AGENTMA_A2A_REMOTE_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, 200, 30_000);
}

function taskTimeoutMs() {
  return boundedEnv('AGENTMA_A2A_REMOTE_TASK_TIMEOUT_MS', DEFAULT_TASK_TIMEOUT_MS, 10_000, 2 * 60 * 60_000);
}

function taskState(task: unknown) {
  if (!task || typeof task !== 'object') return '';
  const status = (task as Record<string, unknown>).status;
  if (!status || typeof status !== 'object') return '';
  const state = (status as Record<string, unknown>).state;
  return typeof state === 'string' ? state : '';
}

function isActionableTaskState(state: string) {
  return TERMINAL_TASK_STATES.has(state) || state === 'TASK_STATE_INPUT_REQUIRED';
}

function abortError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cleanCardText(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === 'string'
    ? Array.from(value, character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f ? ' ' : character)
      .join('')
      .trim()
    : '';
  return (text || fallback).slice(0, maxLength);
}

export function remoteA2AToolName(
  name: string,
  agentCardUrl: string,
  index: number,
  usedNames = new Set<string>(),
) {
  const slug = name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const base = `remote_${slug || 'agent'}`;
  let candidate = base;
  if (!slug || usedNames.has(candidate)) {
    const hash = crypto.createHash('sha256').update(`${name}\0${agentCardUrl}\0${index}`).digest('hex').slice(0, 8);
    candidate = `${base.slice(0, 54)}_${hash}`;
  }
  usedNames.add(candidate);
  return candidate;
}

export function describeA2ARemoteTools(remotes: A2ARemoteConfig[]): A2ARemoteToolDescriptor[] {
  const usedToolNames = new Set<string>();
  return remotes.slice(0, 16).map((config, index) => {
    const toolName = remoteA2AToolName(config.name, config.agentCardUrl, index, usedToolNames);
    return { config, toolName, sdkToolName: `mcp__a2a__${toolName}` };
  });
}

function safeLogError(error: unknown) {
  return Array.from((error as Error)?.message || String(error), character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('').trim().slice(0, 500) || 'unknown error';
}

export async function discoverA2ARemoteAgent(tenantId: string, cardUrl: string) {
  const key = `${tenantId}\0${cardUrl}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { name: cached.name, description: cached.description, rpcUrl: cached.rpcUrl };
  }
  const response = await guardedFetch(cardUrl, {
    headers: { 'A2A-Version': '1.0', Accept: 'application/json' },
    maxBytes: CARD_MAX_BYTES,
    allowLoopbackHttp: allowLoopbackHttp(),
  });
  if (response.status !== 200) throw new Error('Remote Agent Card request failed.');
  let card: Record<string, unknown>;
  try { card = JSON.parse(response.body.toString('utf8')); } catch { throw new Error('Remote Agent Card is invalid JSON.'); }
  const interfaces = card.supportedInterfaces;
  const rpc = Array.isArray(interfaces)
    ? interfaces.find((item): item is { url: string; protocolBinding: string; protocolVersion: string } => Boolean(
      item && typeof item === 'object'
      && (item as Record<string, unknown>).protocolBinding === 'JSONRPC'
      && (item as Record<string, unknown>).protocolVersion === '1.0'
      && typeof (item as Record<string, unknown>).url === 'string',
    ))
    : null;
  if (!rpc?.url || typeof rpc.url !== 'string') throw new Error('Remote Agent does not expose A2A 1.0 JSON-RPC.');
  await guardedFetch(rpc.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'GetTask', params: { id: 'agentma-probe' } }),
    maxBytes: 64 * 1024,
    allowLoopbackHttp: allowLoopbackHttp(),
  }).catch((error) => {
    if ((error as { code?: string }).code === 'blocked_destination') throw error;
  });
  const fallbackName = cleanCardText(new URL(cardUrl).hostname, 'Remote Agent', 64);
  const discovered = {
    name: cleanCardText(card.name, fallbackName, 64),
    description: cleanCardText(card.description, '', 500),
    rpcUrl: rpc.url,
  };
  cache.set(key, { expiresAt: Date.now() + CARD_TTL_MS, ...discovered });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return discovered;
}

async function resolveRpcUrl(tenantId: string, cardUrl: string) {
  return (await discoverA2ARemoteAgent(tenantId, cardUrl)).rpcUrl;
}

function redactCredential(value: string, credential: string | null) {
  return credential ? value.split(credential).join('[REDACTED]') : value;
}

function resultText(value: unknown, credential: string | null) {
  const json = redactCredential(JSON.stringify(value), credential);
  return json.length > RPC_MAX_BYTES ? `${json.slice(0, RPC_MAX_BYTES)}…` : json;
}

async function rpcCall(rpcUrl: string, credential: string | null, method: string, params: unknown, signal?: AbortSignal) {
  const response = await guardedFetch(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json', 'A2A-Version': '1.0', Connection: 'close',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    maxBytes: RPC_MAX_BYTES,
    allowLoopbackHttp: allowLoopbackHttp(),
    signal,
  });
  if (response.status !== 200) throw new Error('Remote A2A request failed.');
  const payload = JSON.parse(response.body.toString('utf8'));
  if (payload?.error) {
    const message = redactCredential(String(payload.error.message || 'request failed'), credential).slice(0, 500);
    throw new Error(`Remote A2A error: ${message}`);
  }
  return payload?.result;
}

async function pollTask(
  rpcUrl: string,
  credential: string | null,
  taskId: string,
  deadline: number,
  signal?: AbortSignal,
) {
  let failures = 0;
  while (true) {
    if (Date.now() > deadline) throw new Error('Remote Agent task timed out.');
    await sleep(pollIntervalMs(), signal);
    if (Date.now() > deadline) throw new Error('Remote Agent task timed out.');
    try {
      const task = await rpcCall(rpcUrl, credential, 'GetTask', { id: taskId, historyLength: 0 }, signal);
      failures = 0;
      if (isActionableTaskState(taskState(task))) return task;
    } catch (error) {
      if (!(error instanceof OutboundRequestError) || ++failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
    }
  }
}

function inputDescriptor(task: Record<string, unknown>) {
  const status = task.status as Record<string, unknown> | undefined;
  const message = status?.message as Record<string, unknown> | undefined;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const part = parts.find((item) => {
    const value = item as Record<string, unknown>;
    return value?.data && typeof value.data === 'object';
  }) as Record<string, unknown> | undefined;
  return part?.data as Record<string, unknown> | undefined;
}

async function continuationFor(task: Record<string, unknown>, requester: QuestionRequester, signal?: AbortSignal) {
  const descriptor = inputDescriptor(task);
  if (descriptor?.type === 'permission') {
    const question = `Allow remote tool ${String(descriptor.toolName || 'operation')}?`;
    const answer = await requester({
      questions: [{
        question, header: 'Remote permission', multiSelect: false,
        options: [
          { label: 'Allow', description: 'Allow the remote Agent operation.' },
          { label: 'Deny', description: 'Deny the remote Agent operation.' },
        ],
      }],
      toolUseID: crypto.randomUUID(), signal,
    });
    return { decision: /^allow$/i.test(answer.answers[question] || '') ? 'allow' : 'deny' };
  }
  const questions = Array.isArray(descriptor?.questions) ? descriptor.questions : [];
  if (!questions.length) throw new Error('Remote Agent requires unsupported additional input.');
  const answer = await requester({ questions, toolUseID: crypto.randomUUID(), signal });
  return { answers: answer.answers };
}

export async function callA2ARemote(
  tenantId: string,
  config: A2ARemoteConfig,
  input: { text?: string; data?: unknown },
  requester?: QuestionRequester,
  signal?: AbortSignal,
) {
  const rpcUrl = await resolveRpcUrl(tenantId, config.agentCardUrl);
  const credential = config.credentialRef ? resolveA2ACredential(tenantId, config.credentialRef) : null;
  if (config.credentialRef && !credential) throw new Error('Remote Agent credential is unavailable.');
  const parts = input.data !== undefined ? [{ data: input.data }] : [{ text: String(input.text || '').slice(0, 64 * 1024) }];
  const deadline = Date.now() + taskTimeoutMs();
  let result = await rpcCall(rpcUrl, credential, 'SendMessage', {
    message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts },
    configuration: { acceptedOutputModes: ['text/plain', 'application/json'], returnImmediately: true },
  }, signal);
  if (result?.message) return resultText(result, credential);
  let task = result?.task;
  if (!task?.id) return resultText(result, credential);
  let remoteTaskId = task?.id;
  const cancel = () => {
    if (!remoteTaskId) return;
    void rpcCall(rpcUrl, credential, 'CancelTask', { id: remoteTaskId }, undefined).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let turn = 0;
    while (true) {
      let state = taskState(task);
      if (!isActionableTaskState(state)) {
        task = await pollTask(rpcUrl, credential, remoteTaskId, deadline, signal);
        state = taskState(task);
      }
      if (TERMINAL_TASK_STATES.has(state)) break;
      if (state !== 'TASK_STATE_INPUT_REQUIRED') continue;
      if (turn >= 8) throw new Error('Remote Agent exceeded the additional input limit.');
      if (!requester) throw new Error('Remote Agent requires additional input.');
      turn += 1;
      const continuation = await continuationFor(task as Record<string, unknown>, requester, signal);
      result = await rpcCall(rpcUrl, credential, 'SendMessage', {
        message: {
          messageId: crypto.randomUUID(), taskId: task.id, contextId: task.contextId,
          role: 'ROLE_USER', parts: [{ data: continuation }],
        },
        configuration: { acceptedOutputModes: ['text/plain', 'application/json'], returnImmediately: true },
      }, signal);
      task = result?.task ?? task;
      remoteTaskId = task?.id || remoteTaskId;
    }
    return resultText({ task }, credential);
  } catch (error) {
    if ((error as Error)?.message === 'Remote Agent task timed out.') cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export function buildA2ARemoteMcp(
  tenantId: string,
  remotes: A2ARemoteConfig[],
  options: { requestUserQuestion?: QuestionRequester; signal?: AbortSignal; onLog?: A2ALogger } = {},
) {
  const tools = describeA2ARemoteTools(remotes).map(({ config, toolName, sdkToolName }) => tool(
    toolName,
    `Call remote A2A Agent: ${config.name}`,
    { text: z.string().max(64 * 1024).optional(), data: z.unknown().optional() },
    async (args) => {
      options.onLog?.({ level: 'info', message: `A2A 调用开始：${config.name} (${sdkToolName})` });
      try {
        const text = await callA2ARemote(tenantId, config, args, options.requestUserQuestion, options.signal);
        options.onLog?.({ level: 'info', message: `A2A 调用完成：${config.name} (${sdkToolName})` });
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const message = safeLogError(error);
        options.onLog?.({ level: 'warn', message: `A2A 调用失败：${config.name} (${sdkToolName}) — ${message}` });
        return { content: [{ type: 'text', text: `Remote Agent call failed: ${message.slice(0, 800)}` }], isError: true };
      }
    },
  ));
  return tools.length ? createSdkMcpServer({ name: 'a2a', version: '1.0.0', tools }) : null;
}
