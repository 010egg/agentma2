import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentTemplate } from '../simulator/types';
import { getAuthHeaders } from '../utils/client-runtime';
import { useAuth } from '../contexts/AuthContext';
import { fetchAgentTemplates, replaceAgentTemplates } from '../utils/agent-templates';
import { listProviderModels } from '../utils/providers';
import { parseConversationIdInput } from '../utils/conversation-links';

type KnowledgeSource = {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
  enabled: boolean;
  createdBy?: string | null;
  publishedAt?: number | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
};

type KnowledgeTestResult = {
  ok: boolean;
  reason?: string;
  fileCount?: number;
  sampleFiles?: string[];
};

type UploadSelection = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  selected: boolean;
  file: File;
};

type TestState = {
  loading?: boolean;
  result?: KnowledgeTestResult;
};

type KnowledgeQuota = {
  knowledgeUploadAdminMaxFiles: number;
  knowledgeUploadMemberMaxFiles: number;
  knowledgeUploadMaxFileBytes: number;
};

type WorkspaceWikiCandidate = {
  name: string;
  path: string;
  relativePath: string;
  fileCount: number;
  markdownCount: number;
  sampleFiles: string[];
};

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

type KnowledgeGraph = {
  source: { id: string; name: string };
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  stats: {
    files: number;
    nodes: number;
    edges: number;
    missing: number;
    truncated?: boolean;
  };
};

type GraphPreviewState = {
  source: KnowledgeSource;
  mode: string;
  graph: KnowledgeGraph;
};

type KnowledgeFilePreview = {
  path: string;
  name: string;
  content: string;
  sizeBytes: number;
  truncated?: boolean;
};

type GraphLayoutNode = KnowledgeGraphNode & {
  x: number;
  y: number;
  radius: number;
};

const jsonAuthHeaders = () => getAuthHeaders({ 'Content-Type': 'application/json' });
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const KNOWLEDGE_UPLOAD_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.xls', '.xlsx'];
const KNOWLEDGE_UPLOAD_ACCEPT = KNOWLEDGE_UPLOAD_EXTENSIONS.join(',');
const KNOWLEDGE_UPLOAD_LABEL = KNOWLEDGE_UPLOAD_EXTENSIONS.join(' / ');
const DEFAULT_KNOWLEDGE_QUOTA: KnowledgeQuota = {
  knowledgeUploadAdminMaxFiles: 100,
  knowledgeUploadMemberMaxFiles: 20,
  knowledgeUploadMaxFileBytes: 1024 * 1024,
};

function defaultSourceNameFromPath(sourcePath: string) {
  const normalized = sourcePath.trim().replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '知识库';
}

function sourceNameForUpload(firstPath: string, fallback: string) {
  if (!firstPath) return fallback;
  if (firstPath.includes('/')) return firstPath.split('/')[0] || fallback;
  const baseName = defaultSourceNameFromPath(firstPath);
  return baseName.replace(/\.(md|markdown|txt|csv|xls|xlsx)$/i, '') || fallback;
}

function isSupportedKnowledgeUpload(file: File) {
  const name = file.name.toLowerCase();
  return KNOWLEDGE_UPLOAD_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function layoutKnowledgeGraph(graph: KnowledgeGraph) {
  const visibleNodes = graph.nodes.slice(0, 140);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .slice(0, 260);
  const width = 920;
  const height = 560;
  const centerX = width / 2;
  const centerY = height / 2;
  const sorted = [...visibleNodes].sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound) || a.label.localeCompare(b.label));
  const maxDegree = Math.max(1, ...sorted.map((node) => node.inbound + node.outbound));
  const nodes = sorted.map((node, index): GraphLayoutNode => {
    const degree = node.inbound + node.outbound;
    const radius = 5 + Math.min(9, Math.sqrt(degree + 1) * 2);
    if (index === 0) return { ...node, x: centerX, y: centerY, radius: radius + 3 };
    const ring = index < 16 ? 1 : index < 56 ? 2 : 3;
    const ringIndex = ring === 1 ? index - 1 : ring === 2 ? index - 16 : index - 56;
    const ringCount = ring === 1 ? Math.min(15, Math.max(1, sorted.length - 1)) : ring === 2 ? 40 : Math.max(1, sorted.length - 56);
    const angle = (Math.PI * 2 * ringIndex) / ringCount - Math.PI / 2 + ring * 0.19;
    const spread = 110 + ring * 82 + (degree / maxDegree) * 20;
    return {
      ...node,
      x: centerX + Math.cos(angle) * spread,
      y: centerY + Math.sin(angle) * spread * 0.72,
      radius,
    };
  });
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return { width, height, nodes, edges: visibleEdges, nodeMap };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const contentType = response.headers.get('content-type') || '';
      const looksHtml = contentType.includes('text/html') || text.trim().startsWith('<');
      throw new Error(looksHtml
        ? `接口返回了 HTML，说明当前后端没有命中这个 API 路由: ${response.url}`
        : `接口返回了非 JSON 内容: ${text.slice(0, 120)}`);
    }
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data
      ? String((data as Record<string, unknown>).error || '请求失败')
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function normalizeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const path = typeof raw.path === 'string' ? raw.path : '';
    return [{
      id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
      name: typeof raw.name === 'string' ? raw.name : '',
      path,
      readOnly: raw.readOnly !== false,
      enabled: raw.enabled !== false,
      createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
      publishedAt: Number(raw.publishedAt) || null,
      archivedAt: Number(raw.archivedAt) || null,
      deletedAt: Number(raw.deletedAt) || null,
      createdAt: Number(raw.createdAt) || undefined,
      updatedAt: Number(raw.updatedAt) || undefined,
    }];
  });
}

export default function Knowledge() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManageSources = user?.role === 'tenant_admin';
  const canUpload = Boolean(user);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [savedSources, setSavedSources] = useState<KnowledgeSource[]>([]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [quota, setQuota] = useState<KnowledgeQuota>(DEFAULT_KNOWLEDGE_QUOTA);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [directImportLoading, setDirectImportLoading] = useState(false);
  const [scanError, setScanError] = useState('');
  const [folderName, setFolderName] = useState('');
  const [uploadFiles, setUploadFiles] = useState<UploadSelection[]>([]);
  const [wikiConversationId, setWikiConversationId] = useState('');
  const [wikiCandidates, setWikiCandidates] = useState<WorkspaceWikiCandidate[]>([]);
  const [selectedWikiPaths, setSelectedWikiPaths] = useState<string[]>([]);
  const [wikiImportName, setWikiImportName] = useState('');
  const [wikiWorkspaceLoading, setWikiWorkspaceLoading] = useState(false);
  const [wikiWorkspaceMsg, setWikiWorkspaceMsg] = useState('');
  const [wikiLaunchLoadingId, setWikiLaunchLoadingId] = useState('');
  const [graphLoadingId, setGraphLoadingId] = useState('');
  const [graphMsg, setGraphMsg] = useState('');
  const [graphPreview, setGraphPreview] = useState<GraphPreviewState | null>(null);
  const [selectedGraphNode, setSelectedGraphNode] = useState<KnowledgeGraphNode | null>(null);
  const [graphFilePreview, setGraphFilePreview] = useState<KnowledgeFilePreview | null>(null);
  const [graphFileLoading, setGraphFileLoading] = useState(false);
  const [graphFileError, setGraphFileError] = useState('');

  const changed = useMemo(() => JSON.stringify(sources) !== JSON.stringify(savedSources), [sources, savedSources]);
  const visibleSources = useMemo(() => sources
    .filter((source) => !source.deletedAt)
    .sort((a, b) => {
      const archived = Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt));
      if (archived !== 0) return archived;
      return (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name);
    }), [sources]);
  const canManageSource = useCallback((source: KnowledgeSource) => (
    canManageSources || Boolean(user?.email && source.createdBy === user.email)
  ), [canManageSources, user?.email]);
  const publicSources = useMemo(() => visibleSources.filter((source) => source.publishedAt && !source.archivedAt && source.enabled), [visibleSources]);
  const mineSources = useMemo(() => visibleSources.filter((source) => (
    canManageSource(source) || (!source.publishedAt && canManageSources)
  )), [visibleSources, canManageSources, canManageSource]);
  const canSaveSources = mineSources.some((source) => canManageSource(source));
  const mineEnabledCount = mineSources.filter((source) => !source.archivedAt && source.enabled && source.path.trim()).length;
  const archivedCount = mineSources.filter((source) => source.archivedAt).length;
  const graphLayout = useMemo(() => graphPreview ? layoutKnowledgeGraph(graphPreview.graph) : null, [graphPreview]);
  const graphTopNodes = useMemo(() => (
    graphPreview
      ? [...graphPreview.graph.nodes]
        .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound) || a.label.localeCompare(b.label))
        .slice(0, 10)
      : []
  ), [graphPreview]);
  const uploadFileLimit = user?.role === 'tenant_admin'
    ? quota.knowledgeUploadAdminMaxFiles
    : quota.knowledgeUploadMemberMaxFiles;

  const loadSources = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/knowledge/sources', { headers: getAuthHeaders() });
      const data = await readJson<unknown>(response);
      const next = normalizeSources(data);
      setSources(next);
      setSavedSources(next);
      setTests({});
    } catch (loadError) {
      setError((loadError as Error).message || '加载知识库失败');
    } finally {
      setLoading(false);
    }
  };

  const loadQuota = async () => {
    try {
      const response = await fetch('/api/quota', { headers: getAuthHeaders() });
      const data = await readJson<Record<string, unknown>>(response);
      setQuota({
        knowledgeUploadAdminMaxFiles: Number(data.knowledgeUploadAdminMaxFiles) || DEFAULT_KNOWLEDGE_QUOTA.knowledgeUploadAdminMaxFiles,
        knowledgeUploadMemberMaxFiles: Number(data.knowledgeUploadMemberMaxFiles) || DEFAULT_KNOWLEDGE_QUOTA.knowledgeUploadMemberMaxFiles,
        knowledgeUploadMaxFileBytes: Number(data.knowledgeUploadMaxFileBytes) || DEFAULT_KNOWLEDGE_QUOTA.knowledgeUploadMaxFileBytes,
      });
    } catch {
      setQuota(DEFAULT_KNOWLEDGE_QUOTA);
    }
  };

  useEffect(() => {
    void loadSources();
    void loadQuota();
  }, []);

  const updateSource = (id: string, patch: Partial<KnowledgeSource>) => {
    setSources((current) => current.map((source) => (source.id === id ? { ...source, ...patch } : source)));
  };

  const handleFilesPicked = (fileList: FileList | null, source: 'files' | 'folder') => {
    const files = Array.from(fileList || []);
    const supportedFiles = files.filter(isSupportedKnowledgeUpload);
    const next = supportedFiles.map((file) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return {
        id: `${relativePath}:${file.size}:${file.lastModified}`,
        name: file.name,
        relativePath,
        size: file.size,
        selected: true,
        file,
      };
    });
    const firstPath = next[0]?.relativePath || '';
    setFolderName(sourceNameForUpload(firstPath, source === 'folder' ? '上传知识库' : '上传文件'));
    setUploadFiles(next);
    if (!next.length) {
      setScanError(`没有可上传的知识文件，支持 ${KNOWLEDGE_UPLOAD_LABEL}`);
    } else if (next.length > uploadFileLimit) {
      setScanError(`当前账号单次最多上传 ${uploadFileLimit} 个文件，请取消勾选一部分后再上传`);
    } else {
      setScanError('');
    }
    setStatus('');
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const toggleUploadFile = (id: string) => {
    setUploadFiles((current) => current.map((item) => (
      item.id === id ? { ...item, selected: !item.selected } : item
    )));
  };

  const uploadSelectedFolderFiles = async () => {
    const selected = uploadFiles.filter((file) => file.selected);
    if (!selected.length) {
      setScanError('请先勾选要上传的文件');
      return;
    }
    if (selected.length > uploadFileLimit) {
      setScanError(`当前账号单次最多上传 ${uploadFileLimit} 个文件，当前已选 ${selected.length} 个`);
      return;
    }
    const oversized = selected.find((file) => file.size > quota.knowledgeUploadMaxFileBytes);
    if (oversized) {
      setScanError(`单个文档不能超过 ${formatBytes(quota.knowledgeUploadMaxFileBytes)}：${oversized.relativePath}`);
      return;
    }
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
      setScanError(`选中文件总大小 ${formatBytes(totalBytes)}，单次最多上传 ${formatBytes(MAX_UPLOAD_BYTES)}`);
      return;
    }
    setDirectImportLoading(true);
    setScanError('');
    setStatus('');
    try {
      const formData = new FormData();
      formData.set('name', folderName.trim() || '上传知识库');
      for (const item of selected) {
        formData.append('files', item.file, item.name);
        formData.append('relativePaths', item.relativePath);
      }
      const response = await fetch('/api/knowledge/sources/upload', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await readJson<unknown>(response);
      const next = normalizeSources(data);
      setSources(next);
      setSavedSources(next);
      setUploadFiles([]);
      setStatus(`已上传 ${selected.length} 个文件并导入知识库，现在可以在 Agent 创建页勾选。`);
    } catch (uploadFailure) {
      setScanError((uploadFailure as Error).message || '上传知识库失败');
    } finally {
      setDirectImportLoading(false);
    }
  };

  const saveSourceList = async (sourceList: KnowledgeSource[], successMessage: string) => {
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const payload = sourceList
        .filter((source) => source.path.trim() && canManageSource(source))
        .map((source) => ({
          ...source,
          name: source.name.trim(),
          path: source.path.trim(),
          readOnly: true,
        }));
      const response = await fetch('/api/knowledge/sources', {
        method: 'PUT',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await readJson<unknown>(response);
      const next = normalizeSources(data);
      setSources(next);
      setSavedSources(next);
      setStatus(successMessage);
    } catch (saveError) {
      setError((saveError as Error).message || '保存知识库失败');
      throw saveError;
    } finally {
      setSaving(false);
    }
  };

  const archiveSource = async (id: string) => {
    const archivedAt = Date.now();
    const nextSources = sources.map((source) => (
      source.id === id ? { ...source, publishedAt: null, archivedAt, deletedAt: null, enabled: false } : source
    ));
    setTests((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    await saveSourceList(nextSources, '已归档。归档项会沉到底部，30 天后自动软删除。').catch(() => {});
  };

  const softDeleteSource = async (id: string) => {
    const deletedAt = Date.now();
    const nextSources = sources.map((source) => (
      source.id === id
        ? { ...source, publishedAt: null, archivedAt: source.archivedAt || deletedAt, deletedAt, enabled: false }
        : source
    ));
    setTests((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    await saveSourceList(nextSources, '已删除。记录已软删除，不再出现在知识库列表。').catch(() => {});
  };

  const restoreSource = async (id: string) => {
    const nextSources = sources.map((source) => (
      source.id === id ? { ...source, archivedAt: null, deletedAt: null, enabled: true } : source
    ));
    await saveSourceList(nextSources, '已恢复。知识库已回到我的知识库列表。').catch(() => {});
  };

  const publishSource = async (id: string) => {
    const publishedAt = Date.now();
    const nextSources = sources.map((source) => (
      source.id === id ? { ...source, publishedAt, archivedAt: null, deletedAt: null, enabled: true } : source
    ));
    await saveSourceList(nextSources, '已发布到公共知识库，其他成员现在可以使用。').catch(() => {});
  };

  const unpublishSource = async (id: string) => {
    const nextSources = sources.map((source) => (
      source.id === id ? { ...source, publishedAt: null } : source
    ));
    await saveSourceList(nextSources, '已从公共知识库撤回。').catch(() => {});
  };

  const testSource = async (source: KnowledgeSource) => {
    const sourcePath = source.path.trim();
    if (!sourcePath) {
      setTests((current) => ({ ...current, [source.id]: { result: { ok: false, reason: '路径不能为空' } } }));
      return;
    }

    setTests((current) => ({ ...current, [source.id]: { loading: true } }));
    try {
      const response = await fetch('/api/knowledge/sources/test', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ path: sourcePath }),
      });
      const result = await readJson<KnowledgeTestResult>(response);
      setTests((current) => ({ ...current, [source.id]: { result } }));
    } catch (testError) {
      setTests((current) => ({ ...current, [source.id]: { result: { ok: false, reason: (testError as Error).message } } }));
    }
  };

  const saveSources = async () => {
    await saveSourceList(sources, '已保存。现在可以在 Agent 创建页按需勾选这些知识库。').catch(() => {});
  };

  const ensureWikiAgentTemplate = async () => {
    if (!user?.tenantId) throw new Error('请先登录');
    const models = listProviderModels();
    const model = models[0] || '';
    if (!model) throw new Error('请先到账户管理配置至少一个可用模型');
    const templates = await fetchAgentTemplates(user.tenantId);
    const existing = templates.find((template) => template.id === 'wiki-agent');
    if (existing) return existing;

    const now = Date.now();
    const wikiAgent: AgentTemplate = {
      id: 'wiki-agent',
      name: 'Wiki 化助手',
      description: '把知识库 source 编译为可在 Obsidian 中浏览的个人 wiki。',
      systemPrompt: [
        '你是 AgentMa 的知识库 wiki 化助手。',
        '当用户要求 wiki 化某个知识库 source 时,必须使用 wiki skill 的 ingest/absorb/query 工作流。',
        '只读取用户指定的知识库 source;不要写入原 source 路径。',
        '所有生成产物都写入当前会话 workspace 的 data/、raw/entries/、wiki/ 目录。',
        '完成后明确告诉用户 wiki/ 目录位置,并提示回到知识库页面用“从会话同步 Wiki 知识库”导入。',
      ].join('\n'),
      model,
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill'],
      subagents: {},
      mcpServers: [],
      eventSources: [],
      skills: ['wiki'],
      effort: 'high',
      maxTurns: 50,
      permissionMode: 'default',
      useKnowledge: true,
      knowledgeSourceIds: [],
      a2aPublished: false,
      a2aRemoteAgents: [],
      createdAt: now,
      updatedAt: now,
    };
    const saved = await replaceAgentTemplates(user.tenantId, [wikiAgent, ...templates]);
    return saved.find((template) => template.id === wikiAgent.id) || wikiAgent;
  };

  const launchWikiSession = async (source: KnowledgeSource) => {
    setWikiLaunchLoadingId(source.id);
    setGraphMsg('');
    setError('');
    try {
      const agent = await ensureWikiAgentTemplate();
      const prompt = [
        `请把知识库 "${source.name || '未命名知识库'}" wiki 化。`,
        '',
        `知识库 source 路径: ${source.path}`,
        `知识库 source id: ${source.id}`,
        '',
        '要求:',
        '1. 在当前会话 workspace 下创建 data/、raw/entries/、wiki/。',
        '2. 从上面的 source 读取原始知识文件,不要写入 source 路径。',
        '3. 调用 wiki skill 完成 ingest,然后 absorb all。',
        '4. 结束时列出生成的 wiki/ 目录路径,方便我回到知识库页面同步。',
      ].join('\n');
      navigate(`/conversations?agent=${encodeURIComponent(agent.id)}&draft=${encodeURIComponent(prompt)}`);
    } catch (launchError) {
      setError((launchError as Error).message || '发起 Wiki 化会话失败');
    } finally {
      setWikiLaunchLoadingId('');
    }
  };

  const scanWorkspaceWikis = async () => {
    const conversationId = parseConversationIdInput(wikiConversationId);
    if (!conversationId) {
      setWikiWorkspaceMsg('请粘贴包含 conversationId 或 join 参数的会话链接，或直接输入对话 ID');
      return;
    }
    if (conversationId !== wikiConversationId.trim()) setWikiConversationId(conversationId);
    setWikiWorkspaceLoading(true);
    setWikiWorkspaceMsg('');
    setWikiCandidates([]);
    setSelectedWikiPaths([]);
    try {
      const response = await fetch('/api/knowledge/workspace/scan', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ conversationId }),
      });
      const data = await readJson<{ wikis?: WorkspaceWikiCandidate[] }>(response);
      const candidates = Array.isArray(data.wikis) ? data.wikis : [];
      setWikiCandidates(candidates);
      setSelectedWikiPaths(candidates.map((candidate) => candidate.path));
      setWikiImportName(candidates[0]?.name ? `${candidates[0].name.replace(/\/?wiki$/, '') || 'Workspace'} Wiki` : '');
      setWikiWorkspaceMsg(candidates.length
        ? `已找到 ${candidates.length} 个 wiki 候选`
        : '没有找到可同步的 wiki/ 目录');
    } catch (scanFailure) {
      setWikiWorkspaceMsg(`扫描失败: ${(scanFailure as Error).message}`);
    } finally {
      setWikiWorkspaceLoading(false);
    }
  };

  const toggleWikiCandidate = (candidatePath: string) => {
    setSelectedWikiPaths((current) => (
      current.includes(candidatePath)
        ? current.filter((item) => item !== candidatePath)
        : [...current, candidatePath]
    ));
  };

  const importSelectedWorkspaceWikis = async () => {
    const conversationId = parseConversationIdInput(wikiConversationId);
    if (!conversationId) {
      setWikiWorkspaceMsg('请粘贴包含 conversationId 或 join 参数的会话链接，或直接输入对话 ID');
      return;
    }
    if (conversationId !== wikiConversationId.trim()) setWikiConversationId(conversationId);
    const selected = wikiCandidates.filter((candidate) => selectedWikiPaths.includes(candidate.path));
    if (!selected.length) {
      setWikiWorkspaceMsg('请先选择要同步的 wiki');
      return;
    }
    setWikiWorkspaceLoading(true);
    setWikiWorkspaceMsg('');
    const imported: KnowledgeSource[] = [];
    const failed: string[] = [];
    try {
      for (const candidate of selected) {
        try {
          const response = await fetch('/api/knowledge/workspace/import', {
            method: 'POST',
            headers: jsonAuthHeaders(),
            body: JSON.stringify({
              conversationId,
              path: candidate.path,
              name: selected.length === 1 ? wikiImportName.trim() : '',
            }),
          });
          const data = await readJson<{ source?: KnowledgeSource }>(response);
          if (data.source) imported.push(data.source);
        } catch (importFailure) {
          failed.push(`${candidate.relativePath}: ${(importFailure as Error).message}`);
        }
      }
      await loadSources();
      setSelectedWikiPaths([]);
      setWikiWorkspaceMsg([
        imported.length ? `已同步 ${imported.length} 个 wiki 知识库` : '',
        failed.length ? `失败 ${failed.length} 个：${failed.join('；')}` : '',
      ].filter(Boolean).join(' ') || '没有同步任何 wiki');
    } finally {
      setWikiWorkspaceLoading(false);
    }
  };

  const openObsidianGraph = async (source: KnowledgeSource) => {
    setGraphLoadingId(source.id);
    setGraphMsg('');
    closeGraphPreview();
    try {
      const response = await fetch(`/api/knowledge/sources/${encodeURIComponent(source.id)}/graph`, {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({}),
      });
      const data = await readJson<{ ok: boolean; mode?: string; graph?: KnowledgeGraph }>(response);
      if (data.graph) {
        setGraphPreview({ source, graph: data.graph, mode: data.mode || 'native' });
        const firstFileNode = data.graph.nodes.find((node) => node.kind === 'file' && node.path) || data.graph.nodes[0] || null;
        if (firstFileNode) void selectGraphNode(source, firstFileNode);
        setGraphMsg(`已生成 "${source.name || '知识库'}" 图谱`);
      } else {
        setGraphMsg(`已请求 Obsidian 打开 "${source.name || '知识库'}" 图谱`);
      }
    } catch (graphFailure) {
      setGraphMsg(`图谱预览失败: ${(graphFailure as Error).message}`);
    } finally {
      setGraphLoadingId('');
    }
  };

  function closeGraphPreview() {
    setGraphPreview(null);
    setSelectedGraphNode(null);
    setGraphFilePreview(null);
    setGraphFileError('');
    setGraphFileLoading(false);
  }

  async function selectGraphNode(source: KnowledgeSource, node: KnowledgeGraphNode) {
    setSelectedGraphNode(node);
    setGraphFilePreview(null);
    setGraphFileError('');
    if (node.kind !== 'file' || !node.path) {
      setGraphFileLoading(false);
      return;
    }

    setGraphFileLoading(true);
    try {
      const response = await fetch(`/api/knowledge/sources/${encodeURIComponent(source.id)}/file-preview`, {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ path: node.path }),
      });
      const data = await readJson<{ file?: KnowledgeFilePreview }>(response);
      setGraphFilePreview(data.file || null);
    } catch (previewFailure) {
      setGraphFileError((previewFailure as Error).message || '读取文件失败');
    } finally {
      setGraphFileLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>📚 知识库</h1>
        <p>导入可绑定到 Agent 的本地文件夹。默认只读；仅创建人关闭「只读」后，创建人自己的 Agent 才能写入，其他成员始终只读。</p>
      </div>

      {error && <div className="card mb-4" style={{ borderColor: 'var(--danger)', background: 'var(--danger-bg)', color: 'var(--danger)' }}>{error}</div>}
      {status && <div className="card mb-4" style={{ borderColor: 'var(--success)', background: 'var(--success-bg)', color: 'var(--success)' }}>{status}</div>}
      {graphMsg && <div className="card mb-4" style={{ borderColor: graphMsg.includes('失败') ? 'var(--danger)' : 'var(--success)', color: graphMsg.includes('失败') ? 'var(--danger)' : 'var(--success)' }}>{graphMsg}</div>}
      {!canManageSources && (
        <div className="card mb-4" style={{ borderColor: 'var(--warning)', background: 'var(--warning-bg)', color: 'var(--warning)' }}>
          当前账号可以上传文件夹生成知识库，也可以管理自己创建的知识库；公共知识库由发布者维护。
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div>
            <div className="card-header" style={{ marginBottom: 4 }}>上传本地文件夹</div>
            <div className="tool-card-desc">
              打开本地文件夹后勾选要上传的知识文件。支持 {KNOWLEDGE_UPLOAD_LABEL}。当前账号单次最多 {uploadFileLimit} 个文件，单文档最多 {formatBytes(quota.knowledgeUploadMaxFileBytes)}，总量最多 {formatBytes(MAX_UPLOAD_BYTES)}。
            </div>
          </div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <input
              ref={folderInputRef}
              type="file"
              multiple
              accept={KNOWLEDGE_UPLOAD_ACCEPT}
              {...{ webkitdirectory: '', directory: '' }}
              onChange={e => handleFilesPicked(e.currentTarget.files, 'folder')}
              style={{ display: 'none' }}
            />
            <button className="btn btn-sm" onClick={() => folderInputRef.current?.click()} disabled={!canUpload || directImportLoading}>
              打开文件夹
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => void uploadSelectedFolderFiles()} disabled={!canUpload || directImportLoading || uploadFiles.filter(file => file.selected).length === 0}>
              {directImportLoading ? '上传中...' : '上传选中文件'}
            </button>
          </div>
        </div>

        {scanError && <div style={{ color: 'var(--danger)', fontSize: '.8em', marginTop: 10 }}>{scanError}</div>}

        {uploadFiles.length > 0 && (
          <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div className="flex-between" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-hover)', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '.82em', fontWeight: 700 }}>
                  {folderName || '上传知识库'}
                </div>
                <div style={{ fontSize: '.74em', color: 'var(--ink-muted)' }}>
                  已选 {uploadFiles.filter(file => file.selected).length}/{uploadFiles.length} 个文件
                </div>
              </div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <input
                  value={folderName}
                  onChange={e => setFolderName(e.target.value)}
                  placeholder="知识库名称"
                  style={{ width: 180 }}
                />
                <button className="btn btn-sm" onClick={() => setUploadFiles(current => current.map(file => ({ ...file, selected: true })))}>全选</button>
                <button className="btn btn-sm" onClick={() => setUploadFiles(current => current.map(file => ({ ...file, selected: false })))}>清空</button>
              </div>
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {uploadFiles.map((item) => (
                <label
                  key={item.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    gap: 10,
                    alignItems: 'start',
                    padding: '10px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={item.selected}
                    onChange={() => toggleUploadFile(item.id)}
                    style={{ width: 'auto', marginTop: 3 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700 }}>{item.name}</span>
                    <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.72em', color: 'var(--ink-secondary)', overflowWrap: 'anywhere', marginTop: 2 }}>
                      {item.relativePath}
                    </span>
                  </span>
                  <span className="badge badge-muted">{formatBytes(item.size)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <div>
            <div className="card-header" style={{ marginBottom: 4 }}>从会话同步 Wiki 知识库</div>
            <div className="tool-card-desc">
              粘贴 Wiki 化会话链接或输入对话 ID，扫描该会话 workspace 里的 wiki/ 产物，并同步为新的知识库 source。
            </div>
          </div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <input
              value={wikiConversationId}
              onChange={e => setWikiConversationId(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void scanWorkspaceWikis(); }}
              placeholder="会话链接或 conversationId"
              style={{ width: 300, fontFamily: 'var(--font-mono)', fontSize: '.8em' }}
            />
            <button className="btn btn-sm btn-primary" onClick={() => void scanWorkspaceWikis()} disabled={wikiWorkspaceLoading}>
              {wikiWorkspaceLoading ? '扫描中...' : '扫描'}
            </button>
          </div>
        </div>

        {wikiCandidates.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div className="flex-between" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-hover)', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.82em', fontWeight: 700 }}>
                Wiki 候选 {selectedWikiPaths.length}/{wikiCandidates.length}
              </span>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <input
                  value={wikiImportName}
                  onChange={e => setWikiImportName(e.target.value)}
                  placeholder="同步后的知识库名称"
                  disabled={wikiCandidates.length !== 1}
                  style={{ width: 220, fontSize: '.8em' }}
                />
                <button className="btn btn-sm" onClick={() => setSelectedWikiPaths(wikiCandidates.map(candidate => candidate.path))}>全选</button>
                <button className="btn btn-sm" onClick={() => setSelectedWikiPaths([])}>清空</button>
                <button className="btn btn-primary btn-sm" onClick={() => void importSelectedWorkspaceWikis()} disabled={wikiWorkspaceLoading || selectedWikiPaths.length === 0}>
                  {wikiWorkspaceLoading ? '同步中...' : '同步为知识库'}
                </button>
              </div>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {wikiCandidates.map(candidate => (
                <label
                  key={candidate.path}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    gap: 10,
                    alignItems: 'start',
                    padding: '10px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedWikiPaths.includes(candidate.path)}
                    onChange={() => toggleWikiCandidate(candidate.path)}
                    style={{ width: 'auto', marginTop: 3 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700 }}>{candidate.relativePath}</span>
                    <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '.72em', color: 'var(--ink-secondary)', overflowWrap: 'anywhere', marginTop: 2 }}>
                      {candidate.path}
                    </span>
                    {candidate.sampleFiles.length > 0 && (
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {candidate.sampleFiles.slice(0, 5).map(file => <span className="badge badge-muted" key={file}>{file}</span>)}
                      </span>
                    )}
                  </span>
                  <span className="badge badge-info">{candidate.markdownCount} md / {candidate.fileCount} 文件</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {wikiWorkspaceMsg && (
          <div style={{ marginTop: 10, fontSize: '.8em', color: wikiWorkspaceMsg.includes('失败') ? 'var(--danger)' : wikiWorkspaceMsg.startsWith('已') ? 'var(--success)' : 'var(--ink-secondary)' }}>
            {wikiWorkspaceMsg}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div>
            <div className="card-header" style={{ marginBottom: 4 }}>公共知识库</div>
            <div className="tool-card-desc">已发布 {publicSources.length} 个公共知识库，租户内成员都可以在 Agent 创建页勾选使用。</div>
          </div>
          <button className="btn btn-sm" onClick={() => void loadSources()} disabled={loading || saving}>刷新</button>
        </div>

        {loading ? (
          <div style={{ color: 'var(--ink-muted)', padding: 18, textAlign: 'center' }}>加载中...</div>
        ) : publicSources.length === 0 ? (
          <div style={{ color: 'var(--ink-muted)', padding: 18, textAlign: 'center' }}>
            还没有公共知识库。可以从“我的知识库”发布一个。
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>知识库名称</th>
                  <th style={{ width: 180 }}>创建人</th>
                  <th style={{ width: 220 }}>测试</th>
                  <th style={{ width: 240 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {publicSources.map((source) => {
                  const test = tests[source.id];
                  return (
                    <tr key={source.id}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{source.name || '未命名知识库'}</div>
                      </td>
                      <td>
                        <span style={{ fontSize: '.78em', color: 'var(--ink-secondary)' }}>
                          {source.createdBy === user?.email ? '你' : source.createdBy || '未知'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'grid', gap: 6 }}>
                          <button className="btn btn-sm" onClick={() => void testSource(source)} disabled={test?.loading}>
                            {test?.loading ? '测试中...' : '测试'}
                          </button>
                          {test?.result && (
                            <div style={{ fontSize: '.74em', color: test.result.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {test.result.ok
                                ? `可读 · ${test.result.fileCount || 0} 个知识文件`
                                : test.result.reason || '不可用'}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                          <button className="btn btn-sm btn-primary" onClick={() => void launchWikiSession(source)} disabled={wikiLaunchLoadingId === source.id}>
                            {wikiLaunchLoadingId === source.id ? '启动中...' : 'Wiki 化'}
                          </button>
                          <button className="btn btn-sm" onClick={() => void openObsidianGraph(source)} disabled={graphLoadingId === source.id}>
                            {graphLoadingId === source.id ? '打开中...' : '图谱预览'}
                          </button>
                          {canManageSource(source) ? (
                            <button className="btn btn-sm" onClick={() => void unpublishSource(source.id)} disabled={saving}>撤回</button>
                          ) : (
                            <span className="badge badge-success">公共</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex-between" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div>
            <div className="card-header" style={{ marginBottom: 4 }}>我的知识库</div>
            <div className="tool-card-desc">
              已导入 {mineSources.length} 个知识库，{mineEnabledCount} 个可被 Agent 勾选，{archivedCount} 个已归档。可以发布到公共知识库供他人使用；归档项会沉到底部，30 天后自动软删除。
            </div>
          </div>
          <div className="flex gap-2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => void loadSources()} disabled={loading || saving}>刷新</button>
            <button className="btn btn-sm btn-primary" onClick={() => void saveSources()} disabled={!changed || saving || !canSaveSources}>
              {saving ? '保存中...' : '保存知识库'}
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ color: 'var(--ink-muted)', padding: 24, textAlign: 'center' }}>加载中...</div>
        ) : mineSources.length === 0 ? (
          <div style={{ color: 'var(--ink-muted)', padding: 24, textAlign: 'center' }}>
            还没有知识库。导入一个 Obsidian vault 或知识文件目录后，就能在 Agent 创建页勾选它。
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>知识库名称</th>
                  <th style={{ width: 90 }}>启停</th>
                  <th style={{ width: 160 }}>只读 / 创建人</th>
                  <th style={{ width: 220 }}>测试</th>
                  <th style={{ width: 260 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {mineSources.map((source) => {
                  const test = tests[source.id];
                  const manageable = canManageSource(source);
                  return (
                    <tr key={source.id} style={{ opacity: source.archivedAt ? .68 : 1 }}>
                      <td>
                        <input
                          value={source.name}
                          onChange={e => updateSource(source.id, { name: e.target.value })}
                          placeholder="主 vault"
                          disabled={!manageable}
                        />
                      </td>
                      <td>
                        {source.archivedAt ? (
                          <span className="badge badge-muted">已归档</span>
                        ) : (
                          <button
                            className={`btn btn-sm ${source.enabled ? '' : 'btn-success'}`}
                            onClick={() => updateSource(source.id, { enabled: !source.enabled })}
                            disabled={!manageable}
                          >
                            {source.enabled ? '停用' : '启用'}
                          </button>
                        )}
                      </td>
                      <td>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                          <input
                            type="checkbox"
                            checked={source.readOnly}
                            onChange={e => updateSource(source.id, { readOnly: e.target.checked })}
                            disabled={!manageable}
                            style={{ width: 'auto', margin: 0 }}
                          />
                          <span>{source.readOnly ? '只读' : '创建人可写'}</span>
                        </label>
                        <div style={{ fontSize: '.7em', color: 'var(--ink-muted)', marginTop: 3 }}>
                          {source.createdBy
                            ? (source.createdBy === user?.email ? '创建人：你' : `创建人：${source.createdBy}`)
                            : '创建人：未知'}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'grid', gap: 6 }}>
                          <button className="btn btn-sm" onClick={() => void testSource(source)} disabled={test?.loading}>
                            {test?.loading ? '测试中...' : '测试'}
                          </button>
                          {test?.result && (
                            <div style={{ fontSize: '.74em', color: test.result.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {test.result.ok
                                ? `可读 · ${test.result.fileCount || 0} 个知识文件`
                                : test.result.reason || '不可用'}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                          {source.archivedAt ? (
                            <>
                              <button className="btn btn-sm btn-success" onClick={() => void restoreSource(source.id)} disabled={saving || !manageable}>恢复</button>
                              <button className="btn btn-sm btn-danger" onClick={() => void softDeleteSource(source.id)} disabled={saving || !manageable}>删除</button>
                            </>
                          ) : (
                            <>
                              <button className="btn btn-sm btn-primary" onClick={() => void launchWikiSession(source)} disabled={wikiLaunchLoadingId === source.id || !source.enabled}>
                                {wikiLaunchLoadingId === source.id ? '启动中...' : 'Wiki 化'}
                              </button>
                              <button className="btn btn-sm" onClick={() => void openObsidianGraph(source)} disabled={graphLoadingId === source.id}>
                                {graphLoadingId === source.id ? '打开中...' : '图谱预览'}
                              </button>
                              {source.publishedAt ? (
                                <button className="btn btn-sm" onClick={() => void unpublishSource(source.id)} disabled={saving || !manageable}>撤回</button>
                              ) : (
                                <button className="btn btn-sm btn-primary" onClick={() => void publishSource(source.id)} disabled={saving || !manageable}>发布</button>
                              )}
                              <button className="btn btn-sm" onClick={() => void archiveSource(source.id)} disabled={saving || !manageable}>归档</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {graphPreview && graphLayout && (
        <div className="knowledge-graph-backdrop" role="presentation" onClick={closeGraphPreview}>
          <div className="knowledge-graph-modal" role="dialog" aria-modal="true" aria-label="知识库图谱预览" onClick={event => event.stopPropagation()}>
            <div className="knowledge-graph-header">
              <div style={{ minWidth: 0 }}>
                <div className="knowledge-graph-title">{graphPreview.source.name || '未命名知识库'}</div>
                <div className="knowledge-graph-subtitle">
                  {graphPreview.graph.stats.files} markdown · {graphPreview.graph.stats.nodes} 节点 · {graphPreview.graph.stats.edges} 连线
                  {graphPreview.graph.stats.truncated ? ' · 已截断' : ''}
                </div>
              </div>
              <button className="btn btn-sm" onClick={closeGraphPreview}>关闭</button>
            </div>

            <div className="knowledge-graph-body">
              <div className="knowledge-graph-canvas">
                {graphLayout.nodes.length === 0 ? (
                  <div className="knowledge-graph-empty">没有可展示的 Markdown 图谱</div>
                ) : (
                  <svg viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`} role="img" aria-label="知识库文件链接图">
                    <defs>
                      <filter id="knowledgeGraphGlow" x="-40%" y="-40%" width="180%" height="180%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge>
                          <feMergeNode in="blur" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
                      </filter>
                    </defs>
                    {graphLayout.edges.map((edge) => {
                      const sourceNode = graphLayout.nodeMap.get(edge.source);
                      const targetNode = graphLayout.nodeMap.get(edge.target);
                      if (!sourceNode || !targetNode) return null;
                      return (
                        <line
                          key={`${edge.source}->${edge.target}`}
                          x1={sourceNode.x}
                          y1={sourceNode.y}
                          x2={targetNode.x}
                          y2={targetNode.y}
                          strokeWidth={Math.min(4, 1 + edge.count * 0.7)}
                          className="knowledge-graph-edge"
                        />
                      );
                    })}
                    {graphLayout.nodes.map((node) => {
                      const degree = node.inbound + node.outbound;
                      const labelVisible = degree >= 2 || graphLayout.nodes.length <= 30;
                      const selected = selectedGraphNode?.id === node.id;
                      return (
                        <g
                          key={node.id}
                          className={`knowledge-graph-node ${node.kind === 'missing' ? 'missing' : 'file'}${selected ? ' selected' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => void selectGraphNode(graphPreview.source, node)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              void selectGraphNode(graphPreview.source, node);
                            }
                          }}
                        >
                          <circle cx={node.x} cy={node.y} r={node.radius} filter={degree >= 5 ? 'url(#knowledgeGraphGlow)' : undefined}>
                            <title>{node.path || node.label}</title>
                          </circle>
                          {labelVisible && (
                            <text x={node.x} y={node.y + node.radius + 13} textAnchor="middle">
                              {node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                )}
              </div>

              <aside className="knowledge-graph-side">
                <div className="knowledge-graph-metric-grid">
                  <div><strong>{graphPreview.graph.stats.files}</strong><span>文件</span></div>
                  <div><strong>{graphPreview.graph.stats.nodes}</strong><span>节点</span></div>
                  <div><strong>{graphPreview.graph.stats.edges}</strong><span>连线</span></div>
                  <div><strong>{graphPreview.graph.stats.missing}</strong><span>缺失引用</span></div>
                </div>

                {selectedGraphNode && (
                  <div className="knowledge-graph-selected">
                    <div className="knowledge-graph-selected-title">{selectedGraphNode.label}</div>
                    <div className="knowledge-graph-selected-meta">
                      {selectedGraphNode.kind === 'missing' ? '缺失引用' : selectedGraphNode.path || '文件'}
                    </div>
                    <div className="knowledge-graph-selected-meta">
                      入链 {selectedGraphNode.inbound} · 出链 {selectedGraphNode.outbound}
                    </div>
                    {graphFileLoading && <div className="knowledge-graph-preview-state">读取中...</div>}
                    {graphFileError && <div className="knowledge-graph-preview-state danger">{graphFileError}</div>}
                    {selectedGraphNode.kind === 'missing' && (
                      <div className="knowledge-graph-preview-state">这个链接还没有对应的知识库文件。</div>
                    )}
                    {graphFilePreview && (
                      <div className="knowledge-graph-file-preview">
                        <div className="knowledge-graph-file-head">
                          <span>{graphFilePreview.name}</span>
                          <b>{formatBytes(graphFilePreview.sizeBytes)}</b>
                        </div>
                        <pre>{graphFilePreview.content}</pre>
                        {graphFilePreview.truncated && <div className="knowledge-graph-preview-state">内容已截断</div>}
                      </div>
                    )}
                  </div>
                )}

                <div className="knowledge-graph-list">
                  {graphTopNodes.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      className={`knowledge-graph-list-item${selectedGraphNode?.id === node.id ? ' selected' : ''}`}
                      onClick={() => void selectGraphNode(graphPreview.source, node)}
                    >
                      <span>{node.label}</span>
                      <b>{node.inbound + node.outbound}</b>
                    </button>
                  ))}
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}

      {Object.values(tests).some((test) => test.result?.ok && test.result.sampleFiles?.length) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">测试样例</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {visibleSources.map((source) => {
              const result = tests[source.id]?.result;
              if (!result?.ok || !result.sampleFiles?.length) return null;
              return (
                <div key={source.id} className="tool-card" style={{ padding: 12 }}>
                  <div className="tool-card-name">{source.name || '未命名知识库'}</div>
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {result.sampleFiles.map((file) => <span className="badge badge-info" key={file}>{file}</span>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
