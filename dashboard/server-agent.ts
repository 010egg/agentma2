import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  query,
  tool,
  createSdkMcpServer,
  type AgentDefinition,
  type CanUseTool,
  type EffortLevel,
  type HookCallbackMatcher,
  type HookEvent,
  type PermissionResult,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { evaluateHookRules, evaluatePermissionRules, listDatasources, listHookRules, listKnowledgeSources, listProtectedSdkCwds, recordAgentRun } from './server-store.ts';
import type { DatasourceRow, HookRuleEvent } from './server-store.ts';
import { DATASOURCE_QUERY_MAX_ROWS } from './server-datasource.ts';
import { buildDatasourceMcp, buildImageInspectMcp, buildModelRequestMcp, listInternalTools } from './server-internal-tools.ts';
import { mapResultSubtypeToOutcome, type RunOutcome } from './src/simulator/run-state.ts';

// ─── Pricing ─────────────────────────────────────────────────────────────────
// Edit to match your provider's actual rates. The SDK's own total_cost_usd
// assumes Claude pricing and is wrong for deepseek/minimax.
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  'deepseek-chat':     { in: 0.27, out: 1.10 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  // OpenAI（经 Anthropic→OpenAI 翻译网关接入）。
  // ⚠️ 下列单价为占位，上线前必须用 OpenAI 官方定价（USD / 百万 token）替换，否则计费失真。
  'gpt-5.5':           { in: 0, out: 0 },
};
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number) {
  const p = MODEL_PRICES[model];
  if (!p) return 0;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

// ─── Safe-allow tool list (read-only, no side effects) ──────────────────────
// These run without prompting the user. Everything else falls through to
// requestPermission.
export const SAFE_AUTO_ALLOW_TOOLS = new Set<string>([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'ToolSearch', 'tool_search',
  'TodoWrite', 'TodoRead', 'TaskGet', 'TaskList', 'TaskOutput',
  'ListMcpResources', 'ReadMcpResource',
  // 数据源工具只读(readOnly 连接 + 单条 SELECT/WITH 校验),在 MCP 层自我兜底,放心自动放行。
  'list_datasources', 'query_datasource',
  // 平台内置模型请求工具只走 tenant 已配置 provider profile，不接受调用方传 key/baseUrl。
  'mcp__model__request',
  'mcp__image__inspect',
]);

const TOOL_SEARCH_TOOL_NAME = 'ToolSearch';

function isFirstPartyAnthropicBaseUrl(baseUrl: string | undefined) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return true;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

function resolveToolSearchEnvValue() {
  return String(process.env.ENABLE_TOOL_SEARCH || '').trim() || 'true';
}

function visualSkillWriteTarget(toolName: string, input: unknown, skills: string[] | undefined, cwd: string) {
  if (toolName !== 'Write') return '';
  if (!skills?.includes('agentma-visual')) return '';
  const filePath = (input as Record<string, unknown> | null | undefined)?.file_path;
  if (typeof filePath !== 'string') return '';
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^viz\/[A-Za-z0-9._-]+\.(html|md|markdown)$/i.test(normalized)) return normalized;

  const resolved = path.resolve(cwd, filePath);
  let resolvedCwd = path.resolve(cwd);
  try {
    resolvedCwd = fs.realpathSync.native(cwd);
  } catch {}
  const vizRoot = path.resolve(resolvedCwd, 'viz');
  let resolvedDir = path.dirname(resolved);
  try {
    resolvedDir = fs.realpathSync.native(resolvedDir);
  } catch {
    resolvedDir = path.resolve(resolvedDir);
  }
  const basename = path.basename(resolved);
  if (
    resolvedDir === vizRoot
    && /^[A-Za-z0-9._-]+\.(html|md|markdown)$/i.test(basename)
  ) {
    return `viz/${basename}`;
  }
  return '';
}

// File-mutating tools mapped to the input field that carries their target path.
// Used to enforce that knowledge-source directories stay read-only.
export const WRITE_TOOL_PATH_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

// A knowledge source is writable for a given run only when the run's initiator is
// the source creator AND the creator turned read_only off. Non-creators (and any
// source still marked read_only) stay locked. Pure + exported for unit testing.
export function isKnowledgeSourceWritable(
  source: { createdBy?: string | null; readOnly?: boolean },
  runnerSub: string | null | undefined,
): boolean {
  const isCreator = Boolean(runnerSub && source.createdBy && runnerSub === source.createdBy);
  return isCreator && source.readOnly === false;
}

// Decide whether a tool call must be denied because it writes into a read-only
// knowledge directory. Pure + exported so it can be unit-tested without a model.
// Returns the offending target path when blocked, otherwise null.
export function knowledgeWriteBlock(
  toolName: string,
  input: unknown,
  cwd: string,
  readOnlyDirs: string[],
): string | null {
  if (!readOnlyDirs.length) return null;
  const pathField = WRITE_TOOL_PATH_FIELDS[toolName];
  if (!pathField) return null;
  const target = (input as Record<string, unknown> | null | undefined)?.[pathField];
  if (typeof target !== 'string' || !target.trim()) return null;
  const resolved = path.resolve(cwd, target);
  const blocked = readOnlyDirs
    .map((dir) => path.resolve(dir))
    .some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  return blocked ? target : null;
}

function isPathInsideAny(filePath: string, roots: string[]) {
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

function readShellPathAt(text: string, start: number) {
  let value = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      i += 1;
      continue;
    }
    if (/[\s"'`|;&<>(){}[\]]/.test(ch)) break;
    value += ch;
  }
  return value;
}

function extractHostPathCandidates(text: string) {
  const roots = [os.homedir(), path.join(os.homedir(), 'Library', 'Application Support', 'agentma2')];
  const candidates = new Set<string>();
  for (const root of roots) {
    const probes = [root, root.replace(/ /g, '\\ ')];
    for (const probe of probes) {
      let index = text.indexOf(probe);
      while (index >= 0) {
        const candidate = readShellPathAt(text, index);
        if (candidate) candidates.add(candidate);
        index = text.indexOf(probe, index + probe.length);
      }
    }
  }
  return Array.from(candidates);
}

function collectInputStrings(input: unknown, depth = 0): string[] {
  if (depth > 3 || input == null) return [];
  if (typeof input === 'string') return [input];
  if (typeof input !== 'object') return [];
  if (Array.isArray(input)) return input.flatMap((item) => collectInputStrings(item, depth + 1));
  return Object.values(input as Record<string, unknown>).flatMap((value) => collectInputStrings(value, depth + 1));
}

function hostPathToolBlock(toolName: string, input: unknown, cwd: string, additionalDirectories: string[]) {
  const guardedTools = new Set(['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  if (!guardedTools.has(toolName)) return null;

  const texts = collectInputStrings(input);
  const hostHomeSkillRe = /(^|[\s"'`])~\/(?:\.claude|\.ssh|Library\/Application(?:\\ | )Support\/agentma2)(?:\/|$)/;
  if (texts.some((text) => hostHomeSkillRe.test(text))) {
    return '宿主 HOME/skills 路径不可在 agent run 内访问；创建技能请使用 ./.claude/skills/<name>/SKILL.md';
  }

  const allowedRoots = [cwd, ...additionalDirectories].map((dir) => path.resolve(dir));
  for (const text of texts) {
    for (const candidate of extractHostPathCandidates(text)) {
      if (!isPathInsideAny(candidate, allowedRoots)) {
        return `宿主路径不在本次 workspace allowlist 内：${candidate}`;
      }
    }
  }
  return null;
}

// ─── Custom HTTP-endpoint tools → SDK MCP wrapper ───────────────────────────
// Schemas come from the request body's `tools` array; endpoints come from
// /tmp/agentma_custom_tools.json.
export function buildCustomToolsMcp(requestTools: unknown[]) {
  if (!Array.isArray(requestTools) || !requestTools.length) return null;
  let endpoints: any[] = [];
  try { endpoints = JSON.parse(fs.readFileSync('/tmp/agentma_custom_tools.json', 'utf-8')); } catch {}
  const byName: Record<string, any> = {};
  for (const e of endpoints) if (e?.endpoint && e.name) byName[e.name] = e;

  const sdkTools: any[] = [];
  for (const t of requestTools as any[]) {
    if (!t?.name || !byName[t.name]) continue;
    const ct = byName[t.name];
    const schema: Record<string, any> = {};
    for (const [k, v] of Object.entries(t.input_schema || {})) {
      let tn = String(v); const opt = tn.endsWith('?'); if (opt) tn = tn.slice(0, -1);
      let zt: any = tn === 'number' ? z.number() : tn === 'boolean' ? z.boolean() : z.string();
      if (opt) zt = zt.optional();
      schema[k] = zt;
    }
    sdkTools.push(tool(t.name, t.description || `Custom tool: ${t.name}`, schema, async (args: any) => {
      let url = ct.endpoint.url;
      let body = ct.endpoint.bodyTemplate || '{}';
      for (const [k, v] of Object.entries(args || {})) {
        url = url.replace(`{{${k}}}`, encodeURIComponent(String(v)));
        body = body.replace(`{{${k}}}`, String(v));
      }
      try {
        const r = await fetch(url, {
          method: ct.endpoint.method,
          headers: { 'Content-Type': 'application/json', ...(ct.endpoint.headers || {}) },
          body: ct.endpoint.method !== 'GET' ? body : undefined,
        });
        return { content: [{ type: 'text', text: (await r.text()).slice(0, 4000) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `err: ${(e as Error).message}` }], isError: true };
      }
    }));
  }
  if (!sdkTools.length) return null;
  return createSdkMcpServer({ name: 'custom', version: '1.0.0', tools: sdkTools });
}

// ─── Permission request system ──────────────────────────────────────────────
// runAgent calls into `RequestPermissionFn`; the HTTP layer registers a
// requester that emits SSE events and waits for the frontend to POST a
// decision back to /api/agents/permissions/:reqId.

export type PermissionDecision = {
  decision: 'allow' | 'deny';
  reason?: string;
  updatedInput?: Record<string, unknown>;
  rememberForSession?: boolean;  // remember within THIS run
};

export type AskUserQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
};

export type AskUserQuestionAnswer = {
  answers: Record<string, string>;
  reason?: string;
};

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  signal?: AbortSignal;
};

export type RequestPermissionFn = (req: PermissionRequest) => Promise<PermissionDecision>;
export type RequestUserQuestionFn = (req: {
  questions: AskUserQuestionItem[];
  toolUseID: string;
  signal?: AbortSignal;
}) => Promise<AskUserQuestionAnswer>;

type Pending = {
  resolve: (decision: PermissionDecision) => void;
  tenantId: string;
  toolName: string;
  createdAt: number;
  timer: NodeJS.Timeout;
};

type PendingUserQuestion = {
  resolve: (answer: AskUserQuestionAnswer) => void;
  tenantId: string;
  createdAt: number;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();
const pendingUserQuestions = new Map<string, PendingUserQuestion>();
const PROMPT_TIMEOUT_MS = 120 * 1000;  // 2 min for user decision; auto-deny on timeout

export function resolvePermissionRequest(reqId: string, tenantId: string, decision: PermissionDecision) {
  const p = pending.get(reqId);
  if (!p) return { ok: false, reason: 'unknown reqId' };
  if (p.tenantId !== tenantId) return { ok: false, reason: 'tenant mismatch' };
  clearTimeout(p.timer);
  pending.delete(reqId);
  p.resolve(decision);
  return { ok: true };
}

export function resolveAskUserQuestion(reqId: string, tenantId: string, answer: AskUserQuestionAnswer) {
  const p = pendingUserQuestions.get(reqId);
  if (!p) return { ok: false, reason: 'unknown reqId' };
  if (p.tenantId !== tenantId) return { ok: false, reason: 'tenant mismatch' };
  clearTimeout(p.timer);
  pendingUserQuestions.delete(reqId);
  p.resolve(answer);
  return { ok: true };
}

export function createPermissionRequester(opts: {
  emit: (event: any) => void;
  sessionAllow: Set<string>;
  tenantId: string;
}): RequestPermissionFn {
  return async (req) => {
    if (opts.sessionAllow.has(req.toolName)) {
      opts.emit({ type: 'permission_resolved', toolName: req.toolName, decision: 'allow', reason: 'session-allow' });
      return { decision: 'allow' };
    }
    const reqId = crypto.randomUUID();
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          opts.emit({ type: 'permission_resolved', reqId, toolName: req.toolName, decision: 'deny', reason: 'timeout' });
          resolve({ decision: 'deny', reason: `no decision in ${PROMPT_TIMEOUT_MS / 1000}s` });
        }
      }, PROMPT_TIMEOUT_MS);
      pending.set(reqId, { resolve, tenantId: opts.tenantId, toolName: req.toolName, createdAt: Date.now(), timer });
      opts.emit({
        type: 'permission_request',
        reqId,
        toolName: req.toolName,
        input: req.input,
        title: req.title,
        displayName: req.displayName,
        description: req.description,
        toolUseID: req.toolUseID,
      });
    }).then((decision) => {
      if (decision.decision === 'allow' && decision.rememberForSession) {
        opts.sessionAllow.add(req.toolName);
      }
      opts.emit({ type: 'permission_resolved', reqId, toolName: req.toolName, decision: decision.decision, reason: decision.reason });
      return decision;
    });
  };
}

export function createAskUserQuestionRequester(opts: {
  emit: (event: any) => void;
  tenantId: string;
}): RequestUserQuestionFn {
  return async (req) => {
    const reqId = crypto.randomUUID();
    return new Promise<AskUserQuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingUserQuestions.has(reqId)) {
          pendingUserQuestions.delete(reqId);
          const answers = buildFallbackAnswers(req.questions);
          resolve({ answers, reason: 'timeout' });
        }
      }, PROMPT_TIMEOUT_MS);
      pendingUserQuestions.set(reqId, { resolve, tenantId: opts.tenantId, createdAt: Date.now(), timer });
      opts.emit({
        type: 'ask_user_question',
        reqId,
        questions: req.questions,
        toolUseID: req.toolUseID,
      });
    }).then((answer) => {
      opts.emit({ type: 'ask_user_question_resolved', reqId, answers: answer.answers, reason: answer.reason });
      return answer;
    });
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'system'; subtype: 'init'; model: string; tools: number; cwd: string; sdkSessionId?: string }
  | { type: 'delta'; text: string; thinking?: boolean }
  | { type: 'permission_request'; reqId: string; toolName: string; input: unknown; title?: string; displayName?: string; description?: string; toolUseID: string }
  | { type: 'permission_resolved'; reqId?: string; toolName: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'ask_user_question'; reqId: string; questions: AskUserQuestionItem[]; toolUseID: string }
  | { type: 'ask_user_question_resolved'; reqId: string; answers?: Record<string, string>; reason?: string }
  | { type: 'hook_response'; eventName: HookRuleEvent; action: string; reason: string; input: unknown; output: unknown; toolUseID?: string }
  | { type: 'task_started'; taskId: string; toolUseId?: string; description: string; subagentType?: string; taskType?: string; prompt?: string; sdkSessionId?: string }
  | { type: 'task_progress'; taskId: string; toolUseId?: string; description: string; subagentType?: string; lastToolName?: string; summary?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }; sdkSessionId?: string }
  | { type: 'task_updated'; taskId: string; status?: string; description?: string; error?: string; backgrounded?: boolean; sdkSessionId?: string }
  | { type: 'task_notification'; taskId: string; toolUseId?: string; status: string; summary?: string; outputFile?: string; usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }; sdkSessionId?: string }
  | { type: 'context_compaction'; subtype: 'compact_boundary'; message: string; sdkSessionId?: string; timestamp: number }
  | { type: 'run_log'; level: 'info' | 'warn'; scope: 'skill' | 'tool_search'; message: string }
  | { type: 'run_outcome'; outcome: RunOutcome; subtype?: string; message?: string }
  | { type: 'result'; subtype: string; text: string; usage: { input_tokens: number; output_tokens: number }; duration_ms: number; cost_usd: number; model: string; sdkSessionId?: string; sdkCwd?: string; structuredOutput?: unknown }
  | { type: 'error'; message: string };

export interface RunAgentOptions {
  prompt: string;
  promptImages?: Array<{
    id?: string;
    name?: string;
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
    size?: number;
  }>;
  visualPreprocess?: {
    enabled: boolean;
    model: string;
    baseUrl?: string;
    apiKey: string;
  };
  imageInspectModel?: string;
  systemPrompt?: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  /** Template-allowed tool names (bare names like 'Read', 'Bash', 'mineflayer-chat'). Empty/undef = no template restriction. */
  tools?: string[];
  /** Raw tool definitions from the request body (for custom-tools schema). */
  requestTools?: any[];
  /** Programmatic SDK subagents exposed through the Agent tool. */
  subagents?: Record<string, AgentDefinition>;
  /** Structured output JSON Schema — when set, SDK returns structured_output alongside text. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Snapshot files before edits so /rewind can restore them. */
  enableFileCheckpointing?: boolean;
  /** SDK skills to expose to the main session. */
  skills?: string[];
  /** MCP server names expected to be loaded natively from project .mcp.json. */
  mcpServers?: string[];
  /** Allow the agent to read tenant-configured knowledge source directories. */
  useKnowledge?: boolean;
  knowledgeSourceIds?: string[];
  /** Tenant datasource ids exposed via the read-only datasource MCP tools. */
  datasourceIds?: string[];
  maxTurns?: number;
  /** Reasoning effort for the MAIN session. Subagent effort is carried separately via AgentDefinition. */
  effort?: EffortLevel;
  abortController?: AbortController;
  cwd?: string;
  /** Persistent template seed copied into a fresh run cwd before SDK query starts. */
  seedDir?: string;
  resumeSdkSessionId?: string;
  tenantId: string;
  sub: string;
  role?: string | null;
  emit: (e: AgentEvent) => void;
  requestPermission: RequestPermissionFn;
  requestUserQuestion: RequestUserQuestionFn;
}

const RUN_CWD_PREFIX = 'agentma-run-';
const RUN_CWD_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_CWD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const AGENT_SEED_MARKER = '.agentma-seeded';
const BLOCKED_AGENT_SEED_COPY_ENTRIES = new Set(['.git', 'node_modules', '.agent-home', AGENT_SEED_MARKER]);
const USER_SKILLS_DIR = path.resolve(process.env.AGENTMA_USER_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills'));
const SAFE_SKILL_NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// P1: 给租户 run 的 env 白名单，绝不把宿主全部 process.env 拷进 agent run。
// 需要额外变量时用 AGENTMA_RUN_ENV_ALLOWLIST 逗号分隔追加，先在 dev 验证不破坏 SDK/MCP。
const RUN_ENV_DEFAULT_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'SHELL'];
const RUN_ENV_ALLOWLIST = [
  ...RUN_ENV_DEFAULT_ALLOWLIST,
  ...(process.env.AGENTMA_RUN_ENV_ALLOWLIST
    ? process.env.AGENTMA_RUN_ENV_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
    : []),
];
// P2: 显式收敛 settingSources。绝不含 'user'，避免 SDK 去加载宿主 ~/.claude（即便
// HOME 已被隔离到 cwd/.agent-home，也按设计在 SDK 层显式排除，不靠隐式默认）。
// 含 'project'/'local' 让租户 workspace 的 CLAUDE.md / .claude/settings(.local).json 原生加载。
const RUN_SETTING_SOURCES: ('user' | 'project' | 'local')[] = ['project', 'local'];
const SANDBOX_ENABLED = process.env.AGENTMA_SANDBOX_ENABLED !== '0';
const SANDBOX_FAIL_IF_UNAVAILABLE = process.env.AGENTMA_SANDBOX_FAIL_IF_UNAVAILABLE !== '0';
// 网络收紧默认 OFF: allowManagedDomainsOnly 会影响 WebFetch/远程 MCP/npx，先单独验证再开。
const SANDBOX_NETWORK_MANAGED_ONLY = process.env.AGENTMA_SANDBOX_NETWORK_MANAGED_ONLY === '1';
let lastRunCwdCleanupMs = 0;

function realpathIfPossible(filePath: string) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function getRunCwdParents() {
  const parents = new Set<string>();
  for (const root of [os.tmpdir(), '/tmp', '/private/tmp']) {
    try {
      parents.add(fs.realpathSync.native(root));
    } catch {}
  }
  return parents;
}

function cleanupExpiredRunCwds(excludeCwd: string) {
  const ttlMs = Number(process.env.AGENTMA_RUN_CWD_TTL_MS || RUN_CWD_DEFAULT_TTL_MS);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;

  const now = Date.now();
  if (now - lastRunCwdCleanupMs < RUN_CWD_CLEANUP_INTERVAL_MS) return;
  lastRunCwdCleanupMs = now;

  const parents = getRunCwdParents();
  const excluded = realpathIfPossible(excludeCwd);
  const protectedCwds = new Set(listProtectedSdkCwds().map(realpathIfPossible));
  for (const parent of parents) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(RUN_CWD_PREFIX)) continue;
      const candidate = path.join(parent, entry.name);
      try {
        const resolved = fs.realpathSync.native(candidate);
        if (resolved === excluded || !parents.has(path.dirname(resolved))) continue;
        if (protectedCwds.has(resolved)) continue;
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory() || now - stat.mtimeMs < ttlMs) continue;
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch {}
    }
  }
}

function copyAgentSeedSafe(sourceDir: string, destDir: string) {
  const sourceRoot = path.resolve(sourceDir);
  const destRoot = path.resolve(destDir);

  const copyRecursive = (currentSource: string, currentDest: string) => {
    fs.mkdirSync(currentDest, { recursive: true });
    const entries = fs.readdirSync(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(currentSource, entry.name);
      const destPath = path.join(currentDest, entry.name);
      const relativePath = path.relative(sourceRoot, sourcePath) || entry.name;
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw new Error(`Agent seed cannot contain symlinks: ${relativePath}`);
      if (BLOCKED_AGENT_SEED_COPY_ENTRIES.has(entry.name)) throw new Error(`Agent seed cannot contain blocked entry: ${relativePath}`);

      const resolvedDest = path.resolve(destPath);
      if (resolvedDest !== destRoot && !resolvedDest.startsWith(destRoot + path.sep)) {
        throw new Error(`Agent seed copy escaped run cwd: ${relativePath}`);
      }

      if (stat.isDirectory()) {
        copyRecursive(sourcePath, destPath);
      } else if (stat.isFile()) {
        if (!fs.existsSync(destPath)) fs.copyFileSync(sourcePath, destPath);
      } else {
        throw new Error(`Agent seed contains unsupported file type: ${relativePath}`);
      }
    }
  };

  copyRecursive(sourceRoot, destRoot);
}

// Skill 投放,一句话: run 启动时把选中的 skill 从宿主技能库复制进 workspace 的
// .claude/skills(settingSources 不含 'user',SDK 只认这里),宿主有的以宿主为准,
// 只在 workspace 里有的沿用 workspace 的,失败的发 run_log 警告。
// 安全边界两条: skill 目录本身按 realpath 解析(宿主管理员放的软链接可信,如 cc-switch);
// 目录内部的软链接一律丢弃(防止 skill 内容把 ~/.ssh 等宿主文件带进沙箱)。
interface SkillProvisionResult {
  provisioned: string[];
  issues: Array<{ skill: string; reason: string }>;
}

function copySkillTree(sourceDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) copySkillTree(sourcePath, path.join(destDir, entry.name));
    else if (stat.isFile()) fs.copyFileSync(sourcePath, path.join(destDir, entry.name));
  }
}

export function provisionRunSkills(skills: string[] | undefined, cwd: string): SkillProvisionResult {
  const result: SkillProvisionResult = { provisioned: [], issues: [] };
  if (!skills?.length) return result;

  const targetRoot = path.resolve(cwd, '.claude', 'skills');
  for (const rawSkill of skills) {
    const skill = rawSkill.trim();
    if (!skill) continue;
    // 名称校验 + 包含性检查: 正则允许 '.',所以 '..' 之类仍可能拼出越界路径。
    const destDir = path.resolve(targetRoot, skill);
    if (!SAFE_SKILL_NAME_RE.test(skill) || !destDir.startsWith(targetRoot + path.sep)) {
      result.issues.push({ skill, reason: '名称非法' });
      continue;
    }

    let sourceDir = '';
    try {
      sourceDir = fs.realpathSync(path.join(USER_SKILLS_DIR, skill));
    } catch { /* 宿主库没有 */ }

    if (!sourceDir) {
      if (fs.existsSync(path.join(destDir, 'SKILL.md'))) result.provisioned.push(skill);
      else result.issues.push({ skill, reason: '宿主技能库中不存在' });
      continue;
    }
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
      result.issues.push({ skill, reason: '不是有效 skill 目录(缺 SKILL.md)' });
      continue;
    }

    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      copySkillTree(sourceDir, destDir);
      result.provisioned.push(skill);
    } catch (error) {
      fs.rmSync(destDir, { recursive: true, force: true });
      result.issues.push({ skill, reason: (error as Error).message });
    }
  }
  return result;
}

const SUPPORTED_HOOK_EVENTS: HookRuleEvent[] = ['PreToolUse', 'PostToolUse', 'Notification'];

function asHookInputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function buildTenantHooks(
  tenantId: string,
  emit: (e: AgentEvent) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  const activeRules = listHookRules(tenantId).filter((rule) => rule.enabled);
  if (!activeRules.length) return undefined;

  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const eventName of SUPPORTED_HOOK_EVENTS) {
    if (!activeRules.some((rule) => rule.eventName === eventName)) continue;
    hooks[eventName] = [{
      hooks: [async (input, toolUseID) => {
        const inputRecord = asHookInputRecord(input);
        const decision = evaluateHookRules(tenantId, eventName, inputRecord);
        if (!decision) return {};
        emit({
          type: 'hook_response',
          eventName,
          action: decision.action,
          reason: decision.reason,
          input: inputRecord,
          output: decision.output,
          toolUseID,
        });
        return decision.output as any;
      }],
      timeout: 30,
    }];
  }

  return Object.keys(hooks).length ? hooks : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function normalizeAskUserQuestions(input: Record<string, unknown>): AskUserQuestionItem[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  return rawQuestions.slice(0, 4).flatMap((item): AskUserQuestionItem[] => {
    const raw = asRecord(item);
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    if (!question) return [];
    const header = typeof raw.header === 'string' && raw.header.trim()
      ? raw.header.trim().slice(0, 24)
      : 'Question';
    const options = Array.isArray(raw.options)
      ? raw.options.slice(0, 4).flatMap((option): AskUserQuestionOption[] => {
          const opt = asRecord(option);
          const label = typeof opt.label === 'string' ? opt.label.trim() : '';
          if (!label) return [];
          return [{
            label,
            description: typeof opt.description === 'string' ? opt.description : '',
            preview: typeof opt.preview === 'string' ? opt.preview : undefined,
          }];
        })
      : [];
    if (options.length < 2) return [];
    return [{
      question,
      header,
      options,
      multiSelect: raw.multiSelect === true,
    }];
  });
}

function buildFallbackAnswers(questions: AskUserQuestionItem[]) {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    answers[question.question] = 'No response before timeout';
  }
  return answers;
}

function buildKnowledgeSystemPrompt(sources: Array<{ name: string; path: string }>) {
  return [
    '你可以访问以下用户知识来源(只读):',
    ...sources.map((source) => `- "${source.name}": ${source.path}`),
    '回答涉及个人知识、笔记、历史记录或知识库内容时,主动使用 Glob 找文件、Grep 全文搜索、Read 读取内容。',
    '引用时给出文件路径；markdown 段落标题、CSV 行列或上传 .xlsx 生成的 .md 表格摘要都可以作为定位信息。Obsidian 风格的 [[wikilink]] 和 #tag 可以直接 grep。',
  ].join('\n');
}

function buildDatasourceSystemPrompt(datasources: DatasourceRow[]) {
  return [
    '当前运行已接入以下只读数据源(SQLite),通过 MCP 工具查询:',
    ...datasources.map((source) => `- "${source.name}" (id: ${source.id}): 表 ${source.tables.map((table) => `${table.name}(${table.rowCount} 行)`).join('、') || '(无表)'}`),
    '需要数据时:先用 list_datasources 查看表结构,再用 query_datasource 执行单条 SELECT/WITH 查询(SQLite 方言)。',
    `查询结果最多 ${DATASOURCE_QUERY_MAX_ROWS} 行;统计、聚合、排序尽量放在 SQL 里完成,不要把全表拉出来自己算。`,
    '不要编造数据;回答里的数字必须来自查询结果。需要可视化时,把查到的数据渲染成 HTML 写入 ./viz/<slug>.html。',
  ].join('\n');
}

function buildSkillsSystemPrompt(skills: string[]) {
  return [
    '当前 Agent 模板已启用以下 Skills:',
    ...skills.map((skill) => `- ${skill}`),
    '当用户请求以 /<skill> 开头,或请求明显匹配某个 Skill 的用途时,优先使用 Skill 工具加载并执行对应 Skill。',
    '不要在相关请求中只凭通用能力回答;如果使用了 Skill,在回答中说明使用了哪个 Skill。',
  ].join('\n');
}

function buildAskUserQuestionSystemPrompt() {
  return [
    '当前 Agent 模板已启用 AskUserQuestion 工具。',
    '当用户需求、范围、输出格式、偏好或关键约束不明确,且用户答案会明显改变结果时,主动调用 AskUserQuestion,不要直接猜。',
    'AskUserQuestion 输入格式必须是: { questions: [{ question, header, options, multiSelect }] }。',
    '每个问题提供 2-4 个 options;每个 option 包含 label 和 description,可选 preview;header 保持简短。',
  ].join('\n');
}

function buildToolSearchSystemPrompt(mode: string) {
  return [
    `当前 Agent 模板已请求启用 SDK ToolSearch,运行配置为 ENABLE_TOOL_SEARCH=${mode}。`,
    'ToolSearch 是按需发现工具的机制,底层/协议中可能显示为 tool_search；它不同于 WebSearch、Grep、Glob 这类普通搜索工具。',
    '本项目不会额外注入 ToolSearch MCP 兜底工具；当用户询问可用工具或搜索能力时,如实说明 SDK ToolSearch 是否已请求启用,并说明非官方兼容网关可能不支持 SDK tool_reference。',
  ].join('\n');
}

function buildRunIsolationSystemPrompt() {
  return [
    '当前 run 在隔离 workspace 中执行。创建或修改 workspace skill 时,使用相对路径 ./.claude/skills/<skill-name>/SKILL.md。',
    '不要检查、读取或写入宿主用户技能背包、~/.claude/skills、~/.ssh 或 /Users/.../Library/Application Support/agentma2；这些路径由 Dashboard 服务端管理。',
  ].join('\n');
}

function getSelectedSkillSlashCommand(prompt: string, skills?: string[]) {
  if (!skills?.length) return null;
  const match = prompt.trim().match(/^\/([a-zA-Z0-9._:-]+)(?:\s+|$)([\s\S]*)$/);
  if (!match) return null;

  const command = match[1].toLowerCase();
  for (const skill of skills) {
    const name = skill.trim();
    if (!name) continue;
    const aliases = [name, name.includes(':') ? name.split(':').pop() || '' : '']
      .filter(Boolean)
      .map((alias) => alias.toLowerCase());
    if (aliases.includes(command)) {
      return {
        command: match[1],
        skill: name,
        args: (match[2] || '').trim(),
      };
    }
  }
  return null;
}

function getThinkingText(block: Record<string, unknown>) {
  if (block.type !== 'thinking') return '';
  for (const key of ['thinking', 'text', 'content', 'summary']) {
    if (typeof block[key] === 'string') return block[key] as string;
  }
  return '';
}

function getThinkingDeltaText(event: Record<string, unknown>) {
  if (event.type !== 'content_block_delta') return '';
  const delta = event.delta;
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return '';
  const record = delta as Record<string, unknown>;
  if (record.type !== 'thinking_delta') return '';
  for (const key of ['thinking', 'text']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return '';
}

async function* buildUserPromptStream(text: string, images: NonNullable<RunAgentOptions['promptImages']>): AsyncIterable<SDKUserMessage> {
  const content: any[] = [];
  const cleanText = text.trim();
  if (cleanText) content.push({ type: 'text', text: cleanText });
  for (const image of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.data,
      },
    });
  }
  yield {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  };
}

type PromptImageInput = NonNullable<RunAgentOptions['promptImages']>[number];
type MaterializedPromptImage = {
  relativePath: string;
  mediaType: PromptImageInput['mediaType'];
  name?: string;
  size: number;
};

const IMAGE_EXTENSIONS: Record<PromptImageInput['mediaType'], string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const ATTACHMENT_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VISION_PREPROCESS_TIMEOUT_MS = 60_000;

function cleanBase64Data(value: string) {
  return value.trim().replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
}

function safeAttachmentBaseName(value: string | undefined, fallback: string) {
  const parsed = path.parse(path.basename(String(value || '').replace(/\\/g, '/')));
  const base = (parsed.name || fallback)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || fallback;
}

function materializePromptImages(cwd: string, images: PromptImageInput[]): MaterializedPromptImage[] {
  if (!images.length) return [];
  const attachmentsDir = path.join(cwd, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return images.map((image, index) => {
    const extension = IMAGE_EXTENSIONS[image.mediaType] || '.png';
    const buffer = Buffer.from(cleanBase64Data(image.data), 'base64');
    const base = safeAttachmentBaseName(image.name, `image-${index + 1}`);
    const suffix = crypto.randomBytes(3).toString('hex');
    const fileName = `${stamp}-${index + 1}-${base}-${suffix}${extension}`;
    const filePath = path.join(attachmentsDir, fileName);
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    return {
      relativePath: path.relative(cwd, filePath).replace(/\\/g, '/'),
      mediaType: image.mediaType,
      name: image.name,
      size: buffer.byteLength,
    };
  });
}

function buildAnthropicMessagesUrl(baseUrl: string | undefined) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.anthropic.com/v1/messages';
  if (/\/v1\/messages$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function extractModelResponseText(data: unknown) {
  if (!data || typeof data !== 'object') return '';
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === 'string' && text.trim() ? [text.trim()] : [];
  }).join('\n');
}

function summarizeHtmlModelResponse(raw: string, contentType: string) {
  const trimmed = raw.trim();
  if (!/html/i.test(contentType) && !/^<!doctype html/i.test(trimmed) && !/^<html[\s>]/i.test(trimmed)) return '';
  const title = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  return [
    '模型网关返回了 HTML 页面而不是 JSON 响应。',
    title ? `页面标题: ${title}。` : '',
    '请检查 provider profile 的 Base URL 是否是 Anthropic-compatible API endpoint，而不是网页地址；也检查本机代理、Cloudflare 或网关鉴权是否拦截了请求。',
  ].filter(Boolean).join(' ');
}

function formatMaterializedImageList(files: MaterializedPromptImage[]) {
  return files.map((file, index) => (
    `${index + 1}. ${file.relativePath} (${file.mediaType}, ${file.size} bytes${file.name ? `, original: ${file.name}` : ''})`
  )).join('\n');
}

function workspaceHasAttachmentImages(cwd: string) {
  const attachmentsDir = path.resolve(cwd, 'attachments');
  try {
    return fs.readdirSync(attachmentsDir).some((name) => ATTACHMENT_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()));
  } catch {
    return false;
  }
}

function uploadedAttachmentImageReadPath(toolName: string, input: unknown, cwd: string) {
  if (toolName !== 'Read') return '';
  const filePath = (input as Record<string, unknown> | null | undefined)?.file_path;
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const rawPath = filePath.trim();
  if (/^file:/i.test(rawPath)) return rawPath;
  const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath));
  const attachmentsRoot = path.resolve(cwd, 'attachments');
  if (resolved !== attachmentsRoot && !resolved.startsWith(`${attachmentsRoot}${path.sep}`)) return '';
  if (!ATTACHMENT_IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return '';
  return path.relative(cwd, resolved).replace(/\\/g, '/');
}

function normalizeAttachmentImagePathCandidate(value: string, cwd: string) {
  const rawPath = value.trim()
    .replace(/^["'(<]+/, '')
    .replace(/[>"'),;]+$/, '');
  if (!rawPath || /^file:/i.test(rawPath)) return '';
  if (!rawPath.includes('attachments/')) return '';
  const resolved = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath.replace(/^\.\//, '')));
  const attachmentsRoot = path.resolve(cwd, 'attachments');
  if (resolved !== attachmentsRoot && !resolved.startsWith(`${attachmentsRoot}${path.sep}`)) return '';
  if (!ATTACHMENT_IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return '';
  return path.relative(cwd, resolved).replace(/\\/g, '/');
}

function uploadedAttachmentImageBashPath(toolName: string, input: unknown, cwd: string) {
  if (toolName !== 'Bash') return '';
  const command = (input as Record<string, unknown> | null | undefined)?.command;
  if (typeof command !== 'string' || !command.trim()) return '';
  if (!/(base64|python3?|PIL|Image\.open|cat|xxd|sips|convert|magick)/i.test(command)) return '';
  const tokens = command.match(/[^\s]+/g) || [];
  for (const token of tokens) {
    const imagePath = normalizeAttachmentImagePathCandidate(token, cwd);
    if (imagePath) return imagePath;
  }
  return '';
}

async function requestVisionPreprocess(
  visual: NonNullable<RunAgentOptions['visualPreprocess']>,
  images: PromptImageInput[],
  files: MaterializedPromptImage[],
  userPrompt: string,
  signal?: AbortSignal,
) {
  const content: Array<Record<string, unknown>> = images.map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType,
      data: cleanBase64Data(image.data),
    },
  }));
  const fileList = formatMaterializedImageList(files);
  const promptText = [
    '你是 AgentMa 的独立视觉预处理器。请只基于图片中可见内容输出给后续 agent 使用的观察结果。',
    '',
    '输出要求:',
    '1. 分图片列出可见对象、界面结构、图表/代码/表格等关键信息。',
    '2. 尽量提取可读文字和数字；不确定的内容标注不确定。',
    '3. 不要执行用户任务，只提供视觉识别结果。',
    '',
    '本地附件路径:',
    fileList,
    '',
    '用户原始请求:',
    userPrompt.trim().slice(0, 4000) || '请识别这些图片。',
  ].join('\n');
  content.push({ type: 'text', text: promptText });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_PREPROCESS_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(buildAnthropicMessagesUrl(visual.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': visual.apiKey,
        authorization: `Bearer ${visual.apiKey}`,
      },
      body: JSON.stringify({
        model: visual.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content }],
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const htmlError = summarizeHtmlModelResponse(raw, response.headers.get('content-type') || '');
    if (htmlError) {
      throw new Error(response.ok ? htmlError : `视觉预处理失败 HTTP ${response.status}: ${htmlError}`);
    }
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = raw;
    }
    if (!response.ok) {
      const message = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      throw new Error(`视觉预处理失败 HTTP ${response.status}: ${message.slice(0, 1200)}`);
    }
    const text = extractModelResponseText(parsed);
    if (!text) throw new Error(`视觉预处理模型 ${visual.model} 未返回可用文本`);
    return text;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`视觉预处理超时(${VISION_PREPROCESS_TIMEOUT_MS / 1000}s)`, { cause: error });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timeout);
  }
}

function appendVisionPreprocessResult(
  prompt: string,
  model: string,
  files: MaterializedPromptImage[],
  visualText: string,
) {
  const fileList = formatMaterializedImageList(files);
  return [
    prompt.trim() || '请基于视觉预处理结果继续处理。',
    '',
    '[Uploaded images saved in workspace]',
    fileList,
    '这些是本地 workspace 相对路径；不要用 file:// URL、WebFetch 或把图片转成大段 base64。视觉预处理结果已在下方给出，优先使用它。',
    '',
    `[Vision preprocessing result: ${model}]`,
    visualText.trim(),
  ].join('\n');
}

function appendUploadedImagePaths(prompt: string, files: MaterializedPromptImage[], imageInspectAvailable: boolean) {
  if (!files.length) return prompt;
  const imageHandlingHint = imageInspectAvailable
    ? '这些是本地 workspace 相对路径；需要读取图片内容时，优先调用内部 MCP 工具 mcp__image__inspect 并传 imagePath/imagePaths。不要用 file:// URL、WebFetch 或把图片转成大段 base64。'
    : '这些是本地 workspace 相对路径；当前 Agent 模板未启用 image.inspect。不要用 Read/Bash/base64 读取图片；若当前模型无法直接查看图片，请开启视觉预处理，或在 Agent 模板里勾选 image.inspect。';
  return [
    prompt.trim() || '请分析这些图片。',
    '',
    '[Uploaded images saved in workspace]',
    formatMaterializedImageList(files),
    imageHandlingHint,
  ].join('\n');
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const cwd = opts.cwd || path.join('/tmp', `agentma-run-${opts.tenantId}-${Date.now()}`);
  fs.mkdirSync(cwd, { recursive: true });
  cleanupExpiredRunCwds(cwd);

  const seedMarkerPath = path.join(cwd, AGENT_SEED_MARKER);
  const isFreshCwd = !opts.resumeSdkSessionId && !fs.existsSync(seedMarkerPath);
  if (opts.seedDir && isFreshCwd && fs.existsSync(opts.seedDir)) {
    copyAgentSeedSafe(opts.seedDir, cwd);
    fs.writeFileSync(seedMarkerPath, String(Date.now()));
  }

  // Per-call env: 仅白名单，绝不把宿主全部 process.env 灌进租户 run。
  const env: Record<string, string> = {};
  for (const key of RUN_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v != null) env[key] = String(v);
  }
  // 隔离 HOME 到运行 workspace：让 ~ 解析到受控空目录，读不到宿主 ~/.claude、~/.ssh 等。
  // 使用 cwd 下的稳定子目录，保证同一对话跨 run resume 时 HOME 保持稳定。
  const runHome = path.join(cwd, '.agent-home');
  fs.mkdirSync(runHome, { recursive: true });
  const skillProvision = provisionRunSkills(opts.skills, cwd);
  const runSkills = skillProvision.provisioned;
  for (const issue of skillProvision.issues) {
    console.warn(`[skill] 未投放 "${issue.skill}": ${issue.reason} (tenant=${opts.tenantId})`);
    opts.emit({ type: 'run_log', level: 'warn', scope: 'skill', message: `Skill "${issue.skill}" 未加载: ${issue.reason}` });
  }
  env.HOME = runHome;
  env.ANTHROPIC_API_KEY = opts.apiKey;
  if (opts.baseUrl) env.ANTHROPIC_BASE_URL = opts.baseUrl;
  const toolSearchRequested = opts.tools?.includes(TOOL_SEARCH_TOOL_NAME) === true;
  if (toolSearchRequested) {
    env.ENABLE_TOOL_SEARCH = resolveToolSearchEnvValue();
    opts.emit({
      type: 'run_log',
      level: 'info',
      scope: 'tool_search',
      message: `ToolSearch 已请求启用: ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH}`,
    });
    if (!isFirstPartyAnthropicBaseUrl(opts.baseUrl)) {
      opts.emit({
        type: 'run_log',
        level: 'warn',
        scope: 'tool_search',
        message: '当前 ANTHROPIC_BASE_URL 不是 Anthropic 官方端点；ToolSearch 需要网关支持 tool_reference，否则请求可能失败或回退。',
      });
    }
  }

  const customMcp = buildCustomToolsMcp(opts.requestTools || []);
  const hooks = buildTenantHooks(opts.tenantId, opts.emit);
  const requestedKnowledgeIds = Array.isArray(opts.knowledgeSourceIds) && opts.knowledgeSourceIds.length
    ? new Set(opts.knowledgeSourceIds)
    : null;
  const knowledgeSources = (opts.useKnowledge || requestedKnowledgeIds)
    ? listKnowledgeSources(opts.tenantId, opts.sub, opts.role === 'tenant_admin' ? 'tenant_admin' : null).filter((source) => (
      source.enabled && !source.archivedAt && (!requestedKnowledgeIds || requestedKnowledgeIds.has(source.id))
    ))
    : [];
  const additionalDirectories = knowledgeSources.map((source) => source.path);
  // Knowledge dirs are granted via additionalDirectories (read + write at the SDK level),
  // so we enforce read-only ourselves in canUseTool. A source is writable for this run
  // only when the run's initiator is its creator AND the creator turned read_only off;
  // every other case (non-creator, or read_only on) stays locked.
  const readOnlyKnowledgeDirs = knowledgeSources
    .filter((source) => !isKnowledgeSourceWritable(source, opts.sub))
    .map((source) => path.resolve(source.path));
  const knowledgeSystemPrompt = knowledgeSources.length ? buildKnowledgeSystemPrompt(knowledgeSources) : '';
  const requestedDatasourceIds = new Set((opts.datasourceIds || []).map((id) => String(id).trim()).filter(Boolean));
  const datasources = requestedDatasourceIds.size
    ? listDatasources(opts.tenantId).filter((source) => source.enabled && requestedDatasourceIds.has(source.id))
    : [];
  const datasourceMcp = buildDatasourceMcp(datasources);
  const internalToolRuntimeNames = new Map(listInternalTools().map((item) => [item.id, `mcp__${item.serverName}__${item.toolName}`]));
  const configuredToolNames = new Set<string>((opts.tools || []).map((name) => String(name || '').trim()).filter(Boolean));
  for (const agent of Object.values(opts.subagents || {})) {
    for (const toolName of agent.tools || []) {
      const normalized = String(toolName || '').trim();
      if (normalized) configuredToolNames.add(normalized);
    }
  }
  const modelRequestMcp = Array.from(configuredToolNames).some((name) => name === 'model.request' || name === internalToolRuntimeNames.get('model.request'))
    ? buildModelRequestMcp(opts.tenantId)
    : null;
  const hasPromptImages = Boolean(opts.promptImages?.length);
  const hasAttachmentImages = workspaceHasAttachmentImages(cwd);
  const imageInspectConfigured = Array.from(configuredToolNames).some((name) => name === 'image.inspect' || name === internalToolRuntimeNames.get('image.inspect'));
  const templateHasExplicitToolList = Boolean(opts.tools?.length);
  const shouldAutoExposeImageInspect = (hasPromptImages || hasAttachmentImages) && !templateHasExplicitToolList;
  const imageInspectMcp = (imageInspectConfigured || shouldAutoExposeImageInspect)
    ? buildImageInspectMcp(opts.tenantId, cwd, opts.imageInspectModel || opts.visualPreprocess?.model || '')
    : null;
  const uploadedImageGuardEnabled = hasPromptImages || hasAttachmentImages || Boolean(imageInspectMcp);
  const datasourceSystemPrompt = datasources.length ? buildDatasourceSystemPrompt(datasources) : '';
  const skillsSystemPrompt = runSkills.length ? buildSkillsSystemPrompt(runSkills) : '';
  const askUserQuestionSystemPrompt = opts.tools?.includes('AskUserQuestion') ? buildAskUserQuestionSystemPrompt() : '';
  const toolSearchSystemPrompt = toolSearchRequested ? buildToolSearchSystemPrompt(env.ENABLE_TOOL_SEARCH || 'true') : '';
  const modelRequestSystemPrompt = modelRequestMcp
    ? '已启用内部工具 model.request。需要请求其他模型、视觉模型或专用小模型时，可以调用该工具；model 必须选择账户已配置且已启用的模型名，不要尝试传入 API Key 或 Base URL。若用户上传图片已保存为 attachments 路径，不要用 Read/Bash 读出 base64 再传给 model.request；应改用 image.inspect。'
    : '';
  const imageInspectSystemPrompt = imageInspectMcp
    ? '已启用内部工具 image.inspect。用户上传的图片会保存到 workspace 的 attachments/ 下；需要读取图片像素或 OCR 时，调用 mcp__image__inspect，传 imagePath 或 imagePaths。不要使用 file://、WebFetch 或把图片转成大段 base64。model 必须选择账户已配置且已启用的模型名；如果工具页已配置默认模型，可以省略 model。'
    : '';
  const effectiveSystemPrompt = [opts.systemPrompt, buildRunIsolationSystemPrompt(), knowledgeSystemPrompt, datasourceSystemPrompt, skillsSystemPrompt, askUserQuestionSystemPrompt, toolSearchSystemPrompt, modelRequestSystemPrompt, imageInspectSystemPrompt].filter((part) => part && part.trim()).join('\n\n');
  const nativeMcpServerNames = new Set((opts.mcpServers || []).map((name) => name.trim()).filter((name) => /^[A-Za-z0-9._-]{1,128}$/.test(name)));
  let customNames = new Set<string>();
  if (customMcp) {
    let endpoints: any[] = [];
    try { endpoints = JSON.parse(fs.readFileSync('/tmp/agentma_custom_tools.json', 'utf-8')); } catch {}
    customNames = new Set(endpoints.filter((e) => e?.endpoint && e.name).map((e) => String(e.name)));
  }
  const sdkVisibleToolName = (name: string) => {
    if (customNames.has(name)) return `mcp__custom__${name}`;
    return internalToolRuntimeNames.get(name) || name;
  };
  const sdkSubagents = Object.fromEntries(Object.entries(opts.subagents || {}).map(([name, agent]) => [
    name,
    {
      ...agent,
      tools: Array.isArray(agent.tools) ? agent.tools.map(sdkVisibleToolName) : agent.tools,
    },
  ]));
  const agentNames = Object.keys(sdkSubagents);
  const subagentSdkToolNames = new Set<string>();
  for (const agent of Object.values(sdkSubagents)) {
    for (const toolName of agent.tools || []) subagentSdkToolNames.add(toolName);
  }
  // Resolve template tool names → SDK-visible names (prefix custom with mcp__custom__).
  const templateToolNames = new Set<string>();
  const sdkBuiltinTools = new Set<string>();
  if (opts.tools && opts.tools.length) {
    for (const t of opts.tools) {
      const isCustom = customNames.has(t);
      const isInternal = internalToolRuntimeNames.has(t);
      templateToolNames.add(sdkVisibleToolName(t));
      if (t === TOOL_SEARCH_TOOL_NAME) {
        templateToolNames.add('tool_search');
        continue;
      }
      if (t === 'Agent') templateToolNames.add('Task');
      if (t === 'Task') templateToolNames.add('Agent');
      if (!isCustom && !isInternal) sdkBuiltinTools.add(t);
    }
    for (const t of subagentSdkToolNames) {
      if (!t.startsWith('mcp__')) sdkBuiltinTools.add(t);
    }
  }
  if (knowledgeSources.length) {
    for (const toolName of ['Read', 'Grep', 'Glob']) {
      templateToolNames.add(toolName);
      sdkBuiltinTools.add(toolName);
    }
  }
  if (datasources.length) {
    // 模板限定工具时也放行数据源 MCP 工具(随 datasourceIds 启用,不要求模板手填)。
    templateToolNames.add('mcp__datasource__list_datasources');
    templateToolNames.add('mcp__datasource__query_datasource');
  }
  if (imageInspectMcp) {
    // image.inspect 显式启用，或开放模板上传图片时自动挂载。
    templateToolNames.add('mcp__image__inspect');
  }
  if (nativeMcpServerNames.size) {
    for (const serverName of nativeMcpServerNames) {
      const wildcardTool = `mcp__${serverName}__*`;
      templateToolNames.add(wildcardTool);
      sdkBuiltinTools.add(wildcardTool);
    }
  }
  if (opts.skills?.length) {
    templateToolNames.add('Skill');
    sdkBuiltinTools.add('Skill');
  }

  // canUseTool: enforce template scope → safe-allow check → defer to user prompt.
  // NOTE: the SDK's runtime schema requires `updatedInput` to be present (a record)
  // when behavior is 'allow', even though the TS type marks it optional.
  const canUseTool: CanUseTool = async (toolName, input, callOpts) => {
    // 1. Template restriction — if template specifies tools and this isn't one of them, deny.
    const allowedBySubagentDefinition = Boolean(callOpts.agentID && subagentSdkToolNames.has(toolName));
    const allowedByNativeMcpServer = toolName.startsWith('mcp__') && Array.from(nativeMcpServerNames).some((serverName) => (
      toolName.startsWith(`mcp__${serverName}__`)
    ));
    if (templateToolNames.size > 0 && !templateToolNames.has(toolName) && !allowedBySubagentDefinition && !allowedByNativeMcpServer) {
      return { behavior: 'deny', message: `Tool '${toolName}' is not enabled by the agent template.` } as PermissionResult;
    }
    const blockedHostPath = hostPathToolBlock(toolName, input, cwd, additionalDirectories);
    if (blockedHostPath) {
      opts.emit({
        type: 'permission_resolved',
        toolName,
        decision: 'deny',
        reason: blockedHostPath,
      });
      return { behavior: 'deny', message: blockedHostPath } as PermissionResult;
    }
    // 1b. Knowledge sources are read-only. Block writes that target a knowledge
    //     directory *before* tenant policy, so this stays a hard, non-overridable
    //     invariant even if a Permissions rule would otherwise allow the tool.
    const blockedKnowledgeWrite = knowledgeWriteBlock(toolName, input, cwd, readOnlyKnowledgeDirs);
    if (blockedKnowledgeWrite) {
      opts.emit({
        type: 'permission_resolved',
        toolName,
        decision: 'deny',
        reason: '知识库目录为只读',
      });
      return { behavior: 'deny', message: `知识库目录为只读，已阻止写入：${blockedKnowledgeWrite}` } as PermissionResult;
    }
    const uploadedImageReadPath = uploadedImageGuardEnabled ? uploadedAttachmentImageReadPath(toolName, input, cwd) : '';
    if (uploadedImageReadPath) {
      const message = /^file:/i.test(uploadedImageReadPath)
        ? imageInspectMcp
          ? '不要使用 file:// 读取本地图片；请改用 mcp__image__inspect，并传 attachments/... 相对路径。'
          : '不要使用 file:// 读取本地图片；当前 Agent 模板未启用 image.inspect，请开启视觉预处理，或在 Agent 模板里勾选 image.inspect。'
        : imageInspectMcp
          ? `不要用 Read 读取上传图片 ${uploadedImageReadPath}；Read 会把图片转成大段 base64 并可能截断。请调用 mcp__image__inspect，输入 {"imagePath":"${uploadedImageReadPath}"}。`
          : `不要用 Read 读取上传图片 ${uploadedImageReadPath}；Read 会把图片转成大段 base64 并可能截断。当前 Agent 模板未启用 image.inspect，请开启视觉预处理，或在 Agent 模板里勾选 image.inspect。`;
      opts.emit({
        type: 'permission_resolved',
        toolName,
        decision: 'deny',
        reason: message,
      });
      return { behavior: 'deny', message } as PermissionResult;
    }
    const uploadedImageBashPath = uploadedImageGuardEnabled ? uploadedAttachmentImageBashPath(toolName, input, cwd) : '';
    if (uploadedImageBashPath) {
      const message = imageInspectMcp
        ? `不要用 Bash/Python/base64 读取或压缩上传图片 ${uploadedImageBashPath} 后再发给模型；这会经过工具输出并可能截断。请调用 mcp__image__inspect，输入 {"imagePath":"${uploadedImageBashPath}"}。`
        : `不要用 Bash/Python/base64 读取或压缩上传图片 ${uploadedImageBashPath} 后再发给模型；这会经过工具输出并可能截断。当前 Agent 模板未启用 image.inspect，请开启视觉预处理，或在 Agent 模板里勾选 image.inspect。`;
      opts.emit({
        type: 'permission_resolved',
        toolName,
        decision: 'deny',
        reason: message,
      });
      return { behavior: 'deny', message } as PermissionResult;
    }
    if (toolName === 'AskUserQuestion') {
      const questions = normalizeAskUserQuestions(input);
      if (!questions.length) {
        return { behavior: 'deny', message: 'AskUserQuestion did not provide valid questions.' } as PermissionResult;
      }
      const answer = await opts.requestUserQuestion({
        questions,
        toolUseID: callOpts.toolUseID,
        signal: callOpts.signal,
      });
      return {
        behavior: 'allow',
        updatedInput: { ...input, questions, answers: answer.answers },
      } as PermissionResult;
    }
    // 2. Tenant policy rules from the Permissions page.
    const policyDecision = evaluatePermissionRules(opts.tenantId, toolName, input);
    if (policyDecision) {
      opts.emit({
        type: 'permission_resolved',
        toolName,
        decision: policyDecision.behavior,
        reason: policyDecision.reason,
      });
      if (policyDecision.behavior === 'allow') {
        return { behavior: 'allow', updatedInput: input } as PermissionResult;
      }
      return { behavior: 'deny', message: policyDecision.reason } as PermissionResult;
    }
    const visualWriteTarget = visualSkillWriteTarget(toolName, input, opts.skills, cwd);
    if (visualWriteTarget) {
      opts.emit({
        type: 'permission_resolved',
        toolName,
        decision: 'allow',
        reason: `agentma-visual:${visualWriteTarget}`,
      });
      return { behavior: 'allow', updatedInput: input } as PermissionResult;
    }
    // 3. Safe auto-allow (read-only). Strip MCP prefix to check the bare name.
    const bareName = toolName.startsWith('mcp__') ? (toolName.split('__').pop() || toolName) : toolName;
    if (SAFE_AUTO_ALLOW_TOOLS.has(toolName) || SAFE_AUTO_ALLOW_TOOLS.has(bareName)) {
      return { behavior: 'allow', updatedInput: input } as PermissionResult;
    }
    // 4. Interactive: ask the user via SSE.
    const r = await opts.requestPermission({
      toolName,
      input,
      title: callOpts.title,
      displayName: callOpts.displayName,
      description: callOpts.description,
      toolUseID: callOpts.toolUseID,
      signal: callOpts.signal,
    });
    if (r.decision === 'allow') {
      return { behavior: 'allow', updatedInput: r.updatedInput || input } as PermissionResult;
    }
    return { behavior: 'deny', message: r.reason || 'denied by user' } as PermissionResult;
  };

  const startTime = Date.now();
  let inTok = 0, outTok = 0, finalText = '', status = 'success', outcome: RunOutcome = 'completed', sdkSessionId = opts.resumeSdkSessionId || '', structuredOutput: unknown = undefined;
  let emittedThinking = false;
  let runPrompt = opts.prompt;
  let runPromptImages = opts.promptImages || [];
  const emitThinking = (text: string) => {
    if (!text) return;
    emittedThinking = true;
    opts.emit({ type: 'delta', text, thinking: true });
  };

  try {
    if (runPromptImages.length) {
      const imageFiles = materializePromptImages(cwd, runPromptImages);
      opts.emit({
        type: 'run_log',
        level: 'info',
        scope: 'skill',
        message: `图片已保存: ${imageFiles.map((file) => file.relativePath).join(', ')}`,
      });
      if (opts.visualPreprocess?.enabled) {
        if (!opts.visualPreprocess.model.trim()) throw new Error('视觉预处理已开启，但未配置视觉识别模型');
        if (!opts.visualPreprocess.apiKey.trim()) throw new Error(`视觉识别模型 ${opts.visualPreprocess.model} 所属供应商未配置 API Key`);
        opts.emit({
          type: 'run_log',
          level: 'info',
          scope: 'skill',
          message: `视觉预处理: ${runPromptImages.length} 张图片 -> ${opts.visualPreprocess.model}`,
        });
        const visualText = await requestVisionPreprocess(
          opts.visualPreprocess,
          runPromptImages,
          imageFiles,
          runPrompt,
          opts.abortController?.signal,
        );
        runPrompt = appendVisionPreprocessResult(runPrompt, opts.visualPreprocess.model, imageFiles, visualText);
        runPromptImages = [];
      } else {
        runPrompt = appendUploadedImagePaths(runPrompt, imageFiles, Boolean(imageInspectMcp));
      }
    }

    const selectedSkillCommand = getSelectedSkillSlashCommand(runPrompt, runSkills);
    if (selectedSkillCommand) {
      const args = selectedSkillCommand.args ? ` ${selectedSkillCommand.args.slice(0, 160)}` : '';
      opts.emit({ type: 'run_log', level: 'info', scope: 'skill', message: `/${selectedSkillCommand.command}${args} -> ${selectedSkillCommand.skill}` });
    }
    const queryPrompt = runPromptImages.length
      ? buildUserPromptStream(runPrompt, runPromptImages)
      : runPrompt;
    for await (const msg of query({
      prompt: queryPrompt,
      options: {
        model: opts.model,
        permissionMode: 'default',  // canUseTool decides everything
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
        ...(sdkBuiltinTools.size ? { tools: Array.from(sdkBuiltinTools) } : {}),
        canUseTool,
        ...(opts.tools?.includes('AskUserQuestion') ? { toolConfig: { askUserQuestion: { previewFormat: 'markdown' } } } : {}),
        includePartialMessages: true,
        maxTurns: Number(opts.maxTurns) || 20,
        ...(opts.effort ? { effort: opts.effort } : {}),
        thinking: { type: 'adaptive', display: 'summarized' },
        cwd,
        settingSources: RUN_SETTING_SOURCES,
        ...(SANDBOX_ENABLED ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: SANDBOX_FAIL_IF_UNAVAILABLE,
            ...(SANDBOX_NETWORK_MANAGED_ONLY ? { network: { allowManagedDomainsOnly: true } } : {}),
          },
        } : {}),
        ...(additionalDirectories.length ? { additionalDirectories } : {}),
        ...(agentNames.length ? { agents: sdkSubagents, forwardSubagentText: true, agentProgressSummaries: true } : {}),
        ...(opts.resumeSdkSessionId ? { resume: opts.resumeSdkSessionId } : {}),
        ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
        ...(opts.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
        ...(runSkills.length ? { skills: runSkills } : {}),
        env,
        settings: { showThinkingSummaries: true },
        ...(hooks ? { hooks, includeHookEvents: true } : {}),
        ...(customMcp || datasourceMcp || modelRequestMcp || imageInspectMcp ? {
          mcpServers: {
            ...(customMcp ? { custom: customMcp } : {}),
            ...(datasourceMcp ? { datasource: datasourceMcp } : {}),
            ...(modelRequestMcp ? { model: modelRequestMcp } : {}),
            ...(imageInspectMcp ? { image: imageInspectMcp } : {}),
          },
        } : {}),
        ...(effectiveSystemPrompt ? { systemPrompt: effectiveSystemPrompt } : {}),
      },
    })) {
      const m = msg as any;
      if (m.session_id && !sdkSessionId) sdkSessionId = m.session_id;
      if (m.type === 'stream_event') {
        emitThinking(getThinkingDeltaText(m.event || {}));
      } else if (m.type === 'system' && m.subtype === 'init') {
        opts.emit({ type: 'system', subtype: 'init', model: m.model, tools: (m.tools || []).length, cwd, sdkSessionId: m.session_id || sdkSessionId || undefined });
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text) { finalText += b.text; opts.emit({ type: 'delta', text: b.text }); }
          else if (b.type === 'thinking') {
            const thinkingText = getThinkingText(b);
            if (!emittedThinking) emitThinking(thinkingText);
          }
          else if (b.type === 'tool_use') opts.emit({ type: 'delta', text: `\n🔧 ${b.name}(${JSON.stringify(b.input).slice(0, 150)})\n` });
        }
      } else if (m.type === 'user') {
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_result') {
            const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            opts.emit({ type: 'delta', text: `📤 ${t.slice(0, 300)}\n` });
          }
        }
      } else if (m.type === 'result') {
        status = m.subtype || 'success';
        outcome = mapResultSubtypeToOutcome(status);
        opts.emit({ type: 'run_outcome', outcome, subtype: status });
        if (m.session_id) sdkSessionId = m.session_id;
        if (m.result) finalText = m.result;
        if (m.structured_output !== undefined) structuredOutput = m.structured_output;
        const u = m.usage || {};
        inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        outTok = u.output_tokens || 0;
      } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
        opts.emit({
          type: 'context_compaction',
          subtype: 'compact_boundary',
          message: typeof m.message === 'string' ? m.message : 'SDK 已触发上下文自动压缩边界',
          sdkSessionId: m.session_id || sdkSessionId || undefined,
          timestamp: Date.now(),
        });
      } else if (m.type === 'system' && m.subtype === 'task_started') {
        opts.emit({
          type: 'task_started',
          taskId: m.task_id,
          toolUseId: m.tool_use_id,
          description: m.description || '',
          subagentType: m.subagent_type,
          taskType: m.task_type,
          prompt: m.prompt,
          sdkSessionId: m.session_id || sdkSessionId || undefined,
        });
      } else if (m.type === 'system' && m.subtype === 'task_progress') {
        opts.emit({
          type: 'task_progress',
          taskId: m.task_id,
          toolUseId: m.tool_use_id,
          description: m.description || '',
          subagentType: m.subagent_type,
          lastToolName: m.last_tool_name,
          summary: m.summary,
          usage: m.usage,
          sdkSessionId: m.session_id || sdkSessionId || undefined,
        });
      } else if (m.type === 'system' && m.subtype === 'task_updated') {
        opts.emit({
          type: 'task_updated',
          taskId: m.task_id,
          status: m.patch?.status,
          description: m.patch?.description,
          error: m.patch?.error,
          backgrounded: m.patch?.is_backgrounded,
          sdkSessionId: m.session_id || sdkSessionId || undefined,
        });
      } else if (m.type === 'system' && m.subtype === 'task_notification') {
        opts.emit({
          type: 'task_notification',
          taskId: m.task_id,
          toolUseId: m.tool_use_id,
          status: m.status,
          summary: m.summary,
          outputFile: m.output_file,
          usage: m.usage,
          sdkSessionId: m.session_id || sdkSessionId || undefined,
        });
      }
    }
  } catch (e) {
    const message = (e as Error).message || String(e);
    const isAbort = opts.abortController?.signal.aborted || (e as Error).name === 'AbortError';
    status = isAbort ? 'aborted' : 'error';
    outcome = isAbort ? 'stopped' : 'provider_error';
    opts.emit({ type: 'run_outcome', outcome, message });
    opts.emit({ type: 'error', message });
  }

  const durationMs = Date.now() - startTime;
  const costUsd = estimateCostUsd(opts.model, inTok, outTok);
  try { recordAgentRun(opts.tenantId, { sub: opts.sub, model: opts.model, durationMs, inputTokens: inTok, outputTokens: outTok, costUsd, status: outcome }); } catch {}
  opts.emit({
    type: 'result',
    subtype: status,
    text: finalText,
    usage: { input_tokens: inTok, output_tokens: outTok },
    duration_ms: durationMs,
    cost_usd: costUsd,
    model: opts.model,
    sdkSessionId: sdkSessionId || undefined,
    sdkCwd: cwd,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  });
}
