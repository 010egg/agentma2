import crypto from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { guardedFetch } from './server-outbound-url.ts';
import { resolveA2ACredential } from './server-store.ts';

export type A2ARemoteConfig = { name: string; agentCardUrl: string; credentialRef?: string };
type QuestionRequester = (request: {
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
  toolUseID: string;
  signal?: AbortSignal;
}) => Promise<{ answers: Record<string, string> }>;

const CARD_TTL_MS = 5 * 60 * 1000;
const CARD_MAX_BYTES = 256 * 1024;
const RPC_MAX_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, { expiresAt: number; rpcUrl: string }>();

function allowLoopbackHttp() {
  return process.env.AGENTMA_A2A_ALLOW_LOOPBACK_HTTP === '1';
}

function safeToolName(name: string, index: number) {
  const slug = name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return `remote_${slug || index + 1}`;
}

async function resolveRpcUrl(tenantId: string, cardUrl: string) {
  const key = `${tenantId}\0${cardUrl}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rpcUrl;
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
  cache.set(key, { expiresAt: Date.now() + CARD_TTL_MS, rpcUrl: rpc.url });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return rpc.url;
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
      'Content-Type': 'application/json', Accept: 'application/json', 'A2A-Version': '1.0',
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
  let result = await rpcCall(rpcUrl, credential, 'SendMessage', {
    message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts },
    configuration: { acceptedOutputModes: ['text/plain', 'application/json'], returnImmediately: false },
  }, signal);
  let task = result?.task;
  let remoteTaskId = task?.id;
  const cancel = () => {
    if (!remoteTaskId) return;
    void rpcCall(rpcUrl, credential, 'CancelTask', { id: remoteTaskId }, undefined).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (let turn = 0; task?.status?.state === 'TASK_STATE_INPUT_REQUIRED' && turn < 8; turn += 1) {
      if (!requester) throw new Error('Remote Agent requires additional input.');
      const continuation = await continuationFor(task as Record<string, unknown>, requester, signal);
      result = await rpcCall(rpcUrl, credential, 'SendMessage', {
        message: {
          messageId: crypto.randomUUID(), taskId: task.id, contextId: task.contextId,
          role: 'ROLE_USER', parts: [{ data: continuation }],
        },
        configuration: { acceptedOutputModes: ['text/plain', 'application/json'], returnImmediately: false },
      }, signal);
      task = result?.task;
      remoteTaskId = task?.id || remoteTaskId;
    }
    return resultText(result, credential);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export function buildA2ARemoteMcp(
  tenantId: string,
  remotes: A2ARemoteConfig[],
  options: { requestUserQuestion?: QuestionRequester; signal?: AbortSignal } = {},
) {
  const tools = remotes.slice(0, 16).map((config, index) => tool(
    safeToolName(config.name, index),
    `Call remote A2A Agent: ${config.name}`,
    { text: z.string().max(64 * 1024).optional(), data: z.unknown().optional() },
    async (args) => {
      try {
        const text = await callA2ARemote(tenantId, config, args, options.requestUserQuestion, options.signal);
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `Remote Agent call failed: ${(error as Error).message.slice(0, 800)}` }], isError: true };
      }
    },
  ));
  return tools.length ? createSdkMcpServer({ name: 'a2a', version: '1.0.0', tools }) : null;
}
