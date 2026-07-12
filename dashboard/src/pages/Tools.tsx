import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BuiltInTool, RegisteredTool, ToolEndpoint } from '../simulator/types';
import { BUILT_IN_TOOLS, initCustomTools, saveCustomTools } from '../simulator/mock-data';
import JsonViewer from '../components/common/JsonViewer';
import { McpServerCard } from '../components/McpServerManager';
import { getAuthHeaders } from '../utils/client-runtime';
import { useAuth } from '../contexts/AuthContext';
import { fetchProviderModels, listProviderModels } from '../utils/providers';
import { initToolCategories, saveToolCategories } from '../utils/tool-categories';
import LineIcon from '../components/LineIcon';
import McpConnections from './McpConnections';
import './Tools.css';

type PlatformCatalogTool = RegisteredTool & {
  source: 'platform';
  sdkToolName: string;
  scope: 'global' | 'template';
  displayName: string;
  templateId?: string;
  templateName?: string;
  remoteId?: string;
};

const BUILTIN_TAG_META: Record<string, string> = {
  file: '文件操作', execution: '命令执行', task: '任务管理',
  search: '搜索查询', interaction: '用户交互', mcp: 'MCP 资源', notebook: 'Notebook', agent: '子代理',
};

type InternalToolSetting = {
  toolId: string;
  settings: Record<string, unknown>;
};

type CategoryDraft = {
  mode: 'create' | 'rename';
  original?: string;
  value: string;
  error?: string;
};

type ToolSourceFilter = 'all' | 'builtin' | 'external';

function normalizeInternalToolSettings(items: unknown): Record<string, InternalToolSetting> {
  if (!Array.isArray(items)) return {};
  return Object.fromEntries(items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const toolId = typeof raw.toolId === 'string' ? raw.toolId : '';
    const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
      ? raw.settings as Record<string, unknown>
      : {};
    return toolId ? [[toolId, { toolId, settings }]] : [];
  }));
}

function defaultModelFromSetting(setting: InternalToolSetting | undefined) {
  const value = setting?.settings.defaultModel;
  return typeof value === 'string' ? value : '';
}

function mergeModelLists(...lists: string[][]) {
  return Array.from(new Set(lists.flatMap(list => list
    .map(model => model.trim())
    .filter(model => model && !model.includes('*')))));
}

const INTERNAL_MODEL_CONFIG_TOOLS = new Set(['model.request', 'image.inspect']);

const EMPTY_TOOL_FORM = {
  name: '', description: '', category: '', mcpServer: '', inputSchema: '{}',
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  endpointUrl: '', endpointMethod: 'GET' as ToolEndpoint['method'],
  endpointHeaders: '', endpointBody: '',
};

function ToolCatalog() {
  const { user } = useAuth();
  const [customTools, setCustomTools] = useState<RegisteredTool[]>(() => initCustomTools());
  const [customCategories, setCustomCategories] = useState<string[]>(() => initToolCategories(customTools));
  const [internalTools, setInternalTools] = useState<RegisteredTool[]>([]);
  const [internalToolsError, setInternalToolsError] = useState('');
  const [platformTools, setPlatformTools] = useState<PlatformCatalogTool[]>([]);
  const [platformToolsError, setPlatformToolsError] = useState('');
  const [providerModels, setProviderModels] = useState<string[]>(() => listProviderModels());
  const [internalToolSettings, setInternalToolSettings] = useState<Record<string, InternalToolSetting>>({});
  const [internalToolDraftModels, setInternalToolDraftModels] = useState<Record<string, string>>({});
  const [savingInternalToolId, setSavingInternalToolId] = useState('');
  const [selectedTool, setSelectedTool] = useState<BuiltInTool | RegisteredTool | null>(null);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<ToolSourceFilter>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [expandedTags, setExpandedTags] = useState<Set<string>>(() => new Set(['file']));
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft | null>(null);
  const [categoryMenu, setCategoryMenu] = useState<string | null>(null);
  const [editingToolName, setEditingToolName] = useState('');
  const [toolFormOpen, setToolFormOpen] = useState(false);

  const [form, setForm] = useState({ ...EMPTY_TOOL_FORM });
  const canConfigureInternalTools = user?.role === 'tenant_admin';

  useEffect(() => {
    if (!user?.tenantId) return;
    let cancelled = false;
    fetch('/api/internal-tools', { headers: getAuthHeaders() })
      .then(async (response) => {
        if (response.ok) return response.json();
        const data = await response.json().catch(() => null);
        throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
      })
      .then((items) => {
        if (cancelled || !Array.isArray(items)) return;
        setInternalToolsError('');
        setInternalTools(items.flatMap((item) => {
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
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          setInternalTools([]);
          setInternalToolsError((error as Error).message || '内部工具加载失败');
        }
      });
    return () => { cancelled = true; };
  }, [user?.tenantId]);

  useEffect(() => {
    if (!user?.tenantId) return;
    let cancelled = false;
    fetch('/api/platform-mcp-tools', { headers: getAuthHeaders() })
      .then(async (response) => {
        if (response.ok) return response.json();
        const data = await response.json().catch(() => null);
        throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
      })
      .then((items) => {
        if (cancelled || !Array.isArray(items)) return;
        setPlatformToolsError('');
        setPlatformTools(items.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const raw = item as Record<string, unknown>;
          const id = typeof raw.id === 'string' ? raw.id : '';
          const serverName = raw.serverName === 'a2a' ? 'a2a' : raw.serverName === 'memory' ? 'memory' : '';
          const sdkToolName = typeof raw.sdkToolName === 'string' ? raw.sdkToolName : '';
          const description = typeof raw.description === 'string' ? raw.description : '';
          const displayName = typeof raw.displayName === 'string' ? raw.displayName : id;
          if (!id || !serverName || !sdkToolName || !description) return [];
          return [{
            name: id,
            displayName,
            description,
            category: typeof raw.category === 'string' ? raw.category : '平台 MCP',
            inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema)
              ? raw.inputSchema as Record<string, unknown>
              : {},
            annotations: raw.annotations && typeof raw.annotations === 'object' && !Array.isArray(raw.annotations)
              ? raw.annotations as RegisteredTool['annotations']
              : undefined,
            source: 'platform',
            mcpServer: serverName,
            sdkToolName,
            scope: raw.scope === 'template' ? 'template' : 'global',
            templateId: typeof raw.templateId === 'string' ? raw.templateId : undefined,
            templateName: typeof raw.templateName === 'string' ? raw.templateName : undefined,
            remoteId: typeof raw.remoteId === 'string' ? raw.remoteId : undefined,
          }];
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          setPlatformTools([]);
          setPlatformToolsError((error as Error).message || '平台 MCP 工具加载失败');
        }
      });
    return () => { cancelled = true; };
  }, [user?.tenantId]);

  useEffect(() => {
    if (!user?.tenantId) return;
    let cancelled = false;
    const loadModels = async () => {
      const localModels = listProviderModels();
      if (!cancelled && localModels.length) {
        setProviderModels(current => mergeModelLists(current, localModels));
      }
      try {
        const remoteModels = await fetchProviderModels();
        if (!cancelled) {
          setProviderModels(current => mergeModelLists(current, localModels, remoteModels, listProviderModels()));
        }
      } catch {
        if (!cancelled) {
          setProviderModels(current => mergeModelLists(current, localModels));
        }
      }
    };
    void loadModels();
    return () => { cancelled = true; };
  }, [user?.tenantId]);

  useEffect(() => {
    if (!user?.tenantId) return;
    let cancelled = false;
    fetch('/api/internal-tool-settings', { headers: getAuthHeaders() })
      .then(response => response.ok ? response.json() : [])
      .then((items) => {
        if (cancelled) return;
        const normalized = normalizeInternalToolSettings(items);
        setInternalToolSettings(normalized);
        setInternalToolDraftModels((current) => {
          const next = { ...current };
          for (const [toolId, setting] of Object.entries(normalized)) {
            if (next[toolId] === undefined) next[toolId] = defaultModelFromSetting(setting);
          }
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setInternalToolSettings({});
      });
    return () => { cancelled = true; };
  }, [user?.tenantId]);

  useEffect(() => {
    if (!categoryMenu) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-category-menu]')) return;
      setCategoryMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCategoryMenu(null);
    };
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [categoryMenu]);

  const allTools: (BuiltInTool | RegisteredTool)[] = [...BUILT_IN_TOOLS, ...platformTools, ...internalTools, ...customTools];
  const tags = Array.from(new Set([
    ...BUILT_IN_TOOLS.map(tool => tool.category),
    ...platformTools.map(tool => tool.category),
    ...internalTools.map(tool => tool.category),
    ...customCategories,
    ...customTools.map(tool => tool.category),
  ]));
  const protectedTags = new Set([...Object.keys(BUILTIN_TAG_META), ...platformTools.map(tool => tool.category), ...internalTools.map(tool => tool.category), '未分类']);
  const persist = (list: RegisteredTool[]) => { setCustomTools(list); saveCustomTools(list); };
  const persistCategories = (list: string[]) => { setCustomCategories(list); saveToolCategories(list); };

  const searchQuery = search.trim().toLowerCase();
  const matchesSourceFilter = (tool: BuiltInTool | RegisteredTool) => (
    sourceFilter === 'all'
    || (sourceFilter === 'builtin' ? !('source' in tool) : 'source' in tool)
  );
  const toolMatchesSearch = (tool: BuiltInTool | RegisteredTool) => (
    tool.name.toLowerCase().includes(searchQuery)
    || tool.description.toLowerCase().includes(searchQuery)
    || tool.category.toLowerCase().includes(searchQuery)
    || (BUILTIN_TAG_META[tool.category] || tool.category).toLowerCase().includes(searchQuery)
  );
  const sourceFilteredTools = allTools.filter(matchesSourceFilter);
  const filtered = sourceFilteredTools.filter(tool => {
    if (searchQuery) return toolMatchesSearch(tool);
    return tagFilter === 'all' || tool.category === tagFilter;
  });
  const sourceMatchedTags = new Set(sourceFilteredTools.map(tool => tool.category));
  const matchedTags = new Set(filtered.map(tool => tool.category));
  const visibleTags = tags.filter(tag => {
    const hasMatchingSource = sourceMatchedTags.has(tag)
      || (sourceFilter !== 'builtin' && customCategories.includes(tag));
    if (!hasMatchingSource) return false;
    return !searchQuery
      || matchedTags.has(tag)
      || (BUILTIN_TAG_META[tag] || tag).toLowerCase().includes(searchQuery);
  });
  const effectiveExpandedTags = searchQuery ? new Set(visibleTags) : expandedTags;
  const currentCategoryName = searchQuery
    ? `搜索结果：${search.trim()}`
    : tagFilter === 'all'
      ? '全部工具'
      : BUILTIN_TAG_META[tagFilter] || tagFilter;
  const currentCategoryDescription = searchQuery
    ? `在名称、说明和分类中找到 ${filtered.length} 个匹配项`
    : tagFilter === 'all'
      ? `当前来源范围内共有 ${filtered.length} 个工具`
      : `${filtered.length} 个工具归属于此分类`;

  const toolsForTreeTag = (tag: string) => {
    const tools = sourceFilteredTools.filter(tool => tool.category === tag);
    if (!searchQuery) return tools;
    return tools.filter(tool => filtered.some(match => match.name === tool.name));
  };

  const toolIdentity = (tool: BuiltInTool | RegisteredTool) => (
    'source' in tool && tool.source === 'platform'
      ? `${tool.name}:${(tool as PlatformCatalogTool).templateId || 'global'}`
      : tool.name
  );

  const toggleTag = (tag: string) => {
    setExpandedTags(current => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const selectCategory = (tag: string) => {
    setTagFilter(tag);
    setSelectedTool(null);
    setMobileTreeOpen(false);
  };

  const selectFolderCategory = (tag: string) => {
    setTagFilter(tag);
    setSelectedTool(null);
    toggleTag(tag);
  };

  const selectTool = (tool: BuiltInTool | RegisteredTool) => {
    setSelectedTool(tool);
    setTagFilter(tool.category);
    setMobileTreeOpen(false);
  };

  const toolSourceLabel = (tool: BuiltInTool | RegisteredTool) => {
    if (!('source' in tool)) return '内置';
    if (tool.source === 'platform') return '平台 MCP';
    return tool.source === 'internal' ? '内部' : '自定义';
  };

  const resetToolForm = () => {
    setForm({ ...EMPTY_TOOL_FORM });
    setEditingToolName('');
    setToolFormOpen(false);
  };
  const handleDelete = (name: string) => {
    persist(customTools.filter(t => t.name !== name));
    if (selectedTool?.name === name) setSelectedTool(null);
    if (editingToolName === name) resetToolForm();
  };
  const startEditTool = (tool: RegisteredTool) => {
    if (tool.source === 'internal' || tool.source === 'platform') return;
    setEditingToolName(tool.name);
    setToolFormOpen(true);
    setForm({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      mcpServer: tool.mcpServer || '',
      inputSchema: JSON.stringify(tool.inputSchema || {}, null, 2),
      readOnlyHint: tool.annotations?.readOnlyHint === true,
      destructiveHint: tool.annotations?.destructiveHint !== false,
      idempotentHint: tool.annotations?.idempotentHint === true,
      openWorldHint: tool.annotations?.openWorldHint !== false,
      endpointUrl: tool.endpoint?.url || '',
      endpointMethod: tool.endpoint?.method || 'GET',
      endpointHeaders: tool.endpoint?.headers ? JSON.stringify(tool.endpoint.headers, null, 2) : '',
      endpointBody: tool.endpoint?.bodyTemplate || '',
    });
  };

  const categoryNameExists = (name: string, except?: string) => {
    const normalized = name.trim().toLocaleLowerCase();
    return tags.some(tag => tag !== except && (
      tag.toLocaleLowerCase() === normalized
      || (BUILTIN_TAG_META[tag] || tag).toLocaleLowerCase() === normalized
    ));
  };

  const beginCreateCategory = () => {
    setSearch('');
    setSourceFilter('external');
    setCategoryMenu(null);
    setCategoryDraft({ mode: 'create', value: '' });
  };

  const changeSourceFilter = (filter: ToolSourceFilter) => {
    setSourceFilter(filter);
    setTagFilter('all');
    setSelectedTool(null);
    setCategoryMenu(null);
  };

  const beginRenameCategory = (tag: string) => {
    if (protectedTags.has(tag)) return;
    setCategoryMenu(null);
    setCategoryDraft({ mode: 'rename', original: tag, value: tag });
  };

  const cancelCategoryDraft = () => setCategoryDraft(null);

  const commitCategoryDraft = () => {
    if (!categoryDraft) return;
    const name = categoryDraft.value.trim();
    if (!name) {
      cancelCategoryDraft();
      return;
    }
    if (categoryNameExists(name, categoryDraft.original)) {
      setCategoryDraft(current => current ? { ...current, error: '已存在同名文件夹' } : current);
      return;
    }

    if (categoryDraft.mode === 'create') {
      persistCategories([...customCategories, name]);
      setTagFilter(name);
      setSelectedTool(null);
      setExpandedTags(current => new Set(current).add(name));
      setCategoryDraft(null);
      return;
    }

    const original = categoryDraft.original;
    if (!original || original === name) {
      cancelCategoryDraft();
      return;
    }
    persistCategories(customCategories.map(category => category === original ? name : category));
    persist(customTools.map(tool => tool.category === original ? { ...tool, category: name } : tool));
    if (tagFilter === original) setTagFilter(name);
    setSelectedTool(current => current?.category === original ? { ...current, category: name } : current);
    setExpandedTags(current => {
      if (!current.has(original)) return current;
      const next = new Set(current);
      next.delete(original);
      next.add(name);
      return next;
    });
    setCategoryDraft(null);
  };

  const deleteCategory = (tag: string) => {
    if (protectedTags.has(tag)) return;
    const toolCount = customTools.filter(tool => tool.category === tag).length;
    const message = toolCount
      ? `删除“${tag}”后，其中 ${toolCount} 个工具会移动到“未分类”。继续吗？`
      : `删除空文件夹“${tag}”？`;
    if (!window.confirm(message)) return;

    persistCategories(customCategories.filter(category => category !== tag));
    persist(customTools.map(tool => tool.category === tag ? { ...tool, category: '未分类' } : tool));
    setExpandedTags(current => {
      const next = new Set(current);
      next.delete(tag);
      return next;
    });
    if (tagFilter === tag) selectCategory('all');
    if (selectedTool?.category === tag) setSelectedTool(null);
    setCategoryMenu(null);
  };

  const handleRegister = () => {
    const category = form.category.trim();
    if (!form.name || !form.description || !category) return;
    let inputSchema: Record<string, unknown>;
    try { inputSchema = JSON.parse(form.inputSchema); } catch { alert('inputSchema 必须是有效的 JSON'); return; }
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      alert('inputSchema 必须是 JSON 对象');
      return;
    }
    let parsedHeaders: unknown;
    try { parsedHeaders = form.endpointHeaders ? JSON.parse(form.endpointHeaders || '{}') : undefined; } catch { alert('Headers 必须是有效的 JSON'); return; }
    if (parsedHeaders && (typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders))) {
      alert('Headers 必须是 JSON 对象');
      return;
    }
    const endpointHeaders = parsedHeaders
      ? Object.fromEntries(Object.entries(parsedHeaders).map(([key, value]) => [key, String(value)]))
      : undefined;
    if (editingToolName && editingToolName !== form.name && customTools.some(t => t.name === form.name)) {
      alert('工具名已存在，请换一个名称');
      return;
    }
    const endpoint: ToolEndpoint | undefined = form.endpointUrl ? {
      url: form.endpointUrl, method: form.endpointMethod,
      headers: endpointHeaders,
      bodyTemplate: form.endpointBody || undefined,
    } : undefined;
    const tool: RegisteredTool = {
      name: form.name, description: form.description, category,
      inputSchema,
      annotations: { readOnlyHint: form.readOnlyHint, destructiveHint: form.destructiveHint, idempotentHint: form.idempotentHint, openWorldHint: form.openWorldHint },
      source: 'local', endpoint, mcpServer: form.mcpServer || undefined,
    };
    const baseTools = editingToolName ? customTools.filter(t => t.name !== editingToolName) : customTools;
    const existing = baseTools.find(t => t.name === tool.name);
    if (!categoryNameExists(category)) persistCategories([...customCategories, category]);
    persist(existing ? baseTools.map(t => t.name === tool.name ? tool : t) : [...baseTools, tool]);
    resetToolForm();
  };

  const saveInternalToolModel = async (toolId: string) => {
    const defaultModel = (internalToolDraftModels[toolId] || '').trim();
    setSavingInternalToolId(toolId);
    try {
      const response = await fetch(`/api/internal-tool-settings/${encodeURIComponent(toolId)}`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ settings: { defaultModel } }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
      }
      const setting = data && typeof data === 'object' ? data as InternalToolSetting : { toolId, settings: { defaultModel } };
      setInternalToolSettings(current => ({ ...current, [toolId]: setting }));
      setInternalToolDraftModels(current => ({ ...current, [toolId]: defaultModelFromSetting(setting) }));
    } catch (error) {
      alert((error as Error).message || '保存内部工具配置失败');
    } finally {
      setSavingInternalToolId('');
    }
  };

  const mcpServers = Array.from(new Set(customTools.filter(t => t.mcpServer).map(t => t.mcpServer!)));
  const internalToolModelValue = (toolId: string) => (
    internalToolDraftModels[toolId] ?? defaultModelFromSetting(internalToolSettings[toolId])
  );
  const internalToolModelOptions = (toolId: string) => (
    mergeModelLists(providerModels, [internalToolModelValue(toolId)])
  );
  const internalToolHasModelConfig = (toolId: string) => INTERNAL_MODEL_CONFIG_TOOLS.has(toolId);

  return (
    <div className="tool-catalog-page">
      <header className="tool-catalog-page-head">
        <div>
          <span className="tool-catalog-eyebrow">Agent capabilities</span>
          <h1>工具目录</h1>
          <p>像浏览文件一样，定位并管理 Agent 可以调用的能力。</p>
        </div>
        <div className="tool-catalog-head-actions">
          <button className="btn tool-tree-mobile-toggle" onClick={() => setMobileTreeOpen(open => !open)} aria-expanded={mobileTreeOpen}>
            <LineIcon name="menu" />
            目录
          </button>
          <button className="btn btn-primary" onClick={() => { resetToolForm(); setToolFormOpen(true); }}>
            <LineIcon name="plus" />
            注册工具
          </button>
        </div>
      </header>

      <div className="tool-catalog-workspace">
        <aside className={`tool-tree-panel ${mobileTreeOpen ? 'mobile-open' : ''}`} aria-label="工具分类目录">
          <div className="tool-tree-summary">
            <div>
              <strong>目录</strong>
              <span>{sourceFilteredTools.length} 个工具 · {visibleTags.length} 个分类</span>
            </div>
            <button type="button" onClick={beginCreateCategory} aria-label="新建文件夹" title="新建文件夹">
              <span className="tool-new-folder-glyph" aria-hidden="true">
                <span className="tool-folder-glyph" />
                <LineIcon name="plus" />
              </span>
            </button>
          </div>
          <label className="tool-tree-search">
            <span className="sr-only">搜索工具或分类</span>
            <span aria-hidden="true">⌕</span>
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索工具或分类" />
            {search && <button type="button" onClick={() => setSearch('')} aria-label="清空搜索">×</button>}
          </label>

          <div className="tool-tree-source-filter" role="group" aria-label="按工具来源筛选">
            {([
              ['all', '全部'],
              ['builtin', '内置'],
              ['external', '非内置'],
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={sourceFilter === value ? 'active' : ''}
                aria-pressed={sourceFilter === value}
                onClick={() => changeSourceFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="tool-tree" role="tree" aria-label="工具目录树">
            <button
              type="button"
              role="treeitem"
              aria-selected={!searchQuery && tagFilter === 'all'}
              className={`tool-tree-row tool-tree-all ${!searchQuery && tagFilter === 'all' ? 'selected' : ''}`}
              onClick={() => selectCategory('all')}
            >
              <LineIcon name="layers" />
              <span>全部工具</span>
              <small>{sourceFilteredTools.length}</small>
            </button>

            {visibleTags.map((tag, index) => {
              const isExpanded = effectiveExpandedTags.has(tag);
              const treeTools = toolsForTreeTag(tag);
              const isSelected = !searchQuery && tagFilter === tag;
              const isProtected = protectedTags.has(tag);
              const isRenaming = categoryDraft?.mode === 'rename' && categoryDraft.original === tag;
              const groupId = `tool-tree-group-${index}`;
              return (
                <div className="tool-tree-branch" key={tag}>
                  <div
                    className={`tool-tree-folder-row ${isSelected ? 'selected' : ''} ${isProtected ? 'protected' : 'editable'}`}
                    role="none"
                    onContextMenu={event => {
                      if (isProtected) return;
                      event.preventDefault();
                      setCategoryMenu(tag);
                    }}
                  >
                    <button
                      type="button"
                      className={`tool-tree-chevron ${isExpanded ? 'expanded' : ''}`}
                      onClick={() => toggleTag(tag)}
                      aria-label={`${isExpanded ? '收起' : '展开'}${BUILTIN_TAG_META[tag] || tag}`}
                      aria-controls={groupId}
                    >
                      <LineIcon name="chevronRight" />
                    </button>
                    {isRenaming ? (
                      <label className="tool-category-inline-editor">
                        <span className="tool-folder-glyph" aria-hidden="true" />
                        <span className="tool-category-editor-field">
                          <span className="sr-only">重命名 {tag}</span>
                          <input
                            autoFocus
                            value={categoryDraft.value}
                            onChange={event => setCategoryDraft(current => current ? { ...current, value: event.target.value, error: undefined } : current)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') { event.preventDefault(); commitCategoryDraft(); }
                              if (event.key === 'Escape') { event.preventDefault(); cancelCategoryDraft(); }
                            }}
                            onBlur={commitCategoryDraft}
                            aria-invalid={Boolean(categoryDraft.error)}
                          />
                          {categoryDraft.error && <small role="alert">{categoryDraft.error}</small>}
                        </span>
                      </label>
                    ) : (
                      <>
                        <button
                          type="button"
                          role="treeitem"
                          aria-expanded={isExpanded}
                          aria-selected={isSelected}
                          className="tool-tree-folder-button"
                          onClick={() => selectFolderCategory(tag)}
                          onDoubleClick={() => beginRenameCategory(tag)}
                          onKeyDown={event => {
                            if (event.key === 'F2') {
                              event.preventDefault();
                              beginRenameCategory(tag);
                            }
                          }}
                        >
                          <span className="tool-folder-glyph" aria-hidden="true" />
                          <span>{BUILTIN_TAG_META[tag] || tag}</span>
                          <small>{sourceFilteredTools.filter(tool => tool.category === tag).length}</small>
                        </button>
                        {!isProtected && (
                          <div className="tool-tree-folder-menu-wrap" data-category-menu>
                            <button
                              type="button"
                              className="tool-tree-folder-more"
                              aria-label={`${tag} 文件夹操作`}
                              aria-haspopup="menu"
                              aria-expanded={categoryMenu === tag}
                              onClick={() => setCategoryMenu(current => current === tag ? null : tag)}
                            >
                              <span aria-hidden="true">···</span>
                            </button>
                            {categoryMenu === tag && (
                              <div className="tool-category-menu" role="menu">
                                <button type="button" role="menuitem" onClick={() => beginRenameCategory(tag)}>重命名 <kbd>F2</kbd></button>
                                <button type="button" role="menuitem" className="danger" onClick={() => deleteCategory(tag)}>删除</button>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="tool-tree-group" id={groupId} role="group">
                      {treeTools.map(tool => (
                        <button
                          type="button"
                          role="treeitem"
                          aria-selected={selectedTool ? toolIdentity(selectedTool) === toolIdentity(tool) : false}
                          className={`tool-tree-file ${selectedTool && toolIdentity(selectedTool) === toolIdentity(tool) ? 'selected' : ''}`}
                          key={toolIdentity(tool)}
                          onClick={() => selectTool(tool)}
                        >
                          <span className="tool-file-glyph" aria-hidden="true" />
                          <span>{tool.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {categoryDraft?.mode === 'create' && (
              <div className="tool-category-editor-row" role="none">
                <span aria-hidden="true" />
                <span className="tool-folder-glyph" aria-hidden="true" />
                <label className="tool-category-editor-field">
                  <span className="sr-only">新文件夹名称</span>
                  <input
                    autoFocus
                    value={categoryDraft.value}
                    onChange={event => setCategoryDraft(current => current ? { ...current, value: event.target.value, error: undefined } : current)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); commitCategoryDraft(); }
                      if (event.key === 'Escape') { event.preventDefault(); cancelCategoryDraft(); }
                    }}
                    onBlur={commitCategoryDraft}
                    aria-invalid={Boolean(categoryDraft.error)}
                  />
                  {categoryDraft.error && <small role="alert">{categoryDraft.error}</small>}
                </label>
              </div>
            )}

            {searchQuery && visibleTags.length === 0 && (
              <div className="tool-tree-no-match">目录中没有匹配项</div>
            )}
          </div>
        </aside>

        <main className="tool-catalog-content">
          <header className="tool-content-head">
            <div>
              <div className="tool-breadcrumb">工具目录 {tagFilter !== 'all' && !searchQuery ? `/ ${BUILTIN_TAG_META[tagFilter] || tagFilter}` : ''}</div>
              <h2>{currentCategoryName}</h2>
              <p>{currentCategoryDescription}</p>
            </div>
            <button className="btn btn-sm" onClick={() => setSearch('')} disabled={!searchQuery}>清除搜索</button>
          </header>

          <div className="tool-content-metrics" aria-label="当前工具摘要">
            <span><strong>{filtered.length}</strong> 工具</span>
            <span><strong>{filtered.filter(tool => tool.annotations?.readOnlyHint).length}</strong> 只读</span>
            <span><strong>{filtered.filter(tool => 'source' in tool).length}</strong> 扩展</span>
          </div>

          {internalToolsError && <div className="tool-catalog-inline-error">内部工具加载失败：{internalToolsError}</div>}
          {platformToolsError && <div className="tool-catalog-inline-error">平台 MCP 动态工具加载失败：{platformToolsError}</div>}

          {filtered.length === 0 ? (
            <div className="tool-catalog-empty">
              <span className="tool-empty-folder" aria-hidden="true" />
              <strong>{searchQuery ? '没有匹配的工具' : '这个文件夹还是空的'}</strong>
              <p>{searchQuery ? '尝试清除搜索，或从左侧选择其他目录。' : '可以注册一个工具，并将它保存到当前分类。'}</p>
              {!searchQuery && tagFilter !== 'all' && (
                <button className="btn btn-sm" onClick={() => { resetToolForm(); setForm(current => ({ ...current, category: tagFilter })); setToolFormOpen(true); }}>
                  <LineIcon name="plus" />
                  注册到此文件夹
                </button>
              )}
            </div>
          ) : (
            <div className="tool-list-table" role="list" aria-label={currentCategoryName}>
              <div className="tool-list-header" aria-hidden="true">
                <span>名称</span><span>说明</span><span>来源</span><span>权限</span>
              </div>
              {filtered.map(tool => (
                <button
                  type="button"
                  role="listitem"
                  className={`tool-list-row ${selectedTool && toolIdentity(selectedTool) === toolIdentity(tool) ? 'selected' : ''}`}
                  key={toolIdentity(tool)}
                  onClick={() => selectTool(tool)}
                >
                  <span className="tool-list-name"><span className="tool-file-glyph" aria-hidden="true" /><code>{tool.name}</code></span>
                  <span className="tool-list-description">{tool.description}</span>
                  <span><em className={`tool-source-pill ${!('source' in tool) ? 'is-builtin' : tool.source === 'platform' ? 'is-platform' : tool.source === 'internal' ? 'is-internal' : 'is-custom'}`}>{toolSourceLabel(tool)}</em></span>
                  <span className="tool-list-permission">{tool.annotations?.readOnlyHint ? '只读' : tool.annotations?.destructiveHint ? '需确认' : '标准'}</span>
                </button>
              ))}
            </div>
          )}

          {selectedTool && (
            <section className="tool-detail-panel fade-in" aria-label={`${selectedTool.name} 详情`}>
              <div className="tool-detail-head">
                <div>
                  <span>{BUILTIN_TAG_META[selectedTool.category] || selectedTool.category}</span>
                  <h3>{selectedTool.name}</h3>
                  <p>{selectedTool.description}</p>
                </div>
                <div className="tool-detail-actions">
                  {'source' in selectedTool && selectedTool.source !== 'internal' && selectedTool.source !== 'platform' && (
                    <>
                      <button className="btn btn-sm" onClick={() => startEditTool(selectedTool)}>编辑</button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(selectedTool.name)}>删除</button>
                    </>
                  )}
                  <button className="btn btn-sm" onClick={() => setSelectedTool(null)} aria-label="关闭工具详情">关闭</button>
                </div>
              </div>

              {'source' in selectedTool && selectedTool.source === 'internal' && internalToolHasModelConfig(selectedTool.name) && (
                <div className="tool-internal-config">
                  <div className="form-group">
                    <label>默认模型</label>
                    <select
                      value={internalToolModelValue(selectedTool.name)}
                      onChange={event => setInternalToolDraftModels(current => ({ ...current, [selectedTool.name]: event.target.value }))}
                      disabled={savingInternalToolId === selectedTool.name}
                    >
                      <option value="">未配置，调用时由 Agent 传 model</option>
                      {internalToolModelOptions(selectedTool.name).map(model => <option key={model} value={model}>{model}</option>)}
                      {providerModels.length === 0 && <option value="" disabled>暂无可选模型</option>}
                    </select>
                    <small>供应商由账户 provider profile 的可用模型路由决定。</small>
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => saveInternalToolModel(selectedTool.name)}
                    disabled={!canConfigureInternalTools || savingInternalToolId === selectedTool.name || internalToolModelValue(selectedTool.name) === defaultModelFromSetting(internalToolSettings[selectedTool.name])}
                  >
                    {savingInternalToolId === selectedTool.name ? '保存中...' : '保存默认模型'}
                  </button>
                  {!canConfigureInternalTools && <span className="badge badge-muted">仅租户管理员可修改</span>}
                </div>
              )}

              <JsonViewer data={selectedTool} maxHeight={400} />
            </section>
          )}
        </main>
      </div>

      <details className="tool-register-panel" open={toolFormOpen} onToggle={event => setToolFormOpen(event.currentTarget.open)}>
        <summary>{editingToolName ? `编辑 MCP 工具：${editingToolName}` : '注册 MCP 工具'}</summary>
        <div className="tool-register-body">
          <div className="grid-2">
            <div>
              <div className="form-group"><label>MCP 服务器名</label><input value={form.mcpServer} onChange={e => setForm({ ...form, mcpServer: e.target.value })} placeholder="minecraft" style={{ fontFamily: 'var(--font-mono)' }} /></div>
              <div className="grid-2">
                <div className="form-group"><label>工具名 *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="my-tool" /></div>
                <div className="form-group"><label>分类 *</label><input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder="Minecraft" list="tag-list" /><datalist id="tag-list">{tags.map(t => <option key={t} value={t} />)}</datalist></div>
              </div>
              <div className="form-group"><label>描述 *</label><input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="工具功能描述" /></div>
              <div className="form-group"><label>inputSchema (JSON)</label><textarea value={form.inputSchema} onChange={e => setForm({ ...form, inputSchema: e.target.value })} rows={3} style={{ fontFamily: 'var(--font-mono)', fontSize: '.8em' }} /></div>
            </div>
            <div>
              <div className="form-group"><label>ToolAnnotations</label>
                {[['readOnlyHint', '只读'], ['destructiveHint', '破坏性'], ['idempotentHint', '幂等'], ['openWorldHint', '外部']].map(([k, v]) => (<label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: '.82em' }}><input type="checkbox" checked={!!form[k as keyof typeof form]} onChange={e => setForm({ ...form, [k]: e.target.checked })} style={{ width: 'auto' }} />{k} ({v})</label>))}
              </div>
              <details style={{ marginBottom: 8 }}><summary style={{ fontSize: '.82em', fontWeight: 600, color: 'var(--info)', cursor: 'pointer' }}>API 端点</summary>
                <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--info-bg)', borderRadius: 6 }}>
                  <div className="form-group"><label>URL</label><input value={form.endpointUrl} onChange={e => setForm({ ...form, endpointUrl: e.target.value })} placeholder="http://localhost:3005/api/action" style={{ fontFamily: 'var(--font-mono)', fontSize: '.78em' }} /></div>
                  <div className="grid-2"><div className="form-group"><label>Method</label><select value={form.endpointMethod} onChange={e => setForm({ ...form, endpointMethod: e.target.value as ToolEndpoint['method'] })}>{['GET','POST','PUT','DELETE','PATCH'].map(m => <option key={m} value={m}>{m}</option>)}</select></div><div className="form-group"><label>Headers (JSON)</label><input value={form.endpointHeaders} onChange={e => setForm({ ...form, endpointHeaders: e.target.value })} placeholder='{"Authorization":"Bearer {{token}}"}' style={{ fontFamily: 'var(--font-mono)', fontSize: '.78em' }} /></div></div>
                  <div className="form-group"><label>Body ({'{{param}}'})</label><textarea value={form.endpointBody} onChange={e => setForm({ ...form, endpointBody: e.target.value })} rows={2} style={{ fontFamily: 'var(--font-mono)', fontSize: '.78em' }} /></div>
                </div>
              </details>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={handleRegister}>{editingToolName ? '保存工具定义' : '注册工具'}</button>
                <button className="btn" onClick={resetToolForm}>{editingToolName ? '取消编辑' : '取消'}</button>
              </div>
            </div>
          </div>
        </div>
      </details>

      {mcpServers.length > 0 && (
        <details className="tool-secondary-panel">
          <summary>MCP 服务端管理 <span>{mcpServers.length}</span></summary>
          <div className="tool-secondary-body">
            {mcpServers.map(server => (
              <McpServerCard key={server} server={server} tools={customTools.filter(tool => tool.mcpServer === server)} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

type ToolsHubTab = 'catalog' | 'mcp';

export default function Tools() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: ToolsHubTab = searchParams.get('tab') === 'mcp' ? 'mcp' : 'catalog';
  const selectTab = (tab: ToolsHubTab) => {
    setSearchParams(tab === 'mcp' ? { tab: 'mcp' } : {}, { replace: true });
  };

  return (
    <div className="tools-hub">
      <div className="tools-hub-tabs" role="tablist" aria-label="工具管理视图">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'catalog'}
          className={activeTab === 'catalog' ? 'active' : ''}
          onClick={() => selectTab('catalog')}
        >
          <LineIcon name="tools" />
          <strong>工具目录</strong>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'mcp'}
          className={activeTab === 'mcp' ? 'active' : ''}
          onClick={() => selectTab('mcp')}
        >
          <LineIcon name="radio" />
          <strong>MCP 连接</strong>
        </button>
      </div>
      <div className="tools-hub-panel" role="tabpanel">
        {activeTab === 'mcp' ? <McpConnections /> : <ToolCatalog />}
      </div>
    </div>
  );
}
