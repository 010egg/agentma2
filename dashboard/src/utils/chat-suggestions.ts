import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTemplate, ChatAttachment, ChatMessage, ProviderConfig } from '../simulator/types';
import { getAuthHeaders } from './client-runtime';
import { loadProviderProfiles } from './providers';

export type ChatNextSuggestion = {
  id: string;
  text: string;
};

type SuggestionStatus = 'accepted' | 'sent' | 'dismissed' | 'abandoned';

async function readSuggestionJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : null;
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
      ? String((data as Record<string, unknown>).error || '推荐生成失败')
      : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return data as T;
}

async function requestNextSuggestion(input: {
  sessionId: string;
  templateId: string;
  model: string;
  provider?: ProviderConfig;
  signal?: AbortSignal;
}): Promise<ChatNextSuggestion | null> {
  const response = await fetch('/api/chat/next-suggestion', {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      sessionId: input.sessionId,
      templateId: input.templateId,
      model: input.model,
      provider: input.provider,
      providerProfiles: loadProviderProfiles(),
    }),
    signal: input.signal,
  });
  const data = await readSuggestionJson<{ suggestionId?: unknown; suggestion?: unknown }>(response);
  const id = typeof data?.suggestionId === 'string' ? data.suggestionId : '';
  const text = typeof data?.suggestion === 'string' ? data.suggestion.trim() : '';
  return id && text ? { id, text } : null;
}

async function recordSuggestionStatus(
  suggestionId: string,
  status: SuggestionStatus,
  details?: { editedBeforeSend?: boolean; finalTextLength?: number },
) {
  if (!suggestionId) return;
  try {
    await fetch(`/api/chat/next-suggestion/${encodeURIComponent(suggestionId)}/event`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        status,
        editedBeforeSend: details?.editedBeforeSend,
        finalTextLength: details?.finalTextLength,
      }),
    });
  } catch {
    // Suggestion telemetry must never break the composer.
  }
}

function isCompleteAssistantMessage(message: ChatMessage | undefined) {
  if (!message || message.role !== 'assistant') return false;
  if (!message.content.trim()) return false;
  return message.status !== 'pending' && message.status !== 'streaming';
}

function latestCompleteAssistantMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isCompleteAssistantMessage(message)) return message;
    if (message?.role === 'user') break;
  }
  return undefined;
}

export function useChatNextSuggestion(input: {
  sessionId?: string | null;
  templateId?: string;
  template?: AgentTemplate | null;
  model?: string;
  provider?: ProviderConfig;
  messages: ChatMessage[];
  composerInput: string;
  attachments?: ChatAttachment[];
  disabled?: boolean;
}) {
  const [suggestion, setSuggestion] = useState<ChatNextSuggestion | null>(null);
  const suggestionRef = useRef<ChatNextSuggestion | null>(null);
  const acceptedRef = useRef<ChatNextSuggestion | null>(null);
  const requestKeyRef = useRef('');
  const requestSeqRef = useRef(0);
  const retryCountsRef = useRef<Record<string, number>>({});
  const retryTimerRef = useRef<number | undefined>(undefined);
  const [retryTick, setRetryTick] = useState(0);
  const latestAssistant = useMemo(() => latestCompleteAssistantMessage(input.messages), [input.messages]);
  const attachmentCount = input.attachments?.length || 0;
  const sessionId = input.sessionId || '';
  const templateId = input.templateId || input.template?.id || '';
  const model = input.model || '';
  const blocked = input.disabled || !sessionId || !templateId || !model || Boolean(input.composerInput.trim()) || attachmentCount > 0;

  useEffect(() => {
    suggestionRef.current = suggestion;
  }, [suggestion]);

  const dismissSuggestion = useCallback((status: Extract<SuggestionStatus, 'dismissed' | 'abandoned'> = 'dismissed') => {
    const current = suggestionRef.current;
    if (!current) return;
    suggestionRef.current = null;
    setSuggestion(null);
    void recordSuggestionStatus(current.id, status);
  }, []);

  useEffect(() => {
    if (!suggestionRef.current) return;
    if (input.composerInput.trim() || attachmentCount > 0 || input.disabled) {
      dismissSuggestion('dismissed');
    }
  }, [attachmentCount, dismissSuggestion, input.composerInput, input.disabled]);

  useEffect(() => {
    if (!blocked && latestAssistant) return;
    requestSeqRef.current += 1;
    window.clearTimeout(retryTimerRef.current);
    if (!suggestionRef.current) return;
    suggestionRef.current = null;
    setSuggestion(null);
  }, [blocked, latestAssistant]);

  useEffect(() => {
    if (blocked || !latestAssistant) return;
    const requestKey = [
      sessionId,
      templateId,
      model,
      latestAssistant.id || '',
      latestAssistant.timestamp,
      latestAssistant.content.length,
    ].join(':');
    if (requestKeyRef.current === requestKey) return;
    requestKeyRef.current = requestKey;
    setSuggestion(null);
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const controller = new AbortController();
    const scheduleRetry = () => {
      const retries = retryCountsRef.current[requestKey] || 0;
      if (retries >= 2) return;
      retryCountsRef.current[requestKey] = retries + 1;
      requestKeyRef.current = '';
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        if (requestSeqRef.current === seq && !controller.signal.aborted) {
          setRetryTick(tick => tick + 1);
        }
      }, 1200 * (retries + 1));
    };
    const timer = window.setTimeout(() => {
      void requestNextSuggestion({
        sessionId,
        templateId,
        model,
        provider: input.provider,
        signal: controller.signal,
      }).then((next) => {
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;
        if (!next) {
          scheduleRetry();
          return;
        }
        delete retryCountsRef.current[requestKey];
        setSuggestion(next);
      }).catch(() => {
        if (requestSeqRef.current !== seq) return;
        setSuggestion(null);
        scheduleRetry();
      });
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [blocked, input.provider, latestAssistant, model, retryTick, sessionId, templateId]);

  useEffect(() => () => {
    window.clearTimeout(retryTimerRef.current);
  }, []);

  const acceptSuggestion = useCallback(() => {
    const current = suggestionRef.current;
    if (!current) return null;
    acceptedRef.current = current;
    suggestionRef.current = null;
    setSuggestion(null);
    void recordSuggestionStatus(current.id, 'accepted');
    return current;
  }, []);

  const markAcceptedSuggestionSent = useCallback((finalText: string) => {
    const accepted = acceptedRef.current;
    if (!accepted) return;
    acceptedRef.current = null;
    const normalizedFinalText = finalText.trim();
    if (!normalizedFinalText) {
      void recordSuggestionStatus(accepted.id, 'abandoned');
      return;
    }
    void recordSuggestionStatus(accepted.id, 'sent', {
      editedBeforeSend: normalizedFinalText !== accepted.text.trim(),
      finalTextLength: normalizedFinalText.length,
    });
  }, []);

  const abandonAcceptedSuggestion = useCallback(() => {
    const accepted = acceptedRef.current;
    if (!accepted) return;
    acceptedRef.current = null;
    void recordSuggestionStatus(accepted.id, 'abandoned');
  }, []);

  return {
    suggestion,
    suggestionText: suggestion?.text || '',
    acceptSuggestion,
    dismissSuggestion,
    markAcceptedSuggestionSent,
    abandonAcceptedSuggestion,
  };
}
