import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TRANSCRIBE_VENV = '/opt/agentma/transcribe-venv';
const DEFAULT_HF_CACHE = '/opt/agentma/hf-cache';
const DEFAULT_MAX_OUTSTANDING_PER_TENANT = 2;
const TRANSCRIBE_MAX_MEDIA_SECONDS = 60 * 60;
const TRANSCRIBE_MAX_FILE_BYTES = 500 * 1024 * 1024;
const TRANSCRIBE_MAX_RETURN_CHARS = 24_000;
const TRANSCRIBE_MAX_RESULT_FILE_BYTES = 32 * 1024 * 1024;
const PROCESS_OUTPUT_MAX_CHARS = 16_000;
const MEDIA_URL_MAX_LENGTH = 8_192;
const DEFAULT_MEDIA_HOST_SUFFIXES = ['amemv.com', 'douyinvod.com', 'bytecdn.com', 'snssdk.com'];
const WORKER_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'transcribe-worker.py');

type TranscribeSource = { url: string } | { audioPath: string };

export type TranscribeRequest = {
  tenantId: string;
  cwd: string;
  source: TranscribeSource;
  language?: string;
};

export type TranscribeResult =
  | { ok: true; text: string; outputPath: string; durationSec: number }
  | { ok: false; error: string };

type ResolvedSource =
  | { kind: 'url'; value: string; identity: string }
  | { kind: 'file'; value: string; identity: string };

type NormalizedRequest = {
  tenantId: string;
  cwd: string;
  source: ResolvedSource;
  language?: string;
  outputName: string;
};

type WorkerResult = { text: string; outputPath: string };

type TranscribeDependencies = {
  probeMedia?: (source: ResolvedSource, signal: AbortSignal, timeoutMs: number) => Promise<number>;
  runWorker?: (
    request: NormalizedRequest,
    signal: AbortSignal,
    timeoutMs: number,
    durationSec: number,
  ) => Promise<WorkerResult>;
};

export type TranscribeQueueOptions = TranscribeDependencies & {
  timeoutMs?: number;
  maxOutstandingPerTenant?: number;
  allowedUrlHostSuffixes?: string[];
  venvPath?: string;
  hfCachePath?: string;
};

type QueueJob = {
  request: NormalizedRequest;
  resolve: (result: TranscribeResult) => void;
};

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

class TranscribeServiceError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TranscribeServiceError';
    this.code = code;
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeHostSuffix(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return /^[a-z0-9.-]{1,253}$/.test(normalized) && !normalized.includes('..') ? normalized : '';
}

function configuredHostSuffixes(extra: string | undefined) {
  const values = [
    ...DEFAULT_MEDIA_HOST_SUFFIXES,
    ...(extra || '').split(','),
  ].map(normalizeHostSuffix).filter(Boolean);
  return Array.from(new Set(values));
}

function hostMatchesSuffix(hostname: string, suffix: string) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function normalizeLanguage(value: unknown) {
  const language = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!language) return undefined;
  if (!/^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(language) || language.length > 8) {
    throw new TranscribeServiceError('invalid_language');
  }
  return language;
}

function safeOutputName(source: ResolvedSource) {
  const hash = crypto.createHash('sha256').update(source.identity).digest('hex').slice(0, 16);
  if (source.kind === 'url') return `${hash}.txt`;
  const stem = path.basename(source.value, path.extname(source.value))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'audio';
  return `${stem}-${hash}.txt`;
}

function appendTail(current: string, chunk: Buffer | string) {
  const combined = current + String(chunk);
  return combined.length > PROCESS_OUTPUT_MAX_CHARS
    ? combined.slice(combined.length - PROCESS_OUTPUT_MAX_CHARS)
    : combined;
}

function killProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already have exited.
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const finish = (error?: Error, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => {
      killProcessTree(child);
      finish(new TranscribeServiceError('process_aborted'));
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new TranscribeServiceError('process_timeout'));
    }, Math.max(1, options.timeoutMs));
    timer.unref?.();

    child.stdout?.on('data', (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(undefined, {
      exitCode: Number.isInteger(code) ? Number(code) : -1,
      stdout,
      stderr,
    }));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  });
}

function sanitizeDiagnostic(value: string, request: NormalizedRequest, venvPath: string, hfCachePath: string) {
  return value
    .replace(/https?:\/\/\S+/gi, '[media-url]')
    .split(request.cwd).join('[workspace]')
    .split(venvPath).join('[transcribe-venv]')
    .split(hfCachePath).join('[hf-cache]')
    .trim()
    .slice(0, 1_000);
}

function minimalProcessEnv() {
  return {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}

function defaultProbeMedia(source: ResolvedSource, signal: AbortSignal, timeoutMs: number) {
  const ffprobe = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
  return runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    source.value,
  ], {
    env: minimalProcessEnv(),
    timeoutMs: Math.min(timeoutMs, 60_000),
    signal,
  }).then((result) => {
    if (result.exitCode !== 0) {
      throw new TranscribeServiceError(source.kind === 'url'
        ? 'media_probe_failed_or_url_expired'
        : 'media_probe_failed');
    }
    const durationSec = Number(result.stdout.trim());
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new TranscribeServiceError('media_duration_unknown');
    }
    return durationSec;
  });
}

function parseWorkerMarker(stdout: string) {
  const prefix = 'AGENTMA_TRANSCRIBE_RESULT=';
  const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(prefix));
  if (!line) throw new TranscribeServiceError('worker_result_missing');
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as { outputPath?: unknown };
    return typeof parsed.outputPath === 'string' ? parsed.outputPath : '';
  } catch {
    throw new TranscribeServiceError('worker_result_invalid');
  }
}

export class TranscribeQueue {
  private readonly timeoutMs: number;
  private readonly maxOutstandingPerTenant: number;
  private readonly allowedUrlHostSuffixes: string[];
  private readonly venvPath: string;
  private readonly hfCachePath: string;
  private readonly probeMedia: NonNullable<TranscribeDependencies['probeMedia']>;
  private readonly runWorker: NonNullable<TranscribeDependencies['runWorker']>;
  private readonly queue: QueueJob[] = [];
  private readonly outstandingByTenant = new Map<string, number>();
  private active = 0;

  constructor(options: TranscribeQueueOptions = {}) {
    this.timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TRANSCRIBE_TIMEOUT_MS, 1_000, 30 * 60_000);
    this.maxOutstandingPerTenant = clampInteger(
      options.maxOutstandingPerTenant,
      DEFAULT_MAX_OUTSTANDING_PER_TENANT,
      1,
      4,
    );
    this.allowedUrlHostSuffixes = Array.from(new Set(
      (options.allowedUrlHostSuffixes || configuredHostSuffixes(process.env.AGENTMA_TRANSCRIBE_URL_HOSTS))
        .map(normalizeHostSuffix)
        .filter(Boolean),
    ));
    this.venvPath = path.resolve(options.venvPath || process.env.AGENTMA_TRANSCRIBE_VENV || DEFAULT_TRANSCRIBE_VENV);
    this.hfCachePath = path.resolve(options.hfCachePath || process.env.AGENTMA_HF_CACHE || DEFAULT_HF_CACHE);
    this.probeMedia = options.probeMedia || defaultProbeMedia;
    this.runWorker = options.runWorker || this.runProductionWorker.bind(this);
  }

  getDiagnostics() {
    return {
      active: this.active,
      queued: this.queue.length,
      outstandingByTenant: Object.fromEntries(this.outstandingByTenant),
    };
  }

  private resolveSource(request: TranscribeRequest): NormalizedRequest {
    const tenantId = String(request.tenantId || '').trim();
    if (!tenantId) throw new TranscribeServiceError('invalid_tenant');

    let cwd: string;
    try {
      cwd = fs.realpathSync(request.cwd);
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not directory');
    } catch {
      throw new TranscribeServiceError('invalid_workspace');
    }

    let source: ResolvedSource;
    if ('url' in request.source) {
      const rawUrl = String(request.source.url || '').trim();
      if (!rawUrl || rawUrl.length > MEDIA_URL_MAX_LENGTH) throw new TranscribeServiceError('invalid_media_url');
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new TranscribeServiceError('invalid_media_url');
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
        throw new TranscribeServiceError('invalid_media_url');
      }
      const hostname = parsed.hostname.toLowerCase();
      if (!this.allowedUrlHostSuffixes.some((suffix) => hostMatchesSuffix(hostname, suffix))) {
        throw new TranscribeServiceError('media_host_not_allowed');
      }
      parsed.hash = '';
      source = { kind: 'url', value: parsed.toString(), identity: parsed.toString() };
    } else {
      const rawPath = String(request.source.audioPath || '').trim();
      if (!rawPath) throw new TranscribeServiceError('invalid_audio_path');
      const candidate = path.resolve(cwd, rawPath);
      let resolved: string;
      let stat: fs.Stats;
      try {
        resolved = fs.realpathSync(candidate);
        stat = fs.statSync(resolved);
      } catch {
        throw new TranscribeServiceError('audio_file_not_found');
      }
      if (!isPathInside(cwd, resolved)) throw new TranscribeServiceError('audio_path_outside_workspace');
      if (!stat.isFile()) throw new TranscribeServiceError('audio_path_not_file');
      if (stat.size > TRANSCRIBE_MAX_FILE_BYTES) throw new TranscribeServiceError('audio_file_too_large');
      source = { kind: 'file', value: resolved, identity: `${resolved}:${stat.size}:${stat.mtimeMs}` };
    }

    return {
      tenantId,
      cwd,
      source,
      language: normalizeLanguage(request.language),
      outputName: safeOutputName(source),
    };
  }

  private async runProductionWorker(
    request: NormalizedRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<WorkerResult> {
    const python = path.join(this.venvPath, 'bin', 'python');
    try {
      fs.accessSync(python, fs.constants.X_OK);
      fs.accessSync(WORKER_SCRIPT, fs.constants.R_OK);
      fs.accessSync(this.hfCachePath, fs.constants.R_OK);
    } catch {
      throw new TranscribeServiceError('transcribe_runtime_unavailable');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-transcribe-'));
    const resultFile = path.join(tempDir, 'transcript.txt');
    try {
      const args = [
        WORKER_SCRIPT,
        '--source-kind', request.source.kind,
        '--source', request.source.value,
        '--workspace', request.cwd,
        '--output-name', request.outputName,
        '--result-file', resultFile,
        '--model', 'mlx-community/whisper-large-v3-turbo',
      ];
      if (request.language) args.push('--language', request.language);

      const result = await runProcess(python, args, {
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          HF_HOME: this.hfCachePath,
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        timeoutMs,
        signal,
      });
      if (result.exitCode !== 0) {
        const detail = sanitizeDiagnostic(result.stderr || result.stdout, request, this.venvPath, this.hfCachePath);
        throw new TranscribeServiceError(detail ? `worker_failed: ${detail}` : 'worker_failed');
      }
      const outputPath = parseWorkerMarker(result.stdout);
      const expectedOutput = `transcripts/${request.outputName}`;
      if (outputPath !== expectedOutput) throw new TranscribeServiceError('worker_output_path_invalid');
      const resultStat = fs.statSync(resultFile);
      if (!resultStat.isFile() || resultStat.size > TRANSCRIBE_MAX_RESULT_FILE_BYTES) {
        throw new TranscribeServiceError('worker_result_too_large');
      }
      return { text: fs.readFileSync(resultFile, 'utf8'), outputPath };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async executeJob(request: NormalizedRequest): Promise<TranscribeResult> {
    const controller = new AbortController();
    const deadline = Date.now() + this.timeoutMs;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        controller.abort();
        reject(new TranscribeServiceError('transcribe_timeout'));
      }, this.timeoutMs);
    });

    const operation = (async (): Promise<TranscribeResult> => {
      const durationSec = await this.probeMedia(request.source, controller.signal, Math.max(1, deadline - Date.now()));
      if (durationSec > TRANSCRIBE_MAX_MEDIA_SECONDS) return { ok: false, error: 'media_too_long' };
      const worker = await this.runWorker(
        request,
        controller.signal,
        Math.max(1, deadline - Date.now()),
        durationSec,
      );
      const fullText = String(worker.text || '').trim();
      const outputPath = String(worker.outputPath || '').trim();
      if (!outputPath || !/^transcripts\/[A-Za-z0-9._-]+\.txt$/.test(outputPath)) {
        return { ok: false, error: 'worker_output_path_invalid' };
      }
      const text = fullText.length > TRANSCRIBE_MAX_RETURN_CHARS
        ? `${fullText.slice(0, TRANSCRIBE_MAX_RETURN_CHARS)}\n\n[全文见 ${outputPath}]`
        : fullText;
      return { ok: true, text, outputPath, durationSec };
    })();

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      return { ok: false, error: error instanceof TranscribeServiceError ? error.code : 'transcribe_failed' };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private pump() {
    if (this.active >= 1) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active += 1;
    void this.executeJob(job.request).then(job.resolve).finally(() => {
      this.active = Math.max(0, this.active - 1);
      const outstanding = Math.max(0, (this.outstandingByTenant.get(job.request.tenantId) || 1) - 1);
      if (outstanding) this.outstandingByTenant.set(job.request.tenantId, outstanding);
      else this.outstandingByTenant.delete(job.request.tenantId);
      this.pump();
    });
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    let normalized: NormalizedRequest;
    try {
      normalized = this.resolveSource(request);
    } catch (error) {
      return { ok: false, error: error instanceof TranscribeServiceError ? error.code : 'invalid_transcribe_request' };
    }

    const outstanding = this.outstandingByTenant.get(normalized.tenantId) || 0;
    if (outstanding >= this.maxOutstandingPerTenant) {
      return { ok: false, error: 'tenant_queue_full_try_later' };
    }
    this.outstandingByTenant.set(normalized.tenantId, outstanding + 1);
    return new Promise<TranscribeResult>((resolve) => {
      this.queue.push({ request: normalized, resolve });
      this.pump();
    });
  }
}

const transcribeQueue = new TranscribeQueue({
  timeoutMs: clampInteger(process.env.AGENTMA_TRANSCRIBE_TIMEOUT_MS, DEFAULT_TRANSCRIBE_TIMEOUT_MS, 30_000, 30 * 60_000),
});

export function transcribeMedia(request: TranscribeRequest) {
  return transcribeQueue.transcribe(request);
}

export function getTranscribeQueueDiagnostics() {
  return transcribeQueue.getDiagnostics();
}
