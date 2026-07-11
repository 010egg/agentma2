import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, TaskNotCancelableError } from '@a2a-js/sdk/client';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { response, body };
}

async function requireOk(label, request) {
  const result = await request;
  if (!result.response.ok) throw new Error(`${label} failed ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port')));
    });
  });
}

async function conditionalGetStatus(url, etag) {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { 'If-None-Match': etag } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await delay(200);
  }
  throw new Error(`server health failed: ${lastError || 'timeout'}`);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child) {
  if (!child || childExited(child)) return;
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGINT'); } catch { child.kill('SIGINT'); }
  } else {
    child.kill('SIGINT');
  }
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(2500),
  ]);
  if (!childExited(child)) child.kill('SIGKILL');
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token) {
  return { ...bearer(token), 'Content-Type': 'application/json' };
}

function template(id, name, patch = {}) {
  const timestamp = Date.now();
  return {
    id,
    name,
    description: `${name} public description`,
    systemPrompt: `SYSTEM-SECRET-${id}`,
    model: 'private-model-name',
    tools: ['Read', 'Bash', '/private/tool-path'],
    subagents: {},
    mcpServers: [],
    eventSources: [],
    skills: ['research', '/private/skill-path'],
    effort: 'medium',
    maxTurns: 10,
    permissionMode: 'default',
    knowledgeSourceIds: [],
    a2aPublished: true,
    a2aRemoteAgents: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

async function rpc(baseUrl, templateId, token, payload, extraHeaders = {}) {
  return await fetchJson(`${baseUrl}/a2a/agents/${encodeURIComponent(templateId)}/rpc`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(token),
      'A2A-Version': '1.0',
      ...extraHeaders,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-protocol-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
process.env.AGENTMA_DATA_DIR = dataDir;
let child;

try {
  child = spawn('npm', ['run', 'server'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      AGENTMA_DATA_DIR: dataDir,
      AGENTMA_PUBLIC_URL: baseUrl,
      AGENTMA_SKIP_RECOVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', chunk => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));
  await waitForHealth(baseUrl);

  const stamp = Date.now();
  const admin = await requireOk('register tenant one', fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'A2A Protocol Admin',
      email: `a2a-protocol-${stamp}@gmail.com`,
      password: 'test-password-123',
    }),
  }));
  const agent = template('protocol-agent', 'Protocol Agent');
  await requireOk('save tenant one agent', fetchJson(`${baseUrl}/api/agents`, {
    method: 'PUT',
    headers: jsonHeaders(admin.token),
    body: JSON.stringify([agent]),
  }));
  const apiKey = await requireOk('create tenant one API Key', fetchJson(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: jsonHeaders(admin.token),
    body: JSON.stringify({ name: 'A2A caller' }),
  }));
  const secondApiKey = await requireOk('create second tenant one API Key', fetchJson(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: jsonHeaders(admin.token),
    body: JSON.stringify({ name: 'A2A other caller' }),
  }));

  const cardUrl = `${baseUrl}/a2a/agents/${agent.id}/.well-known/agent-card.json`;
  const cardResponse = await fetch(cardUrl, { headers: { 'A2A-Version': '1.0' } });
  assert.equal(cardResponse.status, 200);
  const etag = cardResponse.headers.get('etag');
  assert(etag);
  assert.match(cardResponse.headers.get('cache-control') || '', /public/);
  const card = await cardResponse.json();
  assert.equal(card.name, agent.name);
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].url, `${baseUrl}/a2a/agents/${agent.id}/rpc`);
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.securitySchemes.agentmaApiKey.httpAuthSecurityScheme.bearerFormat, 'AgentMa API Key');
  const serializedCard = JSON.stringify(card);
  for (const secret of [agent.systemPrompt, agent.model, admin.tenantId, '/private/', 'a2aRemoteAgents']) {
    assert(!serializedCard.includes(secret), `Agent Card leaked ${secret}`);
  }
  assert.equal(await conditionalGetStatus(cardUrl, etag), 304);

  const missingVersion = await fetchJson(`${baseUrl}/a2a/agents/${agent.id}/rpc`, {
    method: 'POST',
    headers: jsonHeaders(apiKey.rawKey),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'version', method: 'GetTask', params: { id: 'missing' } }),
  });
  assert.equal(missingVersion.response.status, 400);
  assert.equal(missingVersion.body.error?.code, -32009);

  const noAuth = await fetchJson(`${baseUrl}/a2a/agents/${agent.id}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'no-auth', method: 'GetTask', params: { id: 'missing' } }),
  });
  assert.equal(noAuth.response.status, 401);
  assert.match(noAuth.response.headers.get('www-authenticate') || '', /Bearer/);

  const jwtRejected = await rpc(baseUrl, agent.id, admin.token, {
    jsonrpc: '2.0', id: 'jwt', method: 'GetTask', params: { id: 'missing' },
  });
  assert.equal(jwtRejected.response.status, 403);

  const wrongContentType = await fetchJson(`${baseUrl}/a2a/agents/${agent.id}/rpc`, {
    method: 'POST',
    headers: { ...bearer(apiKey.rawKey), 'A2A-Version': '1.0', 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongContentType.response.status, 400);
  assert.equal(wrongContentType.body.error?.code, -32005);

  const malformed = await rpc(baseUrl, agent.id, apiKey.rawKey, '{bad-json');
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error?.code, -32700);

  const unknownMethod = await rpc(baseUrl, agent.id, apiKey.rawKey, {
    jsonrpc: '2.0', id: 'unknown', method: 'UnknownMethod', params: {},
  });
  assert.equal(unknownMethod.response.status, 200);
  assert.equal(unknownMethod.body.error?.code, -32601);

  const unsupportedSend = await rpc(baseUrl, agent.id, apiKey.rawKey, {
    jsonrpc: '2.0',
    id: 'send',
    method: 'SendMessage',
    params: {
      tenant: 'untrusted',
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: 'provider preflight' }],
      },
    },
  });
  assert.equal(unsupportedSend.response.status, 200);
  assert.equal(unsupportedSend.body.error?.code, -32004);

  const missingTask = await rpc(baseUrl, agent.id, apiKey.rawKey, {
    jsonrpc: '2.0', id: 'missing', method: 'GetTask', params: { tenant: 'untrusted', id: 'missing' },
  });
  assert.equal(missingTask.response.status, 200);
  assert.equal(missingTask.body.error?.code, -32001);

  const invalidParams = await rpc(baseUrl, agent.id, apiKey.rawKey, {
    jsonrpc: '2.0', id: 'invalid-params', method: 'GetTask', params: { id: '' },
  });
  assert.equal(invalidParams.response.status, 200);
  assert.equal(invalidParams.body.error?.code, -32602);

  await import('../server-store.ts');
  const a2aStore = await import('../server-a2a-store.ts');
  const scope = {
    tenantId: admin.tenantId,
    templateId: agent.id,
    callerSub: `api_key:${apiKey.id}`,
  };
  const taskId = crypto.randomUUID();
  const contextId = crypto.randomUUID();
  a2aStore.createA2ATask({ ...scope, id: taskId, contextId, messageId: crypto.randomUUID() });
  a2aStore.appendA2AMessage(scope, taskId, {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: 'persisted input' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  });
  a2aStore.appendA2AArtifact(scope, taskId, {
    artifactId: crypto.randomUUID(),
    name: 'persisted artifact',
    description: 'protocol smoke',
    parts: [{ content: { $case: 'text', value: 'artifact data' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
  });

  const client = await new ClientFactory().createFromUrl(cardUrl, '');
  assert.equal(client.protocolVersion, '1.0');
  const clientOptions = { serviceParameters: bearer(apiKey.rawKey) };
  const loaded = await client.getTask({ tenant: 'untrusted', id: taskId, historyLength: 10 }, clientOptions);
  assert.equal(loaded.id, taskId);
  assert.equal(loaded.history[0]?.parts[0]?.content?.value, 'persisted input');
  assert.equal(loaded.artifacts[0]?.name, 'persisted artifact');

  const listed = await client.listTasks({
    tenant: 'untrusted',
    contextId,
    status: TaskState.TASK_STATE_SUBMITTED,
    pageSize: 10,
    pageToken: '',
    historyLength: 10,
    statusTimestampAfter: undefined,
    includeArtifacts: true,
  }, clientOptions);
  assert.equal(listed.totalSize, 1);
  assert.equal(listed.tasks[0]?.id, taskId);

  const otherCaller = await rpc(baseUrl, agent.id, secondApiKey.rawKey, {
    jsonrpc: '2.0', id: 'other-caller', method: 'GetTask', params: { id: taskId },
  });
  assert.equal(otherCaller.body.error?.code, -32001);

  const canceled = await client.cancelTask({ tenant: 'untrusted', id: taskId, metadata: undefined }, clientOptions);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  await assert.rejects(
    () => client.cancelTask({ tenant: '', id: taskId, metadata: undefined }, clientOptions),
    error => error instanceof TaskNotCancelableError,
  );

  const secondTenant = await requireOk('register tenant two', fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'A2A Protocol Other Tenant',
      email: `a2a-protocol-other-${stamp}@gmail.com`,
      password: 'test-password-123',
    }),
  }));
  await requireOk('save other tenant agents', fetchJson(`${baseUrl}/api/agents`, {
    method: 'PUT',
    headers: jsonHeaders(secondTenant.token),
    body: JSON.stringify([
      template('other-tenant-agent', 'Other Tenant Agent'),
      template(agent.id, 'Ambiguous Protocol Agent'),
    ]),
  }));
  const otherTenantKey = await requireOk('create tenant two API Key', fetchJson(`${baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: jsonHeaders(secondTenant.token),
    body: JSON.stringify({ name: 'Other tenant A2A caller' }),
  }));
  const crossTenant = await rpc(baseUrl, 'other-tenant-agent', apiKey.rawKey, {
    jsonrpc: '2.0', id: 'cross-tenant', method: 'GetTask', params: { id: taskId },
  });
  assert.equal(crossTenant.response.status, 404);
  const reverseCrossTenant = await rpc(baseUrl, agent.id, otherTenantKey.rawKey, {
    jsonrpc: '2.0', id: 'reverse-cross-tenant', method: 'GetTask', params: { id: taskId },
  });
  assert.equal(reverseCrossTenant.body.error?.code, -32001);

  const ambiguousCard = await fetch(cardUrl);
  assert.equal(ambiguousCard.status, 404);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'public-card', 'card-redaction', 'etag', 'api-key-only', 'version', 'content-type',
      'json-rpc-errors', 'official-client', 'persisted-get-list-cancel', 'caller-isolation',
      'tenant-isolation', 'ambiguous-card',
    ],
  }));
} finally {
  await stopChild(child);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
