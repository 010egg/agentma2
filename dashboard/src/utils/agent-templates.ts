import type { AgentDefinition, AgentTemplate, EffortLevel, PermissionMode, ProviderConfig } from '../simulator/types';
import { getAuthHeaders } from './client-runtime';

const LEGACY_CACHE_KEY = 'agentma_templates';
const CACHE_KEY_PREFIX = 'agentma_templates:';
const DEFAULT_MODEL = '';
const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'];
const VIZ_AGENT_ID = 'viz-agent';
const VIZ_AGENT_PROMPT_VERSION = 'agentma-visual-quality-v5';
const VIZ_AGENT_REQUIRED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill'];

function getCacheKey(tenantId?: string) {
  return tenantId ? `${CACHE_KEY_PREFIX}${tenantId}` : LEGACY_CACHE_KEY;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
  return Array.from(new Set(normalized));
}

function mergeStringArrays(...lists: string[][]) {
  return Array.from(new Set(lists.flatMap((list) => list.map((item) => item.trim()).filter(Boolean))));
}

function normalizeProviderOverrides(value: unknown): Partial<ProviderConfig> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === 'string' && item.trim().length > 0),
  ) as Partial<ProviderConfig>;
}

function normalizeSubagents(value: unknown): Record<string, AgentDefinition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([name, item]) => {
      if (!name.trim() || !item || typeof item !== 'object' || Array.isArray(item)) return [];
      const raw = item as Record<string, unknown>;
      if (typeof raw.description !== 'string' || typeof raw.prompt !== 'string') return [];
      const maxTurns = Number(raw.maxTurns);
      const agent: AgentDefinition = {
        description: raw.description,
        prompt: raw.prompt,
        tools: Array.isArray(raw.tools) ? normalizeStringArray(raw.tools) : undefined,
        disallowedTools: Array.isArray(raw.disallowedTools) ? normalizeStringArray(raw.disallowedTools) : undefined,
        model: typeof raw.model === 'string' && raw.model.trim() ? raw.model : undefined,
        skills: Array.isArray(raw.skills) ? normalizeStringArray(raw.skills) : undefined,
        initialPrompt: typeof raw.initialPrompt === 'string' ? raw.initialPrompt : undefined,
        maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : undefined,
        background: typeof raw.background === 'boolean' ? raw.background : undefined,
        memory: ['user', 'project', 'local'].includes(String(raw.memory)) ? raw.memory as AgentDefinition['memory'] : undefined,
        effort: typeof raw.effort === 'string' ? raw.effort as EffortLevel : undefined,
        permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode as PermissionMode : undefined,
      };
      return [[name.trim(), agent]];
    }),
  );
}

function normalizeAgentTemplate(value: unknown): AgentTemplate | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) return null;

  const createdAt = Number(raw.createdAt);
  const updatedAt = Number(raw.updatedAt);
  const effort = typeof raw.effort === 'string' ? raw.effort as EffortLevel : 'high';
  const permissionMode = typeof raw.permissionMode === 'string' ? raw.permissionMode as PermissionMode : 'default';
  const maxTurns = Number(raw.maxTurns);
  const tools = normalizeStringArray(raw.tools);

  return {
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model : DEFAULT_MODEL,
    tools: Array.isArray(raw.tools) ? tools : DEFAULT_TOOLS,
    subagents: normalizeSubagents(raw.subagents),
    mcpServers: normalizeStringArray(raw.mcpServers),
    eventSources: normalizeStringArray(raw.eventSources),
    skills: normalizeStringArray(raw.skills),
    effort,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 50,
    permissionMode,
    providerOverrides: normalizeProviderOverrides(raw.providerOverrides),
    outputSchema: raw.outputSchema && typeof raw.outputSchema === 'object' && !Array.isArray(raw.outputSchema)
      ? raw.outputSchema as Record<string, unknown>
      : undefined,
    enableFileCheckpointing: raw.enableFileCheckpointing === true ? true : undefined,
    useKnowledge: raw.useKnowledge === true ? true : undefined,
    knowledgeSourceIds: normalizeStringArray(raw.knowledgeSourceIds),
    visualPreprocessDefault: raw.visualPreprocessDefault === true ? true : undefined,
    visualPreprocessModel: typeof raw.visualPreprocessModel === 'string' && raw.visualPreprocessModel.trim()
      ? raw.visualPreprocessModel.trim()
      : undefined,
    seedDir: typeof raw.seedDir === 'string' && raw.seedDir.trim() ? raw.seedDir : undefined,
    createdBy: typeof raw.createdBy === 'string' && raw.createdBy.trim() ? raw.createdBy : null,
    publishedAt: Number(raw.publishedAt) || null,
    archivedAt: Number(raw.archivedAt) || null,
    deletedAt: Number(raw.deletedAt) || null,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function normalizeAgentTemplates(list: unknown): AgentTemplate[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const template = normalizeAgentTemplate(item);
    return template ? [template] : [];
  });
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) as T : null;
  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>))
      ? String((data as Record<string, unknown>).error || '请求失败')
      : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

function writeTenantCache(tenantId: string, templates: AgentTemplate[]) {
  try {
    localStorage.setItem(getCacheKey(tenantId), JSON.stringify(templates));
  } catch {}
}

function clearLegacyCache() {
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch {}
}

function loadLegacyCachedTemplates() {
  try {
    const raw = localStorage.getItem(LEGACY_CACHE_KEY);
    if (!raw) return [];
    return normalizeAgentTemplates(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function loadCachedAgentTemplates(tenantId?: string): AgentTemplate[] {
  if (!tenantId) return [];
  try {
    const raw = localStorage.getItem(getCacheKey(tenantId));
    if (!raw) return [];
    return normalizeAgentTemplates(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function fetchAgentTemplates(tenantId: string): Promise<AgentTemplate[]> {
  const res = await fetch('/api/agents', { headers: getAuthHeaders() });
  const data = await readJson<unknown[]>(res);
  const templates = normalizeAgentTemplates(data);
  writeTenantCache(tenantId, templates);
  return templates;
}

export async function replaceAgentTemplates(tenantId: string, templates: AgentTemplate[]): Promise<AgentTemplate[]> {
  const normalized = normalizeAgentTemplates(templates);
  const res = await fetch('/api/agents', {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(normalized),
  });
  const data = await readJson<unknown[]>(res);
  const saved = normalizeAgentTemplates(data);
  writeTenantCache(tenantId, saved);
  clearLegacyCache();
  return saved;
}

export async function bootstrapAgentTemplates(tenantId: string, allowLegacyImport = false): Promise<AgentTemplate[]> {
  const remoteTemplates = await fetchAgentTemplates(tenantId);
  if (remoteTemplates.length > 0) return remoteTemplates;

  if (!allowLegacyImport) return remoteTemplates;

  const localCandidate = loadCachedAgentTemplates(tenantId);
  const legacyCandidate = localCandidate.length > 0 ? localCandidate : loadLegacyCachedTemplates();
  if (legacyCandidate.length === 0) return remoteTemplates;

  return replaceAgentTemplates(tenantId, legacyCandidate);
}

function createVizAgentSystemPrompt(existingPrompt?: string) {
  const basePrompt = (existingPrompt || [
    '你是 AgentMa 的可视化助手。',
    '当用户要求图表、看板、报告页、结构化表格、流程图或可视化摘要时,优先使用 agentma-visual skill。',
    '把 HTML 写到当前会话 workspace 的 ./viz/<slug>.html,然后给出服务端注入的预览链接。',
    '当用户要求思维导图/mind map 时,优先把标准 Markdown 标题层级写到 ./viz/<slug>.md;可视化页会自动提供“思维导图/MD”双视图。',
    'HTML 必须自包含,不要引用外部资源;需要交互时使用内联脚本。',
    '回复要简洁,说明临时预览未保存时可能失效,预览页可点击保存。',
  ].join('\n')).trim();

  if (basePrompt.includes(VIZ_AGENT_PROMPT_VERSION)) return basePrompt;

  const qualityGate = [
    `[${VIZ_AGENT_PROMPT_VERSION}]`,
    '先判断可视化类型再选形态:图表、表格、看板、流程图、路线图、思维导图不要互相冒充。',
    '用户明确要求思维导图/mind map 且内容适合层级表达时,优先生成 .md:用 #/##/###/#### 表示层级,不要额外生成复杂 HTML;交付 Markdown 思维导图预览链接。',
    'Markdown 思维导图内容应以中心主题作为 # 一级标题;如果没有明确中心主题,用文件主题或用户问题概括一个一级标题。',
    '只有当用户明确要求自定义交互式 HTML 思维导图时,才生成标准 HTML mindmap:中心主题、左右分支、曲线父子连线、+/- 折叠、画布拖动/缩放、节点可拖动。',
    '自定义 HTML 思维导图布局必须按子树高度排布,父节点居中对齐子树;横向层级步进必须大于节点宽度,禁止二级节点与父节点重叠或堆叠。',
    '自定义 HTML 思维导图交互必须保护用户当前视口:点击 +/-、全部展开/收起、搜索自动展开、自动排版、窗口 resize、外层全屏都不得重算或重置 scale;只允许重新布局/重绘连线并保留当前 pan/zoom。',
    '自定义 HTML 思维导图只能在首次渲染和用户明确点击“居中/适配”按钮时自动 fit;其它交互不要调用 fit/resetZoom/autoScale。',
    '自定义 HTML 思维导图默认折叠态必须只显示中心主题和一级分支;实现时可把一级分支节点设为 collapsed,但不能隐藏一级分支本身。',
    '紧凑只能减少空白,不能牺牲具体信息;节点至少保留标题和一行说明。',
    '生成可视化时不要在正文输出 HTML 或长篇过程;先完成 Skill/Write,最后只给预览链接和简短说明。',
    '交付链接前尽量做 smoke:默认/全展开节点与连线数量匹配、无节点重叠、无缺坐标、截图非空且关键文本不被裁切;失败先自修。',
  ].join('\n');

  return [basePrompt, '', qualityGate].join('\n');
}

function createVizAgentTemplate(model: string): AgentTemplate {
  const now = Date.now();
  return {
    id: VIZ_AGENT_ID,
    name: '可视化助手',
    description: '把数据、结构和说明整理成可保存的 HTML 可视化预览。',
    systemPrompt: createVizAgentSystemPrompt(),
    model,
    tools: VIZ_AGENT_REQUIRED_TOOLS,
    subagents: {},
    mcpServers: [],
    eventSources: [],
    skills: ['agentma-visual'],
    effort: 'high',
    maxTurns: 50,
    permissionMode: 'default',
    knowledgeSourceIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function upgradeVizAgentTemplate(template: AgentTemplate): AgentTemplate {
  const systemPrompt = createVizAgentSystemPrompt(template.systemPrompt);
  const skills = mergeStringArrays(template.skills, ['agentma-visual']);
  const tools = mergeStringArrays(template.tools, VIZ_AGENT_REQUIRED_TOOLS);

  if (
    systemPrompt === template.systemPrompt
    && skills.join('\n') === template.skills.join('\n')
    && tools.join('\n') === template.tools.join('\n')
  ) {
    return template;
  }

  return {
    ...template,
    systemPrompt,
    skills,
    tools,
    updatedAt: Date.now(),
  };
}

export async function ensureVizAgentTemplate(tenantId: string, templates?: AgentTemplate[]): Promise<AgentTemplate[]> {
  const current = templates || await fetchAgentTemplates(tenantId);
  const vizIndex = current.findIndex((template) => template.id === VIZ_AGENT_ID);
  if (vizIndex >= 0) {
    const upgraded = upgradeVizAgentTemplate(current[vizIndex]);
    if (upgraded === current[vizIndex]) return current;
    const next = current.slice();
    next[vizIndex] = upgraded;
    return replaceAgentTemplates(tenantId, next);
  }
  const model = current.find((template) => template.model)?.model || DEFAULT_MODEL;
  return replaceAgentTemplates(tenantId, [createVizAgentTemplate(model), ...current]);
}

export function getCachedAgentTemplateById(tenantId: string | undefined, templateId: string) {
  return loadCachedAgentTemplates(tenantId).find((template) => template.id === templateId) || null;
}
