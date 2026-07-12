import { spawnSync } from 'node:child_process';
import path from 'node:path';

const suites = [
  'smoke:a2a-sdk',
  'smoke:a2a-credentials',
  'smoke:a2a-store',
  'smoke:a2a-template-config',
  'smoke:a2a-protocol',
  'smoke:a2a-execution',
  'smoke:a2a-input-required',
  'smoke:outbound-url-guard',
  'smoke:a2a-bidirectional',
];

const cwd = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const failures = [];

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(npm, ['run', suite], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    failures.push({ suite, status: result.status, error: result.error?.message });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, suites }));
}
