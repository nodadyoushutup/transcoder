import { useCallback, useEffect, useState } from 'react';
import { BACKEND_BASE } from '../lib/env.js';

export function useAuthSession() {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [authMode, setAuthModeState] = useState('login');
  const [authError, setAuthError] = useState(null);
  const [pending, setPending] = useState(false);

  const setAuthMode = useCallback((mode) => {
    setAuthModeState(mode);
    setAuthError(null);
  }, []);

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

  const handleUnauthorized = useCallback(() => {
    setUser(null);
    setAuthMode('login');
    setAuthError('Session expired. Please sign in again.');
  }, [setAuthMode]);

  const login = useCallback(
    async (identifier, password) => {
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
    },
    [setAuthMode],
  );

  const register = useCallback(async (username, email, password) => {
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
  }, [setAuthMode]);

  const logout = useCallback(async () => {
    try {
      await fetch(`${BACKEND_BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {}
    setUser(null);
    setAuthMode('login');
  }, [setAuthMode]);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  return {
    user,
    initializing,
    authMode,
    setAuthMode,
    authError,
    clearAuthError,
    pending,
    login,
    register,
    logout,
    reloadSession: loadSession,
    handleUnauthorized,
  };
}
