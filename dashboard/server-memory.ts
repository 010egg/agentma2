// Per-user long-term memory (跨会话记忆), inherited from Claude Code 的 # Memory 行为。
// 存储按 (tenant, sub) 隔离,与技能同套路(safeSeg + realpath + isInside)。
// runAgent 每次把 MEMORY.md 索引+事实注入 systemPrompt;agent 用 mcp__memory__remember 写入。
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
const MAX_INJECT_CHARS = 6000;   // 注入 systemPrompt 的记忆总量上限
const MAX_BODY_BYTES = 32 * 1024; // 单条事实正文上限

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

// 读 MEMORY.md 索引 + 事实正文(受 MAX_INJECT_CHARS 限),供每次运行注入。无记忆返回 ''。
export function readMemoryContext(auth: MemoryAuth): string {
  try {
    const dir = userMemoryDir(auth);
    const indexPath = path.join(dir, 'MEMORY.md');
    if (!fs.existsSync(indexPath)) return '';
    let out = fs.readFileSync(indexPath, 'utf-8').trim();
    if (!out) return '';
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
    for (const f of files) {
      if (out.length >= MAX_INJECT_CHARS) { out += '\n\n[... 记忆较多,仅注入索引;需要细节可让用户提供 ...]'; break; }
      try { out += `\n\n----- ${f} -----\n${fs.readFileSync(path.join(dir, f), 'utf-8').trim()}`; } catch {}
    }
    return out.slice(0, MAX_INJECT_CHARS + 240);
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
export type MemoryListItem = { name: string; description: string; type: MemoryType; updatedAt: number; sizeBytes: number };

export function listMemories(auth: MemoryAuth): MemoryListItem[] {
  const dir = userMemoryDir(auth);
  if (!fs.existsSync(dir)) return [];
  const root = fs.realpathSync(dir);
  const out: MemoryListItem[] = [];
  for (const f of fs.readdirSync(root)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    try {
      const full = path.join(root, f);
      const stat = fs.statSync(full);
      const p = parseMemoryFile(fs.readFileSync(full, 'utf-8'));
      out.push({ name: f.replace(/\.md$/, ''), description: p.description, type: p.type, updatedAt: stat.mtimeMs, sizeBytes: stat.size });
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
  const stat = fs.statSync(full);
  const p = parseMemoryFile(fs.readFileSync(full, 'utf-8'));
  return { name: slug, description: p.description, type: p.type, body: p.body, updatedAt: stat.mtimeMs, sizeBytes: stat.size };
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
  return { kept, removed };
}

const REMEMBER_DESC = '把非显而易见、以后跨会话能复用的事实存入长期记忆(仅本用户可见)。适合:用户身份/偏好、你被纠正过的做法(含原因)、项目约束或目标、外部资源指针。不要存能从代码/历史直接得到的、或只对当前对话有用的内容。保存前先看已注入的 <memory> 里有没有,避免重复。';

export function buildMemoryMcp(auth: MemoryAuth) {
  return createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    tools: [
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
    ],
  });
}

export function buildMemorySystemPrompt(context: string) {
  const instruction = [
    '# Memory',
    '你有跨会话的长期记忆(按用户隔离)。出现值得长期复用的事实时,调用 mcp__memory__remember 保存:用户是谁/偏好、你被纠正过的做法(含原因)、项目约束或目标、外部资源指针。不要保存能从代码/历史直接得到、或只对当前对话有用的内容。保存前先看下方 <memory>,避免重复。',
  ].join('\n');
  if (!context) return `${instruction}\n\n(当前无已存记忆。)`;
  return `${instruction}\n\n<memory>\n${context}\n</memory>`;
}
