import { useMemo, useState, useEffect } from 'react';
import { BUILT_IN_TOOLS, HOOK_EVENTS } from '../simulator/mock-data';
import { useAuth } from '../contexts/AuthContext';
import CosmicBackground from '../components/CosmicBackground';
import CapabilityUniverse from '../components/CapabilityUniverse';
import type { LineIconName } from '../components/LineIcon';

const SECTIONS = [
  { path: '/conversations', title: '会话', desc: '多轮对话，Agent 按模板配置执行任务', icon: 'chat', color: '#7c3aed' },
  { path: '/agents', title: 'Agent 市场', desc: '创建和管理 Agent 模板，配置工具和能力', icon: 'market', color: '#f59e0b' },
  { path: '/playground', title: 'Playground', desc: '实时测试 query() 流式 API', icon: 'play', color: '#2563eb', adminOnly: true },
  { path: '/tools', title: '工具 & MCP', desc: `${BUILT_IN_TOOLS.length} 内置 + 自定义 MCP 工具`, icon: 'tools', color: '#d97706', adminOnly: true },
  { path: '/skills', title: '技能背包', desc: '管理 Agent Skills，扩展专业能力', icon: 'spark', color: '#8b5cf6' },
  { path: '/hooks', title: 'Hook 系统', desc: `${HOOK_EVENTS.length} 种事件监听`, icon: 'hook', color: '#059669', adminOnly: true },
  { path: '/subagents', title: '子代理管理', desc: 'AgentDefinition / Task CRUD', icon: 'agents', color: '#8b5cf6', adminOnly: true },
  { path: '/permissions', title: '权限系统', desc: 'setPermissionMode / canUseTool', icon: 'shield', color: '#2563eb', adminOnly: true },
  { path: '/observability', title: '可观测性', desc: 'OTEL 遥测 / RateLimit / StreamEvent', icon: 'chart', color: '#10b981', adminOnly: true },
  { path: '/settings', title: '全局设置', desc: 'SdkOptions 完整配置面板', icon: 'gear', color: '#6b7280', adminOnly: true },
] satisfies Array<{ path: string; title: string; desc: string; icon: LineIconName; color: string; adminOnly?: boolean }>;

export default function Overview() {
  const { token, user } = useAuth();
  const [weeklyRuns, setWeeklyRuns] = useState<number | null>(null);
  const isAdmin = user?.role === 'tenant_admin';
  const sections = useMemo(() => SECTIONS.map(section => ({
    ...section,
    disabled: Boolean(section.adminOnly && !isAdmin),
    disabledReason: section.adminOnly && !isAdmin ? '需要管理员权限' : undefined,
  })), [isAdmin]);

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
        <CapabilityUniverse sections={sections} />
      </div>
    </div>
  );
}
