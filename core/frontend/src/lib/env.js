const inferredBackendBase = (() => {
  if (typeof window === 'undefined') {
    return 'http://localhost:5001';
  }
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:5001`;
})();

export const BACKEND_BASE = (import.meta.env.VITE_BACKEND_URL || inferredBackendBase).replace(/\/$/, '');
export const DEFAULT_STREAM_URL = import.meta.env.VITE_STREAM_URL ?? null;
