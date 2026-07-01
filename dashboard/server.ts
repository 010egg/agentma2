import express from 'express';
import cors from 'cors';
import multer from 'multer';
import readXlsxFile from 'read-excel-file/node';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentDefinition, EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import {
  addTeamMember,
  audit,
  authenticateToken,
  canAccessChatSession,
  createApiKey,
  createDatasource,
  createTenantUser,
  createTeam,
  createVisual,
  deleteDatasource,
  deleteUser,
  deleteChatSession,
  deleteVisual,
  forkChatSession,
  getDataLocation,
  getDatasource,
  getMe,
  getLatestAgentRuntimeSession,
  getQuota,
  getQuotaUsageSummary,
  getChatSession,
  getPublicSkill,
  getTenantById,
  getVisual,
  evaluateHookRules,
  evaluatePermissionRules,
  listAgentTemplates,
  listApiKeys,
  listAuditLogs,
  listChatSessions,
  listChatSessionSummaries,
  listDatasources,
  listHookRules,
  listInternalToolSettings,
  listKnowledgeSources,
  listPermissionRules,
  listProviderProfiles,
  listPublicSkills,
  listTeamMembers,
  listTeams,
  listUsers,
  listVisuals,
  loginUser,
  joinChatSession,
  MAX_VISUAL_BYTES,
  createPublicSkill,
  registerUser,
  removeTeamMember,
  recordLearnedSkill,
  replaceHookRules,
  replaceKnowledgeSources,
  replacePermissionRules,
  replaceProviderProfiles,
  replaceAgentTemplates,
  resolveProviderProfileForModel,
  revokeApiKey,
  saveChatSession,
  scanKnowledgeSources,
  signJWT,
  testKnowledgeSource,
  updateChatSession,
  updateChatSessionCollaboration,
  updateInternalToolSetting,
  updatePublicSkill,
  updateQuota,
  updateTenant,
  updateUserRole,
} from './server-store.ts';
import {
  runAgent,
  createPermissionRequester,
  createAskUserQuestionRequester,
  resolvePermissionRequest,
  resolveAskUserQuestion,
} from './server-agent.ts';
import type { AgentEvent } from './server-agent.ts';
import type { Role } from './server-store.ts';
import {
  importDatasourceUpload,
  runDatasourceQuery,
  serializeQueryResult,
  datasourceUploadFormat,
  MAX_DATASOURCE_UPLOAD_BYTES,
  DATASOURCE_UPLOAD_EXTENSIONS,
} from './server-datasource.ts';
import { listInternalTools } from './server-internal-tools.ts';
import { mapResultSubtypeToOutcome, outcomeToMessageStatus, type RunOutcome } from './src/simulator/run-state.ts';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '25mb' }));
app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: '上传内容超过限制，单次最多上传 20MB 文本文件' });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: '请求 JSON 格式无效' });
    return;
  }
  next(error);
});
// 生产模式：serve 前端静态文件
app.use(express.static(path.join(import.meta.dirname, 'dist')));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ═══ EventSource ═══
const eventSources = new Map<string, { name: string; type: string; url: string; enabled: boolean }>();
const deployStatus = new Map<string, { status: string; message: string; started: number }>();
const sessionSubs = new Map<string, Set<string>>();
const sessionSSE = new Map<string, Set<express.Response>>();
const chatSessionSSE = new Map<string, Set<express.Response>>();

type ServerOwnedRun = {
  id: string;
  tenantId: string;
  ownerSub: string;
  events: AgentEvent[];
  subscribers: Set<express.Response>;
  abortController: AbortController;
  startedAt: number;
  completedAt?: number;
  outcome?: RunOutcome;
  sessionId: string;
  sessionDraft: Record<string, unknown>;
  messagesBeforeAssistant: unknown[];
  assistantDraftId: string;
  assistantTimestamp: number;
  thinking: string;
  text: string;
  outcomeDetail?: string;
  cachedErrorMessage?: string;
  sdkSessionId?: string;
  sdkCwd?: string;
  structuredOutput?: unknown;
  runStats?: { costUsd?: number; durationMs?: number; inTok?: number; outTok?: number };
};

const serverRuns = new Map<string, ServerOwnedRun>();
const SERVER_RUN_TTL_MS = 60 * 60 * 1000;

function writeSse(res: express.Response, event: unknown) {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {}
}

function emitServerRun(run: ServerOwnedRun, event: AgentEvent) {
  run.events.push(event);
  for (const subscriber of run.subscribers) writeSse(subscriber, event);
}

function cleanupServerRuns() {
  const cutoff = Date.now() - SERVER_RUN_TTL_MS;
  for (const [runId, run] of serverRuns) {
    if (run.completedAt && run.completedAt < cutoff) serverRuns.delete(runId);
  }
}

function appendAssistantForServerRun(run: ServerOwnedRun, content: string, outcome: RunOutcome) {
  return [
    ...run.messagesBeforeAssistant,
    {
      id: run.assistantDraftId,
      role: 'assistant',
      content,
      status: outcomeToMessageStatus(outcome),
      outcome,
      timestamp: run.assistantTimestamp,
      ...(run.thinking ? { thinking: run.thinking } : {}),
      ...(run.outcomeDetail ? { outcomeDetail: run.outcomeDetail } : {}),
      ...(run.runStats ? { runStats: run.runStats } : {}),
      runId: run.id,
    },
  ];
}

function persistServerRunMessages(run: ServerOwnedRun, messages: unknown[]) {
  const nowMs = Date.now();
  const draft = {
    ...run.sessionDraft,
    id: run.sessionId,
    messages,
    messageCount: messages.length,
    sdkSessionId: run.sdkSessionId || run.sessionDraft.sdkSessionId,
    sdkCwd: run.sdkCwd || run.sessionDraft.sdkCwd,
    updatedAt: nowMs,
  };
  try {
    const result = saveChatSession(run.tenantId, run.ownerSub, draft as any);
    if (result.ok) emitChatSessionEvent(result.session.id, { type: 'session_updated', updatedAt: result.session.updatedAt });
  } catch (error) {
    console.error('[chat-run] failed to persist final message', run.id, (error as Error).message);
  }
}

function persistServerRunPendingMessage(run: ServerOwnedRun) {
  const existing = getChatSession(run.tenantId, run.ownerSub, run.sessionId);
  if (existing && existing.messages.length > 0) {
    const lastMessage = existing.messages[existing.messages.length - 1] as Record<string, unknown> | undefined;
    const canAttachRunId = lastMessage?.id === run.assistantDraftId
      && lastMessage.role === 'assistant'
      && (lastMessage.status === 'pending' || lastMessage.status === 'streaming');
    if (!canAttachRunId) return;
    persistServerRunMessages(run, existing.messages.map((message: any) => (
      message.id === run.assistantDraftId ? { ...message, runId: run.id } : message
    )));
    return;
  }
  const messages = [
    ...run.messagesBeforeAssistant,
    {
      id: run.assistantDraftId,
      role: 'assistant',
      content: '',
      status: 'pending',
      timestamp: run.assistantTimestamp,
      runId: run.id,
    },
  ];
  persistServerRunMessages(run, messages);
}

function persistServerRunFinalMessage(run: ServerOwnedRun, content: string, outcome: RunOutcome) {
  persistServerRunMessages(run, appendAssistantForServerRun(run, content, outcome));
}

function emitChatSessionEvent(sessionId: string, payload: Record<string, unknown>) {
  const clients = chatSessionSSE.get(sessionId);
  if (!clients || clients.size === 0) return;
  const event = JSON.stringify({ sessionId, ...payload });
  for (const client of clients) {
    client.write(`data: ${event}\n\n`);
  }
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
  return Array.from(new Set(normalized));
}

const MAX_SKILL_MD_BYTES = 512 * 1024;
const MAX_CLAUDE_MD_PREVIEW_BYTES = 512 * 1024;
const MAX_LOCAL_SKILL_SCAN_RESULTS = 200;
const MAX_SKILL_INSTALL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_INSTALL_FILES = 500;
const BLOCKED_SKILL_INSTALL_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const MAX_WORKSPACE_WIKI_SCAN_RESULTS = 50;
const MAX_WORKSPACE_WIKI_FILES = 2000;
const MAX_WORKSPACE_WIKI_BYTES = 50 * 1024 * 1024;
const BLOCKED_WORKSPACE_WIKI_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);
const WORKSPACE_ROOT = path.resolve(expandLocalPath(process.env.AGENTMA_WORKSPACE_ROOT || path.join(import.meta.dirname, '..')));
const USER_SKILLS_DIR = path.resolve(expandLocalPath(process.env.AGENTMA_USER_SKILLS_DIR || '~/.claude/skills'));
const PUBLIC_SKILLS_DIR = path.join(getDataLocation().dataDir, 'public-skills');

type SkillInfoResponse = {
  name: string;
  description: string;
  location: 'project' | 'user' | 'plugin';
  path: string;
  enabled: boolean;
  sourcePath?: string;
  installedPath?: string;
  installed?: boolean;
  learnedFromPublicSkillId?: string;
  learnedFromPublicRevision?: number;
  learnedAt?: number;
  overwrote?: boolean;
};

type WorkspaceWikiCandidate = {
  name: string;
  path: string;
  relativePath: string;
  fileCount: number;
  markdownCount: number;
  sampleFiles: string[];
};

function makeHttpError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function expandLocalPath(input: string) {
  const value = input.trim();
  if (value.startsWith('file://')) {
    return new URL(value).pathname;
  }
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveLocalInputPath(input: string, baseDir = process.cwd()) {
  const expanded = expandLocalPath(input);
  if (!expanded) throw makeHttpError('need path', 400);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function resolveLocalSkillPath(input: string, baseDir = process.cwd()) {
  const resolved = resolveLocalInputPath(input, baseDir);
  if (!fs.existsSync(resolved)) throw makeHttpError('路径不存在', 404);

  const stat = fs.statSync(resolved);
  const skillFile = stat.isDirectory() ? path.join(resolved, 'SKILL.md') : resolved;
  const skillDir = stat.isDirectory() ? resolved : path.dirname(resolved);
  if (path.basename(skillFile) !== 'SKILL.md') {
    throw makeHttpError('请选择 SKILL.md 文件或包含 SKILL.md 的技能目录', 400);
  }
  if (!fs.existsSync(skillFile)) throw makeHttpError('目录下没有 SKILL.md', 404);

  const fileStat = fs.statSync(skillFile);
  if (!fileStat.isFile()) throw makeHttpError('SKILL.md 不是文件', 400);
  if (fileStat.size > MAX_SKILL_MD_BYTES) throw makeHttpError('SKILL.md 不能超过 512KB', 400);

  return { skillFile, skillDir };
}

function isPathInside(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspaceSkillPath(input: string, workspaceRootPath = WORKSPACE_ROOT) {
  const { skillFile, skillDir } = resolveLocalSkillPath(input, workspaceRootPath);
  const workspaceRoot = fs.realpathSync(workspaceRootPath);
  const realSkillFile = fs.realpathSync(skillFile);
  const realSkillDir = fs.realpathSync(skillDir);
  if (!isPathInside(realSkillDir, workspaceRoot) || !isPathInside(realSkillFile, workspaceRoot)) {
    throw makeHttpError('只能从当前 workspace 抽取技能到用户背包', 403);
  }
  return { skillFile: realSkillFile, skillDir: realSkillDir };
}

function userSkillInstallDir(skillName: string) {
  const userSkillsRoot = path.resolve(USER_SKILLS_DIR);
  const destDir = path.join(userSkillsRoot, skillName);
  if (!isPathInside(destDir, userSkillsRoot)) throw makeHttpError('技能安装路径非法', 400);
  return destDir;
}

function createWorkspaceSkillInfo(skillFile: string, skillDir: string) {
  if (path.basename(skillFile) !== 'SKILL.md') {
    throw makeHttpError('请选择 SKILL.md 文件或包含 SKILL.md 的技能目录', 400);
  }
  const fileStat = fs.statSync(skillFile);
  if (!fileStat.isFile()) throw makeHttpError('SKILL.md 不是文件', 400);
  if (fileStat.size > MAX_SKILL_MD_BYTES) throw makeHttpError('SKILL.md 不能超过 512KB', 400);

  const content = fs.readFileSync(skillFile, 'utf-8');
  const frontmatterName = readFrontmatterValue(content, 'name');
  const title = content.match(/^#\s+(.+)/m)?.[1]?.trim() || '';
  const name = normalizeInstallSkillName(frontmatterName || path.basename(skillDir));
  const description = readFrontmatterValue(content, 'description') || title || `Workspace 技能: ${skillDir}`;
  const installedPath = userSkillInstallDir(name);
  const installed = fs.existsSync(installedPath);

  return {
    name,
    description,
    location: 'user' as const,
    path: `${skillDir}${path.sep}`,
    sourcePath: `${skillDir}${path.sep}`,
    installedPath: installed ? `${installedPath}${path.sep}` : undefined,
    installed,
    enabled: true,
  };
}

function createLocalSkillInfo(skillFile: string, skillDir: string) {
  if (path.basename(skillFile) !== 'SKILL.md') {
    throw makeHttpError('请选择 SKILL.md 文件或包含 SKILL.md 的技能目录', 400);
  }
  const fileStat = fs.statSync(skillFile);
  if (!fileStat.isFile()) throw makeHttpError('SKILL.md 不是文件', 400);
  if (fileStat.size > MAX_SKILL_MD_BYTES) throw makeHttpError('SKILL.md 不能超过 512KB', 400);

  const content = fs.readFileSync(skillFile, 'utf-8');
  const frontmatterName = readFrontmatterValue(content, 'name');
  const title = content.match(/^#\s+(.+)/m)?.[1]?.trim() || '';
  const name = (frontmatterName || path.basename(skillDir)).trim() || 'local-skill';
  const description = readFrontmatterValue(content, 'description') || title || `本地技能: ${skillDir}`;

  return {
    name,
    description,
    location: 'user' as const,
    path: `${skillDir}${path.sep}`,
    sourcePath: `${skillDir}${path.sep}`,
    enabled: true,
  };
}

function normalizeInstallSkillName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw makeHttpError('SKILL.md frontmatter 缺少有效 name', 400);
  if (normalized.length > 64) throw makeHttpError('技能 name 不能超过 64 个字符', 400);
  return normalized;
}

function createInstallSkillInfo(skillFile: string, skillDir: string, options: { nameOverride?: string } = {}): SkillInfoResponse {
  const fileStat = fs.statSync(skillFile);
  if (!fileStat.isFile()) throw makeHttpError('SKILL.md 不是文件', 400);
  if (fileStat.size > MAX_SKILL_MD_BYTES) throw makeHttpError('SKILL.md 不能超过 512KB', 400);

  const content = fs.readFileSync(skillFile, 'utf-8');
  const frontmatterName = readFrontmatterValue(content, 'name');
  const description = readFrontmatterValue(content, 'description');
  if (!frontmatterName || !description) {
    throw makeHttpError('SKILL.md 必须包含 name 和 description frontmatter', 400);
  }
  const installName = options.nameOverride || frontmatterName;

  return {
    name: normalizeInstallSkillName(installName),
    description,
    location: 'user' as const,
    path: `${skillDir}${path.sep}`,
    enabled: false,
  };
}

function validateSkillInstallTree(skillDir: string) {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw makeHttpError(`技能目录不能包含符号链接: ${path.relative(skillDir, absolute)}`, 400);
      if (stat.isDirectory()) {
        if (BLOCKED_SKILL_INSTALL_DIRS.has(entry.name)) throw makeHttpError(`技能目录不能包含 ${entry.name} 目录`, 400);
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw makeHttpError(`技能目录包含不支持的文件类型: ${path.relative(skillDir, absolute)}`, 400);
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_SKILL_INSTALL_FILES) throw makeHttpError(`技能文件数量不能超过 ${MAX_SKILL_INSTALL_FILES}`, 400);
      if (totalBytes > MAX_SKILL_INSTALL_BYTES) throw makeHttpError('技能目录不能超过 20MB', 400);
    }
  };

  walk(skillDir);
  return { fileCount, totalBytes };
}

function copySkillDirSafe(sourceDir: string, destDir: string) {
  const copyRecursive = (currentSource: string, currentDest: string) => {
    fs.mkdirSync(currentDest, { recursive: true });
    const entries = fs.readdirSync(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(currentSource, entry.name);
      const destPath = path.join(currentDest, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw makeHttpError(`技能目录不能包含符号链接: ${path.relative(sourceDir, sourcePath)}`, 400);
      if (stat.isDirectory()) {
        if (BLOCKED_SKILL_INSTALL_DIRS.has(entry.name)) throw makeHttpError(`技能目录不能包含 ${entry.name} 目录`, 400);
        copyRecursive(sourcePath, destPath);
      } else if (stat.isFile()) {
        fs.copyFileSync(sourcePath, destPath);
      } else {
        throw makeHttpError(`技能目录包含不支持的文件类型: ${path.relative(sourceDir, sourcePath)}`, 400);
      }
    }
  };

  copyRecursive(sourceDir, destDir);
}

function installSkillDirToUserBackpack(
  skillFile: string,
  skillDir: string,
  options: { nameOverride?: string; overwrite?: boolean } = {},
) {
  const skill = createInstallSkillInfo(skillFile, skillDir, options);
  const installStats = validateSkillInstallTree(skillDir);

  fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
  const userSkillsRoot = fs.realpathSync(USER_SKILLS_DIR);
  const destDir = path.join(userSkillsRoot, skill.name);
  if (!isPathInside(destDir, userSkillsRoot)) throw makeHttpError('技能安装路径非法', 400);
  const destExists = fs.existsSync(destDir);
  if (destExists && !options.overwrite) throw makeHttpError(`用户背包中已存在技能 "${skill.name}"`, 409);

  const tmpDir = path.join(userSkillsRoot, `.agentma-install-${skill.name}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    copySkillDirSafe(skillDir, tmpDir);
    if (destExists) fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, destDir);
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }

  return {
    ...skill,
    path: `${destDir}${path.sep}`,
    sourcePath: `${skillDir}${path.sep}`,
    installedPath: `${destDir}${path.sep}`,
    installed: true,
    installStats,
    overwrote: destExists,
  };
}

function installWorkspaceSkill(inputPath: string, workspaceRootPath = WORKSPACE_ROOT, options: { overwrite?: boolean } = {}) {
  const { skillFile, skillDir } = resolveWorkspaceSkillPath(inputPath, workspaceRootPath);
  return installSkillDirToUserBackpack(skillFile, skillDir, options);
}

function collectLocalSkillDirs(root: string, depth: number, found: Array<{ skillFile: string; skillDir: string }>) {
  if (depth > 3 || found.length >= MAX_LOCAL_SKILL_SCAN_RESULTS) return;
  const ownSkillFile = path.join(root, 'SKILL.md');
  if (fs.existsSync(ownSkillFile) && fs.statSync(ownSkillFile).isFile()) {
    found.push({ skillFile: ownSkillFile, skillDir: root });
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (found.length >= MAX_LOCAL_SKILL_SCAN_RESULTS) return;
    if (!entry.isDirectory()) continue;
    if (['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache'].includes(entry.name)) continue;
    collectLocalSkillDirs(path.join(root, entry.name), depth + 1, found);
  }
}

function resolveWorkspaceInputPath(input: string, workspaceRootPath = WORKSPACE_ROOT) {
  const resolved = resolveLocalInputPath(input, workspaceRootPath);
  if (!fs.existsSync(resolved)) throw makeHttpError('路径不存在', 404);
  const workspaceRoot = fs.realpathSync(workspaceRootPath);
  const realPath = fs.realpathSync(resolved);
  if (!isPathInside(realPath, workspaceRoot)) {
    throw makeHttpError('只能扫描当前 workspace 下的技能', 403);
  }
  return realPath;
}

function scanWorkspaceSkills(input: string, workspaceRootPath = WORKSPACE_ROOT) {
  const resolved = resolveWorkspaceInputPath(input, workspaceRootPath);
  const stat = fs.statSync(resolved);
  const found: Array<{ skillFile: string; skillDir: string }> = [];
  if (stat.isFile()) {
    const { skillFile, skillDir } = resolveWorkspaceSkillPath(resolved, workspaceRootPath);
    found.push({ skillFile, skillDir });
  } else if (stat.isDirectory()) {
    collectLocalSkillDirs(resolved, 0, found);
  } else {
    throw makeHttpError('路径不是文件或目录', 400);
  }

  const deduped = Array.from(new Map<string, { skillFile: string; skillDir: string }>(found.map((item): [string, { skillFile: string; skillDir: string }] => {
    const skillFile = fs.realpathSync(item.skillFile);
    const skillDir = fs.realpathSync(item.skillDir);
    return [skillFile, { skillFile, skillDir }];
  })).values());
  if (!deduped.length) throw makeHttpError('没有找到 SKILL.md', 404);
  return deduped.map(({ skillFile, skillDir }) => createWorkspaceSkillInfo(skillFile, skillDir));
}

function scanLocalSkills(input: string) {
  const resolved = resolveLocalInputPath(input);
  if (!fs.existsSync(resolved)) throw makeHttpError('路径不存在', 404);

  const stat = fs.statSync(resolved);
  const found: Array<{ skillFile: string; skillDir: string }> = [];
  if (stat.isFile()) {
    const { skillFile, skillDir } = resolveLocalSkillPath(resolved);
    found.push({ skillFile, skillDir });
  } else if (stat.isDirectory()) {
    collectLocalSkillDirs(resolved, 0, found);
  } else {
    throw makeHttpError('路径不是文件或目录', 400);
  }

  const deduped = Array.from(new Map<string, { skillFile: string; skillDir: string }>(found.map((item): [string, { skillFile: string; skillDir: string }] => {
    const skillFile = path.resolve(item.skillFile);
    const skillDir = path.resolve(item.skillDir);
    return [skillFile, { skillFile, skillDir }];
  })).values());
  if (!deduped.length) throw makeHttpError('没有找到 SKILL.md', 404);
  return deduped.map(({ skillFile, skillDir }) => createLocalSkillInfo(skillFile, skillDir));
}

function parseConversationIdInput(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const looksLikeConversationLink = /^(https?:\/\/|\/|conversations(?:[/?]|$)|\?)/i.test(trimmed);
  if (!looksLikeConversationLink) return trimmed;

  try {
    const url = new URL(trimmed, 'https://dandelion.skin');
    return (url.searchParams.get('conversationId') || url.searchParams.get('join') || '').trim();
  } catch {
    return '';
  }
}

function normalizeHtmlText(value: string) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const normalizedTitle = title ? normalizeHtmlText(title) : '';
  if (normalizedTitle) return normalizedTitle.slice(0, 160);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const normalizedH1 = h1 ? normalizeHtmlText(h1) : '';
  return normalizedH1 ? normalizedH1.slice(0, 160) : undefined;
}

function normalizeMarkdownHeadingText(value: string) {
  return normalizeHtmlText(
    value
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, ''),
  );
}

function titleFromVisualPath(relPath?: string) {
  const basename = path.basename(String(relPath || '')).replace(/\.(html|md|markdown)$/i, '');
  return basename ? basename.slice(0, 160) : undefined;
}

function extractMarkdownTitle(markdown: string, relPath?: string) {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let firstHeading = '';
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(#{1,6})(?!#)\s*(.+?)\s*#*\s*$/);
    if (!match) continue;
    const title = normalizeMarkdownHeadingText(match[2]);
    if (!title) continue;
    if (match[1].length === 1) return title.slice(0, 160);
    firstHeading ||= title;
  }
  return titleFromVisualPath(relPath) || (firstHeading ? firstHeading.slice(0, 160) : undefined);
}

function visualFormatFromPath(relPath: string): 'html' | 'markdown' {
  return /\.(md|markdown)$/i.test(relPath) ? 'markdown' : 'html';
}

function extractVisualTitle(content: string, format: 'html' | 'markdown', relPath?: string) {
  return format === 'markdown' ? extractMarkdownTitle(content, relPath) : extractTitle(content);
}

function readWorkspaceVisual(auth: any, cid: string, relPath: string) {
  const sessionId = parseConversationIdInput(cid);
  if (!sessionId) throw makeHttpError('need cid', 400);
  const session = getChatSession(auth.tenantId, getChatOwnerSub(auth), sessionId);
  if (!session) throw makeHttpError('对话不存在或无权访问', 404);
  const sdkCwd = typeof session.sdkCwd === 'string' ? session.sdkCwd.trim() : '';
  if (!sdkCwd) throw makeHttpError('该对话没有 workspace', 404);
  if (!/^viz\/[A-Za-z0-9._-]+\.(html|md|markdown)$/i.test(relPath)) throw makeHttpError('非法路径', 400);

  const cwdInput = path.resolve(expandLocalPath(sdkCwd));
  if (!fs.existsSync(cwdInput)) throw makeHttpError('workspace 不存在', 404);
  const cwd = fs.realpathSync(cwdInput);
  const file = path.resolve(cwd, relPath);
  if (!isPathInside(file, cwd)) throw makeHttpError('路径越界', 400);
  if (!fs.existsSync(file)) throw makeHttpError('文件不存在', 404);
  const realFile = fs.realpathSync(file);
  if (!isPathInside(realFile, cwd)) throw makeHttpError('路径越界', 400);
  const stat = fs.statSync(realFile);
  if (!stat.isFile()) throw makeHttpError('文件不存在', 404);
  if (stat.size > MAX_VISUAL_BYTES) throw makeHttpError('文件过大', 413);
  return {
    html: fs.readFileSync(realFile, 'utf8'),
    format: visualFormatFromPath(relPath),
    sourceSlug: relPath,
    mtimeMs: stat.mtimeMs,
  };
}

function resolveWorkspaceRootFromConversation(auth: any, conversationId: string) {
  const id = parseConversationIdInput(conversationId);
  if (!id) throw makeHttpError('need conversationId', 400);
  const session = getChatSession(auth.tenantId, getChatOwnerSub(auth), id);
  if (!session) throw makeHttpError('对话不存在或无权访问', 404);
  const sdkCwd = typeof session.sdkCwd === 'string' ? session.sdkCwd.trim() : '';
  if (!sdkCwd) throw makeHttpError('该对话没有 workspace 信息，请先在这个对话里完成一次运行', 400);
  const resolved = path.resolve(expandLocalPath(sdkCwd));
  if (!fs.existsSync(resolved)) throw makeHttpError('该对话记录的 workspace 路径不存在', 404);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw makeHttpError('该对话记录的 workspace 不是目录', 400);
  return fs.realpathSync(resolved);
}

function scanWorkspaceSkillsFromConversation(auth: any, conversationId: string) {
  const workspaceRoot = resolveWorkspaceRootFromConversation(auth, conversationId);
  try {
    return scanWorkspaceSkills('.claude/skills', workspaceRoot);
  } catch (error) {
    const err = error as Error & { status?: number };
    if (err.status === 404) return [];
    throw error;
  }
}

function installWorkspaceSkillFromConversation(
  auth: any,
  conversationId: string,
  skillName: string,
  options: { overwrite?: boolean } = {},
) {
  const name = skillName.trim();
  if (!name) throw makeHttpError('need skill name', 400);
  const workspaceRoot = resolveWorkspaceRootFromConversation(auth, conversationId);
  const candidates = scanWorkspaceSkills('.claude/skills', workspaceRoot);
  const match = candidates.find((skill) => skill.name === name);
  if (!match) throw makeHttpError(`对话 workspace 中没有找到技能 "${name}"`, 404);
  return installWorkspaceSkill(match.sourcePath || match.path, workspaceRoot, options);
}

function collectWorkspaceWikiStats(wikiDir: string) {
  let fileCount = 0;
  let markdownCount = 0;
  let totalBytes = 0;
  const sampleFiles: string[] = [];
  const stack = [wikiDir];

  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!BLOCKED_WORKSPACE_WIKI_DIRS.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      totalBytes += stat.size;
      const relative = path.relative(wikiDir, absolute).split(path.sep).join('/');
      if (path.extname(entry.name).toLowerCase() === '.md') {
        markdownCount += 1;
        if (sampleFiles.length < 10) sampleFiles.push(relative);
      } else if (sampleFiles.length < 10 && ['.json', '.canvas'].includes(path.extname(entry.name).toLowerCase())) {
        sampleFiles.push(relative);
      }
      if (fileCount > MAX_WORKSPACE_WIKI_FILES || totalBytes > MAX_WORKSPACE_WIKI_BYTES) {
        return { fileCount, markdownCount, totalBytes, sampleFiles, tooLarge: true };
      }
    }
  }

  return { fileCount, markdownCount, totalBytes, sampleFiles, tooLarge: false };
}

function workspaceWikiCandidateForDir(dir: string, workspaceRoot: string): WorkspaceWikiCandidate | null {
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return null;
  }
  if (!isPathInside(realDir, workspaceRoot)) return null;
  const stats = collectWorkspaceWikiStats(realDir);
  const hasWikiMarker = ['_index.md', '_backlinks.json', '_fragment_links.json', '_absorb_log.json']
    .some((name) => fs.existsSync(path.join(realDir, name)));
  if (!hasWikiMarker && (path.basename(realDir) !== 'wiki' || stats.markdownCount === 0)) return null;
  if (stats.tooLarge) return null;
  const relativePath = path.relative(workspaceRoot, realDir).split(path.sep).join('/') || '.';
  return {
    name: relativePath === '.' ? 'wiki' : relativePath,
    path: realDir,
    relativePath,
    fileCount: stats.fileCount,
    markdownCount: stats.markdownCount,
    sampleFiles: stats.sampleFiles,
  };
}

function scanWorkspaceWikis(input: string, workspaceRootPath = WORKSPACE_ROOT): WorkspaceWikiCandidate[] {
  const root = fs.realpathSync(workspaceRootPath);
  const resolved = input.trim() ? resolveWorkspaceInputPath(input, root) : root;
  const stat = fs.statSync(resolved);
  const found = new Map<string, WorkspaceWikiCandidate>();

  const visit = (dir: string, depth: number) => {
    if (found.size >= MAX_WORKSPACE_WIKI_SCAN_RESULTS || depth > 5) return;
    const candidate = workspaceWikiCandidateForDir(dir, root);
    if (candidate) found.set(candidate.path, candidate);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.size >= MAX_WORKSPACE_WIKI_SCAN_RESULTS) return;
      if (!entry.isDirectory() || BLOCKED_WORKSPACE_WIKI_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };

  if (stat.isDirectory()) {
    visit(resolved, 0);
  } else {
    throw makeHttpError('路径不是目录', 400);
  }

  return Array.from(found.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function scanWorkspaceWikisFromConversation(auth: any, conversationId: string) {
  const workspaceRoot = resolveWorkspaceRootFromConversation(auth, conversationId);
  return scanWorkspaceWikis('', workspaceRoot);
}

function validateWorkspaceWikiImportTree(wikiDir: string) {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw makeHttpError(`Wiki 目录不能包含符号链接: ${path.relative(wikiDir, absolute)}`, 400);
      if (stat.isDirectory()) {
        if (BLOCKED_WORKSPACE_WIKI_DIRS.has(entry.name)) throw makeHttpError(`Wiki 目录不能包含 ${entry.name} 目录`, 400);
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw makeHttpError(`Wiki 目录包含不支持的文件类型: ${path.relative(wikiDir, absolute)}`, 400);
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_WORKSPACE_WIKI_FILES) throw makeHttpError(`Wiki 文件数量不能超过 ${MAX_WORKSPACE_WIKI_FILES}`, 400);
      if (totalBytes > MAX_WORKSPACE_WIKI_BYTES) throw makeHttpError('Wiki 目录不能超过 50MB', 400);
    }
  };

  walk(wikiDir);
  return { fileCount, totalBytes };
}

function copyWorkspaceWikiDirSafe(sourceDir: string, destDir: string) {
  const copyRecursive = (currentSource: string, currentDest: string) => {
    fs.mkdirSync(currentDest, { recursive: true });
    const entries = fs.readdirSync(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(currentSource, entry.name);
      const destPath = path.join(currentDest, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) throw makeHttpError(`Wiki 目录不能包含符号链接: ${path.relative(sourceDir, sourcePath)}`, 400);
      if (stat.isDirectory()) {
        if (BLOCKED_WORKSPACE_WIKI_DIRS.has(entry.name)) throw makeHttpError(`Wiki 目录不能包含 ${entry.name} 目录`, 400);
        copyRecursive(sourcePath, destPath);
      } else if (stat.isFile()) {
        fs.copyFileSync(sourcePath, destPath);
      } else {
        throw makeHttpError(`Wiki 目录包含不支持的文件类型: ${path.relative(sourceDir, sourcePath)}`, 400);
      }
    }
  };

  copyRecursive(sourceDir, destDir);
}

function importWorkspaceWikiFromConversation(auth: any, conversationId: string, inputPath: string, name: string) {
  const workspaceRoot = resolveWorkspaceRootFromConversation(auth, conversationId);
  const resolved = resolveWorkspaceInputPath(inputPath || 'wiki', workspaceRoot);
  const candidate = workspaceWikiCandidateForDir(resolved, workspaceRoot);
  if (!candidate) throw makeHttpError('该路径不是可同步的 wiki 目录', 400);
  const importStats = validateWorkspaceWikiImportTree(candidate.path);
  const importId = crypto.randomUUID();
  const uploadRoot = path.join(getDataLocation().dataDir, 'knowledge-uploads', auth.tenantId, 'workspace-wikis', importId);
  const resolvedUploadRoot = path.resolve(uploadRoot);
  const tmpDir = `${resolvedUploadRoot}.tmp`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    copyWorkspaceWikiDirSafe(candidate.path, tmpDir);
    fs.mkdirSync(path.dirname(resolvedUploadRoot), { recursive: true });
    fs.renameSync(tmpDir, resolvedUploadRoot);
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }

  const sourceName = (name.trim() || `${candidate.name.replace(/\/?wiki$/, '') || 'Workspace'} Wiki`).slice(0, 80);
  const actorEmail = auth.email || auth.sub;
  const current = listKnowledgeSources(auth.tenantId, actorEmail, auth.role)
    .filter((source) => auth.role === 'tenant_admin' || source.createdBy === actorEmail);
  const saved = replaceKnowledgeSources(auth.tenantId, [
    ...current,
    { name: sourceName, path: resolvedUploadRoot, enabled: true, readOnly: true, createdBy: actorEmail },
  ], actorEmail, auth.role);
  const source = saved.find((item) => item.path === fs.realpathSync.native(resolvedUploadRoot)) || saved[saved.length - 1];
  return { source, importedPath: resolvedUploadRoot, candidate, importStats };
}

function readFrontmatterValue(content: string, key: string) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return '';
  const line = match[1].split('\n').find((item) => item.trim().startsWith(`${key}:`));
  if (!line) return '';
  return line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
}

function normalizePublicSkillSlug(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw makeHttpError('公共技能 slug 不能为空', 400);
  if (normalized.length > 80) throw makeHttpError('公共技能 slug 不能超过 80 个字符', 400);
  return normalized;
}

function toPublicSkillResponse(skill: ReturnType<typeof getPublicSkill> extends infer T ? NonNullable<T> : never) {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    authorSub: skill.authorSub,
    authorTenantId: skill.authorTenantId,
    revision: skill.revision,
    publishedAt: skill.publishedAt,
    updatedAt: skill.updatedAt,
  };
}

function resolveUserBackpackSkillPath(input: { path?: unknown; name?: unknown }) {
  const rawPath = typeof input.path === 'string' ? input.path.trim() : '';
  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  const candidate = rawPath || (rawName ? userSkillInstallDir(normalizeInstallSkillName(rawName)) : '');
  if (!candidate) throw makeHttpError('need path or name', 400);
  if (/^https?:\/\//i.test(candidate)) {
    throw makeHttpError('只能发布本地技能目录或 SKILL.md 文件', 400);
  }

  fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
  const { skillFile, skillDir } = resolveLocalSkillPath(candidate, rawPath ? WORKSPACE_ROOT : USER_SKILLS_DIR);
  if (fs.lstatSync(skillDir).isSymbolicLink() || fs.lstatSync(skillFile).isSymbolicLink()) {
    throw makeHttpError('技能发布源不能是符号链接', 400);
  }
  const realSkillFile = fs.realpathSync(skillFile);
  const realSkillDir = fs.realpathSync(skillDir);
  return { skillFile: realSkillFile, skillDir: realSkillDir };
}

function publicSkillBundleDir(skillId: string, revision: number) {
  return path.join(PUBLIC_SKILLS_DIR, skillId, `rev-${revision}`);
}

function copySkillDirToPublicBundle(sourceDir: string, destDir: string) {
  const installStats = validateSkillInstallTree(sourceDir);
  fs.mkdirSync(PUBLIC_SKILLS_DIR, { recursive: true });
  const publicRoot = path.resolve(PUBLIC_SKILLS_DIR);
  const resolvedDest = path.resolve(destDir);
  if (!isPathInside(resolvedDest, publicRoot)) throw makeHttpError('公共技能存储路径非法', 400);
  if (fs.existsSync(resolvedDest)) throw makeHttpError('公共技能 revision 已存在', 409);

  const tmpDir = path.join(publicRoot, `.agentma-public-${crypto.randomBytes(6).toString('hex')}`);
  try {
    copySkillDirSafe(sourceDir, tmpDir);
    fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
    fs.renameSync(tmpDir, resolvedDest);
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return installStats;
}

function resolvePublicBundleSkillPath(publicSkill: NonNullable<ReturnType<typeof getPublicSkill>>) {
  fs.mkdirSync(PUBLIC_SKILLS_DIR, { recursive: true });
  const publicRoot = fs.realpathSync(PUBLIC_SKILLS_DIR);
  const { skillFile, skillDir } = resolveLocalSkillPath(publicSkill.bundlePath, PUBLIC_SKILLS_DIR);
  const realSkillFile = fs.realpathSync(skillFile);
  const realSkillDir = fs.realpathSync(skillDir);
  if (!isPathInside(realSkillDir, publicRoot) || !isPathInside(realSkillFile, publicRoot)) {
    throw makeHttpError('公共技能包路径非法', 400);
  }
  return { skillFile: realSkillFile, skillDir: realSkillDir };
}

function publishPublicSkillFromBackpack(auth: { tenantId: string; sub: string }, body: Record<string, unknown>) {
  const { skillFile, skillDir } = resolveUserBackpackSkillPath({ path: body.path, name: body.skillName || body.name });
  const skill = createInstallSkillInfo(skillFile, skillDir);
  const displayName = String(body.displayName || body.name || skill.name).trim().slice(0, 100) || skill.name;
  const description = String(body.description || skill.description).trim().slice(0, 500) || skill.description;
  const slug = normalizePublicSkillSlug(String(body.slug || displayName));
  if (getPublicSkill(slug)) throw makeHttpError(`公共技能 slug "${slug}" 已存在`, 409);

  const id = crypto.randomUUID();
  const revision = 1;
  const bundlePath = publicSkillBundleDir(id, revision);
  const publishStats = copySkillDirToPublicBundle(skillDir, bundlePath);
  const publicSkill = createPublicSkill({
    id,
    slug,
    name: displayName,
    description,
    authorSub: auth.sub,
    authorTenantId: auth.tenantId,
    revision,
    bundlePath,
  });
  return { publicSkill, sourcePath: `${skillDir}${path.sep}`, publishStats };
}

function updatePublicSkillFromBackpack(
  auth: { tenantId: string; sub: string },
  idOrSlug: string,
  body: Record<string, unknown>,
) {
  const current = getPublicSkill(idOrSlug);
  if (!current) throw makeHttpError('公共技能不存在', 404);
  if (current.authorTenantId !== auth.tenantId) throw makeHttpError('只能更新本租户发布的公共技能', 403);

  const hasBundleUpdate = typeof body.path === 'string' || typeof body.skillName === 'string';
  let bundlePath = current.bundlePath;
  let revision = current.revision;
  let sourcePath: string | undefined;
  let publishStats: ReturnType<typeof validateSkillInstallTree> | undefined;
  if (hasBundleUpdate) {
    const { skillFile, skillDir } = resolveUserBackpackSkillPath({ path: body.path, name: body.skillName });
    createInstallSkillInfo(skillFile, skillDir);
    revision = current.revision + 1;
    bundlePath = publicSkillBundleDir(current.id, revision);
    publishStats = copySkillDirToPublicBundle(skillDir, bundlePath);
    sourcePath = `${skillDir}${path.sep}`;
  }

  const slug = body.slug === undefined ? current.slug : normalizePublicSkillSlug(String(body.slug));
  if (slug !== current.slug) {
    const conflict = getPublicSkill(slug);
    if (conflict && conflict.id !== current.id) throw makeHttpError(`公共技能 slug "${slug}" 已存在`, 409);
  }
  const publicSkill = updatePublicSkill(current.id, {
    slug,
    name: String(body.displayName || body.name || current.name).trim().slice(0, 100) || current.name,
    description: String(body.description || current.description).trim().slice(0, 500) || current.description,
    revision,
    bundlePath,
  });
  return { publicSkill: publicSkill!, sourcePath, publishStats };
}

function learnPublicSkillIntoBackpack(auth: { tenantId: string; sub: string }, idOrSlug: string, body: Record<string, unknown>): SkillInfoResponse {
  const publicSkill = getPublicSkill(idOrSlug);
  if (!publicSkill) throw makeHttpError('公共技能不存在', 404);
  const { skillFile, skillDir } = resolvePublicBundleSkillPath(publicSkill);
  const nameOverride = typeof body.nameOverride === 'string' ? body.nameOverride.trim() : '';
  const installed = installSkillDirToUserBackpack(skillFile, skillDir, { nameOverride });
  const learned = recordLearnedSkill({
    tenantId: auth.tenantId,
    ownerSub: auth.sub,
    skillName: installed.name,
    skillPath: installed.installedPath || installed.path,
    publicSkillId: publicSkill.id,
    publicRevision: publicSkill.revision,
  });
  return {
    ...installed,
    learnedFromPublicSkillId: learned.publicSkillId,
    learnedFromPublicRevision: learned.publicRevision,
    learnedAt: learned.learnedAt,
  };
}

function normalizeSubagents(value: unknown): Record<string, AgentDefinition> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => {
    const agentName = name.trim();
    if (!agentName || !item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    if (!description || !prompt) return [];
    const maxTurns = Number(raw.maxTurns);
    const memory = String(raw.memory || '');
    const agent: AgentDefinition = {
      description,
      prompt,
      tools: normalizeStringArray(raw.tools),
      disallowedTools: normalizeStringArray(raw.disallowedTools),
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      skills: normalizeStringArray(raw.skills),
      initialPrompt: typeof raw.initialPrompt === 'string' && raw.initialPrompt.trim() ? raw.initialPrompt : undefined,
      maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : undefined,
      background: typeof raw.background === 'boolean' ? raw.background : undefined,
      memory: memory === 'user' || memory === 'project' || memory === 'local' ? memory : undefined,
      effort: typeof raw.effort === 'string' ? raw.effort as EffortLevel : undefined,
      permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode as PermissionMode : undefined,
    };
    return [[agentName, agent] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeAgentTemplateForApi(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const template = { ...(value as Record<string, unknown>) };

  for (const key of ['tools', 'mcpServers', 'eventSources', 'skills', 'knowledgeSourceIds', 'datasourceIds']) {
    if (Array.isArray(template[key])) template[key] = normalizeStringArray(template[key]) || [];
  }
  template.visualPreprocessDefault = template.visualPreprocessDefault === true ? true : undefined;
  template.visualPreprocessModel = typeof template.visualPreprocessModel === 'string' && template.visualPreprocessModel.trim()
    ? template.visualPreprocessModel.trim()
    : undefined;

  if (template.subagents && typeof template.subagents === 'object' && !Array.isArray(template.subagents)) {
    const normalizedSubagents = Object.entries(template.subagents as Record<string, unknown>).flatMap(([name, agent]) => {
      const normalizedName = name.trim();
      if (!normalizedName || !agent || typeof agent !== 'object' || Array.isArray(agent)) return [];
      const normalizedAgent = { ...(agent as Record<string, unknown>) };
      for (const key of ['tools', 'disallowedTools', 'skills']) {
        if (Array.isArray(normalizedAgent[key])) normalizedAgent[key] = normalizeStringArray(normalizedAgent[key]) || [];
      }
      return [[normalizedName, normalizedAgent] as const];
    });
    template.subagents = Object.fromEntries(normalizedSubagents);
  }

  return template;
}

function agentTemplateActor(auth: { sub: string; email?: string }) {
  return auth.email || auth.sub;
}

type AgentTemplateAuth = { tenantId: string; sub: string; email?: string; role?: Role | null };

function listVisibleAgentTemplates(auth: AgentTemplateAuth) {
  return listAgentTemplates(auth.tenantId, agentTemplateActor(auth), auth.role).map(normalizeAgentTemplateForApi);
}

function getVisibleAgentTemplate(auth: AgentTemplateAuth, templateId: string) {
  const id = templateId.trim();
  if (!id) return null;
  return listVisibleAgentTemplates(auth).find((template) => String(template.id || '') === id) || null;
}

function canManageAgentTemplate(auth: { sub: string; email?: string; role?: Role | null }, template: Record<string, unknown>) {
  return auth.role === 'tenant_admin' || String(template.createdBy || '') === agentTemplateActor(auth);
}

type ClaudeMdPreviewSource = 'user' | 'project' | 'local';
type ClaudeMdPreviewFile = {
  source: ClaudeMdPreviewSource;
  label: string;
  path: string;
  exists: boolean;
  bytes?: number;
  mtimeMs?: number;
  content?: string;
  error?: string;
};

function readClaudeMdPreviewFile(source: ClaudeMdPreviewSource, label: string, filePath: string): ClaudeMdPreviewFile {
  const result: ClaudeMdPreviewFile = { source, label, path: filePath, exists: false };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ...result, exists: true, error: '不是普通文件' };
    const bytes = stat.size;
    const base = { ...result, exists: true, bytes, mtimeMs: stat.mtimeMs };
    if (bytes > MAX_CLAUDE_MD_PREVIEW_BYTES) {
      return { ...base, error: `文件超过 ${Math.round(MAX_CLAUDE_MD_PREVIEW_BYTES / 1024)}KB，未读取内容` };
    }
    return { ...base, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return result;
    return { ...result, error: (error as Error).message || '读取失败' };
  }
}

function buildClaudeMdPreviewFiles(cwd: string) {
  // 运行时 settingSources=[project,local]（不含 user），且 HOME 被隔离到 cwd/.agent-home，
  // 宿主 ~/.claude/CLAUDE.md 不会被加载，故预览也不再列出，保持预览与运行时一致。
  return [
    readClaudeMdPreviewFile('project', '项目根 CLAUDE.md', path.join(cwd, 'CLAUDE.md')),
    readClaudeMdPreviewFile('project', '项目 .claude/CLAUDE.md', path.join(cwd, '.claude', 'CLAUDE.md')),
    readClaudeMdPreviewFile('local', '本地 CLAUDE.local.md', path.join(cwd, 'CLAUDE.local.md')),
  ];
}

function buildEffectiveClaudeMdPreview(files: ClaudeMdPreviewFile[]) {
  return files
    .filter((file) => file.exists && typeof file.content === 'string')
    .map((file) => `<!-- ${file.label}: ${file.path} -->\n${file.content}`)
    .join('\n\n');
}

type ChatImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type ChatImageInput = {
  id?: string;
  name?: string;
  mediaType: ChatImageMimeType;
  data: string;
  size: number;
};
type ChatFileInput = {
  name: string;
  mediaType: string;
  data: string;
  size: number;
};

const CHAT_IMAGE_MIME_TYPES = new Set<ChatImageMimeType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CHAT_FILE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html',
  '.svg', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.sql', '.log', '.xls', '.xlsx',
]);
const MAX_CHAT_IMAGES = 4;
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHAT_FILES = 6;
const MAX_CHAT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_FILE_TEXT_CHARS = 40_000;
const chatFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_CHAT_FILES,
    fileSize: MAX_CHAT_FILE_BYTES,
    fields: 20,
  },
});

function base64SizeBytes(data: string) {
  const clean = data.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function normalizeChatImages(value: unknown): { images: ChatImageInput[]; error?: string } {
  if (!Array.isArray(value)) return { images: [] };
  if (value.length > MAX_CHAT_IMAGES) return { images: [], error: `最多一次发送 ${MAX_CHAT_IMAGES} 张图片` };

  const images: ChatImageInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const mediaType = String(raw.mediaType || '') as ChatImageMimeType;
    const data = String(raw.data || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    if (raw.type !== 'image' || !CHAT_IMAGE_MIME_TYPES.has(mediaType)) continue;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return { images: [], error: '图片 base64 数据无效' };
    const size = Number(raw.size) || base64SizeBytes(data);
    if (size > MAX_CHAT_IMAGE_BYTES) return { images: [], error: '单张图片不能超过 5MB' };
    images.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined,
      name: normalizeChatFileName(raw.name),
      mediaType,
      data,
      size,
    });
  }
  return { images };
}

function normalizeChatFileName(value: unknown) {
  return path.basename(String(value || '').replace(/\\/g, '/')).trim().slice(0, 160);
}

function isSupportedChatFileName(name: string) {
  return CHAT_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function chatFileToPromptBlock(file: ChatFileInput) {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(file.data)) throw new Error(`文件 base64 数据无效: ${file.name}`);
  const buffer = Buffer.from(file.data.replace(/\s/g, ''), 'base64');
  if (buffer.byteLength > MAX_CHAT_FILE_BYTES) throw new Error(`单个文件不能超过 2MB: ${file.name}`);
  let content = '';
  const extension = path.extname(file.name).toLowerCase();
  if (extension === '.xlsx') {
    content = (await xlsxBufferToMarkdown(buffer, file.name)).toString('utf8');
  } else if (extension === '.xls') {
    content = '旧版 .xls Excel 文件已上传，但当前聊天附件只能解析 .xlsx。请转存为 .xlsx 或 CSV 后可读取表格内容。';
  } else {
    content = buffer.toString('utf8');
  }
  const truncated = content.length > MAX_CHAT_FILE_TEXT_CHARS;
  const visible = truncated ? content.slice(0, MAX_CHAT_FILE_TEXT_CHARS) : content;
  return [
    `### ${file.name}`,
    `type: ${file.mediaType || 'application/octet-stream'}`,
    `size: ${file.size} bytes`,
    '',
    '```',
    visible,
    '```',
    truncated ? `\n[已截断，仅包含前 ${MAX_CHAT_FILE_TEXT_CHARS} 个字符]` : '',
  ].filter(Boolean).join('\n');
}

async function normalizeChatAttachments(value: unknown): Promise<{ images: ChatImageInput[]; fileBlocks: string[]; error?: string }> {
  if (!Array.isArray(value)) return { images: [], fileBlocks: [] };
  const imageItems = value.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const raw = item as Record<string, unknown>;
    return raw.type === 'image' && CHAT_IMAGE_MIME_TYPES.has(String(raw.mediaType || '') as ChatImageMimeType);
  });
  const unsupportedImageItems = value.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const raw = item as Record<string, unknown>;
    return raw.type === 'image' && !CHAT_IMAGE_MIME_TYPES.has(String(raw.mediaType || '') as ChatImageMimeType);
  });
  const fileItems = value.filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'file');
  const normalizedImages = normalizeChatImages(imageItems);
  if (normalizedImages.error) return { images: [], fileBlocks: [], error: normalizedImages.error };
  if (fileItems.length > MAX_CHAT_FILES) return { images: [], fileBlocks: [], error: `最多一次发送 ${MAX_CHAT_FILES} 个文件` };

  const fileBlocks: string[] = [];
  for (const item of unsupportedImageItems) {
    const raw = item as Record<string, unknown>;
    const name = normalizeChatFileName(raw.name) || 'image';
    const mediaType = String(raw.mediaType || 'unknown');
    fileBlocks.push([
      `### ${name}`,
      `type: ${mediaType}`,
      '',
      `这个图片附件格式为 ${mediaType}，当前图片通道仅支持 PNG、JPEG、GIF、WebP。请转换格式后可进行视觉分析。`,
    ].join('\n'));
  }
  for (const item of fileItems) {
    const raw = item as Record<string, unknown>;
    const name = normalizeChatFileName(raw.name);
    if (!name || !isSupportedChatFileName(name)) {
      return { images: [], fileBlocks: [], error: `仅支持文本、代码、CSV 和 .xlsx 文件: ${name || 'unknown'}` };
    }
    const data = String(raw.data || '').replace(/^data:[^;]+;base64,/, '');
    const size = Number(raw.size) || base64SizeBytes(data);
    if (size > MAX_CHAT_FILE_BYTES) return { images: [], fileBlocks: [], error: `单个文件不能超过 2MB: ${name}` };
    try {
      fileBlocks.push(await chatFileToPromptBlock({
        name,
        mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : 'application/octet-stream',
        data,
        size,
      }));
    } catch (error) {
      return { images: [], fileBlocks: [], error: (error as Error).message || '文件读取失败' };
    }
  }
  return { images: normalizedImages.images, fileBlocks };
}

function parseChatFileUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  chatFileUpload.array('files', MAX_CHAT_FILES)(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? '单个文件不能超过 2MB'
        : error.code === 'LIMIT_FILE_COUNT'
          ? `最多一次上传 ${MAX_CHAT_FILES} 个文件`
          : '上传文件格式无效';
      res.status(400).json({ error: message });
      return;
    }
    res.status(400).json({ error: (error as Error).message || '上传文件失败' });
  });
}

app.post('/api/chat/files/upload', authMiddleware, parseChatFileUpload, (req: any, res) => {
  const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
  if (!files.length) { res.status(400).json({ error: '请选择要上传的文件' }); return; }
  if (files.length > MAX_CHAT_FILES) { res.status(400).json({ error: `最多一次上传 ${MAX_CHAT_FILES} 个文件` }); return; }

  const attachments = [];
  for (const file of files) {
    const name = normalizeChatFileName(file.originalname);
    if (!name || !isSupportedChatFileName(name)) {
      res.status(400).json({ error: `仅支持文本、代码、CSV、.xls 和 .xlsx 文件: ${name || file.originalname || 'unknown'}` });
      return;
    }
    if (file.size > MAX_CHAT_FILE_BYTES) {
      res.status(400).json({ error: `单个文件不能超过 2MB: ${name}` });
      return;
    }
    attachments.push({
      id: crypto.randomUUID(),
      type: 'file',
      mediaType: file.mimetype || 'application/octet-stream',
      data: file.buffer.toString('base64'),
      name,
      size: file.size,
    });
  }
  res.json({ attachments });
});

app.get('/api/events/health', (_req, res) => res.json({ ok: true }));

app.get('/api/deploy/status/:server', (req, res) => {
  const s = deployStatus.get(req.params.server);
  res.json(s || { status: 'idle', message: '', started: 0 });
});

app.post('/api/events/sources', (req, res) => {
  const { action, source } = req.body as any;
  if (action === 'register' && source) { eventSources.set(source.name, { ...source, enabled: true }); res.json({ ok: true }); }
  else if (action === 'remove' && source) { eventSources.delete(source.name); res.json({ ok: true }); }
  else res.json(Array.from(eventSources.values()));
});

app.post('/api/sessions/:id/events/subscribe', (req, res) => {
  const { sourceName } = req.body as any;
  if (!eventSources.has(sourceName)) { res.status(404).json({ error: 'not found' }); return; }
  if (!sessionSubs.has(req.params.id)) sessionSubs.set(req.params.id, new Set());
  sessionSubs.get(req.params.id)!.add(sourceName);
  res.json({ ok: true });
});

app.get('/api/sessions/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  if (!sessionSSE.has(req.params.id)) sessionSSE.set(req.params.id, new Set());
  sessionSSE.get(req.params.id)!.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId: req.params.id })}\n\n`);
  console.log(`[sse] session ${req.params.id.slice(0,8)} connected (${sessionSSE.get(req.params.id)!.size} clients)`);
  req.on('close', () => {
    sessionSSE.get(req.params.id)?.delete(res);
    console.log(`[sse] session ${req.params.id.slice(0,8)} disconnected`);
  });
});

function pushToSession(sid: string, data: object) {
  const cs = sessionSSE.get(sid); if (!cs) return;
  for (const c of cs) try { c.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

async function startBridge(name: string) {
  const es = eventSources.get(name); if (!es) return;
  try {
    const { default: WS } = await import('ws');
    const connect = () => {
      try {
        const ws = new WS(es.url);
        ws.on('open', () => console.log('[bridge]', name, 'connected'));
        ws.on('message', (raw: Buffer) => {
          try {
            const ev = JSON.parse(raw.toString());
            let count = 0;
            for (const [sid, subs] of sessionSubs) {
              if (subs.has(name)) { pushToSession(sid, { ...ev, source: name }); count++; }
            }
            if (count > 0) console.log(`[bridge] ${name} → ${count} sessions, ev=${ev.type}`);
          } catch {}
        });
        ws.on('close', () => setTimeout(connect, 5000));
        ws.on('error', () => {});
      } catch {}
    };
    connect();
  } catch (e) { console.log('[bridge] ws not available:', (e as Error).message); }
}

// ═══ Deploy ═══
app.post('/api/deploy', async (req, res) => {
  const { server, code, tools: deployTools } = req.body as any;
  if (!server || !code) { res.status(400).json({ error: 'need server and code' }); return; }

  const dir = `/tmp/agentma-mcp-${server}`;
  const file = path.join(dir, 'server.js');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, code);

  // 杀旧进程
  try { const pid = fs.readFileSync(path.join(dir, 'pid'), 'utf-8'); process.kill(Number(pid)); } catch {}

  if (deployTools) fs.writeFileSync('/tmp/agentma_custom_tools.json', JSON.stringify(deployTools));

  // 注册 EventSource
  const firstUrl = deployTools?.find((t: any) => t.endpoint)?.endpoint?.url;
  const wsPort = firstUrl ? Number(new URL(firstUrl).port) + 1 : 3006;
  eventSources.set(server, { name: server, type: 'ws', url: `ws://localhost:${wsPort}`, enabled: true });

  console.log(`[deploy] ${server} async start, ws=:${wsPort}`);
  deployStatus.set(server, { status: 'installing', message: '安装依赖中...', started: Date.now() });
  res.json({ ok: true, status: 'deploying', file });

  // 异步安装 + 启动
  (async () => {
    if (code.includes("require('mineflayer')")) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `mcp-${server}` , version: '1.0.0', private: true }));
      if (!fs.existsSync(path.join(dir, 'node_modules/ws')) || !fs.existsSync(path.join(dir, 'node_modules/mineflayer'))) {
        try {
          await new Promise<void>((resolve, reject) => {
            const c = spawn('npm', ['install', 'mineflayer', 'mineflayer-pathfinder', 'ws'], { cwd: dir, stdio: 'pipe' });
            let out = ''; c.stdout?.on('data', d => { out += d; const pct = (out.match(/added|receive|resolv/g) || []).length; deployStatus.set(server, { status: 'installing', message: `安装中 (${pct} 包)...`, started: Date.now() }); });
            c.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
            c.on('error', reject);
          });
        } catch (e) { deployStatus.set(server, { status: 'install_failed', message: String((e as Error).message), started: Date.now() }); return; }
      }
    }
    deployStatus.set(server, { status: 'starting', message: '启动中...', started: Date.now() });
    const proc = spawn('node', [file], { cwd: dir, detached: true, stdio: 'ignore' });
    proc.unref();
    fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
    console.log(`[deploy] ${server} pid=${proc.pid}`);

    // 等进程稳定后标记在线
    setTimeout(() => {
      deployStatus.set(server, { status: 'online', message: '已启动', started: Date.now() });
      startBridge(server);
    }, 3000);
  })();
});

app.post('/api/chat', authMiddleware, async (req: any, res) => {
  const { prompt, messages: inputMessages, systemPrompt, model, provider, tools: requestTools } = req.body || {};
  const subagents = normalizeSubagents(req.body?.subagents);
  const templateId = typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : '';
  const template = templateId ? getVisibleAgentTemplate(req.auth, templateId) : null;
  if (templateId && !template) { res.status(404).json({ error: 'agent not found' }); return; }
  const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
    ? req.body.sessionId.trim()
    : `chat-${Date.now()}`;
  const resumeSdkSessionId = typeof req.body?.sdkSessionId === 'string' ? req.body.sdkSessionId.trim() : '';
  const sdkCwd = typeof req.body?.sdkCwd === 'string' ? req.body.sdkCwd.trim() : '';
  const enableFileCheckpointing = req.body?.enableFileCheckpointing === true;
  const useKnowledge = req.body?.useKnowledge === true;
  const knowledgeSourceIds = normalizeStringArray(req.body?.knowledgeSourceIds) || [];
  const datasourceIds = normalizeStringArray(req.body?.datasourceIds ?? template?.datasourceIds) || [];
  const skills = normalizeStringArray(req.body?.skills);
  const mcpServers = normalizeStringArray(template?.mcpServers || req.body?.mcpServers);
  const outputSchema = req.body?.outputSchema && typeof req.body.outputSchema === 'object' && !Array.isArray(req.body.outputSchema)
    ? req.body.outputSchema as Record<string, unknown>
    : undefined;

  // Fold multi-turn history into systemPrompt so the model sees prior context.
  // When an SDK transcript id is available, resume that transcript and send
  // only the latest turn to avoid duplicating history.
  let runPrompt: string;
  let promptImages: ChatImageInput[] = [];
  let effectiveSystemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
  if (Array.isArray(inputMessages) && inputMessages.length) {
    const filtered: Array<{ role: string; content: string; images: ChatImageInput[]; fileBlocks: string[] }> = [];
    for (const m of inputMessages) {
      const c = typeof m?.content === 'string' ? m.content : '';
      if (c.includes('"type":"tool_use"') || c.includes('"type":"tool_result"') || c.startsWith('[{')) continue;
      const normalizedAttachments = await normalizeChatAttachments(m?.attachments);
      if (normalizedAttachments.error) { res.status(400).json({ error: normalizedAttachments.error }); return; }
      if (!c.trim() && normalizedAttachments.images.length === 0 && normalizedAttachments.fileBlocks.length === 0) continue;
      filtered.push({
        role: String(m.role || 'user'),
        content: c,
        images: normalizedAttachments.images,
        fileBlocks: normalizedAttachments.fileBlocks,
      });
    }
    if (!filtered.length) { res.status(400).json({ error: 'no usable messages' }); return; }
    const latest = filtered[filtered.length - 1];
    const latestFiles = latest.fileBlocks.length
      ? `\n\n[Uploaded files]\n${latest.fileBlocks.join('\n\n')}`
      : '';
    runPrompt = latest.content.trim()
      || (latest.images.length ? '请分析这些图片。' : '请分析这些文件。');
    runPrompt = `${runPrompt}${latestFiles}`;
    promptImages = latest.role === 'user' ? latest.images : [];
    if (!resumeSdkSessionId && filtered.length > 1) {
      const history = filtered.slice(0, -1).map(m => {
        const imageNote = m.images.length ? `\n[${m.role} sent ${m.images.length} image(s)]` : '';
        const fileNote = m.fileBlocks.length ? `\n[${m.role} sent ${m.fileBlocks.length} file(s)]` : '';
        return `${m.role}: ${m.content}${imageNote}${fileNote}`;
      }).join('\n\n');
      effectiveSystemPrompt = [effectiveSystemPrompt, `[Conversation history]\n${history}`].filter(Boolean).join('\n\n');
    }
  } else if (typeof prompt === 'string' && prompt.trim()) {
    runPrompt = prompt;
  } else {
    res.status(400).json({ error: 'need prompt or messages' }); return;
  }
  const selectedModel = [
    model,
    provider?.ANTHROPIC_MODEL,
  ].find(value => typeof value === 'string' && value.trim())?.trim() || '';
  if (!selectedModel) { res.status(400).json({ error: 'no model configured' }); return; }
  const runtimeProvider = resolveRuntimeProvider(req.auth.tenantId, selectedModel, provider, undefined, req.body?.providerProfiles);
  if (!runtimeProvider.apiKey) { res.status(400).json({ error: 'no ANTHROPIC_AUTH_TOKEN' }); return; }
  const visualPreprocessEnabled = typeof req.body?.visualPreprocessEnabled === 'boolean'
    ? req.body.visualPreprocessEnabled === true
    : template?.visualPreprocessDefault === true;
  const visualPreprocessModel = [
    req.body?.visualPreprocessModel,
    template?.visualPreprocessModel,
  ].find(value => typeof value === 'string' && value.trim())?.trim() || '';
  let visualPreprocess: Parameters<typeof runAgent>[0]['visualPreprocess'] | undefined;
  if (visualPreprocessEnabled && promptImages.length) {
    if (!visualPreprocessModel) { res.status(400).json({ error: '视觉预处理已开启，但未配置视觉识别模型' }); return; }
    const visualRuntimeProvider = resolveRuntimeProvider(req.auth.tenantId, visualPreprocessModel, undefined, undefined, req.body?.providerProfiles);
    if (visualRuntimeProvider.source === 'request') {
      res.status(400).json({ error: `视觉识别模型未在 provider profile 中配置: ${visualPreprocessModel}` });
      return;
    }
    if (!visualRuntimeProvider.apiKey) {
      res.status(400).json({ error: `视觉识别模型 ${visualPreprocessModel} 所属供应商未配置 API Key` });
      return;
    }
    visualPreprocess = {
      enabled: true,
      model: visualPreprocessModel,
      baseUrl: visualRuntimeProvider.baseUrl,
      apiKey: visualRuntimeProvider.apiKey,
    };
  }
  console.log(`[provider-route] chat model=${selectedModel} source=${runtimeProvider.source} baseUrl=${describeBaseUrl(runtimeProvider.baseUrl)}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  cleanupServerRuns();
  const abortController = new AbortController();
  const runId = crypto.randomUUID();
  const ownerSub = getChatOwnerSub(req.auth);
  const run: ServerOwnedRun = {
    id: runId,
    tenantId: req.auth.tenantId,
    ownerSub,
    events: [],
    subscribers: new Set([res]),
    abortController,
    startedAt: Date.now(),
    sessionId,
    sessionDraft: {
      id: sessionId,
      templateId: templateId || String(req.body?.templateId || ''),
      title: typeof req.body?.title === 'string' ? req.body.title : '新对话',
      model: selectedModel,
      visualPreprocessEnabled,
      visualPreprocessModel: visualPreprocessModel || undefined,
      sdkSessionId: resumeSdkSessionId || undefined,
      sdkCwd: sdkCwd || undefined,
      forkedFromSessionId: req.body?.forkedFromSessionId,
      forkedFromTitle: req.body?.forkedFromTitle,
      pinned: req.body?.pinned,
      ownerSub: req.body?.ownerSub,
      collaborationEnabled: req.body?.collaborationEnabled,
      collaborationRole: req.body?.collaborationRole,
      collaborationUpdatedAt: req.body?.collaborationUpdatedAt,
      createdAt: Number(req.body?.createdAt) || Date.now(),
    },
    messagesBeforeAssistant: Array.isArray(inputMessages) ? inputMessages : [],
    assistantDraftId: typeof req.body?.assistantDraftId === 'string' ? req.body.assistantDraftId : crypto.randomUUID(),
    assistantTimestamp: Number(req.body?.assistantTimestamp) || Date.now(),
    thinking: '',
    text: '',
  };
  serverRuns.set(runId, run);
  persistServerRunPendingMessage(run);
  writeSse(res, { type: 'run_started', runId, sessionId });
  req.on('close', () => {
    run.subscribers.delete(res);
  });

  const sessionAllow = new Set<string>();
  const emit = (event: AgentEvent) => {
    if (event.type === 'delta') {
      if (event.thinking) run.thinking += event.text || '';
      else run.text += event.text || '';
    } else if (event.type === 'run_outcome') {
      run.outcome = event.outcome;
      run.outcomeDetail = event.subtype || event.message || run.outcomeDetail;
    } else if (event.type === 'error') {
      run.cachedErrorMessage = event.message;
      run.outcome = run.outcome || 'provider_error';
      run.outcomeDetail = run.outcomeDetail || event.message;
    } else if (event.type === 'result') {
      run.sdkSessionId = event.sdkSessionId;
      run.sdkCwd = event.sdkCwd;
      run.structuredOutput = event.structuredOutput;
      run.runStats = {
        costUsd: event.cost_usd,
        durationMs: event.duration_ms,
        inTok: event.usage?.input_tokens,
        outTok: event.usage?.output_tokens,
      };
      const outcome = run.outcome || mapResultSubtypeToOutcome(event.subtype);
      const finalContent = run.text || event.text || (run.cachedErrorMessage ? `错误: ${run.cachedErrorMessage}` : '');
      persistServerRunFinalMessage(run, finalContent, outcome);
      run.outcome = outcome;
      run.completedAt = Date.now();
    }
    emitServerRun(run, event);
  };
  const requestPermission = createPermissionRequester({ emit, sessionAllow, tenantId: req.auth.tenantId });
  const requestUserQuestion = createAskUserQuestionRequester({ emit, tenantId: req.auth.tenantId });
  const toolsList = Array.isArray(requestTools) ? requestTools.map((t: any) => t?.name).filter(Boolean) : undefined;

  void runAgent({
    prompt: runPrompt,
    promptImages,
    visualPreprocess,
    imageInspectModel: visualPreprocessModel || undefined,
    systemPrompt: effectiveSystemPrompt || undefined,
    model: selectedModel,
    baseUrl: runtimeProvider.baseUrl,
    apiKey: runtimeProvider.apiKey,
    tools: toolsList,
    requestTools: Array.isArray(requestTools) ? requestTools : undefined,
    subagents,
    skills,
    mcpServers,
    cwd: sdkCwd || undefined,
    seedDir: resolveAgentSeedDirForTemplate(req.auth.tenantId, template),
    resumeSdkSessionId: resumeSdkSessionId || undefined,
    enableFileCheckpointing: enableFileCheckpointing || undefined,
    useKnowledge: useKnowledge || knowledgeSourceIds.length > 0,
    knowledgeSourceIds,
    datasourceIds,
    outputFormat: outputSchema ? { type: 'json_schema', schema: outputSchema } : undefined,
    effort: (typeof req.body?.effort === 'string' ? req.body.effort : template?.effort) as EffortLevel | undefined,
    tenantId: req.auth.tenantId,
    sub: req.auth.sub,
    role: req.auth.role,
    emit,
    requestPermission,
    requestUserQuestion,
    abortController,
  }).catch((error) => {
    console.error('[chat-run] failed', runId, (error as Error).message);
  }).finally(() => {
    if (!run.completedAt) {
      const outcome = run.outcome || (abortController.signal.aborted ? 'stopped' : 'provider_error');
      const finalContent = run.text || (run.cachedErrorMessage ? `错误: ${run.cachedErrorMessage}` : '');
      persistServerRunFinalMessage(run, finalContent, outcome);
      run.outcome = outcome;
      run.completedAt = Date.now();
      emitServerRun(run, {
        type: 'result',
        subtype: outcome === 'stopped' ? 'aborted' : 'error',
        text: finalContent,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: Date.now() - run.startedAt,
        cost_usd: 0,
        model: selectedModel,
        sdkSessionId: run.sdkSessionId,
        sdkCwd: run.sdkCwd,
      });
    }
    for (const subscriber of run.subscribers) {
      try { subscriber.end(); } catch {}
    }
    run.subscribers.clear();
  });
});

app.get('/api/chat/runs/:id/events', authMiddleware, (req: any, res) => {
  const run = serverRuns.get(req.params.id);
  if (!run || run.tenantId !== req.auth.tenantId || run.ownerSub !== getChatOwnerSub(req.auth)) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  writeSse(res, { type: 'run_started', runId: run.id, sessionId: run.sessionId });
  for (const event of run.events) writeSse(res, event);
  if (run.completedAt) {
    res.end();
    return;
  }
  run.subscribers.add(res);
  req.on('close', () => {
    run.subscribers.delete(res);
  });
});

app.post('/api/chat/runs/:id/cancel', authMiddleware, (req: any, res) => {
  const run = serverRuns.get(req.params.id);
  if (!run || run.tenantId !== req.auth.tenantId || run.ownerSub !== getChatOwnerSub(req.auth)) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  if (!run.completedAt && !run.abortController.signal.aborted) {
    run.abortController.abort();
  }
  res.json({ ok: true });
});

// 启动时恢复已部署的 MCP 服务器
function recoverDeployedServers() {
  const dirs = fs.readdirSync('/tmp', { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('agentma-mcp-'));
  for (const d of dirs) {
    const name = d.name.replace('agentma-mcp-', '');
    const serverFile = path.join('/tmp', d.name, 'server.js');
    const pidFile = path.join('/tmp', d.name, 'pid');
    if (!fs.existsSync(serverFile)) continue;

    // 读取旧 pid 检查进程是否存活
    let isAlive = false;
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
      try { process.kill(pid, 0); isAlive = true; } catch {}
    } catch {}

    if (!isAlive) {
      // 重启进程
      const proc = spawn('node', [serverFile], { cwd: path.join('/tmp', d.name), detached: true, stdio: 'ignore' });
      proc.unref();
      fs.writeFileSync(pidFile, String(proc.pid));
      console.log(`[recover] ${name} restarted pid=${proc.pid}`);
    }

    // 注册 EventSource
    const code = fs.readFileSync(serverFile, 'utf-8');
    const portMatch = code.match(/\.listen\((\d+)/);
    const wsPort = portMatch ? Number(portMatch[1]) + 1 : 3006;
    eventSources.set(name, { name, type: 'ws', url: `ws://localhost:${wsPort}`, enabled: true });
    console.log(`[recover] ${name} events → ws://localhost:${wsPort}`);
    setTimeout(() => startBridge(name), 2000);
  }
}

const PORT = Number(process.env.PORT || 3001);
// SPA fallback
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/dist')) return next();
  const indexPath = path.join(import.meta.dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else next();
});

// ═══ Account System ═══
function authMiddleware(req: any, res: any, next: any) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const auth = authenticateToken(token);
  if (!auth) { res.status(401).json({ error: '未登录' }); return; }
  req.auth = auth;
  next();
}
function requireAdmin(req: any, res: any, next: any) {
  if (req.auth.role !== 'tenant_admin') { res.status(403).json({ error: '需要管理员权限' }); return; }
  next();
}

function getChatOwnerSub(auth: { sub: string }) {
  return auth.sub;
}

function providerField(provider: any, key: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_MODEL') {
  return typeof provider?.[key] === 'string' ? provider[key].trim() : '';
}

function normalizeRequestProviderProfiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const profile = item as Record<string, unknown>;
    const availableModels = Array.isArray(profile.availableModels)
      ? profile.availableModels.flatMap((model) => typeof model === 'string' && model.trim() ? [model.trim()] : [])
      : [];
    return [{
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : 'request provider',
      ANTHROPIC_AUTH_TOKEN: providerField(profile, 'ANTHROPIC_AUTH_TOKEN'),
      ANTHROPIC_BASE_URL: providerField(profile, 'ANTHROPIC_BASE_URL'),
      availableModels,
      enabled: profile.enabled !== false,
    }];
  });
}

function resolveRequestProviderProfileForModel(model: string, profiles: unknown) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return null;
  return normalizeRequestProviderProfiles(profiles)
    .filter(profile => profile.enabled)
    .find(profile => profile.availableModels.some(candidate => candidate.trim().toLowerCase() === normalizedModel))
    || null;
}

function resolveRuntimeProvider(
  tenantId: string,
  model: string,
  primaryProvider?: any,
  fallbackProvider?: any,
  requestProfiles?: unknown,
) {
  const stored = model ? resolveProviderProfileForModel(tenantId, model) : null;
  const requestProfile = stored ? null : resolveRequestProviderProfileForModel(model, requestProfiles);
  const apiKey = stored?.ANTHROPIC_AUTH_TOKEN
    || requestProfile?.ANTHROPIC_AUTH_TOKEN
    || providerField(primaryProvider, 'ANTHROPIC_AUTH_TOKEN')
    || providerField(fallbackProvider, 'ANTHROPIC_AUTH_TOKEN');
  const baseUrl = stored?.ANTHROPIC_BASE_URL
    || requestProfile?.ANTHROPIC_BASE_URL
    || providerField(primaryProvider, 'ANTHROPIC_BASE_URL')
    || providerField(fallbackProvider, 'ANTHROPIC_BASE_URL');
  return {
    apiKey,
    baseUrl,
    source: stored ? `profile:${stored.name}` : requestProfile ? `requestProfile:${requestProfile.name}` : 'request',
  };
}

function describeBaseUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return baseUrl || '<default>';
  }
}

// ═══ Auth Routes ═══
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password || password.length < 6) { res.status(400).json({ error: '邮箱和密码至少 6 位' }); return; }
  const result = registerUser(name || email.split('@')[0], email, password);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  const token = signJWT({ sub: result.user.id, tenantId: result.tenantId });
  res.json({ token, id: result.user.id, username: result.user.username, email: result.user.email, name: result.user.name, tenantId: result.tenantId, role: result.user.role });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const result = loginUser(email, password);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json({
    token: signJWT({ sub: result.user.id, tenantId: result.user.tenantId }),
    id: result.user.id,
    username: result.user.username,
    email: result.user.email,
    name: result.user.name,
    tenantId: result.user.tenantId,
    role: result.user.role,
  });
});

app.get('/api/auth/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const auth = authenticateToken(token);
  if (!auth) { res.status(401).json({ error: '未登录' }); return; }
  res.json(getMe(auth));
});

// ═══ Tenant Routes ═══
app.get('/api/tenant', authMiddleware, (req: any, res) => {
  const t = getTenantById(req.auth.tenantId);
  if (!t) { res.status(404).json({ error: 'not found' }); return; }
  res.json(t);
});

app.patch('/api/tenant', authMiddleware, requireAdmin, (req: any, res) => {
  const t = updateTenant(req.auth.tenantId, { name: req.body?.name, plan: req.body?.plan });
  if (!t) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'update_tenant', req.auth.sub, 'user', `tenant:${req.auth.tenantId}`);
  res.json(t);
});

// ═══ Users Routes ═══
app.get('/api/users', authMiddleware, (req: any, res) => {
  res.json(listUsers(req.auth.tenantId));
});

app.post('/api/users', authMiddleware, requireAdmin, (req: any, res) => {
  const result = createTenantUser(
    req.auth.tenantId,
    req.body?.name || '',
    req.body?.email || '',
    req.body?.password || '',
    req.body?.role || 'member',
  );
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  audit(req.auth.tenantId, 'create_user', req.auth.sub, 'user', `user:${result.user.email}`, { role: result.user.role });
  res.json(result.user);
});

app.patch('/api/users/:email', authMiddleware, requireAdmin, (req: any, res) => {
  const role = req.body?.role;
  if (!['tenant_admin', 'team_admin', 'member'].includes(role)) { res.status(400).json({ error: 'invalid role' }); return; }
  const user = updateUserRole(req.auth.tenantId, req.params.email, role);
  if (!user) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'update_user_role', req.auth.sub, 'user', `user:${req.params.email}`, { role: user.role });
  res.json(user);
});

app.delete('/api/users/:email', authMiddleware, requireAdmin, (req: any, res) => {
  if (req.params.email === req.auth.email) { res.status(400).json({ error: '不能删除自己' }); return; }
  const ok = deleteUser(req.auth.tenantId, req.params.email);
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'delete_user', req.auth.sub, 'user', `user:${req.params.email}`);
  res.json({ ok: true });
});

// ═══ API Keys Routes ═══
app.get('/api/api-keys', authMiddleware, (req: any, res) => {
  res.json(listApiKeys(req.auth.tenantId));
});

app.post('/api/api-keys', authMiddleware, requireAdmin, (req: any, res) => {
  if (req.auth.authType === 'api_key') { res.status(403).json({ error: 'API Key 无法创建新密钥，请使用密码登录' }); return; }
  const key = createApiKey(req.auth.tenantId, req.auth.email || null, req.body?.name || 'API Key', req.body?.scopes || []);
  res.json({ ...key, rawKey: key.rawKey });
});

app.delete('/api/api-keys/:id', authMiddleware, requireAdmin, (req: any, res) => {
  const ok = revokeApiKey(req.auth.tenantId, req.params.id);
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'revoke_api_key', req.auth.sub, 'user', `apikey:${req.params.id}`);
  res.json({ ok: true });
});

// ═══ Provider Profiles Routes (tenant-shared) ═══
app.get('/api/providers', authMiddleware, requireAdmin, (req: any, res) => {
  res.json(listProviderProfiles(req.auth.tenantId));
});

app.put('/api/providers', authMiddleware, requireAdmin, (req: any, res) => {
  const input = Array.isArray(req.body) ? req.body : req.body?.providers;
  if (!Array.isArray(input)) { res.status(400).json({ error: 'providers must be an array' }); return; }
  const saved = replaceProviderProfiles(req.auth.tenantId, input);
  audit(req.auth.tenantId, 'replace_providers', req.auth.sub, 'user', `providers:${req.auth.tenantId}`, { count: saved.length });
  res.json(saved);
});

function providerModelsEndpoint(baseUrl: string) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const pathName = url.pathname.replace(/\/+$/, '');
    if (/\/v1\/models$/i.test(pathName)) return url.toString();
    url.pathname = pathName.endsWith('/v1') ? `${pathName}/models` : `${pathName}/v1/models`;
    url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

function numericContextWindow(value: unknown) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;
}

function modelContextWindowFromApiItem(item: Record<string, unknown>) {
  const nested = item.capabilities && typeof item.capabilities === 'object'
    ? item.capabilities as Record<string, unknown>
    : {};
  return numericContextWindow(item.max_input_tokens)
    || numericContextWindow(item.context_window)
    || numericContextWindow(item.contextWindow)
    || numericContextWindow(item.context_window_tokens)
    || numericContextWindow(item.input_context_window)
    || numericContextWindow(item.context_length)
    || numericContextWindow(item.max_context_tokens)
    || numericContextWindow(nested.max_input_tokens)
    || numericContextWindow(nested.context_window)
    || numericContextWindow(nested.context_length);
}

function parseProviderModelsPayload(payload: unknown) {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown[] }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown[] }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  const availableModels: string[] = [];
  const modelContextWindows: Record<string, number> = {};
  for (const item of list) {
    if (typeof item === 'string') {
      const model = item.trim();
      if (model && !model.includes('*')) availableModels.push(model);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const model = String(raw.id || raw.model || raw.name || '').trim();
    if (!model || model.includes('*')) continue;
    availableModels.push(model);
    const contextWindow = modelContextWindowFromApiItem(raw);
    if (contextWindow) modelContextWindows[model] = contextWindow;
  }
  return {
    availableModels: Array.from(new Set(availableModels)),
    modelContextWindows,
  };
}

async function discoverProviderModels(profile: ReturnType<typeof listProviderProfiles>[number]) {
  const endpoint = providerModelsEndpoint(profile.ANTHROPIC_BASE_URL);
  if (!endpoint) return { availableModels: [], modelContextWindows: {} as Record<string, number> };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = String(profile.ANTHROPIC_AUTH_TOKEN || '').trim();
    if (token) {
      headers['x-api-key'] = token;
      if (!/\.anthropic\.com$/i.test(new URL(endpoint).hostname)) headers.Authorization = `Bearer ${token}`;
    }
    if (/\.anthropic\.com$/i.test(new URL(endpoint).hostname)) headers['anthropic-version'] = '2023-06-01';
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    if (!response.ok) return { availableModels: [], modelContextWindows: {} as Record<string, number> };
    const payload = await response.json().catch(() => null);
    return parseProviderModelsPayload(payload);
  } catch {
    return { availableModels: [], modelContextWindows: {} as Record<string, number> };
  } finally {
    clearTimeout(timeout);
  }
}

function providerProfileForClient(profile: ReturnType<typeof listProviderProfiles>[number]) {
  return {
    id: profile.id,
    name: profile.name,
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: profile.ANTHROPIC_BASE_URL,
    availableModels: profile.availableModels,
    modelContextWindows: profile.modelContextWindows || {},
    enabled: profile.enabled,
    isDefault: profile.isDefault,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

app.get('/api/provider-models', authMiddleware, async (req: any, res) => {
  const profiles = listProviderProfiles(req.auth.tenantId);
  const enabled = profiles.filter(profile => profile.enabled);
  const usable = enabled.length ? enabled : profiles;
  const discovered = await Promise.all(usable.map(async (profile) => {
    const remote = await discoverProviderModels(profile);
    return {
      ...profile,
      availableModels: Array.from(new Set([...profile.availableModels, ...remote.availableModels])),
      modelContextWindows: {
        ...(profile.modelContextWindows || {}),
        ...remote.modelContextWindows,
      },
    };
  }));
  const values = new Set<string>();
  for (const profile of discovered) {
    for (const model of profile.availableModels) {
      if (model.trim()) values.add(model.trim());
    }
  }
  res.json({
    models: Array.from(values),
    profiles: discovered.map(providerProfileForClient),
  });
});

app.get('/api/internal-tools', authMiddleware, (_req: any, res) => {
  res.json(listInternalTools());
});

app.get('/api/internal-tool-settings', authMiddleware, (req: any, res) => {
  res.json(listInternalToolSettings(req.auth.tenantId));
});

app.put('/api/internal-tool-settings/:toolId', authMiddleware, requireAdmin, (req: any, res) => {
  const toolId = String(req.params.toolId || '').trim();
  const knownToolIds = new Set(listInternalTools().map((item) => item.id));
  if (!knownToolIds.has(toolId)) { res.status(404).json({ error: 'internal tool not found' }); return; }

  const input = req.body?.settings && typeof req.body.settings === 'object' && !Array.isArray(req.body.settings)
    ? req.body.settings as Record<string, unknown>
    : req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
  const settings: Record<string, unknown> = {};
  if (toolId === 'model.request' || toolId === 'image.inspect') {
    const defaultModel = typeof input.defaultModel === 'string' ? input.defaultModel.trim() : '';
    if (defaultModel) {
      const profile = resolveProviderProfileForModel(req.auth.tenantId, defaultModel);
      if (!profile || !profile.enabled) {
        res.status(400).json({ error: `模型未在当前账户中启用或配置: ${defaultModel}` });
        return;
      }
      settings.defaultModel = defaultModel;
    }
  }

  const saved = updateInternalToolSetting(req.auth.tenantId, toolId, settings);
  audit(req.auth.tenantId, 'update_internal_tool_setting', req.auth.sub, 'internal_tool', `internal_tool:${toolId}`, settings);
  res.json(saved);
});

// ═══ Quota Routes ═══
app.get('/api/quota', authMiddleware, (req: any, res) => {
  res.json(getQuota(req.auth.tenantId));
});

app.get('/api/quota/usage', authMiddleware, (req: any, res) => {
  res.json(getQuotaUsageSummary(req.auth.tenantId));
});

app.patch('/api/quota', authMiddleware, requireAdmin, (req: any, res) => {
  const q = updateQuota(req.auth.tenantId, req.body || {});
  audit(req.auth.tenantId, 'update_quota', req.auth.sub, 'user', `quota:${req.auth.tenantId}`, req.body);
  res.json(q);
});

// ═══ Teams Routes ═══
app.post('/api/teams', authMiddleware, (req: any, res) => {
  const team = createTeam(req.auth.tenantId, req.body?.name);
  audit(req.auth.tenantId, 'create_team', req.auth.sub, 'user', `team:${team.id}`);
  res.json(team);
});

app.get('/api/teams', authMiddleware, (req: any, res) => {
  res.json(listTeams(req.auth.tenantId));
});

app.get('/api/teams/:id/members', authMiddleware, (req: any, res) => {
  const members = listTeamMembers(req.auth.tenantId, req.params.id);
  if (!members) { res.status(404).json({ error: 'not found' }); return; }
  res.json(members);
});

app.post('/api/teams/:id/members', authMiddleware, (req: any, res) => {
  const result = addTeamMember(req.auth.tenantId, req.params.id, req.body?.userId, req.body?.role || 'member');
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  audit(req.auth.tenantId, 'add_member', req.auth.sub, 'user', `team:${req.params.id}`, { userId: req.body.userId });
  res.json(result.member);
});

app.delete('/api/teams/:id/members/:userId', authMiddleware, (req: any, res) => {
  const ok = removeTeamMember(req.auth.tenantId, req.params.id, req.params.userId);
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'remove_member', req.auth.sub, 'user', `team:${req.params.id}`);
  res.json({ ok: true });
});

// ═══ Audit Logs Routes ═══
app.get('/api/audit-logs', authMiddleware, (req: any, res) => {
  res.json(listAuditLogs(req.auth.tenantId));
});

// ═══ Hook Rules Routes (tenant-shared) ═══
app.get('/api/hook-rules', authMiddleware, (req: any, res) => {
  res.json(listHookRules(req.auth.tenantId));
});

app.put('/api/hook-rules', authMiddleware, requireAdmin, (req: any, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const saved = replaceHookRules(req.auth.tenantId, list);
  audit(req.auth.tenantId, 'replace_hook_rules', req.auth.sub, 'user', `hooks:${req.auth.tenantId}`, { count: saved.length });
  res.json(saved);
});

app.post('/api/hook-rules/evaluate', authMiddleware, (req: any, res) => {
  const eventName = String(req.body?.eventName || '').trim();
  if (!['PreToolUse', 'PostToolUse', 'Notification'].includes(eventName)) {
    res.status(400).json({ error: 'eventName must be PreToolUse, PostToolUse, or Notification' }); return;
  }
  const input = req.body?.input && typeof req.body.input === 'object' && !Array.isArray(req.body.input)
    ? req.body.input
    : {};
  const decision = evaluateHookRules(req.auth.tenantId, eventName as any, input);
  res.json({
    action: decision?.action || 'none',
    reason: decision?.reason || 'no matching tenant hook rule',
    output: decision?.output || {},
    rule: decision?.rule || null,
  });
});

// ═══ Permission Rules Routes (tenant-shared) ═══
app.get('/api/permission-rules', authMiddleware, (req: any, res) => {
  res.json(listPermissionRules(req.auth.tenantId));
});

app.put('/api/permission-rules', authMiddleware, requireAdmin, (req: any, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const saved = replacePermissionRules(req.auth.tenantId, list);
  audit(req.auth.tenantId, 'replace_permission_rules', req.auth.sub, 'user', `permissions:${req.auth.tenantId}`, { count: saved.length });
  res.json(saved);
});

app.post('/api/permission-rules/evaluate', authMiddleware, (req: any, res) => {
  const toolName = String(req.body?.toolName || '').trim();
  if (!toolName) { res.status(400).json({ error: 'need toolName' }); return; }
  const input = req.body?.input && typeof req.body.input === 'object' && !Array.isArray(req.body.input)
    ? req.body.input
    : {};
  const decision = evaluatePermissionRules(req.auth.tenantId, toolName, input);
  res.json({
    behavior: decision?.behavior || 'ask',
    reason: decision?.reason || 'no matching tenant rule',
    rule: decision?.rule || null,
  });
});

// ═══ Knowledge Sources Routes (tenant-shared) ═══
app.get('/api/knowledge/sources', authMiddleware, (req: any, res) => {
  res.json(listKnowledgeSources(req.auth.tenantId, req.auth.email || req.auth.sub, req.auth.role));
});

app.put('/api/knowledge/sources', authMiddleware, (req: any, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  try {
    const saved = replaceKnowledgeSources(req.auth.tenantId, list, req.auth.email || req.auth.sub, req.auth.role);
    audit(req.auth.tenantId, 'replace_knowledge_sources', req.auth.sub, 'user', `knowledge:${req.auth.tenantId}`, { count: saved.length });
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || '保存知识库失败' });
  }
});

app.post('/api/knowledge/sources/test', authMiddleware, (req: any, res) => {
  const sourcePath = String(req.body?.path || '').trim();
  if (!sourcePath) { res.status(400).json({ error: 'need path' }); return; }
  res.json(testKnowledgeSource(sourcePath));
});

app.post('/api/knowledge/sources/scan', authMiddleware, requireAdmin, (req: any, res) => {
  try {
    const sourcePath = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json(scanKnowledgeSources(sourcePath));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || '扫描知识库失败' });
  }
});

function safeUploadedKnowledgePath(input: string) {
  const normalized = input.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return '';
  return normalized;
}

const MAX_KNOWLEDGE_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024;
const KNOWLEDGE_UPLOAD_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.xls', '.xlsx']);
const EXCEL_UPLOAD_EXTENSIONS = new Set(['.xls', '.xlsx']);
const EXCEL_SIDECAR_EXTENSIONS = new Set(['.xlsx']);
const KNOWLEDGE_UPLOAD_EXTENSION_LABEL = '.md, .markdown, .txt, .csv, .xls, .xlsx';
const MAX_EXCEL_SHEETS = 20;
const MAX_EXCEL_ROWS_PER_SHEET = 2000;
const MAX_EXCEL_COLUMNS = 50;
const knowledgeMultipartUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 500,
    fileSize: MAX_KNOWLEDGE_UPLOAD_TOTAL_BYTES,
    fieldSize: 256 * 1024,
    fields: 1000,
  },
});

function formatUploadBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
}

function knowledgeUploadExtension(relativePath: string) {
  return path.extname(relativePath).toLowerCase();
}

function isSupportedKnowledgeUpload(relativePath: string) {
  return KNOWLEDGE_UPLOAD_EXTENSIONS.has(knowledgeUploadExtension(relativePath));
}

function isExcelKnowledgeUpload(relativePath: string) {
  return EXCEL_UPLOAD_EXTENSIONS.has(knowledgeUploadExtension(relativePath));
}

function shouldCreateExcelSidecar(relativePath: string) {
  return EXCEL_SIDECAR_EXTENSIONS.has(knowledgeUploadExtension(relativePath));
}

function markdownTableCell(value: unknown) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function worksheetToMarkdownTable(rows: unknown[][]) {
  const sliced = rows
    .slice(0, MAX_EXCEL_ROWS_PER_SHEET)
    .map((row) => row.slice(0, MAX_EXCEL_COLUMNS).map(markdownTableCell));
  const width = Math.max(0, ...sliced.map((row) => row.length));
  if (!width) return '';

  const padded = sliced.map((row) => Array.from({ length: width }, (_, index) => row[index] || ''));
  const firstRowHasContent = padded[0]?.some((cell) => cell.trim()) || false;
  const header = firstRowHasContent
    ? padded[0]
    : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const body = firstRowHasContent ? padded.slice(1) : padded;
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

async function xlsxBufferToMarkdown(buffer: Buffer, relativePath: string) {
  let sheets: Array<{ sheet: string; data: unknown[][] }>;
  try {
    const parsed = await readXlsxFile(buffer) as unknown;
    sheets = Array.isArray(parsed) && parsed.every((item) => item && typeof item === 'object' && 'data' in item)
      ? (parsed as Array<{ sheet?: string; data: unknown[][] }>).map((item, index) => ({
        sheet: item.sheet || `Sheet${index + 1}`,
        data: item.data,
      }))
      : [{ sheet: 'Sheet1', data: parsed as unknown[][] }];
  } catch (error) {
    throw new Error(`Excel 文件解析失败: ${relativePath} (${(error as Error).message || 'unknown'})`);
  }

  const parts = [`# ${relativePath}`, '', `源文件: ${relativePath}`];
  for (const { sheet: sheetName, data: rows } of sheets.slice(0, MAX_EXCEL_SHEETS)) {
    const table = worksheetToMarkdownTable(rows);
    if (!table) continue;
    parts.push('', `## ${sheetName}`, '', table);
    if (rows.length > MAX_EXCEL_ROWS_PER_SHEET) {
      parts.push('', `已截断: 仅导出前 ${MAX_EXCEL_ROWS_PER_SHEET} 行。`);
    }
  }
  if (sheets.length > MAX_EXCEL_SHEETS) {
    parts.push('', `已截断: 仅导出前 ${MAX_EXCEL_SHEETS} 个工作表。`);
  }
  if (parts.length === 3) parts.push('', '这个 Excel 文件没有可导出的工作表内容。');
  return Buffer.from(parts.join('\n'), 'utf8');
}

async function excelUploadToMarkdown(file: Express.Multer.File, relativePath: string) {
  return xlsxBufferToMarkdown(file.buffer, relativePath);
}

function uploadedBodyStrings(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return [value];
  return [];
}

const MAX_AGENT_IMPORT_FILES = 300;
const MAX_AGENT_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_IMPORT_TOTAL_BYTES = 50 * 1024 * 1024;
const AGENT_SEED_MARKER = '.agentma-seeded';
const BLOCKED_AGENT_IMPORT_DIRS = new Set(['.git', 'node_modules', '.agent-home']);
const BLOCKED_AGENT_IMPORT_BASENAMES = new Set([AGENT_SEED_MARKER]);
const AGENT_IMPORT_NATIVE_ROOTS = new Set(['CLAUDE.md', 'CLAUDE.local.md', '.claude', '.mcp.json']);
const DEFAULT_IMPORTED_AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];

type AgentImportCategory = 'claude' | 'agent' | 'skill' | 'settings' | 'mcp' | 'file';
type AgentImportReport = {
  templateId: string;
  seedDir: string;
  unpacked: Array<{ path: string; bytes: number; category: AgentImportCategory }>;
  detected: { agents: string[]; skills: string[]; claudeMd: boolean; remoteMcp: string[] };
  disabled: { hooks: string[]; stdioMcp: string[] };
  skipped: Array<{ path: string; reason: string }>;
  notes: string[];
};

const agentImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_AGENT_IMPORT_FILES,
    fileSize: MAX_AGENT_IMPORT_FILE_BYTES,
    fieldSize: 512 * 1024,
    fields: 1000,
  },
});

function parseAgentImportUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  agentImportUpload.array('files', MAX_AGENT_IMPORT_FILES)(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? `单个文件不能超过 ${formatUploadBytes(MAX_AGENT_IMPORT_FILE_BYTES)}`
        : error.code === 'LIMIT_FILE_COUNT'
          ? `单次最多导入 ${MAX_AGENT_IMPORT_FILES} 个文件`
          : '导入文件格式无效';
      res.status(400).json({ error: message });
      return;
    }
    res.status(400).json({ error: (error as Error).message || '导入 Agent 失败' });
  });
}

function safeAgentSeedSegment(value: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return normalized || crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function agentSeedDir(tenantId: string, templateId: string) {
  return path.join(getDataLocation().dataDir, 'agent-seeds', safeAgentSeedSegment(tenantId), safeAgentSeedSegment(templateId));
}

function resolveAgentSeedDirForTemplate(tenantId: string, template: Record<string, unknown> | null | undefined) {
  const templateId = typeof template?.id === 'string' ? template.id.trim() : '';
  if (!templateId || typeof template?.seedDir !== 'string' || !template.seedDir.trim()) return undefined;
  const seedDir = agentSeedDir(tenantId, templateId);
  return fs.existsSync(seedDir) ? seedDir : undefined;
}

function safeUploadedAgentImportPath(input: string) {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:($|\/)/.test(raw) || /[\x00-\x1F\x7F]/.test(raw)) return '';
  const parts = raw.split('/');
  if (parts.some((part) => part === '..')) return '';
  const normalizedParts = parts.filter((part) => part && part !== '.');
  if (!normalizedParts.length) return '';
  if (normalizedParts.some((part) => part.length > 160)) return '';
  const normalized = normalizedParts.join('/');
  if (normalized.length > 1024) return '';
  return normalized;
}

function shouldStripAgentImportRoot(paths: string[]) {
  if (!paths.length) return false;
  const split = paths.map((item) => item.split('/'));
  if (split.some((parts) => parts.length < 2)) return false;
  const first = split[0][0];
  if (!first || AGENT_IMPORT_NATIVE_ROOTS.has(first)) return false;
  if (split.some((parts) => parts[0] !== first)) return false;
  return paths.length > 1 || split.some((parts) => AGENT_IMPORT_NATIVE_ROOTS.has(parts[1]));
}

function stripAgentImportRoot(paths: string[]) {
  return shouldStripAgentImportRoot(paths) ? paths.map((item) => item.split('/').slice(1).join('/')) : paths;
}

function importPathBlockedReason(relativePath: string) {
  const parts = relativePath.split('/');
  const blockedDir = parts.find((part) => BLOCKED_AGENT_IMPORT_DIRS.has(part));
  if (blockedDir) return `blocked dir: ${blockedDir}`;
  const blockedName = parts.find((part) => BLOCKED_AGENT_IMPORT_BASENAMES.has(part));
  if (blockedName) return `blocked path: ${blockedName}`;
  return '';
}

function categorizeAgentImportPath(relativePath: string): AgentImportCategory {
  const lower = relativePath.toLowerCase();
  if (relativePath === 'CLAUDE.md' || relativePath === 'CLAUDE.local.md' || relativePath === '.claude/CLAUDE.md') return 'claude';
  if (/^\.claude\/agents\/[^/]+\.md$/i.test(relativePath)) return 'agent';
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/i.test(relativePath)) return 'skill';
  if (lower === '.claude/settings.json' || lower === '.claude/settings.local.json') return 'settings';
  if (lower === '.mcp.json') return 'mcp';
  return 'file';
}

function addUniqueString(target: string[], value: string) {
  const trimmed = value.trim();
  if (trimmed && !target.includes(trimmed)) target.push(trimmed);
}

function detectImportedAgentName(relativePath: string, content: Buffer) {
  if (!/^\.claude\/agents\/[^/]+\.md$/i.test(relativePath)) return '';
  const rawName = path.basename(relativePath, path.extname(relativePath));
  const frontmatterName = readFrontmatterValue(content.toString('utf8', 0, Math.min(content.length, MAX_SKILL_MD_BYTES)), 'name');
  return (frontmatterName || rawName).trim();
}

function detectImportedSkillName(relativePath: string, content: Buffer) {
  const match = relativePath.match(/^\.claude\/skills\/([^/]+)\/SKILL\.md$/i);
  if (!match) return '';
  const frontmatterName = readFrontmatterValue(content.toString('utf8', 0, Math.min(content.length, MAX_SKILL_MD_BYTES)), 'name');
  return (frontmatterName || match[1]).trim();
}

function extractSettingsHooks(content: Buffer) {
  try {
    const parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
    const hooks = parsed?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
    return Object.keys(hooks).filter(Boolean);
  } catch {
    return [];
  }
}

function sanitizeImportedMcpJson(content: Buffer) {
  const remoteServers: Record<string, unknown> = {};
  const remoteNames: string[] = [];
  const disabledStdio: string[] = [];
  try {
    const parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { buffer: Buffer.from(JSON.stringify({ mcpServers: {} }, null, 2), 'utf8'), remoteNames, disabledStdio };
    }
    for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
      if (!name.trim() || !server || typeof server !== 'object' || Array.isArray(server)) continue;
      const record = server as Record<string, unknown>;
      const hasStdio = typeof record.command === 'string' || Array.isArray(record.args) || record.transport === 'stdio';
      const url = typeof record.url === 'string' ? record.url.trim() : '';
      const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
      const safeServerName = /^[A-Za-z0-9._-]{1,128}$/.test(name);
      const isRemote = Boolean(url && /^https?:\/\//i.test(url) && (!type || ['http', 'sse', 'streamable-http'].includes(type)));
      if (hasStdio || !isRemote || !safeServerName) {
        disabledStdio.push(name);
        continue;
      }
      remoteServers[name] = record;
      remoteNames.push(name);
    }
  } catch {
    return { buffer: Buffer.from(JSON.stringify({ mcpServers: {} }, null, 2), 'utf8'), remoteNames, disabledStdio: ['<invalid .mcp.json>'] };
  }
  return {
    buffer: Buffer.from(JSON.stringify({ mcpServers: remoteServers }, null, 2), 'utf8'),
    remoteNames,
    disabledStdio,
  };
}

function renameImportedSettingsPath(relativePath: string) {
  const lower = relativePath.toLowerCase();
  if (lower === '.claude/settings.json' || lower === '.claude/settings.local.json') return `${relativePath}.imported`;
  return relativePath;
}

function replaceDirectoryAtomic(tmpDir: string, destDir: string) {
  const backupDir = `${destDir}.old-${Date.now()}-${crypto.randomUUID()}`;
  let hasBackup = false;
  try {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    if (fs.existsSync(destDir)) {
      fs.renameSync(destDir, backupDir);
      hasBackup = true;
    }
    fs.renameSync(tmpDir, destDir);
    if (hasBackup) fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    if (hasBackup && fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, destDir); } catch {}
    }
    throw error;
  }
}

function unpackAgentImport(auth: any, templateId: string, files: Express.Multer.File[], relativePathInputs: string[]) {
  const seedDir = agentSeedDir(auth.tenantId, templateId);
  const report: AgentImportReport = {
    templateId,
    seedDir,
    unpacked: [],
    detected: { agents: [], skills: [], claudeMd: false, remoteMcp: [] },
    disabled: { hooks: [], stdioMcp: [] },
    skipped: [],
    notes: [
      '~/.claude(user 级)不会带入,请放到项目级 .claude/。',
      'settings.json/settings.local.json 已重命名为 .imported,避免导入项目的 hooks 在 P4 容器层前自动执行。',
      'stdio 型 MCP 已剥离,仅保留远程 MCP。',
    ],
  };

  const rawPaths = files.map((file, index) => safeUploadedAgentImportPath(relativePathInputs[index] || file.originalname || ''));
  if (rawPaths.some((item) => !item)) throw makeHttpError('导入文件路径无效', 400);
  const normalizedPaths = stripAgentImportRoot(rawPaths);
  const tmpDir = `${seedDir}.tmp-${Date.now()}-${crypto.randomUUID()}`;
  const resolvedTmpDir = path.resolve(tmpDir);
  const seenTargets = new Set<string>();
  let totalBytes = 0;

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const [index, file] of files.entries()) {
      const relativePath = normalizedPaths[index];
      if (!relativePath) throw makeHttpError('导入文件路径无效', 400);
      const blockedReason = importPathBlockedReason(relativePath);
      if (blockedReason) {
        report.skipped.push({ path: relativePath, reason: blockedReason });
        continue;
      }
      if (file.buffer.byteLength > MAX_AGENT_IMPORT_FILE_BYTES) {
        throw makeHttpError(`单个文件不能超过 ${formatUploadBytes(MAX_AGENT_IMPORT_FILE_BYTES)}: ${relativePath}`, 400);
      }
      totalBytes += file.buffer.byteLength;
      if (totalBytes > MAX_AGENT_IMPORT_TOTAL_BYTES) {
        throw makeHttpError(`导入总大小不能超过 ${formatUploadBytes(MAX_AGENT_IMPORT_TOTAL_BYTES)}`, 400);
      }

      let targetRelativePath = renameImportedSettingsPath(relativePath);
      let content = file.buffer;
      const category = categorizeAgentImportPath(relativePath);
      if (category === 'settings') {
        for (const hook of extractSettingsHooks(file.buffer)) addUniqueString(report.disabled.hooks, hook);
      }
      if (category === 'mcp') {
        const sanitized = sanitizeImportedMcpJson(file.buffer);
        content = sanitized.buffer;
        for (const name of sanitized.remoteNames) addUniqueString(report.detected.remoteMcp, name);
        for (const name of sanitized.disabledStdio) addUniqueString(report.disabled.stdioMcp, name);
      }
      if (category === 'agent') addUniqueString(report.detected.agents, detectImportedAgentName(relativePath, file.buffer));
      if (category === 'skill') addUniqueString(report.detected.skills, detectImportedSkillName(relativePath, file.buffer));
      if (category === 'claude') report.detected.claudeMd = true;

      targetRelativePath = safeUploadedAgentImportPath(targetRelativePath);
      if (!targetRelativePath) throw makeHttpError('导入文件路径无效', 400);
      const targetPath = path.resolve(path.join(tmpDir, targetRelativePath));
      if (targetPath !== resolvedTmpDir && !targetPath.startsWith(resolvedTmpDir + path.sep)) {
        throw makeHttpError('导入文件路径越界', 400);
      }
      if (seenTargets.has(targetPath)) throw makeHttpError(`导入文件路径重复: ${targetRelativePath}`, 400);
      seenTargets.add(targetPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content);
      report.unpacked.push({ path: targetRelativePath, bytes: content.byteLength, category });
    }

    if (report.unpacked.length === 0) throw makeHttpError('没有可导入的文件', 400);
    replaceDirectoryAtomic(tmpDir, seedDir);
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }

  report.detected.agents.sort();
  report.detected.skills.sort();
  report.detected.remoteMcp.sort();
  report.disabled.hooks.sort();
  report.disabled.stdioMcp.sort();
  return report;
}

function importedAgentTemplateFromReport(existing: Record<string, unknown> | null, report: AgentImportReport, input: Record<string, unknown>) {
  const now = Date.now();
  const bodyName = typeof input.name === 'string' ? input.name.trim() : '';
  const existingName = typeof existing?.name === 'string' ? existing.name.trim() : '';
  const firstAgent = report.detected.agents[0] || '';
  const name = (bodyName || existingName || firstAgent || 'Imported Agent').slice(0, 80);
  const detectedTools = [
    ...DEFAULT_IMPORTED_AGENT_TOOLS,
    ...(report.detected.skills.length ? ['Skill'] : []),
    ...(report.detected.agents.length ? ['Agent'] : []),
    ...(report.detected.remoteMcp.length ? ['ListMcpResources', 'ReadMcpResource'] : []),
  ];
  const existingTools = Array.isArray(existing?.tools) ? normalizeStringArray(existing.tools) || [] : [];
  const existingSkills = Array.isArray(existing?.skills) ? normalizeStringArray(existing.skills) || [] : [];
  const existingMcp = Array.isArray(existing?.mcpServers) ? normalizeStringArray(existing.mcpServers) || [] : [];

  return normalizeAgentTemplateForApi({
    ...(existing || {}),
    id: report.templateId,
    name,
    description: typeof existing?.description === 'string' && existing.description.trim()
      ? existing.description
      : `从本地 Claude Code 项目导入: ${report.unpacked.length} 个文件`,
    systemPrompt: typeof existing?.systemPrompt === 'string' ? existing.systemPrompt : '',
    model: typeof existing?.model === 'string' ? existing.model : '',
    tools: Array.from(new Set([...existingTools, ...detectedTools])),
    mcpServers: Array.from(new Set([...existingMcp, ...report.detected.remoteMcp])),
    eventSources: Array.isArray(existing?.eventSources) ? existing.eventSources : [],
    skills: Array.from(new Set([...existingSkills, ...report.detected.skills])),
    effort: typeof existing?.effort === 'string' ? existing.effort : 'high',
    maxTurns: Number(existing?.maxTurns) || 50,
    permissionMode: typeof existing?.permissionMode === 'string' ? existing.permissionMode : 'default',
    seedDir: report.seedDir,
    createdAt: Number(existing?.createdAt) || now,
    updatedAt: now,
  });
}

function summarizeAgentImportReport(report: AgentImportReport) {
  return {
    templateId: report.templateId,
    seedDir: report.seedDir,
    unpacked: report.unpacked.length,
    skipped: report.skipped.length,
    agents: report.detected.agents,
    skills: report.detected.skills,
    remoteMcp: report.detected.remoteMcp,
    disabledHooks: report.disabled.hooks,
    disabledStdioMcp: report.disabled.stdioMcp,
  };
}

function parseKnowledgeMultipartUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
  knowledgeMultipartUpload.array('files', 500)(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? `单个文档不能超过 ${formatUploadBytes(MAX_KNOWLEDGE_UPLOAD_TOTAL_BYTES)}`
        : error.code === 'LIMIT_FILE_COUNT'
          ? '单次最多上传 500 个文件'
          : '上传文件格式无效';
      res.status(400).json({ error: message });
      return;
    }
    res.status(400).json({ error: (error as Error).message || '上传知识库失败' });
  });
}

app.post('/api/knowledge/sources/upload', authMiddleware, parseKnowledgeMultipartUpload, async (req: any, res) => {
  try {
    const multipartFiles = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
    const jsonFiles = multipartFiles.length ? [] : (Array.isArray(req.body?.files) ? req.body.files : []);
    const fileCount = multipartFiles.length || jsonFiles.length;
    if (!fileCount) { res.status(400).json({ error: '请选择要上传的文件' }); return; }
    const quota = getQuota(req.auth.tenantId);
    const configuredMaxFiles = req.auth.role === 'tenant_admin'
      ? quota.knowledgeUploadAdminMaxFiles
      : quota.knowledgeUploadMemberMaxFiles;
    const maxFiles = Math.max(1, Math.min(500, Number(configuredMaxFiles) || 1));
    const maxFileBytes = Math.max(1024, Math.min(MAX_KNOWLEDGE_UPLOAD_TOTAL_BYTES, Number(quota.knowledgeUploadMaxFileBytes) || 1024));
    if (fileCount > maxFiles) {
      res.status(400).json({ error: `当前账号单次最多上传 ${maxFiles} 个文件` });
      return;
    }

    const timestamp = Date.now();
    const uploadId = crypto.randomUUID();
    const baseName = String(req.body?.name || '').trim() || `uploaded-${timestamp}`;
    const uploadRoot = path.join(getDataLocation().dataDir, 'knowledge-uploads', req.auth.tenantId, uploadId);
    const resolvedUploadRoot = path.resolve(uploadRoot);
    let totalBytes = 0;
    const preparedFiles: Array<{ target: string; content: Buffer }> = [];
    const seenTargets = new Set<string>();

    const addPreparedFile = (relativePath: string, content: Buffer) => {
      if (!isSupportedKnowledgeUpload(relativePath) && !relativePath.toLowerCase().endsWith('.xlsx.md') && !relativePath.toLowerCase().endsWith('.xls.md')) {
        throw new Error(`仅支持上传 ${KNOWLEDGE_UPLOAD_EXTENSION_LABEL}: ${relativePath}`);
      }
      if (content.byteLength > maxFileBytes) {
        throw new Error(`单个文档不能超过 ${formatUploadBytes(maxFileBytes)}: ${relativePath}`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_KNOWLEDGE_UPLOAD_TOTAL_BYTES) throw new Error('单次上传总大小不能超过 20MB');
      const target = path.join(uploadRoot, relativePath);
      const resolvedTarget = path.resolve(target);
      if (!resolvedTarget.startsWith(resolvedUploadRoot + path.sep)) throw new Error('上传文件路径越界');
      if (seenTargets.has(resolvedTarget)) throw new Error(`上传文件路径重复: ${relativePath}`);
      seenTargets.add(resolvedTarget);
      preparedFiles.push({ target: resolvedTarget, content });
    };

    const relativePaths = uploadedBodyStrings(req.body?.relativePaths);
    for (const [index, file] of multipartFiles.entries()) {
      const relativePath = safeUploadedKnowledgePath(relativePaths[index] || file.originalname || '');
      if (!relativePath) { res.status(400).json({ error: '上传文件路径无效' }); return; }
      if (!isSupportedKnowledgeUpload(relativePath)) {
        res.status(400).json({ error: `仅支持上传 ${KNOWLEDGE_UPLOAD_EXTENSION_LABEL}: ${relativePath}` });
        return;
      }
      addPreparedFile(relativePath, file.buffer);
      if (shouldCreateExcelSidecar(relativePath)) {
        addPreparedFile(`${relativePath}.md`, await excelUploadToMarkdown(file, relativePath));
      }
    }

    for (const item of jsonFiles) {
      const relativePath = safeUploadedKnowledgePath(String(item?.relativePath || item?.name || ''));
      const content = typeof item?.content === 'string' ? item.content : '';
      if (!relativePath) { res.status(400).json({ error: '上传文件路径无效' }); return; }
      if (!isSupportedKnowledgeUpload(relativePath) || isExcelKnowledgeUpload(relativePath)) {
        res.status(400).json({ error: `旧版 JSON 上传仅支持文本文件，请使用页面真实上传 ${KNOWLEDGE_UPLOAD_EXTENSION_LABEL}: ${relativePath}` });
        return;
      }
      addPreparedFile(relativePath, Buffer.from(content, 'utf8'));
    }

    fs.mkdirSync(uploadRoot, { recursive: true });
    for (const file of preparedFiles) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      fs.writeFileSync(file.target, file.content);
    }

    const actorEmail = req.auth.email || req.auth.sub;
    const current = listKnowledgeSources(req.auth.tenantId, actorEmail, req.auth.role)
      .filter((source) => req.auth.role === 'tenant_admin' || source.createdBy === actorEmail);
    const saved = replaceKnowledgeSources(req.auth.tenantId, [
      ...current,
      { name: baseName.slice(0, 80), path: uploadRoot, enabled: true, readOnly: true, createdBy: actorEmail },
    ], actorEmail, req.auth.role);
    audit(req.auth.tenantId, 'upload_knowledge_source', req.auth.sub, 'user', `knowledge:${req.auth.tenantId}`, { count: fileCount, path: uploadRoot });
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || '上传知识库失败' });
  }
});

app.get('/api/knowledge/sources/scan', authMiddleware, requireAdmin, (req: any, res) => {
  try {
    const sourcePath = typeof req.query?.path === 'string' ? req.query.path : '';
    res.json(scanKnowledgeSources(sourcePath));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || '扫描知识库失败' });
  }
});

app.post('/api/knowledge/workspace/scan', authMiddleware, (req: any, res) => {
  try {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    if (!conversationId.trim()) { res.status(400).json({ error: 'need conversationId' }); return; }
    res.json({ wikis: scanWorkspaceWikisFromConversation(req.auth, conversationId) });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '扫描 workspace wiki 失败' });
  }
});

app.post('/api/knowledge/workspace/import', authMiddleware, (req: any, res) => {
  try {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    const inputPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!conversationId.trim()) { res.status(400).json({ error: 'need conversationId' }); return; }
    const result = importWorkspaceWikiFromConversation(req.auth, conversationId, inputPath, name);
    audit(req.auth.tenantId, 'import_workspace_wiki', req.auth.sub, 'knowledge', result.importedPath, {
      conversationId,
      sourceId: result.source?.id,
      sourceName: result.source?.name,
      sourcePath: result.candidate.path,
      importStats: result.importStats,
    });
    res.json(result);
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '同步 workspace wiki 失败' });
  }
});

const KNOWLEDGE_GRAPH_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const KNOWLEDGE_GRAPH_BLOCKED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);
const MAX_KNOWLEDGE_GRAPH_FILES = 500;
const MAX_KNOWLEDGE_GRAPH_ENTRIES = 16000;
const MAX_KNOWLEDGE_GRAPH_FILE_BYTES = 512 * 1024;
const KNOWLEDGE_PREVIEW_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv']);
const MAX_KNOWLEDGE_PREVIEW_BYTES = 192 * 1024;

type KnowledgeGraphNode = {
  id: string;
  label: string;
  path?: string;
  kind: 'file' | 'missing';
  inbound: number;
  outbound: number;
  sizeBytes?: number;
};

type KnowledgeGraphEdge = {
  source: string;
  target: string;
  count: number;
};

function graphRelativePath(root: string, fullPath: string) {
  return path.relative(root, fullPath).split(path.sep).join('/');
}

function stripMarkdownExtension(value: string) {
  return value.replace(/\.(md|markdown)$/i, '');
}

function graphKey(value: string) {
  return stripMarkdownExtension(value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim()
    .toLowerCase();
}

function graphLabelFromPath(relativePath: string) {
  const base = stripMarkdownExtension(path.posix.basename(relativePath.replace(/\\/g, '/')));
  return base || relativePath || '未命名';
}

function safeDecodeGraphTarget(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectGraphMarkdownFiles(root: string) {
  const files: Array<{ path: string; relativePath: string; sizeBytes: number }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scannedEntries = 0;
  let truncated = false;

  while (stack.length && scannedEntries < MAX_KNOWLEDGE_GRAPH_ENTRIES && files.length < MAX_KNOWLEDGE_GRAPH_FILES) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries >= MAX_KNOWLEDGE_GRAPH_ENTRIES || files.length >= MAX_KNOWLEDGE_GRAPH_FILES) {
        truncated = true;
        break;
      }
      if (entry.isDirectory()) {
        if (current.depth >= 8 || entry.name.startsWith('.') || KNOWLEDGE_GRAPH_BLOCKED_DIRS.has(entry.name)) continue;
        stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !KNOWLEDGE_GRAPH_MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const fullPath = path.join(current.dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_KNOWLEDGE_GRAPH_FILE_BYTES) continue;
      files.push({ path: fullPath, relativePath: graphRelativePath(root, fullPath), sizeBytes: stat.size });
    }
  }

  return { files, truncated };
}

function firstMarkdownHeading(content: string) {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]
    ?.replace(/[#*_`[\]]/g, '')
    .trim()
    .slice(0, 80);
}

function markdownLinkTargets(content: string) {
  const targets: string[] = [];
  const wikiRe = /!?\[\[([^\]\n]+)\]\]/g;
  for (const match of content.matchAll(wikiRe)) {
    const raw = String(match[1] || '').split('|')[0].split('#')[0].trim();
    if (raw) targets.push(raw);
  }

  const markdownRe = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of content.matchAll(markdownRe)) {
    let raw = String(match[1] || '').trim().replace(/^<|>$/g, '');
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    raw = raw.split('#')[0].split('?')[0].trim();
    if (raw) targets.push(raw);
  }
  return targets;
}

function graphTargetKeys(rawTarget: string, fromRelativePath: string) {
  const decoded = safeDecodeGraphTarget(rawTarget).replace(/\\/g, '/').trim();
  if (!decoded || decoded.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return [];
  const cleaned = stripMarkdownExtension(decoded);
  const fromDir = path.posix.dirname(fromRelativePath.replace(/\\/g, '/'));
  const candidates = [cleaned];
  if (cleaned.startsWith('.') || cleaned.includes('/')) {
    candidates.push(path.posix.normalize(path.posix.join(fromDir, cleaned)));
  } else if (fromDir && fromDir !== '.') {
    candidates.push(path.posix.normalize(path.posix.join(fromDir, cleaned)));
  }
  return Array.from(new Set(candidates.map(graphKey).filter(Boolean)));
}

function buildNativeKnowledgeGraph(root: string, source: { id: string; name: string }) {
  const collected = collectGraphMarkdownFiles(root);
  const nodes = new Map<string, KnowledgeGraphNode>();
  const aliases = new Map<string, string>();
  const contents = new Map<string, string>();

  for (const file of collected.files) {
    let content = '';
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    contents.set(file.relativePath, content);
    const heading = firstMarkdownHeading(content);
    const label = heading || graphLabelFromPath(file.relativePath);
    nodes.set(file.relativePath, {
      id: file.relativePath,
      label,
      path: file.relativePath,
      kind: 'file',
      inbound: 0,
      outbound: 0,
      sizeBytes: file.sizeBytes,
    });

    const noExt = stripMarkdownExtension(file.relativePath);
    const base = stripMarkdownExtension(path.posix.basename(file.relativePath));
    for (const alias of [file.relativePath, noExt, base, heading || '']) {
      const key = graphKey(alias);
      if (key && !aliases.has(key)) aliases.set(key, file.relativePath);
    }
  }

  const edges = new Map<string, KnowledgeGraphEdge>();
  for (const file of collected.files) {
    const content = contents.get(file.relativePath);
    if (!content) continue;
    const sourceNode = nodes.get(file.relativePath);
    if (!sourceNode) continue;
    for (const rawTarget of markdownLinkTargets(content)) {
      const targetKeys = graphTargetKeys(rawTarget, file.relativePath);
      if (!targetKeys.length) continue;
      let targetId = '';
      for (const key of targetKeys) {
        targetId = aliases.get(key) || '';
        if (targetId) break;
      }
      if (!targetId) {
        const missingKey = targetKeys[0];
        targetId = `missing:${missingKey}`;
        if (!nodes.has(targetId)) {
          const label = graphLabelFromPath(rawTarget);
          nodes.set(targetId, { id: targetId, label, kind: 'missing', inbound: 0, outbound: 0 });
        }
      }
      if (targetId === file.relativePath) continue;
      const edgeId = `${file.relativePath}\u0000${targetId}`;
      const existing = edges.get(edgeId);
      if (existing) {
        existing.count += 1;
      } else {
        edges.set(edgeId, { source: file.relativePath, target: targetId, count: 1 });
      }
      sourceNode.outbound += 1;
      const targetNode = nodes.get(targetId);
      if (targetNode) targetNode.inbound += 1;
    }
  }

  const nodeList = Array.from(nodes.values())
    .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound) || a.label.localeCompare(b.label));
  const edgeList = Array.from(edges.values())
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return {
    source: { id: source.id, name: source.name },
    nodes: nodeList,
    edges: edgeList,
    stats: {
      files: collected.files.length,
      nodes: nodeList.length,
      edges: edgeList.length,
      missing: nodeList.filter((node) => node.kind === 'missing').length,
      truncated: collected.truncated,
    },
  };
}

function resolveKnowledgeSourceForRequest(req: any) {
  return listKnowledgeSources(req.auth.tenantId, req.auth.email || req.auth.sub, req.auth.role)
    .find((item) => item.id === req.params.id);
}

function resolvedKnowledgeVaultPath(sourcePath: string) {
  const vaultPath = path.resolve(sourcePath);
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw Object.assign(new Error('知识库目录不存在或不可读'), { status: 400 });
  }
  return fs.realpathSync.native(vaultPath);
}

function readKnowledgePreviewFile(vaultPath: string, inputPath: string) {
  const cleanRelativePath = String(inputPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanRelativePath || cleanRelativePath.split('/').includes('..')) {
    throw Object.assign(new Error('文件路径无效'), { status: 400 });
  }
  if (!KNOWLEDGE_PREVIEW_FILE_EXTENSIONS.has(path.extname(cleanRelativePath).toLowerCase())) {
    throw Object.assign(new Error('仅支持预览 markdown、文本和 CSV 文件'), { status: 400 });
  }

  const targetPath = path.resolve(vaultPath, cleanRelativePath);
  let realTarget: string;
  try {
    realTarget = fs.realpathSync.native(targetPath);
  } catch {
    throw Object.assign(new Error('文件不存在'), { status: 404 });
  }
  const relative = path.relative(vaultPath, realTarget);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('文件路径越界'), { status: 400 });
  }

  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw Object.assign(new Error('路径不是文件'), { status: 400 });
  const bytesToRead = Math.min(stat.size, MAX_KNOWLEDGE_PREVIEW_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(realTarget, 'r');
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: graphRelativePath(vaultPath, realTarget),
    name: path.basename(realTarget),
    sizeBytes: stat.size,
    truncated: stat.size > MAX_KNOWLEDGE_PREVIEW_BYTES,
    content: buffer.toString('utf8'),
  };
}

app.post('/api/knowledge/sources/:id/graph', authMiddleware, async (req: any, res) => {
  try {
    const source = resolveKnowledgeSourceForRequest(req);
    if (!source) { res.status(404).json({ error: 'knowledge source not found' }); return; }
    const vaultPath = resolvedKnowledgeVaultPath(source.path);
    const graph = buildNativeKnowledgeGraph(vaultPath, { id: source.id, name: source.name });
    const serviceUrl = String(process.env.AGENTMA_OBSIDIAN_SERVICE_URL || '').trim();
    if (!serviceUrl) {
      res.json({ ok: true, mode: 'native', graph });
      return;
    }
    try {
      const endpoint = new URL('open-graph', serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath, sourceId: source.id, sourceName: source.name }),
      });
      const text = await response.text();
      let body: unknown = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!response.ok) {
        const message = body && typeof body === 'object' && 'error' in body
          ? String((body as Record<string, unknown>).error || 'Obsidian service 调用失败')
          : `Obsidian service HTTP ${response.status}`;
        res.json({ ok: true, mode: 'native', graph, warning: message, service: body });
        return;
      }
      res.json({ ok: true, mode: 'obsidian', service: body, graph });
    } catch (serviceError) {
      res.json({ ok: true, mode: 'native', graph, warning: (serviceError as Error).message || 'Obsidian service 调用失败' });
    }
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || '打开 Obsidian 图谱失败' });
  }
});

app.post('/api/knowledge/sources/:id/file-preview', authMiddleware, (req: any, res) => {
  try {
    const source = resolveKnowledgeSourceForRequest(req);
    if (!source) { res.status(404).json({ error: 'knowledge source not found' }); return; }
    const vaultPath = resolvedKnowledgeVaultPath(source.path);
    const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json({ ok: true, file: readKnowledgePreviewFile(vaultPath, filePath) });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '读取知识库文件失败' });
  }
});

// ═══ Skills Routes ═══
app.get('/api/skills/public', authMiddleware, (_req: any, res) => {
  try {
    res.json(listPublicSkills().map(toPublicSkillResponse));
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '读取公共技能失败' });
  }
});

app.get('/api/skills/public/:id', authMiddleware, (req: any, res) => {
  try {
    const publicSkill = getPublicSkill(String(req.params.id || ''));
    if (!publicSkill) {
      res.status(404).json({ error: '公共技能不存在' });
      return;
    }
    res.json(toPublicSkillResponse(publicSkill));
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '读取公共技能失败' });
  }
});

app.post('/api/skills/public/:id/learn', authMiddleware, (req: any, res) => {
  try {
    const skill = learnPublicSkillIntoBackpack(req.auth, String(req.params.id || ''), req.body || {});
    audit(req.auth.tenantId, 'learn_public_skill', req.auth.sub, 'skill', skill.path, {
      name: skill.name,
      publicSkillId: skill.learnedFromPublicSkillId,
      publicRevision: skill.learnedFromPublicRevision,
      installedPath: skill.installedPath,
    });
    res.json(skill);
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '学习公共技能失败' });
  }
});

app.post('/api/skills/public', authMiddleware, requireAdmin, (req: any, res) => {
  try {
    const result = publishPublicSkillFromBackpack(req.auth, req.body || {});
    audit(req.auth.tenantId, 'publish_public_skill', req.auth.sub, 'skill', `public-skill:${result.publicSkill.id}`, {
      name: result.publicSkill.name,
      slug: result.publicSkill.slug,
      revision: result.publicSkill.revision,
      sourcePath: result.sourcePath,
      publishStats: result.publishStats,
    });
    res.json(toPublicSkillResponse(result.publicSkill));
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '发布公共技能失败' });
  }
});

app.patch('/api/skills/public/:id', authMiddleware, requireAdmin, (req: any, res) => {
  try {
    const result = updatePublicSkillFromBackpack(req.auth, String(req.params.id || ''), req.body || {});
    audit(req.auth.tenantId, 'update_public_skill', req.auth.sub, 'skill', `public-skill:${result.publicSkill.id}`, {
      name: result.publicSkill.name,
      slug: result.publicSkill.slug,
      revision: result.publicSkill.revision,
      sourcePath: result.sourcePath,
      publishStats: result.publishStats,
    });
    res.json(toPublicSkillResponse(result.publicSkill));
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '更新公共技能失败' });
  }
});

app.post('/api/skills/scan-local', authMiddleware, (req: any, res) => {
  try {
    const inputPath = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json({ skills: scanLocalSkills(inputPath) });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '扫描失败' });
  }
});

app.post('/api/skills/import-local', authMiddleware, (req: any, res) => {
  try {
    const inputPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const { skillFile, skillDir } = resolveLocalSkillPath(inputPath);
    const skill = createLocalSkillInfo(skillFile, skillDir);
    audit(req.auth.tenantId, 'import_local_skill', req.auth.sub, 'skill', skill.path, { name: skill.name });
    res.json(skill);
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '导入失败' });
  }
});

app.post('/api/skills/workspace/scan', authMiddleware, (req: any, res) => {
  try {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    if (conversationId.trim()) {
      res.json({ skills: scanWorkspaceSkillsFromConversation(req.auth, conversationId) });
      return;
    }
    const inputPath = typeof req.body?.path === 'string' ? req.body.path : '';
    res.json({ skills: scanWorkspaceSkills(inputPath) });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '扫描失败' });
  }
});

app.post('/api/skills/workspace/install', authMiddleware, (req: any, res) => {
  try {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    const skillName = typeof req.body?.name === 'string' ? req.body.name : '';
    const inputPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const overwrite = req.body?.overwrite === true;
    const skill = conversationId.trim()
      ? installWorkspaceSkillFromConversation(req.auth, conversationId, skillName, { overwrite })
      : installWorkspaceSkill(inputPath, WORKSPACE_ROOT, { overwrite });
    audit(req.auth.tenantId, 'install_workspace_skill', req.auth.sub, 'skill', skill.path, {
      name: skill.name,
      conversationId: conversationId.trim() || undefined,
      sourcePath: skill.sourcePath,
      installedPath: skill.installedPath,
      installStats: skill.installStats,
      overwrite,
      overwrote: skill.overwrote,
    });
    res.json(skill);
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '安装失败' });
  }
});

// ═══ Agent Templates Routes (personal + published) ═══
app.get('/api/agents', authMiddleware, (req: any, res) => {
  res.json(listVisibleAgentTemplates(req.auth));
});

app.post('/api/agents/import', authMiddleware, parseAgentImportUpload, (req: any, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
    if (!files.length) { res.status(400).json({ error: '请选择要导入的项目目录' }); return; }

    const currentTemplates = listVisibleAgentTemplates(req.auth);
    const mode = String(req.body?.mode || 'new').trim();
    const mergeTargetId = mode.startsWith('merge:')
      ? mode.slice('merge:'.length).trim()
      : mode === 'merge'
        ? String(req.body?.templateId || '').trim()
        : '';
    const existing = mergeTargetId
      ? currentTemplates.find((template) => String(template.id || '') === mergeTargetId)
      : null;
    if (mergeTargetId && !existing) { res.status(404).json({ error: '目标 Agent 模板不存在' }); return; }

    const templateId = mergeTargetId || crypto.randomUUID();
    const relativePaths = uploadedBodyStrings(req.body?.relativePaths);
    const report = unpackAgentImport(req.auth, templateId, files, relativePaths);
    const template = importedAgentTemplateFromReport(existing || null, report, req.body || {});
    const nextTemplates = mergeTargetId
      ? currentTemplates.map((item) => String(item.id || '') === templateId ? template : item)
      : [template, ...currentTemplates.filter((item) => String(item.id || '') !== templateId)];
    const saved = replaceAgentTemplates(req.auth.tenantId, nextTemplates, agentTemplateActor(req.auth), req.auth.role).map(normalizeAgentTemplateForApi);
    const savedTemplate = saved.find((item) => String(item.id || '') === templateId) || template;
    audit(req.auth.tenantId, 'import_agent', req.auth.sub, 'agent', templateId, summarizeAgentImportReport(report));
    res.json({ template: savedTemplate, report });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 400).json({ error: err.message || '导入 Agent 失败' });
  }
});

app.get('/api/agents/:id/claude-md', authMiddleware, (req: any, res) => {
  const agentId = String(req.params.id || '').trim();
  const agent = getVisibleAgentTemplate(req.auth, agentId);
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }

  const latestSession = getLatestAgentRuntimeSession(req.auth.tenantId, getChatOwnerSub(req.auth), agentId);
  const seedDir = latestSession ? undefined : resolveAgentSeedDirForTemplate(req.auth.tenantId, agent);
  const cwd = latestSession?.sdkCwd || seedDir || path.join(os.tmpdir(), `agentma-run-${req.auth.tenantId}-{new-session}`);
  const files = buildClaudeMdPreviewFiles(cwd);
  const effectiveContent = buildEffectiveClaudeMdPreview(files);
  const cwdExists = fs.existsSync(cwd);

  res.json({
    agentId,
    agentName: typeof agent.name === 'string' ? agent.name : agentId,
    cwd,
    cwdExists,
    cwdSource: latestSession ? 'latest_session' : seedDir ? 'template_seed' : 'new_session',
    latestSession: latestSession ? {
      id: latestSession.id,
      title: latestSession.title,
      updatedAt: latestSession.updatedAt,
    } : null,
    settingSources: ['project', 'local'],
    files,
    loadedFiles: files.filter((file) => file.exists && typeof file.content === 'string').map((file) => file.path),
    effectiveContent,
    generatedAt: Date.now(),
    notes: [
      '运行时显式传 settingSources=[project,local]（不含 user），SDK 只从租户 workspace 的项目级/本地级配置加载文件系统说明，不读宿主 ~/.claude。',
      latestSession
        ? '预览使用该 Agent 最近一次可访问会话的 sdkCwd。'
        : seedDir
          ? '该 Agent 尚无带 sdkCwd 的会话；预览使用模板 seed 仓，新会话首跑会复制这些文件到临时 cwd。'
          : '该 Agent 尚无带 sdkCwd 的会话；新会话会创建临时空 cwd，项目级 CLAUDE.md 通常不存在。',
      typeof agent.systemPrompt === 'string' && agent.systemPrompt.trim()
        ? 'Agent 模板的 systemPrompt 会作为独立运行时参数传入，不属于 CLAUDE.md 文件内容。'
        : '',
    ].filter(Boolean),
  });
});

app.put('/api/agents', authMiddleware, (req: any, res) => {
  const list = Array.isArray(req.body) ? req.body.map(normalizeAgentTemplateForApi) : [];
  const actor = agentTemplateActor(req.auth);
  const previous = listAgentTemplates(req.auth.tenantId).map(normalizeAgentTemplateForApi);
  const saved = replaceAgentTemplates(req.auth.tenantId, list, actor, req.auth.role);
  const allAfterSave = listAgentTemplates(req.auth.tenantId).map(normalizeAgentTemplateForApi);
  const savedIds = new Set(allAfterSave.map((template) => String((template as Record<string, unknown>).id || '')));
  for (const template of previous) {
    const templateId = String(template.id || '');
    if (!templateId || savedIds.has(templateId) || !canManageAgentTemplate(req.auth, template) || typeof template.seedDir !== 'string') continue;
    fs.rmSync(agentSeedDir(req.auth.tenantId, templateId), { recursive: true, force: true });
  }
  audit(req.auth.tenantId, 'replace_agents', req.auth.sub, 'user', `agents:${req.auth.tenantId}`, { count: saved.length });
  res.json(saved.map(normalizeAgentTemplateForApi));
});

// ═══ Visual Artifacts Routes ═══
app.get('/api/visuals/file', authMiddleware, (req: any, res) => {
  try {
    const cid = typeof req.query?.cid === 'string' ? req.query.cid : '';
    const relPath = typeof req.query?.path === 'string' ? req.query.path : '';
    const result = readWorkspaceVisual(req.auth, cid, relPath);
    res.json({ ...result, title: extractVisualTitle(result.html, result.format, result.sourceSlug) });
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '读取临时可视化失败' });
  }
});

app.post('/api/visuals', authMiddleware, (req: any, res) => {
  try {
    const cid = typeof req.body?.cid === 'string' ? req.body.cid : '';
    const relPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const explicitTitle = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : undefined;
    const { html, format, sourceSlug } = readWorkspaceVisual(req.auth, cid, relPath);
    if (Buffer.byteLength(html) > MAX_VISUAL_BYTES) throw makeHttpError('文件过大', 413);
    const result = createVisual(req.auth.tenantId, getChatOwnerSub(req.auth), {
      title: explicitTitle || extractVisualTitle(html, format, sourceSlug),
      html,
      sourceSlug,
    });
    res.json(result);
  } catch (error) {
    const err = error as Error & { status?: number };
    res.status(err.status || 500).json({ error: err.message || '保存可视化失败' });
  }
});

app.get('/api/visuals', authMiddleware, (req: any, res) => {
  res.json(listVisuals(req.auth.tenantId, getChatOwnerSub(req.auth)));
});

app.get('/api/visuals/:id', authMiddleware, (req: any, res) => {
  const visual = getVisual(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id);
  if (!visual) { res.status(404).json({ error: 'not found' }); return; }
  res.json({
    id: visual.id,
    title: visual.title,
    html: visual.html,
    format: visualFormatFromPath(visual.sourceSlug || ''),
    sourceSlug: visual.sourceSlug,
    createdAt: visual.createdAt,
  });
});

app.delete('/api/visuals/:id', authMiddleware, (req: any, res) => {
  deleteVisual(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id);
  res.json({ ok: true });
});

// ═══ 数据源(ChatBI 只读查询)═══
const datasourceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_DATASOURCE_UPLOAD_BYTES, fieldSize: 256 * 1024 },
});

function parseDatasourceUpload(req: any, res: any, next: any) {
  datasourceUpload.single('file')(req, res, (error: unknown) => {
    if (!error) { next(); return; }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: `数据源文件不能超过 ${Math.round(MAX_DATASOURCE_UPLOAD_BYTES / 1024 / 1024)}MB` });
      return;
    }
    res.status(400).json({ error: (error as Error).message || '上传数据源失败' });
  });
}

// path 是服务端内部位置,绝不回给前端。
function datasourceToApi(source: {
  id: string; name: string; originalFilename?: string; format: string; sizeBytes: number;
  tables: unknown; createdBy?: string; enabled: boolean; createdAt: number; updatedAt: number;
}) {
  return {
    id: source.id,
    name: source.name,
    originalFilename: source.originalFilename,
    format: source.format,
    sizeBytes: source.sizeBytes,
    tables: source.tables,
    createdBy: source.createdBy,
    enabled: source.enabled,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

app.post('/api/datasources/upload', authMiddleware, parseDatasourceUpload, async (req: any, res) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file || !file.buffer?.length) { res.status(400).json({ error: '请选择要上传的数据文件' }); return; }
    const originalName = String(file.originalname || '').trim();
    if (!datasourceUploadFormat(originalName)) {
      res.status(400).json({ error: `仅支持上传 ${DATASOURCE_UPLOAD_EXTENSIONS.join(' / ')} 文件` });
      return;
    }
    const name = String(req.body?.name || '').trim() || path.basename(originalName, path.extname(originalName));
    const destDir = path.join(getDataLocation().dataDir, 'datasources', req.auth.tenantId, crypto.randomUUID());
    const imported = await importDatasourceUpload(originalName, file.buffer, destDir);
    const created = createDatasource(req.auth.tenantId, {
      name,
      path: imported.dbPath,
      originalFilename: originalName,
      format: imported.format,
      sizeBytes: file.buffer.length,
      tables: imported.tables,
      createdBy: req.auth.email || req.auth.sub,
    });
    audit(req.auth.tenantId, 'upload_datasource', req.auth.sub, 'user', `datasource:${created.id}`, {
      format: imported.format,
      sizeBytes: file.buffer.length,
      tables: imported.tables.length,
    });
    res.json(datasourceToApi(created));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || '上传数据源失败' });
  }
});

app.get('/api/datasources', authMiddleware, (req: any, res) => {
  res.json(listDatasources(req.auth.tenantId).map(datasourceToApi));
});

// 页面「试查询」/ smoke 用;与 agent 走的 MCP 工具共用同一套只读校验。
app.post('/api/datasources/:id/query', authMiddleware, (req: any, res) => {
  const source = getDatasource(req.auth.tenantId, req.params.id);
  if (!source || !source.enabled) { res.status(404).json({ error: 'not found' }); return; }
  try {
    const result = runDatasourceQuery(source.path, String(req.body?.sql || ''));
    res.type('application/json').send(serializeQueryResult(result));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || '查询失败' });
  }
});

app.delete('/api/datasources/:id', authMiddleware, (req: any, res) => {
  const source = getDatasource(req.auth.tenantId, req.params.id);
  if (!source) { res.status(404).json({ error: 'not found' }); return; }
  if (req.auth.role !== 'tenant_admin' && source.createdBy && source.createdBy !== (req.auth.email || req.auth.sub)) {
    res.status(403).json({ error: '只能删除自己创建的数据源' });
    return;
  }
  deleteDatasource(req.auth.tenantId, req.params.id);
  const datasourceRoot = path.resolve(getDataLocation().dataDir, 'datasources', req.auth.tenantId);
  const sourceDir = path.dirname(path.resolve(source.path));
  if (isPathInside(sourceDir, datasourceRoot)) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
  audit(req.auth.tenantId, 'delete_datasource', req.auth.sub, 'user', `datasource:${req.params.id}`, {});
  res.json({ ok: true });
});

// ═══ Chat Sessions Routes ═══
app.get('/api/chat-sessions', authMiddleware, (req: any, res) => {
  const ownerSub = getChatOwnerSub(req.auth);
  if (req.query?.summary === '1') {
    res.json(listChatSessionSummaries(req.auth.tenantId, ownerSub));
    return;
  }
  res.json(listChatSessions(req.auth.tenantId, ownerSub));
});

app.get('/api/chat-sessions/:id/events', authMiddleware, (req: any, res) => {
  const ownerSub = getChatOwnerSub(req.auth);
  if (!canAccessChatSession(req.auth.tenantId, ownerSub, req.params.id)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId: req.params.id })}\n\n`);

  if (!chatSessionSSE.has(req.params.id)) chatSessionSSE.set(req.params.id, new Set());
  chatSessionSSE.get(req.params.id)!.add(res);
  req.on('close', () => {
    const clients = chatSessionSSE.get(req.params.id);
    clients?.delete(res);
    if (clients && clients.size === 0) chatSessionSSE.delete(req.params.id);
  });
});

app.get('/api/chat-sessions/:id', authMiddleware, (req: any, res) => {
  const session = getChatSession(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id);
  if (!session) { res.status(404).json({ error: 'not found' }); return; }
  res.json(session);
});

app.post('/api/chat-sessions', authMiddleware, (req: any, res) => {
  const result = saveChatSession(req.auth.tenantId, getChatOwnerSub(req.auth), req.body || {});
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  emitChatSessionEvent(result.session.id, { type: 'session_updated', updatedAt: result.session.updatedAt });
  res.json(result.session);
});

app.patch('/api/chat-sessions/:id', authMiddleware, (req: any, res) => {
  const session = updateChatSession(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id, req.body || {});
  if (!session) { res.status(404).json({ error: 'not found' }); return; }
  emitChatSessionEvent(session.id, { type: 'session_updated', updatedAt: session.updatedAt });
  res.json(session);
});

app.patch('/api/chat-sessions/:id/collaboration', authMiddleware, (req: any, res) => {
  const enabled = Boolean(req.body?.enabled);
  const session = updateChatSessionCollaboration(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id, enabled);
  if (!session) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, enabled ? 'enable_chat_collaboration' : 'disable_chat_collaboration', req.auth.sub, 'user', `chat_session:${req.params.id}`);
  emitChatSessionEvent(session.id, { type: 'session_updated', updatedAt: session.updatedAt, collaborationEnabled: session.collaborationEnabled });
  res.json(session);
});

app.post('/api/chat-sessions/:id/join', authMiddleware, (req: any, res) => {
  if (req.auth.authType !== 'jwt') {
    res.status(403).json({ error: 'API Key 无法加入协作会话，请使用用户登录' });
    return;
  }
  const session = joinChatSession(req.auth.tenantId, req.auth.sub, req.params.id);
  if (!session) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'join_chat_session', req.auth.sub, 'user', `chat_session:${req.params.id}`);
  emitChatSessionEvent(session.id, { type: 'session_updated', updatedAt: session.updatedAt, joinedBy: req.auth.sub });
  res.json(session);
});

app.post('/api/chat-sessions/:id/fork', authMiddleware, (req: any, res) => {
  const session = forkChatSession(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id);
  if (!session) { res.status(404).json({ error: 'not found' }); return; }
  audit(req.auth.tenantId, 'copy_chat_session', req.auth.sub, 'user', `chat_session:${req.params.id}`, { copiedId: session.id });
  res.json(session);
});

app.delete('/api/chat-sessions/:id', authMiddleware, (req: any, res) => {
  const ok = deleteChatSession(req.auth.tenantId, getChatOwnerSub(req.auth), req.params.id);
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  emitChatSessionEvent(req.params.id, { type: 'session_deleted', deletedAt: Date.now() });
  res.json({ ok: true });
});

// ═══ Agent Run (real SDK execution; P1 first slice) ═══
app.post('/api/agents/run', authMiddleware, async (req: any, res) => {
  const { prompt, template, provider, model } = req.body || {};
  if (!prompt || typeof prompt !== 'string') { res.status(400).json({ error: 'need prompt' }); return; }
  const tmpl = template || {};
  const storedTemplate = typeof tmpl?.id === 'string' && tmpl.id.trim()
    ? getVisibleAgentTemplate(req.auth, tmpl.id.trim())
    : null;
  if (typeof tmpl?.id === 'string' && tmpl.id.trim() && !storedTemplate) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const subagents = normalizeSubagents(tmpl?.subagents);
  const knowledgeSourceIds = normalizeStringArray(tmpl?.knowledgeSourceIds) || [];
  const datasourceIds = normalizeStringArray(tmpl?.datasourceIds ?? storedTemplate?.datasourceIds) || [];
  const skills = normalizeStringArray(tmpl?.skills);
  const mcpServers = normalizeStringArray(storedTemplate?.mcpServers || tmpl?.mcpServers);
  const selectedModel = [
    model,
    tmpl?.model,
    provider?.ANTHROPIC_MODEL,
  ].find(value => typeof value === 'string' && value.trim())?.trim() || '';
  if (!selectedModel) { res.status(400).json({ error: 'no model configured' }); return; }
  const runtimeProvider = resolveRuntimeProvider(req.auth.tenantId, selectedModel, provider, tmpl?.providerOverrides, req.body?.providerProfiles);
  if (!runtimeProvider.apiKey) { res.status(400).json({ error: 'no api key' }); return; }
  console.log(`[provider-route] agents/run model=${selectedModel} source=${runtimeProvider.source} baseUrl=${describeBaseUrl(runtimeProvider.baseUrl)}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const emit = (e: any) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch {} };
  const abortController = new AbortController();
  let didEnd = false;
  req.on('close', () => {
    if (!didEnd && !abortController.signal.aborted) {
      console.log('[agents/run] client disconnected, aborting run');
      abortController.abort();
    }
  });

  const sessionAllow = new Set<string>();
  const requestPermission = createPermissionRequester({ emit, sessionAllow, tenantId: req.auth.tenantId });
  const requestUserQuestion = createAskUserQuestionRequester({ emit, tenantId: req.auth.tenantId });

  await runAgent({
    prompt,
    systemPrompt: typeof tmpl?.systemPrompt === 'string' ? tmpl.systemPrompt : undefined,
    model: selectedModel,
    baseUrl: runtimeProvider.baseUrl,
    apiKey: runtimeProvider.apiKey,
    tools: Array.isArray(tmpl?.tools) ? tmpl.tools : undefined,
    subagents,
    skills,
    mcpServers,
    outputFormat: tmpl?.outputSchema ? { type: 'json_schema', schema: tmpl.outputSchema } : undefined,
    enableFileCheckpointing: tmpl?.enableFileCheckpointing === true || undefined,
    useKnowledge: tmpl?.useKnowledge === true || knowledgeSourceIds.length > 0,
    knowledgeSourceIds,
    datasourceIds,
    maxTurns: Number(tmpl?.maxTurns) || 20,
    effort: (tmpl?.effort as EffortLevel | undefined),
    tenantId: req.auth.tenantId,
    sub: req.auth.sub,
    role: req.auth.role,
    seedDir: resolveAgentSeedDirForTemplate(req.auth.tenantId, storedTemplate || tmpl),
    emit,
    requestPermission,
    requestUserQuestion,
    abortController,
  });
  didEnd = true;
  res.end();
});

// Permission decision endpoint — the frontend POSTs allow/deny here in
// response to a `permission_request` event from the SSE stream.
app.post('/api/agents/permissions/:reqId', authMiddleware, (req: any, res) => {
  const { decision, reason, updatedInput, rememberForSession } = req.body || {};
  if (decision !== 'allow' && decision !== 'deny') {
    res.status(400).json({ error: 'decision must be "allow" or "deny"' }); return;
  }
  const result = resolvePermissionRequest(req.params.reqId, req.auth.tenantId, {
    decision, reason, updatedInput, rememberForSession,
  });
  if (!result.ok) { res.status(404).json({ error: result.reason || 'not found' }); return; }
  res.json({ ok: true });
});

// AskUserQuestion answer endpoint — the frontend POSTs structured answers here
// in response to an `ask_user_question` event from the SSE stream.
app.post('/api/agents/questions/:reqId', authMiddleware, (req: any, res) => {
  const answers = req.body?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    res.status(400).json({ error: 'answers must be an object' }); return;
  }
  const cleaned: Record<string, string> = {};
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer !== 'string') continue;
    const q = question.trim();
    if (!q) continue;
    cleaned[q] = answer.trim();
  }
  if (!Object.keys(cleaned).length) {
    res.status(400).json({ error: 'answers must include at least one string answer' }); return;
  }
  const result = resolveAskUserQuestion(req.params.reqId, req.auth.tenantId, { answers: cleaned });
  if (!result.ok) { res.status(404).json({ error: result.reason || 'not found' }); return; }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[agentma] http://localhost:${PORT}`);
  if (process.env.AGENTMA_SKIP_RECOVER !== '1') recoverDeployedServers();
});
