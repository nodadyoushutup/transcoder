import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPen, faTrash, faTimesCircle } from '@fortawesome/free-solid-svg-icons';
import { io } from 'socket.io-client';
import emojiDictionary from 'emoji-dictionary';
import LazyRender from './LazyRender.jsx';
import notificationSound from '../audio/notification_chat.mp3';

const MESSAGE_LIMIT = 50;
const MAX_ATTACHMENTS = 6;
const TOP_SCROLL_THRESHOLD = 120;
const BOTTOM_SCROLL_THRESHOLD = 160;
const EMOJI_REGEX = /:[a-z0-9_+\-]+:/gi;
const URL_REGEX = /https?:\/\/[^\s<]+/gi;

function emojifyText(segment) {
  return segment.replace(EMOJI_REGEX, (code) => {
    const name = code.slice(1, -1).toLowerCase();
    const emoji = emojiDictionary.getUnicode(name);
    return emoji || code;
  });
}

function renderMessageContent(body, keyPrefix = 'seg') {
  if (!body) {
    return null;
  }
  const nodes = [];
  let lastIndex = 0;
  let segmentIndex = 0;
  body.replace(URL_REGEX, (match, offset) => {
    if (offset > lastIndex) {
      const text = body.slice(lastIndex, offset);
      nodes.push(...renderTextSegment(text, `${keyPrefix}-text-${segmentIndex += 1}`));
    }
    nodes.push(
      <a
        key={`${keyPrefix}-link-${segmentIndex += 1}`}
        href={match}
        target="_blank"
        rel="noopener noreferrer"
        className="text-zinc-200 underline decoration-zinc-500 underline-offset-2 hover:text-white"
      >
        {match}
      </a>,
    );
    lastIndex = offset + match.length;
    return match;
  });
  if (lastIndex < body.length) {
    const text = body.slice(lastIndex);
    nodes.push(...renderTextSegment(text, `${keyPrefix}-tail`));
  }
  return nodes.length ? nodes : null;
}

function renderTextSegment(text, keyPrefix) {
  const emojiText = emojifyText(text);
  const lines = emojiText.split(/\n/);
  const parts = [];
  lines.forEach((line, index) => {
    parts.push(
      <span key={`${keyPrefix}-line-${index}`} className="whitespace-pre-wrap break-words">
        {line}
      </span>,
    );
    if (index < lines.length - 1) {
      parts.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
  });
  return parts;
}

export default function ChatPanel({ backendBase, user, onUnauthorized }) {
  const [messages, setMessages] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [connectionState, setConnectionState] = useState('connecting');
  const [editingMessageId, setEditingMessageId] = useState(null);

  const listRef = useRef(null);
  const socketRef = useRef(null);
  const messageIdsRef = useRef(new Set());
  const autoScrollRef = useRef(true);
  const composerRef = useRef(null);
  const attachmentIdRef = useRef(0);
  const notificationAudioRef = useRef(null);
  const historyReadyRef = useRef(false);

  const baseUrl = useMemo(() => backendBase.replace(/\/$/, ''), [backendBase]);

  const scrollToBottom = useCallback(
    (behavior = 'auto') => {
      const container = listRef.current;
      if (!container) {
        return;
      }
      requestAnimationFrame(() => {
        container.scrollTo({ top: container.scrollHeight, behavior });
      });
    },
    [],
  );

  const normalizeMessages = useCallback(
    (rawMessages) => {
      if (!Array.isArray(rawMessages)) {
        return [];
      }
      return rawMessages
        .map((raw) => {
          const id = Number(raw?.id ?? 0);
          const createdAtValue = raw?.created_at ? new Date(raw.created_at) : new Date();
          if (Number.isNaN(createdAtValue.getTime())) {
            createdAtValue.setTime(Date.now());
          }
          const updatedAtValue = raw?.updated_at ? new Date(raw.updated_at) : createdAtValue;
          const attachments = Array.isArray(raw?.attachments)
            ? raw.attachments
                .map((attachment) => {
                  const attachmentId = Number(attachment?.id ?? 0);
                  if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
                    return null;
                  }
                  const relativeUrl = String(attachment?.url ?? '');
                  if (!relativeUrl) {
                    return null;
                  }
                  const absoluteUrl = relativeUrl.startsWith('http')
                    ? relativeUrl
                    : `${baseUrl}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
                  return {
                    id: attachmentId,
                    url: absoluteUrl,
                    mimeType: String(attachment?.mime_type ?? ''),
                    fileSize: Number(attachment?.file_size ?? 0),
                    originalName: attachment?.original_name ?? null,
                  };
                })
                .filter(Boolean)
            : [];

          return {
            id,
            userId: Number(raw?.user_id ?? 0),
            username: String(raw?.username ?? 'Unknown'),
            body: String(raw?.body ?? ''),
            createdAt: createdAtValue,
            updatedAt: updatedAtValue,
            attachments,
          };
        })
        .filter((message) => Number.isFinite(message.id) && message.id > 0);
    },
    [baseUrl],
  );

  const fetchMessages = useCallback(
    async (beforeId = null) => {
      const params = new URLSearchParams({ limit: String(MESSAGE_LIMIT) });
      if (beforeId) {
        params.set('before_id', String(beforeId));
      }
      const response = await fetch(`${baseUrl}/chat/messages?${params.toString()}`, {
        credentials: 'include',
      });
      if (response.status === 401) {
        onUnauthorized?.();
        return null;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = payload?.error || `Failed to load chat (${response.status})`;
        throw new Error(message);
      }
      const payload = await response.json();
      const normalized = normalizeMessages(payload?.messages);
      return {
        messages: normalized,
        hasMore: Boolean(payload?.has_more),
        nextBefore: payload?.next_before_id ?? null,
      };
    },
    [baseUrl, normalizeMessages, onUnauthorized],
  );

  const ingestMessages = useCallback(
    (incoming, { position = 'append', allowUpdate = false } = {}) => {
      if (!incoming?.length) {
        return;
      }
      const known = messageIdsRef.current;
      const candidates = [];
      for (const message of incoming) {
        if (!known.has(message.id)) {
          known.add(message.id);
          candidates.push(message);
        } else if (allowUpdate) {
          candidates.push(message);
        }
      }
      if (!candidates.length && !allowUpdate) {
        return;
      }
      setMessages((prev) => {
        let next;
        if (allowUpdate) {
          const map = new Map(prev.map((item) => [item.id, item]));
          candidates.forEach((item) => {
            map.set(item.id, item);
          });
          next = Array.from(map.values()).sort((a, b) => a.id - b.id);
        } else {
          next = position === 'prepend' ? [...candidates, ...prev] : [...prev, ...candidates];
          next.sort((a, b) => a.id - b.id);
        }
        messageIdsRef.current = new Set(next.map((item) => item.id));
        if (!allowUpdate && position === 'append' && autoScrollRef.current) {
          scrollToBottom('smooth');
        }
        return next;
      });
    },
    [scrollToBottom],
  );

  const removeMessage = useCallback((messageId) => {
    setMessages((prev) => {
      if (!prev.some((message) => message.id === messageId)) {
        return prev;
      }
      const next = prev.filter((message) => message.id !== messageId);
      messageIdsRef.current.delete(messageId);
      return next;
    });
    setEditingMessageId((current) => {
      if (current === messageId) {
        setInputValue('');
        setSendError(null);
        return null;
      }
      return current;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchMessages();
        if (!result || cancelled) {
          return;
        }
        messageIdsRef.current = new Set(result.messages.map((message) => message.id));
        setMessages(result.messages);
        setHasMore(result.hasMore);
        setNextBeforeId(result.nextBefore);
        setLoadError(null);
        requestAnimationFrame(() => {
          scrollToBottom('auto');
        });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Unable to load chat messages');
      } finally {
        if (!cancelled) {
          setLoadingInitial(false);
          historyReadyRef.current = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMessages, scrollToBottom]);

  useEffect(() => {
    if (typeof Audio === 'undefined') {
      return undefined;
    }
    const audio = new Audio(notificationSound);
    audio.volume = 0.5;
    notificationAudioRef.current = audio;
    return () => {
      audio.pause();
      notificationAudioRef.current = null;
    };
  }, []);

  const playNotification = useCallback((incomingMessages) => {
    if (!historyReadyRef.current || !incomingMessages?.length) {
      return;
    }
    const audio = notificationAudioRef.current;
    if (!audio) {
      return;
    }
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    const socket = io(baseUrl, {
      path: '/socket.io',
      withCredentials: true,
    });
    socketRef.current = socket;
    setConnectionState('connecting');

    socket.on('connect', () => {
      setConnectionState('connected');
    });
    socket.on('disconnect', () => {
      setConnectionState('disconnected');
    });
    socket.on('connect_error', () => {
      setConnectionState('error');
    });
    socket.on('chat:message', (payload) => {
      const normalized = normalizeMessages([payload]);
      ingestMessages(normalized);
      playNotification(normalized);
    });
    socket.on('chat:message:update', (payload) => {
      const normalized = normalizeMessages([payload]);
      ingestMessages(normalized, { allowUpdate: true });
    });
    socket.on('chat:message:delete', (payload) => {
      const messageId = Number(payload?.id ?? 0);
      if (messageId > 0) {
        removeMessage(messageId);
      }
    });

    return () => {
      socket.off('chat:message');
      socket.off('chat:message:update');
      socket.off('chat:message:delete');
      socket.disconnect();
      socketRef.current = null;
    };
  }, [baseUrl, ingestMessages, normalizeMessages, playNotification, removeMessage]);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !nextBeforeId) {
      return;
    }
    autoScrollRef.current = false;
    setLoadingMore(true);
    const container = listRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousOffset = container?.scrollTop ?? 0;
    try {
      const result = await fetchMessages(nextBeforeId);
      if (!result) {
        return;
      }
      setHasMore(result.hasMore);
      setNextBeforeId(result.nextBefore);
      setLoadError(null);
      ingestMessages(result.messages, { position: 'prepend' });
      requestAnimationFrame(() => {
        if (container) {
          const diff = container.scrollHeight - previousHeight;
          container.scrollTop = previousOffset + diff;
        }
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load additional messages');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchMessages, hasMore, ingestMessages, loadingMore, nextBeforeId]);

  const handleScroll = useCallback(() => {
    const container = listRef.current;
    if (!container) {
      return;
    }
    if (container.scrollTop < TOP_SCROLL_THRESHOLD && hasMore && !loadingMore && nextBeforeId) {
      void handleLoadMore();
    }
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    autoScrollRef.current = remaining < BOTTOM_SCROLL_THRESHOLD;
  }, [handleLoadMore, hasMore, loadingMore, nextBeforeId]);

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((prev) => {
      prev.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
      });
      return [];
    });
  }, []);

  const addAttachments = useCallback(
    (files) => {
      if (!files?.length || editingMessageId) {
        return;
      }
      setPendingAttachments((prev) => {
        const remainingSlots = MAX_ATTACHMENTS - prev.length;
        if (remainingSlots <= 0) {
          setSendError('Maximum attachments reached');
          return prev;
        }
        const accepted = [];
        for (const file of files) {
          if (!file || !file.type?.startsWith('image/')) {
            continue;
          }
          if (accepted.length >= remainingSlots) {
            break;
          }
          const previewUrl = URL.createObjectURL(file);
          attachmentIdRef.current += 1;
          accepted.push({
            id: attachmentIdRef.current,
            file,
            name: file.name,
            size: file.size,
            previewUrl,
          });
        }
        if (accepted.length === 0) {
          return prev;
        }
        setSendError(null);
        return [...prev, ...accepted];
      });
    },
    [editingMessageId],
  );

  const handlePaste = useCallback(
    (event) => {
      if (editingMessageId) {
        return;
      }
      const clipboardItems = event.clipboardData?.items;
      if (!clipboardItems || clipboardItems.length === 0) {
        return;
      }
      const files = [];
      for (const item of clipboardItems) {
        if (item?.type?.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
      if (files.length) {
        event.preventDefault();
        addAttachments(files);
      }
    },
    [addAttachments, editingMessageId],
  );

  const removePendingAttachment = useCallback((attachmentId) => {
    setPendingAttachments((prev) => {
      const next = prev.filter((attachment) => {
        if (attachment.id === attachmentId) {
          URL.revokeObjectURL(attachment.previewUrl);
          return false;
        }
        return true;
      });
      return next;
    });
  }, []);

  const startEditingMessage = useCallback(
    (message) => {
      setEditingMessageId(message.id);
      setInputValue(message.body);
      clearPendingAttachments();
      setSendError(null);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
      });
    },
    [clearPendingAttachments],
  );

  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
    setInputValue('');
    setSendError(null);
  }, []);

  const submitMessage = useCallback(async () => {
    if (isSending) {
      return;
    }
    const trimmed = inputValue.trim();
    const hasAttachments = pendingAttachments.length > 0;
    const isEditing = Boolean(editingMessageId);

    if (isEditing && !trimmed) {
      setSendError('Message cannot be empty.');
      return;
    }
    if (!isEditing && !hasAttachments && !trimmed) {
      return;
    }

    setSendError(null);
    setIsSending(true);
    autoScrollRef.current = true;

    try {
      if (isEditing) {
        const response = await fetch(`${baseUrl}/chat/messages/${editingMessageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ body: trimmed }),
        });
        if (response.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const message = payload?.error || `Failed to update message (${response.status})`;
          throw new Error(message);
        }
        const payload = await response.json().catch(() => ({}));
        const normalized = normalizeMessages([payload?.message]);
        ingestMessages(normalized, { allowUpdate: true });
        setEditingMessageId(null);
        setInputValue('');
      } else {
        let response;
        if (hasAttachments) {
          const formData = new FormData();
          formData.append('body', trimmed);
          pendingAttachments.forEach((attachment) => {
            formData.append('attachments', attachment.file, attachment.name);
          });
          response = await fetch(`${baseUrl}/chat/messages`, {
            method: 'POST',
            credentials: 'include',
            body: formData,
          });
        } else {
          response = await fetch(`${baseUrl}/chat/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ body: trimmed }),
          });
        }
        if (response.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const message = payload?.error || `Failed to send message (${response.status})`;
          throw new Error(message);
        }
        setInputValue('');
        clearPendingAttachments();
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Unable to send message');
    } finally {
      setIsSending(false);
    }
  }, [
    baseUrl,
    clearPendingAttachments,
    editingMessageId,
    ingestMessages,
    inputValue,
    isSending,
    normalizeMessages,
    onUnauthorized,
    pendingAttachments,
  ]);

  const handleSubmit = useCallback(
    (event) => {
      event.preventDefault();
      void submitMessage();
    },
    [submitMessage],
  );

  const handleComposerKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void submitMessage();
      }
    },
    [submitMessage],
  );

  const handleDeleteMessage = useCallback(
    async (messageId) => {
      try {
        const response = await fetch(`${baseUrl}/chat/messages/${messageId}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (response.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const message = payload?.error || `Failed to delete message (${response.status})`;
          throw new Error(message);
        }
        removeMessage(messageId);
        if (editingMessageId === messageId) {
          cancelEditing();
        }
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'Unable to delete message');
      }
    },
    [baseUrl, cancelEditing, editingMessageId, onUnauthorized, removeMessage],
  );

  useEffect(() => () => {
    clearPendingAttachments();
  }, [clearPendingAttachments]);

  const connectionBadge = useMemo(() => {
    switch (connectionState) {
      case 'connected':
        return { label: 'Connected', classes: 'bg-emerald-500/20 text-emerald-200' };
      case 'error':
        return { label: 'Connection error', classes: 'bg-rose-500/20 text-rose-200' };
      case 'disconnected':
        return { label: 'Disconnected', classes: 'bg-zinc-700/40 text-zinc-200' };
      default:
        return { label: 'Connecting…', classes: 'bg-amber-500/20 text-amber-200' };
    }
  }, [connectionState]);

  const composerPlaceholder = editingMessageId ? 'Edit your message…' : 'Send a message…';
  const sendButtonLabel = editingMessageId ? 'Save' : 'Send';
  const canSubmit = editingMessageId
    ? Boolean(inputValue.trim())
    : Boolean(inputValue.trim()) || pendingAttachments.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950/70">
      <header className="flex items-center justify-between border-b border-zinc-900/80 px-6 py-4">
        <h2 className="text-lg font-semibold text-zinc-100">Live Chat</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${connectionBadge.classes}`}>
          {connectionBadge.label}
        </span>
      </header>

      <div ref={listRef} onScroll={handleScroll} className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
        {loadError ? (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            {loadError}
          </div>
        ) : null}

        {hasMore ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void handleLoadMore()}
              disabled={loadingMore}
              className="text-xs font-semibold text-zinc-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? 'Loading earlier messages…' : 'Load earlier messages'}
            </button>
          </div>
        ) : null}

        {loadingInitial && !messages.length ? <InitialSkeleton /> : null}

        {!loadingInitial && messages.length === 0 && !loadError ? (
          <p className="text-center text-xs text-zinc-500">No chat activity yet. Start the conversation!</p>
        ) : null}

        {messages.map((message) => (
          <LazyRender
            key={message.id}
            estimatedHeight="3.5rem"
            placeholder={<MessageSkeleton alignment={message.userId === user.id ? 'right' : 'left'} />}
            className="block"
          >
            <MessageBubble
              message={message}
              currentUserId={user.id}
              canModify={Boolean(user?.is_admin) || message.userId === user.id}
              onEdit={startEditingMessage}
              onDelete={handleDeleteMessage}
            />
          </LazyRender>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-zinc-900/80 bg-zinc-950/80 px-6 py-4">
        {editingMessageId ? (
          <div className="mb-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-300">
            <span>Editing message</span>
            <button
              type="button"
              onClick={cancelEditing}
              className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        ) : null}

        {pendingAttachments.length ? (
          <div className="mb-3 flex flex-wrap gap-3">
            {pendingAttachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-20 w-20 rounded-xl border border-zinc-800 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePendingAttachment(attachment.id)}
                  className="absolute -top-2 -right-2 rounded-full bg-zinc-900/90 p-1 text-zinc-200 shadow-md transition hover:text-white"
                >
                  <FontAwesomeIcon icon={faTimesCircle} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={composerRef}
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            if (sendError) {
              setSendError(null);
            }
          }}
          onKeyDown={handleComposerKeyDown}
          onPaste={handlePaste}
          rows={2}
          placeholder={composerPlaceholder}
          className="h-24 w-full resize-none rounded-2xl border border-zinc-800 bg-zinc-900/90 px-4 py-3 text-sm text-zinc-100 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-400/60"
          disabled={connectionState !== 'connected' && connectionState !== 'connecting'}
        />
        <div className="mt-3 flex items-center justify-between gap-2 text-xs">
          {sendError ? <span className="text-rose-200">{sendError}</span> : <span className="text-zinc-500">Shift+Enter for a newline</span>}
          <button
            type="submit"
            disabled={isSending || !canSubmit}
            className="inline-flex items-center rounded-full bg-zinc-200 px-4 py-1.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {isSending ? 'Sending…' : sendButtonLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message, currentUserId, canModify, onEdit, onDelete }) {
  const isSelf = message.userId === currentUserId;
  const containerClass = isSelf ? 'justify-end' : 'justify-start';
  const bubbleClass = isSelf
    ? 'bg-zinc-800/80 text-zinc-100 border border-zinc-700'
    : 'bg-zinc-900/80 text-zinc-100 border border-zinc-800';
  const usernameClass = 'text-zinc-400';
  const isEdited = message.updatedAt && message.updatedAt - message.createdAt > 1000;

  return (
    <div className={`group flex ${containerClass}`}>
      <div className={`relative max-w-[85%] rounded-2xl px-4 py-3 shadow-md shadow-black/30 ${bubbleClass}`}>
        {canModify ? (
          <div className="absolute -right-2 -top-3 flex gap-2 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onEdit(message)}
              className="rounded-full bg-zinc-900/90 p-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
            >
              <FontAwesomeIcon icon={faPen} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(message.id)}
              className="rounded-full bg-zinc-900/90 p-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
            >
              <FontAwesomeIcon icon={faTrash} />
            </button>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <span className={`text-xs font-semibold uppercase tracking-wide ${usernameClass}`}>{message.username}</span>
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">
            {formatTimestamp(message.createdAt)}
            {isEdited ? <span className="ml-2 text-[10px] lowercase text-zinc-500">edited</span> : null}
          </span>
        </div>
        {message.body ? (
          <div className="mt-2 text-sm leading-relaxed text-zinc-100">
            {renderMessageContent(message.body, `msg-${message.id}`)}
          </div>
        ) : null}
        {message.attachments?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.attachments.map((attachment) => (
              <a
                key={attachment.id}
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block max-w-[18rem] overflow-hidden rounded-xl border border-zinc-800 bg-black/50"
              >
                <img
                  src={attachment.url}
                  alt={attachment.originalName ?? 'Chat attachment'}
                  className="h-auto w-full max-h-64 object-contain"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageSkeleton({ alignment }) {
  const justify = alignment === 'right' ? 'justify-end' : 'justify-start';
  return (
    <div className={`flex ${justify}`}>
      <div className="h-20 w-4/5 max-w-[85%] animate-pulse rounded-2xl bg-zinc-900/60" />
    </div>
  );
}

function InitialSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
          <div className="h-20 w-4/5 max-w-[85%] animate-pulse rounded-2xl bg-zinc-900/60" />
        </div>
      ))}
    </div>
  );
}

function formatTimestamp(date) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}
