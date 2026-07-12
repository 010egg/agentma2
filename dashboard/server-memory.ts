// Per-user long-term memory (跨会话记忆), inherited from Claude Code 的 # Memory 行为。
// 存储按 (tenant, sub) 隔离,与技能同套路(safeSeg + realpath + isInside)。
// runAgent 仅把 MEMORY.md 索引注入 systemPrompt;agent 用 memory.recall 按需读取正文。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

export type MemoryAuth = { tenantId: string; sub: string };
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

const USER_MEMORY_ROOT = path.resolve(
  process.env.AGENTMA_USER_MEMORY_DIR || path.join(os.homedir(), '.claude', 'agentma-memory'),
);
const MAX_INDEX_CHARS = 6000;    // 注入 systemPrompt 的记忆索引上限
const MAX_RECALL_CHARS = 12_000; // 单次 recall 返回正文上限
const MAX_BODY_BYTES = 32 * 1024; // 单条事实正文上限
const MEMORY_STATS_FILE = 'memory-stats.json';
const MEMORY_STATS_VERSION = 2;

type MemoryStat = { recallCount: number; lastRecalledAt: number | null };
type MemoryStats = Record<string, MemoryStat>;
type MemoryStatsState = { memories: MemoryStats; needsRewrite: boolean };
export type MemoryRecallResult = { text: string; recalledNames: string[]; omittedNames: string[] };

function safeSeg(value: string) {
  const n = String(value).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return n || crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function slugify(name: string) {
  const s = String(name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 12);
}

function isInside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function userMemoryDir(auth: MemoryAuth) {
  return path.join(USER_MEMORY_ROOT, safeSeg(auth.tenantId), safeSeg(auth.sub));
}

function memoryStatsPath(root: string) {
  return path.join(root, MEMORY_STATS_FILE);
}

function readMemoryStats(root: string): MemoryStatsState {
  const filePath = memoryStatsPath(root);
  if (!fs.existsSync(filePath)) return { memories: {}, needsRewrite: false };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid root');
    const rootRecord = raw as Record<string, unknown>;
    if (rootRecord.version !== MEMORY_STATS_VERSION) return { memories: {}, needsRewrite: true };
    const rawMemories = rootRecord.memories;
    if (!rawMemories || typeof rawMemories !== 'object' || Array.isArray(rawMemories)) throw new Error('invalid memories');
    const stats: MemoryStats = {};
    for (const [name, value] of Object.entries(rawMemories as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      stats[slugify(name)] = {
        recallCount: Math.max(0, Math.floor(Number(item.recallCount) || 0)),
        lastRecalledAt: Number(item.lastRecalledAt) || null,
      };
    }
    return { memories: stats, needsRewrite: false };
  } catch (error) {
    console.warn(`[memory] 忽略损坏的 ${MEMORY_STATS_FILE}: ${(error as Error).message}`);
    return { memories: {}, needsRewrite: true };
  }
}

function writeMemoryStats(root: string, stats: MemoryStats) {
  const target = memoryStatsPath(root);
  const temp = path.join(root, `.memory-stats.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: MEMORY_STATS_VERSION, memories: stats }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function pruneMemoryStats(root: string, keepNames: Set<string>) {
  try {
    const state = readMemoryStats(root);
    const stats = state.memories;
    let changed = false;
    for (const name of Object.keys(stats)) {
      if (keepNames.has(name)) continue;
      delete stats[name];
      changed = true;
    }
    if (changed || state.needsRewrite) writeMemoryStats(root, stats);
  } catch (error) {
    console.warn(`[memory] 清理召回统计失败: ${(error as Error).message}`);
  }
}

// 仅注入路由索引；正文必须通过 memory.recall 按需读取。
export function readMemoryIndex(auth: MemoryAuth): string {
  try {
    const dir = userMemoryDir(auth);
    const indexPath = path.join(dir, 'MEMORY.md');
    if (!fs.existsSync(indexPath)) return '';
    return fs.readFileSync(indexPath, 'utf-8').trim().slice(0, MAX_INDEX_CHARS);
  } catch { return ''; }
}

// 解析一条记忆文件的 frontmatter + 正文。
export function parseMemoryFile(content: string): { name: string; description: string; type: MemoryType; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', type: 'project', body: String(content || '').trim() };
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.*)$/m)?.[1] || '').trim();
  const description = (fm.match(/^description:\s*(.*)$/m)?.[1] || '').trim();
  const rawType = (fm.match(/type:\s*([A-Za-z]+)/)?.[1] || 'project') as MemoryType;
  return { name, description, type: MEMORY_TYPES.includes(rawType) ? rawType : 'project', body: m[2].trim() };
}

// 从实际文件重建 MEMORY.md 索引(丢弃孤儿索引项、保持与文件一致)。
function rebuildIndex(root: string) {
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
  const lines = ['# Memory Index'];
  for (const f of files) {
    try {
      const p = parseMemoryFile(fs.readFileSync(path.join(root, f), 'utf-8'));
      const slug = f.replace(/\.md$/, '');
      lines.push(`- [${slug}](${f}) — ${p.description || p.type}`);
    } catch {}
  }
  fs.writeFileSync(path.join(root, 'MEMORY.md'), lines.join('\n') + '\n', 'utf-8');
}

// 写入一条记忆:落 <slug>.md(带 frontmatter) + 重建 MEMORY.md 索引。路径锁死在用户目录内。
export function writeMemory(auth: MemoryAuth, input: { name: string; description: string; type?: string; body: string }) {
  const dir = userMemoryDir(auth);
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.realpathSync(dir);
  const slug = slugify(input.name);
  const filePath = path.join(root, `${slug}.md`);
  if (!isInside(filePath, root)) throw new Error('memory path invalid');
  const body = String(input.body || '').slice(0, MAX_BODY_BYTES).trim();
  if (!body) throw new Error('memory body 不能为空');
  const desc = String(input.description || '').replace(/\s+/g, ' ').trim();
  const type: MemoryType = MEMORY_TYPES.includes(input.type as MemoryType) ? (input.type as MemoryType) : 'project';
  const content = `---\nname: ${slug}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
  fs.writeFileSync(filePath, content, 'utf-8');

  rebuildIndex(root);
  return { name: slug, path: filePath };
}

// ── 管理面(供 REST/UI 使用) ─────────────────────────────────────────────
export type MemoryListItem = {
  name: string;
  description: string;
  type: MemoryType;
  updatedAt: number;
  sizeBytes: number;
  recallCount: number;
  lastRecalledAt: number | null;
};

export function listMemories(auth: MemoryAuth): MemoryListItem[] {
  const dir = userMemoryDir(auth);
  if (!fs.existsSync(dir)) return [];
  const root = fs.realpathSync(dir);
  const stats = readMemoryStats(root).memories;
  const out: MemoryListItem[] = [];
  for (const f of fs.readdirSync(root)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    try {
      const full = path.join(root, f);
      const stat = fs.statSync(full);
      const p = parseMemoryFile(fs.readFileSync(full, 'utf-8'));
      const name = f.replace(/\.md$/, '');
      out.push({
        name,
        description: p.description,
        type: p.type,
        updatedAt: stat.mtimeMs,
        sizeBytes: stat.size,
        recallCount: stats[name]?.recallCount || 0,
        lastRecalledAt: stats[name]?.lastRecalledAt || null,
      });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readMemory(auth: MemoryAuth, name: string): (MemoryListItem & { body: string }) | null {
  const slug = slugify(name);
  const dir = userMemoryDir(auth);
  if (!fs.existsSync(dir)) return null;
  const root = fs.realpathSync(dir);
  const full = path.join(root, `${slug}.md`);
  if (!isInside(full, root) || !fs.existsSync(full)) return null;
  const stats = readMemoryStats(root).memories;
  const stat = fs.statSync(full);
  const p = parseMemoryFile(fs.readFileSync(full, 'utf-8'));
  return {
    name: slug,
    description: p.description,
    type: p.type,
    body: p.body,
    updatedAt: stat.mtimeMs,
    sizeBytes: stat.size,
    recallCount: stats[slug]?.recallCount || 0,
    lastRecalledAt: stats[slug]?.lastRecalledAt || null,
  };
}

export function recordMemoryRecalls(auth: MemoryAuth, recalledNames: string[]) {
  if (!recalledNames.length) return;
  const dir = userMemoryDir(auth);
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.realpathSync(dir);
  const stats = readMemoryStats(root).memories;
  const timestamp = Date.now();
  for (const name of new Set(recalledNames.map(slugify))) {
    const current = stats[name] || { recallCount: 0, lastRecalledAt: null };
    stats[name] = { recallCount: current.recallCount + 1, lastRecalledAt: timestamp };
  }
  writeMemoryStats(root, stats);
}

export function recallMemories(auth: MemoryAuth, names: string[]): MemoryRecallResult {
  const uniqueNames = Array.from(new Set(names.map(slugify)));
  const normalizedNames = uniqueNames.slice(0, 8);
  const recalledNames: string[] = [];
  const omittedNames: string[] = uniqueNames.slice(8);
  let text = '';

  for (let index = 0; index < normalizedNames.length; index += 1) {
    const name = normalizedNames[index];
    let item: ReturnType<typeof readMemory> = null;
    try { item = readMemory(auth, name); } catch {}
    if (!item) {
      omittedNames.push(name);
      continue;
    }
    const section = [
      `## ${item.name}`,
      `type: ${item.type}`,
      `description: ${item.description || '(none)'}`,
      '',
      item.body,
    ].join('\n');
    const prefix = text ? '\n\n' : '';
    const remaining = MAX_RECALL_CHARS - text.length;
    if (remaining <= prefix.length) {
      omittedNames.push(...normalizedNames.slice(index));
      break;
    }
    text += `${prefix}${section}`.slice(0, remaining);
    recalledNames.push(name);
    if (text.length >= MAX_RECALL_CHARS) {
      omittedNames.push(...normalizedNames.slice(index + 1));
      break;
    }
  }

  if (recalledNames.length) {
    try {
      recordMemoryRecalls(auth, recalledNames);
    } catch (error) {
      console.warn(`[memory] 记录召回统计失败: ${(error as Error).message}`);
    }
  }

  const omitted = omittedNames.length ? `\n\n未返回: ${omittedNames.join(', ')}` : '';
  return {
    text: text ? `# Recalled Memories\n\n${text}${omitted}` : `未召回到记忆。${omitted}`,
    recalledNames,
    omittedNames,
  };
}

export function deleteMemory(auth: MemoryAuth, name: string): boolean {
  const slug = slugify(name);
  const dir = userMemoryDir(auth);
  if (!fs.existsSync(dir)) return false;
  const root = fs.realpathSync(dir);
  const full = path.join(root, `${slug}.md`);
  if (!isInside(full, root) || !fs.existsSync(full)) return false;
  fs.rmSync(full, { force: true });
  rebuildIndex(root);
  const remaining = new Set(fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').map((f) => f.replace(/\.md$/, '')));
  pruneMemoryStats(root, remaining);
  return true;
}

// 机械整理:剔除空/损坏文件、按正文去重、重建索引(非 LLM 语义合并)。
export function consolidateMemories(auth: MemoryAuth): { kept: number; removed: number } {
  const dir = userMemoryDir(auth);
  if (!fs.existsSync(dir)) return { kept: 0, removed: 0 };
  const root = fs.realpathSync(dir);
  const seen = new Set<string>();
  let kept = 0, removed = 0;
  for (const f of fs.readdirSync(root).filter((x) => x.endsWith('.md') && x !== 'MEMORY.md').sort()) {
    const full = path.join(root, f);
    let body = '';
    try { body = parseMemoryFile(fs.readFileSync(full, 'utf-8')).body; } catch { fs.rmSync(full, { force: true }); removed++; continue; }
    const key = body.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) { fs.rmSync(full, { force: true }); removed++; continue; }
    seen.add(key); kept++;
  }
  rebuildIndex(root);
  const remaining = new Set(fs.readdirSync(root).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').map((f) => f.replace(/\.md$/, '')));
  pruneMemoryStats(root, remaining);
  return { kept, removed };
}

const RECALL_DESC = '按名称读取当前用户的长期记忆正文。先根据 system prompt 中的 <memory_index> 判断相关性，只召回当前请求需要的忆块；索引摘要只是路由信息，不能替代正文。';
const REMEMBER_DESC = '把非显而易见、以后跨会话能复用的事实存入长期记忆(仅本用户可见)。适合:用户身份/偏好、你被纠正过的做法(含原因)、项目约束或目标、外部资源指针。不要存能从代码/历史直接得到的、或只对当前对话有用的内容。保存前先看 <memory_index>，必要时调用 recall 确认正文，避免重复。';

export type MemoryCapabilities = { recall: boolean; remember: boolean };

export function buildMemoryMcp(auth: MemoryAuth, capabilities: MemoryCapabilities = { recall: true, remember: true }) {
  const tools = [
    ...(capabilities.recall ? [
      tool('recall', RECALL_DESC, {
        names: z.array(z.string().min(1)).min(1).max(8).describe('要读取的记忆 slug；每次最多 8 个'),
      }, async (args: any) => {
        try {
          const recalled = recallMemories(auth, args.names || []);
          return { content: [{ type: 'text', text: recalled.text }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `召回失败: ${(e as Error).message}` }], isError: true };
        }
      }),
    ] : []),
    ...(capabilities.remember ? [
      tool('remember', REMEMBER_DESC, {
        name: z.string().describe('短横线小写 slug,如 user-prefers-ts'),
        description: z.string().describe('一句话摘要,召回时用于判断相关性'),
        type: z.enum(['user', 'feedback', 'project', 'reference']),
        body: z.string().describe('事实正文;feedback/project 建议附 为什么 / 如何应用'),
      }, async (args: any) => {
        try {
          const saved = writeMemory(auth, args);
          return { content: [{ type: 'text', text: `已记住 "${saved.name}"。` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `记忆失败: ${(e as Error).message}` }], isError: true };
        }
      }),
    ] : []),
  ];
  return createSdkMcpServer({
    name: 'memory',
    version: '2.0.0',
    tools,
  });
}

export function buildMemorySystemPrompt(index: string, capabilities: MemoryCapabilities = { recall: true, remember: true }) {
  const instructions = ['# Memory', '你有按用户隔离的跨会话长期记忆。'];
  if (capabilities.recall) {
    instructions.push('下方 <memory_index> 只有名称和摘要，是用于判断相关性的路由索引，不是完整事实。当前请求与某条索引相关时，先调用 mcp__memory__recall 读取正文，再据此回答；只召回当前请求需要的忆块。');
  }
  if (capabilities.remember) {
    instructions.push('出现值得长期复用的新事实时，调用 mcp__memory__remember 保存。不要保存能从代码或当前对话直接得到、或只对当前对话有用的内容。');
  }
  const instruction = instructions.join('\n');
  if (!capabilities.recall) return instruction;
  if (!index) return `${instruction}\n\n(当前无已存记忆。)`;
  return `${instruction}\n\n<memory_index>\n${index}\n</memory_index>`;
}
