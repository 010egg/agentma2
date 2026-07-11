import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, TaskNotCancelableError } from '@a2a-js/sdk/client';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-execution-'));
process.env.AGENTMA_DATA_DIR = dataDir;
process.env.AGENTMA_SKIP_RECOVER = '1';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const textPart = value => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});
const messageRequest = (text, messageId = crypto.randomUUID(), returnImmediately = false) => ({
  tenant: 'untrusted-client-tenant',
  message: {
    messageId,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: {
    acceptedOutputModes: ['text/plain', 'application/json'],
    taskPushNotificationConfig: undefined,
    historyLength: 20,
    returnImmediately,
  },
  metadata: undefined,
});

let runCount = 0;
const observedRunOptions = [];
const fakeRunAgent = async options => {
  runCount += 1;
  observedRunOptions.push(options);
  options.emit({
    type: 'system',
    subtype: 'init',
    model: options.model,
    tools: options.tools?.length || 0,
    cwd: '/tmp/a2a-smoke',
  });
  if (options.prompt === 'wait-for-cancel') {
    while (!options.abortController?.signal.aborted) await delay(10);
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
  if (options.prompt === 'fail') throw new Error('deterministic execution failure');

  options.emit({ type: 'delta', text: 'hello ' });
  await delay(15);
  options.emit({ type: 'delta', text: `from ${options.prompt}` });
  const text = `hello from ${options.prompt}`;
  const result = {
    subtype: 'success',
    outcome: 'completed',
    text,
    inputTokens: 5,
    outputTokens: 7,
    durationMs: 20,
    costUsd: 0,
    model: options.model,
    structuredOutput: { prompt: options.prompt, ok: true },
  };
  options.emit({ type: 'run_outcome', outcome: 'completed', subtype: 'success' });
  options.emit({
    type: 'result',
    subtype: result.subtype,
    text: result.text,
    usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
    duration_ms: result.durationMs,
    cost_usd: result.costUsd,
    model: result.model,
    structuredOutput: result.structuredOutput,
  });
  return result;
};

let server;
try {
  const store = await import('../server-store.ts');
  const { A2AExecutionManager } = await import('../server-a2a-executor.ts');
  const { mountA2ARoutes } = await import('../server-a2a.ts');

  const registration = store.registerUser(
    'A2A Execution Admin',
    `a2a-execution-${Date.now()}@gmail.com`,
    'test-password-123',
  );
  assert.equal(registration.ok, true);
  const tenantId = registration.tenantId;
  const templateId = 'execution-agent';
  store.replaceProviderProfiles(tenantId, [{
    id: 'smoke-provider',
    name: 'Smoke Provider',
    ANTHROPIC_AUTH_TOKEN: 'smoke-provider-secret',
    ANTHROPIC_BASE_URL: 'https://provider.invalid',
    availableModels: ['smoke-model'],
    enabled: true,
    isDefault: true,
  }]);
  store.replaceAgentTemplates(tenantId, [{
    id: templateId,
    name: 'Execution Agent',
    description: 'Deterministic A2A execution smoke agent',
    systemPrompt: 'Do the smoke task.',
    model: 'smoke-model',
    tools: [],
    subagents: {},
    mcpServers: [],
    eventSources: [],
    skills: [],
    effort: 'medium',
    maxTurns: 5,
    permissionMode: 'default',
    knowledgeSourceIds: [],
    a2aPublished: true,
    a2aRemoteAgents: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }], registration.user.email, 'tenant_admin');
  const apiKey = store.createApiKey(tenantId, registration.user.email, 'Execution caller', []);

  const app = express();
  const executionManager = new A2AExecutionManager(fakeRunAgent);
  mountA2ARoutes(app, { executionManager });
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.AGENTMA_PUBLIC_URL = baseUrl;
  const cardUrl = `${baseUrl}/a2a/agents/${templateId}/.well-known/agent-card.json`;
  const client = await new ClientFactory().createFromUrl(cardUrl, '');
  const requestOptions = { serviceParameters: { Authorization: `Bearer ${apiKey.rawKey}` } };

  const idempotentMessageId = crypto.randomUUID();
  const first = await client.sendMessage(messageRequest('blocking', idempotentMessageId), requestOptions);
  assert('id' in first);
  assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(first.history.length, 2);
  assert.equal(first.history[0]?.role, Role.ROLE_USER);
  assert.equal(first.history[1]?.role, Role.ROLE_AGENT);
  assert.equal(first.history[1]?.parts[0]?.content?.value, 'hello from blocking');
  assert.equal(first.artifacts.find(item => item.name === 'response')?.parts[0]?.content?.value, 'hello from blocking');
  assert.deepEqual(
    first.artifacts.find(item => item.name === 'structured-output')?.parts[0]?.content?.value,
    { prompt: 'blocking', ok: true },
  );
  assert.equal(observedRunOptions[0]?.model, 'smoke-model');
  assert.equal(observedRunOptions[0]?.apiKey, 'smoke-provider-secret');
  assert.equal(observedRunOptions[0]?.baseUrl, 'https://provider.invalid');
  assert.equal(observedRunOptions[0]?.tenantId, tenantId);
  assert.equal(observedRunOptions[0]?.sub, registration.user.id);
  assert.equal(observedRunOptions[0]?.role, 'tenant_admin');
  assert.equal(observedRunOptions[0]?.templateId, templateId);

  const idempotent = await client.sendMessage(messageRequest('blocking', idempotentMessageId), requestOptions);
  assert('id' in idempotent);
  assert.equal(idempotent.id, first.id);
  assert.equal(runCount, 1);

  const streamed = [];
  for await (const event of client.sendMessageStream(messageRequest('streaming'), requestOptions)) {
    streamed.push(event);
  }
  const streamTask = streamed.find(event => event.payload?.$case === 'task')?.payload.value;
  assert(streamTask?.id);
  assert(streamed.some(event => event.payload?.$case === 'statusUpdate'
    && event.payload.value.status?.state === TaskState.TASK_STATE_WORKING));
  assert(streamed.some(event => event.payload?.$case === 'artifactUpdate'));
  assert(streamed.some(event => event.payload?.$case === 'message'));
  assert(streamed.some(event => event.payload?.$case === 'statusUpdate'
    && event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED));
  assert.equal(streamed.filter(event => event.payload?.$case === 'statusUpdate'
    && event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED).length, 1);

  const replayed = [];
  for await (const event of client.resubscribeTask({ tenant: '', id: streamTask.id }, requestOptions)) {
    replayed.push(event);
  }
  assert.equal(replayed.length, streamed.length);
  assert.equal(replayed[0]?.payload?.$case, 'task');

  const loaded = await client.getTask({ tenant: '', id: streamTask.id, historyLength: 20 }, requestOptions);
  assert.equal(loaded.status?.state, TaskState.TASK_STATE_COMPLETED);
  const listed = await client.listTasks({
    tenant: '',
    contextId: loaded.contextId,
    status: TaskState.TASK_STATE_COMPLETED,
    pageSize: 10,
    pageToken: '',
    historyLength: 20,
    statusTimestampAfter: undefined,
    includeArtifacts: true,
  }, requestOptions);
  assert.equal(listed.totalSize, 1);
  assert.equal(listed.tasks[0]?.id, streamTask.id);

  const pending = await client.sendMessage(messageRequest('wait-for-cancel', crypto.randomUUID(), true), requestOptions);
  assert('id' in pending);
  assert([
    TaskState.TASK_STATE_SUBMITTED,
    TaskState.TASK_STATE_WORKING,
  ].includes(pending.status?.state));
  const canceled = await client.cancelTask({ tenant: '', id: pending.id, metadata: undefined }, requestOptions);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  const canceledReplay = [];
  for await (const event of client.resubscribeTask({ tenant: '', id: pending.id }, requestOptions)) {
    canceledReplay.push(event);
  }
  assert.equal(canceledReplay.filter(event => event.payload?.$case === 'statusUpdate'
    && event.payload.value.status?.state === TaskState.TASK_STATE_CANCELED).length, 1);
  await assert.rejects(
    () => client.cancelTask({ tenant: '', id: pending.id, metadata: undefined }, requestOptions),
    error => error instanceof TaskNotCancelableError,
  );

  const failed = await client.sendMessage(messageRequest('fail'), requestOptions);
  assert('id' in failed);
  assert.equal(failed.status?.state, TaskState.TASK_STATE_FAILED);
  assert.match(failed.status?.message?.parts[0]?.content?.value || '', /deterministic execution failure/);
  const failedReplay = [];
  for await (const event of client.resubscribeTask({ tenant: '', id: failed.id }, requestOptions)) {
    failedReplay.push(event);
  }
  assert.equal(failedReplay.filter(event => event.payload?.$case === 'statusUpdate'
    && event.payload.value.status?.state === TaskState.TASK_STATE_FAILED).length, 1);

  await delay(30);
  const usage = store.getUserQuotaUsage(tenantId, registration.user.id);
  assert.equal(usage.dailyConversations.used, 4);
  assert.equal(usage.fiveHourTokens.used, 24);
  assert.equal(usage.weeklyTokens.used, 24);
  assert.equal(runCount, 4);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'blocking-send', 'idempotency', 'streaming', 'replay', 'get-list', 'cancel',
      'failure', 'text-message', 'structured-artifact', 'run-options', 'quota-once',
    ],
  }));
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
