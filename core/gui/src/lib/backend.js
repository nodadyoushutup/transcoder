import { BACKEND_BASES } from './env.js';

const UNIQUE_BASES = Array.from(
  new Set(BACKEND_BASES.filter((candidate) => typeof candidate === 'string' && candidate)),
);

if (UNIQUE_BASES.length === 0) {
  UNIQUE_BASES.push('http://localhost:5001');
}

let resolvedBackendBase = UNIQUE_BASES[0];
const backendBaseListeners = new Set();

const joinBaseAndPath = (base, path) => {
  const normalizedBase = base.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

const notifyBackendBaseChange = (nextBase) => {
  backendBaseListeners.forEach((listener) => {
    try {
      listener(nextBase);
    } catch {
      // Ignore listener errors so one failure doesn't block others.
    }
  });
};

const setResolvedBackendBase = (nextBase) => {
  if (nextBase && resolvedBackendBase !== nextBase) {
    resolvedBackendBase = nextBase;
    notifyBackendBaseChange(resolvedBackendBase);
  }
};

export const getBackendBase = () => resolvedBackendBase;

export const getBackendBases = () => UNIQUE_BASES.slice();

export const subscribeBackendBase = (listener) => {
  backendBaseListeners.add(listener);
  return () => {
    backendBaseListeners.delete(listener);
  };
};

export const backendUrl = (path = '/') => {
  const normalizedPath = path || '/';
  return joinBaseAndPath(getBackendBase(), normalizedPath);
};

export const backendFetch = async (path, options = {}) => {
  const normalizedPath = typeof path === 'string' && path ? path : '/';
  let lastError = null;
  let lastResponse = null;

  for (let index = 0; index < UNIQUE_BASES.length; index += 1) {
    const base = UNIQUE_BASES[index];
    const url = joinBaseAndPath(base, normalizedPath);
    try {
      const response = await fetch(url, options);
      lastResponse = response;
      if (response.status !== 404) {
        setResolvedBackendBase(base);
        return response;
      }
    } catch (error) {
      lastError = error;
      if (index === UNIQUE_BASES.length - 1) {
        throw error;
      }
      continue;
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to determine backend base URL.');
};

export default backendFetch;
