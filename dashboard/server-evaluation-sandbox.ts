import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type EvaluationSandboxStatus = {
  available: boolean;
  provider: 'macos-sandbox-exec' | 'unavailable';
  reason: string;
  networkDefault: 'deny';
};

export type EvaluationCommandSuggestion = {
  key: 'install' | 'build' | 'test' | 'lint' | 'typecheck';
  label: string;
  command: string;
  detectedFrom: string;
};

export type EvaluationCommandResult = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
};

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_COMMAND_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function executable(pathname: string) {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function getEvaluationSandboxStatus(): EvaluationSandboxStatus {
  if (process.platform === 'darwin' && executable(SANDBOX_EXEC)) {
    return {
      available: true,
      provider: 'macos-sandbox-exec',
      reason: 'macOS sandbox-exec 可用；评测命令默认禁网并限制写入评测工作区。',
      networkDefault: 'deny',
    };
  }
  return {
    available: false,
    provider: 'unavailable',
    reason: '当前系统没有已配置的安全评测执行器，代码修复评测已禁用。',
    networkDefault: 'deny',
  };
}

function hasScript(packageJson: Record<string, unknown>, script: string) {
  const scripts = packageJson.scripts;
  return Boolean(scripts && typeof scripts === 'object' && !Array.isArray(scripts) && typeof (scripts as Record<string, unknown>)[script] === 'string');
}

function readJson(filePath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function suggestEvaluationCommands(workspace: string): EvaluationCommandSuggestion[] {
  const root = path.resolve(workspace);
  const suggestions: EvaluationCommandSuggestion[] = [];
  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) {
    const packageJson = readJson(packagePath);
    const runner = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
    const installCommand = runner === 'npm' ? 'npm ci --ignore-scripts' : `${runner} install --frozen-lockfile --ignore-scripts`;
    suggestions.push({ key: 'install', label: '安装依赖', command: installCommand, detectedFrom: 'package.json' });
    for (const [key, label] of [['build', '构建'], ['test', '测试'], ['lint', '静态检查'], ['typecheck', '类型检查']] as const) {
      if (hasScript(packageJson, key)) suggestions.push({ key, label, command: `${runner} run ${key}`, detectedFrom: `package.json#scripts.${key}` });
    }
  }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'))) {
    if (fs.existsSync(path.join(root, 'requirements.txt'))) {
      suggestions.push({ key: 'install', label: '安装依赖', command: 'python3 -m pip install -r requirements.txt', detectedFrom: 'requirements.txt' });
    }
    suggestions.push({ key: 'test', label: '测试', command: 'python3 -m pytest -q', detectedFrom: 'pyproject.toml/pytest.ini' });
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    suggestions.push({ key: 'build', label: '构建', command: 'go build ./...', detectedFrom: 'go.mod' });
    suggestions.push({ key: 'test', label: '测试', command: 'go test ./...', detectedFrom: 'go.mod' });
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    suggestions.push({ key: 'build', label: '构建', command: 'cargo build --locked', detectedFrom: 'Cargo.toml' });
    suggestions.push({ key: 'test', label: '测试', command: 'cargo test --locked', detectedFrom: 'Cargo.toml' });
  }
  const seen = new Set<string>();
  return suggestions.filter(suggestion => {
    const key = `${suggestion.key}:${suggestion.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quoteSandboxLiteral(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sandboxProfile(workspace: string, tempDir: string, allowNetwork: boolean) {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* (subpath "${quoteSandboxLiteral(workspace)}"))`,
    `(allow file-write* (subpath "${quoteSandboxLiteral(tempDir)}"))`,
    '(allow file-write* (literal "/dev/null"))',
    allowNetwork ? '(allow network*)' : '(deny network*)',
  ].join('\n');
}

function safeWorkspace(workspace: string) {
  const resolved = fs.realpathSync.native(path.resolve(workspace));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('评测工作区不是目录');
  if (resolved === '/' || resolved === os.homedir() || resolved === path.parse(resolved).root) {
    throw new Error('拒绝使用过宽的评测工作区');
  }
  return resolved;
}

function safeCommand(command: string) {
  const normalized = String(command || '').trim();
  if (!normalized) throw new Error('评测命令不能为空');
  if (normalized.length > MAX_COMMAND_LENGTH) throw new Error(`评测命令不能超过 ${MAX_COMMAND_LENGTH} 个字符`);
  if (normalized.includes('\0') || normalized.includes('\n') || normalized.includes('\r')) throw new Error('评测命令必须是单行命令');
  return normalized;
}

export async function runEvaluationCommand(input: {
  workspace: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowNetwork?: boolean;
  env?: Record<string, string>;
}): Promise<EvaluationCommandResult> {
  const status = getEvaluationSandboxStatus();
  if (!status.available) throw Object.assign(new Error(status.reason), { code: 'sandbox_unavailable' });
  const workspace = safeWorkspace(input.workspace);
  const command = safeCommand(input.command);
  const timeoutMs = Math.max(1000, Math.min(60 * 60 * 1000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxOutputBytes = Math.max(1024, Math.min(20 * 1024 * 1024, Number(input.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-eval-sandbox-'));
  const profile = sandboxProfile(workspace, tempDir, input.allowNetwork === true);
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    TZ: process.env.TZ || 'UTC',
    HOME: tempDir,
    TMPDIR: tempDir,
    CI: '1',
    ...input.env,
  };
  const startedAt = Date.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;
  try {
    const child = spawn(SANDBOX_EXEC, ['-p', profile, '/bin/zsh', '-lc', command], {
      cwd: workspace,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (current: Buffer, chunk: Buffer) => {
      const remaining = maxOutputBytes - current.length;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, Buffer.from(chunk)); });
    child.stderr.on('data', chunk => { stderr = append(stderr, Buffer.from(chunk)); });
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, timeoutMs);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal });
      });
    });
    return {
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      durationMs: Date.now() - startedAt,
      timedOut,
      truncated,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
