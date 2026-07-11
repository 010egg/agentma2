import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCredentialCipher,
  loadCredentialMasterKey,
} from '../server-credentials.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-credentials-'));
process.env.AGENTMA_DATA_DIR = tempDir;

try {
  const key = loadCredentialMasterKey({ dataDir: tempDir });
  assert.equal(key.length, 32);
  assert.equal(fs.statSync(path.join(tempDir, 'a2a-credential-key')).mode & 0o777, 0o600);
  const cipher = createCredentialCipher(key);
  const first = cipher.encrypt('top-secret');
  const second = cipher.encrypt('top-secret');
  assert.notEqual(first, second);
  assert.equal(cipher.decrypt(first), 'top-secret');
  const tampered = JSON.parse(first);
  tampered.data = Buffer.from(crypto.randomBytes(8)).toString('base64');
  assert.throws(() => cipher.decrypt(JSON.stringify(tampered)), /authentication failed/);
  assert.throws(
    () => loadCredentialMasterKey({ envKey: Buffer.alloc(31).toString('base64') }),
    /32-byte key/,
  );

  const store = await import('../server-store.ts');
  const registration = store.registerUser('A2A Admin', `a2a-smoke-${crypto.randomUUID()}@gmail.com`, 'secret123');
  assert.equal(registration.ok, true);
  const tenantId = registration.tenantId;
  const actor = registration.user.id;

  const created = store.createA2ACredential(tenantId, registration.user.email, 'Remote Agent', 'bearer-one');
  assert.equal(store.resolveA2ACredential(tenantId, created.id), 'bearer-one');
  assert.equal(store.resolveA2ACredential('another-tenant', created.id), null);
  const listedJson = JSON.stringify(store.listA2ACredentials(tenantId));
  assert(!listedJson.includes('bearer-one'));
  assert(!listedJson.includes('secret_ciphertext'));

  const rotated = store.rotateA2ACredential(tenantId, created.id, actor, 'bearer-two');
  assert.equal(rotated?.id, created.id);
  assert.equal(store.resolveA2ACredential(tenantId, created.id), 'bearer-two');

  store.replaceAgentTemplates(tenantId, [{
    id: 'references-credential',
    name: 'References credential',
    a2aRemoteAgents: [{ name: 'remote', agentCardUrl: 'https://example.com/card', credentialRef: created.id }],
  }], actor, 'tenant_admin');
  assert.deepEqual(store.deleteA2ACredential(tenantId, created.id, actor), { ok: false, reason: 'in_use' });
  store.replaceAgentTemplates(tenantId, [], actor, 'tenant_admin');
  assert.deepEqual(store.deleteA2ACredential(tenantId, created.id, actor), { ok: true });
  assert.equal(store.resolveA2ACredential(tenantId, created.id), null);

  console.log(JSON.stringify({
    ok: true,
    checks: ['key-mode', 'random-nonce', 'authenticated-decryption', 'tenant-scope', 'redaction', 'rotation', 'reference-guard'],
  }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
