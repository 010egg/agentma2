import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let baseUrl = '';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function startManagedServer() {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-quota-smoke-'));
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
    if (process.platform !== 'win32' && managed.child.pid) {
      try { process.kill(-managed.child.pid, 'SIGINT'); } catch {}
    } else {
      managed.child.kill('SIGINT');
    }
    await waitForChildExit(managed.child, 2500);
  }
  if (!childExited(managed.child)) {
    if (process.platform !== 'win32' && managed.child.pid) {
      try { process.kill(-managed.child.pid, 'SIGKILL'); } catch {}
    } else {
      managed.child.kill('SIGKILL');
    }
    await waitForChildExit(managed.child, 1500);
  }
  fs.rmSync(managed.dataDir, { recursive: true, force: true });
}

async function register(name, email) {
  const result = await fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'password123' }),
  });
  if (!result.response.ok) {
    throw new Error(`register ${email} failed ${result.response.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function main() {
  let managed = null;
  try {
    managed = await startManagedServer();
    const stamp = Date.now();
    const admin = await register('admin', 'admin@agentma.com');
    const member = await register('Member Smoke', `quota-member-${stamp}@example.test`);

    const users = await fetchJson(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    if (!users.response.ok) throw new Error(`list users failed ${users.response.status}: ${JSON.stringify(users.body)}`);
    const memberRow = users.body.find((user) => user.email === member.email);

    const checks = {
      memberJoinedAdminTenant: member.tenantId === admin.tenantId,
      memberRole: member.role === 'member',
      memberFreePlan: member.planTier === 'free',
      adminSeesMember: Boolean(memberRow),
      memberDailyDefault: memberRow?.quota?.effective?.dailyConversationLimit === 5,
    };

    const patch = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(member.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planTier: 'free',
        dailyConversationLimit: 0,
        fiveHourTokenLimit: null,
        weeklyTokenLimit: null,
      }),
    });
    if (!patch.response.ok) throw new Error(`patch quota failed ${patch.response.status}: ${JSON.stringify(patch.body)}`);
    checks.dailyLimitPatched = patch.body?.quota?.effective?.dailyConversationLimit === 0;

    const denied = await fetchJson(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'This should be blocked before model execution.',
        provider: {
          ANTHROPIC_AUTH_TOKEN: 'fake-key',
          ANTHROPIC_MODEL: 'fake-model',
        },
      }),
    });
    checks.quotaDenied = denied.response.status === 429 && denied.body?.error === 'quota_exceeded';
    checks.quotaWindow = denied.body?.quota?.window === 'daily';

    // 管理员即使被设成 0 上限也不受配额限制
    const adminPatch = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(admin.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyConversationLimit: 0,
        fiveHourTokenLimit: 0,
        weeklyTokenLimit: 0,
      }),
    });
    if (!adminPatch.response.ok) throw new Error(`patch admin quota failed ${adminPatch.response.status}: ${JSON.stringify(adminPatch.body)}`);
    // 配额检查发生在流式响应之前；admin 若被放行会返回 200 SSE 而非 429，
    // 读到响应头即可判断，随后中断连接避免等待整个流。
    const adminAbort = new AbortController();
    let adminChatStatus = 0;
    try {
      const adminChatRes = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Admin should never be blocked by quota.',
          provider: { ANTHROPIC_AUTH_TOKEN: 'fake-key', ANTHROPIC_MODEL: 'fake-model' },
        }),
        signal: adminAbort.signal,
      });
      adminChatStatus = adminChatRes.status;
    } finally {
      adminAbort.abort();
    }
    checks.adminBypassesQuota = adminChatStatus !== 429;

    // 管理员不能修改自己的角色（防止唯一管理员把自己降级锁死）
    const selfRole = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(admin.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    checks.adminCannotDemoteSelf = selfRole.response.status === 400;
    const adminStillAdmin = await fetchJson(`${baseUrl}/api/users`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    checks.adminRoleUnchanged = adminStillAdmin.body.find((user) => user.email === admin.email)?.role === 'tenant_admin';

    const plus = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(member.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planTier: 'plus',
        dailyConversationLimit: null,
        fiveHourTokenLimit: null,
        weeklyTokenLimit: null,
      }),
    });
    if (!plus.response.ok) throw new Error(`patch plus failed ${plus.response.status}: ${JSON.stringify(plus.body)}`);
    checks.plusDefaultFiveHour = plus.body?.quota?.effective?.fiveHourTokenLimit === 1_000_000;
    checks.plusDefaultWeekly = plus.body?.quota?.effective?.weeklyTokenLimit === 5_000_000;

    const pro = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(member.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier: 'pro' }),
    });
    if (!pro.response.ok) throw new Error(`patch pro failed ${pro.response.status}: ${JSON.stringify(pro.body)}`);
    checks.proFiveX = pro.body?.quota?.effective?.fiveHourTokenLimit === 5_000_000
      && pro.body?.quota?.effective?.weeklyTokenLimit === 25_000_000;

    const max = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(member.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier: 'max' }),
    });
    if (!max.response.ok) throw new Error(`patch max failed ${max.response.status}: ${JSON.stringify(max.body)}`);
    checks.maxTwentyX = max.body?.quota?.effective?.fiveHourTokenLimit === 20_000_000
      && max.body?.quota?.effective?.weeklyTokenLimit === 100_000_000;

    const tokenLimited = await fetchJson(`${baseUrl}/api/users/${encodeURIComponent(member.email)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planTier: 'plus',
        dailyConversationLimit: null,
        fiveHourTokenLimit: 0,
        weeklyTokenLimit: null,
      }),
    });
    if (!tokenLimited.response.ok) throw new Error(`patch token limit failed ${tokenLimited.response.status}: ${JSON.stringify(tokenLimited.body)}`);
    const tokenDenied = await fetchJson(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'This should be blocked by the paid token window before model execution.',
        provider: {
          ANTHROPIC_AUTH_TOKEN: 'fake-key',
          ANTHROPIC_MODEL: 'fake-model',
        },
      }),
    });
    checks.tokenQuotaDenied = tokenDenied.response.status === 429 && tokenDenied.body?.error === 'quota_exceeded';
    checks.tokenQuotaWindow = tokenDenied.body?.quota?.window === 'five_hour';

    console.log(`checks ${JSON.stringify(checks)}`);
    const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
    if (failed.length) throw new Error(`user plan quota smoke failed: ${failed.join(', ')}`);
    console.log('user plan quota smoke passed');
  } finally {
    await stopManagedServer(managed);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
