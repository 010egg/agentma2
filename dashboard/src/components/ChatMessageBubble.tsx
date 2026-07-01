import { memo, useState, useMemo } from 'react';
import type { MouseEvent } from 'react';
import type { ChatAttachment, ChatMessage, ChatImageAttachment } from '../simulator/types';
import { renderMarkdown } from '../utils/render-markdown';
import { normalizeMessageOutcome, outcomeBadgeClass, outcomeColor, outcomeLabel } from '../simulator/run-state';
import WaitingHint from './WaitingHint';

type Props = {
  message: ChatMessage;
  /** 等待回复时显示的用户可读阶段（整理思路/调用工具…）；仅 pending 气泡使用 */
  waitingLabel?: string;
};

function ImageGrid({ attachments }: { attachments: ChatImageAttachment[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
      {attachments.map(img => (
        <img
          key={img.id}
          src={`data:${img.mediaType};base64,${img.data}`}
          alt={img.name || '图片'}
          style={{ maxWidth: 200, maxHeight: 200, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border)' }}
        />
      ))}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentGrid({ attachments }: { attachments: ChatAttachment[] }) {
  const images = attachments.filter((item): item is ChatImageAttachment => item.type === 'image');
  const files = attachments.filter((item) => item.type === 'file');
  return (
    <div style={{ display: 'grid', gap: 6, marginBottom: 6 }}>
      {images.length > 0 && <ImageGrid attachments={images} />}
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {files.map(file => (
            <span
              key={file.id}
              className="badge badge-info"
              title={`${file.name} · ${formatBytes(file.size)}`}
              style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {file.name} · {formatBytes(file.size)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      title="复制"
      style={{
        position: 'absolute', top: 6, right: 6,
        opacity: 0, transition: 'opacity 0.15s',
        background: 'var(--bg-hover)', border: '1px solid var(--border)',
        borderRadius: 4, padding: '2px 6px', fontSize: '.7em',
        color: copied ? 'var(--success)' : 'var(--ink-secondary)',
        cursor: 'pointer', lineHeight: 1.4,
      }}
      className="copy-btn"
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

function ChatMessageBubble({ message, waitingLabel }: Props) {
  const isThinkingActive = message.status === 'streaming' && !!message.thinking;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const isPending = message.role === 'assistant' && message.status === 'pending' && !message.content && !message.thinking;
  const outcome = message.role === 'assistant' ? normalizeMessageOutcome(message.outcome, message.status) : undefined;
  const isDangerOutcome = outcome === 'exec_error' || outcome === 'provider_error' || outcome === 'rejected';
  const isError = message.status === 'error' && isDangerOutcome;
  const isStreaming = message.status === 'streaming';
  const isComplete = message.role === 'assistant' && message.status === 'complete' && !!message.content;
  const showOutcomeBadge = Boolean(outcome && outcome !== 'completed' && !isStreaming && !isPending);
  const useMarkdown = message.role === 'assistant' && !isDangerOutcome && !!message.content;

  const htmlContent = useMemo(() => {
    if (!useMarkdown) return '';
    return renderMarkdown(message.content);
  }, [useMarkdown, message.content]);

  const handleMarkdownClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const copyButton = target.closest<HTMLButtonElement>('.chat-code-copy');
    const code = copyButton?.dataset.code;
    if (!copyButton || code == null) return;

    void navigator.clipboard.writeText(code).then(() => {
      copyButton.textContent = '已复制';
      copyButton.dataset.copied = 'true';
      window.setTimeout(() => {
        if (copyButton.dataset.copied === 'true') {
          copyButton.textContent = '复制';
          delete copyButton.dataset.copied;
        }
      }, 1500);
    });
  };

  if (isPending) {
    return (
      <div className="chat-msg assistant" style={{ position: 'relative' }}>
        <WaitingHint label={waitingLabel} />
      </div>
    );
  }

  return (
    <div
      className={`chat-msg ${message.role}${isPending ? ' pulse' : ''}`}
      style={{
        position: 'relative',
        ...(outcome && outcome !== 'completed' ? { borderLeft: `3px solid ${outcomeColor(outcome)}` } : {}),
        ...(isError ? { color: 'var(--danger)' } : {}),
      }}
    >
      {showOutcomeBadge && outcome && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <span className={`badge ${outcomeBadgeClass(outcome)}`}>{outcomeLabel(outcome)}</span>
        </div>
      )}

      {message.attachments && message.attachments.length > 0 && (
        <AttachmentGrid attachments={message.attachments} />
      )}

      {message.thinking && (
        <div style={{ marginBottom: message.content ? 8 : 0 }}>
          {isThinkingActive ? (
            <div style={{
              color: 'var(--ink-muted)', fontSize: '.85em', fontStyle: 'italic',
              borderLeft: '2px solid var(--accent)', paddingLeft: 10,
            }}>
              {message.thinking}
            </div>
          ) : (
            <>
              <button
                onClick={() => setThinkingExpanded(v => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.75em', color: 'var(--ink-muted)', padding: '0 0 4px', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <span style={{ transform: thinkingExpanded ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform .15s' }}>▶</span>
                思考过程
              </button>
              {thinkingExpanded && (
                <div style={{
                  color: 'var(--ink-muted)', fontSize: '.85em', fontStyle: 'italic',
                  borderLeft: '2px solid var(--border)', paddingLeft: 10, marginTop: 2,
                }}>
                  {message.thinking}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {useMarkdown ? (
        <div
          className="chat-markdown"
          onClick={handleMarkdownClick}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      ) : (
        <span>
          {message.content || (isPending ? '...' : '')}
          {isStreaming && !message.content && !message.thinking && (
            <span className="pulse" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'currentColor', verticalAlign: 'middle', marginLeft: 4 }} />
          )}
        </span>
      )}

      {isComplete && <CopyButton text={message.content} />}

      {message.timestamp > 0 && (message.role === 'user' || isComplete) && (
        <div style={{ fontSize: '.65em', color: 'var(--ink-muted)', marginTop: 4, opacity: 0.6 }}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}

function areMessagePropsEqual(prev: Props, next: Props): boolean {
  const a = prev.message;
  const b = next.message;

  return (
    prev.waitingLabel === next.waitingLabel && (
      a === b ||
      (
        a.id === b.id &&
        a.role === b.role &&
        a.content === b.content &&
        a.thinking === b.thinking &&
        a.status === b.status &&
        a.timestamp === b.timestamp &&
        a.attachments === b.attachments
      )
    )
  );
}

export default memo(ChatMessageBubble, areMessagePropsEqual);
