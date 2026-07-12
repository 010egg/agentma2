import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-bidirectional-'));
process.env.AGENTMA_DATA_DIR = dataDir;
process.env.AGENTMA_A2A_ALLOW_LOOPBACK_HTTP = '1';
let server;
try {
  const store = await import('../server-store.ts');
  const { callA2ARemote } = await import('../server-a2a-client.ts');
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
  app.post('/rpc', (req, res) => {
    sawSecret ||= req.header('authorization') === `Bearer ${secret}`;
    const { method, id, params } = req.body || {};
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
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const config = { name: 'remote', agentCardUrl: `${baseUrl}/card`, credentialRef: credential.id };

  const completed = await callA2ARemote(registration.tenantId, config, { text: 'hello' });
  assert.match(completed, /remote-done/);
  assert.match(completed, /structured-output/);
  assert(!completed.includes(secret));
  assert.equal(sawSecret, true);

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

  const stored = JSON.stringify(store.listA2ACredentials(registration.tenantId));
  assert(!stored.includes(secret));
  console.log(JSON.stringify({
    ok: true,
    checks: ['card', 'credential', 'completed', 'structured-artifact', 'input-required', 'cancel', 'no-secret-leak'],
  }));
} finally {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
