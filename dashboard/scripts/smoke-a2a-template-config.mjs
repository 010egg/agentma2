import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let baseUrl = process.env.AGENTMA_SMOKE_BASE_URL || 'http://127.0.0.1:3001';

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port')));
    });
  });
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${url}/api/health`);
      if (health.response.ok) return;
      lastError = `HTTP ${health.response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await delay(250);
  }
  throw new Error(`server health failed: ${lastError || 'timeout'}`);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return true;
  let done = false;
  await Promise.race([
    new Promise(resolve => child.once('exit', () => { done = true; resolve(); })),
    delay(timeoutMs),
  ]);
  return done || childExited(child);
}

function signalManagedServer(managed, signal) {
  if (!managed.child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-managed.child.pid, signal); return; } catch {}
  }
  if (!childExited(managed.child)) managed.child.kill(signal);
}

async function startManagedServer() {
  const port = Number(process.env.AGENTMA_SMOKE_PORT || await getFreePort());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-template-'));
  const child = spawn('npm', ['run', 'server'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      AGENTMA_DATA_DIR: dataDir,
      AGENTMA_SKIP_RECOVER: '1',
      AGENTMA_A2A_ALLOW_LOOPBACK_HTTP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', chunk => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));
  baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { child, dataDir };
}

async function stopManagedServer(managed) {
  if (!managed) return;
  if (!childExited(managed.child)) {
    signalManagedServer(managed, 'SIGINT');
    await waitForChildExit(managed.child, 2500);
  }
  if (!childExited(managed.child)) {
    signalManagedServer(managed, 'SIGKILL');
    await waitForChildExit(managed.child, 1500);
  }
  fs.rmSync(managed.dataDir, { recursive: true, force: true });
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function template(id, name, patch = {}) {
  const timestamp = Date.now();
  return {
    id,
    name,
    description: `${name} description`,
    systemPrompt: `You are ${name}.`,
    model: 'claude-smoke-model',
    tools: ['Read'],
    subagents: {},
    mcpServers: [],
    eventSources: [],
    skills: [],
    effort: 'medium',
    maxTurns: 10,
    permissionMode: 'default',
    knowledgeSourceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

async function main() {
  let managedServer = null;
  try {
    if (process.env.AGENTMA_SMOKE_START_SERVER === '1') managedServer = await startManagedServer();
    await waitForHealth(baseUrl);

    const stamp = Date.now();
    const adminEmail = `a2a-template-admin-${stamp}@gmail.com`;
    const memberEmail = `a2a-template-member-${stamp}@gmail.com`;
    const admin = await requireOk('register admin', fetchJson(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A2A Template Admin', email: adminEmail, password: 'test-password-123' }),
    }));
    const adminHeaders = headers(admin.token);

    await requireOk('create member', fetchJson(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'A2A Template Member', email: memberEmail, password: 'test-password-123', role: 'member' }),
    }));
    const member = await requireOk('login member', fetchJson(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: 'test-password-123' }),
    }));
    const memberHeaders = headers(member.token);

    const credentialSecret = `never-leak-${stamp}`;
    const credential = await requireOk('create credential', fetchJson(`${baseUrl}/api/a2a/credentials`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Partner production', secret: credentialSecret }),
    }));
    const memberOptions = await requireOk('member credential options', fetchJson(`${baseUrl}/api/a2a/credential-options`, {
      headers: memberHeaders,
    }));

    const configured = template('a2a-configured', 'Configured Agent', {
      publishedAt: Date.now(),
      a2aPublished: true,
      a2aRemoteAgents: [{
        name: 'Research Partner',
        agentCardUrl: 'https://example.com/.well-known/agent-card.json',
        credentialRef: credential.id,
        secret: 'strip-this-field',
      }],
    });
    const legacy = template('a2a-legacy', 'Legacy Agent');
    await requireOk('save configured templates', fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify([configured, legacy]),
    }));
    const adminList = await requireOk('list normalized templates', fetchJson(`${baseUrl}/api/agents`, { headers: adminHeaders }));
    const storedConfigured = adminList.find(item => item.id === configured.id);
    const storedLegacy = adminList.find(item => item.id === legacy.id);

    const tampered = {
      ...storedConfigured,
      a2aPublished: false,
      a2aRemoteAgents: [],
      updatedAt: Date.now(),
    };
    await requireOk('non-owner mutation ignored', fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: memberHeaders,
      body: JSON.stringify([tampered]),
    }));
    const afterTamper = await requireOk('list after tamper', fetchJson(`${baseUrl}/api/agents`, { headers: adminHeaders }));
    const protectedConfigured = afterTamper.find(item => item.id === configured.id);

    const memberOwned = template('a2a-member-owned', 'Member Owned Agent', {
      a2aPublished: true,
      a2aRemoteAgents: [{
        name: 'Local Development',
        agentCardUrl: 'http://127.0.0.1:4242/.well-known/agent-card.json',
        credentialRef: credential.id,
      }],
    });
    await requireOk('member saves owned config', fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: memberHeaders,
      body: JSON.stringify([tampered, memberOwned]),
    }));
    const afterMemberCreate = await requireOk('admin sees member config', fetchJson(`${baseUrl}/api/agents`, { headers: adminHeaders }));
    const storedMemberOwned = afterMemberCreate.find(item => item.id === memberOwned.id);

    const cloned = template('a2a-configured-clone', 'Configured Agent Clone', {
      a2aPublished: storedConfigured.a2aPublished,
      a2aRemoteAgents: storedConfigured.a2aRemoteAgents,
    });
    await requireOk('clone-style save preserves refs', fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify([...afterMemberCreate, cloned]),
    }));
    const afterClone = await requireOk('list after clone', fetchJson(`${baseUrl}/api/agents`, { headers: adminHeaders }));
    const storedClone = afterClone.find(item => item.id === cloned.id);

    const duplicateNames = await fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify([template('bad-duplicate', 'Bad Duplicate', {
        a2aRemoteAgents: [
          { name: 'Remote', agentCardUrl: 'https://one.example/card' },
          { name: 'remote', agentCardUrl: 'https://two.example/card' },
        ],
      })]),
    });
    const insecureUrl = await fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify([template('bad-http', 'Bad HTTP', {
        a2aRemoteAgents: [{ name: 'Remote', agentCardUrl: 'http://example.com/card' }],
      })]),
    });
    const unknownCredential = await fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify([template('bad-credential', 'Bad Credential', {
        a2aRemoteAgents: [{ name: 'Remote', agentCardUrl: 'https://example.com/card', credentialRef: 'other-tenant-secret' }],
      })]),
    });
    const tooManyRemotes = await fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify([template('bad-limit', 'Bad Limit', {
        a2aRemoteAgents: Array.from({ length: 17 }, (_, index) => ({
          name: `remote-${index}`,
          agentCardUrl: `https://remote-${index}.example/card`,
        })),
      })]),
    });

    const apiPayload = JSON.stringify({ adminList, memberOptions, afterClone });
    const checks = {
      legacyDefaults: storedLegacy?.a2aPublished === false && Array.isArray(storedLegacy?.a2aRemoteAgents) && storedLegacy.a2aRemoteAgents.length === 0,
      configuredRoundTrip: storedConfigured?.a2aPublished === true
        && storedConfigured?.a2aRemoteAgents?.[0]?.credentialRef === credential.id
        && !('secret' in storedConfigured.a2aRemoteAgents[0]),
      credentialOptionsForManager: memberOptions.some(item => item.id === credential.id && item.name === credential.name),
      noCredentialLeak: !apiPayload.includes(credentialSecret) && !apiPayload.includes('secret_ciphertext'),
      unauthorizedChangeIgnored: protectedConfigured?.a2aPublished === true && protectedConfigured?.a2aRemoteAgents?.length === 1,
      memberOwnConfigAllowed: storedMemberOwned?.a2aPublished === true && storedMemberOwned?.a2aRemoteAgents?.[0]?.credentialRef === credential.id,
      clonePreservesReference: storedClone?.a2aRemoteAgents?.[0]?.credentialRef === credential.id,
      duplicateNamesRejected: duplicateNames.response.status === 400,
      insecureUrlRejected: insecureUrl.response.status === 400,
      unknownCredentialRejected: unknownCredential.response.status === 400,
      arrayLimitRejected: tooManyRemotes.response.status === 400,
    };

    console.log(JSON.stringify({ ok: true, checks }));
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) throw new Error(`A2A template config checks failed: ${failed.join(', ')}`);
  } finally {
    await stopManagedServer(managedServer);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
