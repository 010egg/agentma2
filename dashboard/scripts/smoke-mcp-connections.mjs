import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-mcp-smoke-'));
process.env.AGENTMA_DATA_DIR = tempRoot;
process.env.AGENTMA_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.AGENTMA_MCP_ALLOW_HTTP;
delete process.env.AGENTMA_MCP_HOST_ALLOWLIST;

const dbPath = path.join(tempRoot, 'dashboard.sqlite');
const seedDb = new DatabaseSync(dbPath);
seedDb.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE tenants (id TEXT PRIMARY KEY);
  INSERT INTO tenants (id) VALUES ('tenant-smoke');
`);

const mcp = await import('../server-mcp-connections.ts');
const tenantId = 'tenant-smoke';
const userA = 'user-a';
const userB = 'user-b';
const token = 'Bearer smoke-secret-token-12345';

await assert.rejects(
  () => mcp.validateMcpUrl('http://8.8.8.8/mcp'),
  error => error instanceof mcp.McpConnectionError && /HTTPS/.test(error.message),
);
for (const url of [
  'https://127.0.0.1/mcp',
  'https://192.168.1.10/mcp',
  'https://169.254.169.254/latest/meta-data',
  'https://[::1]/mcp',
  'https://[fc00::1]/mcp',
]) {
  await assert.rejects(() => mcp.validateMcpUrl(url), mcp.McpConnectionError);
}
await assert.rejects(
  () => mcp.createMcpConnection(tenantId, userA, { name: 'custom', url: 'https://8.8.8.8/mcp' }),
  mcp.McpConnectionError,
);
const configuredSecretsKey = process.env.AGENTMA_SECRETS_KEY;
delete process.env.AGENTMA_SECRETS_KEY;
await assert.rejects(
  () => mcp.createMcpConnection(tenantId, userA, {
    name: 'missing-key',
    url: 'https://8.8.8.8/mcp',
    headers: { Authorization: token },
  }),
  error => error instanceof mcp.McpConnectionError && error.code === 'secrets_key_missing',
);
process.env.AGENTMA_SECRETS_KEY = configuredSecretsKey;

const created = await mcp.createMcpConnection(tenantId, userA, {
  name: 'mydb',
  url: 'https://8.8.8.8/mcp',
  type: 'http',
  headers: { Authorization: token },
  description: 'smoke database',
});
assert.equal(created.name, 'mydb');
assert.equal(created.headers.Authorization, 'Bearer smo****');
assert.equal(created.hasHeaders, true);

const storedBeforePatch = seedDb.prepare('SELECT headers_enc FROM mcp_connections WHERE id = ?').get(created.id);
assert(storedBeforePatch?.headers_enc);
assert(!String(storedBeforePatch.headers_enc).includes(token));

await mcp.updateMcpConnection(tenantId, created.id, userA, 'member', { description: 'patched' });
const storedAfterPatch = seedDb.prepare('SELECT headers_enc FROM mcp_connections WHERE id = ?').get(created.id);
assert.equal(storedAfterPatch.headers_enc, storedBeforePatch.headers_enc);

await assert.rejects(
  () => mcp.createMcpConnection(tenantId, userA, { name: 'mydb', url: 'https://8.8.8.8/other' }),
  error => error instanceof mcp.McpConnectionError && /已存在/.test(error.message),
);

const hidden = await mcp.resolveMcpConnectionsForRun({
  tenantId,
  viewerSub: userB,
  viewerRole: 'member',
  names: ['mydb'],
});
assert.deepEqual(hidden.connections, []);
assert.deepEqual(hidden.effectiveServerNames, []);
assert.match(hidden.warnings[0], /未对你开放/);

mcp.setMcpConnectionPublished(tenantId, created.id, userA, 'member', true);
const shared = await mcp.resolveMcpConnectionsForRun({
  tenantId,
  viewerSub: userB,
  viewerRole: 'member',
  names: ['mydb', 'imported-server'],
});
assert.equal(shared.connections[0].headers.Authorization, token);
assert.deepEqual(shared.effectiveServerNames, ['mydb', 'imported-server']);

mcp.setMcpConnectionPublished(tenantId, created.id, userA, 'member', false);
process.env.AGENTMA_MCP_ALLOW_HTTP = '1';
process.env.AGENTMA_MCP_HOST_ALLOWLIST = '127.0.0.1';

const demoHttp = http.createServer(async (req, res) => {
  if (req.headers.authorization !== token) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const requestMcp = new McpServer({ name: 'agentma-smoke-mcp', version: '1.0.0' });
    requestMcp.registerTool('query_demo', {
      description: 'Run a read-only demo query',
    }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const requestTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await requestMcp.connect(requestTransport);
    await requestTransport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    res.once('close', () => {
      void requestTransport.close();
      void requestMcp.close();
    });
  } catch (error) {
    console.error('demo MCP failed', error);
    if (!res.headersSent) res.writeHead(500);
    res.end('demo failure');
  }
});
await new Promise((resolve) => demoHttp.listen(0, '127.0.0.1', resolve));
const demoAddress = demoHttp.address();
assert(demoAddress && typeof demoAddress === 'object');
await mcp.updateMcpConnection(tenantId, created.id, userA, 'member', {
  url: `http://127.0.0.1:${demoAddress.port}/mcp`,
});
const successfulCheck = await mcp.checkMcpConnection(tenantId, created.id, userA, 'member');
assert.equal(successfulCheck.server.name, 'agentma-smoke-mcp');
assert.deepEqual(successfulCheck.tools, [{ name: 'query_demo', description: 'Run a read-only demo query' }]);
await new Promise((resolve, reject) => demoHttp.close(error => error ? reject(error) : resolve()));

await mcp.updateMcpConnection(tenantId, created.id, userA, 'member', {
  url: 'http://127.0.0.1:9/mcp',
});
const unreachable = await mcp.resolveMcpConnectionsForRun({
  tenantId,
  viewerSub: userA,
  viewerRole: 'member',
  names: ['mydb'],
});
assert.equal(unreachable.connections.length, 1);
assert.equal(unreachable.connections[0].url, 'http://127.0.0.1:9/mcp');

await assert.rejects(
  () => mcp.checkMcpConnection(tenantId, created.id, userA, 'member'),
  error => error instanceof mcp.McpConnectionError
    && error.code === 'check_failed'
    && !error.message.includes(token)
    && !error.message.includes('smoke-secret-token-12345'),
);
const checkState = seedDb.prepare('SELECT last_check_ok FROM mcp_connections WHERE id = ?').get(created.id);
assert.equal(checkState.last_check_ok, 0);

await assert.rejects(
  () => mcp.resolveMcpConnectionsForRun({
    tenantId,
    viewerSub: userA,
    names: Array.from({ length: 9 }, (_, index) => `server-${index}`),
  }),
  error => error instanceof mcp.McpConnectionError && /最多选择 8/.test(error.message),
);

for (const entry of fs.readdirSync(tempRoot)) {
  const filePath = path.join(tempRoot, entry);
  if (!fs.statSync(filePath).isFile()) continue;
  assert(!fs.readFileSync(filePath).includes(Buffer.from('smoke-secret-token-12345')));
}

seedDb.close();
console.log(JSON.stringify({
  ok: true,
  checks: [
    'https-only', 'private-addresses', 'reserved-name', 'missing-secrets-key', 'duplicate-name', 'encrypted-at-rest',
    'masked-api-shape', 'patch-retains-headers', 'visibility', 'publish-sharing', 'legacy-name',
    'authenticated-check-success', 'unreachable-runtime-assembly', 'redacted-check-error', 'template-limit', 'no-token-on-disk',
  ],
}));
