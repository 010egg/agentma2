import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ClipboardEvent } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import type { AgentTemplate, ChatAttachment, ChatMessage, ChatRunStats, ChatSession, ProviderConfig } from '../simulator/types';
import { useAuth } from '../contexts/AuthContext';
import { bootstrapAgentTemplates, getCachedAgentTemplateById } from '../utils/agent-templates';
import { isUsingApiKeyAuth, getAuthHeaders } from '../utils/client-runtime';
import { PermissionPromptList, type PermissionRequest } from '../components/PermissionPrompt';
import { AskUserQuestionPromptList, type AskUserQuestionRequest } from '../components/AskUserQuestionPrompt';
import {
  bootstrapChatSessions,
  createChatSessionTitle,
  getChatSession,
  saveChatSession as saveChatSessionApi,
  setChatSessionCollaboration,
  subscribeChatSessionEvents,
} from '../utils/chat-sessions';
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
  type RunPhase,
  type RunOutcome,
} from '../simulator/run-state';
import {
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_FILE_MAX_COUNT,
  CHAT_IMAGE_MAX_COUNT,
  formatAttachmentBytes,
  getChatImageSrc,
  splitChatUploadFiles,
  uniqueChatImageFiles,
  uploadChatImages,
} from '../utils/chat-attachments-ui';

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

function canResumeChatSession(session: ChatSession | null | undefined) {
  return Boolean(session?.sdkSessionId);
}

function defaultVisualPreprocessEnabled(template: AgentTemplate | null | undefined) {
  return template?.visualPreprocessDefault === true;
}

function defaultVisualPreprocessModel(template: AgentTemplate | null | undefined) {
  return template?.visualPreprocessModel || '';
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

export default function AgentChat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const resumeSessionId = searchParams.get('session');
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [runPhase, setRunPhase] = useState<RunPhase>('idle');
  const [sessionId, setSessionId] = useState<string>('');
  const [sessionMeta, setSessionMeta] = useState<ChatSession | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<AskUserQuestionRequest[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTaskEvent[]>([]);
  const [contextEvents, setContextEvents] = useState<ContextCompactionEvent[]>([]);
  const [structuredOutput, setStructuredOutput] = useState<unknown>(null);
  const [runStats, setRunStats] = useState<ChatRunStats | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [collaborationError, setCollaborationError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>(() => listProviderModels());
  const [selectedModelOverride, setSelectedModelOverride] = useState<{ contextKey: string; model: string } | null>(null);
  const [visualPreprocessEnabled, setVisualPreprocessEnabled] = useState(false);
  const [visualPreprocessModel, setVisualPreprocessModel] = useState('');
  const [, setActiveRunId] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isInputComposingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const observingRunIdRef = useRef('');
  const provider = useRef<ProviderConfig>(resolveProviderForModel().provider);
  const modelContextKey = `${id || ''}:${sessionId || resumeSessionId || 'new'}`;
  const selectedModel = selectedModelOverride?.contextKey === modelContextKey ? selectedModelOverride.model : '';
  const effectiveChatModel = selectedModel || sessionMeta?.model || template?.model || '';
  const suggestionModel = user?.inputSuggestionModel?.trim() || '';
  const suggestionProvider = useMemo(() => suggestionModel ? resolveProviderForModel(suggestionModel).provider : undefined, [suggestionModel]);
  const pendingRunMessage = useMemo(() => findPendingRunMessage(messages), [messages]);
  const nextSuggestion = useChatNextSuggestion({
    sessionId,
    templateId: sessionMeta?.templateId || template?.id,
    template,
    model: suggestionModel,
    provider: suggestionProvider,
    messages,
    composerInput: input,
    attachments,
    disabled: isStreaming || pendingPermissions.length > 0 || pendingQuestions.length > 0,
  });
  const focusChatInput = useCallback(() => {
    requestAnimationFrame(() => {
      if (!textareaRef.current || textareaRef.current.disabled) return;
      textareaRef.current.focus();
    });
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
    if (isStreaming || pendingPermissions.length > 0 || pendingQuestions.length > 0) return;
    focusChatInput();
  }, [isStreaming, pendingPermissions.length, pendingQuestions.length, template, focusChatInput]);

  useEffect(() => {
    if (isStreaming || pendingPermissions.length > 0 || pendingQuestions.length > 0) return;
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
  }, [input, isStreaming, pendingPermissions.length, pendingQuestions.length]);

  // 加载模板 + 恢复会话
  useEffect(() => {
    let cancelled = false;
    const tenantId = user?.tenantId;
    if (!id || !tenantId) return;

    const cachedTemplate = getCachedAgentTemplateById(tenantId, id);
    if (cachedTemplate) {
      setTemplate(cachedTemplate);
      provider.current = resolveProviderForModel(cachedTemplate.model).provider;
      if (!resumeSessionId) {
        setVisualPreprocessEnabled(defaultVisualPreprocessEnabled(cachedTemplate));
        setVisualPreprocessModel(defaultVisualPreprocessModel(cachedTemplate));
      }
    }

    (async () => {
      try {
        const templateList = await bootstrapAgentTemplates(tenantId, user.role === 'tenant_admin');
        const serverTemplate = templateList.find((template) => template.id === id) || null;
        if (!serverTemplate) {
          if (!cancelled) navigate('/agents');
          return;
        }
        if (cancelled) return;
        setTemplate(serverTemplate);
        provider.current = resolveProviderForModel(serverTemplate.model).provider;
        const templateVisualEnabled = defaultVisualPreprocessEnabled(serverTemplate);
        const templateVisualModel = defaultVisualPreprocessModel(serverTemplate);

        const sessions = await bootstrapChatSessions(!isUsingApiKeyAuth());
        const existingSession = resumeSessionId
          ? sessions.find((session) => session.id === resumeSessionId)
          : sessions
              .filter((session) => session.templateId === id && session.messages.length > 0)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0];

        if (cancelled) return;

        if (existingSession) {
          const fullSession = await getChatSession(existingSession.id);
          if (cancelled) return;
          const hydratedSession = fullSession || existingSession;
          setSessionId(hydratedSession.id);
          setSessionMeta(hydratedSession);
          setMessages(hydratedSession.messages);
          setVisualPreprocessEnabled(hydratedSession.visualPreprocessEnabled ?? templateVisualEnabled);
          setVisualPreprocessModel(hydratedSession.visualPreprocessModel || templateVisualModel);
          return;
        }

        setSessionId('');
        setSessionMeta(null);
        setMessages([]);
        setVisualPreprocessEnabled(templateVisualEnabled);
        setVisualPreprocessModel(templateVisualModel);
      } catch (error) {
        console.error('failed to load chat sessions', error);
      }
    })();

    return () => { cancelled = true; };
  }, [id, navigate, resumeSessionId, user?.tenantId, user?.role]);

  const persistSession = useCallback(async (
    nextMessages: ChatMessage[],
    sdkSessionId?: string,
    sdkCwd?: string,
    preferredSessionId?: string,
  ) => {
    if (!template || !id || nextMessages.length === 0) return '';

    const now = Date.now();
    const nextId = sessionId || preferredSessionId || `chat-${id}-${now}`;
    const effectiveModel = selectedModel || sessionMeta?.model || template.model || '';
    const canReuseCurrentSdkSession = canResumeChatSession(sessionMeta);
    const draft: ChatSession = {
      id: nextId,
      templateId: id,
      title: createChatSessionTitle(nextMessages, sessionMeta?.title),
      messages: nextMessages,
      model: effectiveModel,
      sdkSessionId: canReuseCurrentSdkSession ? sessionMeta?.sdkSessionId : sdkSessionId,
      sdkCwd: (canReuseCurrentSdkSession ? sessionMeta?.sdkCwd : undefined) || sdkCwd,
      visualPreprocessEnabled,
      visualPreprocessModel: visualPreprocessModel || undefined,
      forkedFromSessionId: sessionMeta?.forkedFromSessionId,
      forkedFromTitle: sessionMeta?.forkedFromTitle,
      pinned: sessionMeta?.pinned,
      ownerSub: sessionMeta?.ownerSub,
      collaborationEnabled: sessionMeta?.collaborationEnabled,
      collaborationRole: sessionMeta?.collaborationRole,
      collaborationUpdatedAt: sessionMeta?.collaborationUpdatedAt,
      createdAt: sessionMeta?.createdAt || now,
      updatedAt: now,
    };

    setSessionId(nextId);
    setSessionMeta(draft);

    try {
      const saved = await saveChatSessionApi(draft);
      setSessionId(saved.id);
      setSessionMeta(saved);
      return saved.id;
    } catch (error) {
      console.error('failed to persist chat session', error);
      return nextId;
    }
  }, [template, id, sessionId, sessionMeta, selectedModel, visualPreprocessEnabled, visualPreprocessModel]);

  const refreshSession = useCallback(async (targetSessionId: string) => {
    const refreshed = await getChatSession(targetSessionId);
    if (!refreshed) {
      if (sessionId === targetSessionId) {
        setSessionId('');
        setSessionMeta(null);
        setMessages([]);
      }
      return null;
    }
    if (sessionId === targetSessionId) {
      setSessionMeta(refreshed);
      setMessages(refreshed.messages);
      setVisualPreprocessEnabled(refreshed.visualPreprocessEnabled ?? defaultVisualPreprocessEnabled(template));
      setVisualPreprocessModel(refreshed.visualPreprocessModel || defaultVisualPreprocessModel(template));
    }
    return refreshed;
  }, [sessionId, template]);

  useEffect(() => {
    if (!sessionId || !pendingRunMessage?.id || !pendingRunMessage.runId) {
      observingRunIdRef.current = '';
      return;
    }
    if (isStreaming || abortRef.current) return;
    if (observingRunIdRef.current === pendingRunMessage.runId) return;
    observingRunIdRef.current = pendingRunMessage.runId;
    const controller = new AbortController();
    const baseMessages = messages;
    setPendingPermissions([]);
    setPendingQuestions([]);
    setAgentTasks([]);
    setContextEvents([]);
    setStructuredOutput(null);
    setRunStats(null);
    void observeServerRun({
      runId: pendingRunMessage.runId,
      sessionId,
      baseMessages,
      draftId: pendingRunMessage.id,
      assistantTimestamp: pendingRunMessage.timestamp,
      initialThinking: pendingRunMessage.thinking,
      initialText: pendingRunMessage.content,
      onMessages: setMessages,
      persistFinal: async (nextMessages, sdkSessionId, sdkCwd) => {
        await persistSession(nextMessages, sdkSessionId, sdkCwd, sessionId);
      },
      setIsStreaming,
      setRunPhase,
      setActiveRunId,
      setPendingPermissions,
      setPendingQuestions,
      setAgentTasks,
      setContextEvents,
      setStructuredOutput,
      setRunStats,
      abortRef,
      signal: controller.signal,
    });
    return () => {
      controller.abort();
      observingRunIdRef.current = '';
    };
  }, [sessionId, pendingRunMessage?.id, pendingRunMessage?.runId, persistSession]);

  useEffect(() => {
    if (!sessionId || !sessionMeta?.collaborationEnabled) return;
    return subscribeChatSessionEvents(sessionId, (event) => {
      if (event.type === 'connected') return;
      if (event.type === 'session_deleted') {
        setSessionId('');
        setSessionMeta(null);
        setMessages([]);
        return;
      }
      void refreshSession(sessionId).catch((error) => {
        console.error('failed to refresh collaboration session', error);
      });
    }, (error) => {
      console.error('collaboration stream failed', error);
    });
  }, [sessionId, sessionMeta?.collaborationEnabled, refreshSession]);

  const handleToggleCollaboration = async () => {
    if (!sessionId || sessionMeta?.collaborationRole === 'member') return;
    setCollaborationError('');
    setCopyStatus('');
    try {
      const saved = await setChatSessionCollaboration(sessionId, !sessionMeta?.collaborationEnabled);
      setSessionMeta(saved);
      setMessages(saved.messages);
      setVisualPreprocessEnabled(saved.visualPreprocessEnabled ?? defaultVisualPreprocessEnabled(template));
      setVisualPreprocessModel(saved.visualPreprocessModel || defaultVisualPreprocessModel(template));
    } catch (error) {
      setCollaborationError((error as Error).message || '协作设置失败');
    }
  };

  const handleCopyCollaborationLink = async () => {
    if (!sessionId) return;
    const link = `${window.location.origin}/conversations?join=${encodeURIComponent(sessionId)}`;
    setCollaborationError('');
    try {
      await navigator.clipboard.writeText(link);
      setCopyStatus('已复制');
      setTimeout(() => setCopyStatus(''), 1800);
    } catch {
      window.prompt('复制协作链接', link);
    }
  };

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

  const handleFilePicked = useCallback(async (fileList: FileList | null) => {
    const pickedFiles = Array.from(fileList || []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!pickedFiles.length) return;
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
    if (nextAttachments.length) {
      setAttachments(prev => [...prev, ...nextAttachments]);
    }
    if (errors.length) {
      setAttachmentError(errors[0]);
    }
  }, [attachments]);

  const handlePaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const files = uniqueChatImageFiles(items
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file)));
    if (!files.length) return;
    event.preventDefault();
    setAttachmentError('');

    const imageCount = attachments.filter((item) => item.type === 'image').length;
    const remainingSlots = CHAT_IMAGE_MAX_COUNT - imageCount;
    if (remainingSlots <= 0) {
      setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
      return;
    }
    const accepted = files.slice(0, remainingSlots);
    if (!accepted.length) {
      setAttachmentError('这张图片无法读取，请换一张');
      return;
    }
    if (files.length > remainingSlots) setAttachmentError(`最多一次发送 ${CHAT_IMAGE_MAX_COUNT} 张图片`);
    try {
      const nextAttachments = await uploadChatImages(accepted);
      setAttachments(prev => [...prev, ...nextAttachments]);
    } catch (error) {
      setAttachmentError((error as Error).message || '图片上传失败');
    }
  }, [attachments]);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    const messageAttachments = attachments;
    if ((!content && messageAttachments.length === 0) || isStreaming || !template) return;
    nextSuggestion.markAcceptedSuggestionSent(content);
    const effectiveModel = selectedModel || sessionMeta?.model || template.model || '';
    provider.current = resolveProviderForModel(effectiveModel).provider;

    const userMsg: ChatMessage = {
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
    };
    const newMessages = [...messages, userMsg];
    const assistantTimestamp = Date.now();
    const draftId = crypto.randomUUID();
    const draftMessages = appendAssistantDraft(newMessages, draftId, assistantTimestamp);
    shouldAutoScrollRef.current = true;
    setShowScrollBottom(false);
    setMessages(draftMessages);
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setAttachments([]);
    setAttachmentError('');
    setIsStreaming(true);
    setRunPhase('initializing');
    setPendingQuestions([]);
    setAgentTasks([]);
    setContextEvents([]);
    setStructuredOutput(null);
    setRunStats(null);

    const requestSessionId = sessionId || `chat-${id || template.id}-${Date.now()}`;
    await persistSession(draftMessages, undefined, undefined, requestSessionId);
    let thinking = '';
    let text = '';
    let runIdForDraft = '';
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
      setRunPhase(deriveRunPhase(phaseFlags));
    };
    const finishRun = () => {
      abortRef.current = null;
      setIsStreaming(false);
      setRunPhase('idle');
      setActiveRunId('');
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
      const finalMessages = finalizeAssistantDraft(newMessages, draftId, assistantTimestamp, content, outcome, thinking || undefined, detail, runIdForDraft || undefined, finalRunStats);
      setMessages(finalMessages);
      await persistSession(finalMessages, sdkSessionId, sdkCwd, requestSessionId);
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          assistantDraftId: draftId,
          assistantTimestamp,
          title: createChatSessionTitle(newMessages, sessionMeta?.title),
          messages: newMessages.map((m, index) => ({
            role: m.role,
            content: m.content,
            attachments: index === newMessages.length - 1 ? m.attachments : undefined,
            timestamp: m.timestamp,
            id: m.id,
            status: m.status,
            thinking: m.thinking,
            outcome: m.outcome,
            outcomeDetail: m.outcomeDetail,
            runStats: m.runStats,
          })),
          systemPrompt: template.systemPrompt || undefined,
          model: effectiveModel,
          provider: provider.current,
          providerProfiles: loadProviderProfiles(),
          visualPreprocessEnabled,
          visualPreprocessModel: visualPreprocessModel || undefined,
          templateId: template.id,
          sessionId: requestSessionId,
          tools: buildRequestToolsForAgent(template),
          mcpServers: template.mcpServers || [],
          subagents: template.subagents,
          skills: template.skills || [],
          enableFileCheckpointing: template.enableFileCheckpointing || undefined,
          useKnowledge: template.useKnowledge || undefined,
          knowledgeSourceIds: template.knowledgeSourceIds || [],
          outputSchema: template.outputSchema || undefined,
          sdkSessionId: canResumeChatSession(sessionMeta) ? sessionMeta?.sdkSessionId : undefined,
          sdkCwd: canResumeChatSession(sessionMeta) ? sessionMeta?.sdkCwd : undefined,
          forkedFromSessionId: sessionMeta?.forkedFromSessionId,
          forkedFromTitle: sessionMeta?.forkedFromTitle,
          pinned: sessionMeta?.pinned,
          ownerSub: sessionMeta?.ownerSub,
          collaborationEnabled: sessionMeta?.collaborationEnabled,
          collaborationRole: sessionMeta?.collaborationRole,
          collaborationUpdatedAt: sessionMeta?.collaborationUpdatedAt,
          createdAt: sessionMeta?.createdAt,
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
      let subscribedReader = reader;
      let subscribedDecoder = decoder;

      while (true) {
        const { done, value } = await subscribedReader.read();
        if (done) break;

        buf += subscribedDecoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6);
          try {
            const data = JSON.parse(json);
            if (data.type === 'run_started') {
              const runId = typeof data.runId === 'string' ? data.runId : '';
              if (runId) {
                runIdForDraft = runId;
                setActiveRunId(runId);
                setMessages(prev => updateAssistantDraft(prev, draftId, { runId }));
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
                setMessages(prev => updateAssistantDraft(prev, draftId, { thinking, status: 'streaming' }));
                updateRunPhase({ initializing: false, thinking: true, streaming: false, toolExecuting: false });
              } else {
                text += data.text || '';
                setMessages(prev => updateAssistantDraft(prev, draftId, { content: text, status: 'streaming' }));
                updateRunPhase({ initializing: false, thinking: false, streaming: true, toolExecuting: false });
              }
            } else if (data.type === 'run_log') {
              const level = data.level === 'warn' ? 'warn' : 'info';
              const message = typeof data.message === 'string' ? data.message : '';
              if (message) {
                text += `\n[${level}] ${message}\n`;
                setMessages(prev => updateAssistantDraft(prev, draftId, { content: text, status: 'streaming' }));
              }
            } else if (data.type === 'result') {
              const finalOutcome = receivedOutcome || mapResultSubtypeToOutcome(data.subtype);
              const finalDetail = outcomeDetail || (typeof data.subtype === 'string' ? data.subtype : undefined);
              const finalContent = text || data.text || '';
              if (data.structuredOutput !== undefined) setStructuredOutput(data.structuredOutput);
              let finalRunStats: ChatRunStats | undefined;
              if (data.cost_usd !== undefined || data.duration_ms !== undefined || data.usage !== undefined) {
                finalRunStats = chatRunStatsFromResultEvent(data);
                setRunStats(finalRunStats || null);
              }
              await persistFinalMessage(finalContent || (cachedErrorMessage ? `错误: ${cachedErrorMessage}` : ''), finalOutcome, data.sdkSessionId, data.sdkCwd, finalDetail, finalRunStats);
            } else if (data.type === 'run_outcome') {
              receivedOutcome = normalizeRunOutcome(data.outcome, receivedOutcome || 'provider_error');
              outcomeDetail = typeof data.subtype === 'string'
                ? data.subtype
                : typeof data.message === 'string' ? data.message : outcomeDetail;
            } else if (data.type === 'permission_request') {
              pendingPermissionCount += 1;
              setPendingPermissions(prev => [...prev, {
                reqId: data.reqId, toolName: data.toolName, input: data.input,
                title: data.title, displayName: data.displayName, description: data.description,
                toolUseID: data.toolUseID,
              }]);
              updateRunPhase({ awaitingPermission: true, initializing: false });
            } else if (data.type === 'permission_resolved') {
              if (data.reqId) {
                pendingPermissionCount = Math.max(0, pendingPermissionCount - 1);
                setPendingPermissions(prev => prev.filter(p => p.reqId !== data.reqId));
                updateRunPhase({ awaitingPermission: pendingPermissionCount > 0 });
              }
            } else if (data.type === 'ask_user_question') {
              pendingQuestionCount += 1;
              setPendingQuestions(prev => [...prev, {
                reqId: data.reqId,
                questions: data.questions || [],
                toolUseID: data.toolUseID,
              }]);
              updateRunPhase({ awaitingInput: true, initializing: false });
            } else if (data.type === 'ask_user_question_resolved') {
              if (data.reqId) {
                pendingQuestionCount = Math.max(0, pendingQuestionCount - 1);
                setPendingQuestions(prev => prev.filter(p => p.reqId !== data.reqId));
                updateRunPhase({ awaitingInput: pendingQuestionCount > 0 });
              }
            } else if (String(data.type || '').startsWith('task_')) {
              setAgentTasks(prev => mergeAgentTaskEvent(prev, data));
              updateRunPhase({ initializing: false, toolExecuting: true, thinking: false, streaming: false });
            } else if (data.type === 'context_compaction') {
              setContextEvents(prev => mergeContextCompactionEvent(prev, data));
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
  }, [input, attachments, isStreaming, template, nextSuggestion, messages, persistSession, selectedModel, sessionMeta, sessionId, id, visualPreprocessEnabled, visualPreprocessModel]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
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

  if (!template) {
    return <div className="page-header"><h1>加载中...</h1></div>;
  }

  const displayModel = effectiveChatModel;
  const observedRunStats = runStats || (!isStreaming ? latestAssistantRunStats(messages) : null);

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div className="flex-between">
          <div>
            <h1 style={{ fontSize: '1.2em' }}>💬 {template.name}</h1>
            <p style={{ fontSize: '.8em' }}>{template.description || template.systemPrompt.slice(0, 60)}</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={() => navigate('/conversations')}>← 返回会话</button>
          </div>
        </div>
        <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
          <ChatModelPicker
            value={displayModel}
            templateModel={template.model}
            models={modelOptions}
            disabled={isStreaming}
            onChange={model => setSelectedModelOverride({ contextKey: modelContextKey, model })}
          />
          <ContextWindowMeter
            model={displayModel}
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
                if (enabled && !visualPreprocessModel) setVisualPreprocessModel(defaultVisualPreprocessModel(template));
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
          {runPhase !== 'idle' && (
            <span className={`badge ${phaseBadgeClass(runPhase)}`}>{phaseLabel(runPhase)}</span>
          )}
          {((template.knowledgeSourceIds || []).length > 0 || template.useKnowledge) && (
            <span className="badge badge-success">知识库×{(template.knowledgeSourceIds || []).length || '全部'}</span>
          )}
          {template.tools.slice(0, 5).map(t => <span key={t} className="badge badge-info">{t}</span>)}
          {template.tools.length > 5 && <span className="badge badge-muted">+{template.tools.length - 5}</span>}
          {sessionMeta && (
            <>
              <span className={`badge ${sessionMeta.collaborationEnabled ? 'badge-success' : 'badge-muted'}`}>
                协作{sessionMeta.collaborationEnabled ? `·${sessionMeta.collaborationRole === 'member' ? '成员' : 'Owner'}` : '关闭'}
              </span>
              {sessionMeta.collaborationRole !== 'member' && (
                <button
                  className="btn btn-sm"
                  onClick={handleToggleCollaboration}
                  disabled={!sessionMeta.persisted}
                  title={sessionMeta.persisted ? undefined : '发送一条消息保存会话后才能开启协作'}
                >
                  {sessionMeta.collaborationEnabled ? '关闭协作' : '开启协作'}
                </button>
              )}
              {sessionMeta.collaborationEnabled && (
                <button className="btn btn-sm" onClick={handleCopyCollaborationLink}>
                  {copyStatus || '复制链接'}
                </button>
              )}
            </>
          )}
          {collaborationError && <span style={{ color: 'var(--danger)', fontSize: '.76em' }}>{collaborationError}</span>}
        </div>
      </div>

      <div className="chat-container">
        <div className="chat-messages" ref={messagesRef} onScroll={updateScrollBottomVisibility}>
          {messages.length === 0 && !isStreaming && (
            <div style={{ textAlign: 'center', color: 'var(--ink-muted)', padding: 40, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div>
                <div style={{ fontSize: '1.5em', marginBottom: 8 }}>🤖</div>
                <div>{template.name}</div>
                <div style={{ fontSize: '.82em' }}>{template.systemPrompt.slice(0, 60) || '开始一段对话吧'}</div>
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

        <div style={{ padding: '0 12px', maxHeight: '42vh', overflowY: 'auto', flexShrink: 0 }}>
          <AskUserQuestionPromptList
            pending={pendingQuestions}
            onResolved={(reqId) => setPendingQuestions(prev => prev.filter(p => p.reqId !== reqId))}
          />
          <PermissionPromptList
            pending={pendingPermissions}
            onResolved={(reqId) => setPendingPermissions(prev => prev.filter(p => p.reqId !== reqId))}
          />
        </div>

        <div className="chat-input-area">
          {(attachments.length > 0 || attachmentError) && (
            <div style={{ padding: '4px 0' }}>
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
            accept={CHAT_ATTACHMENT_ACCEPT}
            onChange={e => void handleFilePicked(e.currentTarget.files)}
            style={{ display: 'none' }}
          />
          <button
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            title="上传文件"
            aria-label="上传文件"
            style={{ width: 34, height: 34, minWidth: 34, padding: 0, borderRadius: 6, fontSize: 20, lineHeight: '30px' }}
          >
            +
          </button>
          <div className="composer-suggestion-field">
            {nextSuggestion.suggestionText && !input.trim() && (
              <button
                type="button"
                className="composer-ghost-suggestion"
                onClick={handleApplySuggestion}
                disabled={isStreaming}
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
              onPaste={e => void handlePaste(e)}
              placeholder={nextSuggestion.suggestionText ? '' : '输入消息，Enter 发送，Shift+Enter 换行，可粘贴图片，也可上传文件'}
              style={{ resize: 'none', overflowY: 'hidden', minHeight: 38, maxHeight: 200 }}
              disabled={isStreaming}
            />
          </div>
          {isStreaming ? (
            <button className="btn btn-danger" onClick={handleStop}>
              {isWaitingPhase(runPhase) ? '停止等待' : '停止'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleSend} disabled={!input.trim() && attachments.length === 0}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
