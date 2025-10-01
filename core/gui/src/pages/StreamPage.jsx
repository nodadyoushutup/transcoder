import dashjs from 'dashjs';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faGaugeHigh, faSliders, faUsers } from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import ControlPanel from '../components/ControlPanel.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import ViewerPanel from '../components/ViewerPanel.jsx';
import DockNav from '../components/navigation/DockNav.jsx';
import StatusPanel from '../components/StatusPanel.jsx';
import { BACKEND_BASE, DEFAULT_STREAM_URL } from '../lib/env.js';

const DASH_EVENTS = dashjs.MediaPlayer.events;

const SIDEBAR_TABS = [
  { id: 'chat', label: 'Chat', icon: () => <FontAwesomeIcon icon={faComments} size="lg" /> },
  { id: 'viewers', label: 'Viewers', icon: () => <FontAwesomeIcon icon={faUsers} size="lg" /> },
  { id: 'status', label: 'Status', icon: () => <FontAwesomeIcon icon={faGaugeHigh} size="lg" /> },
  { id: 'control', label: 'Control', icon: () => <FontAwesomeIcon icon={faSliders} size="lg" /> },
];

const SIDEBAR_STORAGE_KEY = 'stream.sidebarTab';

const spinnerMessage = (text) => (
  <>
    <span className="relative flex h-3 w-3">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-current" />
    </span>
    <span>{text}</span>
  </>
);

function createPlayer() {
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
}) {
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [statusFetchError, setStatusFetchError] = useState(null);
  const [manifestUrl, setManifestUrl] = useState(DEFAULT_STREAM_URL);
  const [statusInfo, setStatusInfo] = useState({ type: 'info', message: 'Initializing…' });
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [statsText, setStatsText] = useState('');
  const [activeSidebarTab, setActiveSidebarTab] = useState(() => {
    if (typeof window === 'undefined') {
      return 'control';
    }
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === 'none') {
      return null;
    }
    if (SIDEBAR_TABS.some((tab) => tab.id === stored)) {
      return stored;
    }
    return 'control';
  });

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const pollingRef = useRef(false);
  const pollTimerRef = useRef(null);
  const consecutiveOkRef = useRef(0);
  const autoStartRef = useRef(false);
  const initPlayerRef = useRef(() => {});

  const handleSidebarChange = useCallback((nextId) => {
    setActiveSidebarTab(nextId);
  }, []);

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

  const teardownPlayer = useCallback(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (player) {
      try {
        if (player.__onStreamInitialized) {
          player.off(DASH_EVENTS.STREAM_INITIALIZED, player.__onStreamInitialized);
          player.__onStreamInitialized = undefined;
        }
        if (player.__onStreamError) {
          player.off(DASH_EVENTS.ERROR, player.__onStreamError);
          player.__onStreamError = undefined;
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
      const probeUrl = `${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}probe=${Date.now()}`;
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
  }, [headOrGet, manifestUrl, setStatusBadge, showOffline]);

  const initPlayer = useCallback(() => {
    const video = videoRef.current;
    if (!video || !manifestUrl) {
      return;
    }

    teardownPlayer();
    const player = createPlayer();
    playerRef.current = player;

    const sourceUrl = `${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}ts=${Date.now()}`;

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
    player.on(DASH_EVENTS.STREAM_INITIALIZED, onStreamInitialized);
    player.on(DASH_EVENTS.ERROR, onError);

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
  }, [hideOffline, manifestUrl, setStatusBadge, showOffline, startPolling, teardownPlayer]);

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

  useEffect(() => {
    playerRef.current = createPlayer();

    void fetchStatus();
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, 5000);

    return () => {
      window.clearInterval(timer);
      teardownPlayer();
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, [fetchStatus, teardownPlayer]);

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
    let rafId = null;
    const updateStats = () => {
      const player = playerRef.current;
      const video = videoRef.current;
      if (player && video) {
        try {
          const isLive = player.isDynamic?.() ?? false;
          const duration = typeof player.duration === 'function' ? player.duration() : NaN;
          const currentTime = video.currentTime || 0;
          const latency = isLive && !Number.isNaN(duration) ? Math.max(0, duration - currentTime) : 0;
          const buffered = video.buffered?.length
            ? Math.max(0, video.buffered.end(video.buffered.length - 1) - currentTime)
            : 0;
          setStatsText(
            `Latency: ${latency.toFixed(2)}s · Buffered: ${buffered.toFixed(2)}s · Position: ${currentTime.toFixed(2)}s`,
          );
        } catch {
          setStatsText('');
        }
      } else {
        setStatsText('');
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

  const handleStart = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${BACKEND_BASE}/transcode/start`, {
        method: 'POST',
        credentials: 'include',
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to start transcoder (${response.status})`);
      }
      setStatusBadge('info', spinnerMessage('Starting transcoder…'));
      showOffline('Starting transcoder…');
      pollingRef.current = false;
      consecutiveOkRef.current = 0;
      setManifestUrl(null);
      void fetchStatus();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusFetchError((prev) => prev ?? message);
    } finally {
      setPending(false);
    }
  }, [fetchStatus, onUnauthorized, showOffline, setStatusBadge]);

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
              className="max-h-full max-w-full object-contain focus:outline-none"
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
            {activeSidebarTab === 'chat' ? (
              <ChatPanel
                backendBase={BACKEND_BASE}
                user={user}
                viewer={viewer}
                viewerReady={viewerReady}
                loadingViewer={loadingViewer}
                onUnauthorized={onUnauthorized}
                chatPreferences={chatPreferences}
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
                onStart={handleStart}
                onStop={handleStop}
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
