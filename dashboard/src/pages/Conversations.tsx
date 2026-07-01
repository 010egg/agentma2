import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ClipboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ChatSession, AgentTemplate, ChatMessage, ChatRunStats, ProviderConfig, ChatAttachment, ChatImageMimeType } from '../simulator/types';
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
import JsonViewer from '../components/common/JsonViewer';
import ChatMessageBubble from '../components/ChatMessageBubble';
import WaitingHint from '../components/WaitingHint';
import ChatModelPicker from '../components/ChatModelPicker';
import ModelPicker from '../components/common/ModelPicker';
import ContextWindowMeter from '../components/ContextWindowMeter';
import ContextCompactionEvents from '../components/ContextCompactionEvents';
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
  CHAT_FILE_ACCEPT,
  CHAT_FILE_MAX_COUNT,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  CHAT_IMAGE_MIME_TYPES,
  fileToChatAttachment,
  formatAttachmentBytes,
  getChatImageSrc,
  uniqueChatImageFiles,
} from '../utils/chat-attachments-ui';
import {
  bootstrapChatSessions,
  createChatSessionTitle,
  deleteChatSession as deleteChatSessionApi,
  forkChatSession as forkChatSessionApi,
  getChatSession,
  getChatSessionDisplayTitle,
  joinChatSession as joinChatSessionApi,
  patchChatSession,
  saveChatSession as saveChatSessionApi,
  setChatSessionCollaboration,
  subscribeChatSessionEvents,
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
    const data = JSON.parse(text) as { error?: unknown };
    return data?.error ? String(data.error) : `API 错误: ${response.status}`;
  } catch {
    return text.slice(0, 240) || `API 错误: ${response.status}`;
  }
}

function formatShortId(value?: string | null) {
  return value ? value.slice(0, 5) : '-';
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

export default function Conversations() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAgentId = searchParams.get('agent') || '';
  const joinSessionId = searchParams.get('join') || '';
  const requestedConversationId = searchParams.get('conversationId') || '';
  const requestedSessionId = searchParams.get('sdkSessionId') || searchParams.get('sessionId') || '';
  const requestedDraft = searchParams.get('draft') || '';
  const { user } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
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

  // 聊天状态
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionRunUi, setSessionRunUi] = useState<Record<string, SessionRunUiState>>({});
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionLoadSeqRef = useRef(0);
  const isInputComposingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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
    setSessions(prev => {
      const exists = prev.some((item) => item.id === session.id);
      if (!exists) return [session, ...prev];
      return prev.map((item) => item.id === session.id ? session : item);
    });
  }, []);

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
        setSessions(prev => prev.filter(item => item.id !== session.id));
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
  }, [syncConversationUrl, templates, upsertSession]);

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
      setSessionsLoading(true);
      setSessionsError('');
      try {
        const savedSessions = await bootstrapChatSessions(!isUsingApiKeyAuth());
        if (!cancelled) setSessions(savedSessions);
      } catch (error) {
        console.error('failed to load chat sessions', error);
        if (!cancelled) setSessionsError((error as Error).message || '历史对话加载失败');
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user?.tenantId, user?.role]);

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
    setSessions(prev => {
      const existingSession = prev.find((session) => session.id === id);
      if (existingSession) {
        return prev.map((session) => session.id === id ? { ...draft, createdAt: existingSession.createdAt } : session);
      }
      return [draft, ...prev];
    });

    try {
      const saved = await saveChatSessionApi(draft);
      setSessions(prev => {
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
  }, [selectedAgentId, currentAgent, sessions, syncConversationUrl, selectedModel, visualPreprocessEnabled, visualPreprocessModel]);

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
      setSessions(prev => prev.filter(session => session.id !== sessionId));
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
  }, [activeSessionId, upsertSession, syncConversationUrl]);

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
    isStreaming,
    messages,
    patchSessionRunUi,
    pendingRunMessage?.content,
    pendingRunMessage?.id,
    pendingRunMessage?.runId,
    pendingRunMessage?.thinking,
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
        setSessions(prev => prev.filter(session => session.id !== activeSession.id));
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
  }, [activeSession?.id, activeSession?.collaborationEnabled, refreshSession]);

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
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title: nextTitle } : s));
    setEditingId(null);
    try {
      const saved = await patchChatSession(id, { title: nextTitle });
      setSessions(prev => prev.map(s => s.id === id ? saved : s));
    } catch (error) {
      console.error('failed to rename chat session', error);
    }
  };

  // 置顶
  const handlePin = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const current = sessions.find((session) => session.id === id);
    const nextPinned = !current?.pinned;
    setSessions(prev => prev.map(s => s.id === id ? { ...s, pinned: nextPinned } : s));
    try {
      const saved = await patchChatSession(id, { pinned: nextPinned });
      setSessions(prev => prev.map(s => s.id === id ? saved : s));
    } catch (error) {
      console.error('failed to pin chat session', error);
    }
  };

  const handleCopySession = async (source: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const copied = await forkChatSessionApi(source.id);
      setSessions(prev => [copied, ...prev.filter(s => s.id !== copied.id)]);
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
    setSessions(updated);
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
      setSessions(sessions);
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
    event.preventDefault();
    setAttachmentError('');

    const imageCount = attachments.filter((item) => item.type === 'image').length;
    const remainingSlots = CHAT_IMAGE_MAX_COUNT - imageCount;
    if (remainingSlots <= 0) {
      setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
      return;
    }

    const accepted: File[] = [];
    for (const file of files) {
      if (!CHAT_IMAGE_MIME_TYPES.has(file.type as ChatImageMimeType)) {
        setAttachmentError('不支持这种图片格式；普通文件请用 + 上传');
        continue;
      }
      if (file.size > CHAT_IMAGE_MAX_BYTES) {
        setAttachmentError('单张图片不能超过 5MB');
        continue;
      }
      if (accepted.length < remainingSlots) accepted.push(file);
    }

    if (files.length > remainingSlots) {
      setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
    }
    if (!accepted.length) return;

    try {
      const nextAttachments = await Promise.all(accepted.map(fileToChatAttachment));
      setAttachments(prev => [...prev, ...nextAttachments]);
    } catch (error) {
      setAttachmentError((error as Error).message || '图片读取失败');
    }
  }, [attachments]);

  const handleFilePicked = useCallback(async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!files.length) return;
    setAttachmentError('');

    const currentFileCount = attachments.filter((item) => item.type === 'file').length;
    const remainingFiles = CHAT_FILE_MAX_COUNT - currentFileCount;
    if (remainingFiles <= 0) {
      setAttachmentError(`最多一次发送 ${CHAT_FILE_MAX_COUNT} 个文件`);
      return;
    }

    const accepted = files.slice(0, remainingFiles);
    if (files.length > remainingFiles) setAttachmentError(`最多一次发送 ${CHAT_FILE_MAX_COUNT} 个文件`);
    try {
      const formData = new FormData();
      for (const file of accepted) formData.append('files', file, file.name);
      const response = await fetch('/api/chat/files/upload', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      });
      const data = await response.json().catch(() => ({})) as { attachments?: ChatAttachment[]; error?: string };
      if (!response.ok) throw new Error(data.error || `上传失败: ${response.status}`);
      const nextAttachments = Array.isArray(data.attachments) ? data.attachments : [];
      setAttachments(prev => [...prev, ...nextAttachments]);
    } catch (error) {
      setAttachmentError((error as Error).message || '文件读取失败');
    }
  }, [attachments]);

  // 发送消息
  const handleSend = useCallback(async () => {
    const content = input.trim();
    const messageAttachments = attachments;
    if ((!content && messageAttachments.length === 0) || isStreaming || isSessionDetailLoading || !currentAgent) return;

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
    setSessionMessages,
    updateSessionRunPhase,
  ]);

  const handleStop = useCallback(() => {
    if (!activeSessionId) return;
    runAbortControllersRef.current.get(activeSessionId)?.abort();
  }, [activeSessionId]);

  return (
    <div className="conversation-shell">
      <div
        className={`conversation-list-overlay ${mobileListOpen ? 'open' : ''}`}
        onClick={() => setMobileListOpen(false)}
      />
      {/* 左侧：历史对话列表 */}
      <div className={`conversation-sidebar ${mobileListOpen ? 'open' : ''}`}>
        {/* Agent 选择 + 新对话 */}
        <div style={{ padding: '14px 14px 8px', borderBottom: '1px solid var(--border)' }}>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <select
              value={selectedAgentId}
              onChange={e => handleAgentChange(e.target.value)}
              style={{ fontSize: '.82em' }}
            >
              {templates.length === 0 && <option value="">暂无 Agent</option>}
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleNew}
            disabled={!selectedAgentId}
            style={{ width: '100%' }}
          >
            + 新对话
          </button>
        </div>

        {/* 会话搜索 */}
        {selectedAgentSessions.length > 5 && (
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
            <input
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
              placeholder="搜索会话..."
              style={{ width: '100%', fontSize: '.78em', padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--ink)' }}
            />
          </div>
        )}

        {/* 会话列表 */}
        <div ref={sidebarRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {visibleSessions
            .map(s => (
              <div
                key={s.id}
                ref={activeSessionId === s.id ? activeItemRef : undefined}
                onClick={() => { void handleSelect(s); }}
                style={{
                  padding: '10px 12px', borderRadius: 6, cursor: 'pointer',
                  marginBottom: 4, transition: 'all .1s',
                  background: activeSessionId === s.id ? 'var(--accent-bg)' : s.pinned ? 'var(--warning-bg)' : 'transparent',
                }}
                onMouseEnter={e => { if (activeSessionId !== s.id && !s.pinned) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (activeSessionId !== s.id && !s.pinned) e.currentTarget.style.background = 'transparent'; }}
              >
                {/* 标题行 */}
                <div className="flex-between" style={{ marginBottom: 3 }}>
                  {editingId === s.id ? (
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void handleRename(s.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => { void handleRename(s.id); }}
                      onClick={e => e.stopPropagation()}
                      style={{ fontSize: '.82em', padding: '3px 6px', flex: 1 }}
                    />
                  ) : (
                    <div
                      style={{ fontSize: '.84em', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
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
                  <span
                    onClick={e => { void handlePin(s.id, e); }}
                    style={{ cursor: 'pointer', fontSize: '.85em', opacity: s.pinned ? 1 : .3, marginLeft: 4 }}
                    title={s.pinned ? '取消置顶' : '置顶'}
                  >📌</span>
                </div>
                <div className="flex-between" style={{ fontSize: '.72em', color: 'var(--ink-muted)' }}>
                  <span>{templates.find(t => t.id === s.templateId)?.name || 'Agent'}</span>
                  <span style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>
                    {s.collaborationEnabled && <span title={s.collaborationRole === 'member' ? '我加入的协作会话' : '我开启的协作会话'}>协作 · </span>}
                    {s.messageCount ?? s.messages.length} 条
                  </span>
                </div>
                {s.forkedFromTitle && (
                  <div style={{ fontSize: '.68em', color: 'var(--ink-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    来自：{s.forkedFromTitle}
                  </div>
                )}
                <div className="flex-between" style={{ fontSize: '.68em', color: 'var(--ink-muted)', marginTop: 2 }}>
                  <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
                  <span className="flex gap-2">
                    <button
                      className="btn btn-sm"
                      style={{ padding: '0 6px', fontSize: '.85em' }}
                      title="复制当前历史为一个新对话，并立即切换过去"
                      onClick={e => { void handleCopySession(s, e); }}
                    >复制</button>
                    <button
                      className="btn btn-sm"
                      style={{ padding: '0 6px', fontSize: '.85em', color: 'var(--danger)' }}
                      onClick={e => { e.stopPropagation(); void handleDelete(s.id); }}
                    >删除</button>
                  </span>
                </div>
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
      </div>

      {/* 右侧：对话区域 */}
      <div className="conversation-main">
        {!selectedAgentId ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-muted)' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2em', marginBottom: 8 }}>💬</div>
              <div>{templates.length === 0 ? (
                <>请先去 <a href="/agents" style={{ color: 'var(--accent)' }}>Agent 市场</a> 创建 Agent</>
              ) : '请选择一个 Agent 开始对话'}</div>
            </div>
          </div>
        ) : (
          <>
            {/* 对话头部 */}
            <div className="conversation-header">
              <button
                className="btn btn-sm conversation-list-toggle"
                onClick={() => setMobileListOpen(true)}
                aria-label="打开会话列表"
              >
                历史
              </button>
              <div style={{ fontWeight: 700, fontSize: '.95em' }}>{currentAgent?.name}</div>
              <div className="flex gap-2" style={{ flexWrap: 'wrap', flex: 1 }}>
                <span
                  className="conversation-id-badge"
                  title={activeSession?.id ? `对话id: ${activeSession.id}` : '对话id 暂无'}
                >
                  对话id {formatShortId(activeSession?.id)}
                </span>
                <span
                  className="conversation-id-badge"
                  title={activeSession?.sdkSessionId ? `会话id: ${activeSession.sdkSessionId}` : '会话id 暂无'}
                >
                  会话id {formatShortId(activeSession?.sdkSessionId)}
                </span>
                {currentAgent && (
                  <>
                  <ChatModelPicker
                    value={effectiveModel}
                    templateModel={currentAgent.model}
                    models={modelOptions}
                    disabled={isStreaming}
                    onChange={model => setSelectedModelOverride({ contextKey: modelContextKey, model })}
                  />
                  <ContextWindowMeter
                    model={effectiveModel}
                    inputTokens={observedRunStats?.inTok}
                    outputTokens={observedRunStats?.outTok}
                    compacted={contextEvents.length > 0}
                  />
                  <label
                    className="badge badge-muted"
                    title="开启后图片先由视觉模型预处理，再交给当前 Agent"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: isStreaming ? 'not-allowed' : 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={visualPreprocessEnabled}
                      disabled={isStreaming}
                      onChange={event => {
                        const enabled = event.target.checked;
                        setVisualPreprocessEnabled(enabled);
                        if (enabled && !visualPreprocessModel) setVisualPreprocessModel(defaultVisualPreprocessModel(currentAgent));
                      }}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    视觉预处理
                  </label>
                  {visualPreprocessEnabled && (
                    <div style={{ width: 220, maxWidth: '100%' }}>
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
                {runPhase !== 'idle' && (
                  <span className={`badge ${phaseBadgeClass(runPhase)}`}>{phaseLabel(runPhase)}</span>
                )}
                {((currentAgent?.knowledgeSourceIds || []).length > 0 || currentAgent?.useKnowledge) && (
                  <span className="badge badge-success">知识库×{(currentAgent?.knowledgeSourceIds || []).length || '全部'}</span>
                )}
                {(() => {
                  const tools = currentAgent?.tools || [];
                  const customs = initCustomTools();
                  const serverNames = Array.from(new Set(
                    tools
                      .filter(t => customs.find(c => c.name === t)?.mcpServer)
                      .map(t => customs.find(c => c.name === t)!.mcpServer!)
                  ));
                  return (
                    <>
                      {serverNames.length > 0 ? (
                        <span className="badge" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
                          MCP ×{serverNames.length}
                        </span>
                      ) : (
                        <span className="badge badge-muted">MCP ×0</span>
                      )}
                      {serverNames.map(s => {
                        const serverTools = customs.filter(c => c.mcpServer === s && tools.includes(c.name));
                        const firstEndpoint = serverTools.find(t => t.endpoint)?.endpoint;
                        return (
                          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span className="badge badge-muted" style={{ fontFamily: 'var(--font-mono)', fontSize: '.7em' }}>
                              {s} ({serverTools.length}工具)
                            </span>
                            {firstEndpoint && <McpStatusDot server={s} endpoint={firstEndpoint.url} />}
                          </span>
                        );
                      })}
                      {tools.length === 0 && <span className="badge badge-muted">无工具</span>}
                    </>
                  );
                })()}
                {/* 事件源开关（会话级） */}
                {eventSources.length > 0 && (
                  <span style={{ position: 'relative' }}>
                    <span className="badge" style={{ cursor: 'pointer', background: subbedSources.length > 0 ? 'var(--success-bg)' : 'var(--bg-hover)', color: subbedSources.length > 0 ? 'var(--success)' : 'var(--ink-muted)', userSelect: 'none' }}
                      onClick={() => setShowEventToggles(!showEventToggles)}>
                      📡 {subbedSources.length > 0 ? subbedSources.length : '0'}
                    </span>
                    {showEventToggles && (
                      <div className="fade-in" style={{ position: 'absolute', top: 24, left: 0, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', zIndex: 20, minWidth: 160, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}>
                        {eventSources.map(es => (
                          <label key={es.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: '.8em', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            <input type="checkbox" checked={subbedSources.includes(es.name)} onChange={() => {
                              const next = subbedSources.includes(es.name) ? subbedSources.filter(s => s !== es.name) : [...subbedSources, es.name];
                              setSubbedSources(next);
                              localStorage.setItem(`session_subs_${activeSessionId}`, JSON.stringify(next));
                              fetch(`/api/sessions/${activeSessionId}/events/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceName: es.name }) }).catch(() => {});
                            }} style={{ width: 'auto', margin: 0 }} />
                            📡 {es.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </span>
                )}
                {activeSession && (
                  <span className="flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
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
                      <span style={{ color: 'var(--danger)', fontSize: '.76em' }}>{collaborationError}</span>
                    )}
                  </span>
                )}
              </div>
              <button className="btn btn-sm" onClick={() => navigate('/agents')}>Agent 市场</button>
            </div>

            {/* 消息列表 */}
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
              {messages.length === 0 && !isSessionDetailLoading && !sessionLoadError && !isStreaming && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-muted)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2em' }}>🤖</div>
                    <div style={{ fontWeight: 600 }}>{currentAgent?.name}</div>
                    <div style={{ fontSize: '.82em', maxWidth: 300 }}>
                      {currentAgent?.systemPrompt?.slice(0, 80) || '发送消息开始对话'}
                    </div>
                  </div>
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
              {observedRunStats && !isStreaming && (
                <div style={{ textAlign: 'right', fontSize: '.72em', color: 'var(--ink-muted)', padding: '2px 4px' }}>
                  {observedRunStats.durationMs != null && <span>{(observedRunStats.durationMs / 1000).toFixed(1)}s</span>}
                  {observedRunStats.inTok != null && <span style={{ marginLeft: 8 }}>{observedRunStats.inTok}↑ {observedRunStats.outTok ?? 0}↓ tok</span>}
                  {observedRunStats.costUsd != null && <span style={{ marginLeft: 8 }}>${observedRunStats.costUsd.toFixed(4)}</span>}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                className={`chat-scroll-bottom${showScrollBottom ? ' is-visible' : ''}`}
                onClick={scrollToBottom}
                aria-label="回到底部"
                title="回到底部"
              >
                <span aria-hidden="true">↓</span>
              </button>
            )}

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
              <div className="chat-input-area" style={{ padding: 0, borderTop: 'none' }}>
                {(attachments.length > 0 || attachmentError) && (
                  <div style={{ padding: '4px 8px' }}>
                    {attachmentError && <div style={{ color: 'var(--danger)', fontSize: '.75em', marginBottom: 4 }}>{attachmentError}</div>}
                    {attachments.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {attachments.map(item => (
                          <div key={item.id} style={{ position: 'relative' }}>
                            {item.type === 'image' ? (
                              <img src={getChatImageSrc(item)} alt={item.name}
                                style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />
                            ) : (
                              <div
                                className="badge badge-info"
                                title={`${item.name} · ${formatAttachmentBytes(item.size)}`}
                                style={{ maxWidth: 220, height: 28, display: 'flex', alignItems: 'center', paddingRight: 22, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              >
                                {item.name} · {formatAttachmentBytes(item.size)}
                              </div>
                            )}
                            <button onClick={() => setAttachments(prev => prev.filter(a => a.id !== item.id))}
                              style={{ position: 'absolute', top: -4, right: -4, width: 16, height: 16, borderRadius: '50%', background: 'var(--danger)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 10, lineHeight: '16px', padding: 0 }}>
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
                  accept={CHAT_FILE_ACCEPT}
                  onChange={e => void handleFilePicked(e.currentTarget.files)}
                  style={{ display: 'none' }}
                />
                <button
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming || isSessionDetailLoading}
                  title="上传文件"
                  aria-label="上传文件"
                  style={{ width: 34, height: 34, minWidth: 34, padding: 0, borderRadius: 6, fontSize: 20, lineHeight: '30px' }}
                >
                  +
                </button>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; }}
                  onKeyDown={e => {
                    const isComposing = isInputComposingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
                    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  onCompositionStart={() => { isInputComposingRef.current = true; }}
                  onCompositionEnd={() => { isInputComposingRef.current = false; }}
                  onPaste={handlePaste}
                  placeholder="输入消息，Enter 发送，Shift+Enter 换行，可粘贴图片，也可上传文件"
                  style={{ resize: 'none', overflowY: 'hidden', minHeight: 38, maxHeight: 200 }}
                  disabled={isStreaming || isSessionDetailLoading}
                />
                {isStreaming ? (
                  <button className="btn btn-danger" onClick={handleStop}>
                    {isWaitingPhase(runPhase) ? '停止等待' : '停止'}
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={handleSend} disabled={isSessionDetailLoading || (!input.trim() && attachments.length === 0)}>
                    发送
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
