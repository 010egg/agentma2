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
      { path: '/agents', label: 'Agent 市场', icon: 'market' },
      { path: '/knowledge', label: '知识库', icon: 'book' },
      { path: '/visuals', label: '我的可视化', icon: 'chart' },
      { path: '/skills', label: '技能背包', icon: 'spark' },
      { path: '/account', label: '账户管理', icon: 'user' },
    ],
  },
  {
    title: '运维',
    items: [
      { path: '/', label: '总览', icon: 'overview' },
      { path: '/playground', label: 'Playground', icon: 'play' },
      { path: '/settings', label: '全局设置', icon: 'gear' },
      { path: '/tools', label: '工具背包', icon: 'tools' },
      { path: '/hooks', label: 'Hook 系统', icon: 'hook' },
      { path: '/subagents', label: '子代理管理', icon: 'agents' },
      { path: '/permissions', label: '权限系统', icon: 'shield' },
      { path: '/observability', label: '可观测性', icon: 'chart' },
      { path: '/crawler', label: '操作后台', icon: 'tools' },
    ],
  },
] satisfies Array<{ title: string; items: Array<{ path: string; label: string; icon: LineIconName }> }>;

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
        {SECTIONS.map(section => (
          <div className="sidebar-section" key={section.title}>
            <div className="sidebar-section-title">{section.title}</div>
            {section.items.map(item => (
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
