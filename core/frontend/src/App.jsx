import dashjs from 'dashjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BADGE_CLASSES = {
  info: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-zinc-700 bg-zinc-800/60 text-zinc-200',
  warn: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-zinc-700 bg-amber-600/20 text-amber-200',
  ok: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-zinc-700 bg-emerald-600/20 text-emerald-200',
  err: 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs border-zinc-700 bg-rose-600/20 text-rose-200',
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

function LoginForm({ onSubmit, pending, error, switchToRegister }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(identifier.trim(), password);
      }}
    >
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          type="text"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-center text-sm text-zinc-400">
        Need an account?{' '}
        <button
          type="button"
          className="font-medium text-amber-400 transition hover:text-amber-300"
          onClick={switchToRegister}
          disabled={pending}
        >
          Register
        </button>
      </p>
    </form>
  );
}

function RegisterForm({ onSubmit, pending, error, switchToLogin }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(username.trim(), email.trim(), password);
      }}
    >
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="reg-username">
          Username
        </label>
        <input
          id="reg-username"
          type="text"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="reg-email">
          Email
        </label>
        <input
          id="reg-email"
          type="email"
          autoComplete="email"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="reg-password">
          Password
        </label>
        <input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {pending ? 'Creating account…' : 'Create account'}
      </button>
      <p className="text-center text-sm text-zinc-400">
        Already registered?{' '}
        <button
          type="button"
          className="font-medium text-amber-400 transition hover:text-amber-300"
          onClick={switchToLogin}
          disabled={pending}
        >
          Sign in
        </button>
      </p>
    </form>
  );
}

function AuthPage({ mode, setMode, pending, error, onLogin, onRegister }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 px-4 text-zinc-100">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-zinc-800/80 bg-zinc-900/90 p-10 shadow-2xl">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold text-white">Publex Control</h1>
          <p className="text-sm text-zinc-400">
            {mode === 'login' ? 'Sign in to manage your transcoder.' : 'Create an account to manage your transcoder.'}
          </p>
        </div>
        {mode === 'login' ? (
          <LoginForm
            onSubmit={onLogin}
            pending={pending}
            error={error}
            switchToRegister={() => setMode('register')}
          />
        ) : (
          <RegisterForm
            onSubmit={onRegister}
            pending={pending}
            error={error}
            switchToLogin={() => setMode('login')}
          />
        )}
      </div>
    </main>
  );
}

function Dashboard({ user, onLogout, onUnauthorized }) {
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
      return payload;
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
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
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      pollingRef.current = false;
      teardownPlayer();
    };
  }, [fetchStatus, teardownPlayer]);

  const handleStart = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${BACKEND_BASE}/transcode/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.error ?? `Backend responded with ${response.status}`;
        throw new Error(message);
      }
      const payload = await fetchStatus();
      if (payload?.running) {
        startPolling();
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setPending(false);
    }
  }, [fetchStatus, onUnauthorized, startPolling]);

  const handleStop = useCallback(async () => {
    setPending(true);
    try {
      const response = await fetch(`${BACKEND_BASE}/transcode/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.error ?? `Backend responded with ${response.status}`;
        throw new Error(message);
      }
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
      setManifestUrl(null);
      showOffline('Transcoder stopped');
      setPending(false);
      void fetchStatus();
    }
  }, [fetchStatus, onUnauthorized, showOffline, teardownPlayer]);

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

  const statsPanel = useMemo(
    () => (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-200">Player Metrics</h2>
          <span className="text-xs text-zinc-400">Signed in as <span className="font-medium text-amber-400">{user.username}</span></span>
        </div>
        <p className="text-sm text-zinc-300">{statsText || 'Awaiting playback…'}</p>
      </div>
    ),
    [statsText, user.username],
  );

  return (
    <main className="flex h-screen flex-col bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/90 px-10 py-4">
        <span className="text-lg font-semibold text-white">Publex</span>
        <nav className="flex items-center gap-6 text-sm text-zinc-300">
          <span className="hidden sm:inline">Welcome, <span className="font-medium text-amber-400">{user.username}</span></span>
          <button
            type="button"
            onClick={onLogout}
            className="rounded-full border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 transition hover:border-amber-500 hover:text-amber-300"
          >
            Sign out
          </button>
        </nav>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-[3] items-center justify-center bg-black px-0 py-10 lg:px-0">
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
                <div className="space-y-2 text-center text-amber-300">
                  <div className="mx-auto h-4 w-4">
                    <span className="relative flex h-4 w-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500/70 opacity-75" />
                      <span className="relative inline-flex h-4 w-4 rounded-full bg-amber-300" />
                    </span>
                  </div>
                  <p className="text-base font-semibold">Stream offline</p>
                  <p className="text-xs text-amber-200/70">Waiting for MPD…</p>
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

        <div className="flex min-w-0 flex-[1] flex-col gap-6 overflow-y-auto border-l border-zinc-900 bg-zinc-950/95 px-6 py-10 lg:px-8">
          <header className="space-y-4">
            <div>
              <h1 className="text-3xl font-semibold text-amber-500">Transcoder Control Panel</h1>
              <p className="mt-2 text-sm text-zinc-300">
                Backend:&nbsp;
                <code className="rounded bg-zinc-900 px-2 py-1 text-xs text-amber-400">{BACKEND_BASE}</code>
              </p>
              <p className="text-sm text-zinc-300">
                Manifest:&nbsp;
                <code className="rounded bg-zinc-900 px-2 py-1 text-xs text-amber-400">{manifestUrl ?? 'pending…'}</code>
              </p>
            </div>
            <span className={badgeClassName}>{statusInfo.message}</span>
          </header>

          <div className="grid gap-3 rounded-2xl border border-amber-500/30 bg-zinc-900/80 p-5">
            <button
              type="button"
              onClick={handleStart}
              disabled={pending || status?.running}
              className="inline-flex items-center justify-center rounded-full bg-amber-500 px-6 py-2.5 text-base font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              Play / Start Transcoder
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={pending || !status?.running}
              className="inline-flex items-center justify-center rounded-full bg-rose-500 px-6 py-2.5 text-base font-semibold text-zinc-50 transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              Stop Transcoder
            </button>
          </div>

          {statsPanel}

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-200">Backend Status</h2>
              <span className="text-xs text-zinc-500">User: {user.email}</span>
            </div>
            <pre className="max-h-[50vh] overflow-auto break-words rounded-2xl bg-zinc-950/90 p-5 text-xs text-zinc-200">
              {status ? JSON.stringify(status, null, 2) : 'Fetching backend status…'}
            </pre>
          </div>
        </div>
      </div>
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [authMode, setAuthMode] = useState('login');
  const [authError, setAuthError] = useState(null);
  const [pending, setPending] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`${BACKEND_BASE}/auth/session`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Session check failed (${response.status})`);
      }
      const payload = await response.json();
      setUser(payload?.user ?? null);
      setAuthError(null);
    } catch {
      setUser(null);
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    setAuthError(null);
  }, [authMode]);

  const handleUnauthorized = useCallback(() => {
    setUser(null);
    setAuthMode('login');
    setAuthError('Session expired. Please sign in again.');
  }, []);

  const handleLogin = useCallback(async (identifier, password) => {
    if (!identifier || !password) {
      setAuthError('Identifier and password are required.');
      return;
    }
    setPending(true);
    setAuthError(null);
    try {
      const response = await fetch(`${BACKEND_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ identifier, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setAuthError(payload?.error ?? 'Unable to sign in.');
        return;
      }
      setUser(payload?.user ?? null);
      setAuthMode('login');
    } catch (exc) {
      setAuthError(exc instanceof Error ? exc.message : 'Unable to sign in.');
    } finally {
      setPending(false);
      setInitializing(false);
    }
  }, []);

  const handleRegister = useCallback(async (username, email, password) => {
    if (!username || !email || !password) {
      setAuthError('Username, email, and password are required.');
      return;
    }
    setPending(true);
    setAuthError(null);
    try {
      const response = await fetch(`${BACKEND_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, email, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setAuthError(payload?.error ?? 'Unable to create account.');
        return;
      }
      setUser(payload?.user ?? null);
      setAuthMode('login');
    } catch (exc) {
      setAuthError(exc instanceof Error ? exc.message : 'Unable to create account.');
    } finally {
      setPending(false);
      setInitializing(false);
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await fetch(`${BACKEND_BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {}
    setUser(null);
    setAuthMode('login');
  }, []);

  if (initializing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-300">
        <span className="text-sm">Checking session…</span>
      </main>
    );
  }

  if (!user) {
    return (
      <AuthPage
        mode={authMode}
        setMode={setAuthMode}
        pending={pending}
        error={authError}
        onLogin={handleLogin}
        onRegister={handleRegister}
      />
    );
  }

  return <Dashboard user={user} onLogout={handleLogout} onUnauthorized={handleUnauthorized} />;
}

export default App;
