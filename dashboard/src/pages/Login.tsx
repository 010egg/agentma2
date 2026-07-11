import type { FormEvent } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AgentMaMark from '../components/AgentMaMark';
import CosmicBackground from '../components/CosmicBackground';
import { useTilt } from '../hooks/useTilt';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const { login, register } = useAuth();

  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const cardRef = useTilt<HTMLDivElement>(10);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = isRegister ? await register(name, email, password) : await login(email, password);
    setLoading(false);
    if (result.ok) navigate('/');
    else setError(result.error || '操作失败');
  };

  return (
    <div className="login-page cosmic-route">
      <CosmicBackground variant="login" fill="fixed" hero />
      <div className="login-shell">
        <div className="login-brand">
          <AgentMaMark className="login-mark" />
          <div>
            <div className="login-word">agentma</div>
            <div className="login-tag">agent management console</div>
          </div>
        </div>

        <div className="login-card" ref={cardRef}>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {isRegister && (
                <div className="form-group">
                  <label>姓名</label>
                  <input value={name} onChange={e => setName(e.target.value)}
                    placeholder="你的名字" />
                </div>
              )}
              <div className="form-group">
                <label>邮箱</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="name@company.com" title="支持常见公共邮箱和企业邮箱" required />
              </div>
              <div className="form-group">
                <label>密码</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="至少 6 位" required minLength={6} />
              </div>
            </div>

            {error && (
              <div className="login-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary login-submit"
            >
              {loading ? '...' : isRegister ? '创建账号' : '登 录'}
            </button>
          </form>

          <div className="login-switch">
            {isRegister ? '已有账号？' : '没有账号？'}
            <button type="button" onClick={() => { setIsRegister(!isRegister); setError(''); }}>
              {isRegister ? '去登录' : '去注册'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
