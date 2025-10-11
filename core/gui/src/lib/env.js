const inferredBackendBase = (() => {
  if (typeof window === 'undefined') {
    return 'http://localhost:5001';
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:5001`;
})();

const inferredIngestBase = (() => {
  if (typeof window === 'undefined') {
    return 'http://localhost:5005';
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:5005`;
})();

const normalizeBackendBase = (raw) => {
  if (!raw) {
    return inferredBackendBase;
  }
  try {
    const url = new URL(raw);
    // Drop legacy `/api` suffixes so the refactored backend routes resolve correctly.
    if (url.pathname === '/api' || url.pathname === '/api/') {
      url.pathname = '/';
    }
    // Trim any trailing slash for consistency with how we concatenate request paths.
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    // Fall back to the inferred base if the provided URL is malformed.
    return inferredBackendBase;
  }
};

export const BACKEND_BASE = normalizeBackendBase(import.meta.env.GUI_BACKEND_URL || inferredBackendBase);
export const INGEST_BASE = (import.meta.env.GUI_INGEST_URL || inferredIngestBase).replace(/\/$/, '');

const configuredStreamUrl = import.meta.env.GUI_STREAM_URL;
export const DEFAULT_STREAM_URL = configuredStreamUrl
  ? configuredStreamUrl
  : `${INGEST_BASE}/media/audio_video.mpd`;
