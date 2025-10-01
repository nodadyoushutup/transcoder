import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import LazyRender from './LazyRender.jsx';

const MESSAGE_LIMIT = 50;
const TOP_SCROLL_THRESHOLD = 120;
const BOTTOM_SCROLL_THRESHOLD = 160;

export default function ChatPanel({ backendBase, user, onUnauthorized }) {
  const [messages, setMessages] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState(null);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [connectionState, setConnectionState] = useState('connecting');

  const listRef = useRef(null);
  const socketRef = useRef(null);
  const messageIdsRef = useRef(new Set());
  const autoScrollRef = useRef(true);

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

  const normalizeMessages = useCallback((rawMessages) => {
    if (!Array.isArray(rawMessages)) {
      return [];
    }
    return rawMessages
      .map((raw) => {
        const createdAtValue = raw?.created_at ? new Date(raw.created_at) : new Date();
        if (Number.isNaN(createdAtValue.getTime())) {
          createdAtValue.setTime(Date.now());
        }
        return {
          id: Number(raw?.id ?? 0),
          userId: Number(raw?.user_id ?? 0),
          username: String(raw?.username ?? 'Unknown'),
          body: String(raw?.body ?? ''),
          createdAt: createdAtValue,
        };
      })
      .filter((message) => Number.isFinite(message.id) && message.id > 0 && message.body);
  }, []);

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
    (incoming, { position = 'append' } = {}) => {
      if (!incoming?.length) {
        return;
      }
      const known = messageIdsRef.current;
      const fresh = [];
      for (const message of incoming) {
        if (!known.has(message.id)) {
          known.add(message.id);
          fresh.push(message);
        }
      }
      if (!fresh.length) {
        return;
      }
      setMessages((prev) => {
        const next = position === 'prepend' ? [...fresh, ...prev] : [...prev, ...fresh];
        next.sort((a, b) => a.id - b.id);
        return next;
      });
      if (position === 'append' && autoScrollRef.current) {
        scrollToBottom('smooth');
      }
    },
    [scrollToBottom],
  );

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
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMessages, scrollToBottom]);

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
    });

    return () => {
      socket.off('chat:message');
      socket.disconnect();
      socketRef.current = null;
    };
  }, [baseUrl, ingestMessages, normalizeMessages]);

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

  const submitMessage = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isSending) {
      return;
    }
    setSendError(null);
    setIsSending(true);
    autoScrollRef.current = true;
    try {
      const response = await fetch(`${baseUrl}/chat/messages`, {
        method: 'POST',
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
        const message = payload?.error || `Failed to send message (${response.status})`;
        throw new Error(message);
      }
      setInputValue('');
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Unable to send message');
    } finally {
      setIsSending(false);
    }
  }, [baseUrl, inputValue, isSending, onUnauthorized]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950/70">
      <header className="flex items-center justify-between border-b border-zinc-900/80 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Live Chat</h2>
          <p className="text-xs text-zinc-400">Messages update in real-time over WebSockets</p>
        </div>
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
              className="text-xs font-semibold text-amber-400 transition hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? 'Loading earlier messages…' : 'Load earlier messages'}
            </button>
          </div>
        ) : null}

        {loadingInitial && !messages.length ? (
          <InitialSkeleton />
        ) : null}

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
            <MessageBubble message={message} currentUserId={user.id} />
          </LazyRender>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-zinc-900/80 bg-zinc-950/80 px-6 py-4">
        <textarea
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          rows={2}
          placeholder="Send a message…"
          className="h-20 w-full resize-none rounded-2xl border border-zinc-800 bg-zinc-900/90 px-4 py-3 text-sm text-zinc-100 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/40"
          disabled={connectionState !== 'connected' && connectionState !== 'connecting'}
        />
        <div className="mt-3 flex items-center justify-between gap-2 text-xs">
          {sendError ? <span className="text-rose-200">{sendError}</span> : <span className="text-zinc-500">Shift+Enter for a newline</span>}
          <button
            type="submit"
            disabled={isSending || !inputValue.trim()}
            className="inline-flex items-center rounded-full bg-amber-500 px-4 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {isSending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message, currentUserId }) {
  const isSelf = message.userId === currentUserId;
  const containerClass = isSelf ? 'justify-end' : 'justify-start';
  const bubbleClass = isSelf
    ? 'bg-zinc-800/80 text-zinc-100 border border-zinc-700'
    : 'bg-zinc-900/80 text-zinc-100 border border-zinc-800';
  const usernameClass = 'text-zinc-400';

  return (
    <div className={`flex ${containerClass}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-md shadow-black/30 ${bubbleClass}`}>
        <div className="flex items-center justify-between gap-4">
          <span className={`text-xs font-semibold uppercase tracking-wide ${usernameClass}`}>{message.username}</span>
          <span className="text-[10px] uppercase tracking-wide text-zinc-400">{formatTimestamp(message.createdAt)}</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{message.body}</p>
      </div>
    </div>
  );
}

function MessageSkeleton({ alignment }) {
  const justify = alignment === 'right' ? 'justify-end' : 'justify-start';
  return (
    <div className={`flex ${justify}`}>
      <div className="h-16 w-4/5 max-w-[85%] animate-pulse rounded-2xl bg-zinc-900/60" />
    </div>
  );
}

function InitialSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className={`flex ${index % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
          <div className="h-16 w-4/5 max-w-[85%] animate-pulse rounded-2xl bg-zinc-900/60" />
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
