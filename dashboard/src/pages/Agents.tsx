import { type FormEvent, useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentDefinition, AgentTemplate, EffortLevel, PermissionMode, SkillInfo, RegisteredTool } from '../simulator/types';
import { EFFORT_LEVELS, PERMISSION_MODES, DEFAULT_SKILLS, initCustomTools } from '../simulator/mock-data';
import { useAuth } from '../contexts/AuthContext';
import { bootstrapAgentTemplates, loadCachedAgentTemplates, replaceAgentTemplates } from '../utils/agent-templates';
import { getAuthHeaders } from '../utils/client-runtime';
import { listProviderModels, resolveProviderForModel } from '../utils/providers';
import ModelPicker from '../components/common/ModelPicker';
import LineIcon from '../components/LineIcon';
import A2AConfigEditor from '../components/A2AConfigEditor';

type KnowledgeSource = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
};

function normalizeInternalTools(items: unknown): RegisteredTool[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const serverName = typeof raw.serverName === 'string' ? raw.serverName : '';
    const toolName = typeof raw.toolName === 'string' ? raw.toolName : '';
    const description = typeof raw.description === 'string' ? raw.description : '';
    if (!id || !serverName || !toolName || !description) return [];
    return [{
      name: id,
      description,
      category: typeof raw.category === 'string' ? raw.category : '内部工具',
      inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema)
        ? raw.inputSchema as Record<string, unknown>
        : {},
      annotations: raw.annotations && typeof raw.annotations === 'object' && !Array.isArray(raw.annotations)
        ? raw.annotations as RegisteredTool['annotations']
        : undefined,
      source: 'internal',
      mcpServer: serverName,
    }];
  });
}

type ClaudeMdPreviewFile = {
  source: 'user' | 'project' | 'local';
  label: string;
  path: string;
  exists: boolean;
  bytes?: number;
  mtimeMs?: number;
  content?: string;
  error?: string;
};

type ClaudeMdPreview = {
  agentId: string;
  agentName: string;
  cwd: string;
  cwdExists: boolean;
  cwdSource: 'latest_session' | 'template_seed' | 'new_session';
  latestSession: { id: string; title: string; updatedAt: number } | null;
  settingSources: Array<'user' | 'project' | 'local'>;
  files: ClaudeMdPreviewFile[];
  loadedFiles: string[];
  effectiveContent: string;
  generatedAt: number;
  notes: string[];
};

type AgentImportReport = {
  templateId: string;
  seedDir: string;
  unpacked: Array<{ path: string; bytes: number; category: string }>;
  detected: { agents: string[]; skills: string[]; claudeMd: boolean; remoteMcp: string[] };
  disabled: { hooks: string[]; stdioMcp: string[] };
  skipped: Array<{ path: string; reason: string }>;
  notes: string[];
};

type AgentMarketSort = 'popular' | 'updated' | 'name';

function loadSkills(): SkillInfo[] {
  try {
    const raw = localStorage.getItem('agentma_skills');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(skill => ({ ...skill, enabled: true }));
    }
  } catch {}
  return DEFAULT_SKILLS.map(skill => ({ ...skill, enabled: true }));
}

function loadMcpServers(): { name: string }[] {
  try { const raw = localStorage.getItem('agentma_mcp_servers'); if (raw) return JSON.parse(raw); } catch {}
  return [];
}

function normalizeKnowledgeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const path = typeof raw.path === 'string' ? raw.path : '';
    if (!id || !path || Number(raw.archivedAt) || Number(raw.deletedAt)) return [];
    return [{
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : path.split('/').filter(Boolean).pop() || '知识库',
      path,
      enabled: raw.enabled !== false,
    }];
  });
}

function getDirectoryRelativePath(file: File) {
  return ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, '/');
}

function newTemplate(): AgentTemplate {
  return {
    id: '', name: '', description: '', systemPrompt: '',
    model: '', tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    mcpServers: [], eventSources: [], skills: [], knowledgeSourceIds: [],
    effort: 'high', maxTurns: 50, permissionMode: 'default',
    a2aPublished: false, a2aRemoteAgents: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function defaultSubagent(): AgentDefinition {
  return {
    description: '只读代码探索代理',
    prompt: '你是一个只读代码探索子代理。分析文件和结构，最后给出简短结论，不修改文件。',
    tools: ['Read', 'Grep', 'Glob'],
    effort: 'medium',
    permissionMode: 'default',
  };
}

function getCloneTemplateName(sourceName: string, templates: AgentTemplate[]) {
  const existingNames = new Set(templates.map(template => template.name.trim()).filter(Boolean));
  const baseName = `${sourceName.trim() || '未命名 Agent'} 克隆`;
  let name = baseName;
  let suffix = 2;
  while (existingNames.has(name)) {
    name = `${baseName} ${suffix}`;
    suffix += 1;
  }
  return name;
}

function getCloneTemplateId(templates: AgentTemplate[], now: number) {
  const existingIds = new Set(templates.map(template => template.id));
  let id = `agent-${now}`;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `agent-${now}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function cloneTemplate(source: AgentTemplate, templates: AgentTemplate[]): AgentTemplate {
  const now = Date.now();
  const cloned = JSON.parse(JSON.stringify(source)) as AgentTemplate;
  return {
    ...cloned,
    id: getCloneTemplateId(templates, now),
    name: getCloneTemplateName(source.name, templates),
    createdBy: undefined,
    publishedAt: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const TOOL_CATEGORIES = [
  { name: 'file', label: '文件', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] },
  { name: 'execution', label: '执行', tools: ['Bash', 'EnterWorktree'] },
  { name: 'search', label: '搜索', tools: ['WebSearch', 'WebFetch', 'ToolSearch'] },
  { name: 'task', label: '任务', tools: ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput'] },
  { name: 'agent', label: '代理', tools: ['Agent', 'Skill', 'AskUserQuestion', 'ExitPlanMode'] },
  { name: 'mcp', label: 'MCP', tools: ['ListMcpResources', 'ReadMcpResource'] },
  { name: 'notebook', label: 'Notebook', tools: ['NotebookEdit'] },
];
const KNOWLEDGE_TOOLS = ['Read', 'Grep', 'Glob'];

function userAgentActor(user: { email?: string; id?: string } | null) {
  return user?.email || user?.id || '';
}

function isPublishedAgent(template: AgentTemplate) {
  return Boolean(template.publishedAt) && !template.archivedAt && !template.deletedAt;
}

export default function Agents() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [templates, setTemplates] = useState<AgentTemplate[]>(() => loadCachedAgentTemplates(user?.tenantId));
  const [form, setForm] = useState<AgentTemplate>(newTemplate());
  const [isEditing, setIsEditing] = useState(false);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [previewAgent, setPreviewAgent] = useState<AgentTemplate | null>(null);
  const [claudeMdPreview, setClaudeMdPreview] = useState<ClaudeMdPreview | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importReport, setImportReport] = useState<AgentImportReport | null>(null);
  const [importedAgent, setImportedAgent] = useState<AgentTemplate | null>(null);
  const [isImportReportOpen, setIsImportReportOpen] = useState(false);
  const [isGitImportOpen, setIsGitImportOpen] = useState(false);
  const [gitImportUrl, setGitImportUrl] = useState('');
  const [gitImportRef, setGitImportRef] = useState('');
  const [marketSearch, setMarketSearch] = useState('');
  const [marketSort, setMarketSort] = useState<AgentMarketSort>('popular');
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // 动态加载技能和 MCP 服务器（非写死）
  const [liveSkills] = useState<SkillInfo[]>(loadSkills);
  const [liveMcp] = useState<{ name: string }[]>(loadMcpServers);
  const [liveKnowledgeSources, setLiveKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [liveEventSources, setLiveEventSources] = useState<Array<{ name: string; type: string; url: string; enabled: boolean }>>([]);
  const modelSuggestions = listProviderModels();
  const availableModelSet = new Set(modelSuggestions);
  const selectedModel = form.model.trim();
  const selectedModelAvailable = selectedModel ? availableModelSet.has(selectedModel) : false;
  const providerMatch = selectedModelAvailable ? resolveProviderForModel(selectedModel) : null;
  const visualModel = (form.visualPreprocessModel || '').trim();
  const visualModelAvailable = visualModel ? availableModelSet.has(visualModel) : false;
  const visualProviderMatch = visualModelAvailable ? resolveProviderForModel(visualModel) : null;
  const actor = userAgentActor(user || null);
  const canManageTemplate = (template: AgentTemplate) => user?.role === 'tenant_admin' || Boolean(actor && template.createdBy === actor);
  const publicTemplates = templates.filter(template => isPublishedAgent(template));
  const mineTemplates = templates.filter(template => canManageTemplate(template));
  const visibleTemplateIds = new Set([...publicTemplates, ...mineTemplates].map(template => template.id));
  const hiddenTemplateCount = templates.length - visibleTemplateIds.size;
  const normalizedMarketSearch = marketSearch.trim().toLowerCase();

  useEffect(() => {
    fetch('/api/events/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) })
      .then(r => r.json()).then(data => { if (Array.isArray(data)) setLiveEventSources(data); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user?.tenantId) return;
    fetch('/api/knowledge/sources', { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then(data => setLiveKnowledgeSources(normalizeKnowledgeSources(data)))
      .catch(() => setLiveKnowledgeSources([]));
  }, [user?.tenantId]);
  const [liveCustomTools, setLiveCustomTools] = useState<RegisteredTool[]>(() => initCustomTools());
  const [liveInternalTools, setLiveInternalTools] = useState<RegisteredTool[]>([]);
  const subagentEntries = Object.entries(form.subagents || {});

  useEffect(() => {
    if (!isEditorOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsEditorOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEditorOpen]);

  useEffect(() => {
    if (!isPreviewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsPreviewOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPreviewOpen]);

  useEffect(() => {
    if (!isImportReportOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsImportReportOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isImportReportOpen]);

  useEffect(() => {
    if (!isGitImportOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsGitImportOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isGitImportOpen]);

  // 每次页面可见时刷新自定义工具
  useEffect(() => {
    const onFocus = () => setLiveCustomTools(initCustomTools());
    window.addEventListener('focus', onFocus);
    // 也监听 storage 事件（跨 tab）
    const onStorage = (e: StorageEvent) => { if (e.key === 'agentma_custom_tools') setLiveCustomTools(initCustomTools()); };
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onStorage); };
  }, []);

  useEffect(() => {
    if (!user?.tenantId) return;
    let cancelled = false;
    fetch('/api/internal-tools', { headers: getAuthHeaders() })
      .then(response => response.ok ? response.json() : [])
      .then(data => { if (!cancelled) setLiveInternalTools(normalizeInternalTools(data)); })
      .catch(() => { if (!cancelled) setLiveInternalTools([]); });
    return () => { cancelled = true; };
  }, [user?.tenantId]);

  useEffect(() => {
    if (!user?.tenantId) return;

    let cancelled = false;
    setTemplates(loadCachedAgentTemplates(user.tenantId));
    setIsLoading(true);

    void bootstrapAgentTemplates(user.tenantId, user.role === 'tenant_admin')
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setError('');
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError((loadError as Error).message || '加载 Agent 失败');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [user?.tenantId, user?.role]);

  useEffect(() => {
    const tenantId = user?.tenantId;
    if (!tenantId) return;

    const refreshFromServer = () => {
      void bootstrapAgentTemplates(tenantId, user.role === 'tenant_admin')
        .then(setTemplates)
        .catch(() => setTemplates(loadCachedAgentTemplates(tenantId)));
    };
    const refreshFromCache = () => setTemplates(loadCachedAgentTemplates(tenantId));
    const onTemplatesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ tenantId?: string }>).detail;
      if (!detail?.tenantId || detail.tenantId === tenantId) refreshFromCache();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith('agentma_templates')) refreshFromCache();
    };

    window.addEventListener('focus', refreshFromServer);
    window.addEventListener('storage', onStorage);
    window.addEventListener('agentma:agent-templates-updated', onTemplatesUpdated);
    return () => {
      window.removeEventListener('focus', refreshFromServer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('agentma:agent-templates-updated', onTemplatesUpdated);
    };
  }, [user?.tenantId, user?.role]);

  useEffect(() => {
    if (!form.id) return;
    const current = templates.find((template) => template.id === form.id);
    if (current) {
      const selectedKnowledgeIds = (current.knowledgeSourceIds || []).length
        ? current.knowledgeSourceIds || []
        : current.useKnowledge
          ? liveKnowledgeSources.filter(source => source.enabled).map(source => source.id)
          : [];
      setForm({
        ...current,
        knowledgeSourceIds: selectedKnowledgeIds,
        useKnowledge: selectedKnowledgeIds.length > 0 || current.useKnowledge || undefined,
      });
      setIsEditing(true);
      return;
    }
    if (isEditing) {
      setForm(newTemplate());
      setIsEditing(false);
    }
  }, [templates, form.id, isEditing, liveKnowledgeSources]);

  const handleSelect = (t: AgentTemplate) => {
    const selectedKnowledgeIds = (t.knowledgeSourceIds || []).length
      ? t.knowledgeSourceIds || []
      : t.useKnowledge
        ? liveKnowledgeSources.filter(source => source.enabled).map(source => source.id)
        : [];
    setForm({
      ...t,
      knowledgeSourceIds: selectedKnowledgeIds,
      useKnowledge: selectedKnowledgeIds.length > 0 || t.useKnowledge || undefined,
    });
    setIsEditing(true);
    setIsEditorOpen(true);
  };

  const handleNew = () => {
    setForm(newTemplate());
    setIsEditing(false);
    setIsEditorOpen(true);
  };

  const handleClone = async (source: AgentTemplate) => {
    if (!user?.tenantId) return;
    const cloned = cloneTemplate(source, templates);
    const nextTemplates = [cloned, ...templates];

    setIsSaving(true);
    try {
      const persisted = await replaceAgentTemplates(user.tenantId, nextTemplates);
      const persistedClone = persisted.find((template) => template.id === cloned.id) || cloned;
      setTemplates(persisted);
      setForm(persistedClone);
      setIsEditing(true);
      setIsEditorOpen(true);
      setError('');
    } catch (saveError) {
      setError((saveError as Error).message || '克隆 Agent 失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim() || !user?.tenantId) return;
    if (!modelSuggestions.length) {
      setError('请先到账户管理 -> 供应商配置至少一个可用模型');
      return;
    }
    if (!selectedModel || !availableModelSet.has(selectedModel)) {
      setError('请选择供应商中已配置的可用模型');
      return;
    }
    const invalidSubagent = Object.entries(form.subagents || {}).find(([, agent]) => (
      agent.model && !availableModelSet.has(agent.model)
    ));
    if (invalidSubagent) {
      setError(`子代理 ${invalidSubagent[0]} 的模型不在供应商可用模型中`);
      return;
    }
    const selectedProviderId = providerMatch?.profile.id || resolveProviderForModel(selectedModel).profile.id;
    const crossProviderSubagent = Object.entries(form.subagents || {}).find(([, agent]) => (
      agent.model && resolveProviderForModel(agent.model).profile.id !== selectedProviderId
    ));
    if (crossProviderSubagent) {
      setError(`子代理 ${crossProviderSubagent[0]} 的模型属于另一个供应商；同一次 SDK 运行只能使用一个供应商`);
      return;
    }
    if (form.visualPreprocessDefault && !visualModel) {
      setError('默认开启视觉预处理时必须选择视觉识别模型');
      return;
    }
    if (visualModel && !availableModelSet.has(visualModel)) {
      setError('视觉识别模型不在供应商可用模型中');
      return;
    }
    const normalizedA2ARemotes = (form.a2aRemoteAgents || []).map((remote) => ({
      name: remote.name.trim(),
      agentCardUrl: remote.agentCardUrl.trim(),
      credentialRef: remote.credentialRef?.trim() || undefined,
    }));
    if (normalizedA2ARemotes.length > 16) {
      setError('每个 Agent 最多配置 16 个远程 A2A Agent');
      return;
    }
    const incompleteRemoteIndex = normalizedA2ARemotes.findIndex(remote => !remote.name || !remote.agentCardUrl);
    if (incompleteRemoteIndex >= 0) {
      setError(`远程 A2A Agent 第 ${incompleteRemoteIndex + 1} 行需要名称和 Agent Card URL`);
      return;
    }
    const invalidRemoteUrlIndex = normalizedA2ARemotes.findIndex((remote) => {
      try { new URL(remote.agentCardUrl); return false; } catch { return true; }
    });
    if (invalidRemoteUrlIndex >= 0) {
      setError(`远程 A2A Agent 第 ${invalidRemoteUrlIndex + 1} 行的 Agent Card URL 无效`);
      return;
    }
    const remoteNameKeys = normalizedA2ARemotes.map(remote => remote.name.toLocaleLowerCase('en-US'));
    if (new Set(remoteNameKeys).size !== remoteNameKeys.length) {
      setError('远程 A2A Agent 名称不能重复');
      return;
    }
    const now = Date.now();
    const selectedKnowledgeIds = (form.knowledgeSourceIds || []).filter(Boolean);
    const selectedSkills = form.skills || [];
    const hasLegacyAllKnowledge = Boolean(form.useKnowledge && selectedKnowledgeIds.length === 0 && liveKnowledgeSources.length === 0);
    const effectiveTools = selectedSkills.length > 0
      ? Array.from(new Set([...form.tools, 'Skill']))
      : form.tools;
    const saved: AgentTemplate = {
      ...form,
      id: form.id || `agent-${now}`,
      name: form.name.trim(),
      model: selectedModel,
      createdBy: form.createdBy || actor || null,
      publishedAt: form.publishedAt || null,
      archivedAt: form.archivedAt || null,
      deletedAt: form.deletedAt || null,
      knowledgeSourceIds: selectedKnowledgeIds,
      useKnowledge: selectedKnowledgeIds.length > 0 || hasLegacyAllKnowledge || undefined,
      visualPreprocessDefault: form.visualPreprocessDefault === true ? true : undefined,
      visualPreprocessModel: visualModel || undefined,
      a2aPublished: form.a2aPublished === true,
      a2aRemoteAgents: normalizedA2ARemotes,
      providerOverrides: undefined,
      tools: selectedKnowledgeIds.length > 0 || hasLegacyAllKnowledge
        ? Array.from(new Set([...effectiveTools, ...KNOWLEDGE_TOOLS]))
        : effectiveTools,
      createdAt: form.createdAt || now,
      updatedAt: now,
    };
    const nextTemplates = isEditing
      ? templates.map(t => t.id === saved.id ? saved : t)
      : [saved, ...templates];

    setIsSaving(true);
    try {
      const persisted = await replaceAgentTemplates(user.tenantId, nextTemplates);
      setTemplates(persisted);
      setForm(persisted.find((template) => template.id === saved.id) || saved);
      setIsEditing(true);
      setError('');
    } catch (saveError) {
      setError((saveError as Error).message || '保存 Agent 失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async (source: AgentTemplate) => {
    if (!user?.tenantId || !canManageTemplate(source)) return;
    const published: AgentTemplate = {
      ...source,
      createdBy: source.createdBy || actor || null,
      publishedAt: Date.now(),
      archivedAt: null,
      deletedAt: null,
      updatedAt: Date.now(),
    };
    const nextTemplates = templates.map(template => template.id === source.id ? published : template);
    setIsSaving(true);
    try {
      const persisted = await replaceAgentTemplates(user.tenantId, nextTemplates);
      setTemplates(persisted);
      setForm(current => current.id === source.id ? (persisted.find(template => template.id === source.id) || published) : current);
      setError('');
    } catch (saveError) {
      setError((saveError as Error).message || '发布 Agent 失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnpublish = async (source: AgentTemplate) => {
    if (!user?.tenantId || !canManageTemplate(source)) return;
    const unpublished: AgentTemplate = {
      ...source,
      publishedAt: null,
      updatedAt: Date.now(),
    };
    const nextTemplates = templates.map(template => template.id === source.id ? unpublished : template);
    setIsSaving(true);
    try {
      const persisted = await replaceAgentTemplates(user.tenantId, nextTemplates);
      setTemplates(persisted);
      setForm(current => current.id === source.id ? (persisted.find(template => template.id === source.id) || unpublished) : current);
      setError('');
    } catch (saveError) {
      setError((saveError as Error).message || '撤回 Agent 失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!user?.tenantId) return;
    const target = templates.find(template => template.id === id);
    if (target && !canManageTemplate(target)) {
      setError('只能删除自己创建的 Agent');
      return;
    }
    const nextTemplates = templates.filter(t => t.id !== id);
    setIsSaving(true);
    try {
      const persisted = await replaceAgentTemplates(user.tenantId, nextTemplates);
      setTemplates(persisted);
      setError('');
      if (form.id === id) {
        setForm(newTemplate());
        setIsEditing(false);
        setIsEditorOpen(false);
      }
    } catch (saveError) {
      setError((saveError as Error).message || '删除 Agent 失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleImportDirectory = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (importInputRef.current) importInputRef.current.value = '';
    if (!files.length || !user?.tenantId) return;

    setIsImporting(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('mode', 'new');
      for (const file of files) {
        formData.append('files', file, file.name);
        formData.append('relativePaths', getDirectoryRelativePath(file));
      }
      const response = await fetch('/api/agents/import', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      });
      const text = await response.text();
      let data: { template?: AgentTemplate; report?: AgentImportReport; error?: string } = {};
      if (text) {
        const trimmed = text.trimStart();
        if (trimmed.startsWith('<')) {
          throw new Error(`导入接口返回了 HTML (${response.status})，后端可能未部署 /api/agents/import 或 /api 代理指向旧服务`);
        }
        try {
          data = JSON.parse(text) as { template?: AgentTemplate; report?: AgentImportReport; error?: string };
        } catch {
          throw new Error('导入接口返回了无法解析的响应');
        }
      }
      if (!response.ok) throw new Error(data.error || `导入失败: ${response.status}`);
      if (!data.template || !data.report) throw new Error('导入响应缺少模板或报告');
      const refreshed = await bootstrapAgentTemplates(user.tenantId, user.role === 'tenant_admin');
      setTemplates(refreshed);
      const savedTemplate = refreshed.find((template) => template.id === data.template?.id) || data.template;
      setForm(savedTemplate);
      setIsEditing(true);
      setIsEditorOpen(false);
      setImportedAgent(savedTemplate);
      setImportReport(data.report);
      setIsImportReportOpen(true);
    } catch (importError) {
      setError((importError as Error).message || '导入 Agent 失败');
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportGit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user?.tenantId) return;
    const url = gitImportUrl.trim();
    const ref = gitImportRef.trim();
    if (!url) {
      setError('请输入 Git 仓库 URL');
      return;
    }

    setIsImporting(true);
    setError('');
    try {
      const response = await fetch('/api/agents/import/git', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'new', url, ref }),
      });
      const text = await response.text();
      let data: { template?: AgentTemplate; report?: AgentImportReport; error?: string } = {};
      if (text) {
        const trimmed = text.trimStart();
        if (trimmed.startsWith('<')) {
          throw new Error(`Git 导入接口返回了 HTML (${response.status})，后端可能未部署 /api/agents/import/git 或 /api 代理指向旧服务`);
        }
        try {
          data = JSON.parse(text) as { template?: AgentTemplate; report?: AgentImportReport; error?: string };
        } catch {
          throw new Error('Git 导入接口返回了无法解析的响应');
        }
      }
      if (!response.ok) throw new Error(data.error || `Git 导入失败: ${response.status}`);
      if (!data.template || !data.report) throw new Error('Git 导入响应缺少模板或报告');
      const refreshed = await bootstrapAgentTemplates(user.tenantId, user.role === 'tenant_admin');
      setTemplates(refreshed);
      const savedTemplate = refreshed.find((template) => template.id === data.template?.id) || data.template;
      setForm(savedTemplate);
      setIsEditing(true);
      setIsEditorOpen(false);
      setIsGitImportOpen(false);
      setGitImportUrl('');
      setGitImportRef('');
      setImportedAgent(savedTemplate);
      setImportReport(data.report);
      setIsImportReportOpen(true);
    } catch (importError) {
      setError((importError as Error).message || 'Git 导入 Agent 失败');
    } finally {
      setIsImporting(false);
    }
  };

  const toggleTool = (tool: string) => {
    setForm(prev => ({
      ...prev,
      tools: prev.tools.includes(tool)
        ? prev.tools.filter(t => t !== tool)
        : [...prev.tools, tool],
    }));
  };

  const toggleKnowledgeSource = (sourceId: string) => {
    setForm(prev => ({
      ...prev,
      knowledgeSourceIds: (prev.knowledgeSourceIds || []).includes(sourceId)
        ? (prev.knowledgeSourceIds || []).filter(id => id !== sourceId)
        : [...(prev.knowledgeSourceIds || []), sourceId],
    }));
  };

  const addSubagent = () => {
    setForm(prev => {
      const count = Object.keys(prev.subagents || {}).length + 1;
      return {
        ...prev,
        tools: prev.tools.includes('Agent') ? prev.tools : [...prev.tools, 'Agent'],
        subagents: {
          ...(prev.subagents || {}),
          [`worker-${count}`]: defaultSubagent(),
        },
      };
    });
  };

  const renameSubagent = (oldName: string, nextName: string) => {
    const cleanName = nextName.trim();
    if (!cleanName || cleanName === oldName) return;
    setForm(prev => {
      const subagents = { ...(prev.subagents || {}) };
      if (!subagents[oldName] || subagents[cleanName]) return prev;
      subagents[cleanName] = subagents[oldName];
      delete subagents[oldName];
      return { ...prev, subagents };
    });
  };

  const updateSubagent = (name: string, patch: Partial<AgentDefinition>) => {
    setForm(prev => ({
      ...prev,
      subagents: {
        ...(prev.subagents || {}),
        [name]: { ...(prev.subagents || {})[name], ...patch },
      },
    }));
  };

  const deleteSubagent = (name: string) => {
    setForm(prev => {
      const subagents = { ...(prev.subagents || {}) };
      delete subagents[name];
      return { ...prev, subagents };
    });
  };

  const toggleMcp = (srv: string) => {
    setForm(prev => ({
      ...prev,
      mcpServers: prev.mcpServers.includes(srv)
        ? prev.mcpServers.filter(s => s !== srv)
        : [...prev.mcpServers, srv],
    }));
  };

  const toggleEventSource = (name: string) => {
    setForm(prev => ({
      ...prev,
      eventSources: (prev.eventSources || []).includes(name)
        ? (prev.eventSources || []).filter(s => s !== name)
        : [...(prev.eventSources || []), name],
    }));
  };

  const toggleSkill = (skill: string) => {
    setForm(prev => ({
      ...prev,
      skills: (prev.skills || []).includes(skill)
        ? (prev.skills || []).filter(s => s !== skill)
        : [...(prev.skills || []), skill],
    }));
  };

  const openClaudeMdPreview = async (agent: AgentTemplate) => {
    setPreviewAgent(agent);
    setClaudeMdPreview(null);
    setPreviewError('');
    setIsPreviewOpen(true);
    setIsPreviewLoading(true);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/claude-md`, {
        headers: getAuthHeaders(),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const message = data && typeof data === 'object' && 'error' in data
          ? String((data as { error?: unknown }).error || '读取 CLAUDE.md 失败')
          : `HTTP ${response.status}`;
        throw new Error(message);
      }
      setClaudeMdPreview(data as ClaudeMdPreview);
    } catch (previewLoadError) {
      setPreviewError((previewLoadError as Error).message || '读取 CLAUDE.md 失败');
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const startChat = (agentId: string) => {
    navigate(`/conversations?agent=${encodeURIComponent(agentId)}`);
  };

  const formatBytes = (bytes?: number) => {
    if (!Number.isFinite(bytes)) return '';
    if ((bytes || 0) < 1024) return `${bytes} B`;
    return `${Math.round((bytes || 0) / 1024)} KB`;
  };

  const getPopularity = (template: AgentTemplate) => ({
    runCount: Math.max(0, Math.floor(Number(template.popularity?.runCount) || 0)),
    lastRunAt: Number(template.popularity?.lastRunAt) || null,
  });

  const getTemplateSearchText = (template: AgentTemplate) => [
    template.name,
    template.description,
    template.systemPrompt,
    template.model,
    ...(template.tools || []),
    ...(template.skills || []),
    ...(template.mcpServers || []),
    ...(template.eventSources || []),
    ...(template.a2aRemoteAgents || []).flatMap(remote => [remote.name, remote.agentCardUrl]),
  ].join(' ').toLowerCase();

  const matchesMarketSearch = (template: AgentTemplate) => (
    !normalizedMarketSearch || getTemplateSearchText(template).includes(normalizedMarketSearch)
  );

  const compareTemplates = (a: AgentTemplate, b: AgentTemplate) => {
    if (marketSort === 'name') return (a.name || '').localeCompare(b.name || '', 'zh-CN');
    if (marketSort === 'updated') return (b.updatedAt || 0) - (a.updatedAt || 0);
    const aPopularity = getPopularity(a);
    const bPopularity = getPopularity(b);
    return bPopularity.runCount - aPopularity.runCount
      || (bPopularity.lastRunAt || 0) - (aPopularity.lastRunAt || 0)
      || (b.updatedAt || 0) - (a.updatedAt || 0);
  };

  const visiblePublicTemplates = publicTemplates.filter(matchesMarketSearch).sort(compareTemplates);
  const visibleMineTemplates = mineTemplates.filter(matchesMarketSearch).sort(compareTemplates);
  const hasMarketSearch = normalizedMarketSearch.length > 0;

  const renderTemplateCard = (t: AgentTemplate, scope: 'public' | 'mine') => {
    const manageable = canManageTemplate(t);
    const published = isPublishedAgent(t);
    const popularity = getPopularity(t);
    const ownerLabel = t.createdBy
      ? (t.createdBy === actor ? '你创建' : `创建人 ${t.createdBy}`)
      : '创建人未知';
    const lastRunLabel = popularity.lastRunAt ? `最近使用 ${new Date(popularity.lastRunAt).toLocaleString()}` : '暂无使用记录';
    const summary = (t.description || t.systemPrompt.slice(0, 140)).trim() || '暂无描述';
    const knowledgeCount = (t.knowledgeSourceIds || []).length || (t.useKnowledge ? liveKnowledgeSources.filter(source => source.enabled).length : 0);
    const featureBadges = [
      t.a2aPublished ? 'A2A 已发布' : '',
      (t.a2aRemoteAgents || []).length > 0 ? `远程 A2A×${t.a2aRemoteAgents.length}` : '',
      knowledgeCount > 0 ? `知识库×${knowledgeCount || '全部'}` : '',
      t.visualPreprocessDefault ? '视觉预处理' : '',
      (t.skills || []).includes('agentma-visual') && !t.visualPreprocessDefault ? '可视化' : '',
    ].filter(Boolean).slice(0, 3);
    return (
      <div
        key={`${scope}-${t.id}`}
        className={`agent-card ${form.id === t.id ? 'selected' : ''} ${manageable ? '' : 'agent-card-readonly'}`}
        onClick={() => manageable ? handleSelect(t) : undefined}
        style={{ cursor: manageable ? 'pointer' : 'default' }}
      >
        <div className="agent-card-head">
          <div className="agent-card-title-block">
            <div className="agent-card-name-row">
              <span className="agent-card-mark" aria-hidden="true">
                <LineIcon name="agents" />
              </span>
              <div className="agent-card-name">{t.name || '未命名 Agent'}</div>
            </div>
            <div className="agent-card-owner">{ownerLabel}</div>
          </div>
          <div className="agent-card-meta">
            <span className={`badge ${published ? 'badge-success' : 'badge-muted'}`}>{published ? '公共' : '个人'}</span>
            <span
              className={`badge ${popularity.runCount > 0 ? 'badge-warning' : 'badge-muted'}`}
              title={lastRunLabel}
            >
              使用 {popularity.runCount} 次
            </span>
            <span className="agent-card-date">{new Date(t.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
        <div className="agent-card-desc">{summary}</div>
        {featureBadges.length > 0 && (
          <div className="agent-card-tags">
            {featureBadges.map(badge => (
              <span key={badge} className="badge badge-info">{badge}</span>
            ))}
          </div>
        )}
        <div className="agent-card-actions" aria-label={`${t.name || 'Agent'} 操作`}>
          <button
            type="button"
            className="btn btn-sm agent-card-preview-btn"
            onClick={(event) => {
              event.stopPropagation();
              void openClaudeMdPreview(t);
            }}
            disabled={isSaving || !t.id}
            title={`预览 ${t.name} 运行时生效的 CLAUDE.md`}
          >
            <LineIcon name="book" />
            预览
          </button>
          <button
            type="button"
            className="btn btn-sm agent-card-clone-btn"
            onClick={(event) => {
              event.stopPropagation();
              void handleClone(t);
            }}
            disabled={isSaving || !t.id}
            title={`克隆 ${t.name} 为新 Agent 模板`}
          >
            <LineIcon name="copy" />
            克隆
          </button>
          {manageable && (
            <>
              {published ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleUnpublish(t);
                  }}
                  disabled={isSaving || !t.id}
                >
                  <LineIcon name="radio" />
                  下线
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handlePublish(t);
                  }}
                  disabled={isSaving || !t.id}
                >
                  <LineIcon name="radio" />
                  发布
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary agent-card-chat-btn"
            onClick={(event) => {
              event.stopPropagation();
              startChat(t.id);
            }}
            disabled={isSaving || !t.id}
            title={`和 ${t.name} 开始对话`}
          >
            <LineIcon name="chat" />
            对话
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="page-header agents-page-header">
        <h1 className="agents-page-title">
          <span className="agents-page-title-icon" aria-hidden="true">
            <LineIcon name="market" />
          </span>
          Agent 模板
        </h1>
        <p>公共模板与个人模板分区管理，配置工具和技能后即可开启对话。</p>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <div className="agents-page-shell">
        {/* 模板列表 */}
        <div className="agents-list-panel">
          <div className="agents-list-toolbar mb-4">
            <button className="btn btn-primary" onClick={handleNew} disabled={isSaving || isImporting}>
              <LineIcon name="spark" />
              新建 Agent
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => importInputRef.current?.click()}
              disabled={isSaving || isImporting}
            >
              <LineIcon name="layers" />
              {isImporting ? '导入中...' : '导入本地项目'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setIsGitImportOpen(true)}
              disabled={isSaving || isImporting}
            >
              <LineIcon name="radio" />
              Git 导入
            </button>
            <div className="agents-market-controls" role="search">
              <input
                value={marketSearch}
                onChange={event => setMarketSearch(event.target.value)}
                placeholder="搜索 Agent 名称、描述、工具、技能"
                aria-label="搜索 Agent"
              />
              <select
                value={marketSort}
                onChange={event => setMarketSort(event.target.value as AgentMarketSort)}
                aria-label="Agent 排序"
              >
                <option value="popular">热度优先</option>
                <option value="updated">最近更新</option>
                <option value="name">名称</option>
              </select>
            </div>
            <input
              ref={importInputRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              style={{ display: 'none' }}
              onChange={event => { void handleImportDirectory(event.target.files); }}
            />
          </div>

          {isLoading && templates.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40 }}>
              加载中...
            </div>
          ) : templates.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40 }}>
              暂无 Agent，点击上方按钮创建
            </div>
          ) : (
            <div className="agents-market-sections">
              <section className="agents-market-section">
                <div className="agents-section-head">
                  <div>
                    <div className="card-header" style={{ marginBottom: 3 }}>公共 Agent</div>
                    <div className="tool-card-desc">
                      已发布 {publicTemplates.length} 个{hasMarketSearch ? `，匹配 ${visiblePublicTemplates.length} 个` : ''}，租户内成员都可以看到并使用。
                    </div>
                  </div>
                </div>
                {visiblePublicTemplates.length === 0 ? (
                  <div className="agents-empty-panel">
                    {hasMarketSearch ? '公共区没有匹配的 Agent。' : '还没有公共 Agent。可以从“我的 Agent”发布一个。'}
                  </div>
                ) : (
                  <div className="agents-list-grid">
                    {visiblePublicTemplates.map(template => renderTemplateCard(template, 'public'))}
                  </div>
                )}
              </section>

              <section className="agents-market-section">
                <div className="agents-section-head">
                  <div>
                    <div className="card-header" style={{ marginBottom: 3 }}>我的 Agent</div>
                    <div className="tool-card-desc">
                      已拥有 {mineTemplates.length} 个{hasMarketSearch ? `，匹配 ${visibleMineTemplates.length} 个` : ''}。未发布的 Agent 只有创建人可见；发布后会出现在公共 Agent 中。
                      {hiddenTemplateCount > 0 ? ` 另有 ${hiddenTemplateCount} 个不可编辑的公共项仅显示在上方。` : ''}
                    </div>
                  </div>
                </div>
                {visibleMineTemplates.length === 0 ? (
                  <div className="agents-empty-panel">
                    {hasMarketSearch ? '我的列表里没有匹配的 Agent。' : '暂无个人 Agent，点击上方按钮创建或克隆公共 Agent。'}
                  </div>
                ) : (
                  <div className="agents-list-grid">
                    {visibleMineTemplates.map(template => renderTemplateCard(template, 'mine'))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {isPreviewOpen && (
        <div className="agents-preview-backdrop" onClick={() => setIsPreviewOpen(false)}>
          <section
            className="agents-preview-panel card"
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${previewAgent?.name || 'Agent'} 的 CLAUDE.md`}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex-between agents-preview-head">
              <div>
                <div className="card-header" style={{ marginBottom: 2 }}>
                  {previewAgent?.name || claudeMdPreview?.agentName || 'Agent'} · CLAUDE.md
                </div>
                <div className="agents-preview-subtitle">
                  真实运行时文件系统说明预览
                </div>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setIsPreviewOpen(false)}>
                关闭
              </button>
            </div>

            {isPreviewLoading ? (
              <div className="agents-preview-empty">读取运行时 CLAUDE.md...</div>
            ) : previewError ? (
              <div className="agents-preview-error">{previewError}</div>
            ) : claudeMdPreview && (
              <div className="agents-preview-body">
                <div className="agents-preview-meta">
                  <div>
                    <span className="agents-preview-meta-label">cwd</span>
                    <code>{claudeMdPreview.cwd}</code>
                  </div>
                  <div>
                    <span className="agents-preview-meta-label">来源</span>
                    <span>
                      {claudeMdPreview.cwdSource === 'latest_session'
                        ? '最近运行会话'
                        : claudeMdPreview.cwdSource === 'template_seed'
                          ? '模板 seed 仓'
                          : '新会话默认临时目录'}
                      {claudeMdPreview.cwdExists ? '' : ' · 当前不存在'}
                    </span>
                  </div>
                  {claudeMdPreview.latestSession && (
                    <div>
                      <span className="agents-preview-meta-label">会话</span>
                      <span>
                        {claudeMdPreview.latestSession.title} · {new Date(claudeMdPreview.latestSession.updatedAt).toLocaleString()}
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="agents-preview-meta-label">settingSources</span>
                    <span>{claudeMdPreview.settingSources.join(', ')}</span>
                  </div>
                </div>

                <div className="agents-preview-files">
                  {claudeMdPreview.files.map(file => (
                    <div key={file.path} className={`agents-preview-file ${file.exists ? 'loaded' : 'missing'}`}>
                      <div className="agents-preview-file-main">
                        <span className={`badge ${file.exists ? 'badge-success' : 'badge-muted'}`}>
                          {file.exists ? '已命中' : '缺失'}
                        </span>
                        <span className="agents-preview-file-label">{file.label}</span>
                        {file.bytes !== undefined && <span className="agents-preview-file-size">{formatBytes(file.bytes)}</span>}
                        {file.error && <span className="badge badge-warning">{file.error}</span>}
                      </div>
                      <code>{file.path}</code>
                    </div>
                  ))}
                </div>

                {claudeMdPreview.notes.length > 0 && (
                  <div className="agents-preview-notes">
                    {claudeMdPreview.notes.map(note => <div key={note}>{note}</div>)}
                  </div>
                )}

                <div>
                  <div className="agents-preview-section-title">
                    合并预览 · {claudeMdPreview.loadedFiles.length} 个文件
                  </div>
                  {claudeMdPreview.effectiveContent ? (
                    <pre className="agents-preview-content">{claudeMdPreview.effectiveContent}</pre>
                  ) : (
                    <div className="agents-preview-empty">
                      没有找到会被加载的 CLAUDE.md 文件。
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {isGitImportOpen && (
        <div
          className="agents-preview-backdrop"
          onClick={() => { if (!isImporting) setIsGitImportOpen(false); }}
        >
          <section
            className="agents-preview-panel card"
            style={{ width: 'min(560px, calc(100vw - 40px))' }}
            role="dialog"
            aria-modal="true"
            aria-label="Git 导入 Agent"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex-between agents-preview-head">
              <div>
                <div className="card-header" style={{ marginBottom: 2 }}>Git 导入 Agent</div>
                <div className="agents-preview-subtitle">从公开 HTTPS 仓库创建 Agent 模板 seed</div>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setIsGitImportOpen(false)}
                disabled={isImporting}
              >
                关闭
              </button>
            </div>

            <form className="agents-preview-body" onSubmit={handleImportGit}>
              <div>
                <label htmlFor="agent-git-import-url">仓库 URL</label>
                <input
                  id="agent-git-import-url"
                  value={gitImportUrl}
                  onChange={event => setGitImportUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  autoFocus
                  disabled={isImporting}
                />
              </div>
              <div>
                <label htmlFor="agent-git-import-ref">Branch / Tag / Ref</label>
                <input
                  id="agent-git-import-ref"
                  value={gitImportRef}
                  onChange={event => setGitImportRef(event.target.value)}
                  placeholder="main"
                  disabled={isImporting}
                />
              </div>
              <div className="agents-preview-notes">
                仅支持公开 https:// 仓库；token、SSH、私有仓库凭据留到后续版本。
              </div>
              <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setIsGitImportOpen(false)}
                  disabled={isImporting}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isImporting || !gitImportUrl.trim()}
                >
                  <LineIcon name="radio" />
                  {isImporting ? '导入中...' : '开始导入'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {isImportReportOpen && importReport && (
        <div className="agents-preview-backdrop" onClick={() => setIsImportReportOpen(false)}>
          <section
            className="agents-preview-panel card"
            role="dialog"
            aria-modal="true"
            aria-label="Agent 导入报告"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex-between agents-preview-head">
              <div>
                <div className="card-header" style={{ marginBottom: 2 }}>
                  {importedAgent?.name || 'Imported Agent'} · 导入报告
                </div>
                <div className="agents-preview-subtitle">
                  模板 seed 已写入，后续新会话会在首跑复制到 workspace cwd
                </div>
              </div>
              <div className="flex gap-2">
                {importedAgent?.id && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => startChat(importedAgent.id)}>
                    开始对话
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setIsImportReportOpen(false)}>
                  关闭
                </button>
              </div>
            </div>

            <div className="agents-preview-body">
              <div className="agents-preview-meta">
                <div>
                  <span className="agents-preview-meta-label">templateId</span>
                  <code>{importReport.templateId}</code>
                </div>
                <div>
                  <span className="agents-preview-meta-label">seedDir</span>
                  <code>{importReport.seedDir}</code>
                </div>
                <div>
                  <span className="agents-preview-meta-label">unpacked</span>
                  <span>{importReport.unpacked.length} 个文件</span>
                </div>
                <div>
                  <span className="agents-preview-meta-label">skipped</span>
                  <span>{importReport.skipped.length} 个文件</span>
                </div>
              </div>

              <div className="agents-import-detected">
                <span className="badge badge-success">CLAUDE.md {importReport.detected.claudeMd ? '已检测' : '未检测'}</span>
                {importReport.detected.agents.map(name => <span key={`agent-${name}`} className="badge badge-info">agent: {name}</span>)}
                {importReport.detected.skills.map(name => <span key={`skill-${name}`} className="badge badge-info">skill: {name}</span>)}
                {importReport.detected.remoteMcp.map(name => <span key={`mcp-${name}`} className="badge badge-success">remote MCP: {name}</span>)}
                {!importReport.detected.agents.length && !importReport.detected.skills.length && !importReport.detected.remoteMcp.length && !importReport.detected.claudeMd && (
                  <span className="badge badge-muted">未检测到 Claude Code 专用文件</span>
                )}
              </div>

              {(importReport.disabled.hooks.length > 0 || importReport.disabled.stdioMcp.length > 0) && (
                <div className="agents-preview-notes">
                  {importReport.disabled.hooks.length > 0 && (
                    <div>已禁用 hooks: {importReport.disabled.hooks.join(', ')}</div>
                  )}
                  {importReport.disabled.stdioMcp.length > 0 && (
                    <div>已剥离 stdio MCP: {importReport.disabled.stdioMcp.join(', ')}</div>
                  )}
                </div>
              )}

              {importReport.notes.length > 0 && (
                <div className="agents-preview-notes">
                  {importReport.notes.map(note => <div key={note}>{note}</div>)}
                </div>
              )}

              {importReport.unpacked.length > 0 && (
                <div>
                  <div className="agents-preview-section-title">已解包文件</div>
                  <div className="agents-import-file-list">
                    {importReport.unpacked.slice(0, 80).map(file => (
                      <div key={file.path} className="agents-import-file-row">
                        <span className="badge badge-muted">{file.category}</span>
                        <code>{file.path}</code>
                        <span>{formatBytes(file.bytes)}</span>
                      </div>
                    ))}
                    {importReport.unpacked.length > 80 && (
                      <div className="agents-import-file-row muted">
                        还有 {importReport.unpacked.length - 80} 个文件未显示
                      </div>
                    )}
                  </div>
                </div>
              )}

              {importReport.skipped.length > 0 && (
                <div>
                  <div className="agents-preview-section-title">已跳过</div>
                  <div className="agents-import-file-list">
                    {importReport.skipped.slice(0, 40).map(file => (
                      <div key={`${file.path}-${file.reason}`} className="agents-import-file-row skipped">
                        <code>{file.path}</code>
                        <span>{file.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {isEditorOpen && (
        <div className="agents-editor-backdrop" onClick={() => setIsEditorOpen(false)}>
          <aside
            className="agents-editor-panel card"
            role="dialog"
            aria-modal="true"
            aria-label={isEditing ? `编辑 Agent ${form.name}` : '新建 Agent'}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex-between mb-4 agents-editor-head">
              <div className="card-header" style={{ marginBottom: 0 }}>
                {isEditing ? `编辑: ${form.name}` : '新建 Agent'}
              </div>
              <div className="flex gap-2">
                {isEditing && (
                  <button className="btn btn-sm btn-danger" onClick={() => { void handleDelete(form.id); }} disabled={isSaving}>删除</button>
                )}
                <button className="btn btn-sm btn-primary" onClick={() => { void handleSave(); }} disabled={isSaving}>
                  {isSaving ? '保存中...' : '保存'}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setIsEditorOpen(false)} disabled={isSaving}>
                  关闭
                </button>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label>名称 *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如：代码审查助手" />
              </div>
              <div className="form-group">
                <label>描述</label>
                <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="简要描述这个 Agent 的功能" />
              </div>
            </div>

            <div className="form-group">
              <label>System Prompt（系统提示词）</label>
              <textarea
                value={form.systemPrompt}
                onChange={e => setForm({ ...form, systemPrompt: e.target.value })}
                rows={8}
                placeholder="你是一位资深的...&#10;&#10;请遵循以下规则：&#10;1. ..."
                style={{ resize: 'vertical' }}
              />
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="flex gap-2" style={{ alignItems: 'center' }}>
                  模型
                  {selectedModelAvailable && providerMatch
                    ? <span className="badge badge-muted">{providerMatch.profile.name}</span>
                    : <span className="badge badge-warning">{selectedModel ? '不可用' : '必选'}</span>}
                </label>
                <ModelPicker
                  value={form.model}
                  models={modelSuggestions}
                  onChange={model => setForm({ ...form, model })}
                  placeholder="输入或选择模型"
                />
              </div>
              <div className="form-group">
                <label>maxTurns</label>
                <input type="number" value={form.maxTurns} onChange={e => setForm({ ...form, maxTurns: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label>权限模式</label>
                <select value={form.permissionMode} onChange={e => setForm({ ...form, permissionMode: e.target.value as PermissionMode })}>
                  {PERMISSION_MODES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label className="flex gap-2" style={{ alignItems: 'center' }}>
                  视觉识别模型
                  {visualModel
                    ? visualModelAvailable && visualProviderMatch
                      ? <span className="badge badge-muted">{visualProviderMatch.profile.name}</span>
                      : <span className="badge badge-warning">不可用</span>
                    : <span className="badge badge-muted">未配置</span>}
                </label>
                <ModelPicker
                  value={form.visualPreprocessModel || ''}
                  models={modelSuggestions}
                  onChange={model => setForm({ ...form, visualPreprocessModel: model || undefined })}
                  placeholder="选择视觉模型"
                />
              </div>
              <div className="form-group">
                <label>视觉预处理</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 38 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(form.visualPreprocessDefault)}
                    onChange={e => setForm({ ...form, visualPreprocessDefault: e.target.checked || undefined })}
                    style={{ width: 'auto' }}
                  />
                  <span style={{ fontSize: '.85em' }}>新会话默认开启</span>
                </label>
              </div>
            </div>

            {/* 结构化输出 */}
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '.82em', color: 'var(--ink-secondary)', marginBottom: 8 }}>
                结构化输出 (outputSchema) {form.outputSchema ? '✓' : '— 可选'}
              </summary>
              <div className="form-group">
                <label>JSON Schema（留空 = 纯文本输出）</label>
                <textarea
                  rows={6}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '.76em', resize: 'vertical' }}
                  placeholder={'{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" },\n    "summary": { "type": "string" }\n  },\n  "required": ["title", "summary"]\n}'}
                  value={form.outputSchema ? JSON.stringify(form.outputSchema, null, 2) : ''}
                  onChange={e => {
                    const raw = e.target.value.trim();
                    if (!raw) { setForm({ ...form, outputSchema: undefined }); return; }
                    try { setForm({ ...form, outputSchema: JSON.parse(raw) }); } catch { /* keep existing until valid */ }
                  }}
                />
                {form.outputSchema && (
                  <div style={{ fontSize: '.72em', color: 'var(--success)', marginTop: 4 }}>schema 有效，运行时启用结构化输出</div>
                )}
              </div>
            </details>

            {/* 文件检查点 */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={Boolean(form.enableFileCheckpointing)}
                onChange={e => setForm({ ...form, enableFileCheckpointing: e.target.checked || undefined })}
                style={{ width: 'auto' }}
              />
              <span style={{ fontSize: '.85em' }}>
                enableFileCheckpointing — 编辑前快照文件，支持 /rewind 回滚
              </span>
            </label>

            <A2AConfigEditor
              key={user?.tenantId || 'signed-out'}
              templateId={form.id}
              published={form.a2aPublished === true}
              remoteAgents={form.a2aRemoteAgents || []}
              canManageCredentials={user?.role === 'tenant_admin'}
              onPublishedChange={a2aPublished => setForm(current => ({ ...current, a2aPublished }))}
              onRemoteAgentsChange={a2aRemoteAgents => setForm(current => ({ ...current, a2aRemoteAgents }))}
            />

            {/* 知识库选择 */}
            <div className="form-group">
              <label>
                知识库 (Knowledge) — 已选 {(form.knowledgeSourceIds || []).length} 个 ·{' '}
                <a href="/knowledge" style={{ color: 'var(--accent)', fontSize: '.85em' }}>管理知识库</a>
              </label>
              {liveKnowledgeSources.length > 0 && (
                <div style={{ color: 'var(--ink-muted)', fontSize: '.74em', margin: '2px 0 8px' }}>
                  🔒 默认只读：仅当你是该知识库的创建人、且在知识库页面关闭了「只读」时，你的 Agent 才能写入；其他成员始终只读。
                </div>
              )}
              {liveKnowledgeSources.length === 0 ? (
                <div style={{ color: 'var(--ink-muted)', fontSize: '.78em', padding: '8px 0' }}>
                  暂无知识库，请先在知识库页面创建。
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {liveKnowledgeSources.map(source => {
                    const selected = (form.knowledgeSourceIds || []).includes(source.id);
                    return (
                      <label
                        key={source.id}
                        title={source.path}
                        style={{
                          display: 'inline-grid',
                          gridTemplateColumns: 'auto minmax(0, 1fr)',
                          alignItems: 'start',
                          gap: 6,
                          padding: '6px 9px',
                          borderRadius: 4,
                          fontSize: '.76em',
                          cursor: source.enabled || selected ? 'pointer' : 'not-allowed',
                          background: selected ? 'var(--success-bg)' : 'var(--bg-hover)',
                          color: selected ? 'var(--success)' : 'var(--ink-secondary)',
                          border: `1px solid ${selected ? 'var(--success)' : 'transparent'}`,
                          opacity: source.enabled ? 1 : .5,
                          maxWidth: 340,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleKnowledgeSource(source.id)}
                          disabled={!source.enabled && !selected}
                          style={{ width: 'auto', margin: '2px 0 0' }}
                        />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700 }}>{source.name}</span>
                          <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.8em', color: 'inherit', opacity: .72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {source.path}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 工具选择 */}
            <div className="form-group">
              <label>启用的工具 (tools: string[]) — 已选 {form.tools.length} 个</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {TOOL_CATEGORIES.map(cat => (
                  <div key={cat.name}>
                    <div style={{ fontSize: '.72em', fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 4, textTransform: 'uppercase' }}>
                      {cat.label}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {cat.tools.map(tool => (
                        <label
                          key={tool}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px', borderRadius: 4,
                            fontSize: '.76em', cursor: 'pointer',
                            background: form.tools.includes(tool) ? 'var(--accent-bg)' : 'var(--bg-hover)',
                            color: form.tools.includes(tool) ? 'var(--accent)' : 'var(--ink-secondary)',
                            border: `1px solid ${form.tools.includes(tool) ? 'var(--accent)' : 'transparent'}`,
                          }}
                        >
                          <input
                            type="checkbox" checked={form.tools.includes(tool)}
                            onChange={() => toggleTool(tool)}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          {tool}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {/* 自定义工具（动态加载，和内置工具混在一起） */}
                {liveCustomTools.length > 0 && (
                  <div>
                    <div style={{ fontSize: '.72em', fontWeight: 600, color: 'var(--success)', marginBottom: 4, textTransform: 'uppercase' }}>
                      自定义 · <a href="/tools" style={{ color: 'var(--accent)', fontWeight: 400, textTransform: 'none' }}>管理</a>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {liveCustomTools.map(tool => (
                        <label
                          key={tool.name}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px', borderRadius: 4,
                            fontSize: '.76em', cursor: 'pointer',
                            background: form.tools.includes(tool.name) ? 'var(--accent-bg)' : 'var(--bg-hover)',
                            color: form.tools.includes(tool.name) ? 'var(--accent)' : 'var(--ink-secondary)',
                            border: `1px solid ${form.tools.includes(tool.name) ? 'var(--accent)' : 'transparent'}`,
                          }}
                        >
                          <input
                            type="checkbox" checked={form.tools.includes(tool.name)}
                            onChange={() => toggleTool(tool.name)}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          {tool.name}
                          {tool.endpoint && <span style={{ fontSize: '.8em', opacity: .6 }}>🔗</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {liveInternalTools.length > 0 && (
                  <div>
                    <div style={{ fontSize: '.72em', fontWeight: 600, color: 'var(--info)', marginBottom: 4, textTransform: 'uppercase' }}>
                      内部 · <a href="/tools" style={{ color: 'var(--accent)', fontWeight: 400, textTransform: 'none' }}>查看</a>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {liveInternalTools.map(tool => (
                        <label
                          key={tool.name}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px', borderRadius: 4,
                            fontSize: '.76em', cursor: 'pointer',
                            background: form.tools.includes(tool.name) ? 'var(--accent-bg)' : 'var(--bg-hover)',
                            color: form.tools.includes(tool.name) ? 'var(--accent)' : 'var(--ink-secondary)',
                            border: `1px solid ${form.tools.includes(tool.name) ? 'var(--accent)' : 'transparent'}`,
                          }}
                          title={tool.description}
                        >
                          <input
                            type="checkbox" checked={form.tools.includes(tool.name)}
                            onChange={() => toggleTool(tool.name)}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          {tool.name}
                          <span style={{ fontSize: '.8em', opacity: .6 }}>MCP</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 子代理定义 */}
            <div className="form-group">
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <label style={{ marginBottom: 0 }}>子代理 (SDK agents) — 已定义 {subagentEntries.length} 个</label>
                <button type="button" className="btn btn-sm btn-primary" onClick={addSubagent}>
                  + 子代理
                </button>
              </div>
              {subagentEntries.length === 0 ? (
                <div style={{ color: 'var(--ink-muted)', fontSize: '.78em', padding: '8px 0' }}>
                  添加后会自动启用 Agent 工具，运行时通过 SDK Agent tool 调用。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {subagentEntries.map(([name, agent]) => (
                    <div key={name} className="tool-card" style={{ padding: 12 }}>
                      <div className="grid-2">
                        <div className="form-group" style={{ marginBottom: 8 }}>
                          <label>名称</label>
                          <input
                            defaultValue={name}
                            onBlur={e => renameSubagent(name, e.target.value)}
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 8 }}>
                          <label>模型覆盖</label>
                          <ModelPicker
                            value={agent.model || ''}
                            models={modelSuggestions}
                            onChange={model => updateSubagent(name, { model: model || undefined })}
                            allowEmpty
                            placeholder="留空继承主模型"
                          />
                        </div>
                      </div>
                      <div className="form-group" style={{ marginBottom: 8 }}>
                        <label>description</label>
                        <input
                          value={agent.description}
                          onChange={e => updateSubagent(name, { description: e.target.value })}
                          placeholder="何时使用这个子代理"
                        />
                      </div>
                      <div className="form-group" style={{ marginBottom: 8 }}>
                        <label>prompt</label>
                        <textarea
                          value={agent.prompt}
                          onChange={e => updateSubagent(name, { prompt: e.target.value })}
                          rows={2}
                          placeholder="子代理系统提示词"
                          style={{ resize: 'vertical' }}
                        />
                      </div>
                      <div className="grid-2">
                        <div className="form-group" style={{ marginBottom: 8 }}>
                          <label>tools</label>
                          <input
                            value={(agent.tools || []).join(', ')}
                            onChange={e => updateSubagent(name, { tools: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
                            placeholder="Read, Grep, Glob"
                            style={{ fontFamily: 'var(--font-mono)' }}
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 8 }}>
                          <label>maxTurns</label>
                          <input
                            type="number"
                            value={agent.maxTurns || ''}
                            onChange={e => updateSubagent(name, { maxTurns: Number(e.target.value) || undefined })}
                            placeholder="继承默认"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 8 }}>
                          <label>effort</label>
                          <select value={agent.effort || ''} onChange={e => updateSubagent(name, { effort: e.target.value as EffortLevel || undefined })}>
                            <option value="">继承</option>
                            {EFFORT_LEVELS.map(e => <option key={e.value} value={e.value}>{e.label} ({e.value})</option>)}
                          </select>
                        </div>
                        <div className="form-group" style={{ marginBottom: 8 }}>
                          <label>权限模式</label>
                          <select value={agent.permissionMode || ''} onChange={e => updateSubagent(name, { permissionMode: e.target.value as PermissionMode || undefined })}>
                            <option value="">继承</option>
                            {PERMISSION_MODES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="flex-between">
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0, fontSize: '.78em' }}>
                          <input
                            type="checkbox"
                            checked={Boolean(agent.background)}
                            onChange={e => updateSubagent(name, { background: e.target.checked || undefined })}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          background
                        </label>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => deleteSubagent(name)}>
                          删除子代理
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 技能选择 */}
            {liveSkills.length > 0 && (
              <div className="form-group">
                <label>技能 (Skills) — 已选 {(form.skills || []).length} 个 · <a href="/skills" style={{ color: 'var(--accent)', fontSize: '.85em' }}>管理技能</a></label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {liveSkills.map(skill => (
                    <label
                      key={skill.name}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '3px 8px', borderRadius: 4,
                        fontSize: '.76em', cursor: 'pointer',
                        background: (form.skills || []).includes(skill.name) ? 'var(--accent-bg)' : 'var(--bg-hover)',
                        color: (form.skills || []).includes(skill.name) ? 'var(--accent)' : 'var(--ink-secondary)',
                        border: `1px solid ${(form.skills || []).includes(skill.name) ? 'var(--accent)' : 'transparent'}`,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={(form.skills || []).includes(skill.name)}
                        onChange={() => toggleSkill(skill.name)}
                        style={{ width: 'auto', margin: 0 }}
                      />
                      {skill.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* MCP 服务器选择 */}
            <div className="form-group">
              <label>MCP 服务器 · <a href="/tools" style={{ color: 'var(--accent)', fontSize: '.85em' }}>管理</a></label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {liveMcp.map(srv => (
                  <label
                    key={srv.name}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', borderRadius: 4,
                      fontSize: '.76em', cursor: 'pointer',
                      background: form.mcpServers.includes(srv.name) ? 'var(--info-bg)' : 'var(--bg-hover)',
                      color: form.mcpServers.includes(srv.name) ? 'var(--info)' : 'var(--ink-secondary)',
                      border: `1px solid ${form.mcpServers.includes(srv.name) ? 'var(--info)' : 'transparent'}`,
                    }}
                  >
                    <input
                      type="checkbox" checked={form.mcpServers.includes(srv.name)}
                      onChange={() => toggleMcp(srv.name)}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    {srv.name}
                  </label>
                ))}
                {liveMcp.length === 0 && (
                  <span style={{ fontSize: '.76em', color: 'var(--ink-muted)' }}>暂无自定义 MCP 服务器，显示默认列表</span>
                )}
              </div>
            </div>

            {/* 事件订阅 (EventSource) */}
            {liveEventSources.length > 0 && (
              <div className="form-group">
                <label>📡 事件订阅 (EventSource) · 已选 {(form.eventSources || []).length} 个</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {liveEventSources.map(es => (
                    <label
                      key={es.name}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '3px 8px', borderRadius: 4, fontSize: '.76em', cursor: 'pointer',
                        background: (form.eventSources || []).includes(es.name) ? 'var(--accent-bg)' : 'var(--bg-hover)',
                        color: (form.eventSources || []).includes(es.name) ? 'var(--accent)' : 'var(--ink-secondary)',
                        border: `1px solid ${(form.eventSources || []).includes(es.name) ? 'var(--accent)' : 'transparent'}`,
                      }}
                    >
                      <input type="checkbox" checked={(form.eventSources || []).includes(es.name)}
                        onChange={() => toggleEventSource(es.name)} style={{ width: 'auto', margin: 0 }} />
                      📡 {es.name}
                      <span style={{ opacity: .5, fontSize: '.9em' }}>({es.type})</span>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: '.7em', color: 'var(--ink-muted)', marginTop: 4 }}>
                  勾选后，该 Agent 的会话将实时接收事件推送
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
