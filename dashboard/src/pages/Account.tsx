import { useState, useEffect, useRef } from 'react';
import { getAuthHeaders } from '../utils/client-runtime';
import type { ProviderProfile } from '../simulator/types';
import { createProviderProfile, fetchProviderModels, listProviderModels, loadProviderProfiles, mergeProviderProfiles, saveProviderProfiles, splitAvailableModels } from '../utils/providers';
import { normalizeRunOutcome, outcomeBadgeClass, outcomeLabel } from '../simulator/run-state';
import { useAuth } from '../contexts/AuthContext';

const jsonAuthHeaders = () => getAuthHeaders({ 'Content-Type': 'application/json' });

type QuotaUsageRun = {
  id: string;
  actor: string;
  model: string;
  status: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
};

type QuotaUsageSummary = {
  quota: Record<string, number | string>;
  usage: {
    monthlyActiveSeconds: { used: number; limit: number; percent: number };
    weeklyRunCount: { used: number; limit: number; percent: number };
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    lastRunAt: number | null;
  };
  recentRuns: QuotaUsageRun[];
};

function formatNumber(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function formatBytes(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function bytesToMb(value: unknown) {
  const bytes = Number(value || 0);
  return Number.isFinite(bytes) ? Math.round((bytes / 1024 / 1024) * 100) / 100 : 0;
}

function mbToBytes(value: unknown) {
  const mb = Number(value || 0);
  return Number.isFinite(mb) ? Math.round(mb * 1024 * 1024) : 0;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatSeconds(seconds: number) {
  return formatDuration(seconds * 1000);
}

function formatCurrency(value: number) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function usageColor(percent: number) {
  if (percent >= 90) return 'var(--danger)';
  if (percent >= 70) return 'var(--warning)';
  return 'var(--success)';
}

export default function Account() {
  const [tab, setTab] = useState<'info' | 'providers' | 'apikeys' | 'teams' | 'users' | 'quota' | 'audit'>('info');

  return (
    <div>
      <div className="page-header">
        <h1>⚙ 账户管理</h1>
        <p>租户信息 · 供应商 · 用户管理 · API 密钥 · 团队 · 配额 · 审计日志</p>
      </div>

      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        {[
          ['info', '租户信息'], ['providers', '供应商'], ['users', '用户管理'], ['apikeys', 'API 密钥'],
          ['teams', '团队'], ['quota', '配额管理'], ['audit', '审计日志'],
        ].map(([k, v]) => (
          <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k as any)}>{v}</button>
        ))}
      </div>

      {tab === 'info' && <TenantInfo />}
      {tab === 'providers' && <ProviderManager />}
      {tab === 'users' && <UserManager />}
      {tab === 'apikeys' && <ApiKeyManager />}
      {tab === 'teams' && <TeamManager />}
      {tab === 'quota' && <QuotaManager />}
      {tab === 'audit' && <AuditLogs />}
    </div>
  );
}

function ProviderManager() {
  const [providers, setProviders] = useState<ProviderProfile[]>(loadProviderProfiles);
  const [draftProvider, setDraftProvider] = useState<ProviderProfile | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeProvider = draftProvider;

  const persist = (next: ProviderProfile[]) => {
    const savedProviders = saveProviderProfiles(next);
    setProviders(savedProviders);
    void fetch('/api/providers', {
      method: 'PUT',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(savedProviders),
    })
      .then(async response => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      })
      .then(serverProviders => {
        if (Array.isArray(serverProviders)) {
          setProviders(saveProviderProfiles(mergeProviderProfiles(savedProviders, serverProviders)));
        }
      })
      .catch(error => {
        console.error('failed to sync provider profiles', error);
      });
    setSaved(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSaved(false), 1400);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/providers', { headers: getAuthHeaders() });
        if (!response.ok) return;
        const serverProviders = await response.json();
        if (!Array.isArray(serverProviders)) return;
        const localProviders = loadProviderProfiles();
        if (serverProviders.length) {
          const normalized = saveProviderProfiles(mergeProviderProfiles(localProviders, serverProviders));
          if (!cancelled) setProviders(normalized);
          void fetch('/api/providers', {
            method: 'PUT',
            headers: jsonAuthHeaders(),
            body: JSON.stringify(normalized),
          }).catch(error => {
            console.error('failed to sync merged provider profiles', error);
          });
          return;
        }

        if (!localProviders.length) return;
        const saveResponse = await fetch('/api/providers', {
          method: 'PUT',
          headers: jsonAuthHeaders(),
          body: JSON.stringify(localProviders),
        });
        if (!saveResponse.ok) return;
        const savedProviders = await saveResponse.json();
        if (!cancelled && Array.isArray(savedProviders)) setProviders(saveProviderProfiles(savedProviders));
      } catch (error) {
        console.error('failed to load provider profiles', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const updateDraftProvider = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => {
    setDraftProvider(provider => (
      provider ? { ...provider, [key]: value, updatedAt: Date.now() } : provider
    ));
  };

  const addProvider = () => {
    setDraftProvider(createProviderProfile({
      id: `provider-${Date.now()}`,
      name: `供应商 ${providers.length + 1}`,
      availableModels: [],
      enabled: true,
    }));
  };

  const removeProvider = (id: string) => {
    if (providers.length <= 1) return;
    persist(providers.filter(provider => provider.id !== id));
    if (draftProvider?.id === id) setDraftProvider(null);
  };

  const saveDraftProvider = () => {
    if (!draftProvider) return;
    const exists = providers.some(provider => provider.id === draftProvider.id);
    let next = exists
      ? providers.map(provider => provider.id === draftProvider.id ? draftProvider : provider)
      : [...providers, draftProvider];
    if (draftProvider.isDefault) {
      next = next.map(provider => ({ ...provider, isDefault: provider.id === draftProvider.id }));
    }
    persist(next);
    setDraftProvider(null);
  };

  return (
    <div>
      <div className="spread mb-4" style={{ alignItems: 'center' }}>
        <div>
          <div className="section-title" style={{ marginBottom: 4 }}>模型供应商</div>
          <p style={{ color: 'var(--ink-secondary)', margin: 0 }}>
            在这里维护每个供应商的 API 凭据和可用模型，Agent 模板只能从这些模型里选择。
          </p>
        </div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          {saved && <span className="badge badge-success">已保存</span>}
          <button className="btn btn-primary" onClick={addProvider}>添加供应商</button>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {providers.map((provider) => (
          <button
            type="button"
            className="card"
            key={provider.id}
            onClick={() => setDraftProvider({ ...provider })}
            style={{
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              font: 'inherit',
              color: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              opacity: provider.enabled ? 1 : .62,
            }}
          >
            <span style={{ fontWeight: 700 }}>{provider.name}</span>
            <span style={{ color: 'var(--ink-muted)', fontSize: '.82em' }}>配置</span>
          </button>
        ))}
      </div>

      {activeProvider && (
        <div
          onClick={() => setDraftProvider(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            background: 'rgba(0, 0, 0, .28)',
            display: 'grid',
            placeItems: 'center',
            padding: 20,
          }}
        >
          <div
            className="card"
            onClick={event => event.stopPropagation()}
            style={{
              position: 'relative',
              width: 'min(920px, 100%)',
              maxHeight: 'min(760px, calc(100vh - 40px))',
              overflow: 'auto',
              boxShadow: '0 24px 80px rgba(0, 0, 0, .28)',
            }}
          >
            <div className="mb-4" style={{ paddingRight: 430 }}>
              <div className="flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={activeProvider.name}
                  onChange={e => updateDraftProvider('name', e.target.value)}
                  style={{ maxWidth: 260, fontWeight: 700 }}
                />
                <span className="badge badge-muted">可用模型 {activeProvider.availableModels.length}</span>
                {activeProvider.isDefault && <span className="badge badge-success">默认</span>}
                {!activeProvider.enabled && <span className="badge badge-warning">停用</span>}
              </div>
            </div>

            <div className="flex gap-2" style={{ position: 'absolute', top: 18, right: 18, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => updateDraftProvider('enabled', !activeProvider.enabled)}>
                {activeProvider.enabled ? '停用' : '启用'}
              </button>
              <button className="btn btn-sm" onClick={() => updateDraftProvider('isDefault', true)} disabled={activeProvider.isDefault}>设为默认</button>
              <button className="btn btn-sm btn-danger" onClick={() => removeProvider(activeProvider.id)} disabled={providers.length <= 1}>删除</button>
              <button className="btn btn-sm btn-primary" onClick={saveDraftProvider}>保存</button>
              <button className="btn btn-sm" onClick={() => { setShowToken(false); setDraftProvider(null); }}>关闭</button>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label>ANTHROPIC_BASE_URL</label>
                <input
                  value={activeProvider.ANTHROPIC_BASE_URL}
                  onChange={e => updateDraftProvider('ANTHROPIC_BASE_URL', e.target.value)}
                  placeholder="https://api.example.com/anthropic"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '.78em' }}
                />
              </div>
              <div className="form-group">
                <label>ANTHROPIC_AUTH_TOKEN</label>
                <div className="flex gap-2" style={{ alignItems: 'center' }}>
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={activeProvider.ANTHROPIC_AUTH_TOKEN}
                    onChange={e => updateDraftProvider('ANTHROPIC_AUTH_TOKEN', e.target.value)}
                    placeholder="sk-..."
                    style={{ fontFamily: 'var(--font-mono)', flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowToken(v => !v)}
                    title={showToken ? '隐藏' : '显示'}
                  >
                    {showToken ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>可用模型</label>
                <textarea
                  value={activeProvider.availableModels.join('\n')}
                  onChange={e => updateDraftProvider('availableModels', splitAvailableModels(e.target.value))}
                  rows={4}
                  placeholder={'每行一个精确模型 ID\ndeepseek-v4-flash\nclaude-sonnet-4-6'}
                  style={{ fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                />
                <div style={{ color: 'var(--ink-muted)', fontSize: '.72em', marginTop: 5 }}>
                  不支持通配符；Agent 模板只能选择这里列出的精确模型。
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TenantInfo() {
  const { user, refreshUser } = useAuth();
  const [tenant, setTenant] = useState<any>(null);
  const [name, setName] = useState('');
  const [suggestionModel, setSuggestionModel] = useState(() => user?.inputSuggestionModel || '');
  const [modelOptions, setModelOptions] = useState<string[]>(() => listProviderModels());
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [preferenceSaved, setPreferenceSaved] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  useEffect(() => { fetch('/api/tenant', { headers: getAuthHeaders() }).then(r => r.json()).then(d => { setTenant(d); setName(d.name || ''); }); }, []);
  useEffect(() => { setSuggestionModel(user?.inputSuggestionModel || ''); }, [user?.inputSuggestionModel]);
  useEffect(() => {
    let cancelled = false;
    void fetchProviderModels()
      .then(models => {
        if (!cancelled && models.length) setModelOptions(models);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    await fetch('/api/tenant', { method: 'PATCH', headers: jsonAuthHeaders(), body: JSON.stringify({ name }) });
    setTenant({ ...tenant, name });
  };
  const saveSuggestionPreference = async () => {
    setPreferenceSaving(true);
    setPreferenceSaved(false);
    setPreferenceError('');
    try {
      const r = await fetch('/api/account/preferences', {
        method: 'PATCH',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ inputSuggestionModel: suggestionModel }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || '保存失败');
      const nextModel = typeof body.inputSuggestionModel === 'string'
        ? body.inputSuggestionModel
        : suggestionModel.trim();
      setSuggestionModel(nextModel);
      await refreshUser();
      setPreferenceSaved(true);
    } catch (error) {
      setPreferenceError((error as Error).message || '保存失败');
    } finally {
      setPreferenceSaving(false);
    }
  };
  if (!tenant) return null;
  const suggestionModelOptions = Array.from(new Set([
    suggestionModel.trim(),
    ...modelOptions,
  ].filter(Boolean)));
  const savedSuggestionModel = user?.inputSuggestionModel?.trim() || '';
  return (
    <div className="card">
      <div className="spread" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="card-header" style={{ marginBottom: 0 }}>租户信息</div>
        <span className={`badge ${savedSuggestionModel ? 'badge-info' : 'badge-muted'}`}>
          输入框推荐{savedSuggestionModel ? '已启用' : '未启用'}
        </span>
      </div>
      <div className="grid-2">
        <div className="form-group"><label>名称</label><input value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="form-group"><label>ID</label><input value={tenant.id} readOnly /></div>
        <div className="form-group"><label>区域</label><input value={tenant.region} readOnly /></div>
        <div className="form-group"><label>套餐</label>
          <select value={tenant.plan} onChange={e => { const p = e.target.value; fetch('/api/tenant', { method: 'PATCH', headers: jsonAuthHeaders(), body: JSON.stringify({ plan: p }) }).then(() => setTenant({ ...tenant, plan: p })); }}>
            <option value="free">Free</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div className="form-group"><label>状态</label><input value={tenant.status} readOnly /></div>
      </div>
      <button className="btn btn-primary mt-2" onClick={save}>保存</button>

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 16 }}>
        <div className="section-title" style={{ marginBottom: 10 }}>输入框推荐</div>
        <div className="grid-2" style={{ alignItems: 'end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>推荐模型</label>
            <input
              list="input-suggestion-model-options"
              value={suggestionModel}
              onChange={e => {
                setSuggestionModel(e.target.value);
                setPreferenceSaved(false);
              }}
              placeholder="留空关闭"
            />
            <datalist id="input-suggestion-model-options">
              {suggestionModelOptions.map(model => <option key={model} value={model} />)}
            </datalist>
            <div className="kpi-sub">未设置时不会启用输入框推荐</div>
          </div>
          <div className="flex gap-2" style={{ alignItems: 'center', justifyContent: 'flex-start', minHeight: 38 }}>
            <button className="btn btn-primary" onClick={saveSuggestionPreference} disabled={preferenceSaving}>
              {preferenceSaving ? '保存中' : '保存推荐模型'}
            </button>
            {preferenceSaved && <span className="badge badge-success">已保存</span>}
            {preferenceError && <span style={{ color: 'var(--danger)', fontSize: '.82em' }}>{preferenceError}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserManager() {
  const [users, setUsers] = useState<any[]>([]);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'member' });
  const [createError, setCreateError] = useState('');
  useEffect(() => { fetch('/api/users', { headers: getAuthHeaders() }).then(r => r.json()).then(setUsers); }, []);
  const create = async () => {
    setCreateError('');
    const r = await fetch('/api/users', { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify(newUser) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      setCreateError(body.error || '创建用户失败');
      return;
    }
    setUsers([...users, body]);
    setNewUser({ name: '', email: '', password: '', role: 'member' });
  };
  const changeRole = async (email: string, role: string) => {
    await fetch(`/api/users/${encodeURIComponent(email)}`, { method: 'PATCH', headers: jsonAuthHeaders(), body: JSON.stringify({ role }) });
    setUsers(users.map((u: any) => u.email === email ? { ...u, role } : u));
  };
  const remove = async (email: string) => {
    if (!confirm('确定删除用户 ' + email + '？')) return;
    await fetch(`/api/users/${encodeURIComponent(email)}`, { method: 'DELETE', headers: getAuthHeaders() });
    setUsers(users.filter((u: any) => u.email !== email));
  };
  return (
    <div className="card">
      <div className="card-header">用户管理 ({users.length})</div>
      <div className="grid-4 mb-3">
        <input
          value={newUser.name}
          onChange={e => setNewUser({ ...newUser, name: e.target.value })}
          placeholder="名称"
        />
        <input
          value={newUser.email}
          onChange={e => setNewUser({ ...newUser, email: e.target.value })}
          placeholder="邮箱"
        />
        <input
          type="password"
          value={newUser.password}
          onChange={e => setNewUser({ ...newUser, password: e.target.value })}
          placeholder="初始密码"
        />
        <div className="flex gap-2">
          <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })}>
            <option value="member">成员</option>
            <option value="team_admin">团队管理</option>
            <option value="tenant_admin">管理员</option>
          </select>
          <button className="btn btn-primary" onClick={create}>创建</button>
        </div>
      </div>
      {createError && <div style={{ color: 'var(--danger)', fontSize: '.82em', marginBottom: 10 }}>{createError}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>用户名</th><th>邮箱</th><th>名称</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            {users.map((u: any) => (
              <tr key={u.email}>
                <td>{u.username || u.email}</td><td>{u.email}</td><td>{u.name}</td>
                <td>
                  <select value={u.role} onChange={e => changeRole(u.email, e.target.value)} style={{ width: 130 }}>
                    <option value="tenant_admin">管理员</option><option value="team_admin">团队管理</option><option value="member">成员</option>
                  </select>
                </td>
                <td style={{ fontSize: '.8em' }}>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => remove(u.email)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ApiKeyManager() {
  const [keys, setKeys] = useState<any[]>([]);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<string[]>([]);
  const [rawKey, setRawKey] = useState('');
  useEffect(() => { fetch('/api/api-keys', { headers: getAuthHeaders() }).then(r => r.json()).then(setKeys); }, []);

  const create = async () => {
    const r = await fetch('/api/api-keys', { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ name: newName, scopes: newScopes }) });
    const k = await r.json();
    setKeys([...keys, k]);
    setRawKey(k.rawKey);
    setNewName(''); setNewScopes([]);
  };
  const revoke = async (id: string) => {
    await fetch(`/api/api-keys/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
    setKeys(keys.filter((k: any) => k.id !== id));
  };

  const SCOPES = ['runs:write', 'runs:read', 'templates:write', 'templates:read', 'connections:use'];
  return (
    <div className="card">
      <div className="card-header">API 密钥</div>
      {rawKey && <div className="card mb-4" style={{ background: 'var(--success-bg)', borderColor: 'var(--success)' }}><div className="card-header">新密钥（仅显示一次）</div><code style={{ fontSize: '.8em', wordBreak: 'break-all' }}>{rawKey}</code></div>}
      <div className="grid-2 mb-4">
        <div className="form-group"><label>名称</label><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="My API Key" /></div>
        <div className="form-group">
          <label>权限范围</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {SCOPES.map(s => (
              <label key={s} style={{ fontSize: '.76em', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={newScopes.includes(s)} onChange={() => setNewScopes(newScopes.includes(s) ? newScopes.filter(x => x !== s) : [...newScopes, s])} style={{ width: 'auto' }} />{s}
              </label>
            ))}
          </div>
        </div>
      </div>
      <button className="btn btn-primary" onClick={create}>创建密钥</button>
      <div className="table-wrap mt-4">
        <table>
          <thead><tr><th>名称</th><th>前缀</th><th>权限</th><th>创建</th><th>操作</th></tr></thead>
          <tbody>
            {keys.map((k: any) => (
              <tr key={k.id}>
                <td>{k.name}</td><td style={{ fontFamily: 'var(--font-mono)', fontSize: '.8em' }}>{k.keyPrefix}</td>
                <td>{k.scopes?.join(', ') || '全部'}</td>
                <td style={{ fontSize: '.8em' }}>{new Date(k.createdAt).toLocaleDateString()}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => revoke(k.id)}>撤销</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TeamManager() {
  const [teams, setTeams] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [newName, setNewName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  useEffect(() => { fetch('/api/teams', { headers: getAuthHeaders() }).then(r => r.json()).then(setTeams); }, []);

  const create = async () => {
    const r = await fetch('/api/teams', { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ name: newName }) });
    const t = await r.json();
    setTeams([...teams, t]); setNewName('');
  };
  const select = async (t: any) => {
    setSel(t);
    const r = await fetch(`/api/teams/${t.id}/members`, { headers: getAuthHeaders() });
    setMembers(await r.json());
  };
  const addMember = async () => {
    await fetch(`/api/teams/${sel.id}/members`, { method: 'POST', headers: jsonAuthHeaders(), body: JSON.stringify({ userId: addEmail, role: 'member' }) });
    setAddEmail('');
    select(sel);
  };
  const removeMember = async (uid: string) => {
    await fetch(`/api/teams/${sel.id}/members/${uid}`, { method: 'DELETE', headers: getAuthHeaders() });
    select(sel);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <div className="card">
        <div className="card-header">团队列表</div>
        <div className="flex gap-2 mb-4"><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="团队名" style={{ flex: 1 }} /><button className="btn btn-primary btn-sm" onClick={create}>创建</button></div>
        {teams.map((t: any) => (
          <div key={t.id} className="tool-card mb-2" onClick={() => select(t)} style={{ cursor: 'pointer', background: sel?.id === t.id ? 'var(--accent-bg)' : undefined }}>
            <div className="tool-card-name">{t.name}</div>
            <div className="tool-card-desc">{t.memberCount} 人</div>
          </div>
        ))}
      </div>
      {sel && (
        <div className="card">
          <div className="card-header">{sel.name} — 成员</div>
          <div className="flex gap-2 mb-4"><input value={addEmail} onChange={e => setAddEmail(e.target.value)} placeholder="用户邮箱" style={{ flex: 1 }} /><button className="btn btn-primary btn-sm" onClick={addMember}>添加</button></div>
          {members.map((m: any) => (
            <div key={m.userId} className="flex-between tool-card mb-2">
              <div><div className="tool-card-name">{m.email}</div><div className="tool-card-desc">{m.role}</div></div>
              <button className="btn btn-sm btn-danger" onClick={() => removeMember(m.userId)}>移除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuotaManager() {
  const [quota, setQuota] = useState<any>(null);
  const [usage, setUsage] = useState<QuotaUsageSummary | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(true);
  const [usageLoading, setUsageLoading] = useState(true);
  const [quotaError, setQuotaError] = useState('');
  const [usageError, setUsageError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>({});
  useEffect(() => {
    let cancelled = false;
    setQuotaLoading(true);
    setUsageLoading(true);
    setQuotaError('');
    setUsageError('');

    fetch('/api/quota', { headers: getAuthHeaders() })
      .then(async r => {
        if (!r.ok) throw new Error(await r.text() || '配额数据加载失败');
        return r.json();
      })
      .then(d => {
        if (cancelled) return;
        setQuota(d);
        setForm(d);
      })
      .catch(error => {
        if (!cancelled) setQuotaError((error as Error).message || '配额数据加载失败');
      })
      .finally(() => {
        if (!cancelled) setQuotaLoading(false);
      });

    fetch('/api/quota/usage', { headers: getAuthHeaders() })
      .then(async r => {
        if (!r.ok) throw new Error(await r.text() || '真实用量加载失败');
        return r.json();
      })
      .then(d => {
        if (!cancelled) setUsage(d);
      })
      .catch(error => {
        if (!cancelled) {
          setUsage(null);
          setUsageError((error as Error).message || '真实用量加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const r = await fetch('/api/quota', { method: 'PATCH', headers: jsonAuthHeaders(), body: JSON.stringify(form) });
    const nextQuota = await r.json();
    setQuota(nextQuota);
    setUsage(usage ? { ...usage, quota: nextQuota } : usage);
    setEditing(false);
  };

  if (quotaLoading) {
    return (
      <div className="card">
        <div className="card-header">配额管理</div>
        <div className="kpi-card">
          <div className="kpi-label">正在读取配额数据</div>
          <div className="kpi-sub">基础配置加载完成后会先显示，真实用量会继续独立刷新。</div>
        </div>
      </div>
    );
  }
  if (quotaError || !quota) {
    return (
      <div className="card">
        <div className="card-header">配额管理</div>
        <div className="kpi-card">
          <div className="kpi-label" style={{ color: 'var(--danger)' }}>配额数据加载失败</div>
          <div className="kpi-sub">{quotaError || '服务器没有返回配额数据'}</div>
        </div>
      </div>
    );
  }
  const FIELDS = [
    { key: 'monthlyActiveSecondsLimit', label: '月活跃秒数上限', unit: '秒' },
    { key: 'weeklyRunCountLimit', label: '周运行次数上限', unit: '次' },
    { key: 'maxConcurrentRuns', label: '最大并发运行数', unit: '个' },
    { key: 'perRunMaxActiveHours', label: '单次最大活跃时长', unit: '小时' },
    { key: 'perRunMaxWallClockHours', label: '单次最大墙钟时长', unit: '小时' },
    { key: 'perRunMaxLlmTokens', label: '单次最大 LLM Token', unit: 'tokens' },
    { key: 'perRunMaxToolCalls', label: '单次最大工具调用', unit: '次' },
    { key: 'knowledgeUploadAdminMaxFiles', label: '管理员上传文档数', unit: '个', hint: '默认 100，最高 500' },
    { key: 'knowledgeUploadMemberMaxFiles', label: '成员上传文档数', unit: '个', hint: '默认 20，最高 500' },
    {
      key: 'knowledgeUploadMaxFileBytes',
      label: '单文档大小上限',
      unit: 'MB',
      hint: '推荐 1MB，最高 20MB',
      display: formatBytes,
      inputValue: bytesToMb,
      toValue: mbToBytes,
      step: 0.1,
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {usageLoading && (
        <div className="card">
          <div className="flex-between">
            <div className="card-header" style={{ marginBottom: 0 }}>真实用量</div>
            <span className="badge badge-info">加载中</span>
          </div>
          <div className="kpi-card mt-4">
            <div className="kpi-label">正在聚合最近运行</div>
            <div className="kpi-sub">配额配置已可查看和调整，用量统计返回后会自动显示。</div>
          </div>
        </div>
      )}
      {!usageLoading && usageError && (
        <div className="card">
          <div className="flex-between">
            <div className="card-header" style={{ marginBottom: 0 }}>真实用量</div>
            <span className="badge badge-danger">加载失败</span>
          </div>
          <div className="kpi-card mt-4">
            <div className="kpi-label">最近运行统计暂不可用</div>
            <div className="kpi-sub">{usageError}</div>
          </div>
        </div>
      )}
      {usage && (
        <div className="card">
          <div className="flex-between">
            <div className="card-header" style={{ marginBottom: 0 }}>真实用量</div>
            <span className="badge badge-info">agent_run 审计聚合</span>
          </div>
          <div className="grid-4 mt-4">
            {[
              ['本周运行', `${formatNumber(usage.usage.weeklyRunCount.used)} / ${formatNumber(usage.usage.weeklyRunCount.limit)}`, usage.usage.weeklyRunCount.percent, '次'],
              ['月活跃时长', `${formatSeconds(usage.usage.monthlyActiveSeconds.used)} / ${formatSeconds(usage.usage.monthlyActiveSeconds.limit)}`, usage.usage.monthlyActiveSeconds.percent, ''],
              ['LLM Tokens', formatNumber(usage.usage.totalTokens), 0, `${formatNumber(usage.usage.totalInputTokens)} in / ${formatNumber(usage.usage.totalOutputTokens)} out`],
              ['估算成本', formatCurrency(usage.usage.totalCostUsd), 0, usage.usage.lastRunAt ? `最近 ${new Date(usage.usage.lastRunAt).toLocaleString()}` : '暂无运行'],
            ].map(([label, value, percent, sub]) => (
              <div key={label as string} className="kpi-card">
                <div className="kpi-label">{label}</div>
                <div className="kpi-value" style={{ fontSize: '1.18em' }}>{value}</div>
                {Number(percent) > 0 ? (
                  <>
                    <div style={{ height: 6, background: 'var(--bg-hover)', borderRadius: 999, overflow: 'hidden', marginTop: 10 }}>
                      <div style={{ width: `${percent}%`, height: '100%', background: usageColor(Number(percent)) }} />
                    </div>
                    <div className="kpi-sub">{percent}% 已用{sub ? ` · ${sub}` : ''}</div>
                  </>
                ) : (
                  <div className="kpi-sub">{sub}</div>
                )}
              </div>
            ))}
          </div>
          <div className="grid-3 mt-4">
            <div className="kpi-card">
              <div className="kpi-label">运行结果</div>
              <div className="kpi-value" style={{ fontSize: '1.1em' }}>{formatNumber(usage.usage.successfulRuns)} 成功</div>
              <div className="kpi-sub">{formatNumber(usage.usage.failedRuns)} 失败 · 最近 {formatNumber(usage.usage.totalRuns)} 条</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">总运行时长</div>
              <div className="kpi-value" style={{ fontSize: '1.1em' }}>{formatDuration(usage.usage.totalDurationMs)}</div>
              <div className="kpi-sub">来自最近 100 条 agent_run 审计</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">单次限制</div>
              <div className="kpi-value" style={{ fontSize: '1.1em' }}>{formatNumber(quota.perRunMaxToolCalls)} 工具</div>
              <div className="kpi-sub">{formatNumber(quota.perRunMaxLlmTokens)} tokens</div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex-between">
          <div className="card-header" style={{ marginBottom: 0 }}>配额管理</div>
          <button className="btn btn-sm" onClick={() => setEditing(!editing)}>{editing ? '取消' : '调整配额'}</button>
        </div>
        <div className="grid-2 mt-4">
          {FIELDS.map((field) => (
            <div key={field.key} className="kpi-card">
              <div className="kpi-label">{field.label}</div>
              {editing ? (
                <input
                  type="number"
                  step={field.step || 1}
                  value={field.inputValue ? field.inputValue(form[field.key]) : form[field.key] || 0}
                  onChange={e => setForm({ ...form, [field.key]: field.toValue ? field.toValue(e.target.value) : Number(e.target.value) })}
                  style={{ fontSize: '1.2em', fontWeight: 700 }}
                />
              ) : (
                <div className="kpi-value" style={{ fontSize: '1.1em' }}>
                  {field.display ? field.display(quota[field.key]) : `${quota[field.key]?.toLocaleString?.() || quota[field.key]} ${field.unit}`}
                </div>
              )}
              {editing && <div className="kpi-sub">{field.unit}{field.hint ? ` · ${field.hint}` : ''}</div>}
            </div>
          ))}
        </div>
        {editing && <button className="btn btn-primary mt-4" onClick={save}>保存配额</button>}
      </div>

      {usage && (
        <div className="card">
          <div className="card-header">最近运行</div>
          {usage.recentRuns.length === 0 ? (
            <div className="kpi-card">
              <div className="kpi-label">暂无 agent_run</div>
              <div className="kpi-sub">真实 SDK 执行完成后会自动写入这里。</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>时间</th><th>模型</th><th>状态</th><th>时长</th><th>Tokens</th><th>成本</th><th>操作者</th></tr></thead>
                <tbody>
                  {usage.recentRuns.map((run) => (
                    <tr key={run.id}>
                      <td style={{ fontSize: '.8em' }}>{new Date(run.createdAt).toLocaleString()}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78em' }}>{run.model || 'unknown'}</td>
                      <td>
                        {(() => {
                          const outcome = normalizeRunOutcome(run.status, 'provider_error');
                          return <span className={`badge ${outcomeBadgeClass(outcome)}`} title={run.status}>{outcomeLabel(outcome)}</span>;
                        })()}
                      </td>
                      <td>{formatDuration(run.durationMs)}</td>
                      <td>{formatNumber(run.totalTokens)}</td>
                      <td>{formatCurrency(run.costUsd)}</td>
                      <td style={{ fontSize: '.78em' }}>{run.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AuditLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => { fetch('/api/audit-logs', { headers: getAuthHeaders() }).then(r => r.json()).then(setLogs); }, []);
  return (
    <div className="card">
      <div className="card-header">审计日志 ({logs.length})</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>时间</th><th>操作</th><th>操作者</th><th>资源</th></tr></thead>
          <tbody>
            {logs.map((l: any) => (
              <tr key={l.id}>
                <td style={{ fontSize: '.8em' }}>{new Date(l.createdAt).toLocaleString()}</td>
                <td>{l.action}</td>
                <td>{l.actor}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78em' }}>{l.resource}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
