import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAuthHeaders } from '../utils/client-runtime';

type VisualListItem = {
  id: string;
  title?: string;
  createdAt: number;
  sizeBytes: number;
};

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : null;
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
      ? String((data as Record<string, unknown>).error || '请求失败')
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number) {
  return value ? new Date(value).toLocaleString() : '未知';
}

export default function Visuals() {
  const [items, setItems] = useState<VisualListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState('');

  const loadVisuals = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/visuals', { headers: getAuthHeaders() });
      const data = await readJson<VisualListItem[]>(response);
      setItems(Array.isArray(data) ? data : []);
    } catch (loadError) {
      setError((loadError as Error).message || '读取可视化失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVisuals();
  }, [loadVisuals]);

  const deleteVisual = async (visual: VisualListItem) => {
    if (!window.confirm(`删除「${visual.title || '未命名'}」？`)) return;
    setDeletingId(visual.id);
    setError('');
    try {
      const response = await fetch(`/api/visuals/${encodeURIComponent(visual.id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      await readJson<{ ok: boolean }>(response);
      await loadVisuals();
    } catch (deleteError) {
      setError((deleteError as Error).message || '删除失败');
    } finally {
      setDeletingId('');
    }
  };

  return (
    <div className="visuals-page">
      <div className="page-header">
        <h1>我的可视化</h1>
        <p>保存后的可视化产物会保留在这里，临时预览需要先在预览页保存。</p>
      </div>

      {error && <div className="visual-inline-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card">
        <div className="flex-between mb-4">
          <div className="card-header" style={{ marginBottom: 0 }}>
            可视化列表 {items.length > 0 && <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}>({items.length})</span>}
          </div>
          <button className="btn btn-sm" type="button" onClick={loadVisuals} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>

        {items.length === 0 && !loading ? (
          <div className="visuals-empty">
            <strong>暂无已保存可视化</strong>
            <p>在会话中打开临时预览后，点击预览页右上角的“保存”即可归档到这里。</p>
            <Link className="btn btn-primary" to="/conversations">去会话</Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>创建时间</th>
                  <th>大小</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="visuals-title-cell">
                        <strong>{item.title || '未命名'}</strong>
                        <span>{item.id}</span>
                      </div>
                    </td>
                    <td>{formatTime(item.createdAt)}</td>
                    <td>{formatBytes(item.sizeBytes)}</td>
                    <td>
                      <div className="visual-row-actions">
                        <Link className="btn btn-sm btn-primary" to={`/viz?id=${encodeURIComponent(item.id)}`}>打开</Link>
                        <button
                          className="btn btn-sm btn-danger"
                          type="button"
                          onClick={() => void deleteVisual(item)}
                          disabled={deletingId === item.id}
                        >
                          {deletingId === item.id ? '删除中…' : '删除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {loading && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--ink-muted)', textAlign: 'center', padding: '20px 0' }}>加载中…</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
