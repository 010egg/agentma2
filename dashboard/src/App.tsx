import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import AuthGuard from './components/AuthGuard';
import Layout from './components/Layout';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Playground from './pages/Playground';
import Agents from './pages/Agents';
import AgentChat from './pages/AgentChat';
import Conversations from './pages/Conversations';
import Sessions from './pages/Sessions';
import Tools from './pages/Tools';
import Knowledge from './pages/Knowledge';
import Hooks from './pages/Hooks';
import Skills from './pages/Skills';
import VizPreview from './pages/VizPreview';
import Visuals from './pages/Visuals';
import Subagents from './pages/Subagents';
import Permissions from './pages/Permissions';
import Observability from './pages/Observability';
import CrawlerOps from './pages/CrawlerOps';
import Settings from './pages/Settings';
import Account from './pages/Account';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={
          <AuthGuard>
            <Layout>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/playground" element={<Playground />} />
                <Route path="/agents" element={<Agents />} />
                <Route path="/agents/:id/chat" element={<AgentChat />} />
                <Route path="/conversations" element={<Conversations />} />
                <Route path="/sessions" element={<Sessions />} />
                <Route path="/tools" element={<Tools />} />
                <Route path="/knowledge" element={<Knowledge />} />
                <Route path="/viz" element={<VizPreview />} />
                <Route path="/visuals" element={<Visuals />} />
                <Route path="/skills" element={<Skills />} />
                <Route path="/hooks" element={<Hooks />} />
                <Route path="/subagents" element={<Subagents />} />
                <Route path="/permissions" element={<Permissions />} />
                <Route path="/observability" element={<Observability />} />
                <Route path="/crawler" element={<CrawlerOps />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/account" element={<Account />} />
              </Routes>
            </Layout>
          </AuthGuard>
        } />
      </Routes>
    </AuthProvider>
  );
}
