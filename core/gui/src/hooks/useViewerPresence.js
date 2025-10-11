import { useCallback, useEffect, useMemo, useState } from 'react';
import { backendFetch } from '../lib/backend.js';

const HEARTBEAT_INTERVAL_MS = 15000;

export function useViewerPresence(user) {
  const [viewer, setViewer] = useState(null);
  const [loadingViewer, setLoadingViewer] = useState(true);

  const identifyViewer = useCallback(async () => {
    setLoadingViewer(true);
    try {
      const response = await backendFetch('/viewers/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Viewer identify failed (${response.status})`);
      }
      const viewerPayload = payload?.viewer ?? {};
      const token = viewerPayload?.token || null;
      const kind = viewerPayload?.kind === 'user' ? 'user' : 'guest';
      const guestName = payload?.guest?.name || null;
      const displayName = viewerPayload?.display_name
        || user?.username
        || guestName
        || 'Viewer';
      const senderKey = kind === 'user' && user?.id != null
        ? `user:${user.id}`
        : token
          ? `guest:${token}`
          : null;

      const resolvedViewer = {
        token,
        kind,
        displayName,
        guestName: kind === 'guest' ? (guestName || displayName) : null,
        senderKey,
      };
      setViewer(resolvedViewer);
      setLoadingViewer(false);
      return resolvedViewer;
    } catch (error) {
      setViewer((current) => {
        if (current) {
          return current;
        }
        const fallback = user
          ? {
              token: null,
              kind: 'user',
              displayName: user.username,
              guestName: null,
              senderKey: user.id != null ? `user:${user.id}` : null,
            }
          : {
              token: null,
              kind: 'guest',
              displayName: 'Viewer',
              guestName: 'Viewer',
              senderKey: null,
            };
        return fallback;
      });
      setLoadingViewer(false);
      return null;
    }
  }, [user?.id, user?.username]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await identifyViewer();
      if (!cancelled && !result && user) {
        // Attempt to refresh once more if logged in user
        await identifyViewer();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identifyViewer, user]);

  useEffect(() => {
    if (!viewer?.token) {
      return undefined;
    }
    let cancelled = false;
    const heartbeat = async () => {
      try {
        await backendFetch('/viewers/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token: viewer.token }),
        });
      } catch {
        /* noop */
      }
    };
    heartbeat();
    const interval = window.setInterval(() => {
      if (!cancelled) {
        void heartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [viewer?.token]);

  const ready = useMemo(() => !loadingViewer && viewer != null, [loadingViewer, viewer]);

  return {
    viewer,
    loadingViewer,
    viewerReady: ready,
    refreshViewer: identifyViewer,
  };
}

export default useViewerPresence;
