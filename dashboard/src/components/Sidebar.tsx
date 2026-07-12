import { NavLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import AgentMaMark from './AgentMaMark';
import LineIcon from './LineIcon';
import type { LineIconName } from './LineIcon';

const SECTIONS = [
  {
    title: '核心',
    items: [
      { path: '/conversations', label: '会话', icon: 'chat' },
      { path: '/agents', label: 'Agent', icon: 'agents' },
      { path: '/knowledge', label: '知识库', icon: 'book' },
      { path: '/skills', label: '技能', icon: 'spark' },
      { path: '/tools', label: '工具', icon: 'tools' },
      { path: '/memories', label: '记忆', icon: 'pin' },
      { path: '/visuals', label: '可视化', icon: 'chart' },
      { path: '/', label: '总览', icon: 'overview' },
    ],
  },
  {
    title: '运维',
    adminOnly: true,
    items: [
      { path: '/account', label: '账户管理', icon: 'user' },
      { path: '/playground', label: 'Playground', icon: 'play' },
      { path: '/settings', label: '全局设置', icon: 'gear' },
      { path: '/hooks', label: 'Hook 系统', icon: 'hook' },
      { path: '/subagents', label: '子代理管理', icon: 'agents' },
      { path: '/permissions', label: '权限系统', icon: 'shield' },
      { path: '/observability', label: '可观测性', icon: 'chart' },
      { path: '/evaluations', label: '评估系统', icon: 'layers', reviewerVisible: true },
      { path: '/crawler', label: '操作后台', icon: 'tools' },
    ],
  },
] satisfies Array<{ title: string; adminOnly?: boolean; items: Array<{ path: string; label: string; icon: LineIconName; reviewerVisible?: boolean }> }>;

type SidebarProps = {
  collapsed?: boolean;
  onNavigate?: () => void;
  onToggleCollapsed?: () => void;
};

function userInitial(label?: string) {
  const raw = (label || 'A').trim();
  return raw.slice(0, 1).toUpperCase();
}

export default function Sidebar({ collapsed = false, onNavigate, onToggleCollapsed }: SidebarProps) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'tenant_admin';
  return (
    <nav className="sidebar-body">
      <div className="sidebar-logo-row">
        <div className="sidebar-logo" title="AgentMa">
          <AgentMaMark className="sidebar-logo-mark" />
          <span className="sidebar-logo-lockup">
            <span className="sidebar-logo-text">agentma</span>
            <span className="sidebar-logo-tag">agent management</span>
          </span>
        </div>
        <button
          type="button"
          className="icon-btn sidebar-collapse-btn"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
          title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
        >
          <LineIcon name={collapsed ? 'chevronRight' : 'chevronLeft'} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {SECTIONS.filter(section => !section.adminOnly || isAdmin || section.items.some(item => 'reviewerVisible' in item && item.reviewerVisible)).map(section => (
          <div className="sidebar-section" key={section.title}>
            <div className="sidebar-section-title">{section.title}</div>
            {section.items.filter(item => !section.adminOnly || isAdmin || ('reviewerVisible' in item && item.reviewerVisible)).map(item => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              >
                <span className="sidebar-link-icon">
                  <LineIcon name={item.icon} />
                </span>
                <span className="sidebar-link-label">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <span className="sidebar-user-chip">{userInitial(user?.username || user?.name || user?.email)}</span>
        <span className="sidebar-user-meta">
          <span className="sidebar-user-name">{user?.username || user?.name || 'AgentMa'}</span>
          {user && <span className="sidebar-user-mail" title={user.email}>{user.email}</span>}
        </span>
        <button className="icon-btn sidebar-logout-btn" onClick={logout} title="登出" aria-label="登出">
          <LineIcon name="logout" />
        </button>
      </div>
    </nav>
  );
}
