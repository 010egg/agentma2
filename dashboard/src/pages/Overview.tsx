import { useState, useEffect } from 'react';
import { BUILT_IN_TOOLS } from '../simulator/mock-data';
import { useAuth } from '../contexts/AuthContext';
import CosmicBackground from '../components/CosmicBackground';
import CapabilityUniverse from '../components/CapabilityUniverse';
import type { LineIconName } from '../components/LineIcon';

const SECTIONS = [
  { path: '/conversations', title: '会话', desc: '多轮对话，Agent 按模板配置执行任务', icon: 'chat', color: '#7c3aed' },
  { path: '/agents', title: 'Agent', desc: '创建和管理 Agent 模板，配置工具和能力', icon: 'agents', color: '#f59e0b' },
  { path: '/knowledge', title: '知识库', desc: '上传、管理和绑定 Agent 可检索的知识源', icon: 'book', color: '#2563eb' },
  { path: '/skills', title: '技能', desc: '管理 Agent Skills，扩展专业能力', icon: 'spark', color: '#8b5cf6' },
  { path: '/tools', title: '工具', desc: `${BUILT_IN_TOOLS.length} 个内置工具与租户远程 MCP`, icon: 'tools', color: '#d97706' },
  { path: '/memories', title: '记忆', desc: '管理 Agent 长期记忆与按需召回', icon: 'pin', color: '#059669' },
  { path: '/visuals', title: '可视化', desc: '创建和管理对话生成的可视化内容', icon: 'chart', color: '#10b981' },
] satisfies Array<{ path: string; title: string; desc: string; icon: LineIconName; color: string }>;

export default function Overview() {
  const { token } = useAuth();
  const [weeklyRuns, setWeeklyRuns] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetch('/api/quota/usage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (!cancelled) setWeeklyRuns(data?.usage?.weeklyRunCount?.used ?? data?.usage?.totalRuns ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="cosmic-route cosmic-overview">
      <CosmicBackground variant="overview" fill="absolute" />
      <div className="cosmic-content">
        <div className="overview-run-metric" aria-label={`本周运行 ${weeklyRuns ?? '暂无数据'} 次 Agent 执行`}>
          <span>本周运行</span>
          <strong>{weeklyRuns ?? '—'}</strong>
          <span>次 Agent 执行</span>
        </div>
        <CapabilityUniverse sections={SECTIONS} />
      </div>
    </div>
  );
}
