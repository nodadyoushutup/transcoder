import dashjs from 'dashjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BADGE_CLASSES = {
  info: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-sky-800 bg-sky-900/40 text-sky-200',
  warn: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-amber-800 bg-amber-900/40 text-amber-200',
  ok: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-emerald-800 bg-emerald-900/40 text-emerald-200',
  err: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-rose-800 bg-rose-900/40 text-rose-200',
};

const spinnerMessage = (text) => (
  <>
    <span className="relative flex h-3 w-3">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
      <span className="relative inline-flex h-3 w-3 rounded-full bg-current" />
    </span>
    <span>{text}</span>
  </>
);

const inferredBackendBase = (() => {
  if (typeof window === 'undefined') {
    return 'http://localhost:5001';
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:5001`;
})();

const BACKEND_BASE = (import.meta.env.VITE_BACKEND_URL || inferredBackendBase).replace(/\/$/, '');
const DEFAULT_STREAM_URL = import.meta.env.VITE_STREAM_URL ?? null;
const DASH_EVENTS = dashjs.MediaPlayer.events;

export default function App() {
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [manifestUrl, setManifestUrl] = useState(DEFAULT_STREAM_URL);
  const [statusInfo, setStatusInfo] = useState({ type: 'info', message: 'Initializing…' });
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [statsText, setStatsText] = useState('');

  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const pollingRef = useRef(false);
  const pollTimerRef = useRef(null);
  const consecutiveOkRef = useRef(0);
  const autoStartRef = useRef(false);
  const initPlayerRef = useRef(() => {});

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
          initPlayerRef.current();
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
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video || !manifestUrl) {
      return;
    }

    const sourceUrl = `${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}ts=${Date.now()}`;

    teardownPlayer();

    const onStreamInitialized = () => {
      hideOffline();
      setStatusBadge('ok', 'Playing live stream');
      const vid = videoRef.current;
      if (vid) {
        const playPromise = vid.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => {});
        }
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
      const response = await fetch(`${BACKEND_BASE}/transcode/status`);
      if (!response.ok) {
        throw new Error(`Backend responded with ${response.status}`);
      }
      const payload = await response.json();
      setStatus(payload);
      if (payload?.manifest_url) {
        setManifestUrl(payload.manifest_url);
      }
      setError(null);
      return payload;
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      return null;
    }
  }, []);

  useEffect(() => {
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
    playerRef.current = player;

    void fetchStatus();
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, 5000);

    return () => {
      window.clearInterval(timer);
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      pollingRef.current = false;
      teardownPlayer();
      playerRef.current = null;
    };
  }, [fetchStatus, teardownPlayer]);

  const handleStart = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await fetch(`${BACKEND_BASE}/transcode/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await fetchStatus();
      if (payload?.running) {
        startPolling();
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setPending(false);
    }
  }, [fetchStatus, startPolling]);

  const handleStop = useCallback(async () => {
    setPending(true);
    try {
      await fetch(`${BACKEND_BASE}/transcode/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      pollingRef.current = false;
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      consecutiveOkRef.current = 0;
      teardownPlayer();
      showOffline('Transcoder stopped');
      setPending(false);
      void fetchStatus();
    }
  }, [fetchStatus, showOffline, teardownPlayer]);

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

  const badgeClassName = BADGE_CLASSES[statusInfo.type] || BADGE_CLASSES.info;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="lg:flex lg:items-start min-h-screen">
        <div className="px-6 py-10 lg:w-2/3 xl:w-3/5 lg:min-h-screen lg:py-12 lg:pr-8 min-w-0">
          <div className="rounded-3xl border border-slate-800/70 bg-slate-900/70 p-4 shadow-2xl shadow-slate-950/40 backdrop-blur lg:sticky lg:top-12">
            <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-black" style={{ aspectRatio: '16 / 9' }}>
              <video
                ref={videoRef}
                id="dash-player"
                autoPlay
                muted
                playsInline
                controls
                tabIndex={0}
                className="h-full w-full object-contain focus:outline-none"
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
                <div className="absolute inset-0 flex items-center justify-center bg-black/90">
                  <div className="text-center space-y-2">
                    <div className="mx-auto h-4 w-4 text-sky-300">
                      <span className="relative flex h-4 w-4">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400/70 opacity-75" />
                        <span className="relative inline-flex h-4 w-4 rounded-full bg-sky-300" />
                      </span>
                    </div>
                    <p className="text-base font-semibold text-slate-100">Stream offline</p>
                    <p className="text-xs text-slate-400">Waiting for MPD…</p>
                  </div>
                </div>
              ) : null}
            </div>
            {error ? (
              <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex-1 px-6 py-10 lg:min-h-screen lg:max-h-screen lg:overflow-y-auto lg:py-12 min-w-0">
          <div className="flex flex-col gap-6 pb-12">
            <header className="space-y-4">
              <div>
                <h1 className="text-3xl font-semibold">Transcoder Control Panel</h1>
                <p className="mt-2 text-sm text-slate-400">
                  Backend:&nbsp;
                  <code className="rounded bg-slate-900 px-2 py-1 text-xs text-slate-200">{BACKEND_BASE}</code>
                </p>
                <p className="text-sm text-slate-400">
                  Manifest:&nbsp;
                  <code className="rounded bg-slate-900 px-2 py-1 text-xs text-slate-200">
                    {manifestUrl ?? 'pending…'}
                  </code>
                </p>
              </div>
              <span className={badgeClassName}>{statusInfo.message}</span>
            </header>

            <div className="grid gap-3 rounded-2xl border border-slate-800/70 bg-slate-950/60 p-5">
              <button
                type="button"
                onClick={handleStart}
                disabled={pending || status?.running}
                className="inline-flex items-center justify-center rounded-full bg-sky-500 px-6 py-2.5 text-base font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                Play / Start Transcoder
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={pending || !status?.running}
                className="inline-flex items-center justify-center rounded-full bg-rose-500 px-6 py-2.5 text-base font-semibold text-slate-50 transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                Stop Transcoder
              </button>
            </div>

            <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-5 space-y-3">
              <h2 className="text-xl font-semibold text-slate-100">Player Metrics</h2>
              <p className="text-sm text-slate-300">{statsText || 'Awaiting playback…'}</p>
            </div>

            <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-5">
              <h2 className="mb-4 text-xl font-semibold text-slate-100">Backend Status</h2>
              <pre className="max-h-[50vh] overflow-auto break-words rounded-2xl bg-slate-950 p-5 text-xs text-slate-300">
                {status ? JSON.stringify(status, null, 2) : 'Fetching backend status…'}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
