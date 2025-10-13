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

const sanitizeBackendBase = (raw) => {
  if (!raw) {
    return inferredBackendBase;
  }
  try {
    const url = new URL(raw);
    // Trim any trailing slash for consistency with how we concatenate request paths.
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    // Fall back to the inferred base if the provided URL is malformed.
    return inferredBackendBase;
  }
};

const buildBackendBaseCandidates = (raw) => {
  const primary = sanitizeBackendBase(raw);
  const candidates = [primary];

  try {
    const url = new URL(primary);
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    if (pathname === '/api') {
      const trimmed = new URL(primary);
      trimmed.pathname = '/';
      const trimmedBase = trimmed.toString().replace(/\/$/, '');
      if (!candidates.includes(trimmedBase)) {
        candidates.push(trimmedBase);
      }
    } else if (pathname === '/' || pathname === '') {
      const withApi = new URL(primary);
      withApi.pathname = '/api';
      const apiBase = withApi.toString().replace(/\/$/, '');
      if (!candidates.includes(apiBase)) {
        candidates.push(apiBase);
      }
    }
  } catch {
    // Ignore URL parsing errors; fall back to the single inferred candidate.
  }

  return candidates;
};

export const BACKEND_BASES = buildBackendBaseCandidates(
  import.meta.env.GUI_BACKEND_URL || inferredBackendBase,
);
export const BACKEND_BASE = BACKEND_BASES[0];
export const INGEST_BASE = (import.meta.env.GUI_INGEST_URL || inferredIngestBase).replace(/\/$/, '');

const configuredStreamUrl = import.meta.env.GUI_STREAM_URL;
export const DEFAULT_STREAM_URL = configuredStreamUrl ? configuredStreamUrl : '';
