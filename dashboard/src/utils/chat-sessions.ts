import type { ChatAttachment, ChatImageAttachment, ChatMessage, ChatSession } from '../simulator/types';
import { getAuthHeaders } from './client-runtime';
import { normalizeChatMessageStatus, normalizeMessageOutcome, outcomeToMessageStatus } from '../simulator/run-state';
import { normalizeChatRunStats } from './chat-run-stats';

const LEGACY_SESSION_KEY = 'agentma_chat_sessions';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_STORED_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const GENERIC_TITLES = new Set(['新对话', '(无标题)', '未命名对话']);
const MEANINGLESS_TITLE_RE = /^[\d\s,，.。、;；:：|/\\_-]+$/;

function compactTitleText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isMeaningfulTitle(value: string): boolean {
  return Boolean(value) && !GENERIC_TITLES.has(value) && !MEANINGLESS_TITLE_RE.test(value);
}

export function createChatSessionTitle(messages: ChatMessage[], existingTitle?: string): string {
  const current = compactTitleText(existingTitle);
  if (isMeaningfulTitle(current)) return current.slice(0, 60);

  const firstUser = messages.find((message) => message.role === 'user') || messages[0];
  const content = compactTitleText(firstUser?.content);
  if (isMeaningfulTitle(content)) return content.slice(0, 40);
  if (firstUser?.attachments?.some((attachment) => attachment.type === 'file')) return '文件对话';
  if (firstUser?.attachments?.some((attachment) => attachment.type === 'image')) return '图片对话';
  if (content) return '未命名对话';
  return '新对话';
}

export function getChatSessionDisplayTitle(session: Pick<ChatSession, 'title' | 'messages'>): string {
  return createChatSessionTitle(session.messages, session.title);
}

function normalizeAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ChatAttachment[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (raw.type === 'file') {
      const name = String(raw.name || '').trim();
      const data = String(raw.data || '');
      const size = Number(raw.size) || 0;
      if (!name || !data || size > MAX_STORED_ATTACHMENT_BYTES) return [];
      return [{
        id: String(raw.id || crypto.randomUUID()),
        type: 'file' as const,
        mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : 'application/octet-stream',
        data,
        name,
        size,
      }];
    }
    if (raw.type !== 'image') return [];
    const mediaType = String(raw.mediaType || '');
    const data = String(raw.data || '');
    if (!IMAGE_TYPES.has(mediaType) || !data) return [];
    return [{
      id: String(raw.id || crypto.randomUUID()),
      type: 'image' as const,
      mediaType: mediaType as ChatImageAttachment['mediaType'],
      data,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      size: Number(raw.size) || 0,
    }];
  });
}

function normalizeMessage(message: unknown): ChatMessage | null {
  if (!message || typeof message !== 'object') return null;
  const raw = message as Record<string, unknown>;
  const role = raw.role;
  const content = raw.content;
  const attachments = normalizeAttachments(raw.attachments);
  const timestamp = Number(raw.timestamp);
  if (!['user', 'assistant', 'system'].includes(String(role))) return null;
  if (typeof content !== 'string') return null;
  const status = normalizeChatMessageStatus(raw.status);
  const outcome = normalizeMessageOutcome(raw.outcome, status);
  const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  const thinking = typeof raw.thinking === 'string' && raw.thinking ? raw.thinking : undefined;
  const outcomeDetail = typeof raw.outcomeDetail === 'string' && raw.outcomeDetail ? raw.outcomeDetail : undefined;
  const runId = typeof raw.runId === 'string' && raw.runId ? raw.runId : undefined;
  const runStats = normalizeChatRunStats(raw.runStats);
  return {
    ...(id ? { id } : {}),
    role: role as ChatMessage['role'],
    content,
    ...(thinking ? { thinking } : {}),
    ...(status || outcome ? { status: status || outcomeToMessageStatus(outcome!) } : {}),
    ...(outcome ? { outcome } : {}),
    ...(outcomeDetail ? { outcomeDetail } : {}),
    ...(runId ? { runId } : {}),
    ...(runStats ? { runStats } : {}),
    ...(attachments.length ? { attachments } : {}),
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

function normalizeSession(session: unknown): ChatSession | null {
  if (!session || typeof session !== 'object') return null;
  const id = String((session as { id?: unknown }).id || '');
  const ownerSub = String((session as { ownerSub?: unknown }).ownerSub || '');
  const templateId = String((session as { templateId?: unknown }).templateId || '');
  const title = String((session as { title?: unknown }).title || '');
  const model = String((session as { model?: unknown }).model || '');
  const sdkSessionId = String((session as { sdkSessionId?: unknown }).sdkSessionId || '');
  const sdkCwd = String((session as { sdkCwd?: unknown }).sdkCwd || '');
  const visualPreprocessModel = String((session as { visualPreprocessModel?: unknown }).visualPreprocessModel || '');
  const forkedFromSessionId = String((session as { forkedFromSessionId?: unknown }).forkedFromSessionId || '');
  const forkedFromTitle = String((session as { forkedFromTitle?: unknown }).forkedFromTitle || '');
  const collaborationRole = String((session as { collaborationRole?: unknown }).collaborationRole || '');
  const collaborationUpdatedAt = Number((session as { collaborationUpdatedAt?: unknown }).collaborationUpdatedAt);
  const messageCount = Number((session as { messageCount?: unknown }).messageCount);
  const createdAt = Number((session as { createdAt?: unknown }).createdAt);
  const updatedAt = Number((session as { updatedAt?: unknown }).updatedAt);
  if (!id || !templateId) return null;
  const rawMessages = Array.isArray((session as { messages?: unknown[] }).messages)
    ? (session as { messages: unknown[] }).messages
    : [];
  const messages = rawMessages.flatMap((message) => {
    const normalized = normalizeMessage(message);
    return normalized ? [normalized] : [];
  });
  return {
    id,
    ownerSub: ownerSub || undefined,
    templateId,
    title,
    messages,
    messageCount: Number.isFinite(messageCount) ? messageCount : messages.length,
    model,
    sdkSessionId: sdkSessionId || undefined,
    sdkCwd: sdkCwd || undefined,
    visualPreprocessEnabled: Boolean((session as { visualPreprocessEnabled?: unknown }).visualPreprocessEnabled),
    visualPreprocessModel: visualPreprocessModel || undefined,
    forkedFromSessionId: forkedFromSessionId || undefined,
    forkedFromTitle: forkedFromTitle || undefined,
    pinned: Boolean((session as { pinned?: unknown }).pinned),
    collaborationEnabled: Boolean((session as { collaborationEnabled?: unknown }).collaborationEnabled),
    collaborationRole: collaborationRole === 'owner' || collaborationRole === 'member' ? collaborationRole : undefined,
    collaborationUpdatedAt: Number.isFinite(collaborationUpdatedAt) ? collaborationUpdatedAt : undefined,
    persisted: true,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) as T : null;
  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>))
      ? String((data as Record<string, unknown>).error || '请求失败')
      : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export function loadLegacyChatSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((session) => {
      const normalized = normalizeSession(session);
      // localStorage 里的旧会话不是服务端确认过的
      return normalized ? [{ ...normalized, persisted: undefined }] : [];
    });
  } catch {
    return [];
  }
}

export async function listChatSessions(): Promise<ChatSession[]> {
  const res = await fetch('/api/chat-sessions', {
    headers: getAuthHeaders(),
  });
  const data = await readJson<unknown[]>(res);
  return Array.isArray(data)
    ? data.flatMap((session) => {
        const normalized = normalizeSession(session);
        return normalized ? [normalized] : [];
      })
    : [];
}

export async function listChatSessionSummaries(): Promise<ChatSession[]> {
  const res = await fetch('/api/chat-sessions?summary=1', {
    headers: getAuthHeaders(),
  });
  const data = await readJson<unknown[]>(res);
  return Array.isArray(data)
    ? data.flatMap((session) => {
        const normalized = normalizeSession(session);
        return normalized ? [normalized] : [];
      })
    : [];
}

export async function getChatSession(sessionId: string): Promise<ChatSession | null> {
  const res = await fetch(`/api/chat-sessions/${encodeURIComponent(sessionId)}`, {
    headers: getAuthHeaders(),
  });
  if (res.status === 404) return null;
  const data = await readJson<unknown>(res);
  return normalizeSession(data);
}

export async function saveChatSession(session: ChatSession): Promise<ChatSession> {
  const res = await fetch('/api/chat-sessions', {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(session),
  });
  const data = await readJson<unknown>(res);
  const normalized = normalizeSession(data);
  if (!normalized) throw new Error('会话保存失败');
  return normalized;
}

export async function patchChatSession(
  sessionId: string,
  patch: Partial<Pick<ChatSession, 'title' | 'pinned' | 'templateId' | 'model' | 'sdkSessionId' | 'sdkCwd' | 'visualPreprocessEnabled' | 'visualPreprocessModel'>>,
): Promise<ChatSession> {
  const res = await fetch(`/api/chat-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  });
  const data = await readJson<unknown>(res);
  const normalized = normalizeSession(data);
  if (!normalized) throw new Error('会话更新失败');
  return normalized;
}

export async function forkChatSession(sessionId: string): Promise<ChatSession> {
  const res = await fetch(`/api/chat-sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
  });
  const data = await readJson<unknown>(res);
  const normalized = normalizeSession(data);
  if (!normalized) throw new Error('会话复制失败');
  return normalized;
}

export async function setChatSessionCollaboration(sessionId: string, enabled: boolean): Promise<ChatSession> {
  const res = await fetch(`/api/chat-sessions/${encodeURIComponent(sessionId)}/collaboration`, {
    method: 'PATCH',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ enabled }),
  });
  const data = await readJson<unknown>(res);
  const normalized = normalizeSession(data);
  if (!normalized) throw new Error('协作设置失败');
  return normalized;
}

export async function joinChatSession(sessionId: string): Promise<ChatSession> {
  const res = await fetch(`/api/chat-sessions/${encodeURIComponent(sessionId)}/join`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
  });
  const data = await readJson<unknown>(res);
  const normalized = normalizeSession(data);
  if (!normalized) throw new Error('加入协作会话失败');
  return normalized;
}

export type ChatSessionEvent = {
  type: 'connected' | 'session_updated' | 'session_deleted';
  sessionId: string;
  updatedAt?: number;
  deletedAt?: number;
  collaborationEnabled?: boolean;
  joinedBy?: string;
};

export function subscribeChatSessionEvents(
  sessionId: string,
  onEvent: (event: ChatSessionEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const controller = new AbortController();
  const url = `/api/chat-sessions/${encodeURIComponent(sessionId)}/events`;

  (async () => {
    try {
      const res = await fetch(url, {
        headers: getAuthHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`协作连接失败: ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('协作连接无响应体');
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(6)) as ChatSessionEvent;
            if (event?.type && event.sessionId) onEvent(event);
          } catch {}
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) onError?.(error as Error);
    }
  })();

  return () => controller.abort();
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/chat-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  await readJson(res);
}

export async function bootstrapChatSessions(allowLegacyImport = true): Promise<ChatSession[]> {
  const remoteSessions = await listChatSessionSummaries();
  if (remoteSessions.length > 0) return remoteSessions;

  if (!allowLegacyImport) return [];

  const legacySessions = loadLegacyChatSessions();
  if (legacySessions.length === 0) return [];

  await Promise.allSettled(legacySessions.map((session) => saveChatSession(session)));
  return listChatSessionSummaries();
}
