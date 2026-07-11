import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, RequestMalformedError, TaskNotFoundError } from '@a2a-js/sdk/client';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-input-'));
process.env.AGENTMA_DATA_DIR = dataDir;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const part = (kind, value) => ({
  content: { $case: kind, value },
  metadata: undefined,
  filename: '',
  mediaType: kind === 'data' ? 'application/json' : 'text/plain',
});
const request = (text, options = {}) => ({
  tenant: '',
  message: {
    messageId: options.messageId || crypto.randomUUID(),
    contextId: options.contextId || '',
    taskId: options.taskId || '',
    role: Role.ROLE_USER,
    parts: [part(options.data ? 'data' : 'text', options.data || text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: {
    acceptedOutputModes: ['text/plain'],
    taskPushNotificationConfig: undefined,
    historyLength: 20,
    returnImmediately: options.returnImmediately === true,
  },
  metadata: undefined,
});

async function waitForState(client, id, state, callOptions, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await client.getTask({ tenant: '', id, historyLength: 20 }, callOptions);
    if (task.status?.state === state) return task;
    await delay(10);
  }
  throw new Error(`task ${id} did not reach state ${state}`);
}

const fakeRunAgent = async options => {
  let text;
  if (options.prompt.startsWith('permission')) {
    const decision = await options.requestPermission({
      toolName: 'Write',
      input: { path: 'output.txt' },
      title: 'Write output',
      description: 'Allow the Agent to write output.txt.',
      toolUseID: crypto.randomUUID(),
    });
    text = `permission:${decision.decision}`;
  } else {
    const answer = await options.requestUserQuestion({
      questions: [{
        question: 'Which color?',
        header: 'Color',
        options: [{ label: 'Blue', description: 'Choose blue' }],
        multiSelect: false,
      }],
      toolUseID: crypto.randomUUID(),
    });
    text = `answer:${answer.answers['Which color?'] || ''}`;
  }
  options.emit({ type: 'delta', text });
  options.emit({ type: 'run_outcome', outcome: 'completed', subtype: 'success' });
  return {
    subtype: 'success', outcome: 'completed', text,
    inputTokens: 1, outputTokens: 1, durationMs: 1, costUsd: 0, model: options.model,
  };
};

let server;
try {
  const store = await import('../server-store.ts');
  const { A2AInputRegistry } = await import('../server-a2a-input.ts');
  const { A2AExecutionManager } = await import('../server-a2a-executor.ts');
  const { mountA2ARoutes } = await import('../server-a2a.ts');
  const registration = store.registerUser('Input Admin', `a2a-input-${Date.now()}@gmail.com`, 'password123');
  assert.equal(registration.ok, true);
  const tenantId = registration.tenantId;
  store.replaceProviderProfiles(tenantId, [{
    id: 'provider', name: 'Provider', ANTHROPIC_AUTH_TOKEN: 'secret',
    ANTHROPIC_BASE_URL: 'https://provider.invalid', availableModels: ['input-model'], enabled: true, isDefault: true,
  }]);
  store.replaceAgentTemplates(tenantId, [{
    id: 'input-agent', name: 'Input Agent', description: 'Input smoke', systemPrompt: '', model: 'input-model',
    tools: ['Write', 'AskUserQuestion'], subagents: {}, mcpServers: [], eventSources: [], skills: [],
    effort: 'medium', maxTurns: 5, permissionMode: 'default', knowledgeSourceIds: [],
    a2aPublished: true, a2aRemoteAgents: [], createdAt: Date.now(), updatedAt: Date.now(),
  }], registration.user.email, 'tenant_admin');
  const apiKey = store.createApiKey(tenantId, registration.user.email, 'caller', []);
  const otherKey = store.createApiKey(tenantId, registration.user.email, 'other caller', []);
  const manager = new A2AExecutionManager(fakeRunAgent, new A2AInputRegistry(80));
  const app = express();
  mountA2ARoutes(app, { executionManager: manager });
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.AGENTMA_PUBLIC_URL = baseUrl;
  const client = await new ClientFactory().createFromUrl(
    `${baseUrl}/a2a/agents/input-agent/.well-known/agent-card.json`, '',
  );
  const auth = { serviceParameters: { Authorization: `Bearer ${apiKey.rawKey}` } };
  const otherAuth = { serviceParameters: { Authorization: `Bearer ${otherKey.rawKey}` } };

  for (const decision of ['allow', 'deny']) {
    const pending = await client.sendMessage(request(`permission-${decision}`, { returnImmediately: true }), auth);
    assert('id' in pending);
    const inputTask = await waitForState(client, pending.id, TaskState.TASK_STATE_INPUT_REQUIRED, auth);
    assert.equal(inputTask.status?.message?.parts[1]?.content?.value?.type, 'permission');
    if (decision === 'allow') {
      await assert.rejects(
        () => client.sendMessage(request('', {
          taskId: pending.id, contextId: pending.contextId, data: { decision: 'maybe' },
        }), auth),
        error => error instanceof RequestMalformedError,
      );
      await assert.rejects(
        () => client.sendMessage(request('', {
          taskId: pending.id, contextId: `${pending.contextId}-wrong`, data: { decision },
        }), auth),
        error => error instanceof TaskNotFoundError,
      );
      await assert.rejects(
        () => client.sendMessage(request('', {
          taskId: pending.id, contextId: pending.contextId, data: { decision },
        }), otherAuth),
        error => error instanceof TaskNotFoundError,
      );
    }
    const resumed = await client.sendMessage(request('', {
      taskId: pending.id, contextId: pending.contextId, data: { decision },
    }), auth);
    assert('id' in resumed);
    assert.equal(resumed.id, pending.id);
    assert.equal(resumed.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(resumed.status?.message?.parts[0]?.content?.value, `permission:${decision}`);
  }

  const questionPending = await client.sendMessage(request('question', { returnImmediately: true }), auth);
  assert('id' in questionPending);
  await waitForState(client, questionPending.id, TaskState.TASK_STATE_INPUT_REQUIRED, auth);
  const answered = await client.sendMessage(request('', {
    taskId: questionPending.id,
    contextId: questionPending.contextId,
    data: { answers: { 'Which color?': 'Blue' } },
  }), auth);
  assert('id' in answered);
  assert.equal(answered.status?.message?.parts[0]?.content?.value, 'answer:Blue');

  const canceledPending = await client.sendMessage(request('permission-cancel', { returnImmediately: true }), auth);
  assert('id' in canceledPending);
  await waitForState(client, canceledPending.id, TaskState.TASK_STATE_INPUT_REQUIRED, auth);
  const canceled = await client.cancelTask({ tenant: '', id: canceledPending.id, metadata: undefined }, auth);
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);

  const timeoutPending = await client.sendMessage(request('permission-timeout', { returnImmediately: true }), auth);
  assert('id' in timeoutPending);
  await waitForState(client, timeoutPending.id, TaskState.TASK_STATE_INPUT_REQUIRED, auth);
  const timedOut = await waitForState(client, timeoutPending.id, TaskState.TASK_STATE_FAILED, auth);
  assert.match(timedOut.status?.message?.parts[0]?.content?.value || '', /timed out/i);

  console.log(JSON.stringify({
    ok: true,
    checks: ['permission-allow', 'permission-deny', 'questions', 'scope-match', 'cancel-release', 'timeout'],
  }));
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
