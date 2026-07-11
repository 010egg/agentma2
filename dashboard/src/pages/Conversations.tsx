import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ClipboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChatSession, AgentTemplate, ChatMessage, ChatRunStats, ProviderConfig, ChatAttachment } from '../simulator/types';
import { initCustomTools } from '../simulator/mock-data';
import type { EventSourceConfig } from '../simulator/types';
import { getEndpointProbeBlockReason, isUsingApiKeyAuth, getAuthHeaders } from '../utils/client-runtime';
import { PermissionPromptList, type PermissionRequest } from '../components/PermissionPrompt';
import { AskUserQuestionPromptList, type AskUserQuestionRequest } from '../components/AskUserQuestionPrompt';
import { useAuth } from '../contexts/AuthContext';
import { bootstrapAgentTemplates, ensureVizAgentTemplate, loadCachedAgentTemplates } from '../utils/agent-templates';
import { buildRequestToolsForAgent } from '../utils/build-request-tools';
import { mergeAgentTaskEvent, taskStatusColor, taskStatusLabel, type AgentTaskEvent } from '../utils/agent-tasks';
import { mergeContextCompactionEvent, type ContextCompactionEvent } from '../utils/context-events';
import { appendAssistantDraft, finalizeAssistantDraft, updateAssistantDraft } from '../utils/chat-stream-draft';
import { findPendingRunMessage, observeServerRun } from '../utils/chat-run-events';
import { chatRunStatsFromResultEvent, latestAssistantRunStats } from '../utils/chat-run-stats';
import { fetchProviderModels, listProviderModels, loadProviderProfiles, resolveProviderForModel } from '../utils/providers';
import { useChatNextSuggestion } from '../utils/chat-suggestions';
import JsonViewer from '../components/common/JsonViewer';
import ChatMessageBubble from '../components/ChatMessageBubble';
import WaitingHint from '../components/WaitingHint';
import ChatModelPicker from '../components/ChatModelPicker';
import ModelPicker from '../components/common/ModelPicker';
import ContextWindowMeter from '../components/ContextWindowMeter';
import ContextCompactionEvents from '../components/ContextCompactionEvents';
import LineIcon, { type LineIconName } from '../components/LineIcon';
import {
  deriveRunPhase,
  isWaitingPhase,
  mapResultSubtypeToOutcome,
  normalizeRunOutcome,
  phaseBadgeClass,
  phaseLabel,
  type RunOutcome,
  type RunPhase,
} from '../simulator/run-state';
import {
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_FILE_MAX_COUNT,
  CHAT_IMAGE_MAX_COUNT,
  formatChatAttachmentUploadStatus,
  formatAttachmentBytes,
  getChatImageSrc,
  splitChatUploadFiles,
  type ChatAttachmentUploadStatus,
  uniqueChatImageFiles,
  uploadChatImages,
} from '../utils/chat-attachments-ui';
import {
  bootstrapChatSessions,
  createChatSessionTitle,
  deleteChatSession as deleteChatSessionApi,
  forkChatSession as forkChatSessionApi,
  getChatSession,
  getChatSessionDisplayTitle,
  joinChatSession as joinChatSessionApi,
  loadCachedChatSessionSummaries,
  patchChatSession,
  saveChatSession as saveChatSessionApi,
  setChatSessionCollaboration,
  subscribeChatSessionEvents,
  writeCachedChatSessionSummaries,
} from '../utils/chat-sessions';

// MCP 服务状态指示灯（自动 ping 端点）
function McpStatusDot({ server, endpoint }: { server: string; endpoint: string }) {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [detail, setDetail] = useState('');

  const doPing = useCallback(async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const blockedReason = getEndpointProbeBlockReason(endpoint);
      if (blockedReason) {
        if (!cancelled) {
          setStatus('offline');
          setDetail(blockedReason);
        }
        return;
      }
      // 试 /api/health
      const base = endpoint.replace(/\/api\/[^/]+$/, '');
      let ok = await doPing(base + '/api/health');
      if (!ok) ok = await doPing(endpoint); // 试直接请求 endpoint
      if (!cancelled) {
        setStatus(ok ? 'online' : 'offline');
        setDetail(ok ? '' : `无法连接 ${base}`);
      }
    };
    check();
    const iv = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [endpoint, doPing]);

  const colors: Record<string, string> = { checking: 'var(--ink-muted)', online: 'var(--success)', offline: 'var(--danger)' };
  return (
    <span title={`${server}: ${status}${detail ? ' — ' + detail : ''}`} style={{
      width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
      background: colors[status], cursor: 'pointer',
    }} onClick={() => { if (status === 'offline') alert(`${server} 离线\n${detail}`); }} />
  );
}

function formatEvent(ev: { type: string; source?: string; username?: string; message?: string; health?: number }): string {
  if (ev.type === 'chat') return `[${ev.source || 'bot'}] ${ev.username || '?'}: ${ev.message || ''}`;
  if (ev.type === 'health') return `[${ev.source || 'bot'}] 血量: ${ev.health}`;
  if (ev.type === 'playerJoin') return `[${ev.source || 'bot'}] ${ev.username || '?'} 加入了游戏`;
  if (ev.type === 'playerLeave') return `[${ev.source || 'bot'}] ${ev.username || '?'} 离开了游戏`;
  return `[${ev.source || 'bot'}] ${ev.type}`;
}

async function readChatError(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return `API 错误: ${response.status}`;
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (data?.message) return String(data.message);
    return data?.error ? String(data.error) : `API 错误: ${response.status}`;
  } catch {
    return text.slice(0, 240) || `API 错误: ${response.status}`;
  }
}

function compareChatSessions(a: ChatSession, b: ChatSession) {
  if (a.pinned && !b.pinned) return -1;
  if (!a.pinned && b.pinned) return 1;
  return b.updatedAt - a.updatedAt;
}

function getSessionsForAgent(sessions: ChatSession[], agentId: string) {
  return sessions
    .filter(session => session.templateId === agentId)
    .sort(compareChatSessions);
}

function canResumeSessionForAgent(session: ChatSession | null | undefined, agent: AgentTemplate | null | undefined) {
  if (!session?.sdkSessionId || !agent) return false;
  return session.templateId === agent.id;
}

function defaultVisualPreprocessEnabled(agent: AgentTemplate | null | undefined) {
  return agent?.visualPreprocessDefault === true;
}

function defaultVisualPreprocessModel(agent: AgentTemplate | null | undefined) {
  return agent?.visualPreprocessModel || '';
}

const SCROLL_BOTTOM_THRESHOLD = 80;

function isTextEntryElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'textarea' || tagName === 'select') return true;
  if (tagName !== 'input') return false;
  const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
  return !['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit'].includes(type);
}

function userInitial(label?: string) {
  const raw = (label || 'A').trim();
  return raw.slice(0, 1).toUpperCase();
}

type ConversationUrlState = Pick<ChatSession, 'id' | 'sdkSessionId'> | null;
type SessionRunUiState = {
  isStreaming: boolean;
  phase: RunPhase;
  runId: string;
  pendingPermissions: PermissionRequest[];
  pendingQuestions: AskUserQuestionRequest[];
  agentTasks: AgentTaskEvent[];
  contextEvents: ContextCompactionEvent[];
  structuredOutput: unknown;
  runStats: ChatRunStats | null;
};

const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = [];
const EMPTY_ASK_USER_QUESTIONS: AskUserQuestionRequest[] = [];
const EMPTY_AGENT_TASKS: AgentTaskEvent[] = [];
const EMPTY_CONTEXT_EVENTS: ContextCompactionEvent[] = [];
const HEADER_TOOL_PREF_KEY = 'agentma:conversation-header-tools:v1';

type HeaderToolKey = 'visual' | 'collaboration' | 'status' | 'context' | 'capabilities';
type HeaderToolPreferences = Record<HeaderToolKey, boolean>;

const DEFAULT_HEADER_TOOL_PREFERENCES: HeaderToolPreferences = {
  visual: true,
  collaboration: true,
  status: true,
  context: false,
  capabilities: false,
};

const HEADER_TOOL_OPTIONS: Array<{ key: HeaderToolKey; label: string; description: string; icon: LineIconName }> = [
  { key: 'visual', label: '视觉', description: '显示图片视觉预处理开关', icon: 'image' },
  { key: 'collaboration', label: '协作', description: '显示协作开关和复制入口', icon: 'agents' },
  { key: 'status', label: '运行状态', description: '运行时显示当前阶段', icon: 'radio' },
  { key: 'context', label: '上下文', description: '显示上下文窗口用量', icon: 'chart' },
  { key: 'capabilities', label: '能力', description: '显示知识库和 MCP 概览', icon: 'layers' },
];

function loadHeaderToolPreferences(): HeaderToolPreferences {
  try {
    const raw = localStorage.getItem(HEADER_TOOL_PREF_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<HeaderToolPreferences> : {};
    return {
      visual: parsed.visual ?? DEFAULT_HEADER_TOOL_PREFERENCES.visual,
      collaboration: parsed.collaboration ?? DEFAULT_HEADER_TOOL_PREFERENCES.collaboration,
      status: parsed.status ?? DEFAULT_HEADER_TOOL_PREFERENCES.status,
      context: parsed.context ?? DEFAULT_HEADER_TOOL_PREFERENCES.context,
      capabilities: parsed.capabilities ?? DEFAULT_HEADER_TOOL_PREFERENCES.capabilities,
    };
  } catch {
    return DEFAULT_HEADER_TOOL_PREFERENCES;
  }
}

function createIdleSessionRunUiState(): SessionRunUiState {
  return {
    isStreaming: false,
    phase: 'idle',
    runId: '',
    pendingPermissions: [],
    pendingQuestions: [],
    agentTasks: [],
    contextEvents: [],
    structuredOutput: null,
    runStats: null,
  };
}

type ChatSessionCacheUser = {
  tenantId?: string;
  id?: string;
  email?: string;
  username?: string;
} | null | undefined;

function getChatSessionSummaryCacheScope(user: ChatSessionCacheUser) {
  const tenantId = user?.tenantId || '';
  const ownerKey = user?.id || user?.email || user?.username || '';
  return tenantId && ownerKey ? `${tenantId}:${ownerKey}` : '';
}

export default function Conversations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAgentId = searchParams.get('agent') || '';
  const joinSessionId = searchParams.get('join') || '';
  const requestedConversationId = searchParams.get('conversationId') || '';
  const requestedSessionId = searchParams.get('sdkSessionId') || searchParams.get('sessionId') || '';
  const requestedDraft = searchParams.get('draft') || '';
  const { user } = useAuth();
  const chatSessionCacheScope = getChatSessionSummaryCacheScope(user);
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadCachedChatSessionSummaries(chatSessionCacheScope));
  const [sessionsLoading, setSessionsLoading] = useState(() => loadCachedChatSessionSummaries(chatSessionCacheScope).length === 0);
  const [sessionsError, setSessionsError] = useState('');
  const [templates, setTemplates] = useState<AgentTemplate[]>(() => loadCachedAgentTemplates(user?.tenantId));
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>(() => listProviderModels());
  const [selectedModelOverride, setSelectedModelOverride] = useState<{ contextKey: string; model: string } | null>(null);
  const [visualPreprocessEnabled, setVisualPreprocessEnabled] = useState(false);
  const [visualPreprocessModel, setVisualPreprocessModel] = useState('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState('');
  const [sessionLoadError, setSessionLoadError] = useState('');
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [headerToolPrefs, setHeaderToolPrefs] = useState<HeaderToolPreferences>(() => loadHeaderToolPreferences());
  const [headerDisplayOpen, setHeaderDisplayOpen] = useState(false);

  // 聊天状态
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionRunUi, setSessionRunUi] = useState<Record<string, SessionRunUiState>>({});
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentUploadStatus, setAttachmentUploadStatus] = useState<ChatAttachmentUploadStatus | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionLoadSeqRef = useRef(0);
  const isInputComposingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentUploadInFlightRef = useRef(false);
  const runAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const activeSessionIdRef = useRef<string | null>(null);
  const observingRunIdRef = useRef('');
  const activeItemRef = useRef<HTMLDivElement>(null);
  const provider = useRef<ProviderConfig>(resolveProviderForModel().provider);
  const currentAgent = templates.find(t => t.id === selectedAgentId);
  const activeSession = activeSessionId ? sessions.find(s => s.id === activeSessionId) || null : null;
  const isSessionDetailLoading = Boolean(activeSessionId && loadingSessionId === activeSessionId);
  const modelContextKey = `${selectedAgentId || ''}:${activeSessionId || 'new'}`;
  const selectedModel = selectedModelOverride?.contextKey === modelContextKey ? selectedModelOverride.model : '';
  const effectiveModel = selectedModel || activeSession?.model || currentAgent?.model || '';
  const activeRunUi = activeSessionId ? sessionRunUi[activeSessionId] : undefined;
  const isStreaming = Boolean(activeRunUi?.isStreaming);
  const runPhase = activeRunUi?.phase || 'idle';
  const pendingPermissions = activeRunUi?.pendingPermissions || EMPTY_PERMISSION_REQUESTS;
  const pendingQuestions = activeRunUi?.pendingQuestions || EMPTY_ASK_USER_QUESTIONS;
  const agentTasks = activeRunUi?.agentTasks || EMPTY_AGENT_TASKS;
  const contextEvents = activeRunUi?.contextEvents || EMPTY_CONTEXT_EVENTS;
  const structuredOutput = activeRunUi?.structuredOutput ?? null;
  const runStats = activeRunUi?.runStats || null;
  const observedRunStats = runStats || (!isStreaming ? latestAssistantRunStats(messages) : null);
  const suggestionModel = user?.inputSuggestionModel?.trim() || '';
  const suggestionProvider = useMemo(() => suggestionModel ? resolveProviderForModel(suggestionModel).provider : undefined, [suggestionModel]);
  const isAttachmentUploading = Boolean(attachmentUploadStatus);
  const nextSuggestion = useChatNextSuggestion({
    sessionId: activeSessionId,
    templateId: activeSession?.templateId || currentAgent?.id,
    template: currentAgent,
    model: suggestionModel,
    provider: suggestionProvider,
    messages,
    composerInput: input,
    attachments,
    disabled: isStreaming || isAttachmentUploading || isSessionDetailLoading || pendingPermissions.length > 0 || pendingQuestions.length > 0,
  });
  const isWelcomeState = messages.length === 0 && !isSessionDetailLoading && !sessionLoadError && !isStreaming;
  const agentToolSummary = useMemo(() => {
    const tools = currentAgent?.tools || [];
    const customs = initCustomTools();
    const servers = Array.from(new Set(
      tools
        .filter(t => customs.find(c => c.name === t)?.mcpServer)
        .map(t => customs.find(c => c.name === t)!.mcpServer!)
    )).map(server => {
      const serverTools = customs.filter(c => c.mcpServer === server && tools.includes(c.name));
      const firstEndpoint = serverTools.find(t => t.endpoint)?.endpoint;
      return {
        name: server,
        toolCount: serverTools.length,
        endpointUrl: firstEndpoint?.url || '',
      };
    });
    return { tools, servers };
  }, [currentAgent?.tools]);
  const pendingRunMessage = useMemo(() => findPendingRunMessage(messages), [messages]);
  const focusChatInput = useCallback(() => {
    requestAnimationFrame(() => {
      if (!textareaRef.current || textareaRef.current.disabled) return;
      textareaRef.current.focus();
    });
  }, []);

  const [botEvents, setBotEvents] = useState<Array<{ type: string; source?: string; username?: string; message?: string; health?: number; timestamp: number }>>([]);
  const [eventSources, setEventSources] = useState<EventSourceConfig[]>([]);
  const [subbedSources, setSubbedSources] = useState<string[]>([]);
  const [showEventToggles, setShowEventToggles] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [collaborationError, setCollaborationError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const selectedAgentSessions = selectedAgentId ? getSessionsForAgent(sessions, selectedAgentId) : [];
  const visibleSessions = selectedAgentSessions
    .filter(session => !sessionSearch || getChatSessionDisplayTitle(session).toLowerCase().includes(sessionSearch.toLowerCase()));
  const persistRef = useRef<((msgs: ChatMessage[], sid: string | null, sdkSessionId?: string, sdkCwd?: string, options?: { syncUrl?: boolean }) => Promise<string>) | null>(null);
  const appliedDraftRef = useRef('');
  const appliedConversationRequestRef = useRef('');

  const cacheSessions = useCallback((nextSessions: ChatSession[]) => {
    writeCachedChatSessionSummaries(chatSessionCacheScope, nextSessions);
  }, [chatSessionCacheScope]);

  const updateSessions = useCallback((updater: (previous: ChatSession[]) => ChatSession[]) => {
    setSessions(previous => {
      const next = updater(previous);
      cacheSessions(next);
      return next;
    });
  }, [cacheSessions]);

  const refreshAgentTemplates = useCallback(() => {
    const tenantId = user?.tenantId;
    if (!tenantId) return;
    void (async () => {
      try {
        const bootstrapped = await bootstrapAgentTemplates(tenantId, user.role === 'tenant_admin');
        const list = await ensureVizAgentTemplate(tenantId, bootstrapped);
        setTemplates(list);
      } catch (error) {
        console.error('failed to refresh agent templates', error);
      }
    })();
  }, [user?.tenantId, user?.role]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    setMobileMoreOpen(false);
    setHeaderDisplayOpen(false);
    setShowEventToggles(false);
  }, [activeSessionId, selectedAgentId]);

  const updateHeaderToolPreference = useCallback((key: HeaderToolKey, value: boolean) => {
    setHeaderToolPrefs(prev => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(HEADER_TOOL_PREF_KEY, JSON.stringify(next));
      } catch {
        // Preference persistence is optional; the in-memory toggle still works.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!currentAgent || activeSessionId) return;
    setVisualPreprocessEnabled(defaultVisualPreprocessEnabled(currentAgent));
    setVisualPreprocessModel(defaultVisualPreprocessModel(currentAgent));
  }, [activeSessionId, currentAgent?.id, currentAgent?.visualPreprocessDefault, currentAgent?.visualPreprocessModel]);

  const patchSessionRunUi = useCallback((
    sessionId: string,
    updater: (current: SessionRunUiState) => SessionRunUiState,
  ) => {
    if (!sessionId) return;
    setSessionRunUi(prev => {
      const current = prev[sessionId] || createIdleSessionRunUiState();
      const next = updater(current);
      return { ...prev, [sessionId]: next };
    });
  }, []);

  const beginSessionRun = useCallback((sessionId: string) => {
    patchSessionRunUi(sessionId, () => ({
      ...createIdleSessionRunUiState(),
      isStreaming: true,
      phase: 'initializing',
    }));
  }, [patchSessionRunUi]);

  const updateSessionRunPhase = useCallback((sessionId: string, phase: RunPhase) => {
    patchSessionRunUi(sessionId, current => ({ ...current, phase, isStreaming: current.isStreaming || phase !== 'idle' }));
  }, [patchSessionRunUi]);

  const finishSessionRun = useCallback((sessionId: string) => {
    runAbortControllersRef.current.delete(sessionId);
    patchSessionRunUi(sessionId, current => ({
      ...current,
      isStreaming: false,
      phase: 'idle',
      runId: '',
      pendingPermissions: [],
      pendingQuestions: [],
    }));
  }, [patchSessionRunUi]);

  const setSessionMessages = useCallback((
    sessionId: string,
    updater: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[]),
  ) => {
    if (activeSessionIdRef.current !== sessionId) return;
    setMessages(updater);
  }, []);

  useEffect(() => {
    if (!user?.tenantId) return;
    let cancelled = false;
    void fetchProviderModels()
      .then((models) => {
        if (!cancelled && models.length) setModelOptions(models);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [user?.tenantId]);

  useEffect(() => {
    if (!currentAgent || isStreaming || isSessionDetailLoading || pendingPermissions.length > 0 || pendingQuestions.length > 0) return;
    focusChatInput();
  }, [
    activeSessionId,
    currentAgent,
    focusChatInput,
    isSessionDetailLoading,
    isStreaming,
    pendingPermissions.length,
    pendingQuestions.length,
    selectedAgentId,
  ]);

  useEffect(() => {
    if (!currentAgent || isStreaming || isSessionDetailLoading || pendingPermissions.length > 0 || pendingQuestions.length > 0) return;
    const handleTypingIntent = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      if (isTextEntryElement(document.activeElement)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const textarea = textareaRef.current;
      if (!textarea || textarea.disabled) return;
      event.preventDefault();
      const start = textarea.selectionStart ?? input.length;
      const end = textarea.selectionEnd ?? input.length;
      const nextInput = input.slice(0, start) + event.key + input.slice(end);
      const nextCursor = start + event.key.length;
      setInput(nextInput);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
      });
    };
    window.addEventListener('keydown', handleTypingIntent);
    return () => window.removeEventListener('keydown', handleTypingIntent);
  }, [
    currentAgent,
    input,
    isSessionDetailLoading,
    isStreaming,
    pendingPermissions.length,
    pendingQuestions.length,
  ]);

  const syncConversationUrl = useCallback((session: ConversationUrlState) => {
    const next = new URLSearchParams(searchParams);
    next.delete('join');
    if (session?.id) next.set('conversationId', session.id);
    else next.delete('conversationId');
    next.delete('sessionId');
    if (session?.sdkSessionId) next.set('sdkSessionId', session.sdkSessionId);
    else next.delete('sdkSessionId');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const upsertSession = useCallback((session: ChatSession) => {
    updateSessions(prev => {
      const exists = prev.some((item) => item.id === session.id);
      if (!exists) return [session, ...prev];
      return prev.map((item) => item.id === session.id ? session : item);
    });
  }, [updateSessions]);

  const openSession = useCallback(async (session: ChatSession) => {
    const loadSeq = ++sessionLoadSeqRef.current;
    const messageCount = session.messageCount ?? session.messages.length;
    const hasFullMessages = session.messages.length >= messageCount;

    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setMessages(hasFullMessages ? session.messages : []);
    setSessionLoadError('');
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setAttachmentError('');
    const sessionAgent = templates.find(t => t.id === session.templateId) || null;
    setVisualPreprocessEnabled(session.visualPreprocessEnabled ?? defaultVisualPreprocessEnabled(sessionAgent));
    setVisualPreprocessModel(session.visualPreprocessModel || defaultVisualPreprocessModel(sessionAgent));
    if (session.templateId && templates.find(t => t.id === session.templateId)) {
      setSelectedAgentId(session.templateId);
    }
    setMobileListOpen(false);
    syncConversationUrl(session);

    if (hasFullMessages) {
      setLoadingSessionId('');
      return session;
    }

    setLoadingSessionId(session.id);
    try {
      const fullSession = await getChatSession(session.id);
      if (sessionLoadSeqRef.current !== loadSeq) return null;
      if (!fullSession) {
        updateSessions(prev => prev.filter(item => item.id !== session.id));
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
        setMessages([]);
        syncConversationUrl(null);
        return null;
      }
      upsertSession(fullSession);
      setMessages(fullSession.messages);
      const fullSessionAgent = templates.find(t => t.id === fullSession.templateId) || null;
      setVisualPreprocessEnabled(fullSession.visualPreprocessEnabled ?? defaultVisualPreprocessEnabled(fullSessionAgent));
      setVisualPreprocessModel(fullSession.visualPreprocessModel || defaultVisualPreprocessModel(fullSessionAgent));
      if (fullSession.templateId && templates.find(t => t.id === fullSession.templateId)) {
        setSelectedAgentId(fullSession.templateId);
      }
      syncConversationUrl(fullSession);
      return fullSession;
    } catch (error) {
      if (sessionLoadSeqRef.current === loadSeq) {
        setSessionLoadError((error as Error).message || '历史消息读取失败');
      }
      return null;
    } finally {
      if (sessionLoadSeqRef.current === loadSeq) setLoadingSessionId('');
    }
  }, [syncConversationUrl, templates, updateSessions, upsertSession]);

  // 自动回复
  const doAutoReply = useCallback(async (eventText: string) => {
    if (!currentAgent || isStreaming || !activeSessionId) return;

    const sessionId = activeSessionId;
    const agent = currentAgent;
    const currentMsgs = messages;
    const active = sessions.find((session) => session.id === sessionId);
    const autoModel = selectedModel || active?.model || agent.model;
    const prov = resolveProviderForModel(autoModel).provider;

    beginSessionRun(sessionId);
    const eventMsg: ChatMessage = { role: 'user', content: eventText, timestamp: Date.now() };
    const newMsgs = [...currentMsgs, eventMsg];
    const assistantTimestamp = Date.now();
    const draftId0 = crypto.randomUUID();
    const draftMsgs = appendAssistantDraft(newMsgs, draftId0, assistantTimestamp);
    setSessionMessages(sessionId, draftMsgs);
    await persistRef.current?.(draftMsgs, sessionId, undefined, undefined, { syncUrl: activeSessionIdRef.current === sessionId });

    let thinking = '';
    let text = '';
    const runIdForDraft = { current: '' };
    let didFinalize = false;
    let receivedOutcome: RunOutcome | null = null;
    let outcomeDetail: string | undefined;
    let cachedErrorMessage = '';
    const phaseFlags = {
      initializing: true,
      streaming: false,
      thinking: false,
      toolExecuting: false,
      awaitingPermission: false,
      awaitingInput: false,
      finalizing: false,
    };
    let pendingPermissionCount = 0;
    let pendingQuestionCount = 0;
    const updateRunPhase = (patch: Partial<typeof phaseFlags>) => {
      Object.assign(phaseFlags, patch);
      updateSessionRunPhase(sessionId, deriveRunPhase(phaseFlags));
    };
    const finishRun = () => {
      finishSessionRun(sessionId);
    };
    const persistFinalMessage = async (
      content: string,
      outcome: RunOutcome,
      sdkSessionId?: string,
      sdkCwd?: string,
      detail?: string,
      finalRunStats?: ChatRunStats,
    ) => {
      if (didFinalize) return;
      didFinalize = true;
      updateRunPhase({ finalizing: true, initializing: false, streaming: false, thinking: false, toolExecuting: false });
      const finalMsgs = finalizeAssistantDraft(newMsgs, draftId0, assistantTimestamp, content, outcome, thinking || undefined, detail, runIdForDraft.current || undefined, finalRunStats);
      setSessionMessages(sessionId, finalMsgs);
      const sid = await (persistRef.current?.(finalMsgs, sessionId, sdkSessionId, sdkCwd, { syncUrl: activeSessionIdRef.current === sessionId }) || Promise.resolve(''));
      if (sid && activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = sid;
        setActiveSessionId(sid);
      }
    };

    const controller = new AbortController();
    runAbortControllersRef.current.set(sessionId, controller);

    try {
      const shouldResume = canResumeSessionForAgent(active, agent);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          assistantDraftId: draftId0,
          assistantTimestamp,
          title: createChatSessionTitle(newMsgs, active?.title),
          messages: newMsgs.map((m, index) => ({
            role: m.role,
            content: m.content,
            attachments: index === newMsgs.length - 1 ? m.attachments : undefined,
            timestamp: m.timestamp,
            id: m.id,
            status: m.status,
            thinking: m.thinking,
            outcome: m.outcome,
            outcomeDetail: m.outcomeDetail,
            runStats: m.runStats,
          })),
          systemPrompt: agent.systemPrompt || undefined,
          model: autoModel,
          provider: prov,
          providerProfiles: loadProviderProfiles(),
          templateId: agent.id,
          sessionId,
          tools: buildRequestToolsForAgent(agent),
          mcpServers: agent.mcpServers || [],
          subagents: agent.subagents,
          skills: agent.skills || [],
          enableFileCheckpointing: agent.enableFileCheckpointing || undefined,
          useKnowledge: agent.useKnowledge || undefined,
          knowledgeSourceIds: agent.knowledgeSourceIds || [],
          outputSchema: agent.outputSchema || undefined,
          sdkSessionId: shouldResume ? active?.sdkSessionId : undefined,
          sdkCwd: shouldResume ? active?.sdkCwd : undefined,
          forkedFromSessionId: active?.forkedFromSessionId,
          forkedFromTitle: active?.forkedFromTitle,
          pinned: active?.pinned,
          ownerSub: active?.ownerSub,
          collaborationEnabled: active?.collaborationEnabled,
          collaborationRole: active?.collaborationRole,
          collaborationUpdatedAt: active?.collaborationUpdatedAt,
          createdAt: active?.createdAt,
        }),
      });

      if (!res.ok) {
        const errorText = await readChatError(res);
        await persistFinalMessage(errorText, 'rejected', undefined, undefined, errorText);
        finishRun();
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        await persistFinalMessage('连接失败: 响应体为空', 'provider_error', undefined, undefined, 'empty response body');
        finishRun();
        return;
      }

      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'run_started') {
              const runId = typeof d.runId === 'string' ? d.runId : '';
              if (runId) {
                runIdForDraft.current = runId;
                patchSessionRunUi(sessionId, current => ({ ...current, runId, isStreaming: true }));
                setSessionMessages(sessionId, prev => updateAssistantDraft(prev, draftId0, { runId }));
                controller.signal.addEventListener('abort', () => {
                  fetch(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
                    method: 'POST',
                    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                  }).catch(() => undefined);
                }, { once: true });
              }
            } else if (d.type === 'system' && d.subtype === 'init') {
              updateRunPhase({ initializing: true });
            } else if (d.type === 'delta') {
              if (d.thinking) {
                thinking += d.text || '';
                setSessionMessages(sessionId, prev => updateAssistantDraft(prev, draftId0, { thinking, status: 'streaming' }));
                updateRunPhase({ initializing: false, thinking: true, streaming: false, toolExecuting: false });
              } else {
                text += d.text || '';
                setSessionMessages(sessionId, prev => updateAssistantDraft(prev, draftId0, { content: text, status: 'streaming' }));
                updateRunPhase({ initializing: false, thinking: false, streaming: true, toolExecuting: false });
              }
            } else if (d.type === 'result') {
              const finalOutcome = receivedOutcome || mapResultSubtypeToOutcome(d.subtype);
              const finalDetail = outcomeDetail || (typeof d.subtype === 'string' ? d.subtype : undefined);
              const content = text || d.text || '';
              if (d.structuredOutput !== undefined) {
                patchSessionRunUi(sessionId, current => ({ ...current, structuredOutput: d.structuredOutput }));
              }
              if (d.cost_usd !== undefined || d.duration_ms !== undefined || d.usage !== undefined) {
                const finalRunStats = chatRunStatsFromResultEvent(d);
                patchSessionRunUi(sessionId, current => ({
                  ...current,
                  runStats: finalRunStats || null,
                }));
                await persistFinalMessage(content || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : ''), finalOutcome, d.sdkSessionId, d.sdkCwd, finalDetail, finalRunStats);
              } else {
                await persistFinalMessage(content || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : ''), finalOutcome, d.sdkSessionId, d.sdkCwd, finalDetail);
              }
              refreshAgentTemplates();
            } else if (d.type === 'run_outcome') {
              receivedOutcome = normalizeRunOutcome(d.outcome, receivedOutcome || 'provider_error');
              outcomeDetail = typeof d.subtype === 'string'
                ? d.subtype
                : typeof d.message === 'string' ? d.message : outcomeDetail;
            } else if (d.type === 'permission_request') {
              pendingPermissionCount += 1;
              const req = {
                reqId: d.reqId, toolName: d.toolName, input: d.input,
                title: d.title, displayName: d.displayName, description: d.description,
                toolUseID: d.toolUseID,
              };
              patchSessionRunUi(sessionId, current => ({ ...current, pendingPermissions: [...current.pendingPermissions, req] }));
              updateRunPhase({ awaitingPermission: true, initializing: false });
            } else if (d.type === 'permission_resolved') {
              if (d.reqId) {
                pendingPermissionCount = Math.max(0, pendingPermissionCount - 1);
                patchSessionRunUi(sessionId, current => ({
                  ...current,
                  pendingPermissions: current.pendingPermissions.filter(p => p.reqId !== d.reqId),
                }));
                updateRunPhase({ awaitingPermission: pendingPermissionCount > 0 });
              }
            } else if (d.type === 'ask_user_question') {
              pendingQuestionCount += 1;
              const req = {
                reqId: d.reqId,
                questions: d.questions || [],
                toolUseID: d.toolUseID,
              };
              patchSessionRunUi(sessionId, current => ({ ...current, pendingQuestions: [...current.pendingQuestions, req] }));
              updateRunPhase({ awaitingInput: true, initializing: false });
            } else if (d.type === 'ask_user_question_resolved') {
              if (d.reqId) {
                pendingQuestionCount = Math.max(0, pendingQuestionCount - 1);
                patchSessionRunUi(sessionId, current => ({
                  ...current,
                  pendingQuestions: current.pendingQuestions.filter(p => p.reqId !== d.reqId),
                }));
                updateRunPhase({ awaitingInput: pendingQuestionCount > 0 });
              }
            } else if (String(d.type || '').startsWith('task_')) {
              patchSessionRunUi(sessionId, current => ({
                ...current,
                agentTasks: mergeAgentTaskEvent(current.agentTasks, d),
              }));
              updateRunPhase({ initializing: false, toolExecuting: true, thinking: false, streaming: false });
            } else if (d.type === 'context_compaction') {
              patchSessionRunUi(sessionId, current => ({
                ...current,
                contextEvents: mergeContextCompactionEvent(current.contextEvents, d),
              }));
            } else if (d.type === 'error') {
              cachedErrorMessage = String(d.message || '未知错误');
              receivedOutcome = receivedOutcome || 'provider_error';
              outcomeDetail = outcomeDetail || cachedErrorMessage;
            }
          } catch {}
        }
      }
      if (!didFinalize) {
        const fallbackOutcome = receivedOutcome && receivedOutcome !== 'completed' ? receivedOutcome : 'disconnected';
        await persistFinalMessage(text || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : '连接失败: 响应提前结束'), fallbackOutcome, undefined, undefined, outcomeDetail);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        await persistFinalMessage(text, 'stopped', undefined, undefined, 'AbortError');
      } else {
        const message = (error as Error).message;
        await persistFinalMessage(`连接失败: ${message}`, 'provider_error', undefined, undefined, message);
      }
    }
    finishRun();
  }, [
    activeSessionId,
    beginSessionRun,
    currentAgent,
    finishSessionRun,
    isStreaming,
    messages,
    patchSessionRunUi,
    selectedModel,
    sessions,
    setSessionMessages,
    refreshAgentTemplates,
    updateSessionRunPhase,
  ]);

  // 订阅 EventSource — 当 MCP 服务器部署后，自动桥接 bot 事件到当前会话
  useEffect(() => {
    if (!activeSessionId) return;
    const sid = activeSessionId;

    const setup = async () => {
      // 1. 获取已注册的事件源
      const srcRes = await fetch('/api/events/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) });
      const sources: EventSourceConfig[] = await srcRes.json().catch(() => []);
      if (!Array.isArray(sources) || sources.length === 0) return;

      // 首次打开自动订阅所有可用源，后续以用户手动选择为准
      const savedSubs: string[] = (() => { try { const r = localStorage.getItem(`session_subs_${sid}`); return r ? JSON.parse(r) : sources.map((s: EventSourceConfig) => s.name); } catch { return sources.map((s: EventSourceConfig) => s.name); } })();
      if (!localStorage.getItem(`session_subs_${sid}`)) {
        localStorage.setItem(`session_subs_${sid}`, JSON.stringify(savedSubs));
      }
      setEventSources(sources);
      setSubbedSources(savedSubs);

      for (const s of sources) {
        if (!s.enabled || !savedSubs.includes(s.name)) continue;
        fetch(`/api/sessions/${sid}/events/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceName: s.name }) }).catch(() => {});
      }

      // 3. 连接 SSE 事件流
      const evtSource = new EventSource(`/api/sessions/${sid}/events`);
      evtSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'connected') return;
          const ev = { ...data, timestamp: Date.now() };
          setBotEvents(prev => [...prev.slice(-50), ev]);
          // 事件自动触发 agent 回复
          if (!isStreaming && currentAgent) {
            doAutoReply(formatEvent(ev));
          }
        } catch {}
      };
      evtSource.onerror = () => { /* 自动重连 */ };
      return () => evtSource.close();
    };

    const cleanup = setup();
    return () => { cleanup.then(fn => fn?.()); };
  }, [activeSessionId, currentAgent]);

  // 加载数据
  // 锁定外层滚动，让内部区域各自独立滚动
  useEffect(() => {
    const el = document.querySelector('.main-content');
    if (el) el.classList.add('no-scroll');
    return () => { if (el) el.classList.remove('no-scroll'); };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (user?.tenantId) {
      const tenantId = user.tenantId;
      setTemplates(loadCachedAgentTemplates(tenantId));
      void (async () => {
        try {
          const bootstrapped = await bootstrapAgentTemplates(tenantId, user.role === 'tenant_admin');
          const list = await ensureVizAgentTemplate(tenantId, bootstrapped);
          if (!cancelled) setTemplates(list);
        } catch (error) {
          console.error('failed to load agent templates', error);
        }
      })();
    }

    (async () => {
      const cachedSessions = loadCachedChatSessionSummaries(chatSessionCacheScope);
      if (!cancelled) {
        setSessions(cachedSessions);
        setSessionsLoading(cachedSessions.length === 0);
      }
      setSessionsError('');
      try {
        const savedSessions = await bootstrapChatSessions(!isUsingApiKeyAuth(), chatSessionCacheScope);
        if (!cancelled) setSessions(savedSessions);
      } catch (error) {
        console.error('failed to load chat sessions', error);
        if (!cancelled) setSessionsError((error as Error).message || '历史对话加载失败');
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [chatSessionCacheScope, user?.tenantId, user?.role]);

  useEffect(() => {
    if (selectedAgentId) return;
    if (requestedAgentId) {
      if (templates.some((template) => template.id === requestedAgentId)) {
        setSelectedAgentId(requestedAgentId);
        return;
      }
      if (templates.length === 0) return;
    }
    const lastId = sessions.length > 0
      ? [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].templateId
      : templates[0]?.id || '';
    if (lastId) setSelectedAgentId(lastId);
  }, [requestedAgentId, sessions, templates, selectedAgentId]);

  useEffect(() => {
    if (joinSessionId) {
      appliedConversationRequestRef.current = '';
      return;
    }
    const requestKey = requestedConversationId
      ? `conversation:${requestedConversationId}`
      : requestedSessionId
        ? `sdk:${requestedSessionId}`
        : '';
    if (!requestKey) {
      appliedConversationRequestRef.current = '';
      return;
    }
    if (appliedConversationRequestRef.current === requestKey) return;

    const requestedSession = (requestedConversationId
      ? sessions.find((session) => session.id === requestedConversationId)
      : null)
      || (requestedSessionId
        ? sessions.find((session) => session.sdkSessionId === requestedSessionId)
        : null);
    if (!requestedSession) return;

    appliedConversationRequestRef.current = requestKey;
    if (activeSessionId !== requestedSession.id) {
      void openSession(requestedSession);
    }
  }, [joinSessionId, requestedConversationId, requestedSessionId, sessions, activeSessionId, openSession]);

  useEffect(() => {
    if (!requestedDraft || appliedDraftRef.current === requestedDraft) return;
    appliedDraftRef.current = requestedDraft;
    sessionLoadSeqRef.current += 1;
    setLoadingSessionId('');
    setSessionLoadError('');
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    setMessages([]);
    setInput(requestedDraft);
    setAttachments([]);
    setAttachmentError('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const next = new URLSearchParams(searchParams);
    next.delete('draft');
    setSearchParams(next, { replace: true });
  }, [requestedDraft, searchParams, setSearchParams]);

  const updateScrollBottomVisibility = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    const shouldShow = canScroll && distanceFromBottom > SCROLL_BOTTOM_THRESHOLD;
    shouldAutoScrollRef.current = !shouldShow;
    setShowScrollBottom(current => (current === shouldShow ? current : shouldShow));
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollBottom(false);
    } else {
      updateScrollBottomVisibility();
    }
  }, [messages, agentTasks, isStreaming, updateScrollBottomVisibility]);

  const scrollToBottom = () => {
    const el = messagesRef.current;
    if (!el) return;
    shouldAutoScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowScrollBottom(false);
  };

  // 保存会话（服务端持久化 + 本地状态同步）
  const persistSession = useCallback(async (
    msgs: ChatMessage[],
    sid: string | null,
    sdkSessionId?: string,
    sdkCwd?: string,
    options: { syncUrl?: boolean } = {},
  ) => {
    if (!selectedAgentId || msgs.length === 0) return '';
    const shouldSyncUrl = options.syncUrl !== false;
    const now = Date.now();
    const id = sid || `chat-${Date.now()}`;
    const existing = sid ? sessions.find((session) => session.id === sid) : undefined;
    const currentModel = selectedModel || existing?.model || currentAgent?.model || '';
    const canReuseExistingSdkSession = canResumeSessionForAgent(existing, currentAgent);
    const draft: ChatSession = {
      id,
      templateId: selectedAgentId,
      title: createChatSessionTitle(msgs, existing?.title),
      messages: msgs,
      messageCount: msgs.length,
      model: currentModel,
      sdkSessionId: canReuseExistingSdkSession ? existing?.sdkSessionId : sdkSessionId,
      sdkCwd: (canReuseExistingSdkSession ? existing?.sdkCwd : undefined) || sdkCwd,
      visualPreprocessEnabled,
      visualPreprocessModel: visualPreprocessModel || undefined,
      forkedFromSessionId: existing?.forkedFromSessionId,
      forkedFromTitle: existing?.forkedFromTitle,
      pinned: existing?.pinned,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    updateSessions(prev => {
      const existingSession = prev.find((session) => session.id === id);
      if (existingSession) {
        return prev.map((session) => session.id === id ? { ...draft, createdAt: existingSession.createdAt } : session);
      }
      return [draft, ...prev];
    });

    try {
      const saved = await saveChatSessionApi(draft);
      updateSessions(prev => {
        const exists = prev.some((session) => session.id === saved.id);
        if (!exists) return [saved, ...prev];
        return prev.map((session) => session.id === saved.id ? saved : session);
      });
      if (shouldSyncUrl) syncConversationUrl(saved);
      return saved.id;
    } catch (error) {
      console.error('failed to persist chat session', error);
      if (shouldSyncUrl) syncConversationUrl(draft);
      return id;
    }
  }, [selectedAgentId, currentAgent, sessions, syncConversationUrl, selectedModel, updateSessions, visualPreprocessEnabled, visualPreprocessModel]);

  // 把 persistSession 存到 ref 供 doAutoReply 使用
  persistRef.current = persistSession;

  // 新建对话
  const handleNew = () => {
    if (!selectedAgentId) return;
    sessionLoadSeqRef.current += 1;
    setLoadingSessionId('');
    setSessionLoadError('');
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    setMessages([]);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setAttachmentError('');
    setVisualPreprocessEnabled(defaultVisualPreprocessEnabled(currentAgent));
    setVisualPreprocessModel(defaultVisualPreprocessModel(currentAgent));
    setMobileListOpen(false);
    syncConversationUrl(null);
  };

  // 选中会话时滚动到可见位置
  useEffect(() => {
    if (activeSessionId && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [activeSessionId]);

  // 恢复已有会话
  const handleSelect = useCallback((s: ChatSession) => {
    void openSession(s);
  }, [openSession]);

  const handleAgentChange = useCallback((agentId: string) => {
    sessionLoadSeqRef.current += 1;
    setLoadingSessionId('');
    setSessionLoadError('');
    setSelectedAgentId(agentId);
    setSessionSearch('');
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setAttachmentError('');
    setMobileListOpen(false);

    const nextSession = getSessionsForAgent(sessions, agentId)[0];
    if (nextSession) {
      void openSession(nextSession);
      return;
    }

    setActiveSessionId(null);
    setMessages([]);
    syncConversationUrl(null);
  }, [sessions, syncConversationUrl, openSession]);

  const refreshSession = useCallback(async (sessionId: string) => {
    const refreshed = await getChatSession(sessionId);
    if (!refreshed) {
      updateSessions(prev => prev.filter(session => session.id !== sessionId));
      if (activeSessionId === sessionId) {
        sessionLoadSeqRef.current += 1;
        setLoadingSessionId('');
        setSessionLoadError('');
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
        setMessages([]);
        syncConversationUrl(null);
      }
      return null;
    }
    upsertSession(refreshed);
    if (activeSessionId === sessionId) {
      setMessages(refreshed.messages);
      if (refreshed.templateId) setSelectedAgentId(refreshed.templateId);
      syncConversationUrl(refreshed);
    }
    return refreshed;
  }, [activeSessionId, syncConversationUrl, updateSessions, upsertSession]);

  useEffect(() => {
    if (!activeSessionId || !pendingRunMessage?.id || !pendingRunMessage.runId) {
      observingRunIdRef.current = '';
      return;
    }
    if (isStreaming || runAbortControllersRef.current.has(activeSessionId)) return;
    if (observingRunIdRef.current === pendingRunMessage.runId) return;
    observingRunIdRef.current = pendingRunMessage.runId;
    const sessionId = activeSessionId;
    const controller = new AbortController();
    const baseMessages = messages;
    const sessionAbortRef = { current: null as AbortController | null };
    void observeServerRun({
      runId: pendingRunMessage.runId,
      sessionId,
      baseMessages,
      draftId: pendingRunMessage.id,
      assistantTimestamp: pendingRunMessage.timestamp,
      initialThinking: pendingRunMessage.thinking,
      initialText: pendingRunMessage.content,
      onMessages: updater => setSessionMessages(sessionId, updater),
      persistFinal: async (nextMessages, sdkSessionId, sdkCwd) => {
        const sid = await persistSession(nextMessages, sessionId, sdkSessionId, sdkCwd, { syncUrl: activeSessionIdRef.current === sessionId });
        if (sid && activeSessionIdRef.current === sessionId) {
          activeSessionIdRef.current = sid;
          setActiveSessionId(sid);
        }
      },
      setIsStreaming: (value) => {
        if (value) beginSessionRun(sessionId);
        else finishSessionRun(sessionId);
      },
      setRunPhase: phase => updateSessionRunPhase(sessionId, phase),
      setActiveRunId: runId => patchSessionRunUi(sessionId, current => ({ ...current, runId })),
      setPendingPermissions: updater => patchSessionRunUi(sessionId, current => ({ ...current, pendingPermissions: updater(current.pendingPermissions) })),
      setPendingQuestions: updater => patchSessionRunUi(sessionId, current => ({ ...current, pendingQuestions: updater(current.pendingQuestions) })),
      setAgentTasks: updater => patchSessionRunUi(sessionId, current => ({ ...current, agentTasks: updater(current.agentTasks) })),
      setContextEvents: updater => patchSessionRunUi(sessionId, current => ({ ...current, contextEvents: updater(current.contextEvents) })),
      setStructuredOutput: value => patchSessionRunUi(sessionId, current => ({ ...current, structuredOutput: value })),
      setRunStats: value => patchSessionRunUi(sessionId, current => ({ ...current, runStats: value })),
      abortRef: sessionAbortRef,
      signal: controller.signal,
    });
    if (sessionAbortRef.current) {
      runAbortControllersRef.current.set(sessionId, sessionAbortRef.current);
    }
    return () => {
      controller.abort();
      observingRunIdRef.current = '';
    };
  }, [
    activeSessionId,
    beginSessionRun,
    finishSessionRun,
    patchSessionRunUi,
    pendingRunMessage?.id,
    pendingRunMessage?.runId,
    pendingRunMessage?.timestamp,
    persistSession,
    setSessionMessages,
    updateSessionRunPhase,
  ]);

  useEffect(() => {
    if (!joinSessionId) return;
    let cancelled = false;
    const clearJoinParam = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('join');
      setSearchParams(next, { replace: true });
    };

    (async () => {
      setCollaborationError('');
      try {
        const joined = await joinChatSessionApi(joinSessionId);
        if (cancelled) return;
        upsertSession(joined);
        setLoadingSessionId('');
        setSessionLoadError('');
        activeSessionIdRef.current = joined.id;
        setActiveSessionId(joined.id);
        setMessages(joined.messages);
        if (joined.templateId) setSelectedAgentId(joined.templateId);
        syncConversationUrl(joined);
      } catch (error) {
        if (!cancelled) {
          setCollaborationError((error as Error).message || '加入协作会话失败');
          clearJoinParam();
        }
      }
    })();

    return () => { cancelled = true; };
  }, [joinSessionId, searchParams, setSearchParams, upsertSession, syncConversationUrl]);

  useEffect(() => {
    if (!activeSession?.id || !activeSession.collaborationEnabled) return;
    return subscribeChatSessionEvents(activeSession.id, (event) => {
      if (event.type === 'connected') return;
      if (event.type === 'session_deleted') {
        updateSessions(prev => prev.filter(session => session.id !== activeSession.id));
        sessionLoadSeqRef.current += 1;
        setLoadingSessionId('');
        setSessionLoadError('');
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
        setMessages([]);
        return;
      }
      void refreshSession(activeSession.id).catch((error) => {
        console.error('failed to refresh collaboration session', error);
      });
    }, (error) => {
      console.error('collaboration stream failed', error);
    });
  }, [activeSession?.id, activeSession?.collaborationEnabled, refreshSession, updateSessions]);

  // 编辑标题
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const startRename = (s: ChatSession) => {
    setEditingId(s.id);
    setEditTitle(s.title || s.messages[0]?.content?.slice(0, 40) || '');
  };

  const handleRename = async (id: string) => {
    const nextTitle = editTitle.trim();
    if (!nextTitle) return;
    updateSessions(prev => prev.map(s => s.id === id ? { ...s, title: nextTitle } : s));
    setEditingId(null);
    try {
      const saved = await patchChatSession(id, { title: nextTitle });
      updateSessions(prev => prev.map(s => s.id === id ? saved : s));
    } catch (error) {
      console.error('failed to rename chat session', error);
    }
  };

  // 置顶
  const handlePin = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const current = sessions.find((session) => session.id === id);
    const nextPinned = !current?.pinned;
    updateSessions(prev => prev.map(s => s.id === id ? { ...s, pinned: nextPinned } : s));
    try {
      const saved = await patchChatSession(id, { pinned: nextPinned });
      updateSessions(prev => prev.map(s => s.id === id ? saved : s));
    } catch (error) {
      console.error('failed to pin chat session', error);
    }
  };

  const handleCopySession = async (source: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const copied = await forkChatSessionApi(source.id);
      updateSessions(prev => [copied, ...prev.filter(s => s.id !== copied.id)]);
      setSessionSearch('');
      void openSession(copied);
    } catch (error) {
      alert(`复制会话失败: ${(error as Error).message || '未知错误'}`);
    }
  };

  // 删除会话
  const handleDelete = async (id: string) => {
    const updated = sessions.filter(s => s.id !== id);
    runAbortControllersRef.current.get(id)?.abort();
    runAbortControllersRef.current.delete(id);
    setSessionRunUi(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    updateSessions(() => updated);
    if (activeSessionId === id) {
      sessionLoadSeqRef.current += 1;
      setLoadingSessionId('');
      setSessionLoadError('');
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
      setMessages([]);
      setAttachments([]);
      setAttachmentError('');
      syncConversationUrl(null);
    }
    try {
      await deleteChatSessionApi(id);
    } catch (error) {
      console.error('failed to delete chat session', error);
      updateSessions(() => sessions);
    }
  };

  const handleToggleCollaboration = async () => {
    if (!activeSession || activeSession.collaborationRole === 'member') return;
    setCollaborationError('');
    setCopyStatus('');
    try {
      const saved = await setChatSessionCollaboration(activeSession.id, !activeSession.collaborationEnabled);
      upsertSession(saved);
      setMessages(saved.messages);
    } catch (error) {
      setCollaborationError((error as Error).message || '协作设置失败');
    }
  };

  const handleCopyCollaborationLink = async () => {
    if (!activeSession) return;
    const link = `${window.location.origin}/conversations?join=${encodeURIComponent(activeSession.id)}`;
    setCollaborationError('');
    try {
      await navigator.clipboard.writeText(link);
      setCopyStatus('已复制');
      setTimeout(() => setCopyStatus(''), 1800);
    } catch {
      window.prompt('复制协作链接', link);
    }
  };

  const handlePaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardItems = Array.from(event.clipboardData.items || []);
    const clipboardFiles = Array.from(event.clipboardData.files || []);
    const itemFiles = clipboardFiles.length ? [] : clipboardItems
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = uniqueChatImageFiles([...clipboardFiles, ...itemFiles]);

    if (!files.length) return;
    if (attachmentUploadInFlightRef.current || isAttachmentUploading) {
      event.preventDefault();
      setAttachmentError('附件还在上传中，请稍等');
      return;
    }
    event.preventDefault();
    setAttachmentError('');

    const imageCount = attachments.filter((item) => item.type === 'image').length;
    const remainingSlots = CHAT_IMAGE_MAX_COUNT - imageCount;
    if (remainingSlots <= 0) {
      setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
      return;
    }

    const accepted = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
    }
    if (!accepted.length) {
      setAttachmentError('这张图片无法读取，请换一张');
      return;
    }

    attachmentUploadInFlightRef.current = true;
    setAttachmentUploadStatus({ imageCount: accepted.length, fileCount: 0 });
    try {
      const nextAttachments = await uploadChatImages(accepted);
      setAttachments(prev => [...prev, ...nextAttachments]);
    } catch (error) {
      setAttachmentError((error as Error).message || '图片上传失败');
    } finally {
      attachmentUploadInFlightRef.current = false;
      setAttachmentUploadStatus(null);
    }
  }, [attachments, isAttachmentUploading]);

  const handleFilePicked = useCallback(async (fileList: FileList | null) => {
    const pickedFiles = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!pickedFiles.length) return;
    if (attachmentUploadInFlightRef.current || isAttachmentUploading) {
      setAttachmentError('附件还在上传中，请稍等');
      return;
    }
    setAttachmentError('');
    const { images, files } = splitChatUploadFiles(pickedFiles);

    const imageCount = attachments.filter((item) => item.type === 'image').length;
    const remainingImages = CHAT_IMAGE_MAX_COUNT - imageCount;
    const currentFileCount = attachments.filter((item) => item.type === 'file').length;
    const remainingFiles = CHAT_FILE_MAX_COUNT - currentFileCount;
    if (images.length > 0 && remainingImages <= 0) {
      setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
      return;
    }
    if (files.length > 0 && remainingFiles <= 0) {
      setAttachmentError(`最多一次发送 ${CHAT_FILE_MAX_COUNT} 个文件`);
      return;
    }

    const acceptedImages = images.slice(0, remainingImages);
    const acceptedFiles = files.slice(0, remainingFiles);
    if (images.length > remainingImages) setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
    if (files.length > remainingFiles) setAttachmentError(`最多一次发送 ${CHAT_FILE_MAX_COUNT} 个文件`);
    const nextAttachments: ChatAttachment[] = [];
    const errors: string[] = [];
    if (acceptedImages.length || acceptedFiles.length) {
      attachmentUploadInFlightRef.current = true;
      setAttachmentUploadStatus({ imageCount: acceptedImages.length, fileCount: acceptedFiles.length });
      try {
        if (acceptedImages.length) {
          try {
            nextAttachments.push(...await uploadChatImages(acceptedImages));
          } catch (error) {
            errors.push((error as Error).message || '图片上传失败');
          }
        }
        if (acceptedFiles.length) {
          try {
            const formData = new FormData();
            for (const file of acceptedFiles) formData.append('files', file, file.name);
            const response = await fetch('/api/chat/files/upload', {
              method: 'POST',
              headers: getAuthHeaders(),
              body: formData,
            });
            const data = await response.json().catch(() => ({})) as { attachments?: ChatAttachment[]; error?: string };
            if (!response.ok) throw new Error(data.error || `上传失败: ${response.status}`);
            nextAttachments.push(...(Array.isArray(data.attachments) ? data.attachments : []));
          } catch (error) {
            errors.push((error as Error).message || '文件上传失败');
          }
        }
      } finally {
        attachmentUploadInFlightRef.current = false;
        setAttachmentUploadStatus(null);
      }
    }
    if (nextAttachments.length) {
      setAttachments(prev => [...prev, ...nextAttachments]);
    }
    if (errors.length) {
      setAttachmentError(errors[0]);
    }
  }, [attachments, isAttachmentUploading]);

  // 发送消息
  const handleSend = useCallback(async () => {
    const content = input.trim();
    const messageAttachments = attachments;
    if ((!content && messageAttachments.length === 0) || isStreaming || isAttachmentUploading || attachmentUploadInFlightRef.current || isSessionDetailLoading || !currentAgent) return;
    nextSuggestion.markAcceptedSuggestionSent(content);

    const sendModel = selectedModel || activeSession?.model || currentAgent.model;
    provider.current = resolveProviderForModel(sendModel).provider;
    const requestSessionId = activeSessionId || `chat-${Date.now()}`;
    if (!activeSessionId) {
      activeSessionIdRef.current = requestSessionId;
      setActiveSessionId(requestSessionId);
    }
    beginSessionRun(requestSessionId);

    const userMsg: ChatMessage = {
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
    };
    const newMsgs = [...messages, userMsg];
    const assistantTimestamp = Date.now();
    const draftId = crypto.randomUUID();
    const draftMsgs = appendAssistantDraft(newMsgs, draftId, assistantTimestamp);
    shouldAutoScrollRef.current = true;
    setShowScrollBottom(false);
    setSessionMessages(requestSessionId, draftMsgs);
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setAttachmentError('');
    await persistSession(draftMsgs, requestSessionId, undefined, undefined, { syncUrl: activeSessionIdRef.current === requestSessionId });
    let thinking = '';
    let text = '';
    const runIdForDraft = { current: '' };
    let didFinalize = false;
    let receivedOutcome: RunOutcome | null = null;
    let outcomeDetail: string | undefined;
    let cachedErrorMessage = '';
    const phaseFlags = {
      initializing: true,
      streaming: false,
      thinking: false,
      toolExecuting: false,
      awaitingPermission: false,
      awaitingInput: false,
      finalizing: false,
    };
    let pendingPermissionCount = 0;
    let pendingQuestionCount = 0;
    const updateRunPhase = (patch: Partial<typeof phaseFlags>) => {
      Object.assign(phaseFlags, patch);
      updateSessionRunPhase(requestSessionId, deriveRunPhase(phaseFlags));
    };
    const finishRun = () => {
      finishSessionRun(requestSessionId);
    };
    const persistFinalMessage = async (
      finalContent: string,
      outcome: RunOutcome,
      sdkSessionId?: string,
      sdkCwd?: string,
      detail?: string,
      finalRunStats?: ChatRunStats,
    ) => {
      if (didFinalize) return;
      didFinalize = true;
      updateRunPhase({ finalizing: true, initializing: false, streaming: false, thinking: false, toolExecuting: false });
      const finalMsgs = finalizeAssistantDraft(newMsgs, draftId, assistantTimestamp, finalContent, outcome, thinking || undefined, detail, runIdForDraft.current || undefined, finalRunStats);
      setSessionMessages(requestSessionId, finalMsgs);
      const sid = await persistSession(finalMsgs, requestSessionId, sdkSessionId, sdkCwd, { syncUrl: activeSessionIdRef.current === requestSessionId });
      if (sid && activeSessionIdRef.current === requestSessionId) {
        activeSessionIdRef.current = sid;
        setActiveSessionId(sid);
      }
    };

    const controller = new AbortController();
    runAbortControllersRef.current.set(requestSessionId, controller);

    try {
      const active = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
      const shouldResume = canResumeSessionForAgent(active, currentAgent);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          assistantDraftId: draftId,
          assistantTimestamp,
          title: createChatSessionTitle(newMsgs, active?.title),
          messages: newMsgs.map((m, index) => ({
            role: m.role,
            content: m.content,
            attachments: index === newMsgs.length - 1 ? m.attachments : undefined,
            timestamp: m.timestamp,
            id: m.id,
            status: m.status,
            thinking: m.thinking,
            outcome: m.outcome,
            outcomeDetail: m.outcomeDetail,
            runStats: m.runStats,
          })),
          systemPrompt: currentAgent.systemPrompt || undefined,
          model: sendModel,
          provider: provider.current,
          providerProfiles: loadProviderProfiles(),
          visualPreprocessEnabled,
          visualPreprocessModel: visualPreprocessModel || undefined,
          templateId: currentAgent.id,
          sessionId: requestSessionId,
          tools: buildRequestToolsForAgent(currentAgent),
          mcpServers: currentAgent.mcpServers || [],
          subagents: currentAgent.subagents,
          skills: currentAgent.skills || [],
          enableFileCheckpointing: currentAgent.enableFileCheckpointing || undefined,
          useKnowledge: currentAgent.useKnowledge || undefined,
          knowledgeSourceIds: currentAgent.knowledgeSourceIds || [],
          outputSchema: currentAgent.outputSchema || undefined,
          sdkSessionId: shouldResume ? active?.sdkSessionId : undefined,
          sdkCwd: shouldResume ? active?.sdkCwd : undefined,
          forkedFromSessionId: active?.forkedFromSessionId,
          forkedFromTitle: active?.forkedFromTitle,
          pinned: active?.pinned,
          ownerSub: active?.ownerSub,
          collaborationEnabled: active?.collaborationEnabled,
          collaborationRole: active?.collaborationRole,
          collaborationUpdatedAt: active?.collaborationUpdatedAt,
          createdAt: active?.createdAt,
        }),
      });

      if (!res.ok) {
        const errorText = await readChatError(res);
        await persistFinalMessage(errorText, 'rejected', undefined, undefined, errorText);
        finishRun();
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        await persistFinalMessage('连接失败: 响应体为空', 'provider_error', undefined, undefined, 'empty response body');
        finishRun();
        return;
      }

      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'run_started') {
              const runId = typeof data.runId === 'string' ? data.runId : '';
              if (runId) {
                runIdForDraft.current = runId;
                patchSessionRunUi(requestSessionId, current => ({ ...current, runId, isStreaming: true }));
                setSessionMessages(requestSessionId, prev => updateAssistantDraft(prev, draftId, { runId }));
                controller.signal.addEventListener('abort', () => {
                  fetch(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {
                    method: 'POST',
                    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                  }).catch(() => undefined);
                }, { once: true });
              }
            } else if (data.type === 'system' && data.subtype === 'init') {
              updateRunPhase({ initializing: true });
            } else if (data.type === 'delta') {
              if (data.thinking) {
                thinking += data.text || '';
                setSessionMessages(requestSessionId, prev => updateAssistantDraft(prev, draftId, { thinking, status: 'streaming' }));
                updateRunPhase({ initializing: false, thinking: true, streaming: false, toolExecuting: false });
              } else {
                text += data.text || '';
                setSessionMessages(requestSessionId, prev => updateAssistantDraft(prev, draftId, { content: text, status: 'streaming' }));
                updateRunPhase({ initializing: false, thinking: false, streaming: true, toolExecuting: false });
              }
            } else if (data.type === 'result') {
              const finalOutcome = receivedOutcome || mapResultSubtypeToOutcome(data.subtype);
              const finalDetail = outcomeDetail || (typeof data.subtype === 'string' ? data.subtype : undefined);
              const finalContent = text || data.text || '';
              if (data.structuredOutput !== undefined) {
                patchSessionRunUi(requestSessionId, current => ({ ...current, structuredOutput: data.structuredOutput }));
              }
              if (data.cost_usd !== undefined || data.duration_ms !== undefined || data.usage !== undefined) {
                const finalRunStats = chatRunStatsFromResultEvent(data);
                patchSessionRunUi(requestSessionId, current => ({
                  ...current,
                  runStats: finalRunStats || null,
                }));
                await persistFinalMessage(finalContent || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : ''), finalOutcome, data.sdkSessionId, data.sdkCwd, finalDetail, finalRunStats);
              } else {
                await persistFinalMessage(finalContent || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : ''), finalOutcome, data.sdkSessionId, data.sdkCwd, finalDetail);
              }
              refreshAgentTemplates();
            } else if (data.type === 'run_outcome') {
              receivedOutcome = normalizeRunOutcome(data.outcome, receivedOutcome || 'provider_error');
              outcomeDetail = typeof data.subtype === 'string'
                ? data.subtype
                : typeof data.message === 'string' ? data.message : outcomeDetail;
            } else if (data.type === 'permission_request') {
              pendingPermissionCount += 1;
              const req = {
                reqId: data.reqId, toolName: data.toolName, input: data.input,
                title: data.title, displayName: data.displayName, description: data.description,
                toolUseID: data.toolUseID,
              };
              patchSessionRunUi(requestSessionId, current => ({ ...current, pendingPermissions: [...current.pendingPermissions, req] }));
              updateRunPhase({ awaitingPermission: true, initializing: false });
            } else if (data.type === 'permission_resolved') {
              if (data.reqId) {
                pendingPermissionCount = Math.max(0, pendingPermissionCount - 1);
                patchSessionRunUi(requestSessionId, current => ({
                  ...current,
                  pendingPermissions: current.pendingPermissions.filter(p => p.reqId !== data.reqId),
                }));
                updateRunPhase({ awaitingPermission: pendingPermissionCount > 0 });
              }
            } else if (data.type === 'ask_user_question') {
              pendingQuestionCount += 1;
              const req = {
                reqId: data.reqId,
                questions: data.questions || [],
                toolUseID: data.toolUseID,
              };
              patchSessionRunUi(requestSessionId, current => ({ ...current, pendingQuestions: [...current.pendingQuestions, req] }));
              updateRunPhase({ awaitingInput: true, initializing: false });
            } else if (data.type === 'ask_user_question_resolved') {
              if (data.reqId) {
                pendingQuestionCount = Math.max(0, pendingQuestionCount - 1);
                patchSessionRunUi(requestSessionId, current => ({
                  ...current,
                  pendingQuestions: current.pendingQuestions.filter(p => p.reqId !== data.reqId),
                }));
                updateRunPhase({ awaitingInput: pendingQuestionCount > 0 });
              }
            } else if (String(data.type || '').startsWith('task_')) {
              patchSessionRunUi(requestSessionId, current => ({
                ...current,
                agentTasks: mergeAgentTaskEvent(current.agentTasks, data),
              }));
              updateRunPhase({ initializing: false, toolExecuting: true, thinking: false, streaming: false });
            } else if (data.type === 'context_compaction') {
              patchSessionRunUi(requestSessionId, current => ({
                ...current,
                contextEvents: mergeContextCompactionEvent(current.contextEvents, data),
              }));
            } else if (data.type === 'error') {
              cachedErrorMessage = String(data.message || '未知错误');
              receivedOutcome = receivedOutcome || 'provider_error';
              outcomeDetail = outcomeDetail || cachedErrorMessage;
            }
          } catch {}
        }
      }
      if (!didFinalize) {
        const fallbackOutcome = receivedOutcome && receivedOutcome !== 'completed' ? receivedOutcome : 'disconnected';
        await persistFinalMessage(text || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : '连接失败: 响应提前结束'), fallbackOutcome, undefined, undefined, outcomeDetail);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        await persistFinalMessage(text, 'stopped', undefined, undefined, 'AbortError');
      } else {
        const message = (e as Error).message;
        await persistFinalMessage(`连接失败: ${message}`, 'provider_error', undefined, undefined, message);
      }
    }
    finishRun();
  }, [
    input,
    attachments,
    isStreaming,
    isAttachmentUploading,
    isSessionDetailLoading,
    currentAgent,
    messages,
    activeSessionId,
    persistSession,
    sessions,
    selectedModel,
    activeSession?.model,
    visualPreprocessEnabled,
    visualPreprocessModel,
    beginSessionRun,
    finishSessionRun,
    patchSessionRunUi,
    refreshAgentTemplates,
    setSessionMessages,
    updateSessionRunPhase,
    nextSuggestion,
  ]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    runAbortControllersRef.current.get(activeSessionId)?.abort();
  }, [activeSessionId]);

  const handleOpenMobileNavigation = useCallback(() => {
    setMobileListOpen(false);
    window.dispatchEvent(new Event('agentma:open-mobile-nav'));
  }, []);

  const handleApplySuggestion = useCallback(() => {
    const accepted = nextSuggestion.acceptSuggestion();
    if (!accepted) return false;
    setInput(accepted.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(accepted.text.length, accepted.text.length);
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    });
    return true;
  }, [nextSuggestion]);

  const renderAgentControls = (options: { showModel?: boolean; showContext?: boolean; showVisual?: boolean } = {}) => {
    if (!currentAgent) return null;
    const { showModel = true, showContext = true, showVisual = true } = options;
    return (
      <>
        {showModel && (
          <ChatModelPicker
            value={effectiveModel}
            templateModel={currentAgent.model}
            models={modelOptions}
            disabled={isStreaming}
            onChange={model => setSelectedModelOverride({ contextKey: modelContextKey, model })}
          />
        )}
        {showContext && (
          <ContextWindowMeter
            model={effectiveModel}
            inputTokens={observedRunStats?.inTok}
            outputTokens={observedRunStats?.outTok}
            compacted={contextEvents.length > 0}
          />
        )}
        {showVisual && (
          <>
            <label
              className={`badge ${visualPreprocessEnabled ? 'badge-info' : 'badge-muted'} conversation-visual-toggle`}
              title="开启后图片先由视觉模型预处理，再交给当前 Agent"
            >
              <input
                className="conversation-visual-toggle-input"
                type="checkbox"
                checked={visualPreprocessEnabled}
                disabled={isStreaming}
                onChange={event => {
                  const enabled = event.target.checked;
                  setVisualPreprocessEnabled(enabled);
                  if (enabled && !visualPreprocessModel) setVisualPreprocessModel(defaultVisualPreprocessModel(currentAgent));
                }}
              />
              <span className="conversation-visual-switch" aria-hidden="true" />
              <LineIcon name="image" />
            </label>
            {visualPreprocessEnabled && (
              <div className="conversation-visual-model-picker">
                <ModelPicker
                  value={visualPreprocessModel}
                  models={modelOptions}
                  onChange={setVisualPreprocessModel}
                  placeholder="视觉模型"
                />
              </div>
            )}
          </>
        )}
      </>
    );
  };

  const renderCapabilityBadges = () => (
    <>
      {((currentAgent?.knowledgeSourceIds || []).length > 0 || currentAgent?.useKnowledge) && (
        <span className="badge badge-success">知识库×{(currentAgent?.knowledgeSourceIds || []).length || '全部'}</span>
      )}
      {agentToolSummary.tools.length === 0 && <span className="badge badge-muted">无工具</span>}
    </>
  );

  const renderStatusBadges = () => (
    <>
      {runPhase !== 'idle' && (
        <span className={`badge ${phaseBadgeClass(runPhase)}`}>{phaseLabel(runPhase)}</span>
      )}
      {((currentAgent?.knowledgeSourceIds || []).length > 0 || currentAgent?.useKnowledge) && (
        <span className="badge badge-success">知识库×{(currentAgent?.knowledgeSourceIds || []).length || '全部'}</span>
      )}
      {agentToolSummary.servers.map(server => (
        <span key={server.name} className="conversation-mcp-server">
          <span className="badge badge-muted">
            {server.name}
          </span>
          {server.endpointUrl && <McpStatusDot server={server.name} endpoint={server.endpointUrl} />}
        </span>
      ))}
      {agentToolSummary.tools.length === 0 && <span className="badge badge-muted">无工具</span>}
    </>
  );

  const renderEventSourceControl = () => eventSources.length > 0 ? (
    <span className="conversation-event-source-control">
      <span
        className="badge"
        style={{
          cursor: 'pointer',
          background: subbedSources.length > 0 ? 'var(--success-bg)' : 'var(--bg-hover)',
          color: subbedSources.length > 0 ? 'var(--success)' : 'var(--ink-muted)',
          userSelect: 'none',
        }}
        onClick={() => setShowEventToggles(!showEventToggles)}
      >
        📡 {subbedSources.length > 0 ? subbedSources.length : '0'}
      </span>
      {showEventToggles && (
        <div className="conversation-event-source-popover fade-in">
          {eventSources.map(es => (
            <label key={es.name}>
              <input
                type="checkbox"
                checked={subbedSources.includes(es.name)}
                onChange={() => {
                  const next = subbedSources.includes(es.name) ? subbedSources.filter(s => s !== es.name) : [...subbedSources, es.name];
                  setSubbedSources(next);
                  localStorage.setItem(`session_subs_${activeSessionId}`, JSON.stringify(next));
                  fetch(`/api/sessions/${activeSessionId}/events/subscribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourceName: es.name }),
                  }).catch(() => {});
                }}
              />
              📡 {es.name}
            </label>
          ))}
        </div>
      )}
    </span>
  ) : null;

  const renderCollaborationControls = () => activeSession ? (
    <span className="conversation-collaboration-controls">
      <span className={`badge ${activeSession.collaborationEnabled ? 'badge-success' : 'badge-muted'}`}>
        协作{activeSession.collaborationEnabled ? `·${activeSession.collaborationRole === 'member' ? '成员' : 'Owner'}` : '关闭'}
      </span>
      {activeSession.collaborationRole !== 'member' && (
        <button
          className="btn btn-sm"
          onClick={handleToggleCollaboration}
          disabled={!activeSession.persisted}
          title={activeSession.persisted ? undefined : '发送一条消息保存会话后才能开启协作'}
        >
          {activeSession.collaborationEnabled ? '关闭协作' : '开启协作'}
        </button>
      )}
      {activeSession.collaborationEnabled && (
        <button className="btn btn-sm" onClick={handleCopyCollaborationLink}>
          {copyStatus || '复制链接'}
        </button>
      )}
      {collaborationError && (
        <span className="conversation-collaboration-error">{collaborationError}</span>
      )}
    </span>
  ) : null;

  const renderCollaborationQuickControl = () => {
    const collaborationEnabled = activeSession?.collaborationEnabled === true;
    const isMember = activeSession?.collaborationRole === 'member';
    const canToggle = Boolean(activeSession && !isMember && activeSession.persisted && !isStreaming);
    let title = '发送一条消息保存会话后才能开启协作';
    if (isMember) title = '你是协作会话成员';
    else if (activeSession?.persisted) title = '开启后可复制链接邀请他人协作';
    return (
      <>
        <label
          className={`badge ${collaborationEnabled ? 'badge-success' : 'badge-muted'} conversation-collaboration-quick`}
          title={title}
        >
          <input
            className="conversation-collaboration-quick-input"
            type="checkbox"
            checked={collaborationEnabled}
            disabled={!canToggle}
            onChange={() => {
              void handleToggleCollaboration();
            }}
          />
          <span className="conversation-collaboration-switch" aria-hidden="true" />
          <LineIcon name="agents" />
          <span className="conversation-collaboration-label">
            {isMember ? '成员' : '协作'}
          </span>
        </label>
        {collaborationEnabled && (
          <button
            className="btn btn-sm conversation-collaboration-copy"
            onClick={handleCopyCollaborationLink}
            title={copyStatus || '复制协作链接'}
            aria-label={copyStatus || '复制协作链接'}
          >
            <LineIcon name="copy" />
          </button>
        )}
      </>
    );
  };

  const renderHeaderDisplayControl = () => (
    <span className="conversation-header-display">
      <button
        type="button"
        className="btn btn-sm conversation-header-display-button"
        onClick={() => setHeaderDisplayOpen(open => !open)}
        aria-expanded={headerDisplayOpen}
        aria-label="选择顶部显示项"
        title="选择顶部显示项"
      >
        <LineIcon name="sliders" />
      </button>
      {headerDisplayOpen && (
        <div className="conversation-header-display-menu">
          {HEADER_TOOL_OPTIONS.map(option => (
            <label key={option.key} title={option.description}>
              <input
                type="checkbox"
                checked={headerToolPrefs[option.key]}
                onChange={event => updateHeaderToolPreference(option.key, event.target.checked)}
              />
              <LineIcon name={option.icon} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </span>
  );

  const renderHeaderTools = () => (
    <>
      {renderAgentControls({
        showModel: false,
        showContext: headerToolPrefs.context,
        showVisual: headerToolPrefs.visual,
      })}
      {headerToolPrefs.capabilities && renderCapabilityBadges()}
      {headerToolPrefs.collaboration && renderCollaborationQuickControl()}
      {headerToolPrefs.status && runPhase !== 'idle' && (
        <span className={`badge ${phaseBadgeClass(runPhase)}`}>{phaseLabel(runPhase)}</span>
      )}
      {renderHeaderDisplayControl()}
    </>
  );

  const headerTitle = activeSession ? getChatSessionDisplayTitle(activeSession) : '新对话';

  return (
    <div className="conversation-shell">
      <div
        className={`conversation-list-overlay ${mobileListOpen ? 'open' : ''}`}
        onClick={() => setMobileListOpen(false)}
      />
      {/* 左侧：历史对话列表 */}
      <div className={`conversation-sidebar ${mobileListOpen ? 'open' : ''}`}>
        {/* Agent 选择 + 新对话 */}
        <div className="conversation-sidebar-top">
          <button
            type="button"
            className="conversation-new-chat-btn"
            onClick={handleNew}
            disabled={!selectedAgentId}
          >
            <span className="conversation-new-chat-icon" aria-hidden="true">+</span>
            新对话
          </button>
          <div className="conversation-agent-picker">
            <select
              value={selectedAgentId}
              onChange={e => handleAgentChange(e.target.value)}
            >
              {templates.length === 0 && <option value="">暂无 Agent</option>}
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>

        {/* 会话搜索 */}
        {selectedAgentSessions.length > 5 && (
          <div className="conversation-session-search">
            <input
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
              placeholder="搜索会话..."
            />
          </div>
        )}

        {/* 会话列表 */}
        <div ref={sidebarRef} className="conversation-session-list">
          {visibleSessions
            .map(s => (
              <div
                key={s.id}
                ref={activeSessionId === s.id ? activeItemRef : undefined}
                onClick={() => { void handleSelect(s); }}
                className={`conversation-session-item${activeSessionId === s.id ? ' active' : ''}${s.pinned ? ' pinned' : ''}`}
              >
                {/* 标题行 */}
                <div className="conversation-session-title-row">
                  {editingId === s.id ? (
                    <input
                      autoFocus
                      className="conversation-session-title-input"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void handleRename(s.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => { void handleRename(s.id); }}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <div
                      className="conversation-session-title"
                      onDoubleClick={e => { e.stopPropagation(); startRename(s); }}
                      title={`${getChatSessionDisplayTitle(s)} · 双击编辑标题`}
                    >
                      {getChatSessionDisplayTitle(s)}
                    </div>
                  )}
                  {sessionRunUi[s.id]?.isStreaming && (
                    <span
                      className={`badge ${phaseBadgeClass(sessionRunUi[s.id].phase)}`}
                      style={{ marginLeft: 6, fontSize: '.68em', whiteSpace: 'nowrap' }}
                    >
                      {phaseLabel(sessionRunUi[s.id].phase)}
                    </span>
                  )}
                  <span className="conversation-session-actions">
                    <button
                      type="button"
                      className={`conversation-session-action${s.pinned ? ' is-pinned' : ''}`}
                      onClick={e => { void handlePin(s.id, e); }}
                      title={s.pinned ? '取消置顶' : '置顶'}
                      aria-label={s.pinned ? '取消置顶' : '置顶'}
                    >
                      <LineIcon name="pin" />
                    </button>
                    <button
                      type="button"
                      className="conversation-session-action"
                      title="复制当前历史为一个新对话，并立即切换过去"
                      aria-label="复制会话"
                      onClick={e => { void handleCopySession(s, e); }}
                    >
                      <LineIcon name="copy" />
                    </button>
                    <button
                      type="button"
                      className="conversation-session-action danger"
                      title="删除会话"
                      aria-label="删除会话"
                      onClick={e => { e.stopPropagation(); void handleDelete(s.id); }}
                    >
                      <LineIcon name="trash" />
                    </button>
                  </span>
                </div>
                <div className="conversation-session-meta">
                  <span className="conversation-session-agent">{templates.find(t => t.id === s.templateId)?.name || 'Agent'}</span>
                  <span>
                    {s.collaborationEnabled && <span title={s.collaborationRole === 'member' ? '我加入的协作会话' : '我开启的协作会话'}>协作 · </span>}
                    {s.messageCount ?? s.messages.length}条
                  </span>
                  <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
                </div>
                {s.forkedFromTitle && (
                  <div className="conversation-session-fork">
                    来自：{s.forkedFromTitle}
                  </div>
                )}
              </div>
            ))}
          {sessionsLoading && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--ink-muted)', fontSize: '.82em' }}>
              正在读取历史对话...
            </div>
          )}
          {!sessionsLoading && sessionsError && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--danger)', fontSize: '.82em' }}>
              历史对话加载失败
              <div style={{ color: 'var(--ink-muted)', marginTop: 4 }}>{sessionsError}</div>
            </div>
          )}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--ink-muted)', fontSize: '.82em' }}>
              {templates.length === 0 ? '请先创建 Agent' : '选择 Agent 开始对话'}
            </div>
          )}
        </div>
        <div className="conversation-sidebar-account">
          <button
            type="button"
            className="conversation-sidebar-account-button"
            onClick={handleOpenMobileNavigation}
            aria-label="打开主导航"
            title="打开主导航"
          >
            <span className="conversation-sidebar-account-avatar" aria-hidden="true">
              {userInitial(user?.username || user?.name || user?.email)}
            </span>
          </button>
        </div>
      </div>

      {/* 右侧：对话区域 */}
      <div className="conversation-main">
        {!selectedAgentId ? (
          <div className="conversation-hero-wrap">
            <div className="conversation-hero">
              <div className="conversation-hero-title">
                {templates.length === 0 ? '先创建一个 Agent' : '选择一个 Agent 开始'}
              </div>
              <div className="conversation-hero-subtitle">
                {templates.length === 0 ? (
                  <>去 <a href="/agents" style={{ color: 'var(--accent)' }}>Agent 市场</a> 创建你的第一个 Agent</>
                ) : '从左侧列表选择一个 Agent，开始新的对话'}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 对话头部 */}
            <div className="conversation-header">
              <button
                type="button"
                className="icon-btn conversation-list-toggle"
                onClick={() => setMobileListOpen(true)}
                aria-label="打开会话列表"
                title="历史对话"
              >
                <LineIcon name="chat" />
              </button>
              <div className="conversation-title">
                <span className="conversation-title-icon" aria-hidden="true">
                  <LineIcon name="chat" />
                </span>
                <span className="conversation-title-text">
                  <span className="conversation-title-name" title={headerTitle}>
                    {headerTitle}
                  </span>
                  <span className="conversation-title-meta">
                    {currentAgent?.name || 'Agent'} · {messages.length} 条
                  </span>
                </span>
              </div>
              <div className="conversation-header-tools">
                {renderHeaderTools()}
              </div>
              <button
                type="button"
                className={`icon-btn conversation-mobile-more${mobileMoreOpen ? ' open' : ''}`}
                onClick={() => setMobileMoreOpen(open => !open)}
                aria-label={mobileMoreOpen ? '关闭更多设置' : '打开更多设置'}
                aria-expanded={mobileMoreOpen}
                aria-controls="conversation-mobile-panel"
                title={mobileMoreOpen ? '关闭更多' : '更多'}
              >
                <LineIcon name={mobileMoreOpen ? 'x' : 'gear'} />
              </button>
            </div>
            <div
              id="conversation-mobile-panel"
              className={`conversation-mobile-panel${mobileMoreOpen ? ' open' : ''}`}
            >
              <div className="conversation-mobile-section">
                <div className="conversation-mobile-section-title">上下文与视觉</div>
                <div className="conversation-mobile-control-row">
                  {renderAgentControls({ showModel: false })}
                </div>
              </div>
              <div className="conversation-mobile-section">
                <div className="conversation-mobile-section-title">运行状态</div>
                <div className="conversation-mobile-control-row">
                  {renderStatusBadges()}
                  {renderEventSourceControl()}
                  {renderCollaborationControls()}
                </div>
              </div>
            </div>

            {/* 消息列表 */}
            <div className={`conversation-body${isWelcomeState ? ' is-welcome' : ''}`}>
            <div className="conversation-messages" ref={messagesRef} onScroll={updateScrollBottomVisibility}>
              {/* Bot 实时事件 */}
              {activeSessionId && (
                <details style={{ fontSize: '.78em' }}>
                  <summary style={{ color: botEvents.length > 0 ? 'var(--success)' : 'var(--ink-muted)', cursor: 'pointer' }}>📡 实时事件 ({botEvents.length})</summary>
                  <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
                    {botEvents.length === 0 && <div style={{ color: 'var(--ink-muted)', padding: 4 }}>等待 Minecraft 事件...</div>}
                    {botEvents.slice(-20).reverse().map((ev, i) => (
                      <div key={i} className="chat-msg thinking" style={{ marginBottom: 4, padding: '4px 10px' }}>
                        <span className="badge badge-muted">{ev.source}</span>{' '}
                        {ev.type === 'chat' ? <><b>{ev.username}</b>: {ev.message}</>
                        : ev.type === 'playerJoin' ? <>{ev.username} 加入了</>
                        : ev.type === 'playerLeave' ? <>{ev.username} 离开了</>
                        : ev.type === 'health' ? <>血量 {ev.health}</>
                        : <>{ev.type}</>}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {isSessionDetailLoading && !isStreaming && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-muted)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <WaitingHint label="正在翻历史" />
                    <div style={{ fontSize: '.82em', maxWidth: 300, marginTop: 6 }}>历史列表已可操作，完整消息会话加载完成后自动显示。</div>
                  </div>
                </div>
              )}
              {sessionLoadError && !isSessionDetailLoading && !isStreaming && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 700 }}>历史消息读取失败</div>
                    <div style={{ fontSize: '.82em', maxWidth: 320, marginTop: 4, color: 'var(--ink-muted)' }}>{sessionLoadError}</div>
                  </div>
                </div>
              )}
              {isWelcomeState && (
                <div className="conversation-hero">
                  <div className="conversation-hero-title">
                    {currentAgent?.name ? `和 ${currentAgent.name} 聊聊` : '开始新的对话'}
                  </div>
                  {currentAgent?.systemPrompt && (
                    <div className="conversation-hero-subtitle">{currentAgent.systemPrompt.slice(0, 100)}</div>
                  )}
                </div>
              )}
              {messages.map((msg, i) => (
                <ChatMessageBubble
                  key={msg.id || i}
                  message={msg}
                  waitingLabel={msg.status === 'pending' && runPhase !== 'idle' ? phaseLabel(runPhase) : undefined}
                />
              ))}
              {agentTasks.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {agentTasks.map(task => (
                    <div key={task.id} className="chat-msg thinking" style={{ padding: '8px 12px' }}>
                      <div className="flex-between" style={{ gap: 10 }}>
                        <span style={{ fontWeight: 600 }}>{task.subagentType || task.taskType || '子任务'}</span>
                        <span className="badge" style={{ color: taskStatusColor(task.status), background: 'var(--bg-hover)' }}>
                          {taskStatusLabel(task.status)}
                        </span>
                      </div>
                      <div style={{ marginTop: 4 }}>{task.summary || task.description || task.id}</div>
                      {(task.lastToolName || task.usage?.total_tokens) && (
                        <div style={{ marginTop: 4, fontSize: '.78em', color: 'var(--ink-muted)' }}>
                          {task.lastToolName && <span>tool: {task.lastToolName}</span>}
                          {task.usage?.total_tokens && <span>{task.lastToolName ? ' · ' : ''}{task.usage.total_tokens} tokens</span>}
                        </div>
                      )}
                      {task.error && <div style={{ marginTop: 4, color: 'var(--danger)' }}>{task.error}</div>}
                    </div>
                  ))}
                </div>
              )}
              <ContextCompactionEvents events={contextEvents} />
              {structuredOutput !== null && !isStreaming && (
                <div className="chat-msg assistant" style={{ padding: '8px 12px' }}>
                  <div style={{ fontSize: '.72em', fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 6 }}>
                    结构化输出 (outputSchema)
                  </div>
                  <JsonViewer data={structuredOutput} maxHeight={300} />
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            <div className="conversation-prompts">
              <AskUserQuestionPromptList
                pending={pendingQuestions}
                onResolved={(reqId) => {
                  if (!activeSessionId) return;
                  patchSessionRunUi(activeSessionId, current => ({
                    ...current,
                    pendingQuestions: current.pendingQuestions.filter(p => p.reqId !== reqId),
                  }));
                }}
              />
              <PermissionPromptList
                pending={pendingPermissions}
                onResolved={(reqId) => {
                  if (!activeSessionId) return;
                  patchSessionRunUi(activeSessionId, current => ({
                    ...current,
                    pendingPermissions: current.pendingPermissions.filter(p => p.reqId !== reqId),
                  }));
                }}
              />
            </div>

            {/* 输入区域 */}
            <div className="conversation-composer">
              <div className="chat-input-area conversation-composer-shell">
                {(attachments.length > 0 || attachmentError || attachmentUploadStatus) && (
                  <div className="composer-attachments">
                    {attachmentError && <div className="composer-attachment-error">{attachmentError}</div>}
                    {attachmentUploadStatus && (
                      <div className="composer-upload-status" role="status" aria-live="polite">
                        <span className="composer-upload-spinner" aria-hidden="true" />
                        <span>{formatChatAttachmentUploadStatus(attachmentUploadStatus)}</span>
                      </div>
                    )}
                    {attachments.length > 0 && (
                      <div className="composer-attachment-list">
                        {attachments.map(item => (
                          <div key={item.id} className="composer-attachment-item">
                            {item.type === 'image' ? (
                              <img className="composer-attachment-image" src={getChatImageSrc(item)} alt={item.name} />
                            ) : (
                              <div
                                className="badge badge-info composer-attachment-file"
                                title={`${item.name} · ${formatAttachmentBytes(item.size)}`}
                              >
                                {item.name} · {formatAttachmentBytes(item.size)}
                              </div>
                            )}
                            <button
                              type="button"
                              className="composer-attachment-remove"
                              onClick={() => setAttachments(prev => prev.filter(a => a.id !== item.id))}
                              aria-label="移除附件"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={CHAT_ATTACHMENT_ACCEPT}
                  onChange={e => void handleFilePicked(e.currentTarget.files)}
                  disabled={isStreaming || isAttachmentUploading || isSessionDetailLoading}
                  style={{ display: 'none' }}
                />
                {messages.length > 0 && showScrollBottom && (
                  <div className="composer-scroll-bottom-row">
                    <button
                      type="button"
                      className="chat-scroll-bottom is-visible"
                      onClick={scrollToBottom}
                      aria-label="回到底部"
                      title="回到底部"
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                  </div>
                )}
                <div className="conversation-composer-input-row composer-suggestion-field">
                  {nextSuggestion.suggestionText && !input.trim() && (
                    <button
                      type="button"
                      className="composer-ghost-suggestion"
                      onClick={handleApplySuggestion}
                      disabled={isStreaming || isSessionDetailLoading}
                      aria-label={`应用推荐回复：${nextSuggestion.suggestionText}`}
                      title="应用推荐回复"
                    >
                      <span className="composer-suggestion-text">{nextSuggestion.suggestionText}</span>
                      <kbd className="composer-suggestion-key-hint">Tab 应用</kbd>
                      <span className="composer-suggestion-touch-hint" aria-hidden="true">点击应用</span>
                    </button>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="conversation-composer-input"
                    value={input}
                    onChange={e => {
                      if (!e.target.value.trim()) nextSuggestion.abandonAcceptedSuggestion();
                      setInput(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
                    }}
                    onKeyDown={e => {
                      const isComposing = isInputComposingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
                      if (e.key === 'Tab' && !e.shiftKey && !isComposing && nextSuggestion.suggestionText && !input.trim()) {
                        e.preventDefault();
                        handleApplySuggestion();
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    onCompositionStart={() => { isInputComposingRef.current = true; }}
                    onCompositionEnd={() => { isInputComposingRef.current = false; }}
                    onPaste={handlePaste}
                    placeholder={nextSuggestion.suggestionText ? '' : '输入消息，Enter 发送，Shift+Enter 换行'}
                    disabled={isStreaming || isSessionDetailLoading}
                  />
                </div>
                <div className="conversation-composer-toolbar">
                  <div className="composer-toolbar-left">
                    <button
                      type="button"
                      className="composer-icon-btn"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isStreaming || isAttachmentUploading || isSessionDetailLoading}
                      title={isAttachmentUploading ? '附件上传中' : '上传文件'}
                      aria-label={isAttachmentUploading ? '附件上传中' : '上传文件'}
                    >
                      +
                    </button>
                  </div>
                  <div className="composer-toolbar-right">
                    {currentAgent && (
                      <div className="composer-model-picker">
                        <ChatModelPicker
                          value={effectiveModel}
                          templateModel={currentAgent.model}
                          models={modelOptions}
                          disabled={isStreaming}
                          onChange={model => setSelectedModelOverride({ contextKey: modelContextKey, model })}
                        />
                      </div>
                    )}
                    {isStreaming ? (
                      <button
                        type="button"
                        className="composer-send-btn is-stop"
                        onClick={handleStop}
                        title={isWaitingPhase(runPhase) ? '停止等待' : '停止'}
                        aria-label={isWaitingPhase(runPhase) ? '停止等待' : '停止'}
                      >
                        <span aria-hidden="true">■</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="composer-send-btn"
                        onClick={handleSend}
                        disabled={isAttachmentUploading || isSessionDetailLoading || (!input.trim() && attachments.length === 0)}
                        title="发送"
                        aria-label="发送"
                      >
                        <span aria-hidden="true">↑</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
