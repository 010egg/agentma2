import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import LineIcon from './LineIcon';
import Sidebar from './Sidebar';

const PAGE_META = [
  { match: (path: string) => path === '/', title: '总览', eyebrow: 'overview', lede: 'SDK 状态、配额、模板和运行入口。' },
  { match: (path: string) => path.startsWith('/conversations'), title: '会话', eyebrow: 'conversation', lede: '多 Agent 对话、历史、分叉、权限和工具调用。' },
  { match: (path: string) => path === '/agents', title: 'Agent 市场', eyebrow: 'agents', lede: '创建、配置和组合可复用 Agent。' },
  { match: (path: string) => path.startsWith('/agents/') && path.endsWith('/chat'), title: 'Agent Chat', eyebrow: 'agent runtime', lede: '直接和选定 Agent 运行一次真实会话。' },
  { match: (path: string) => path === '/playground', title: 'Playground', eyebrow: 'sdk query', lede: '调试 query 请求、工具、权限和模型参数。' },
  { match: (path: string) => path === '/account', title: '账户管理', eyebrow: 'tenant', lede: '租户、供应商、用户、团队、API key、配额和审计。' },
  { match: (path: string) => path === '/settings', title: '全局设置', eyebrow: 'settings', lede: '会话、限制和工具默认配置。' },
  { match: (path: string) => path === '/tools', title: '工具背包', eyebrow: 'tools', lede: '维护本地工具、远程端点和标签。' },
  { match: (path: string) => path === '/knowledge', title: '知识库', eyebrow: 'knowledge', lede: '上传、管理、测试和绑定知识源。' },
  { match: (path: string) => path === '/skills', title: '技能背包', eyebrow: 'skills', lede: '从 GitHub 导入，或从 workspace 抽取到用户背包。' },
  { match: (path: string) => path === '/hooks', title: 'Hook 系统', eyebrow: 'hooks', lede: '管理真实 Hook 规则和运行时决策日志。' },
  { match: (path: string) => path === '/subagents', title: '子代理管理', eyebrow: 'subagents', lede: '维护 AgentDefinition 和运行配置。' },
  { match: (path: string) => path === '/permissions', title: '权限系统', eyebrow: 'permissions', lede: '配置 canUseTool 规则、模式和决策检查。' },
  { match: (path: string) => path === '/observability', title: '可观测性', eyebrow: 'observability', lede: '查看事件结构、运行记录和环境变量。' },
];

function getPageMeta(pathname: string) {
  return PAGE_META.find((item) => item.match(pathname)) || {
    title: 'AgentMa',
    eyebrow: 'console',
    lede: 'Agent management console',
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isVizPreview = location.pathname === '/viz';
  const isOverview = location.pathname === '/';
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('agentma_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('agentma_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };
  const pageMeta = getPageMeta(location.pathname);

  return (
    <div className={`app-layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <button
        type="button"
        className="mobile-menu-btn icon-btn"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label={sidebarOpen ? '关闭导航' : '打开导航'}
        title={sidebarOpen ? '关闭导航' : '打开导航'}
      >
        <LineIcon name={sidebarOpen ? 'x' : 'menu'} />
      </button>
      <div className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />
      <div className={`sidebar${sidebarOpen ? ' open' : ''}${sidebarCollapsed ? ' collapsed' : ''}`}>
        <Sidebar
          collapsed={sidebarCollapsed}
          onNavigate={() => setSidebarOpen(false)}
          onToggleCollapsed={toggleSidebarCollapsed}
        />
      </div>
      <main className={`main-content${isVizPreview ? ' visual-preview-main' : ''}${isOverview ? ' cosmic' : ''}`}>
        <header className="console-topbar">
          <div className="titleblock">
            <div className="eyebrow">
              agentma console
              <span className="crumb-sep">/</span>
              <span>{pageMeta.eyebrow}</span>
            </div>
            <h1>{pageMeta.title}</h1>
            <p className="lede">{pageMeta.lede}</p>
          </div>
          <div className="topbar-actions">
            <span className="topbar-status">
              <LineIcon name="bolt" />
              live api
            </span>
          </div>
        </header>
        <section className="content-surface">{children}</section>
      </main>
    </div>
  );
}
