import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import LineIcon from '../components/LineIcon';
import { getAuthHeaders } from '../utils/client-runtime';

type McpConnection = {
  id: string;
  name: string;
  url: string;
  type: 'http' | 'sse';
  headers: Record<string, string>;
  hasHeaders: boolean;
  description: string;
  enabled: boolean;
  createdBy: string;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
};

type HeaderDraft = { id: string; name: string; value: string };
type ConnectionForm = {
  name: string;
  url: string;
  type: 'http' | 'sse';
  description: string;
  enabled: boolean;
  headers: HeaderDraft[];
};

type CheckResult = {
  ok: true;
  server: { name: string; version: string } | null;
  tools: Array<{ name: string; description: string }>;
};

const EMPTY_FORM: ConnectionForm = {
  name: '',
  url: '',
  type: 'http',
  description: '',
  enabled: true,
  headers: [{ id: 'authorization', name: 'Authorization', value: '' }],
};

function newHeader(): HeaderDraft {
  return { id: crypto.randomUUID(), name: '', value: '' };
}

function formatDate(value: number | null) {
  if (!value) return '从未';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `请求失败 (${response.status})`);
  return data;
}

export default function McpConnections() {
  const { user } = useAuth();
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<McpConnection | null>(null);
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [replaceHeaders, setReplaceHeaders] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [checkingId, setCheckingId] = useState('');
  const [checkTarget, setCheckTarget] = useState<McpConnection | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState('');
  const [publishTarget, setPublishTarget] = useState<McpConnection | null>(null);

  const actor = user?.id || user?.email || '';
  const canManage = useCallback((connection: McpConnection) => (
    user?.role === 'tenant_admin' || connection.createdBy === actor
  ), [actor, user?.role]);

  const loadConnections = useCallback(async () => {
    try {
      setError('');
      const response = await fetch('/api/mcp-connections', { headers: getAuthHeaders() });
      const data = await readJson(response);
      setConnections(Array.isArray(data) ? data : []);
    } catch (err) {
      setError((err as Error).message || '读取 MCP 连接失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadConnections(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConnections]);

  useEffect(() => {
    if (!formOpen && !publishTarget && !checkTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setFormOpen(false);
      setPublishTarget(null);
      setCheckTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [checkTarget, formOpen, publishTarget]);

  const stats = useMemo(() => ({
    enabled: connections.filter((item) => item.enabled).length,
    published: connections.filter((item) => item.publishedAt).length,
    healthy: connections.filter((item) => item.lastCheckOk === true).length,
  }), [connections]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, headers: [{ id: crypto.randomUUID(), name: 'Authorization', value: '' }] });
    setReplaceHeaders(true);
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (connection: McpConnection) => {
    setEditing(connection);
    setForm({
      name: connection.name,
      url: connection.url,
      type: connection.type,
      description: connection.description,
      enabled: connection.enabled,
      headers: [newHeader()],
    });
    setReplaceHeaders(false);
    setFormError('');
    setFormOpen(true);
  };

  const updateHeader = (id: string, patch: Partial<HeaderDraft>) => {
    setForm((current) => ({
      ...current,
      headers: current.headers.map((header) => header.id === id ? { ...header, ...patch } : header),
    }));
  };

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const headers = Object.fromEntries(form.headers
        .map((header) => [header.name.trim(), header.value.trim()] as const)
        .filter(([name, value]) => name && value));
      const payload: Record<string, unknown> = {
        name: form.name,
        url: form.url,
        type: form.type,
        description: form.description,
        enabled: form.enabled,
      };
      if (!editing || replaceHeaders) payload.headers = headers;
      const response = await fetch(editing ? `/api/mcp-connections/${editing.id}` : '/api/mcp-connections', {
        method: editing ? 'PATCH' : 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      await readJson(response);
      setFormOpen(false);
      await loadConnections();
    } catch (err) {
      setFormError((err as Error).message || '保存 MCP 连接失败');
    } finally {
      setSaving(false);
    }
  };

  const mutateConnection = async (connection: McpConnection, action: string, init: RequestInit = {}) => {
    setError('');
    try {
      const response = await fetch(`/api/mcp-connections/${connection.id}${action}`, {
        ...init,
        headers: getAuthHeaders(init.headers || {}),
      });
      await readJson(response);
      await loadConnections();
    } catch (err) {
      setError((err as Error).message || '操作失败');
    }
  };

  const runCheck = async (connection: McpConnection) => {
    setCheckingId(connection.id);
    setCheckTarget(connection);
    setCheckResult(null);
    setCheckError('');
    try {
      const response = await fetch(`/api/mcp-connections/${connection.id}/check`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      setCheckResult(await readJson(response));
      await loadConnections();
    } catch (err) {
      setCheckError((err as Error).message || '连接测试失败');
      await loadConnections();
    } finally {
      setCheckingId('');
    }
  };

  const confirmDelete = async (connection: McpConnection) => {
    if (!window.confirm(`删除 MCP 连接 "${connection.name}"？使用该名称的模板将回退为普通 .mcp.json 引用。`)) return;
    await mutateConnection(connection, '', { method: 'DELETE' });
  };

  return (
    <div className="mcp-connections-page">
      <div className="mcp-connections-toolbar">
        <div className="mcp-connection-stats" aria-label="MCP 连接概览">
          <span><strong>{connections.length}</strong> 连接</span>
          <span><strong>{stats.enabled}</strong> 启用</span>
          <span><strong>{stats.published}</strong> 已发布</span>
          <span><strong>{stats.healthy}</strong> 最近正常</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          <LineIcon name="radio" />
          新建连接
        </button>
      </div>

      <div className="mcp-security-note">
        <LineIcon name="shield" />
        <div>
          <strong>凭据只在服务端解密并注入 SDK。</strong>
          <span>不要连接不可信 MCP；数据库 MCP 应使用只读账号。发布连接会把同一认证能力共享给整个租户。</span>
        </div>
      </div>

      {error && <div className="mcp-inline-error" role="alert">{error}</div>}

      <div className="mcp-connections-table-wrap">
        <table className="mcp-connections-table">
          <thead>
            <tr>
              <th>连接</th>
              <th>端点</th>
              <th>可见性</th>
              <th>最近检查</th>
              <th><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="mcp-empty-row">正在读取连接...</td></tr>
            )}
            {!loading && connections.length === 0 && (
              <tr>
                <td colSpan={5} className="mcp-empty-row">
                  <strong>还没有 MCP 连接</strong>
                  <span>添加一个远程 HTTP/SSE MCP，然后在 Agent 模板里勾选使用。</span>
                  <button type="button" className="btn btn-sm" onClick={openCreate}>新建第一个连接</button>
                </td>
              </tr>
            )}
            {connections.map((connection) => (
              <tr key={connection.id} className={!connection.enabled ? 'is-disabled' : ''}>
                <td>
                  <div className="mcp-name-cell">
                    <span className={`mcp-status-dot ${connection.enabled ? 'is-on' : 'is-off'}`} aria-hidden="true" />
                    <div>
                      <code>{connection.name}</code>
                      <span>{connection.description || (connection.enabled ? '已启用' : '已停用')}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="mcp-endpoint-cell">
                    <span className="badge badge-info">{connection.type}</span>
                    <span title={connection.url}>{connection.url}</span>
                    {connection.hasHeaders && <span className="badge badge-muted">已认证</span>}
                  </div>
                </td>
                <td>
                  <span className={`badge ${connection.publishedAt ? 'badge-success' : 'badge-muted'}`}>
                    {connection.publishedAt ? '租户共享' : '私有'}
                  </span>
                </td>
                <td>
                  <div className="mcp-check-cell">
                    <span className={`mcp-check-state ${connection.lastCheckOk === true ? 'is-ok' : connection.lastCheckOk === false ? 'is-bad' : ''}`}>
                      {connection.lastCheckOk === true ? '正常' : connection.lastCheckOk === false ? '失败' : '未检查'}
                    </span>
                    <span>{formatDate(connection.lastCheckAt)}</span>
                  </div>
                </td>
                <td>
                  <div className="mcp-row-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={checkingId === connection.id}
                      onClick={() => void runCheck(connection)}
                    >
                      <LineIcon name="bolt" />
                      {checkingId === connection.id ? '测试中' : '测试'}
                    </button>
                    {canManage(connection) && (
                      <>
                        <button type="button" className="btn btn-sm" onClick={() => openEdit(connection)}>
                          <LineIcon name="sliders" />
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => connection.publishedAt
                            ? void mutateConnection(connection, '/unpublish', { method: 'POST' })
                            : setPublishTarget(connection)}
                        >
                          <LineIcon name="layers" />
                          {connection.publishedAt ? '取消发布' : '发布'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void mutateConnection(connection, '', {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled: !connection.enabled }),
                          })}
                        >
                          {connection.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn mcp-delete-btn"
                          onClick={() => void confirmDelete(connection)}
                          aria-label={`删除 ${connection.name}`}
                          title="删除连接"
                        >
                          <LineIcon name="trash" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mcp-db-guide" aria-labelledby="mcp-db-guide-title">
        <div className="mcp-db-guide-head">
          <span className="mcp-guide-icon"><LineIcon name="layers" /></span>
          <div>
            <h2 id="mcp-db-guide-title">连接自己的数据库</h2>
            <p>按数据新鲜度与安全责任选择接入路径。</p>
          </div>
        </div>
        <div className="mcp-db-paths">
          <article>
            <span className="mcp-path-index">A</span>
            <h3>上传数据文件</h3>
            <p>适合静态报表和一次性分析。上传 SQLite、CSV 或 Excel，平台转换后提供只读查询。</p>
          </article>
          <article className="is-recommended">
            <span className="mcp-path-index">B</span>
            <h3>远程数据库 MCP</h3>
            <p>推荐的在线库接法。在自己的环境部署 HTTP MCP，使用数据库只读账号，再把 MCP token 配到这里。</p>
            <ol>
              <li>部署可信的 streamable HTTP/SSE MCP 服务。</li>
              <li>为 MCP 创建数据库只读账号。</li>
              <li>新建连接并测试工具清单。</li>
              <li>在 Agent 模板中勾选连接。</li>
            </ol>
          </article>
          <article>
            <span className="mcp-path-index">C</span>
            <h3>平台直连数据库</h3>
            <p>Postgres/MySQL 原生连接器规划中。本期不托管数据库连接串，也不直接访问在线数据库。</p>
          </article>
        </div>
      </section>

      {formOpen && (
        <div className="mcp-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFormOpen(false);
        }}>
          <div className="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-form-title">
            <div className="mcp-modal-head">
              <div>
                <span className="eyebrow">remote mcp</span>
                <h2 id="mcp-form-title">{editing ? `编辑 ${editing.name}` : '新建 MCP 连接'}</h2>
              </div>
              <button type="button" className="icon-btn" onClick={() => setFormOpen(false)} aria-label="关闭">
                <LineIcon name="x" />
              </button>
            </div>
            <form onSubmit={submitForm}>
              <div className="mcp-form-grid">
                <div className="form-group">
                  <label htmlFor="mcp-name">名称</label>
                  <input id="mcp-name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="mydb" />
                  <span className="mcp-field-help">工具前缀为 mcp__名称__*，保存后可在模板中勾选。</span>
                </div>
                <div className="form-group">
                  <label htmlFor="mcp-type">传输类型</label>
                  <select id="mcp-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as 'http' | 'sse' })}>
                    <option value="http">Streamable HTTP</option>
                    <option value="sse">SSE</option>
                  </select>
                </div>
                <div className="form-group mcp-form-wide">
                  <label htmlFor="mcp-url">MCP URL</label>
                  <input id="mcp-url" type="url" required value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://mcp.example.com/mcp" />
                  <span className="mcp-field-help">默认只接受 HTTPS，并拒绝私网、回环和链路本地地址。</span>
                </div>
                <div className="form-group mcp-form-wide">
                  <label htmlFor="mcp-description">说明</label>
                  <textarea id="mcp-description" rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="只读查询生产分析库" />
                </div>
              </div>

              <fieldset className="mcp-header-fieldset">
                <div className="mcp-header-legend">
                  <div>
                    <legend>认证 headers</legend>
                    <span>支持 Authorization、X-Api-Key 和自定义 X-*；值只写不读。</span>
                  </div>
                  {editing?.hasHeaders && !replaceHeaders && (
                    <button type="button" className="btn btn-sm" onClick={() => setReplaceHeaders(true)}>替换认证</button>
                  )}
                </div>
                {editing?.hasHeaders && !replaceHeaders ? (
                  <div className="mcp-existing-headers">
                    {Object.entries(editing.headers).map(([name, value]) => <code key={name}>{name}: {value}</code>)}
                    <span>保存时将保留现有认证 header。</span>
                  </div>
                ) : (
                  <>
                    {form.headers.map((header) => (
                      <div className="mcp-header-row" key={header.id}>
                        <input aria-label="Header 名称" value={header.name} onChange={(event) => updateHeader(header.id, { name: event.target.value })} placeholder="Authorization" />
                        <input aria-label="Header 值" type="password" autoComplete="off" value={header.value} onChange={(event) => updateHeader(header.id, { value: event.target.value })} placeholder="Bearer token" />
                        <button type="button" className="icon-btn" onClick={() => setForm((current) => ({ ...current, headers: current.headers.filter((item) => item.id !== header.id) }))} aria-label="移除 header">
                          <LineIcon name="trash" />
                        </button>
                      </div>
                    ))}
                    <button type="button" className="btn btn-sm" onClick={() => setForm((current) => ({ ...current, headers: [...current.headers, newHeader()] }))}>添加 header</button>
                  </>
                )}
              </fieldset>

              <label className="mcp-enabled-toggle">
                <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
                <span>启用连接</span>
              </label>

              {formError && <div className="mcp-inline-error" role="alert">{formError}</div>}
              <div className="mcp-modal-actions">
                <button type="button" className="btn" onClick={() => setFormOpen(false)}>取消</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? '保存中...' : '保存连接'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {publishTarget && (
        <div className="mcp-modal-backdrop" role="presentation">
          <div className="mcp-modal mcp-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="mcp-publish-title">
            <div className="mcp-modal-head">
              <div>
                <span className="eyebrow">credential sharing</span>
                <h2 id="mcp-publish-title">发布 {publishTarget.name}？</h2>
              </div>
              <button type="button" className="icon-btn" onClick={() => setPublishTarget(null)} aria-label="关闭"><LineIcon name="x" /></button>
            </div>
            <p>发布后，租户内任何用户运行引用该连接的 Agent 时，都会使用创建者配置的认证 header。请确认 MCP 背后使用只读账号，并且查询能力可以共享。</p>
            <div className="mcp-modal-actions">
              <button type="button" className="btn" onClick={() => setPublishTarget(null)}>取消</button>
              <button type="button" className="btn btn-primary" onClick={() => {
                const target = publishTarget;
                setPublishTarget(null);
                void mutateConnection(target, '/publish', { method: 'POST' });
              }}>确认发布并共享凭据</button>
            </div>
          </div>
        </div>
      )}

      {checkTarget && (
        <div className="mcp-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && checkingId !== checkTarget.id) setCheckTarget(null);
        }}>
          <div className="mcp-modal mcp-check-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-check-title">
            <div className="mcp-modal-head">
              <div>
                <span className="eyebrow">connection check</span>
                <h2 id="mcp-check-title">{checkTarget.name} 工具清单</h2>
              </div>
              <button type="button" className="icon-btn" disabled={checkingId === checkTarget.id} onClick={() => setCheckTarget(null)} aria-label="关闭"><LineIcon name="x" /></button>
            </div>
            {checkingId === checkTarget.id && <div className="mcp-check-loading"><span />正在进行 MCP initialize 与 tools/list...</div>}
            {checkError && <div className="mcp-inline-error" role="alert">{checkError}</div>}
            {checkResult && (
              <>
                <div className="mcp-check-summary">
                  <span className="badge badge-success">握手成功</span>
                  <span>{checkResult.server ? `${checkResult.server.name} ${checkResult.server.version}` : '服务器未声明版本'}</span>
                  <strong>{checkResult.tools.length} 个工具</strong>
                </div>
                <div className="mcp-tool-list">
                  {checkResult.tools.length === 0 && <p>服务器握手成功，但没有声明工具。</p>}
                  {checkResult.tools.map((tool) => (
                    <div key={tool.name}>
                      <code>{tool.name}</code>
                      <p>{tool.description || '无描述'}</p>
                    </div>
                  ))}
                </div>
                <p className="mcp-untrusted-note"><LineIcon name="shield" /> 工具描述来自第三方 MCP，属于不可信输入。只连接你确认可信的服务。</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
