import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-bidirectional-'));
process.env.AGENTMA_DATA_DIR = dataDir;
process.env.AGENTMA_A2A_ALLOW_LOOPBACK_HTTP = '1';
let server;
let mcpClient;
let mcpServerInstance;
try {
  const store = await import('../server-store.ts');
  const {
    buildA2ARemoteMcp,
    callA2ARemote,
    describeA2ARemoteTools,
    discoverA2ARemoteAgent,
    remoteA2AToolName,
  } = await import('../server-a2a-client.ts');
  const registration = store.registerUser('Remote Caller', `remote-${Date.now()}@gmail.com`, 'password123');
  assert.equal(registration.ok, true);
  const secret = `remote-secret-${crypto.randomUUID()}`;
  const credential = store.createA2ACredential(
    registration.tenantId, registration.user.email, 'Remote smoke credential', secret,
  );
  let baseUrl = '';
  let cancelCount = 0;
  let sawSecret = false;
  const app = express();
  app.use(express.json());
  app.get('/card', (_req, res) => res.json({
    name: 'Remote Smoke Agent', description: 'remote', version: '1.0.0',
    supportedInterfaces: [{ url: `${baseUrl}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    capabilities: { streaming: false }, skills: [], securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], signatures: [],
  }));
  app.get('/large-card', (_req, res) => res.json({
    name: 'Large Remote Smoke Agent', description: 'remote', version: '1.0.0',
    supportedInterfaces: [{ url: `${baseUrl}/large-rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    capabilities: { streaming: false }, skills: [], securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], signatures: [],
  }));
  app.post('/rpc', (req, res) => {
    sawSecret ||= req.header('authorization') === `Bearer ${secret}`;
    const { method, id, params } = req.body || {};
    if (method === 'SendMessage' && params?.message?.parts?.[0]?.text === 'echo-secret') {
      res.json({ jsonrpc: '2.0', id, result: { task: {
        id: 'remote-echo-task', contextId: 'remote-context',
        status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: secret }] } },
        artifacts: [], history: [],
      } } });
      return;
    }
    if (method === 'SendMessage' && params?.message?.parts?.[0]?.text === 'error-secret') {
      res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: `malicious echo ${secret}` } });
      return;
    }
    if (method === 'GetTask') {
      res.json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } });
      return;
    }
    if (method === 'CancelTask') {
      cancelCount += 1;
      res.json({ jsonrpc: '2.0', id, result: { id: params.id, contextId: 'ctx', status: { state: 'TASK_STATE_CANCELED' } } });
      return;
    }
    const continuation = params?.message?.taskId;
    const inputText = params?.message?.parts?.[0]?.text;
    if (inputText === 'needs-input' && !continuation) {
      res.json({ jsonrpc: '2.0', id, result: { task: {
        id: 'remote-input-task', contextId: 'remote-context',
        status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { parts: [{
          data: { type: 'permission', toolName: 'RemoteWrite', input: {} },
        }] } }, artifacts: [], history: [],
      } } });
      return;
    }
    res.json({ jsonrpc: '2.0', id, result: { task: {
      id: continuation || 'remote-complete-task', contextId: 'remote-context',
      status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'remote-done' }] } },
      artifacts: [{ artifactId: 'structured', name: 'structured-output', parts: [{ data: { ok: true } }] }],
      history: [],
    } } });
  });
  app.post('/large-rpc', (req, res) => {
    const { id } = req.body || {};
    res.json({ jsonrpc: '2.0', id, result: { event: 'x'.repeat(2 * 1024 * 1024 + 1) } });
  });
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const config = { name: 'remote', agentCardUrl: `${baseUrl}/card`, credentialRef: credential.id };
  const discovered = await discoverA2ARemoteAgent(registration.tenantId, config.agentCardUrl);
  assert.equal(discovered.name, 'Remote Smoke Agent');
  assert.equal(discovered.rpcUrl, `${baseUrl}/rpc`);
  const chineseToolName = remoteA2AToolName('中文研究员', config.agentCardUrl, 0);
  assert.match(chineseToolName, /^remote_agent_[a-f0-9]{8}$/);
  assert.notEqual(chineseToolName, remoteA2AToolName('中文审核员', config.agentCardUrl, 0));
  const descriptors = describeA2ARemoteTools([{ ...config, name: '中文研究员' }]);
  assert.equal(descriptors[0].toolName, chineseToolName);
  assert.equal(descriptors[0].sdkToolName, `mcp__a2a__${chineseToolName}`);

  const completed = await callA2ARemote(registration.tenantId, config, { text: 'hello' });
  assert.match(completed, /remote-done/);
  assert.match(completed, /structured-output/);
  assert(!completed.includes(secret));
  assert.equal(sawSecret, true);

  const echoed = await callA2ARemote(registration.tenantId, config, { text: 'echo-secret' });
  assert(!echoed.includes(secret));
  assert.match(echoed, /\[REDACTED\]/);
  await assert.rejects(
    () => callA2ARemote(registration.tenantId, config, { text: 'error-secret' }),
    error => !String(error?.message || error).includes(secret) && /\[REDACTED\]/.test(String(error?.message || error)),
  );

  await assert.rejects(
    () => callA2ARemote(registration.tenantId, { name: 'large', agentCardUrl: `${baseUrl}/large-card` }, { text: 'large' }),
    error => error?.code === 'response_too_large',
  );

  const continued = await callA2ARemote(
    registration.tenantId,
    config,
    { text: 'needs-input' },
    async request => ({ answers: { [request.questions[0].question]: 'Allow' } }),
  );
  assert.match(continued, /TASK_STATE_COMPLETED/);
  assert.match(continued, /remote-input-task/);

  const abortController = new AbortController();
  const canceledCall = callA2ARemote(
    registration.tenantId,
    config,
    { text: 'needs-input' },
    request => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
    abortController.signal,
  );
  setTimeout(() => abortController.abort(), 25);
  await assert.rejects(canceledCall, /aborted/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cancelCount, 1);

  const a2aLogs = [];
  const mcp = buildA2ARemoteMcp(registration.tenantId, [{ ...config, name: '中文研究员' }], {
    onLog: event => a2aLogs.push(event),
  });
  assert(mcp);
  mcpServerInstance = mcp.instance;
  mcpClient = new Client({ name: 'a2a-smoke-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), mcpServerInstance.connect(serverTransport)]);
  const listedTools = await mcpClient.listTools();
  assert.equal(listedTools.tools[0].name, chineseToolName);
  const mcpCompleted = await mcpClient.callTool({ name: chineseToolName, arguments: { text: 'hello' } });
  assert.equal(mcpCompleted.isError, undefined);
  const mcpFailed = await mcpClient.callTool({ name: chineseToolName, arguments: { text: 'error-secret' } });
  assert.equal(mcpFailed.isError, true);
  assert(a2aLogs.some(event => event.message.startsWith('A2A 调用开始：中文研究员')));
  assert(a2aLogs.some(event => event.message.startsWith('A2A 调用完成：中文研究员')));
  assert(a2aLogs.some(event => event.message.startsWith('A2A 调用失败：中文研究员')));
  assert(!JSON.stringify(a2aLogs).includes(secret));

  const serverSource = fs.readFileSync(path.resolve(import.meta.dirname, '../server.ts'), 'utf8');
  const chatRoute = serverSource.slice(
    serverSource.indexOf("app.post('/api/chat'"),
    serverSource.indexOf("app.post('/api/chat/next-suggestion'"),
  );
  const agentRunRoute = serverSource.slice(serverSource.indexOf("app.post('/api/agents/run'"));
  assert.match(chatRoute, /a2aRemoteAgents:\s*Array\.isArray\(template\?\.a2aRemoteAgents\)/);
  assert.match(agentRunRoute, /a2aRemoteAgents:\s*Array\.isArray\(storedTemplate\?\.a2aRemoteAgents\)/);
  assert.doesNotMatch(agentRunRoute, /a2aRemoteAgents:\s*Array\.isArray\(tmpl\?\.a2aRemoteAgents\)/);
  const agentRuntimeSource = fs.readFileSync(path.resolve(import.meta.dirname, '../server-agent.ts'), 'utf8');
  assert.match(agentRuntimeSource, /const allowedByA2ARemote = a2aRuntimeToolNames\.has\(toolName\)/);
  assert.match(agentRuntimeSource, /!allowedByBuiltinMemory && !allowedByA2ARemote/);

  const stored = JSON.stringify(store.listA2ACredentials(registration.tenantId));
  assert(!stored.includes(secret));
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'card', 'card-discovery', 'chinese-tool-name', 'credential', 'completed', 'structured-artifact', 'input-required', 'cancel',
      'credential-redaction', 'oversized-remote-event', 'no-secret-leak', 'mcp-runtime-logs', 'chat-runtime-wiring',
      'template-a2a-authorization',
    ],
  }));
} finally {
  if (mcpClient) await mcpClient.close().catch(() => {});
  if (mcpServerInstance) await mcpServerInstance.close().catch(() => {});
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
