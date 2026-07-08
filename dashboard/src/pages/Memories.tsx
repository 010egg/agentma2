import { useState, useEffect } from 'react';
import { getAuthHeaders } from '../utils/client-runtime';

type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
interface MemoryItem { name: string; description: string; type: MemoryType; updatedAt: number; sizeBytes: number }
interface MemoryDetail extends MemoryItem { body: string }

const TYPE_LABELS: Record<MemoryType, { label: string; color: string }> = {
  user: { label: '用户', color: 'var(--info)' },
  feedback: { label: '反馈', color: 'var(--warning)' },
  project: { label: '项目', color: 'var(--success)' },
  reference: { label: '引用', color: 'var(--accent)' },
};

const EMPTY_FORM = { name: '', description: '', type: 'project' as MemoryType, body: '' };

function shortDate(ts: number) {
  return ts ? new Date(ts).toLocaleString() : '';
}

export default function Memories() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/memory', { headers: getAuthHeaders() });
      const data = await res.json().catch(() => []);
      if (!res.ok) { setMsg({ type: 'error', text: data.error || `读取失败: HTTP ${res.status}` }); return; }
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setMsg({ type: 'error', text: `读取失败: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const toggleExpand = async (name: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
    if (!bodies[name]) {
      try {
        const res = await fetch(`/api/memory/${encodeURIComponent(name)}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.ok) setBodies(prev => ({ ...prev, [name]: (data as MemoryDetail).body || '' }));
      } catch { /* ignore */ }
    }
  };

  const startEdit = async (item: MemoryItem) => {
    let body = bodies[item.name];
    if (body === undefined) {
      try {
        const res = await fetch(`/api/memory/${encodeURIComponent(item.name)}`, { headers: getAuthHeaders() });
        const data = await res.json().catch(() => ({}));
        body = res.ok ? (data as MemoryDetail).body || '' : '';
        setBodies(prev => ({ ...prev, [item.name]: body! }));
      } catch { body = ''; }
    }
    setCreating(false);
    setEditing(item.name);
    setForm({ name: item.name, description: item.description, type: item.type, body: body || '' });
  };

  const save = async () => {
    const name = form.name.trim();
    if (!name || !form.body.trim()) { setMsg({ type: 'error', text: '名称与正文不能为空' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ description: form.description, type: form.type, body: form.body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ type: 'error', text: data.error || `保存失败: HTTP ${res.status}` }); return; }
      setBodies(prev => ({ ...prev, [data.name || name]: form.body }));
      setEditing(null); setCreating(false); setForm(EMPTY_FORM);
      setMsg({ type: 'success', text: `已保存记忆 "${data.name || name}"。` });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: `保存失败: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`删除记忆 "${name}"？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(name)}`, { method: 'DELETE', headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 404) { setMsg({ type: 'error', text: data.error || `删除失败: HTTP ${res.status}` }); return; }
      setItems(prev => prev.filter(m => m.name !== name));
      setMsg({ type: 'success', text: `已删除 "${name}"。` });
    } catch (e) {
      setMsg({ type: 'error', text: `删除失败: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const consolidate = async () => {
    if (!window.confirm('整理记忆：剔除空/损坏项、按正文去重、重建索引。继续？')) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/memory/consolidate', { method: 'POST', headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ type: 'error', text: data.error || `整理失败: HTTP ${res.status}` }); return; }
      setBodies({});
      setMsg({ type: 'success', text: `整理完成：保留 ${data.kept} 条，清理 ${data.removed} 条。` });
      await load();
    } catch (e) {
      setMsg({ type: 'error', text: `整理失败: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    setEditing(null);
    setCreating(true);
    setForm(EMPTY_FORM);
  };

  return (
    <div>
      <div className="page-header">
        <h1>🧠 Agent 记忆</h1>
        <p>跨会话的长期记忆（按用户隔离）。Agent 在对话中自动写入；你也可以在此查看、编辑、删除或整理。</p>
      </div>

      <div className="grid-3 mb-4">
        <div className="kpi-card">
          <div className="kpi-label">记忆条数</div>
          <div className="kpi-value">{items.length}</div>
          <div className="kpi-sub">当前账户</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">类型分布</div>
          <div className="kpi-value" style={{ fontSize: '.82em', fontFamily: 'var(--font-mono)' }}>
            {(['user', 'feedback', 'project', 'reference'] as MemoryType[])
              .map(t => `${TYPE_LABELS[t].label} ${items.filter(m => m.type === t).length}`).join(' · ')}
          </div>
          <div className="kpi-sub">user / feedback / project / reference</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">总体积</div>
          <div className="kpi-value">{(items.reduce((s, m) => s + m.sizeBytes, 0) / 1024).toFixed(1)}K</div>
          <div className="kpi-sub">注入上限 6K/次</div>
        </div>
      </div>

      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={startCreate} disabled={busy}>新建记忆</button>
        <button className="btn" onClick={() => { void consolidate(); }} disabled={busy || items.length === 0}>整理去重</button>
        <button className="btn" onClick={() => { void load(); }} disabled={loading}>{loading ? '刷新中...' : '刷新'}</button>
      </div>

      {msg && (
        <div className="card mb-4" style={{ borderColor: msg.type === 'success' ? 'var(--success)' : 'var(--danger)', color: msg.type === 'success' ? 'var(--success)' : 'var(--danger)' }}>
          {msg.text}
        </div>
      )}

      {(creating || editing) && (
        <div className="card mb-4" style={{ borderColor: 'var(--accent)' }}>
          <div className="card-header">{creating ? '新建记忆' : `编辑：${editing}`}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="名称 slug（如 user-prefers-ts）"
                disabled={!creating}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '.82em', flex: '1 1 240px' }}
              />
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as MemoryType }))} style={{ flex: '0 0 140px' }}>
                {(['user', 'feedback', 'project', 'reference'] as MemoryType[]).map(t => (
                  <option key={t} value={t}>{TYPE_LABELS[t].label}</option>
                ))}
              </select>
            </div>
            <input
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="一句话摘要（召回时用于判断相关性）"
              style={{ fontSize: '.85em' }}
            />
            <textarea
              value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              placeholder="记忆正文；feedback/project 建议附 为什么 / 如何应用"
              rows={5}
              style={{ fontSize: '.85em', fontFamily: 'var(--font-mono)' }}
            />
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" onClick={() => { void save(); }} disabled={busy}>保存</button>
              <button className="btn btn-sm" onClick={() => { setEditing(null); setCreating(false); setForm(EMPTY_FORM); }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40 }}>加载中...</div>
      ) : items.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40 }}>
          还没有记忆。Agent 在对话里遇到值得长期记住的事会自动写入，你也可以点“新建记忆”手动添加。
        </div>
      ) : (
        <div className="grid-2">
          {items.map(item => {
            const t = TYPE_LABELS[item.type];
            const isOpen = expanded.has(item.name);
            return (
              <div key={item.name} className="tool-card">
                <div className="flex-between" style={{ alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="tool-card-name" style={{ fontFamily: 'var(--font-mono)' }}>{item.name}</div>
                    <div className="tool-card-desc">{item.description || <span style={{ color: 'var(--ink-muted)' }}>（无摘要）</span>}</div>
                    <div className="mt-2 flex gap-2" style={{ flexWrap: 'wrap' }}>
                      <span className="badge" style={{ background: t.color + '20', color: t.color }}>{t.label}</span>
                      <span className="badge badge-muted">{shortDate(item.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2" style={{ flexDirection: 'column', alignItems: 'stretch', flex: '0 0 auto' }}>
                    <button className="btn btn-sm" onClick={() => { void toggleExpand(item.name); }}>{isOpen ? '收起' : '查看'}</button>
                    <button className="btn btn-sm" onClick={() => { void startEdit(item); }}>编辑</button>
                    <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={() => { void remove(item.name); }} disabled={busy}>删除</button>
                  </div>
                </div>
                {isOpen && (
                  <pre style={{ marginTop: 10, padding: 10, background: 'var(--bg-hover)', borderRadius: 6, fontSize: '.78em', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}>
                    {bodies[item.name] ?? '加载中...'}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
