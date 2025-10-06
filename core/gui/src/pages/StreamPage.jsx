import * as dashjsModule from 'dashjs';
import 'vtt.js';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faComments, faGaugeHigh, faSliders, faUsers } from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ControlPanel from '../components/ControlPanel.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import ViewerPanel from '../components/ViewerPanel.jsx';
import DockNav from '../components/navigation/DockNav.jsx';
import StatusPanel from '../components/StatusPanel.jsx';
import MetadataPanel from '../components/MetadataPanel.jsx';
import PlayerControlBar from '../components/PlayerControlBar.jsx';
import { fetchCurrentPlayback, fetchPlayerSettings, playQueue, skipQueue } from '../lib/api.js';
import { BACKEND_BASE, DEFAULT_STREAM_URL } from '../lib/env.js';

let cachedDashjs = null;

function resolveDashjs() {
  if (cachedDashjs?.MediaPlayer) {
    return cachedDashjs;
  }
  if (dashjsModule?.MediaPlayer) {
    cachedDashjs = dashjsModule;
    return cachedDashjs;
  }
  if (dashjsModule?.default?.MediaPlayer) {
    cachedDashjs = dashjsModule.default;
    return cachedDashjs;
  }
  if (typeof window !== 'undefined' && window.dashjs?.MediaPlayer) {
    cachedDashjs = window.dashjs;
    return cachedDashjs;
  }
  return null;
}

function getDashEvents() {
  return resolveDashjs()?.MediaPlayer?.events ?? null;
}

const SIDEBAR_TABS = [
  { id: 'chat', label: 'Chat', icon: () => <FontAwesomeIcon icon={faComments} size="lg" /> },
  { id: 'metadata', label: 'Metadata', icon: () => <FontAwesomeIcon icon={faCircleInfo} size="lg" /> },
  { id: 'viewers', label: 'Viewers', icon: () => <FontAwesomeIcon icon={faUsers} size="lg" /> },
  { id: 'status', label: 'Status', icon: () => <FontAwesomeIcon icon={faGaugeHigh} size="lg" /> },
  { id: 'control', label: 'Control', icon: () => <FontAwesomeIcon icon={faSliders} size="lg" /> },
];

const SIDEBAR_STORAGE_KEY = 'stream.sidebarTab';
const MAX_PLAYER_ATTACH_ATTEMPTS = 10;
const ATTACH_RETRY_DELAY_MS = 400;
const DETAILED_STATUS_PERMISSION = 'stream.status.view_detailed';
const DEFAULT_ATTACH_MIN_SEGMENTS = 3;
const MANIFEST_CACHE_TTL_MS = 1000;

const spinnerMessage = (text) => (
  <span
    data-indicator="custom"
    className="inline-flex items-center gap-2"
  >
    <span className="relative inline-flex h-3 w-3">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-current" />
    </span>
    <span>{text}</span>
  </span>
);

function normalizeDiagnosticMessage(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeDiagnosticMessage(item))
      .filter(Boolean);
    return normalized.length > 0 ? normalized.join(', ') : null;
  }
  if (typeof value === 'object') {
    const candidates = ['message', 'reason', 'error', 'description', 'detail'];
    for (const key of candidates) {
      const candidateValue = value[key];
      if (candidateValue && candidateValue !== value) {
        const normalized = normalizeDiagnosticMessage(candidateValue);
        if (normalized) {
          return normalized;
        }
      }
    }
    if (typeof value.id === 'string' && value.id.trim()) {
      return value.id;
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}') {
        return json;
      }
    } catch {}
  }
  return null;
}

function clonePlayerConfig() {
  return {
    streaming: {
      delay: {
        liveDelay: Number.NaN,
        liveDelayFragmentCount: 10,
        useSuggestedPresentationDelay: true,
      },
      liveCatchup: {
        enabled: true,
        maxDrift: 2.0,
        playbackRate: {
          min: -0.2,
          max: 0.2,
        },
      },
      buffer: {
        fastSwitchEnabled: false,
        bufferPruningInterval: 10,
        bufferToKeep: 6,
        bufferTimeAtTopQuality: 8,
        bufferTimeAtTopQualityLongForm: 10,
      },
      text: { defaultEnabled: false, defaultLanguage: '' },
    },
  };
}

function parseManifestDetails(manifestText) {
  if (typeof manifestText !== 'string' || manifestText.trim() === '') {
    return { sessionId: null, startNumber: null, lastNumber: null, representationIds: [] };
  }
  const sessionMatch = manifestText.match(/media="[^"']*?sessions\/([^/]+)\/chunk-/i);
  const sessionId = sessionMatch && sessionMatch[1] ? sessionMatch[1] : null;
  const startMatch = manifestText.match(/startNumber\s*=\s*"(\d+)"/i);
  const startNumber = startMatch ? Number.parseInt(startMatch[1], 10) : null;

  const representationIds = new Set();
  const representationRegex = /<Representation[^>]*\bid=\"(\d+)\"/gi;
  let representationMatch;
  while ((representationMatch = representationRegex.exec(manifestText)) !== null) {
    const rawId = Number.parseInt(representationMatch[1], 10);
    if (Number.isFinite(rawId)) {
      representationIds.add(rawId);
    }
  }

  let totalSegments = 0;
  const segmentRegex = /<S\b[^>]*>/gi;
  let segmentMatch;
  while ((segmentMatch = segmentRegex.exec(manifestText)) !== null) {
    const tag = segmentMatch[0];
    const repeatMatch = tag.match(/\br\s*=\s*"(-?\d+)"/i);
    const repeatCount = repeatMatch ? Number.parseInt(repeatMatch[1], 10) : 0;
    const repeats = Number.isFinite(repeatCount) && repeatCount > 0 ? repeatCount : 0;
    totalSegments += 1 + repeats;
    if (totalSegments > 2000) {
      break;
    }
  }

  let lastNumber = null;
  if (Number.isFinite(startNumber) && totalSegments > 0) {
    lastNumber = startNumber + totalSegments - 1;
  }

  return {
    sessionId,
    startNumber: Number.isFinite(startNumber) ? startNumber : null,
    lastNumber: Number.isFinite(lastNumber) ? lastNumber : null,
    representationIds: Array.from(representationIds).sort((a, b) => a - b),
  };
}

function formatChunkNumber(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return '00000';
  }
  return numeric.toString().padStart(5, '0');
}

const DEFAULT_PLAYER_CONFIG = Object.freeze(clonePlayerConfig());

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return fallback;
}

function asClampedInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  let result = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isFinite(result)) {
    result = fallback;
  }
  if (maximum !== undefined && result > maximum) {
    result = maximum;
  }
  if (minimum !== undefined && result < minimum) {
    result = minimum;
  }
  return result;
}

function asClampedFloat(value, fallback, minimum, maximum) {
  const parsed = Number.parseFloat(value);
  let result = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isFinite(result)) {
    result = fallback;
  }
  if (maximum !== undefined && result > maximum) {
    result = maximum;
  }
  if (minimum !== undefined && result < minimum) {
    result = minimum;
  }
  return result;
}

function normalizePlayerSettings(config) {
  const base = clonePlayerConfig();
  if (!config || typeof config !== 'object') {
    return base;
  }
  const streamingInput = config.streaming ?? {};
  const delayInput = streamingInput.delay ?? {};
  const liveDelay = delayInput.liveDelay;
  if (typeof liveDelay === 'number' && Number.isFinite(liveDelay) && liveDelay >= 0) {
    base.streaming.delay.liveDelay = liveDelay;
  } else {
    base.streaming.delay.liveDelay = Number.NaN;
  }
  base.streaming.delay.liveDelayFragmentCount = asClampedInt(
    delayInput.liveDelayFragmentCount,
    base.streaming.delay.liveDelayFragmentCount,
    0,
    240,
  );
  base.streaming.delay.useSuggestedPresentationDelay = asBoolean(
    delayInput.useSuggestedPresentationDelay,
    base.streaming.delay.useSuggestedPresentationDelay,
  );

  const catchupInput = streamingInput.liveCatchup ?? {};
  base.streaming.liveCatchup.enabled = asBoolean(
    catchupInput.enabled,
    base.streaming.liveCatchup.enabled,
  );
  base.streaming.liveCatchup.maxDrift = asClampedFloat(
    catchupInput.maxDrift,
    base.streaming.liveCatchup.maxDrift,
    0,
    30,
  );
  const playbackInput = catchupInput.playbackRate ?? {};
  let rateMin = asClampedFloat(
    playbackInput.min,
    base.streaming.liveCatchup.playbackRate.min,
    -1,
    1,
  );
  let rateMax = asClampedFloat(
    playbackInput.max,
    base.streaming.liveCatchup.playbackRate.max,
    -1,
    1,
  );
  if (rateMin > rateMax) {
    const temp = rateMin;
    rateMin = rateMax;
    rateMax = temp;
  }
  base.streaming.liveCatchup.playbackRate = { min: rateMin, max: rateMax };

  const bufferInput = streamingInput.buffer ?? {};
  base.streaming.buffer.fastSwitchEnabled = asBoolean(
    bufferInput.fastSwitchEnabled,
    base.streaming.buffer.fastSwitchEnabled,
  );
  base.streaming.buffer.bufferPruningInterval = asClampedInt(
    bufferInput.bufferPruningInterval,
    base.streaming.buffer.bufferPruningInterval,
    0,
    86400,
  );
  base.streaming.buffer.bufferToKeep = asClampedInt(
    bufferInput.bufferToKeep,
    base.streaming.buffer.bufferToKeep,
    0,
    86400,
  );
  base.streaming.buffer.bufferTimeAtTopQuality = asClampedInt(
    bufferInput.bufferTimeAtTopQuality,
    base.streaming.buffer.bufferTimeAtTopQuality,
    0,
    86400,
  );
  base.streaming.buffer.bufferTimeAtTopQualityLongForm = asClampedInt(
    bufferInput.bufferTimeAtTopQualityLongForm,
    base.streaming.buffer.bufferTimeAtTopQualityLongForm,
    0,
    86400,
  );

  const textInput = streamingInput.text ?? {};
  base.streaming.text.defaultEnabled = asBoolean(
    textInput.defaultEnabled,
    base.streaming.text.defaultEnabled,
  );
  const prefLangSource =
    Object.prototype.hasOwnProperty.call(textInput, 'defaultLanguage')
      ? textInput.defaultLanguage
      : textInput.preferredLanguage;
  if (typeof prefLangSource === 'string') {
    base.streaming.text.defaultLanguage = prefLangSource.trim();
  } else if (prefLangSource == null) {
    base.streaming.text.defaultLanguage = '';
  } else {
    base.streaming.text.defaultLanguage = String(prefLangSource).trim();
  }

  return base;
}

function stripUnsupportedTextSettings(settings) {
  if (!settings?.streaming?.text) {
    return settings;
  }

  const streaming = { ...settings.streaming };
  const text = { ...streaming.text };
  delete text.defaultLanguage;
  delete text.preferredLanguage;

  return {
    ...settings,
    streaming: {
      ...streaming,
      text,
    },
  };
}

function applyTextLanguagePreference(player, textConfig = {}) {
  if (typeof player?.setInitialMediaSettingsFor !== 'function') {
    return;
  }

  const candidate =
    textConfig.defaultLanguage ??
    textConfig.preferredLanguage ??
    null;

  if (typeof candidate !== 'string') {
    return;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return;
  }

  try {
    player.setInitialMediaSettingsFor('text', { lang: trimmed });
  } catch {
    // Ignore failures; dash.js may not support this on certain builds.
  }
}

function applyPlayerSettings(player, settings, { normalized = false } = {}) {
  if (!player?.updateSettings) {
    return null;
  }

  const normalizedSettings = normalized ? settings : normalizePlayerSettings(settings);
  const sanitizedSettings = stripUnsupportedTextSettings(normalizedSettings);
  player.updateSettings(sanitizedSettings);
  applyTextLanguagePreference(player, normalizedSettings?.streaming?.text);
  return normalizedSettings;
}

function createPlayer(customSettings = DEFAULT_PLAYER_CONFIG) {
  const dashjs = resolveDashjs();
  if (!dashjs?.MediaPlayer) {
    console.error('dash.js MediaPlayer API unavailable');
    return null;
  }

  const player = dashjs.MediaPlayer().create();
  player.__isInitialized = false;
  applyPlayerSettings(player, customSettings);
  return player;
}

export default function StreamPage({
  user,
  viewer,
  viewerReady,
  loadingViewer,
  onLogout,
  onUnauthorized,
  onRequestAuth,
  showHeader = true,
  chatPreferences,
  onViewLibraryItem,
}) {
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [statusFetchError, setStatusFetchError] = useState(null);
  const [manifestUrl, setManifestUrl] = useState(DEFAULT_STREAM_URL);
  const manifestUrlRef = useRef(DEFAULT_STREAM_URL);
  const manifestSessionRef = useRef(null);
  const queueStateRef = useRef({ active: null, pending: null });
  const deferredManifestRef = useRef(null);
  const [statusInfo, setStatusInfo] = useState({ type: 'info', message: 'Initializing…' });
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [statsText, setStatsText] = useState('');
  const [currentMetadata, setCurrentMetadata] = useState(null);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [metadataError, setMetadataError] = useState(null);
  const [metadataRefreshTick, setMetadataRefreshTick] = useState(0);
  const [redisStatus, setRedisStatus] = useState({ available: false, last_error: 'Redis unavailable' });
  const [playbackClock, setPlaybackClock] = useState({ currentSeconds: 0, durationSeconds: null });
  const [queuePending, setQueuePending] = useState(false);
  const [dashDiagnostics, setDashDiagnostics] = useState([]);
  const [subtitleTracks, setSubtitleTracks] = useState([]);
  const subtitleAppliedRef = useRef(false);
  const metadataTokenRef = useRef(null);
  const metadataRetryTimerRef = useRef(null);
  const [playerSettingsTick, setPlayerSettingsTick] = useState(0);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false);
  const [activeSubtitleId, setActiveSubtitleId] = useState('off');
  const [volumeLevel, setVolumeLevel] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [bufferedPercent, setBufferedPercent] = useState(0);

  const [activeSidebarTab, setActiveSidebarTab] = useState(() => {
    if (typeof window === 'undefined') {
      return 'metadata';
    }
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === 'none') {
      return null;
    }
    if (SIDEBAR_TABS.some((tab) => tab.id === stored)) {
      return stored;
    }
    return 'metadata';
  });

  const canViewDetailedStatus = useMemo(() => {
    if (!user) {
      return false;
    }
    if (user.is_admin) {
      return true;
    }
    const permissionList = Array.isArray(user.permissions) ? user.permissions : [];
    if (permissionList.includes('*')) {
      return true;
    }
    return permissionList.includes(DETAILED_STATUS_PERMISSION);
  }, [user]);

  const pushDashDiagnostic = useCallback((type, eventLike) => {
    const timestamp = Date.now();
    const request = eventLike?.request ?? eventLike?.event?.request ?? null;
    const rawCode =
      request?.httpResponseCode ??
      request?.status ??
      eventLike?.event?.status ??
      eventLike?.status ??
      eventLike?.code ??
      null;
    const code = typeof rawCode === 'number' && Number.isFinite(rawCode)
      ? rawCode
      : Number.isFinite(Number(rawCode))
        ? Number(rawCode)
        : null;
    const mediaType =
      (typeof request?.mediaType === 'string' && request.mediaType) ||
      (typeof eventLike?.event?.mediaType === 'string' && eventLike.event.mediaType) ||
      null;
    const rawUrl =
      (typeof request?.url === 'string' && request.url) ||
      (typeof eventLike?.event?.url === 'string' && eventLike.event.url) ||
      null;
    let segment = null;
    if (rawUrl) {
      const sanitized = rawUrl.split('#')[0];
      const withoutQuery = sanitized.split('?')[0];
      const parts = withoutQuery.split('/');
      segment = parts[parts.length - 1] || withoutQuery;
    }
    const messageSource =
      eventLike?.event?.message ??
      eventLike?.event?.id ??
      eventLike?.event?.error ??
      eventLike?.message ??
      eventLike?.error ??
      null;
    const message = normalizeDiagnosticMessage(messageSource);
    const key = [type, mediaType ?? 'any', code ?? 'none', segment ?? rawUrl ?? 'unknown'].join('|');

    if (type && (type.startsWith('buffer') || (code && code >= 400))) {
      // eslint-disable-next-line no-console
      console.warn('[StreamPage] dash diagnostic', {
        type,
        code,
        mediaType,
        segment,
        rawUrl,
        message,
      });
    }

    setDashDiagnostics((prev) => {
      const matchIndex = prev.findIndex((item) => item.key === key);
      if (matchIndex !== -1) {
        const next = [...prev];
        const existing = { ...next[matchIndex] };
        existing.count += 1;
        existing.at = timestamp;
        if (message) {
          existing.message = message;
        }
        if (rawUrl) {
          existing.rawUrl = rawUrl;
        }
        next.splice(matchIndex, 1);
        next.unshift(existing);
        return next;
      }

      const entry = {
        key,
        type,
        code,
        mediaType,
        segment,
        rawUrl,
        message,
        at: timestamp,
        count: 1,
      };
      return [entry, ...prev].slice(0, 8);
    });
  }, []);

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const attachSegmentThresholdRef = useRef(DEFAULT_ATTACH_MIN_SEGMENTS);
  const segmentSessionRef = useRef(null);
  const segmentsReadyRef = useRef(false);
  const manifestSegmentsRef = useRef({
    sessionId: null,
    startNumber: null,
    lastNumber: null,
    representationIds: [],
    fetchedAt: 0,
    initVerified: false,
  });
  const pendingResetRef = useRef(false);
  const playerConfigRef = useRef(normalizePlayerSettings());
  const pollingRef = useRef(false);
  const pollTimerRef = useRef(null);
  const consecutiveOkRef = useRef(0);
  const autoStartRef = useRef(false);
  const initPlayerRef = useRef(() => {});
  const attachStateRef = useRef({ token: 0, attempts: 0, deferred: null });
  const attachingRef = useRef(false);
  const lastPidRef = useRef(null);
  const metadataInitializedRef = useRef(false);
  const playbackClockRef = useRef({ currentSeconds: 0, durationSeconds: null });

  const handleSidebarChange = useCallback((nextId) => {
    setActiveSidebarTab(nextId);
  }, []);

  const handleViewLibrary = useCallback(() => {
    if (!currentMetadata) {
      return;
    }
    const ratingKey =
      currentMetadata?.item?.rating_key ??
      currentMetadata?.details?.item?.rating_key ??
      currentMetadata?.source?.item?.rating_key ??
      null;
    if (!ratingKey) {
      return;
    }
    const librarySectionId =
      currentMetadata?.item?.library_section_id ??
      currentMetadata?.details?.item?.library_section_id ??
      currentMetadata?.source?.item?.library_section_id ??
      null;
    onViewLibraryItem?.({ ratingKey, librarySectionId });
  }, [currentMetadata, onViewLibraryItem]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, activeSidebarTab ?? 'none');
    }
  }, [activeSidebarTab]);

  const setStatusBadge = useCallback((type, message) => {
    setStatusInfo({ type, message });
  }, []);

  const showOffline = useCallback(
    (message = 'Waiting for MPD…') => {
      setOverlayVisible(true);
      setStatusBadge('warn', spinnerMessage(message));
    },
    [setStatusBadge],
  );

  const hideOffline = useCallback(() => {
    setOverlayVisible(false);
  }, []);

  const normalizeAttachError = useCallback((err) => {
    if (err instanceof Error) {
      return err;
    }
    try {
      if (typeof err === 'string') {
        return new Error(err);
      }
      return new Error(JSON.stringify(err));
    } catch {
      return new Error(String(err ?? 'dash.js attach failed'));
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handler = (event) => {
      const reason = event?.reason ?? null;
      const state = attachStateRef.current;
      if (!state?.deferred) {
        return;
      }
      const message = reason instanceof Error ? reason.message : String(reason ?? '');
      const stack = reason?.stack ? String(reason.stack) : '';
      const haystack = `${message}\n${stack}`.toLowerCase();
      if (!haystack.includes('dash') && !haystack.includes('range')) {
        return;
      }
      event?.preventDefault?.();
      const error = normalizeAttachError(reason);
      const deferred = state.deferred;
      state.deferred = null;
      deferred.reject(error);
    };
    window.addEventListener('unhandledrejection', handler);
    return () => {
      window.removeEventListener('unhandledrejection', handler);
    };
  }, [normalizeAttachError]);

  useEffect(() => {
    return () => {
      if (metadataRetryTimerRef.current) {
        window.clearTimeout(metadataRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchPlayerSettings();
        if (cancelled) {
          return;
        }
        const waitSetting = response?.settings?.attachMinimumSegments;
        let waitSegments;
        if (typeof waitSetting === 'number') {
          waitSegments = waitSetting;
        } else if (typeof waitSetting === 'string' && waitSetting.trim() !== '') {
          const parsedWait = Number.parseInt(waitSetting, 10);
          waitSegments = Number.isFinite(parsedWait) ? parsedWait : undefined;
        } else {
          waitSegments = undefined;
        }
        if (!Number.isFinite(waitSegments)) {
          waitSegments = DEFAULT_ATTACH_MIN_SEGMENTS;
        }
        waitSegments = Math.max(0, Math.min(240, waitSegments));
        attachSegmentThresholdRef.current = waitSegments;

        const normalized = normalizePlayerSettings(response?.settings);
        playerConfigRef.current = normalized;
        if (playerRef.current) {
          applyPlayerSettings(playerRef.current, normalized, { normalized: true });
        }
        subtitleAppliedRef.current = false;
        setPlayerSettingsTick((tick) => tick + 1);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Failed to load player settings', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const headOrGet = useCallback(async (url) => {
    try {
      const headResp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (headResp.ok) {
        return headResp;
      }
      if (headResp.status === 405 || headResp.status === 501) {
        return await fetch(url, { method: 'GET', cache: 'no-store' });
      }
      return headResp;
    } catch {
      return { ok: false, status: 0 };
    }
  }, []);

  const cacheBustUrl = useCallback((url, param = 'ts') => {
    if (!url) {
      return url;
    }
    const stamp = Date.now().toString();
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.delete(param);
      parsed.searchParams.set(param, stamp);
      return parsed.toString();
    } catch {
      const [base, query = ''] = url.split('?');
      const params = new URLSearchParams(query);
      params.delete(param);
      params.set(param, stamp);
      const composed = params.toString();
      return composed ? `${base}?${composed}` : `${base}?${param}=${stamp}`;
    }
  }, []);

  const withSessionFragment = useCallback((url, sessionId) => {
    if (!url || !sessionId) {
      return url;
    }
    // eslint-disable-next-line no-console
    console.info('[StreamPage] withSessionFragment', { url, sessionId });
    try {
      const parsed = new URL(url, window.location.href);
      parsed.hash = `session=${sessionId}`;
      return parsed.toString();
    } catch {
      const [base] = url.split('#', 1);
      return `${base}#session=${sessionId}`;
    }
  }, []);

  const teardownPlayer = useCallback(() => {
    // eslint-disable-next-line no-console
    console.info('[StreamPage] teardownPlayer invoked');
    const player = playerRef.current;
    const video = videoRef.current;
    if (player) {
      player.__isInitialized = false;
      try {
        const dashEvents = getDashEvents();
        if (dashEvents) {
          if (player.__onStreamInitialized) {
            player.off(dashEvents.STREAM_INITIALIZED, player.__onStreamInitialized);
            player.__onStreamInitialized = undefined;
          }
          if (player.__onStreamError) {
            player.off(dashEvents.ERROR, player.__onStreamError);
            player.__onStreamError = undefined;
          }
          if (Array.isArray(player.__diagnosticHandlers)) {
            for (const [evt, handler] of player.__diagnosticHandlers) {
              try {
                player.off(evt, handler);
              } catch {}
            }
            player.__diagnosticHandlers = undefined;
          }
        }
      } catch {}
      try {
        player.reset();
      } catch {}
      try {
        player.destroy?.();
      } catch {}
      playerRef.current = null;
    }
    if (video) {
      try {
        if (pendingResetRef.current) {
          try {
            video.currentTime = 0;
          } catch {}
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        delete video.dataset.started;
      } catch {}
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current || !manifestUrl) {
      return;
    }
    // eslint-disable-next-line no-console
    console.info('[StreamPage] startPolling', {
      manifestUrl,
      session: segmentSessionRef.current,
    });
    pollingRef.current = true;
    consecutiveOkRef.current = 0;
    segmentsReadyRef.current = false;
    manifestSegmentsRef.current = {
      sessionId: segmentSessionRef.current,
      startNumber: null,
      lastNumber: null,
      representationIds: [],
      fetchedAt: 0,
      initVerified: false,
    };
    showOffline();
    setStatusBadge('info', spinnerMessage('Checking MPD…'));

    const tick = async () => {
      const probeUrl = cacheBustUrl(manifestUrl, 'probe');
      const response = await headOrGet(probeUrl);

      if (response.ok) {
        const ensureSegmentsReady = async () => {
          if (segmentsReadyRef.current) {
            return true;
          }
          const requiredSegments = attachSegmentThresholdRef.current;
          if (!requiredSegments || requiredSegments <= 1) {
            segmentsReadyRef.current = true;
            return true;
          }

          let sessionId = segmentSessionRef.current;
          const now = Date.now();
          const manifestCache = manifestSegmentsRef.current;
          const isCacheStale = now - manifestCache.fetchedAt > MANIFEST_CACHE_TTL_MS;

          const needsManifestRefresh =
            !sessionId || manifestCache.sessionId !== sessionId || manifestCache.startNumber == null || isCacheStale;

          if (needsManifestRefresh) {
            try {
              const manifestResponse = await fetch(
                cacheBustUrl(manifestUrl, 'session'),
                { method: 'GET', cache: 'no-store' },
              );
              if (manifestResponse.ok) {
                const manifestText = await manifestResponse.text();
                const details = parseManifestDetails(manifestText);
                manifestSegmentsRef.current = {
                  sessionId: details.sessionId || sessionId || null,
                  startNumber: details.startNumber,
                  lastNumber: details.lastNumber,
                  representationIds: details.representationIds || [],
                  fetchedAt: Date.now(),
                  initVerified:
                    manifestSegmentsRef.current.initVerified &&
                    manifestSegmentsRef.current.sessionId === (details.sessionId || sessionId || null),
                };
              } else {
                manifestSegmentsRef.current = {
                  sessionId: sessionId || null,
                  startNumber: manifestSegmentsRef.current.startNumber,
                  lastNumber: manifestSegmentsRef.current.lastNumber,
                  representationIds: manifestSegmentsRef.current.representationIds,
                  fetchedAt: 0,
                  initVerified: false,
                };
              }
            } catch {
              manifestSegmentsRef.current = {
                sessionId: sessionId || null,
                startNumber: manifestSegmentsRef.current.startNumber,
                lastNumber: manifestSegmentsRef.current.lastNumber,
                representationIds: manifestSegmentsRef.current.representationIds,
                fetchedAt: 0,
                initVerified: false,
              };
            }
          }

          const manifestInfo = manifestSegmentsRef.current;
          if (manifestInfo.sessionId && manifestInfo.sessionId !== sessionId) {
            sessionId = manifestInfo.sessionId;
            segmentSessionRef.current = manifestInfo.sessionId;
            segmentsReadyRef.current = false;
          }
          if (!sessionId) {
            return false;
          }

          const manifestTarget = (() => {
            try {
              return new URL(manifestUrl, window.location.href);
            } catch {
              return null;
            }
          })();
          if (!manifestTarget) {
            // eslint-disable-next-line no-console
            console.info('[StreamPage] manifest target missing');
            return true;
          }
          const basePath = `${manifestTarget.origin}${manifestTarget.pathname.replace(/[^/]+$/, '')}`;
          const reps = manifestInfo.representationIds.length > 0
            ? manifestInfo.representationIds
            : [0];

          if (!manifestInfo.initVerified) {
            let initSuccess = true;
            for (const rep of reps) {
              const initUrl = `${basePath}sessions/${sessionId}/init-${rep}.m4s`;
              try {
                const resp = await headOrGet(cacheBustUrl(initUrl, 'init'));
                if (!resp.ok) {
                  initSuccess = false;
                  break;
                }
              } catch {
                initSuccess = false;
                break;
              }
            }
            manifestSegmentsRef.current.initVerified = initSuccess;
            if (!initSuccess) {
              manifestSegmentsRef.current.fetchedAt = 0;
              return false;
            }
          }

          const startNumber = Number.isFinite(manifestInfo.startNumber) ? manifestInfo.startNumber : 0;
          const lastNumber = Number.isFinite(manifestInfo.lastNumber)
            ? manifestInfo.lastNumber
            : startNumber + requiredSegments;
          const checksNeeded = Math.max(requiredSegments * 2, requiredSegments + 4);
          let successCount = 0;
          let attempts = 0;
          let currentNumber = lastNumber;

          while (attempts < checksNeeded && successCount < requiredSegments && currentNumber >= startNumber) {
            const padded = formatChunkNumber(currentNumber);
            let allReady = true;
            for (const rep of reps) {
              const segmentUrl = `${basePath}sessions/${sessionId}/chunk-${rep}-${padded}.m4s`;
              try {
                const segmentResponse = await headOrGet(cacheBustUrl(segmentUrl, `segment-${rep}-${padded}`));
                if (!segmentResponse.ok) {
                  if (segmentResponse.status === 404) {
                    manifestSegmentsRef.current.fetchedAt = 0;
                  }
                  allReady = false;
                  break;
                }
              } catch {
                allReady = false;
                break;
              }
            }
            if (allReady) {
              successCount += 1;
            }
            currentNumber -= 1;
            attempts += 1;
          }

          // eslint-disable-next-line no-console
          console.info('[StreamPage] segment readiness sweep', {
            sessionId,
            successCount,
            requiredSegments,
            attempts,
            startNumber,
            lastNumber,
          });

          if (successCount >= requiredSegments) {
            segmentsReadyRef.current = true;
            // eslint-disable-next-line no-console
            console.info('[StreamPage] segments ready', {
              sessionId,
              successCount,
              requiredSegments,
            });
            return true;
          }
          if (successCount === 0) {
            manifestSegmentsRef.current.fetchedAt = 0;
          }
          // eslint-disable-next-line no-console
          console.info('[StreamPage] segments not ready yet', {
            sessionId,
            successCount,
            requiredSegments,
          });
          return false;
        };

        const segmentsReady = await ensureSegmentsReady();
        if (!segmentsReady) {
          // eslint-disable-next-line no-console
          console.info('[StreamPage] polling wait for segments');
          consecutiveOkRef.current = 0;
          setStatusBadge(
            'info',
            spinnerMessage(`Waiting for segments (≥${attachSegmentThresholdRef.current})…`),
          );
          pollTimerRef.current = window.setTimeout(tick, 600);
          return;
        }

        consecutiveOkRef.current += 1;
        // eslint-disable-next-line no-console
        console.info('[StreamPage] MPD probe success', {
          consecutiveOk: consecutiveOkRef.current,
        });
        setStatusBadge('info', spinnerMessage(`MPD OK (${consecutiveOkRef.current}/2)…`));
        if (consecutiveOkRef.current >= 2) {
          pollingRef.current = false;
          if (pollTimerRef.current) {
            window.clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          setStatusBadge('info', spinnerMessage('Attaching player…'));
          // eslint-disable-next-line no-console
          console.info('[StreamPage] triggering player attach', {
            manifest: manifestUrlRef.current,
            session: segmentSessionRef.current,
          });
          const initializer = initPlayerRef.current;
          if (initializer) {
            await initializer();
          }
          return;
        }
      } else {
        consecutiveOkRef.current = 0;
        const code = response.status || 'net';
        setStatusBadge('warn', spinnerMessage(`Waiting for MPD (status: ${code})…`));
      }

      pollTimerRef.current = window.setTimeout(tick, 1000);
    };

    tick();
  }, [cacheBustUrl, headOrGet, manifestUrl, setStatusBadge, showOffline]);

  const initPlayer = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !manifestUrl) {
      return false;
    }

    if (attachingRef.current) {
      return false;
    }
    attachingRef.current = true;

    const handleAttachFailure = (err) => {
      if (err) {
        console.error('Failed to initialise dash.js player', err);
      } else {
        console.error('Failed to initialise dash.js player');
      }
      // eslint-disable-next-line no-console
      console.info('[StreamPage] handleAttachFailure invoked', { err });
      setStatusBadge('warn', spinnerMessage('Player failed, retrying…'));
      pollingRef.current = false;
      consecutiveOkRef.current = 0;
      teardownPlayer();
      showOffline('Player failed, retrying…');
      startPolling();
    };

    const sourceUrl = cacheBustUrl(manifestUrl);
    const state = attachStateRef.current;
    state.token += 1;
    state.attempts = 0;
    state.deferred = null;
    // eslint-disable-next-line no-console
    console.info('[StreamPage] initPlayer begin', {
      manifestUrl,
      sourceUrl,
      session: segmentSessionRef.current,
    });

    try {
      let lastError = null;
      for (let attempt = 1; attempt <= MAX_PLAYER_ATTACH_ATTEMPTS; attempt += 1) {
        state.attempts = attempt;
        teardownPlayer();
        const player = createPlayer(playerConfigRef.current);
        if (!player) {
          setStatusBadge('warn', spinnerMessage('Video player runtime unavailable'));
          showOffline('Waiting for player runtime…');
          return false;
        }
        const dashEvents = getDashEvents();
        if (!dashEvents) {
          try {
            player.reset?.();
          } catch {}
          try {
            player.destroy?.();
          } catch {}
          setStatusBadge('warn', spinnerMessage('Video player runtime unavailable'));
          showOffline('Waiting for player runtime…');
          return false;
        }

        playerRef.current = player;

        const onStreamInitialized = () => {
          if (pendingResetRef.current && player && typeof player.seek === 'function') {
            try {
              player.seek(0);
            } catch {}
            pendingResetRef.current = false;
          }
          hideOffline();
          setStatusBadge('ok', 'Live');
          const vid = videoRef.current;
          if (vid) {
            const playPromise = vid.play?.();
            playPromise?.catch(() => {});
          }
        };

        const onError = (evt) => {
          player.__isInitialized = false;
          pushDashDiagnostic('player.error', evt);
          const http = evt?.event?.status || evt?.status || 0;
          setStatusBadge('warn', spinnerMessage(`Player error (${http || 'network'}) — rechecking`));
          teardownPlayer();
          pollingRef.current = false;
          consecutiveOkRef.current = 0;
          showOffline('Recovering from player error…');
          startPolling();
        };

        const diagHandlers = [];
        if (dashEvents.FRAGMENT_LOADING_FAILED) {
          const handler = (evt) => {
            pushDashDiagnostic('segment.failed', evt);
          };
          player.on(dashEvents.FRAGMENT_LOADING_FAILED, handler);
          diagHandlers.push([dashEvents.FRAGMENT_LOADING_FAILED, handler]);
        }
        if (dashEvents.HTTP_RESPONSE_CODE) {
          const handler = (evt) => {
            const statusCode =
              evt?.response?.status ??
              evt?.request?.response?.status ??
              evt?.request?.status ??
              evt?.status ??
              null;
            if (typeof statusCode === 'number' && statusCode >= 400) {
              pushDashDiagnostic(`http.${statusCode}`, evt);
            }
          };
          player.on(dashEvents.HTTP_RESPONSE_CODE, handler);
          diagHandlers.push([dashEvents.HTTP_RESPONSE_CODE, handler]);
        }
        if (dashEvents.BUFFER_LEVEL_OUTRUN) {
          const handler = (evt) => {
            pushDashDiagnostic('buffer.outrun', evt);
          };
          player.on(dashEvents.BUFFER_LEVEL_OUTRUN, handler);
          diagHandlers.push([dashEvents.BUFFER_LEVEL_OUTRUN, handler]);
        }
        if (dashEvents.BUFFER_EMPTY) {
          const handler = (evt) => pushDashDiagnostic('buffer.empty', evt);
          player.on(dashEvents.BUFFER_EMPTY, handler);
          diagHandlers.push([dashEvents.BUFFER_EMPTY, handler]);
        }
        if (dashEvents.BUFFER_LOADED) {
          const handler = (evt) => pushDashDiagnostic('buffer.loaded', evt);
          player.on(dashEvents.BUFFER_LOADED, handler);
          diagHandlers.push([dashEvents.BUFFER_LOADED, handler]);
        }
        if (dashEvents.BUFFER_LEVEL_STATE_CHANGED) {
          const handler = (evt) => pushDashDiagnostic('buffer.state', evt);
          player.on(dashEvents.BUFFER_LEVEL_STATE_CHANGED, handler);
          diagHandlers.push([dashEvents.BUFFER_LEVEL_STATE_CHANGED, handler]);
        }
        if (dashEvents.FRAGMENT_LOADING_COMPLETED) {
          const handler = (evt) => pushDashDiagnostic('segment.loaded', evt);
          player.on(dashEvents.FRAGMENT_LOADING_COMPLETED, handler);
          diagHandlers.push([dashEvents.FRAGMENT_LOADING_COMPLETED, handler]);
        }
        if (dashEvents.PLAYBACK_STALLED) {
          const handler = (evt) => pushDashDiagnostic('playback.stalled', evt);
          player.on(dashEvents.PLAYBACK_STALLED, handler);
          diagHandlers.push([dashEvents.PLAYBACK_STALLED, handler]);
        }
        if (dashEvents.PLAYBACK_NOT_ALLOWED) {
          const handler = (evt) => pushDashDiagnostic('playback.not_allowed', evt);
          player.on(dashEvents.PLAYBACK_NOT_ALLOWED, handler);
          diagHandlers.push([dashEvents.PLAYBACK_NOT_ALLOWED, handler]);
        }
        if (dashEvents.PLAYBACK_ERROR) {
          const handler = (evt) => pushDashDiagnostic('playback.error', evt);
          player.on(dashEvents.PLAYBACK_ERROR, handler);
          diagHandlers.push([dashEvents.PLAYBACK_ERROR, handler]);
        }
        if (dashEvents.PLAYBACK_STARTED) {
          const handler = (evt) => pushDashDiagnostic('playback.started', evt);
          player.on(dashEvents.PLAYBACK_STARTED, handler);
          diagHandlers.push([dashEvents.PLAYBACK_STARTED, handler]);
        }
        if (dashEvents.PLAYBACK_PLAYING) {
          const handler = (evt) => pushDashDiagnostic('playback.playing', evt);
          player.on(dashEvents.PLAYBACK_PLAYING, handler);
          diagHandlers.push([dashEvents.PLAYBACK_PLAYING, handler]);
        }
        if (dashEvents.PLAYBACK_PAUSED) {
          const handler = (evt) => pushDashDiagnostic('playback.paused', evt);
          player.on(dashEvents.PLAYBACK_PAUSED, handler);
          diagHandlers.push([dashEvents.PLAYBACK_PAUSED, handler]);
        }
        if (dashEvents.PLAYBACK_TIME_UPDATED) {
          const handler = (evt) => pushDashDiagnostic('playback.time', evt);
          player.on(dashEvents.PLAYBACK_TIME_UPDATED, handler);
          diagHandlers.push([dashEvents.PLAYBACK_TIME_UPDATED, handler]);
        }
        if (diagHandlers.length > 0) {
          player.__diagnosticHandlers = diagHandlers;
        }

        if (!video.dataset.started) {
          video.muted = true;
          video.dataset.started = '1';
        }
        video.autoplay = true;
        video.playsInline = true;

        setStatusBadge('info', spinnerMessage(`Attaching player (try ${attempt}/${MAX_PLAYER_ATTACH_ATTEMPTS})…`));

        try {
          player.setAutoPlay(true);
          player.initialize(video, sourceUrl, true, 0);

          await new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
              try {
                player.off(dashEvents.STREAM_INITIALIZED, onceSuccess);
              } catch {}
              try {
                player.off(dashEvents.ERROR, onceError);
              } catch {}
            };
            const finish = (err) => {
              if (settled) {
                return;
              }
              settled = true;
              cleanup();
              state.deferred = null;
              if (err) {
                reject(normalizeAttachError(err));
              } else {
                resolve();
              }
            };
            const onceSuccess = () => {
              try {
                player.__isInitialized = true;
                onStreamInitialized();
              } catch {}
              finish();
            };
            const onceError = (evt) => {
              player.__isInitialized = false;
              const cause = evt?.event ?? evt?.error ?? evt;
              finish(cause);
            };

            player.on(dashEvents.STREAM_INITIALIZED, onceSuccess);
            player.on(dashEvents.ERROR, onceError);

            state.deferred = {
              resolve: () => finish(),
              reject: (err) => finish(err),
            };

          });

          player.__onStreamInitialized = onStreamInitialized;
          player.__onStreamError = onError;
          player.on(dashEvents.STREAM_INITIALIZED, onStreamInitialized);
          player.on(dashEvents.ERROR, onError);
          // eslint-disable-next-line no-console
          console.info('[StreamPage] dash.js attach success');
          return true;
        } catch (err) {
          lastError = normalizeAttachError(err);
          console.warn(`dash.js attach attempt ${attempt}/${MAX_PLAYER_ATTACH_ATTEMPTS} failed`, lastError);
          // eslint-disable-next-line no-console
          console.info('[StreamPage] dash.js attach failure', {
            attempt,
            error: lastError?.message || lastError,
          });
          try {
            player.__isInitialized = false;
            player.reset?.();
          } catch (resetError) {
            console.warn('dash.js reset failed after attach error', resetError);
          }
          try {
            player.destroy?.();
          } catch {}
          try {
            video.pause();
            video.removeAttribute('src');
            video.load();
          } catch {}
          if (attempt >= MAX_PLAYER_ATTACH_ATTEMPTS) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(ATTACH_RETRY_DELAY_MS * attempt, 1500)));
        }
      }

      handleAttachFailure(lastError);
      return false;
    } finally {
      attachingRef.current = false;
      attachStateRef.current.deferred = null;
    }
  }, [
    cacheBustUrl,
    hideOffline,
    manifestUrl,
    normalizeAttachError,
    pushDashDiagnostic,
    setStatusBadge,
    showOffline,
    startPolling,
    teardownPlayer,
  ]);

  useEffect(() => {
    if (manifestUrlRef.current !== manifestUrl) {
      // eslint-disable-next-line no-console
      console.info('[StreamPage] manifestUrl updated', {
        previous: manifestUrlRef.current,
        next: manifestUrl,
      });
    }
    manifestUrlRef.current = manifestUrl;
  }, [manifestUrl]);

  useEffect(() => {
    initPlayerRef.current = initPlayer;
  }, [initPlayer]);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`${BACKEND_BASE}/transcode/status`, { credentials: 'include' });
      if (response.status === 401) {
        setStatus(null);
        setStatusFetchError('Authentication required');
        onUnauthorized();
        return null;
      }
      if (!response.ok) {
        throw new Error(`Backend responded with ${response.status}`);
      }
      const payload = await response.json();
      const session = payload && typeof payload.session === 'object' && payload.session !== null
        ? payload.session
        : payload && typeof payload === 'object'
          ? payload
          : null;

      setStatus(session ?? null);
  const queueState = session && typeof session.queue_auto_advance === 'object' && session.queue_auto_advance !== null
    ? session.queue_auto_advance
    : null;
  const queueActiveSessionId = typeof queueState?.session_id === 'string' && queueState.session_id
    ? queueState.session_id
        : null;
      const queuePendingSessionId = typeof queueState?.pending_session_id === 'string' && queueState.pending_session_id
        ? queueState.pending_session_id
        : null;
      const previousQueueState = queueStateRef.current;
      queueStateRef.current = {
        active: queueActiveSessionId,
        pending: queuePendingSessionId,
      };
      const pendingJustCleared = Boolean(previousQueueState.pending && !queuePendingSessionId);
      const activeChanged = (queueActiveSessionId || null) !== (previousQueueState.active || null);
  const newSessionReady = Boolean(queueActiveSessionId && activeChanged && pendingJustCleared);
  if (newSessionReady) {
    // eslint-disable-next-line no-console
    console.info('[StreamPage] new session ready', {
      queueActiveSessionId,
      previousQueueState,
    });
    autoStartRef.current = false;
    pollingRef.current = false;
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    teardownPlayer();
    showOffline('Switching streams…');
    setStatusBadge('info', spinnerMessage('Switching to new stream…'));
    pendingResetRef.current = true;
  }
      let resolvedSessionId = null;
      if (queueActiveSessionId) {
        resolvedSessionId = queueActiveSessionId;
      } else if (session) {
        if (typeof session.session_id === 'string' && session.session_id) {
          resolvedSessionId = session.session_id;
        } else if (typeof session.sessionId === 'string' && session.sessionId) {
          resolvedSessionId = session.sessionId;
        } else if (typeof session.id === 'string' && session.id) {
          resolvedSessionId = session.id;
        }
      }

  if (resolvedSessionId !== segmentSessionRef.current) {
    // eslint-disable-next-line no-console
    console.info('[StreamPage] updating segment session ref', {
      previous: segmentSessionRef.current,
      next: resolvedSessionId,
    });
    segmentSessionRef.current = resolvedSessionId;
    segmentsReadyRef.current = false;
    manifestSegmentsRef.current = {
      sessionId: resolvedSessionId,
      startNumber: null,
      lastNumber: null,
      representationIds: [],
      fetchedAt: 0,
      initVerified: false,
    };
    pendingResetRef.current = true;
  } else if (!session) {
        // eslint-disable-next-line no-console
        console.info('[StreamPage] clearing segment session ref (no session)');
        segmentSessionRef.current = null;
        segmentsReadyRef.current = false;
        manifestSegmentsRef.current = {
          sessionId: null,
          startNumber: null,
          lastNumber: null,
          representationIds: [],
          fetchedAt: 0,
          initVerified: false,
        };
      }

      const manifestCandidate =
        (session && typeof session.manifest_url === 'string' && session.manifest_url) ||
        (payload && typeof payload.manifest_url === 'string' && payload.manifest_url) ||
        null;
      const deferManifestSwap = Boolean(
        queuePendingSessionId
          && queueActiveSessionId
          && queueActiveSessionId === segmentSessionRef.current
          && manifestUrlRef.current
          && manifestUrlRef.current !== DEFAULT_STREAM_URL,
      );
      let manifestToApply = null;
      if (manifestCandidate) {
        if (deferManifestSwap) {
          // eslint-disable-next-line no-console
          console.info('[StreamPage] deferring manifest swap', {
            manifestCandidate,
            queueActiveSessionId,
            queuePendingSessionId,
          });
          deferredManifestRef.current = manifestCandidate;
        } else {
          // eslint-disable-next-line no-console
          console.info('[StreamPage] immediate manifest swap', {
            manifestCandidate,
            queueActiveSessionId,
          });
          manifestToApply = manifestCandidate;
          deferredManifestRef.current = null;
        }
      } else {
        deferredManifestRef.current = null;
      }

      if (newSessionReady && deferredManifestRef.current) {
        manifestToApply = deferredManifestRef.current;
        deferredManifestRef.current = null;
      }

      if (manifestToApply) {
        const sessionMarker = queueActiveSessionId
          || resolvedSessionId
          || queuePendingSessionId
          || segmentSessionRef.current
          || null;
        const nextManifest = sessionMarker
          ? withSessionFragment(manifestToApply, sessionMarker)
          : manifestToApply;
        const currentSessionMarker = manifestSessionRef.current;
        const shouldSwap =
          nextManifest !== manifestUrlRef.current
          || (sessionMarker && sessionMarker !== currentSessionMarker);

        if (shouldSwap) {
          // eslint-disable-next-line no-console
          console.info('[StreamPage] applying manifest', {
            manifestToApply,
            sessionMarker,
            currentSessionMarker,
          });
          manifestSessionRef.current = sessionMarker || null;
          setManifestUrl(nextManifest);
        }
      }

      const redisInfo =
        (payload && typeof payload.redis === 'object' && payload.redis !== null ? payload.redis : null) ||
        (session && typeof session.redis === 'object' && session.redis !== null ? session.redis : null) ||
        { available: false, last_error: 'Redis unavailable' };
      setRedisStatus(redisInfo);

      const metadataBlock = payload && typeof payload.metadata === 'object' && payload.metadata !== null
        ? payload.metadata
        : null;

      const hasItem = Boolean(
        metadataBlock?.item &&
        typeof metadataBlock.item === 'object' &&
        Object.keys(metadataBlock.item).length > 0,
      );
      if (hasItem) {
        setCurrentMetadata(metadataBlock);
        setMetadataError(null);
      } else {
        setCurrentMetadata(null);
      }

      if (!metadataInitializedRef.current) {
        metadataInitializedRef.current = true;
      }
      setMetadataLoading(false);

      const sessionSubtitles = Array.isArray(session?.subtitles) ? session.subtitles : [];
      const subtitleList = sessionSubtitles
        .filter((track) => track && typeof track === 'object')
        .map((track) => ({ ...track }));
      setSubtitleTracks(subtitleList);
      subtitleAppliedRef.current = false;

      setError(null);
      setStatusFetchError(null);
      return payload;
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      // eslint-disable-next-line no-console
      console.info('[StreamPage] fetchStatus error', { message });
      setError(message);
      setStatusFetchError(message);
      setStatus(null);
      setMetadataError(message);
      setMetadataLoading(false);
      setCurrentMetadata(null);
      setSubtitleTracks([]);
      metadataInitializedRef.current = true;
      setRedisStatus({ available: false, last_error: message });
      return null;
    }
  }, [
    onUnauthorized,
    setStatusBadge,
    showOffline,
    teardownPlayer,
    withSessionFragment,
  ]);

  const handleMetadataReload = useCallback(() => {
    setMetadataLoading(true);
    setMetadataError(null);
    void fetchStatus();
  }, [fetchStatus]);

  const handlePlayQueueAction = useCallback(async () => {
    if (queuePending) {
      return;
    }
    setQueuePending(true);
    try {
      await playQueue();
      await fetchStatus();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (exc?.status === 401) {
        onUnauthorized();
      }
      setStatusBadge('warn', message);
    } finally {
      setQueuePending(false);
    }
  }, [fetchStatus, onUnauthorized, queuePending, setStatusBadge]);

  const handleSkipQueueAction = useCallback(async () => {
    if (queuePending) {
      return;
    }
    setQueuePending(true);
    try {
      await skipQueue();
      await fetchStatus();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (exc?.status === 401) {
        onUnauthorized();
      }
      setStatusBadge('warn', message);
    } finally {
      setQueuePending(false);
    }
  }, [fetchStatus, onUnauthorized, queuePending, setStatusBadge]);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.info('[StreamPage] initial mount');
    const player = createPlayer(playerConfigRef.current);
    if (player) {
      playerRef.current = player;
    } else {
      setStatusBadge('warn', spinnerMessage('Video player runtime unavailable'));
    }

    void fetchStatus();
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, 2000);

    return () => {
      window.clearInterval(timer);
      teardownPlayer();
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, [fetchStatus, setStatusBadge, teardownPlayer]);

  useEffect(() => {
    const currentPid = status?.pid ?? null;
    const previousPid = lastPidRef.current;
    // eslint-disable-next-line no-console
    console.info('[StreamPage] PID watcher', {
      currentPid,
      previousPid,
      running: status?.running,
    });

    if (currentPid !== previousPid) {
      lastPidRef.current = currentPid;
      metadataInitializedRef.current = false;
      setMetadataLoading(true);
      if (currentPid && status?.running) {
        setDashDiagnostics([]);
        pollingRef.current = false;
        autoStartRef.current = false;
        if (pollTimerRef.current) {
          window.clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        teardownPlayer();
        showOffline('Switching streams…');
        setStatusBadge('info', spinnerMessage('Switching to new stream…'));
        startPolling();
      }
    }

    if (!currentPid && previousPid && !status?.running) {
      lastPidRef.current = null;
    }
  }, [
    setDashDiagnostics,
    setStatusBadge,
    showOffline,
    startPolling,
    status?.pid,
    status?.running,
    teardownPlayer,
  ]);

  useEffect(() => {
    if (status?.running && manifestUrl && !autoStartRef.current) {
      autoStartRef.current = true;
      startPolling();
    }
    if (!status?.running) {
      autoStartRef.current = false;
      pollingRef.current = false;
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      showOffline('Transcoder not playing');
    }
  }, [manifestUrl, showOffline, startPolling, status?.running]);

  useEffect(() => {
    const running = status?.running === true;
    // eslint-disable-next-line no-console
    console.info('[StreamPage] status running check', {
      running,
      pid: status?.pid,
      session: status?.session_id || status?.sessionId,
    });
    if (!running) {
      metadataTokenRef.current = null;
      setCurrentMetadata(null);
      setMetadataLoading(false);
      setMetadataError(null);
      if (metadataRetryTimerRef.current) {
        window.clearTimeout(metadataRetryTimerRef.current);
        metadataRetryTimerRef.current = null;
      }
      return;
    }

    const tokenParts = [
      status?.pid ?? 'npid',
      status?.output_manifest ?? '',
      status?.manifest_url ?? '',
    ];
    const token = tokenParts.join('|');

    if (metadataTokenRef.current === token && currentMetadata) {
      return;
    }

    if (metadataRetryTimerRef.current) {
      window.clearTimeout(metadataRetryTimerRef.current);
      metadataRetryTimerRef.current = null;
    }

    let cancelled = false;
    setMetadataLoading(true);
    setMetadataError(null);

    (async () => {
      try {
        const payload = await fetchCurrentPlayback();
        if (cancelled) {
          return;
        }

        const redisInfo = payload && typeof payload.redis === 'object' && payload.redis !== null
          ? payload.redis
          : { available: false, last_error: 'Redis unavailable' };
        setRedisStatus(redisInfo);

        const metadataRaw =
          payload && typeof payload.metadata === 'object' && payload.metadata !== null
            ? payload.metadata
            : payload && typeof payload === 'object' && payload !== null
              ? payload
              : null;

        const hasItem = metadataRaw?.item && Object.keys(metadataRaw.item).length > 0;
        if (hasItem) {
          const sessionSubtitles = Array.isArray(payload?.session?.subtitles)
            ? payload.session.subtitles.filter((track) => track && typeof track === 'object')
            : [];
          const metadataSubtitles = Array.isArray(metadataRaw?.subtitles)
            ? metadataRaw.subtitles.filter((track) => track && typeof track === 'object')
            : [];
          const subtitleSource = metadataSubtitles.length ? metadataSubtitles : sessionSubtitles;
          const nextMetadata = { ...metadataRaw };
          if (subtitleSource.length) {
            nextMetadata.subtitles = subtitleSource.map((track) => ({ ...track }));
          } else if (Object.prototype.hasOwnProperty.call(nextMetadata, 'subtitles')) {
            delete nextMetadata.subtitles;
          }
          metadataTokenRef.current = token;
          setCurrentMetadata(nextMetadata);
          setMetadataLoading(false);
          return;
        }

        metadataTokenRef.current = null;
        setCurrentMetadata(null);
        setMetadataLoading(false);
        metadataRetryTimerRef.current = window.setTimeout(() => {
          metadataRetryTimerRef.current = null;
          setMetadataRefreshTick((prev) => prev + 1);
        }, 1500);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setMetadataError(message);
        setMetadataLoading(false);
        setRedisStatus({ available: false, last_error: message });
        metadataTokenRef.current = null;
        metadataRetryTimerRef.current = window.setTimeout(() => {
          metadataRetryTimerRef.current = null;
          setMetadataRefreshTick((prev) => prev + 1);
        }, 4000);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    currentMetadata,
    metadataRefreshTick,
    status?.manifest_url,
    status?.output_manifest,
    status?.pid,
    status?.running,
  ]);

  useEffect(() => {
    if (!currentMetadata) {
      setSubtitleTracks([]);
      subtitleAppliedRef.current = false;
      return;
    }

    if (Array.isArray(currentMetadata.subtitles)) {
      const normalized = currentMetadata.subtitles
        .filter((track) => track && typeof track === 'object')
        .map((track) => ({ ...track }));
      setSubtitleTracks(normalized);
      subtitleAppliedRef.current = false;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(currentMetadata, 'subtitles')) {
      setSubtitleTracks([]);
      subtitleAppliedRef.current = false;
    }
  }, [currentMetadata]);

  useEffect(() => {
    subtitleAppliedRef.current = false;
  }, [status?.pid]);

  const handleVolumeSlider = useCallback((value) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const clamped = Math.min(1, Math.max(0, value));
    video.volume = clamped;
    if (clamped > 0 && video.muted) {
      video.muted = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.muted = !video.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = videoContainerRef.current;
    if (!container) {
      return;
    }
    if (!document.fullscreenElement) {
      const request = container.requestFullscreen?.();
      request?.catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const toggleSubtitleMenu = useCallback(() => {
    setSubtitleMenuOpen((open) => !open);
  }, []);

  const resolvedSubtitleTracks = useMemo(() => {
    if (!Array.isArray(subtitleTracks) || subtitleTracks.length === 0) {
      return [];
    }
    const versionToken = status?.pid ? String(status.pid) : '';
    return subtitleTracks
      .map((track) => {
        if (!track) {
          return null;
        }
        const relativePath = track.path || track.relative_path || track.relativePath;
        let baseUrl = typeof track.url === 'string' && track.url ? track.url : null;
        if (!baseUrl && relativePath) {
          baseUrl = `${BACKEND_BASE}/media/${relativePath}`;
        }
        if (!baseUrl) {
          return null;
        }
        let src = baseUrl;
        if (versionToken) {
          src = baseUrl.includes('?') ? `${baseUrl}&v=${versionToken}` : `${baseUrl}?v=${versionToken}`;
        }
        return { ...track, src };
      })
      .filter(Boolean);
  }, [subtitleTracks, status?.pid]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }
    const updateVolume = () => {
      setVolumeLevel(video.volume);
      setIsMuted(video.muted || video.volume === 0);
    };
    updateVolume();
    video.addEventListener('volumechange', updateVolume);
    return () => {
      video.removeEventListener('volumechange', updateVolume);
    };
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    subtitleAppliedRef.current = false;
  }, [playerSettingsTick]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    if (!resolvedSubtitleTracks.length) {
      Array.from(video.textTracks || []).forEach((track) => {
        track.mode = 'disabled';
      });
      subtitleAppliedRef.current = true;
      return undefined;
    }

    let retryTimer = null;

    const applyPreferences = () => {
      if (subtitleAppliedRef.current) {
        return;
      }
      const targetVideo = videoRef.current;
      if (!targetVideo) {
        return;
      }
      const textTracks = Array.from(targetVideo.textTracks || []);
      if (!textTracks.length) {
        retryTimer = window.setTimeout(applyPreferences, 200);
        return;
      }

      const textPrefs = playerConfigRef.current?.streaming?.text ?? {};
      const preferredRaw =
        textPrefs.defaultLanguage ?? textPrefs.preferredLanguage ?? '';
      const preferred = String(preferredRaw ?? '')
        .trim()
        .toLowerCase();
      const autoEnabled = Boolean(textPrefs.defaultEnabled);

      let forcedIndex = -1;
      let preferredIndex = -1;
      let fallbackIndex = -1;

      textTracks.forEach((track, index) => {
        track.mode = 'disabled';
        const meta = resolvedSubtitleTracks[index];
        if (!meta) {
          return;
        }
        if (meta.forced && forcedIndex === -1) {
          forcedIndex = index;
        }
        if (!meta.forced && fallbackIndex === -1) {
          fallbackIndex = index;
        }

        if (autoEnabled && preferred && !meta.forced) {
          const lang = (meta.language || '').toLowerCase();
          const label = (meta.label || '').toLowerCase();
          const langMatches = lang === preferred || lang.startsWith(`${preferred}-`);
          const labelMatches = preferred && label.includes(preferred);
          if ((langMatches || labelMatches) && preferredIndex === -1) {
            preferredIndex = index;
          }
        }
      });

      if (fallbackIndex === -1 && resolvedSubtitleTracks.length > 0) {
        fallbackIndex = forcedIndex !== -1 ? forcedIndex : 0;
      }

      let selection = -1;
      if (autoEnabled) {
        if (preferredIndex !== -1) {
          selection = preferredIndex;
        } else if (fallbackIndex !== -1) {
          selection = fallbackIndex;
        } else if (forcedIndex !== -1) {
          selection = forcedIndex;
        }
      } else if (forcedIndex !== -1) {
        selection = forcedIndex;
      }

      if (selection !== -1 && textTracks[selection]) {
        textTracks[selection].mode = 'showing';
        const meta = resolvedSubtitleTracks[selection];
        if (meta?.id) {
          setActiveSubtitleId(meta.id);
        }
      }
      if (forcedIndex !== -1 && forcedIndex !== selection && textTracks[forcedIndex]) {
        textTracks[forcedIndex].mode = 'disabled';
      }
      subtitleAppliedRef.current = true;
    };

    const timer = window.setTimeout(applyPreferences, 200);
    return () => {
      window.clearTimeout(timer);
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [resolvedSubtitleTracks, playerSettingsTick, status?.pid]);

  const handleSubtitleSelect = useCallback(
    (subtitleId) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const tracks = Array.from(video.textTracks || []);
      let matched = false;
      tracks.forEach((track, index) => {
        const meta = resolvedSubtitleTracks[index];
        const isMatch = meta?.id === subtitleId;
        track.mode = isMatch ? 'showing' : 'disabled';
        if (isMatch) {
          matched = true;
        }
      });
      if (!matched) {
        tracks.forEach((track) => {
          track.mode = 'disabled';
        });
        setActiveSubtitleId('off');
      } else {
        setActiveSubtitleId(subtitleId);
      }
      subtitleAppliedRef.current = true;
      setSubtitleMenuOpen(false);
    },
    [resolvedSubtitleTracks],
  );

  useEffect(() => {
    const handleClickAway = (event) => {
      const container = document.getElementById('subtitle-toggle');
      if (!container) {
        return;
      }
      if (!container.contains(event.target)) {
        setSubtitleMenuOpen(false);
      }
    };
    if (subtitleMenuOpen) {
      window.addEventListener('pointerdown', handleClickAway);
    }
    return () => {
      window.removeEventListener('pointerdown', handleClickAway);
    };
  }, [subtitleMenuOpen]);

  useEffect(() => {
    let rafId = null;
    const updateStats = () => {
      const player = playerRef.current;
      const video = videoRef.current;
      if (player && player.__isInitialized && video) {
        try {
          const isLive = player.isDynamic?.() ?? false;
          const duration = typeof player.duration === 'function' ? player.duration() : NaN;
          const currentTime = video.currentTime || 0;
          const computedDuration = Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : Number.isFinite(duration) && duration > 0
              ? duration
              : null;
          const latency = isLive && !Number.isNaN(duration) ? Math.max(0, duration - currentTime) : 0;
          const buffered = video.buffered?.length
            ? Math.max(0, video.buffered.end(video.buffered.length - 1) - currentTime)
            : 0;
          if (buffered <= 0.25) {
            // eslint-disable-next-line no-console
            console.warn('[StreamPage] low buffer', {
              buffered,
              currentTime,
              session: segmentSessionRef.current,
              manifest: manifestUrlRef.current,
            });
          }
          setStatsText(
            `Latency: ${latency.toFixed(2)}s · Buffered: ${buffered.toFixed(2)}s · Position: ${currentTime.toFixed(2)}s`,
          );

          if (Number.isFinite(computedDuration) && computedDuration > 0) {
            try {
              const latestBuffered = video.buffered?.length
                ? video.buffered.end(video.buffered.length - 1)
                : 0;
              setBufferedPercent(Math.min(1, Math.max(0, latestBuffered / computedDuration)));
            } catch (error) {
              setBufferedPercent(0);
            }
          } else {
            setBufferedPercent(0);
          }

          const lastClock = playbackClockRef.current;
          const nextClock = { currentSeconds: currentTime, durationSeconds: computedDuration };
          const durationChanged = (lastClock.durationSeconds ?? null) !== (nextClock.durationSeconds ?? null);
          const delta = Math.abs(nextClock.currentSeconds - (lastClock.currentSeconds ?? 0));
          if (durationChanged || delta >= 0.25) {
            playbackClockRef.current = nextClock;
            setPlaybackClock(nextClock);
          }
        } catch {
          setStatsText('');
          if (playbackClockRef.current.currentSeconds !== 0 || playbackClockRef.current.durationSeconds !== null) {
            playbackClockRef.current = { currentSeconds: 0, durationSeconds: null };
            setPlaybackClock({ currentSeconds: 0, durationSeconds: null });
          }
        }
      } else {
        setStatsText('');
        setBufferedPercent(0);
        if (playbackClockRef.current.currentSeconds !== 0 || playbackClockRef.current.durationSeconds !== null) {
          playbackClockRef.current = { currentSeconds: 0, durationSeconds: null };
          setPlaybackClock({ currentSeconds: 0, durationSeconds: null });
        }
      }
      rafId = window.requestAnimationFrame(updateStats);
    };
    updateStats();
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  useEffect(() => {
    let lastTime = 0;
    let stallCount = 0;
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      const video = videoRef.current;
      if (!player || !player.__isInitialized || !video) {
        stallCount = 0;
        return;
      }
      const now = video.currentTime || 0;
      if (Math.abs(now - lastTime) < 0.05) {
        stallCount += 1;
      } else {
        stallCount = 0;
      }
      lastTime = now;
      if (stallCount >= 5 && player.isDynamic?.()) {
        const liveEdge = player.duration?.();
        if (typeof liveEdge === 'number' && !Number.isNaN(liveEdge)) {
          video.currentTime = Math.max(0, liveEdge - 0.5);
          stallCount = 0;
        }
      }
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const videoPaneClasses = [
    'flex min-w-0 items-center justify-center bg-black px-0 py-10 lg:px-0 transition-all duration-300',
    activeSidebarTab ? 'flex-[3]' : 'flex-1',
  ].join(' ');

  const isAuthenticated = Boolean(user);
  const headerDisplayName = isAuthenticated ? user.username : viewer?.displayName || 'Guest';
  const headerStatusLabel = isAuthenticated ? 'Signed in' : 'Guest viewer';

  const handleStop = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${BACKEND_BASE}/transcode/stop`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (response.status === 409) {
        await response.json().catch(() => null);
      } else if (!response.ok) {
        throw new Error(`Failed to stop transcoder (${response.status})`);
      }
      teardownPlayer();
      setManifestUrl(null);
      showOffline('Transcoder stopped');
      setPending(false);
      void fetchStatus();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusFetchError((prev) => prev ?? message);
    } finally {
      setPending(false);
    }
  }, [fetchStatus, onUnauthorized, showOffline, teardownPlayer]);

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-background text-foreground">
      {showHeader ? (
        <header className="flex items-center justify-between border-b border-border/80 bg-surface/90 px-10 py-4">
          <span className="text-lg font-semibold text-foreground">Publex</span>
          <nav className="flex items-center gap-4 text-sm text-muted">
            <div className="hidden flex-col items-end sm:flex">
              <span className="text-xs uppercase tracking-wide text-subtle">{headerStatusLabel}</span>
              <span className="font-medium text-accent">{headerDisplayName}</span>
            </div>
            {isAuthenticated ? (
              <button
                type="button"
                onClick={onLogout}
                className="rounded-full border border-border px-4 py-1.5 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent"
              >
                Sign out
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onRequestAuth?.('login')}
                  className="rounded-full border border-accent/40 px-4 py-1.5 text-sm font-medium text-accent transition hover:border-accent hover:text-accent"
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => onRequestAuth?.('register')}
                  className="rounded-full border border-border px-4 py-1.5 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent"
                >
                  Register
                </button>
              </div>
            )}
          </nav>
        </header>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        <div className={videoPaneClasses}>
          <div ref={videoContainerRef} className="relative group flex h-full w-full max-h-full max-w-full items-center justify-center">
            <video
              ref={videoRef}
              id="dash-player"
              autoPlay
              muted
              playsInline
              crossOrigin="anonymous"
              tabIndex={0}
              className="block h-full w-full max-h-full object-contain focus:outline-none"
              onClick={(event) => {
                event.preventDefault();
                const video = videoRef.current;
                if (video && video.paused) {
                  void video.play().catch(() => {});
                }
              }}
              onPause={(event) => {
                const video = event.currentTarget;
                if (video.paused) {
                  event.preventDefault();
                  void video.play().catch(() => {});
                }
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              {resolvedSubtitleTracks.map((track) => {
                const label = track.label || (track.language ? track.language.toUpperCase() : 'Subtitles');
                return (
                  <track
                    key={`subtitle-${track.id}`}
                    kind="subtitles"
                    src={track.src}
                    label={label}
                    srcLang={track.language || ''}
                    data-stream-id={track.id}
                    data-forced={track.forced ? '1' : '0'}
                    default={Boolean(track.default && !track.forced)}
                  />
                );
              })}
            </video>

            <PlayerControlBar
              currentTime={playbackClock.currentSeconds}
              duration={playbackClock.durationSeconds ?? 0}
              bufferedPercent={bufferedPercent}
              volume={volumeLevel}
              isMuted={isMuted}
              onVolumeChange={handleVolumeSlider}
              onToggleMute={toggleMute}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              subtitleMenuOpen={subtitleMenuOpen}
              onToggleSubtitleMenu={toggleSubtitleMenu}
              resolvedSubtitleTracks={resolvedSubtitleTracks}
              activeSubtitleId={activeSubtitleId}
              onSelectSubtitle={handleSubtitleSelect}
            />

            {overlayVisible ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/85">
                <div className="space-y-2 text-center text-accent">
                  <div className="mx-auto h-4 w-4">
                    <span className="relative flex h-4 w-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500/70 opacity-75" />
                      <span className="relative inline-flex h-4 w-4 rounded-full bg-amber-300" />
                    </span>
                  </div>
                  <p className="text-base font-semibold">Stream offline</p>
                  <p className="text-xs text-accent/70">Waiting for MPD…</p>
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="absolute bottom-6 left-1/2 w-10/12 max-w-md -translate-x-1/2 rounded-xl border border-rose-500/40 bg-rose-500/20 px-4 py-3 text-center text-sm text-rose-100">
                {error}
              </p>
            ) : null}
          </div>
        </div>

        {activeSidebarTab ? (
          <aside className="flex min-w-[20rem] max-w-[28rem] flex-1 flex-col border-l border-border bg-background/95">
            {activeSidebarTab === 'metadata' ? (
              <MetadataPanel
                metadata={currentMetadata}
                loading={metadataLoading}
                error={metadataError}
                progress={playbackClock}
                onReload={handleMetadataReload}
                onViewLibrary={handleViewLibrary}
              />
            ) : null}
            {activeSidebarTab === 'chat' ? (
              <ChatPanel
                backendBase={BACKEND_BASE}
                user={user}
                viewer={viewer}
                viewerReady={viewerReady}
                loadingViewer={loadingViewer}
                onUnauthorized={onUnauthorized}
                chatPreferences={chatPreferences}
                redisStatus={redisStatus}
              />
            ) : null}
            {activeSidebarTab === 'viewers' ? (
              <ViewerPanel
                backendBase={BACKEND_BASE}
                viewer={viewer}
                viewerReady={viewerReady}
                loadingViewer={loadingViewer}
              />
            ) : null}
            {activeSidebarTab === 'status' ? (
              <StatusPanel
                backendBase={BACKEND_BASE}
                manifestUrl={manifestUrl}
                statusInfo={statusInfo}
                status={status}
                statusFetchError={statusFetchError}
                statsText={statsText}
                canViewDetailedStatus={canViewDetailedStatus}
                dashDiagnostics={dashDiagnostics}
              />
            ) : null}
            {activeSidebarTab === 'control' ? (
              <ControlPanel
                status={status}
                user={user}
                pending={pending}
                queuePending={queuePending}
                onStop={handleStop}
                onSkip={handleSkipQueueAction}
                onPlayQueue={handlePlayQueueAction}
                onRequestAuth={onRequestAuth}
              />
            ) : null}
          </aside>
        ) : null}

        <DockNav
          items={SIDEBAR_TABS}
          activeId={activeSidebarTab}
          onChange={handleSidebarChange}
        />
      </div>
    </div>
  );
}
