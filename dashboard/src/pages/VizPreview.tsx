import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import VisualFrame from '../components/artifacts/VisualFrame';
import MarkdownMindMap, { type MarkdownVisualMode } from '../components/artifacts/MarkdownMindMap';
import LineIcon from '../components/LineIcon';
import { getAuthHeaders } from '../utils/client-runtime';
import { isLikelyMarkdownMindMap } from '../utils/markdown-mindmap';

type VisualPayload = {
  id?: string;
  title?: string;
  html: string;
  format?: 'html' | 'markdown';
  sourceSlug?: string;
  createdAt?: number;
  mtimeMs?: number;
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

function formatTime(value?: number) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function looksLikeMarkdownPath(value: string) {
  return /\.(md|markdown)$/i.test(value.trim());
}

function inferVisualFormat(visual: VisualPayload | null, relPath: string): 'html' | 'markdown' {
  if (visual?.format === 'markdown') return 'markdown';
  if (visual?.format === 'html') return 'html';
  if (looksLikeMarkdownPath(visual?.sourceSlug || relPath)) return 'markdown';
  const source = visual?.html || '';
  if (!/^\s*(<!doctype|<html|<script|<style|<svg|<canvas|<div|<section)\b/i.test(source) && isLikelyMarkdownMindMap(source)) {
    return 'markdown';
  }
  return 'html';
}

export default function VizPreview() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const previewShellRef = useRef<HTMLDivElement | null>(null);
  const id = searchParams.get('id')?.trim() || '';
  const cid = searchParams.get('cid')?.trim() || '';
  const relPath = searchParams.get('path')?.trim() || '';
  const isSaved = Boolean(id);
  const visualKey = `${id}\n${cid}\n${relPath}`;
  const [visual, setVisual] = useState<VisualPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [fullscreenError, setFullscreenError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [markdownModeState, setMarkdownModeState] = useState<{ key: string; mode: MarkdownVisualMode }>({ key: '', mode: 'mindmap' });
  const markdownMode = markdownModeState.key === visualKey ? markdownModeState.mode : 'mindmap';
  const setMarkdownMode = (mode: MarkdownVisualMode) => setMarkdownModeState({ key: visualKey, mode });

  const sourceLabel = useMemo(() => {
    if (isSaved) return '已保存';
    return relPath || '临时文件';
  }, [isSaved, relPath]);
  const visualFormat = useMemo(() => inferVisualFormat(visual, relPath), [visual, relPath]);
  const isMarkdownVisual = visualFormat === 'markdown';

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      setSaveError('');
      try {
        if (!id && (!cid || !relPath)) throw new Error('缺少可视化参数');
        const url = id
          ? `/api/visuals/${encodeURIComponent(id)}`
          : `/api/visuals/file?cid=${encodeURIComponent(cid)}&path=${encodeURIComponent(relPath)}`;
        const response = await fetch(url, { headers: getAuthHeaders() });
        const data = await readJson<VisualPayload>(response);
        if (!cancelled) setVisual(data);
      } catch (loadError) {
        if (!cancelled) {
          setVisual(null);
          setError((loadError as Error).message || '可视化读取失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [id, cid, relPath]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === previewShellRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const saveVisual = async () => {
    if (!cid || !relPath || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const response = await fetch('/api/visuals', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cid, path: relPath, title: visual?.title }),
      });
      const data = await readJson<{ id: string }>(response);
      navigate(`/viz?id=${encodeURIComponent(data.id)}`, { replace: true });
    } catch (saveFailure) {
      setSaveError((saveFailure as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleFullscreen = async () => {
    const previewShell = previewShellRef.current;
    if (!previewShell) return;
    setFullscreenError('');
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      await previewShell.requestFullscreen();
    } catch (fullscreenFailure) {
      setFullscreenError((fullscreenFailure as Error).message || '浏览器未允许进入全屏');
    }
  };

  if (loading) {
    return (
      <div className="visual-page">
        <div className="page-header">
          <h1>可视化预览</h1>
          <p>正在载入可视化产物</p>
        </div>
        <div className="card">加载中…</div>
      </div>
    );
  }

  if (error || !visual?.html) {
    return (
      <div className="visual-page visual-expired">
        <div className="card">
          <span className="badge badge-warning">临时链接</span>
          <h1>此临时可视化已失效</h1>
          <p>沙箱已清理、重启或会话删除导致。代码与技能都在，回对话重跑即可。</p>
          {error && <pre className="visual-error-detail">{error}</pre>}
          <Link className="btn btn-primary" to="/conversations">返回会话</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="visual-page" ref={previewShellRef}>
      <div className="visual-banner">
        <div className="visual-title-block">
          <span className={`badge ${isSaved ? 'badge-success' : 'badge-warning'}`}>{isSaved ? '已保存' : '临时'}</span>
          <div>
            <h1>{visual.title || '未命名可视化'}</h1>
            <p>{sourceLabel}{visual.createdAt || visual.mtimeMs ? ` · ${formatTime(visual.createdAt || visual.mtimeMs)}` : ''}</p>
          </div>
        </div>
        <div className="visual-actions">
          {isMarkdownVisual && (
            <div className="visual-mode-toggle" role="tablist" aria-label="Markdown 预览模式">
              <button
                className={markdownMode === 'mindmap' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={markdownMode === 'mindmap'}
                onClick={() => setMarkdownMode('mindmap')}
              >
                <LineIcon name="chart" />
                思维导图
              </button>
              <button
                className={markdownMode === 'markdown' ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={markdownMode === 'markdown'}
                onClick={() => setMarkdownMode('markdown')}
              >
                <LineIcon name="book" />
                MD
              </button>
            </div>
          )}
          <button
            className="btn btn-sm visual-fullscreen-btn"
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
            title={isFullscreen ? '退出全屏' : '进入全屏'}
          >
            <LineIcon name={isFullscreen ? 'collapse' : 'expand'} />
            {isFullscreen ? '退出全屏' : '全屏'}
          </button>
          <Link className="btn btn-sm" to="/visuals">我的可视化</Link>
          {!isSaved && (
            <button className="btn btn-sm btn-primary" type="button" onClick={saveVisual} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          )}
        </div>
      </div>
      {saveError && <div className="visual-inline-error">{saveError}</div>}
      {fullscreenError && <div className="visual-inline-error">{fullscreenError}</div>}
      <div className={`visual-frame-host${isMarkdownVisual ? ' visual-markdown-host' : ''}`}>
        {isMarkdownVisual ? (
          <MarkdownMindMap markdown={visual.html} title={visual.title} mode={markdownMode} />
        ) : (
          <VisualFrame html={visual.html} />
        )}
      </div>
    </div>
  );
}
