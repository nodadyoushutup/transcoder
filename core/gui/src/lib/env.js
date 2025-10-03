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

export const BACKEND_BASE = (import.meta.env.VITE_BACKEND_URL || inferredBackendBase).replace(/\/$/, '');
export const INGEST_BASE = (import.meta.env.VITE_INGEST_URL || inferredIngestBase).replace(/\/$/, '');

const configuredStreamUrl = import.meta.env.VITE_STREAM_URL;
export const DEFAULT_STREAM_URL = configuredStreamUrl
  ? configuredStreamUrl
  : `${INGEST_BASE}/media/audio_video.mpd`;
