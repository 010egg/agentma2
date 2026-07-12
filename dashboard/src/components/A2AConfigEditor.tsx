import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { A2ARemoteAgentConfig } from '../simulator/types';
import { getAuthHeaders } from '../utils/client-runtime';
import { mintA2ARemoteId } from '../utils/platform-mcp-tools';
import LineIcon from './LineIcon';

type A2ACredentialMetadata = {
  id: string;
  name: string;
  createdAt: number;
  rotatedAt: number | null;
};

type A2ADiscovery = {
  name: string;
  description: string;
  rpcUrl: string;
};

type A2ADiscoveryState = {
  url: string;
  status: 'loading' | 'success' | 'error';
  message: string;
};

type Props = {
  templateId: string;
  published: boolean;
  remoteAgents: A2ARemoteAgentConfig[];
  canManageCredentials: boolean;
  onPublishedChange: (published: boolean) => void;
  onRemoteAgentsChange: (remoteAgents: A2ARemoteAgentConfig[]) => void;
};

async function readApiResponse<T>(response: Response): Promise<T> {
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

async function fetchCredentialOptions() {
  const response = await fetch('/api/a2a/credential-options', { headers: getAuthHeaders() });
  return readApiResponse<A2ACredentialMetadata[]>(response);
}

export default function A2AConfigEditor({
  templateId,
  published,
  remoteAgents,
  canManageCredentials,
  onPublishedChange,
  onRemoteAgentsChange,
}: Props) {
  const [credentials, setCredentials] = useState<A2ACredentialMetadata[]>([]);
  const [isCredentialsLoading, setIsCredentialsLoading] = useState(true);
  const [credentialError, setCredentialError] = useState('');
  const [credentialBusyId, setCredentialBusyId] = useState<string | null>(null);
  const [rotatingCredentialId, setRotatingCredentialId] = useState<string | null>(null);
  const [remoteDiscovery, setRemoteDiscovery] = useState<Record<number, A2ADiscoveryState>>({});
  const remoteAgentsRef = useRef(remoteAgents);
  const discoveryRequestRef = useRef<Record<number, number>>({});
  const newCredentialNameRef = useRef<HTMLInputElement | null>(null);
  const newCredentialSecretRef = useRef<HTMLInputElement | null>(null);
  const rotateCredentialSecretRef = useRef<HTMLInputElement | null>(null);
  const agentCardUrl = templateId
    ? `${window.location.origin}/a2a/agents/${encodeURIComponent(templateId)}/.well-known/agent-card.json`
    : '';

  useEffect(() => {
    remoteAgentsRef.current = remoteAgents;
  }, [remoteAgents]);

  useEffect(() => {
    let cancelled = false;
    void fetchCredentialOptions()
      .then((items) => {
        if (cancelled) return;
        setCredentials(Array.isArray(items) ? items : []);
        setCredentialError('');
      })
      .catch((loadError) => {
        if (cancelled) return;
        setCredentials([]);
        setCredentialError((loadError as Error).message || '加载 A2A 凭据失败');
      })
      .finally(() => {
        if (!cancelled) setIsCredentialsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const reloadCredentials = async () => {
    setIsCredentialsLoading(true);
    try {
      const items = await fetchCredentialOptions();
      setCredentials(Array.isArray(items) ? items : []);
      setCredentialError('');
    } catch (loadError) {
      setCredentialError((loadError as Error).message || '加载 A2A 凭据失败');
    } finally {
      setIsCredentialsLoading(false);
    }
  };

  const createCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nameInput = newCredentialNameRef.current;
    const secretInput = newCredentialSecretRef.current;
    const name = nameInput?.value.trim() || '';
    const secret = secretInput?.value || '';
    if (secretInput) secretInput.value = '';
    if (!name || !secret) {
      setCredentialError('创建凭据需要名称和密钥值');
      return;
    }

    setCredentialBusyId('create');
    setCredentialError('');
    try {
      const response = await fetch('/api/a2a/credentials', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name, secret }),
      });
      await readApiResponse<A2ACredentialMetadata>(response);
      if (nameInput) nameInput.value = '';
      await reloadCredentials();
    } catch (createError) {
      setCredentialError((createError as Error).message || '创建 A2A 凭据失败');
    } finally {
      setCredentialBusyId(null);
    }
  };

  const rotateCredential = async (event: FormEvent<HTMLFormElement>, credentialId: string) => {
    event.preventDefault();
    const secretInput = rotateCredentialSecretRef.current;
    const secret = secretInput?.value || '';
    if (secretInput) secretInput.value = '';
    if (!secret) {
      setCredentialError('请输入新的密钥值');
      return;
    }

    setCredentialBusyId(credentialId);
    setCredentialError('');
    try {
      const response = await fetch(`/api/a2a/credentials/${encodeURIComponent(credentialId)}`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ secret }),
      });
      await readApiResponse<A2ACredentialMetadata>(response);
      setRotatingCredentialId(null);
      await reloadCredentials();
    } catch (rotateError) {
      setCredentialError((rotateError as Error).message || '轮换 A2A 凭据失败');
    } finally {
      setCredentialBusyId(null);
    }
  };

  const deleteCredential = async (credential: A2ACredentialMetadata) => {
    if (!window.confirm(`删除凭据“${credential.name}”？被 Agent 引用时服务端会拒绝删除。`)) return;
    setCredentialBusyId(credential.id);
    setCredentialError('');
    try {
      const response = await fetch(`/api/a2a/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      await readApiResponse<{ ok: true }>(response);
      await reloadCredentials();
    } catch (deleteError) {
      setCredentialError((deleteError as Error).message || '删除 A2A 凭据失败');
    } finally {
      setCredentialBusyId(null);
    }
  };

  const addRemoteAgent = () => {
    onRemoteAgentsChange([
      ...remoteAgents,
      { id: mintA2ARemoteId(), name: '', agentCardUrl: '', credentialRef: undefined },
    ]);
  };

  const updateRemoteAgent = (index: number, patch: Partial<A2ARemoteAgentConfig>) => {
    const next = remoteAgentsRef.current.map((remote, remoteIndex) => (
      remoteIndex === index ? { ...remote, ...patch } : remote
    ));
    remoteAgentsRef.current = next;
    onRemoteAgentsChange(next);
  };

  const deleteRemoteAgent = (index: number) => {
    const next = remoteAgentsRef.current.filter((_, remoteIndex) => remoteIndex !== index);
    remoteAgentsRef.current = next;
    onRemoteAgentsChange(next);
    setRemoteDiscovery({});
  };

  const discoverRemoteAgent = async (index: number) => {
    const remote = remoteAgentsRef.current[index];
    const url = remote?.agentCardUrl.trim() || '';
    if (!url) return;
    try {
      new URL(url);
    } catch {
      setRemoteDiscovery(current => ({
        ...current,
        [index]: { url, status: 'error', message: '请先输入有效的绝对 URL' },
      }));
      return;
    }
    const currentState = remoteDiscovery[index];
    if (currentState?.url === url && currentState.status === 'success') return;
    const requestId = (discoveryRequestRef.current[index] || 0) + 1;
    discoveryRequestRef.current[index] = requestId;
    setRemoteDiscovery(current => ({
      ...current,
      [index]: { url, status: 'loading', message: '正在读取 Agent Card…' },
    }));
    try {
      const response = await fetch(`/api/a2a/discover?url=${encodeURIComponent(url)}`, {
        headers: getAuthHeaders(),
      });
      const discovered = await readApiResponse<A2ADiscovery>(response);
      const latest = remoteAgentsRef.current[index];
      if (discoveryRequestRef.current[index] !== requestId || latest?.agentCardUrl.trim() !== url) return;
      if (!latest.name.trim()) updateRemoteAgent(index, { name: discovered.name });
      setRemoteDiscovery(current => ({
        ...current,
        [index]: { url, status: 'success', message: `已识别：${discovered.name}` },
      }));
    } catch (discoveryError) {
      if (discoveryRequestRef.current[index] !== requestId) return;
      setRemoteDiscovery(current => ({
        ...current,
        [index]: { url, status: 'error', message: (discoveryError as Error).message || '无法读取 Agent Card' },
      }));
    }
  };

  return (
    <section className="a2a-config-panel" aria-labelledby="agent-a2a-config-title">
      <div className="a2a-config-head">
        <div className="a2a-config-heading">
          <span className="a2a-config-icon" aria-hidden="true"><LineIcon name="radio" /></span>
          <div>
            <div id="agent-a2a-config-title" className="a2a-config-title">A2A 1.0 互操作</div>
            <div className="a2a-config-subtitle">发布这个模板的 Agent Card，或把远程 A2A Agent 作为后续运行工具。</div>
          </div>
        </div>
        <label className="a2a-publish-toggle">
          <input type="checkbox" checked={published} onChange={event => onPublishedChange(event.target.checked)} />
          <span className="a2a-publish-switch" aria-hidden="true" />
          <span>{published ? 'A2A 已发布' : 'A2A 未发布'}</span>
        </label>
      </div>

      <div className="a2a-card-url-block">
        <label htmlFor="agent-a2a-card-url">公开 Agent Card URL</label>
        <div className="a2a-card-url-row">
          <input
            id="agent-a2a-card-url"
            value={agentCardUrl}
            readOnly
            placeholder="保存 Agent 后生成固定 URL"
            aria-describedby="agent-a2a-card-url-help"
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!agentCardUrl}
            onClick={() => {
              if (agentCardUrl && navigator.clipboard) void navigator.clipboard.writeText(agentCardUrl);
            }}
            aria-label="复制 Agent Card URL"
          >
            <LineIcon name="copy" />
            复制
          </button>
        </div>
        <div id="agent-a2a-card-url-help" className="a2a-field-help">
          只有启用 A2A 发布且模板可用时，协议边界才会公开此 Card；浏览器登录令牌不会用于 A2A RPC。
        </div>
      </div>

      <div className="a2a-remotes-head">
        <div>
          <div className="a2a-section-label">远程 Agent</div>
          <div className="a2a-field-help">只需填写 Card URL；名称会自动读取，也可设置当前模板内唯一的本地别名。</div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={addRemoteAgent}
          disabled={remoteAgents.length >= 16}
        >
          <LineIcon name="agents" />
          添加远程 Agent
        </button>
      </div>

      {remoteAgents.length === 0 ? (
        <div className="a2a-empty-state">尚未配置远程 A2A Agent。未配置时不会生成远程调用工具。</div>
      ) : (
        <div className="a2a-remote-list">
          {remoteAgents.map((remote, index) => {
            const credentialAvailable = !remote.credentialRef
              || credentials.some(credential => credential.id === remote.credentialRef);
            return (
              <div key={index} className="a2a-remote-row">
                <div className="a2a-remote-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</div>
                <div className="a2a-remote-fields">
                  <div className="form-group">
                    <label htmlFor={`a2a-remote-name-${index}`}>本地名称（可选）</label>
                    <input
                      id={`a2a-remote-name-${index}`}
                      value={remote.name}
                      maxLength={64}
                      onChange={event => updateRemoteAgent(index, { name: event.target.value })}
                      placeholder="自动使用 Agent Card 名称"
                      autoComplete="off"
                    />
                    <div className="a2a-field-help">支持中文；填写后作为本地别名，不受远端 Card 改名影响。</div>
                  </div>
                  <div className="form-group a2a-remote-url-field">
                    <label htmlFor={`a2a-remote-url-${index}`}>Agent Card URL *</label>
                    <div className="a2a-card-url-row">
                      <input
                        id={`a2a-remote-url-${index}`}
                        type="url"
                        value={remote.agentCardUrl}
                        onChange={event => {
                          updateRemoteAgent(index, { agentCardUrl: event.target.value });
                          setRemoteDiscovery(current => {
                            const next = { ...current };
                            delete next[index];
                            return next;
                          });
                        }}
                        onBlur={() => { void discoverRemoteAgent(index); }}
                        placeholder="https://agent.example/.well-known/agent-card.json"
                        maxLength={2048}
                        autoComplete="url"
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!remote.agentCardUrl.trim() || remoteDiscovery[index]?.status === 'loading'}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => { void discoverRemoteAgent(index); }}
                      >
                        {remoteDiscovery[index]?.status === 'loading' ? '识别中…' : '识别'}
                      </button>
                    </div>
                    {remoteDiscovery[index] && (
                      <div
                        className={remoteDiscovery[index].status === 'error' ? 'a2a-inline-error' : 'a2a-field-help'}
                        role={remoteDiscovery[index].status === 'error' ? 'alert' : undefined}
                      >
                        {remoteDiscovery[index].message}
                      </div>
                    )}
                  </div>
                  <div className="form-group">
                    <label htmlFor={`a2a-remote-credential-${index}`}>Bearer 凭据</label>
                    <select
                      id={`a2a-remote-credential-${index}`}
                      value={remote.credentialRef || ''}
                      onChange={event => updateRemoteAgent(index, { credentialRef: event.target.value || undefined })}
                      disabled={isCredentialsLoading}
                    >
                      <option value="">不发送凭据</option>
                      {!credentialAvailable && remote.credentialRef && (
                        <option value={remote.credentialRef}>当前引用（不可用）</option>
                      )}
                      {credentials.map(credential => (
                        <option key={credential.id} value={credential.id}>{credential.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger a2a-remote-delete"
                  onClick={() => deleteRemoteAgent(index)}
                  aria-label={`删除远程 Agent ${remote.name || index + 1}`}
                >
                  <LineIcon name="trash" />
                  删除
                </button>
              </div>
            );
          })}
        </div>
      )}

      <details className="a2a-credentials-panel">
        <summary>
          <span>远程凭据</span>
          <span className="badge badge-muted">{credentials.length} 个</span>
          {!canManageCredentials && <span className="a2a-credentials-summary-note">管理员维护</span>}
        </summary>
        <div className="a2a-credentials-body">
          <div className="a2a-field-help">
            凭据值使用 AES-256-GCM 加密保存。界面只加载名称和引用 ID，不会回显明文或密文。
          </div>
          {credentialError && <div className="a2a-inline-error" role="alert">{credentialError}</div>}

          {canManageCredentials && (
            <form className="a2a-credential-create" onSubmit={createCredential}>
              <div className="form-group">
                <label htmlFor="a2a-new-credential-name">凭据名称 *</label>
                <input
                  id="a2a-new-credential-name"
                  ref={newCredentialNameRef}
                  maxLength={128}
                  placeholder="例如：Partner production"
                  autoComplete="off"
                />
              </div>
              <div className="form-group">
                <label htmlFor="a2a-new-credential-secret">Bearer 密钥 *</label>
                <input
                  id="a2a-new-credential-secret"
                  ref={newCredentialSecretRef}
                  type="password"
                  placeholder="仅在提交时发送一次"
                  autoComplete="new-password"
                />
              </div>
              <button type="submit" className="btn btn-sm btn-primary" disabled={credentialBusyId !== null}>
                <LineIcon name="shield" />
                {credentialBusyId === 'create' ? '创建中...' : '创建凭据'}
              </button>
            </form>
          )}

          {isCredentialsLoading ? (
            <div className="a2a-empty-state">加载凭据元数据...</div>
          ) : credentials.length === 0 ? (
            <div className="a2a-empty-state">暂无远程凭据。无认证的远程 Agent 可以保持“不发送凭据”。</div>
          ) : (
            <div className="a2a-credential-list">
              {credentials.map(credential => (
                <div key={credential.id} className="a2a-credential-row">
                  <div className="a2a-credential-main">
                    <strong>{credential.name}</strong>
                    <code title={credential.id}>{credential.id}</code>
                    <span>
                      {credential.rotatedAt
                        ? `轮换于 ${new Date(credential.rotatedAt).toLocaleString()}`
                        : `创建于 ${new Date(credential.createdAt).toLocaleString()}`}
                    </span>
                  </div>
                  {canManageCredentials && (
                    <div className="a2a-credential-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setRotatingCredentialId(current => current === credential.id ? null : credential.id)}
                        disabled={credentialBusyId !== null}
                      >
                        <LineIcon name="sliders" />
                        轮换
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => { void deleteCredential(credential); }}
                        disabled={credentialBusyId !== null}
                      >
                        <LineIcon name="trash" />
                        删除
                      </button>
                    </div>
                  )}
                  {canManageCredentials && rotatingCredentialId === credential.id && (
                    <form
                      className="a2a-credential-rotate"
                      onSubmit={event => { void rotateCredential(event, credential.id); }}
                    >
                      <label htmlFor={`a2a-rotate-secret-${credential.id}`}>新的 Bearer 密钥</label>
                      <input
                        id={`a2a-rotate-secret-${credential.id}`}
                        ref={rotateCredentialSecretRef}
                        type="password"
                        placeholder="提交后立即清空"
                        autoComplete="new-password"
                        autoFocus
                      />
                      <button type="submit" className="btn btn-sm btn-primary" disabled={credentialBusyId === credential.id}>
                        {credentialBusyId === credential.id ? '轮换中...' : '确认轮换'}
                      </button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
