import { useEffect, useState } from 'react';
import type { BuiltInTool, RegisteredTool, ToolEndpoint } from '../simulator/types';
import { BUILT_IN_TOOLS, initCustomTools, saveCustomTools } from '../simulator/mock-data';
import JsonViewer from '../components/common/JsonViewer';
import { McpServerCard } from '../components/McpServerManager';
import { getAuthHeaders } from '../utils/client-runtime';
import { useAuth } from '../contexts/AuthContext';
import { fetchProviderModels, listProviderModels } from '../utils/providers';

const BUILTIN_TAG_META: Record<string, string> = {
  file: '文件操作', execution: '命令执行', task: '任务管理',
  search: '搜索查询', interaction: '用户交互', mcp: 'MCP 资源', notebook: 'Notebook', agent: '子代理',
};

type InternalToolSetting = {
  toolId: string;
  settings: Record<string, unknown>;
};

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

export default function Tools() {
  const { user } = useAuth();
  const [customTools, setCustomTools] = useState<RegisteredTool[]>(() => initCustomTools());
  const [internalTools, setInternalTools] = useState<RegisteredTool[]>([]);
  const [internalToolsError, setInternalToolsError] = useState('');
  const [providerModels, setProviderModels] = useState<string[]>(() => listProviderModels());
  const [internalToolSettings, setInternalToolSettings] = useState<Record<string, InternalToolSetting>>({});
  const [internalToolDraftModels, setInternalToolDraftModels] = useState<Record<string, string>>({});
  const [savingInternalToolId, setSavingInternalToolId] = useState('');
  const [selectedTool, setSelectedTool] = useState<BuiltInTool | RegisteredTool | null>(null);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [tagRenaming, setTagRenaming] = useState<{ old: string; val: string } | null>(null);
  const [newTagName, setNewTagName] = useState('');
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

  const allTools: (BuiltInTool | RegisteredTool)[] = [...BUILT_IN_TOOLS, ...internalTools, ...customTools];
  const tags = Array.from(new Set(allTools.map(t => t.category)));
  const persist = (list: RegisteredTool[]) => { setCustomTools(list); saveCustomTools(list); };

  const searchQuery = search.trim().toLowerCase();
  const filtered = allTools
    .filter(t => searchQuery || tagFilter === 'all' || t.category === tagFilter)
    .filter(t => {
      if (!searchQuery) return true;
      return t.name.toLowerCase().includes(searchQuery)
        || t.description.toLowerCase().includes(searchQuery)
        || t.category.toLowerCase().includes(searchQuery);
    });

  const resetToolForm = () => {
    setForm({ ...EMPTY_TOOL_FORM });
    setEditingToolName('');
    setToolFormOpen(false);
  };
  const handleDelete = (name: string) => {
    persist(customTools.filter(t => t.name !== name));
    if (editingToolName === name) resetToolForm();
  };
  const startEditTool = (tool: RegisteredTool) => {
    if (tool.source === 'internal') return;
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
  const startRename = (tag: string) => setTagRenaming({ old: tag, val: tag });
  const confirmRename = () => {
    if (!tagRenaming || !tagRenaming.val.trim() || tagRenaming.val === tagRenaming.old) { setTagRenaming(null); return; }
    persist(customTools.map(t => t.category === tagRenaming.old ? { ...t, category: tagRenaming.val.trim() } : t));
    if (tagFilter === tagRenaming.old) setTagFilter(tagRenaming.val.trim());
    setTagRenaming(null);
  };
  const deleteTag = (tag: string) => {
    if (BUILTIN_TAG_META[tag]) return;
    persist(customTools.map(t => t.category === tag ? { ...t, category: '未分类' } : t));
    if (tagFilter === tag) setTagFilter('all');
  };
  const createTag = () => { if (newTagName.trim() && !tags.includes(newTagName.trim())) { setTagFilter(newTagName.trim()); setNewTagName(''); } };

  const handleRegister = () => {
    if (!form.name || !form.description || !form.category) return;
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
      name: form.name, description: form.description, category: form.category,
      inputSchema,
      annotations: { readOnlyHint: form.readOnlyHint, destructiveHint: form.destructiveHint, idempotentHint: form.idempotentHint, openWorldHint: form.openWorldHint },
      source: 'local', endpoint, mcpServer: form.mcpServer || undefined,
    };
    const baseTools = editingToolName ? customTools.filter(t => t.name !== editingToolName) : customTools;
    const existing = baseTools.find(t => t.name === tool.name);
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
    <div>
      <div className="page-header">
        <h1>🎒 工具 & MCP</h1>
        <p>按 Tag 分类管理 — 内置工具 + 自定义 MCP 工具，通过 mcpServers 注入 SDK</p>
      </div>

      {(internalTools.length > 0 || internalToolsError) && (
        <div className="section mb-4">
          <div className="section-title">内部工具</div>
          {internalToolsError ? (
            <div className="badge badge-danger">加载失败: {internalToolsError}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {internalTools.map(tool => (
                <div
                  key={tool.name}
                  className="tool-card"
                  style={{ cursor: 'default' }}
                >
                  <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="tool-card-name">{tool.name}</div>
                      <div className="tool-card-desc">{tool.description}</div>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setTagFilter(tool.category);
                        setSearch(tool.name);
                      }}
                      style={{ fontFamily: 'var(--font-mono)', flexShrink: 0 }}
                    >
                      定位
                    </button>
                  </div>
                  {internalToolHasModelConfig(tool.name) && (
                    <div className="mt-2" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end' }}>
                      <div className="form-group" style={{ marginBottom: 0, flex: '1 1 260px', minWidth: 220 }}>
                        <label>默认模型</label>
                        <select
                          value={internalToolModelValue(tool.name)}
                          onChange={event => setInternalToolDraftModels(current => ({ ...current, [tool.name]: event.target.value }))}
                          disabled={savingInternalToolId === tool.name}
                        >
                          <option value="">未配置，调用时由 Agent 传 model</option>
                          {internalToolModelOptions(tool.name).map(model => <option key={model} value={model}>{model}</option>)}
                          {providerModels.length === 0 && <option value="" disabled>暂无可选模型，请先在账户供应商配置里保存可用模型</option>}
                        </select>
                        <div style={{ color: 'var(--ink-muted)', fontSize: '.78em', marginTop: 4 }}>
                          供应商由账户 provider profile 的可用模型路由决定。
                        </div>
                        {providerModels.length === 0 && (
                          <div className="mt-2">
                            <span className="badge badge-warning">未读取到可用模型，请到账户管理的供应商配置填写精确模型 ID 并保存。</span>
                          </div>
                        )}
                      </div>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => saveInternalToolModel(tool.name)}
                        disabled={
                          !canConfigureInternalTools
                          || savingInternalToolId === tool.name
                          || internalToolModelValue(tool.name) === defaultModelFromSetting(internalToolSettings[tool.name])
                        }
                      >
                        {savingInternalToolId === tool.name ? '保存中...' : '保存'}
                      </button>
                    </div>
                  )}
                  {!canConfigureInternalTools && internalToolHasModelConfig(tool.name) && (
                    <div className="mt-2">
                      <span className="badge badge-muted">仅租户管理员可修改默认模型</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 搜索 + Tag 筛选 */}
      <div className="flex gap-3 mb-3" style={{ alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`搜索 ${allTools.length} 个工具...`} style={{ flex: 1, minWidth: 200, maxWidth: 340 }} />
        <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <button className={`btn btn-sm ${tagFilter === 'all' ? 'btn-primary' : ''}`} onClick={() => setTagFilter('all')}>全部 ({allTools.length})</button>
          {tags.map(tag => (
            <button key={tag} className={`btn btn-sm ${tagFilter === tag ? 'btn-primary' : ''}`} onClick={() => setTagFilter(tag)} onDoubleClick={e => { e.preventDefault(); if (!BUILTIN_TAG_META[tag]) startRename(tag); }} title="单击筛选，双击重命名自定义标签">
              {BUILTIN_TAG_META[tag] || tag} <span style={{ marginLeft: 4, opacity: .6 }}>{allTools.filter(t => t.category === tag).length}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tag 管理 */}
      <details className="card mb-4">
        <summary className="card-header" style={{ cursor: 'pointer', marginBottom: 0 }}>Tag 管理 (增/删/改)</summary>
        <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={newTagName} onChange={e => setNewTagName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') createTag(); }} placeholder="新标签名" style={{ width: 140, fontSize: '.82em' }} />
          <button className="btn btn-sm btn-primary" onClick={createTag}>新建 Tag</button>
          <span style={{ color: 'var(--ink-muted)', fontSize: '.78em' }}>· 双击上方标签按钮可重命名 · 内置标签不可删除</span>
        </div>
        {tagRenaming && (
          <div className="flex gap-2 mt-2 fade-in" style={{ alignItems: 'center' }}>
            <span style={{ fontSize: '.8em' }}>重命名 "{tagRenaming.old}" →</span>
            <input autoFocus value={tagRenaming.val} onChange={e => setTagRenaming({ ...tagRenaming, val: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setTagRenaming(null); }} style={{ width: 160, fontSize: '.82em' }} />
            <button className="btn btn-sm btn-primary" onClick={confirmRename}>确认</button>
            <button className="btn btn-sm" onClick={() => setTagRenaming(null)}>取消</button>
          </div>
        )}
        <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
          {tags.filter(t => !BUILTIN_TAG_META[t]).map(tag => (
            <span key={tag} className="flex gap-1" style={{ alignItems: 'center', fontSize: '.8em', background: 'var(--bg-hover)', padding: '2px 8px', borderRadius: 4 }}>
              {tag}
              <span onClick={() => deleteTag(tag)} style={{ cursor: 'pointer', color: 'var(--danger)', fontSize: '1.1em' }} title="删除标签">×</span>
            </span>
          ))}
        </div>
      </details>

      {/* MCP 服务器管理 */}
      {mcpServers.length > 0 && (
        <div className="section mt-4">
          <div className="section-title">MCP 服务端管理</div>
          {mcpServers.map(srv => {
            const st = customTools.filter(t => t.mcpServer === srv);
            return <McpServerCard key={srv} server={srv} tools={st} />;
          })}
        </div>
      )}

      {/* 工具卡片 */}
      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-muted)' }}>无匹配工具</div>
      ) : (
        <div className="grid-2">
          {filtered.map(tool => (
            <div key={tool.name} className="tool-card" onClick={() => setSelectedTool(tool)} style={{ cursor: 'pointer' }}>
              <div className="flex-between">
                <div className="tool-card-name">{tool.name}</div>
                {'source' in tool && <span className="badge badge-info">{(tool as RegisteredTool).source === 'internal' ? '内部' : '自定义'}</span>}
              </div>
              <div className="tool-card-desc">{tool.description}</div>
              <div className="mt-2 flex gap-2" style={{ flexWrap: 'wrap' }}>
                <span className="badge badge-muted">{BUILTIN_TAG_META[tool.category] || tool.category}</span>
                {'endpoint' in tool && (tool as RegisteredTool).endpoint && <span className="badge" style={{ background: 'var(--info-bg)', color: 'var(--info)' }}>{(tool as RegisteredTool).endpoint!.method} API</span>}
                {'mcpServer' in tool && (tool as RegisteredTool).mcpServer && <span className="badge" style={{ background: 'var(--success-bg)', color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: '.72em' }}>mcp__{(tool as RegisteredTool).mcpServer}__*</span>}
                {tool.annotations?.readOnlyHint && <span className="badge badge-success">只读</span>}
              </div>
              {'source' in tool && (tool as RegisteredTool).source !== 'internal' && (
                <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
                  <button className="btn btn-sm" onClick={e => { e.stopPropagation(); startEditTool(tool as RegisteredTool); }}>编辑</button>
                  <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); handleDelete(tool.name); }}>删除</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {selectedTool && (
        <div className="card mt-4 fade-in">
          <div className="flex-between"><div className="card-header" style={{ marginBottom: 0 }}>{selectedTool.name}</div><button className="btn btn-sm" onClick={() => setSelectedTool(null)}>关闭</button></div>
          <div className="mt-4"><JsonViewer data={selectedTool} maxHeight={400} /></div>
        </div>
      )}

      {/* 注册工具 */}
      <details className="section mt-4" open={toolFormOpen} onToggle={e => setToolFormOpen(e.currentTarget.open)}>
        <summary className="section-title" style={{ cursor: 'pointer' }}>
          {editingToolName ? `编辑 MCP 工具: ${editingToolName}` : '+ 注册 MCP 工具'}
        </summary>
        <div className="card mt-2" style={{ borderColor: 'var(--success)' }}>
          <div className="grid-2">
            <div>
              <div className="form-group"><label>MCP 服务器名</label><input value={form.mcpServer} onChange={e => setForm({ ...form, mcpServer: e.target.value })} placeholder="minecraft" style={{ fontFamily: 'var(--font-mono)' }} /></div>
              <div className="grid-2">
                <div className="form-group"><label>工具名 *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="my-tool" /></div>
                <div className="form-group"><label>Tag *</label><input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder="Minecraft" list="tag-list" /><datalist id="tag-list">{tags.map(t => <option key={t} value={t} />)}</datalist></div>
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
                {editingToolName && <button className="btn" onClick={resetToolForm}>取消编辑</button>}
              </div>
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
