import * as dashjsModule from 'dashjs';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faComments, faGaugeHigh, faSliders, faUsers } from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import ControlPanel from '../components/ControlPanel.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import ViewerPanel from '../components/ViewerPanel.jsx';
import DockNav from '../components/navigation/DockNav.jsx';
import StatusPanel from '../components/StatusPanel.jsx';
import MetadataPanel from '../components/MetadataPanel.jsx';
import { fetchCurrentPlayback, playQueue, skipQueue } from '../lib/api.js';
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

function createPlayer() {
  const dashjs = resolveDashjs();
  if (!dashjs?.MediaPlayer) {
    console.error('dash.js MediaPlayer API unavailable');
    return null;
  }

  const player = dashjs.MediaPlayer().create();
  player.updateSettings({
    streaming: {
      delay: {
        liveDelay: Number.NaN,
        liveDelayFragmentCount: 3,
        useSuggestedPresentationDelay: true,
      },
      liveCatchup: {
        enabled: true,
        maxDrift: 1.0,
        playbackRate: { min: -0.2, max: 0.2 },
      },
      buffer: {
        fastSwitchEnabled: false,
        bufferPruningInterval: 10,
        bufferToKeep: 6,
        bufferTimeAtTopQuality: 8,
        bufferTimeAtTopQualityLongForm: 8,
      },
      text: { defaultEnabled: false },
    },
  });
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
  const [statusInfo, setStatusInfo] = useState({ type: 'info', message: 'Initializing…' });
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [statsText, setStatsText] = useState('');
  const [currentMetadata, setCurrentMetadata] = useState(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState(null);
  const [metadataRefreshTick, setMetadataRefreshTick] = useState(0);
  const [redisStatus, setRedisStatus] = useState({ available: true, last_error: null });
  const [playbackClock, setPlaybackClock] = useState({ currentSeconds: 0, durationSeconds: null });
  const [queuePending, setQueuePending] = useState(false);
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

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const pollingRef = useRef(false);
  const pollTimerRef = useRef(null);
  const consecutiveOkRef = useRef(0);
  const autoStartRef = useRef(false);
  const initPlayerRef = useRef(() => {});
  const lastPidRef = useRef(null);
  const metadataTokenRef = useRef(null);
  const metadataRetryTimerRef = useRef(null);
  const playbackClockRef = useRef({ currentSeconds: 0, durationSeconds: null });

  const handleSidebarChange = useCallback((nextId) => {
    setActiveSidebarTab(nextId);
  }, []);

  const handleMetadataReload = useCallback(() => {
    if (metadataRetryTimerRef.current) {
      window.clearTimeout(metadataRetryTimerRef.current);
      metadataRetryTimerRef.current = null;
    }
    setMetadataRefreshTick((prev) => prev + 1);
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

  useEffect(() => {
    return () => {
      if (metadataRetryTimerRef.current) {
        window.clearTimeout(metadataRetryTimerRef.current);
      }
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

  const teardownPlayer = useCallback(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (player) {
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
    pollingRef.current = true;
    consecutiveOkRef.current = 0;
    showOffline();
    setStatusBadge('info', spinnerMessage('Checking MPD…'));

    const tick = async () => {
      const probeUrl = cacheBustUrl(manifestUrl, 'probe');
      const response = await headOrGet(probeUrl);

      if (response.ok) {
        consecutiveOkRef.current += 1;
        setStatusBadge('info', spinnerMessage(`MPD OK (${consecutiveOkRef.current}/2)…`));
        if (consecutiveOkRef.current >= 2) {
          pollingRef.current = false;
          if (pollTimerRef.current) {
            window.clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          setStatusBadge('info', spinnerMessage('Attaching player…'));
          initPlayerRef.current?.();
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

  const initPlayer = useCallback(() => {
    const video = videoRef.current;
    if (!video || !manifestUrl) {
      return;
    }

    teardownPlayer();
    const player = createPlayer();
    if (!player) {
      setStatusBadge('warn', spinnerMessage('Video player runtime unavailable'));
      showOffline('Waiting for player runtime…');
      return;
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
      return;
    }

    playerRef.current = player;

    const sourceUrl = cacheBustUrl(manifestUrl);

    const onStreamInitialized = () => {
      hideOffline();
      setStatusBadge('ok', 'Live');
      const vid = videoRef.current;
      if (vid) {
        const playPromise = vid.play?.();
        playPromise?.catch(() => {});
      }
    };

    const onError = (evt) => {
      const http = evt?.event?.status || evt?.status || 0;
      setStatusBadge('warn', spinnerMessage(`Player error (${http || 'network'}) — rechecking`));
      teardownPlayer();
      pollingRef.current = false;
      consecutiveOkRef.current = 0;
      showOffline('Recovering from player error…');
      startPolling();
    };

    player.__onStreamInitialized = onStreamInitialized;
    player.__onStreamError = onError;
    player.on(dashEvents.STREAM_INITIALIZED, onStreamInitialized);
    player.on(dashEvents.ERROR, onError);

    if (!video.dataset.started) {
      video.muted = true;
      video.dataset.started = '1';
    }
    video.autoplay = true;
    video.playsInline = true;

    try {
      player.setAutoPlay(true);
      player.initialize(video, null, true);
      player.attachSource(sourceUrl);
    } catch (err) {
      console.error('Failed to initialise dash.js player', err);
      setStatusBadge('warn', spinnerMessage('Player failed, retrying…'));
      teardownPlayer();
      showOffline('Player failed, retrying…');
      startPolling();
    }
  }, [cacheBustUrl, hideOffline, manifestUrl, setStatusBadge, showOffline, startPolling, teardownPlayer]);

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
      setStatus(payload);
      if (payload?.manifest_url) {
        setManifestUrl(payload.manifest_url);
      }
      setError(null);
      setStatusFetchError(null);
      return payload;
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusFetchError(message);
      setStatus(null);
      return null;
    }
  }, [onUnauthorized]);

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
    const player = createPlayer();
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

    if (currentPid !== previousPid) {
      lastPidRef.current = currentPid;
      if (currentPid && status?.running) {
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
  }, [setStatusBadge, showOffline, startPolling, status?.pid, status?.running, teardownPlayer]);

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
      showOffline('Transcoder offline');
    }
  }, [manifestUrl, showOffline, startPolling, status?.running]);

  useEffect(() => {
    const running = status?.running === true;
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
        const data = await fetchCurrentPlayback();
        setRedisStatus(data?.redis ?? { available: false, last_error: 'Redis unavailable' });
        if (cancelled) {
          return;
        }
        const hasItem = data?.item && Object.keys(data.item).length > 0;
        if (hasItem) {
          metadataTokenRef.current = token;
          setCurrentMetadata(data);
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
    let rafId = null;
    const updateStats = () => {
      const player = playerRef.current;
      const video = videoRef.current;
      if (player && video) {
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
          setStatsText(
            `Latency: ${latency.toFixed(2)}s · Buffered: ${buffered.toFixed(2)}s · Position: ${currentTime.toFixed(2)}s`,
          );

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
      if (!player || !video) {
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
      if (!response.ok) {
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
          <div className="relative flex h-full w-full max-h-full max-w-full items-center justify-center">
            <video
              ref={videoRef}
              id="dash-player"
              autoPlay
              muted
              playsInline
              controls
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
