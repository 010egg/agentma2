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
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

async function requireOk(label, request) {
  const result = await request;
  if (!result.response.ok) {
    throw new Error(`${label} failed ${result.response.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('failed to allocate a local port'));
      });
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
    new Promise((resolve) => child.once('exit', () => {
      done = true;
      resolve();
    })),
    delay(timeoutMs),
  ]);
  return done || childExited(child);
}

function signalManagedServer(managed, signal) {
  if (!managed.child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-managed.child.pid, signal);
      return;
    } catch {}
  }
  if (!childExited(managed.child)) managed.child.kill(signal);
}

async function startManagedServer() {
  const port = Number(process.env.AGENTMA_SMOKE_PORT || await getFreePort());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-import-data-'));
  const child = spawn('npm', ['run', 'server'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), AGENTMA_DATA_DIR: dataDir, AGENTMA_SKIP_RECOVER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

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

function appendFile(form, relativePath, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  form.append('files', new Blob([buffer]), path.basename(relativePath));
  form.append('relativePaths', relativePath);
}

async function main() {
  let managedServer = null;
  try {
    if (process.env.AGENTMA_SMOKE_START_SERVER === '1') {
      managedServer = await startManagedServer();
    }
    await waitForHealth(baseUrl);

    const stamp = Date.now();
    const register = await requireOk('register', fetchJson(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Agent Import Smoke',
        email: `agent-import-${stamp}@gmail.com`,
        password: 'test-password-123',
      }),
    }));
    const token = register.token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    const form = new FormData();
    form.append('mode', 'new');
    form.append('name', `Imported Smoke ${stamp}`);
    appendFile(form, `cc-project/CLAUDE.md`, `root marker ${stamp}`);
    appendFile(form, `cc-project/.claude/agents/reviewer.md`, `---\nname: smoke-reviewer\n---\nreview prompt`);
    appendFile(form, `cc-project/.claude/skills/smoke-skill/SKILL.md`, `---\nname: smoke-skill\n---\nskill prompt`);
    appendFile(form, `cc-project/.claude/settings.json`, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'touch SHOULD_NOT_RUN' }] }] },
    }));
    appendFile(form, `cc-project/.mcp.json`, JSON.stringify({
      mcpServers: {
        remoteSearch: { type: 'http', url: 'https://example.com/mcp' },
        localTool: { command: 'node', args: ['server.js'] },
      },
    }));
    appendFile(form, `cc-project/node_modules/skipped.txt`, 'skip');

    const imported = await requireOk('agent import', fetchJson(`${baseUrl}/api/agents/import`, {
      method: 'POST',
      headers: authHeaders,
      body: form,
    }));

    const template = imported.template;
    const report = imported.report;
    const seedDir = report.seedDir;
    const preview = await requireOk('claude md preview', fetchJson(`${baseUrl}/api/agents/${template.id}/claude-md`, {
      headers: authHeaders,
    }));

    const templates = await requireOk('list agents', fetchJson(`${baseUrl}/api/agents`, { headers: authHeaders }));
    const storedTemplate = templates.find((item) => item.id === template.id);
    const seedFiles = [];
    const collectSeedFiles = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) collectSeedFiles(absolute);
        else seedFiles.push(path.relative(seedDir, absolute));
      }
    };
    if (fs.existsSync(seedDir)) collectSeedFiles(seedDir);

    const badForm = new FormData();
    badForm.append('mode', 'new');
    appendFile(badForm, '../escape.txt', 'bad');
    const bad = await fetchJson(`${baseUrl}/api/agents/import`, {
      method: 'POST',
      headers: authHeaders,
      body: badForm,
    });
    const badGitUrl = await fetchJson(`${baseUrl}/api/agents/import/git`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/repo.git' }),
    });
    const badGitRef = await fetchJson(`${baseUrl}/api/agents/import/git`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/example/repo.git', ref: 'main;rm-rf' }),
    });

    const mcpPath = path.join(seedDir, '.mcp.json');
    const mcpServers = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers : {};
    const preDeleteChecks = {
      templateCreated: Boolean(template.id && storedTemplate?.seedDir),
      popularityDefaulted: storedTemplate?.popularity?.runCount === 0,
      strippedTopDir: fs.existsSync(path.join(seedDir, 'CLAUDE.md')) && !fs.existsSync(path.join(seedDir, 'cc-project')),
      settingsDisabled: fs.existsSync(path.join(seedDir, '.claude', 'settings.json.imported')) && !fs.existsSync(path.join(seedDir, '.claude', 'settings.json')),
      mcpSanitized: Boolean(mcpServers.remoteSearch && !mcpServers.localTool),
      blockedDirSkipped: report.skipped.some((item) => item.path.includes('node_modules')),
      reportDetected: report.detected.claudeMd
        && report.detected.agents.includes('smoke-reviewer')
        && report.detected.skills.includes('smoke-skill')
        && report.detected.remoteMcp.includes('remoteSearch'),
      reportDisabled: report.disabled.hooks.includes('PreToolUse') && report.disabled.stdioMcp.includes('localTool'),
      previewUsesSeed: preview.cwdSource === 'template_seed' && preview.effectiveContent.includes(`root marker ${stamp}`),
      traversalRejected: bad.response.status >= 400,
      gitUrlValidationRejected: badGitUrl.response.status >= 400,
      gitRefValidationRejected: badGitRef.response.status >= 400,
    };

    await requireOk('delete imported agent', fetchJson(`${baseUrl}/api/agents`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    }));

    const checks = {
      ...preDeleteChecks,
      seedDeletedWithTemplate: !fs.existsSync(seedDir),
    };

    console.log(`agent import ${JSON.stringify({
      templateId: template.id,
      seedDir,
      seedFiles,
      mcpServers,
      unpacked: report.unpacked.length,
      disabled: report.disabled,
      skipped: report.skipped,
      checks,
    })}`);

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) throw new Error(`checks failed: ${failed.join(', ')}`);
  } finally {
    await stopManagedServer(managedServer);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
