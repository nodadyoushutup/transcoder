import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFaceSmile, faPen, faTrash, faTimesCircle } from '@fortawesome/free-solid-svg-icons';
import { io } from 'socket.io-client';
import emojiDictionary from 'emoji-dictionary';
import LazyRender from './LazyRender.jsx';
import notificationSound from '../audio/notification_chat.mp3';
import { fetchChatMentions } from '../lib/api.js';
import EmojiPicker from './EmojiPicker.jsx';

const MESSAGE_LIMIT = 50;
const MAX_ATTACHMENTS = 6;
const TOP_SCROLL_THRESHOLD = 120;
const BOTTOM_SCROLL_THRESHOLD = 160;
const EMOJI_REGEX = /:[a-z0-9_+\-]+:/gi;
const URL_REGEX = /https?:\/\/[^\s<]+/gi;
const MAX_EMOJI_SUGGESTIONS = 8;
const MAX_MENTION_SUGGESTIONS = 8;

const SOUND_MODULES = import.meta.glob('../audio/*', { eager: true, import: 'default', query: '?url' });
const SOUND_URLS = Object.entries(SOUND_MODULES).reduce((acc, [path, url]) => {
  const fileName = path.split('/').pop();
  if (fileName) {
    acc[fileName] = url;
  }
  return acc;
}, {});
const DEFAULT_NOTIFICATION_SOUND = SOUND_URLS['notification_chat.mp3'] || notificationSound;

function emojifyText(segment) {
  return segment.replace(EMOJI_REGEX, (code) => {
    const name = code.slice(1, -1).toLowerCase();
    const emoji = emojiDictionary.getUnicode(name);
    return emoji || code;
  });
}

function renderMessageContent(body, keyPrefix = 'seg', mentions = []) {
  if (!body) {
    return null;
  }
  const nodes = [];
  let lastIndex = 0;
  let segmentIndex = 0;
  const mentionSet = new Set(
    Array.isArray(mentions) ? mentions.map((mention) => mention.toLowerCase()) : [],
  );
  body.replace(URL_REGEX, (match, offset) => {
    if (offset > lastIndex) {
      const text = body.slice(lastIndex, offset);
      nodes.push(
        ...renderTextSegment(text, `${keyPrefix}-text-${(segmentIndex += 1)}`, mentionSet),
      );
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
    nodes.push(...renderTextSegment(text, `${keyPrefix}-tail`, mentionSet));
  }
  return nodes.length ? nodes : null;
}

function renderTextSegment(text, keyPrefix, mentionSet) {
  const emojiText = emojifyText(text);
  const lines = emojiText.split(/\n/);
  const parts = [];
  lines.forEach((line, index) => {
    const segments = mentionSet && mentionSet.size
      ? line.split(/(\B@[a-z0-9_\-]+)/gi).map((segment, segmentIndex) => {
          if (/^@[a-z0-9_\-]+$/i.test(segment)) {
            const bare = segment.slice(1).toLowerCase();
            if (mentionSet.has(bare)) {
              return (
                <span
                  key={`${keyPrefix}-mention-${index}-${segmentIndex}`}
                  className="font-semibold text-amber-300"
                >
                  {segment}
                </span>
              );
            }
          }
          return (
            <span key={`${keyPrefix}-text-${index}-${segmentIndex}`}>{segment}</span>
          );
        })
      : [<span key={`${keyPrefix}-text-${index}-0`}>{line}</span>];
    parts.push(
      <span key={`${keyPrefix}-line-${index}`} className="whitespace-pre-wrap break-words">
        {segments}
      </span>,
    );
    if (index < lines.length - 1) {
      parts.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
  });
  return parts;
}

export default function ChatPanel({
  backendBase,
  user,
  viewer,
  viewerReady,
  loadingViewer,
  onUnauthorized,
  chatPreferences,
}) {
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
  const [emojiSuggestions, setEmojiSuggestions] = useState(null);
  const [mentionCandidates, setMentionCandidates] = useState([]);
  const [mentionSuggestions, setMentionSuggestions] = useState(null);
  const [composerPickerOpen, setComposerPickerOpen] = useState(false);
  const [reactionPicker, setReactionPicker] = useState(null);

  const listRef = useRef(null);
  const socketRef = useRef(null);
  const messageIdsRef = useRef(new Set());
  const autoScrollRef = useRef(true);
  const composerRef = useRef(null);
  const attachmentIdRef = useRef(0);
  const notificationAudioRef = useRef(null);
  const historyReadyRef = useRef(false);
  const composerSelectionRef = useRef({ start: 0, end: 0 });
  const composerControlsRef = useRef(null);

  const baseUrl = useMemo(() => backendBase.replace(/\/$/, ''), [backendBase]);
  const currentUserId = user?.id ?? null;
  const currentSenderKey = useMemo(() => {
    if (viewer?.senderKey) {
      return viewer.senderKey;
    }
    if (currentUserId != null) {
      return `user:${currentUserId}`;
    }
    return null;
  }, [viewer?.senderKey, currentUserId]);
  const viewerDisplayName = viewer?.displayName || user?.username || 'Viewer';
  const viewerKind = viewer?.kind || (currentUserId != null ? 'user' : 'guest');
  const connectionReady = connectionState === 'connected' || connectionState === 'connecting';
  const composerDisabled = !currentSenderKey || !connectionReady;
  const emojiList = useMemo(() => {
    const namesSource = Array.isArray(emojiDictionary.names)
      ? emojiDictionary.names
      : Object.keys(emojiDictionary.emoji || {});
    const unique = Array.from(new Set(namesSource));
    return unique
      .map((name) => {
        const unicode = emojiDictionary.getUnicode(name);
        if (!unicode) {
          return null;
        }
        return {
          name,
          unicode,
          colon: `:${name}:`,
        };
      })
      .filter(Boolean);
  }, []);

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

  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el || typeof window === 'undefined') {
      return;
    }
    const styles = window.getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const padding = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const border = (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
    const minHeight = lineHeight + padding + border;
    const maxHeight = lineHeight * 3 + padding + border;
    el.style.height = 'auto';
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${Math.max(newHeight, minHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  const insertEmojiAtCursor = useCallback(
    (emojiChar) => {
      const { start, end } = composerSelectionRef.current;
      setInputValue((current) => {
        const before = current.slice(0, start);
        const after = current.slice(end);
        const nextValue = `${before}${emojiChar}${after}`;
        const caret = before.length + emojiChar.length;
        requestAnimationFrame(() => {
          if (composerRef.current) {
            composerRef.current.focus();
            composerRef.current.setSelectionRange(caret, caret);
          }
          composerSelectionRef.current = { start: caret, end: caret };
          setEmojiSuggestions(null);
          resizeComposer();
        });
        return nextValue;
      });
    },
    [resizeComposer],
  );

  const updateEmojiSuggestions = useCallback(
    (value, caretPosition) => {
      const activeValue = value ?? '';
      if (caretPosition == null) {
        setEmojiSuggestions(null);
        return;
      }
      const substring = activeValue.slice(0, caretPosition);
      const colonIndex = substring.lastIndexOf(':');
      if (colonIndex === -1) {
        setEmojiSuggestions(null);
        return;
      }
      if (colonIndex > 0) {
        const prevChar = substring.charAt(colonIndex - 1);
        if (prevChar && /[^\s]/.test(prevChar)) {
          setEmojiSuggestions(null);
          return;
        }
      }
      const query = substring.slice(colonIndex + 1);
      if (/[^a-z0-9_+\-]/i.test(query)) {
        setEmojiSuggestions(null);
        return;
      }
      const lowered = query.toLowerCase();
      const suggestions = emojiList
        .filter((emoji) => emoji.name.startsWith(lowered))
        .slice(0, MAX_EMOJI_SUGGESTIONS);
      if (!suggestions.length) {
        setEmojiSuggestions(null);
        return;
      }
      setMentionSuggestions(null);
      setEmojiSuggestions({
        start: colonIndex,
        end: caretPosition,
        query: lowered,
        suggestions,
        activeIndex: 0,
      });
    },
    [emojiList],
  );

  const applyEmojiSuggestion = useCallback(
    (emoji) => {
      if (!emoji || !emojiSuggestions) {
        return;
      }
      const replacement = emoji.unicode || emoji.colon || '';
      const startIndex = emojiSuggestions.start;
      const endIndex = emojiSuggestions.end;
      setInputValue((current) => {
        const before = current.slice(0, startIndex);
        const after = current.slice(endIndex);
        const nextValue = `${before}${replacement}${after}`;
        const caret = before.length + replacement.length;
        requestAnimationFrame(() => {
          if (composerRef.current) {
            composerRef.current.focus();
            composerRef.current.setSelectionRange(caret, caret);
          }
          composerSelectionRef.current = { start: caret, end: caret };
          resizeComposer();
        });
        return nextValue;
      });
      setEmojiSuggestions(null);
    },
    [emojiSuggestions, resizeComposer],
  );

  const updateMentionSuggestions = useCallback(
    (value, caretPosition) => {
      if (!mentionCandidates.length) {
        setMentionSuggestions(null);
        return;
      }
      if (caretPosition == null) {
        setMentionSuggestions(null);
        return;
      }
      const text = value ?? '';
      const substring = text.slice(0, caretPosition);
      const atIndex = substring.lastIndexOf('@');
      if (atIndex === -1) {
        setMentionSuggestions(null);
        return;
      }
      if (atIndex > 0) {
        const prevChar = substring.charAt(atIndex - 1);
        if (prevChar && /[^\s]/.test(prevChar)) {
          setMentionSuggestions(null);
          return;
        }
      }
      const query = substring.slice(atIndex + 1);
      if (/[^a-z0-9_\-]/i.test(query)) {
        setMentionSuggestions(null);
        return;
      }
      const lowered = query.toLowerCase();
      const suggestions = mentionCandidates
        .filter((candidate) => candidate.username.toLowerCase().startsWith(lowered))
        .slice(0, MAX_MENTION_SUGGESTIONS);
      if (!suggestions.length) {
        setMentionSuggestions(null);
        return;
      }
      setEmojiSuggestions(null);
      setMentionSuggestions({
        start: atIndex,
        end: caretPosition,
        query: lowered,
        suggestions,
        activeIndex: 0,
      });
    },
    [mentionCandidates],
  );

  const applyMentionSuggestion = useCallback(
    (candidate) => {
      if (!candidate || !mentionSuggestions) {
        return;
      }
      const replacement = `@${candidate.username}`;
      const startIndex = mentionSuggestions.start;
      const endIndex = mentionSuggestions.end;
      setInputValue((current) => {
        const before = current.slice(0, startIndex);
        const after = current.slice(endIndex);
        const needsSpace = after.length === 0 || !/^\s/.test(after);
        const insertion = needsSpace ? `${replacement} ` : replacement;
        const nextValue = `${before}${insertion}${after}`;
        const caret = before.length + insertion.length;
        requestAnimationFrame(() => {
          if (composerRef.current) {
            composerRef.current.focus();
            composerRef.current.setSelectionRange(caret, caret);
          }
          composerSelectionRef.current = { start: caret, end: caret };
          setMentionSuggestions(null);
          resizeComposer();
        });
        return nextValue;
      });
    },
    [mentionSuggestions, resizeComposer],
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
          const reactions = Array.isArray(raw?.reactions)
            ? raw.reactions
                .map((reaction) => {
                  const emoji = reaction?.emoji ?? '';
                  if (!emoji) {
                    return null;
                  }
                  const userIds = Array.isArray(reaction?.user_ids)
                    ? reaction.user_ids.map((id) => Number(id))
                    : [];
                  const usernames = Array.isArray(reaction?.users)
                    ? reaction.users.map(String)
                    : [];
                  return {
                    emoji,
                    count: Number(reaction?.count ?? 0),
                    userIds,
                    usernames,
                    reacted: currentUserId != null && userIds.includes(currentUserId),
                  };
                })
                .filter(Boolean)
            : [];

          const senderKey = typeof raw?.sender_key === 'string' && raw.sender_key ? raw.sender_key : null;
          const isGuest = Boolean(raw?.is_guest);
          const mentions = Array.isArray(raw?.mentions)
            ? raw.mentions
                .map((mention) => {
                  const userId = Number(mention?.user_id ?? 0);
                  const username = String(mention?.username ?? '');
                  if (!userId || !username) {
                    return null;
                  }
                  return {
                    userId,
                    username,
                  };
                })
                .filter(Boolean)
            : [];
          const mentionsMe = currentUserId != null && mentions.some((mention) => mention.userId === currentUserId);
          const avatarRelative = typeof raw?.user_avatar_url === 'string' ? raw.user_avatar_url : null;
          const avatarUrl = avatarRelative
            ? avatarRelative.startsWith('http')
              ? avatarRelative
              : `${baseUrl}${avatarRelative.startsWith('/') ? '' : '/'}${avatarRelative}`
            : null;

          return {
            id,
            userId: Number(raw?.user_id ?? 0),
            username: String(raw?.username ?? 'Unknown'),
            senderKey,
            isGuest,
            body: String(raw?.body ?? ''),
            createdAt: createdAtValue,
            updatedAt: updatedAtValue,
            attachments,
            reactions,
            mentions,
            mentionsMe,
            userAvatarUrl: avatarUrl,
            isSelf: Boolean(senderKey && currentSenderKey && senderKey === currentSenderKey),
          };
        })
        .filter((message) => Number.isFinite(message.id) && message.id > 0);
    },
    [baseUrl, currentUserId, currentSenderKey],
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
    const soundKey = chatPreferences?.notification_sound;
    const soundUrl = SOUND_URLS[soundKey] || DEFAULT_NOTIFICATION_SOUND;
    const volume = Math.max(0, Math.min(1, Number(chatPreferences?.notification_volume ?? 0.5)));
    const audio = new Audio(soundUrl);
    audio.volume = volume;
    notificationAudioRef.current = audio;
    return () => {
      audio.pause();
      notificationAudioRef.current = null;
    };
  }, [chatPreferences]);

  useEffect(() => {
    let ignore = false;
    if (!user) {
      setMentionCandidates([]);
      setMentionSuggestions(null);
      return () => {
        ignore = true;
      };
    }
    (async () => {
      try {
        const data = await fetchChatMentions();
        if (ignore) {
          return;
        }
        const users = Array.isArray(data?.users)
          ? data.users
              .map((entry) => {
                const id = Number(entry?.id ?? 0);
                const username = String(entry?.username ?? '');
                if (!id || !username) {
                  return null;
                }
                const relativeAvatar = typeof entry?.avatar_url === 'string' ? entry.avatar_url : null;
                const avatarUrl = relativeAvatar
                  ? relativeAvatar.startsWith('http')
                    ? relativeAvatar
                    : `${BACKEND_BASE}${relativeAvatar.startsWith('/') ? '' : '/'}${relativeAvatar}`
                  : null;
                return {
                  id,
                  username,
                  avatarUrl,
                  isAdmin: Boolean(entry?.is_admin),
                };
              })
              .filter(Boolean)
          : [];
        setMentionCandidates(users);
      } catch {
        if (!ignore) {
          setMentionCandidates([]);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [user]);

  const playNotification = useCallback(
    (incomingMessages) => {
      if (!historyReadyRef.current || !incomingMessages?.length) {
        return;
      }
      const scope = chatPreferences?.notify_scope || 'mentions';
      if (scope === 'none') {
        return;
      }
      const shouldNotify = incomingMessages.some((message) => {
        if (message.isSelf) {
          return false;
        }
        if (scope === 'mentions') {
          return Boolean(message.mentionsMe);
        }
        return true;
      });
      if (!shouldNotify) {
        return;
      }
      const audio = notificationAudioRef.current;
      if (!audio) {
        return;
      }
      const volume = Math.max(0, Math.min(1, Number(chatPreferences?.notification_volume ?? audio.volume)));
      audio.volume = volume;
      try {
        audio.currentTime = 0;
        void audio.play().catch(() => {});
      } catch {
        /* noop */
      }
    },
    [chatPreferences],
  );

  useEffect(() => {
    setMessages((existing) =>
      existing.map((message) => ({
        ...message,
        isSelf: Boolean(message.senderKey && currentSenderKey && message.senderKey === currentSenderKey),
      })),
    );
  }, [currentSenderKey]);

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
    if (!currentSenderKey) {
      setSendError('Preparing chat session…');
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
        setEmojiSuggestions(null);
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
        setEmojiSuggestions(null);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Unable to send message');
    } finally {
      setIsSending(false);
    }
  }, [
    baseUrl,
    clearPendingAttachments,
    currentSenderKey,
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
      if (mentionSuggestions?.suggestions?.length) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setMentionSuggestions((prev) => {
            if (!prev) return prev;
            const nextIndex = (prev.activeIndex + 1) % prev.suggestions.length;
            return { ...prev, activeIndex: nextIndex };
          });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setMentionSuggestions((prev) => {
            if (!prev) return prev;
            const nextIndex = (prev.activeIndex - 1 + prev.suggestions.length) % prev.suggestions.length;
            return { ...prev, activeIndex: nextIndex };
          });
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const active = mentionSuggestions.suggestions[mentionSuggestions.activeIndex];
          applyMentionSuggestion(active);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setMentionSuggestions(null);
          return;
        }
      }
      if (emojiSuggestions?.suggestions?.length) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setEmojiSuggestions((prev) => {
            if (!prev) return prev;
            const nextIndex = (prev.activeIndex + 1) % prev.suggestions.length;
            return { ...prev, activeIndex: nextIndex };
          });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setEmojiSuggestions((prev) => {
            if (!prev) return prev;
            const nextIndex = (prev.activeIndex - 1 + prev.suggestions.length) % prev.suggestions.length;
            return { ...prev, activeIndex: nextIndex };
          });
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const active = emojiSuggestions.suggestions[emojiSuggestions.activeIndex];
          applyEmojiSuggestion(active);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setEmojiSuggestions(null);
          return;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void submitMessage();
      }
    },
    [applyEmojiSuggestion, applyMentionSuggestion, emojiSuggestions, mentionSuggestions, submitMessage],
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

  const sendReaction = useCallback(
    async (messageId, emoji, method) => {
      try {
        const response = await fetch(`${baseUrl}/chat/messages/${messageId}/reactions`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ emoji }),
        });
        if (response.status === 401) {
          onUnauthorized?.();
          return false;
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const message = payload?.error || `Reaction request failed (${response.status})`;
          throw new Error(message);
        }
        return true;
      } catch (error) {
        setSendError(error instanceof Error ? error.message : 'Reaction failed');
        return false;
      }
    },
    [baseUrl, onUnauthorized],
  );

  const handleReactionToggle = useCallback(
    async (message, reaction) => {
      const emoji = reaction?.emoji;
      if (!emoji) {
        return;
      }
      const method = reaction.reacted ? 'DELETE' : 'POST';
      await sendReaction(message.id, emoji, method);
      setReactionPicker(null);
    },
    [sendReaction],
  );

  const handleReactionSelection = useCallback(
    async (messageId, emoji) => {
      if (!emoji?.unicode) {
        return;
      }
      setReactionPicker(null);
      await sendReaction(messageId, emoji.unicode, 'POST');
    },
    [sendReaction],
  );

  const handleOpenReactionPicker = useCallback((messageId, anchorRect) => {
    setReactionPicker({
      messageId,
      left: Math.min(window.innerWidth - 280, Math.max(8, anchorRect.left - 128)),
      top: Math.max(8, anchorRect.top - 260),
    });
    setComposerPickerOpen(false);
  }, []);

  const handleComposerChange = useCallback(
    (event) => {
      const { value, selectionStart, selectionEnd } = event.target;
      setInputValue(value);
      composerSelectionRef.current = {
        start: selectionStart ?? value.length,
        end: selectionEnd ?? value.length,
      };
      setSendError(null);
      updateEmojiSuggestions(value, selectionStart ?? value.length);
      updateMentionSuggestions(value, selectionStart ?? value.length);
      requestAnimationFrame(resizeComposer);
    },
    [resizeComposer, updateEmojiSuggestions, updateMentionSuggestions],
  );

  const handleComposerSelectionUpdate = useCallback(
    (event) => {
      const { selectionStart, selectionEnd, value } = event.target;
      composerSelectionRef.current = {
        start: selectionStart ?? 0,
        end: selectionEnd ?? 0,
      };
      updateEmojiSuggestions(value, selectionStart ?? 0);
      updateMentionSuggestions(value, selectionStart ?? 0);
      requestAnimationFrame(resizeComposer);
    },
    [resizeComposer, updateEmojiSuggestions, updateMentionSuggestions],
  );

  useEffect(() => () => {
    clearPendingAttachments();
  }, [clearPendingAttachments]);

  useEffect(() => {
    resizeComposer();
  }, [resizeComposer, inputValue, pendingAttachments]);

  useEffect(() => {
    if (!composerPickerOpen) {
      return () => {};
    }
    const handler = (event) => {
      if (composerControlsRef.current?.contains(event.target)) {
        return;
      }
      setComposerPickerOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
    };
  }, [composerPickerOpen]);

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

  const composerPlaceholder = editingMessageId
    ? 'Edit your message…'
    : `Send a message as ${viewerDisplayName}`;
  const sendButtonLabel = editingMessageId ? 'Save' : 'Send';
  const canSubmit = editingMessageId
    ? Boolean(inputValue.trim())
    : Boolean(inputValue.trim()) || pendingAttachments.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950/70">
      <header className="flex items-center justify-between border-b border-zinc-900/80 px-6 py-4">
        <h2 className="text-lg font-semibold text-zinc-100">Live Chat</h2>
        <div className="flex flex-col items-end gap-1 text-xs text-zinc-400">
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${connectionBadge.classes}`}>
            {connectionBadge.label}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            {viewerKind === 'guest' ? `Guest · ${viewerDisplayName}` : `User · ${viewerDisplayName}`}
          </span>
        </div>
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
            placeholder={<MessageSkeleton alignment={message.isSelf ? 'right' : 'left'} />}
            className="block"
          >
            <div className={`flex ${message.isSelf ? 'justify-end' : 'justify-start'}`}>
              <div className={`flex items-start gap-3 ${message.isSelf ? 'flex-row-reverse' : ''}`}>
                <MessageAvatar message={message} />
                <MessageBubble
                  message={message}
                  canModify={Boolean(user?.is_admin) || (currentUserId != null && message.userId === currentUserId)}
                  canReact={currentUserId != null}
                  onEdit={startEditingMessage}
                  onDelete={handleDeleteMessage}
                  onToggleReaction={currentUserId != null ? handleReactionToggle : null}
                  onOpenReactionPicker={currentUserId != null ? handleOpenReactionPicker : null}
                />
              </div>
            </div>
          </LazyRender>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-zinc-900/80 bg-zinc-950/80 px-6 py-4">
        <div className="relative">
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
            onChange={handleComposerChange}
            onKeyDown={handleComposerKeyDown}
            onKeyUp={handleComposerSelectionUpdate}
            onClick={handleComposerSelectionUpdate}
            onSelect={handleComposerSelectionUpdate}
            onFocus={handleComposerSelectionUpdate}
            onPaste={handlePaste}
            rows={1}
            placeholder={composerPlaceholder}
            className="max-h-[144px] w-full rounded-2xl border border-zinc-800 bg-zinc-900/90 px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-400/60"
            style={{ resize: 'none' }}
            disabled={composerDisabled}
          />

          {emojiSuggestions?.suggestions?.length ? (
            <div className="absolute bottom-24 left-0 z-30 w-56 rounded-2xl border border-zinc-800 bg-zinc-900/95 p-2 shadow-2xl">
              {emojiSuggestions.suggestions.map((emoji, index) => (
                <button
                  key={emoji.name}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyEmojiSuggestion(emoji);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs transition ${
                    index === emojiSuggestions.activeIndex ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  <span className="text-lg">{emoji.unicode}</span>
                  <span className="text-[11px] text-zinc-400">{emoji.colon}</span>
                </button>
              ))}
            </div>
          ) : null}

          {mentionSuggestions?.suggestions?.length ? (
            <div className="absolute bottom-24 right-0 z-30 w-64 rounded-2xl border border-zinc-800 bg-zinc-900/95 p-2 shadow-2xl">
              {mentionSuggestions.suggestions.map((candidate, index) => (
                <button
                  key={candidate.id}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMentionSuggestion(candidate);
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-xs transition ${
                    index === mentionSuggestions.activeIndex
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-zinc-800 bg-zinc-900 text-xs font-semibold text-amber-200">
                    {candidate.avatarUrl ? (
                      <img
                        src={candidate.avatarUrl}
                        alt={`${candidate.username} avatar`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      candidate.username.charAt(0).toUpperCase()
                    )}
                  </span>
                  <span className="flex-1 text-left">@{candidate.username}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div ref={composerControlsRef} className="mt-3 flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setComposerPickerOpen((prev) => !prev)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 transition hover:bg-zinc-700"
                title="Insert emoji"
              >
                <FontAwesomeIcon icon={faFaceSmile} />
              </button>
              {sendError ? (
                <span className="text-rose-200">{sendError}</span>
              ) : (
                <span className="text-zinc-500">
                  {loadingViewer && viewerKind === 'guest' ? 'Preparing guest session…' : 'Shift+Enter for newline'}
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={isSending || !canSubmit || composerDisabled}
              className="inline-flex items-center rounded-full bg-zinc-200 px-4 py-1.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {isSending ? 'Sending…' : sendButtonLabel}
            </button>
          </div>

          {composerPickerOpen ? (
            <EmojiPicker
              emojis={emojiList}
              onSelect={(emoji) => insertEmojiAtCursor(emoji.unicode || emoji.colon || '')}
              onClose={() => setComposerPickerOpen(false)}
              style={{ position: 'absolute', right: 0, bottom: '3.5rem' }}
            />
          ) : null}
        </div>
      </form>

      {reactionPicker ? (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={() => setReactionPicker(null)} />
          <EmojiPicker
            emojis={emojiList}
            onSelect={(emoji) => handleReactionSelection(reactionPicker.messageId, emoji)}
            onClose={() => setReactionPicker(null)}
            style={{ position: 'fixed', left: reactionPicker.left, top: reactionPicker.top }}
          />
        </>
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  canModify,
  canReact = false,
  onEdit,
  onDelete,
  onToggleReaction,
  onOpenReactionPicker,
}) {
  const isSelf = Boolean(message.isSelf);
  const baseBubbleClass = isSelf
    ? 'bg-zinc-800/80 text-zinc-100 border border-zinc-700'
    : 'bg-zinc-900/80 text-zinc-100 border border-zinc-800';
  const isEdited = message.updatedAt && Math.abs(message.updatedAt - message.createdAt) > 1000;
  const highlightClass = message.mentionsMe
    ? 'border-amber-400 bg-amber-500/25 text-amber-50 shadow-amber-500/30'
    : '';
  const bubbleClass = `${baseBubbleClass} ${highlightClass}`.trim();
  const usernameClass = message.mentionsMe ? 'text-amber-200' : 'text-zinc-400';

  return (
    <div className={`group relative max-w-[70vw] rounded-2xl px-4 py-3 shadow-md shadow-black/30 ${bubbleClass}`}>
      <div className="pointer-events-none absolute -right-2 -top-3 flex gap-2 opacity-0 transition group-hover:opacity-100">
        {canReact ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenReactionPicker?.(message.id, event.currentTarget.getBoundingClientRect());
            }}
            className="pointer-events-auto rounded-full bg-zinc-900/90 p-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
          >
            <FontAwesomeIcon icon={faFaceSmile} />
          </button>
        ) : null}
        {canModify ? (
          <>
            <button
              type="button"
              onClick={() => onEdit(message)}
              className="pointer-events-auto rounded-full bg-zinc-900/90 p-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
            >
              <FontAwesomeIcon icon={faPen} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(message.id)}
              className="pointer-events-auto rounded-full bg-zinc-900/90 p-1 text-xs text-zinc-200 transition hover:bg-zinc-800"
            >
              <FontAwesomeIcon icon={faTrash} />
            </button>
          </>
        ) : null}
      </div>
      <div className="flex items-start justify-between gap-4">
        <span className={`text-xs font-semibold uppercase tracking-wide ${usernameClass}`}>{message.username}</span>
        <span className={`text-[10px] tracking-wide ${message.mentionsMe ? 'text-amber-100' : 'text-zinc-400'}`}>
          {formatTimestamp(message.createdAt)}
          {isEdited ? <span className="ml-2 lowercase text-zinc-500">edited</span> : null}
        </span>
      </div>
      {message.body ? (
        <div className="mt-2 text-sm leading-relaxed text-zinc-100">
          {renderMessageContent(
            message.body,
            `msg-${message.id}`,
            Array.isArray(message.mentions) ? message.mentions.map((mention) => mention.username) : [],
          )}
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
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {message.reactions?.map((reaction) => {
          const reactedClass = reaction.reacted
            ? 'border-zinc-500 bg-zinc-700/70 text-white'
            : 'border-zinc-700 bg-zinc-800/50 text-zinc-200 hover:border-zinc-500';
          return (
            <button
              key={`${message.id}-${reaction.emoji}`}
              type="button"
              onClick={(event) => {
                if (!canReact) {
                  event.preventDefault();
                  return;
                }
                event.stopPropagation();
                onToggleReaction?.(message, reaction);
              }}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition ${reactedClass} ${
                canReact ? '' : 'cursor-not-allowed opacity-60'
              }`}
              title={reaction.usernames.length ? reaction.usernames.join(', ') : 'No reactions yet'}
              disabled={!canReact}
            >
              <span className="text-base">{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          );
        })}
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

function MessageAvatar({ message }) {
  const avatarUrl = message.userAvatarUrl;
  const initial = (message.username || 'U').charAt(0).toUpperCase();
  if (avatarUrl) {
    return (
      <div className="mt-1 h-10 w-10 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900">
        <img src={avatarUrl} alt={`${message.username} avatar`} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="mt-1 flex h-10 w-10 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-xs font-semibold text-amber-200">
      {initial}
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
    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
    const timeFormatter = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const zonePart = new Intl.DateTimeFormat(undefined, {
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value;
    const dateText = dateFormatter.format(date);
    const timeText = timeFormatter.format(date);
    return `${dateText} · ${timeText}${zonePart ? ` ${zonePart}` : ''}`;
  } catch {
    return date.toLocaleTimeString();
  }
}
