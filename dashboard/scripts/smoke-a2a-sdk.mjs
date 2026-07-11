import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {
  Role,
  TaskState,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from '@a2a-js/sdk/server/express';
import { ClientFactory } from '@a2a-js/sdk/client';

const now = () => new Date().toISOString();
const textPart = (value) => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: 'text/plain',
});
const agentMessage = (contextId, taskId, text) => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [textPart(text)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

const liveBuses = new Map();
const canceledTasks = new Set();

const executor = {
  async execute(context, eventBus) {
    liveBuses.set(context.taskId, eventBus);
    const task = {
      id: context.taskId,
      contextId: context.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() },
      artifacts: [],
      history: [context.userMessage],
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.task(task));
    eventBus.publish(AgentEvent.statusUpdate({
      taskId: context.taskId,
      contextId: context.contextId,
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now() },
      final: false,
      metadata: undefined,
    }));

    const prompt = context.userMessage.parts
      .filter((part) => part.content?.$case === 'text')
      .map((part) => part.content.value)
      .join('\n');
    if (prompt === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (canceledTasks.has(context.taskId)) return;

    eventBus.publish(AgentEvent.artifactUpdate({
      taskId: context.taskId,
      contextId: context.contextId,
      artifact: {
        artifactId: crypto.randomUUID(),
        name: 'answer',
        description: 'SDK smoke result',
        parts: [textPart(`echo:${prompt}`)],
        metadata: undefined,
        extensions: [],
      },
      append: false,
      lastChunk: true,
      metadata: undefined,
    }));
    eventBus.publish(AgentEvent.statusUpdate({
      taskId: context.taskId,
      contextId: context.contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: agentMessage(context.contextId, context.taskId, `done:${prompt}`),
        timestamp: now(),
      },
      final: true,
      metadata: undefined,
    }));
  },

  async cancelTask(taskId, eventBus) {
    canceledTasks.add(taskId);
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId: '',
      status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: now() },
      final: true,
      metadata: undefined,
    }));
    liveBuses.delete(taskId);
  },
};

const card = {
  name: 'AgentMa A2A SDK Smoke Agent',
  description: 'Verifies the pinned official A2A 1.0 JavaScript SDK.',
  supportedInterfaces: [{ url: '', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
  provider: { organization: 'AgentMa', url: 'https://example.invalid' },
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{
    id: 'echo',
    name: 'Echo',
    description: 'Echoes input for protocol verification.',
    tags: ['smoke'],
    examples: ['hello'],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: [],
  }],
  signatures: [],
};

const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
const app = express();
app.use(express.json());
app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/rpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

const server = await new Promise((resolve) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});

try {
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  card.supportedInterfaces[0].url = `${baseUrl}/rpc`;

  const rawCardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`, {
    headers: { 'A2A-Version': '1.0' },
  });
  assert.equal(rawCardResponse.status, 200);
  const rawCard = await rawCardResponse.json();
  assert.equal(rawCard.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(rawCard.capabilities.streaming, true);

  const client = await new ClientFactory().createFromUrl(baseUrl);
  const makeRequest = (text, returnImmediately = false) => ({
    tenant: '',
    message: {
      messageId: crypto.randomUUID(),
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: undefined,
      historyLength: undefined,
      returnImmediately,
    },
    metadata: undefined,
  });

  const sent = await client.sendMessage(makeRequest('sync'));
  assert('id' in sent, 'blocking SendMessage should return a Task');
  assert.equal(sent.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(sent.artifacts[0]?.parts[0]?.content?.value, 'echo:sync');

  const streamed = [];
  for await (const event of client.sendMessageStream(makeRequest('stream'))) streamed.push(event);
  assert(streamed.some((event) => event.payload?.$case === 'task'));
  assert(streamed.some((event) => event.payload?.$case === 'artifactUpdate'));
  assert(streamed.some((event) => (
    event.payload?.$case === 'statusUpdate'
    && event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED
  )));
  const streamedTask = streamed.find((event) => event.payload?.$case === 'task')?.payload.value;
  assert(streamedTask?.id);

  const loaded = await client.getTask({ tenant: '', id: streamedTask.id, historyLength: undefined });
  assert.equal(loaded.id, streamedTask.id);
  const listed = await client.listTasks({
    tenant: '',
    contextId: streamedTask.contextId,
    // The beta SDK's InMemoryTaskStore treats UNSPECIFIED as a literal filter,
    // so verify ListTasks with the known terminal state instead of "all".
    status: TaskState.TASK_STATE_COMPLETED,
    pageSize: 100,
    pageToken: '',
    historyLength: undefined,
    statusTimestampAfter: undefined,
    includeArtifacts: true,
  });
  assert(listed.tasks.some((task) => task.id === streamedTask.id));

  const pending = await client.sendMessage(makeRequest('wait', true));
  assert('id' in pending);
  const canceled = await client.cancelTask({ tenant: '', id: pending.id });
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);

  const badVersion = await fetch(`${baseUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '9.9' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'bad-version', method: 'GetTask', params: { id: 'missing' } }),
  });
  const badVersionBody = await badVersion.json();
  assert.equal(badVersionBody.error?.code, -32009);

  console.log(JSON.stringify({
    ok: true,
    sdk: '1.0.0-beta.0',
    checks: ['card', 'send', 'stream', 'get', 'list', 'cancel', 'version'],
  }));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
