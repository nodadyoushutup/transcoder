import { useCallback, useEffect, useMemo, useState } from 'react';
import AppHeader from './components/AppHeader.jsx';
import { useAuthSession } from './hooks/useAuthSession.js';
import useViewerPresence from './hooks/useViewerPresence.js';
import AuthPage from './pages/AuthPage.jsx';
import StreamPage from './pages/StreamPage.jsx';
import PreferencesPage from './pages/PreferencesPage.jsx';
import SystemSettingsPage from './pages/SystemSettingsPage.jsx';
import LibraryPage from './pages/LibraryPage.jsx';
import { fetchPreferences } from './lib/api.js';

const DEFAULT_THEME = 'dark';
const THEME_STORAGE_KEY = 'publex.theme';
const THEME_ALIASES = {
  monaki: 'monokai',
  dracula: 'darcula',
};
const AVAILABLE_THEMES = new Set(['dark', 'light', 'monokai', 'darcula']);

function normalizeTheme(value) {
  if (!value) {
    return DEFAULT_THEME;
  }
  const lower = String(value).toLowerCase();
  const resolved = THEME_ALIASES[lower] || lower;
  if (AVAILABLE_THEMES.has(resolved)) {
    return resolved;
  }
  return DEFAULT_THEME;
}

const DEFAULT_VIEW = 'stream';
const VIEW_STORAGE_KEY = 'publex.activeView';
const AVAILABLE_VIEWS = new Set(['stream', 'library', 'preferences', 'settings']);

function normalizeView(value) {
  if (!value) {
    return DEFAULT_VIEW;
  }
  const candidate = String(value).toLowerCase();
  if (AVAILABLE_VIEWS.has(candidate)) {
    return candidate;
  }
  return DEFAULT_VIEW;
}

function determineCanAccessSettings(user) {
  if (!user) {
    return false;
  }
  if (user.is_admin) {
    return true;
  }
  const permissions = new Set(user.permissions || []);
  return (
    permissions.has('*')
    || permissions.has('system.settings.manage')
    || permissions.has('transcoder.settings.manage')
    || permissions.has('users.manage')
    || permissions.has('chat.settings.manage')
  );
}

function App() {
  const {
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
    reloadSession,
    handleUnauthorized,
  } = useAuthSession();

  const { viewer, loadingViewer, viewerReady } = useViewerPresence(user);
  const [authVisible, setAuthVisible] = useState(false);
  const [activeView, setActiveView] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = window.sessionStorage.getItem(VIEW_STORAGE_KEY);
        if (stored) {
          return normalizeView(stored);
        }
      } catch (error) {
        console.warn('Failed to read view preference from sessionStorage', error);
      }
    }
    return DEFAULT_VIEW;
  });
  const [chatPreferences, setChatPreferences] = useState(null);
  const [appearancePreferences, setAppearancePreferences] = useState(null);
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored) {
        return normalizeTheme(stored);
      }
    }
    return DEFAULT_THEME;
  });
  const [libraryFocus, setLibraryFocus] = useState(null);

  const canAccessSettings = useMemo(() => determineCanAccessSettings(user), [user]);

  useEffect(() => {
    if (!initializing && !user && activeView !== DEFAULT_VIEW) {
      setActiveView(DEFAULT_VIEW);
    }
  }, [user, activeView, initializing]);

  useEffect(() => {
    if (!initializing && !canAccessSettings && activeView === 'settings') {
      setActiveView(DEFAULT_VIEW);
    }
  }, [canAccessSettings, activeView, initializing]);

  useEffect(() => {
    let ignore = false;
    if (!user) {
      setChatPreferences(null);
      setAppearancePreferences(null);
      setTheme(DEFAULT_THEME);
      return () => {
        ignore = true;
      };
    }
    (async () => {
      try {
        const data = await fetchPreferences();
        if (!ignore) {
          const chatSettings = data?.chat?.settings || data?.chat?.defaults || null;
          setChatPreferences(chatSettings);
          const themeSetting = (
            data?.appearance?.settings?.theme
            || data?.appearance?.defaults?.theme
            || DEFAULT_THEME
          );
          const normalizedTheme = normalizeTheme(themeSetting);
          setAppearancePreferences({ theme: normalizedTheme });
          setTheme(normalizedTheme);
        }
      } catch {
        if (!ignore) {
          setChatPreferences(null);
          setAppearancePreferences(null);
          setTheme(DEFAULT_THEME);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [user]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme]);

  const openAuth = useCallback(
    (mode = 'login') => {
      setAuthMode(mode);
      clearAuthError();
      setAuthVisible(true);
    },
    [clearAuthError, setAuthMode],
  );

  const closeAuth = useCallback(() => {
    setAuthVisible(false);
    clearAuthError();
  }, [clearAuthError]);

  const handleUnauthorizedPrompt = useCallback(() => {
    handleUnauthorized();
    setAuthVisible(true);
  }, [handleUnauthorized]);

  const handleLogout = useCallback(async () => {
    await logout();
    setActiveView(DEFAULT_VIEW);
    setAuthVisible(false);
    setAppearancePreferences(null);
    setTheme(DEFAULT_THEME);
  }, [logout]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.sessionStorage.setItem(VIEW_STORAGE_KEY, activeView);
    } catch (error) {
      console.warn('Failed to persist view preference to sessionStorage', error);
    }
  }, [activeView]);

  useEffect(() => {
    if (user && authVisible) {
      setAuthVisible(false);
    }
  }, [authVisible, user]);

  const isAuthenticated = Boolean(user);

  const handleChatPreferencesChange = useCallback((prefs) => {
    setChatPreferences(prefs);
  }, []);

  const handleThemeChange = useCallback((nextTheme) => {
    const normalized = normalizeTheme(nextTheme);
    setTheme(normalized);
    setAppearancePreferences({ theme: normalized });
  }, []);

  const handleOpenLibraryItem = useCallback(
    (target) => {
      const ratingKey = target?.ratingKey ?? target?.rating_key ?? null;
      const librarySectionId = target?.librarySectionId ?? target?.library_section_id ?? null;
      if (ratingKey) {
        setLibraryFocus({ ratingKey, librarySectionId: librarySectionId ?? null });
      } else {
        setLibraryFocus(null);
      }
      setActiveView('library');
    },
    [setActiveView, setLibraryFocus],
  );

  if (initializing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-subtle">
        <span className="text-sm">Checking session…</span>
      </main>
    );
  }

  return (
    <>
      <div className="flex h-screen w-full flex-col bg-background text-foreground">
        <AppHeader
          brand="Publex"
          isAuthenticated={isAuthenticated}
          user={user}
          onSignIn={openAuth}
          onRegister={openAuth}
          onLogout={handleLogout}
          onNavigate={(next) => setActiveView(next)}
          activeView={activeView}
          canAccessSettings={canAccessSettings}
        />

        <div className="flex flex-1 w-full min-h-0 overflow-hidden">
          {activeView === 'stream' ? (
            <StreamPage
              user={user}
              viewer={viewer}
              viewerReady={viewerReady}
              loadingViewer={loadingViewer}
              onLogout={handleLogout}
              onUnauthorized={handleUnauthorizedPrompt}
              onRequestAuth={openAuth}
              showHeader={false}
              chatPreferences={chatPreferences}
              onViewLibraryItem={handleOpenLibraryItem}
            />
          ) : null}

          {activeView === 'library' ? (
            <LibraryPage
              onStartPlayback={() => {
                setActiveView('stream');
              }}
              focusItem={libraryFocus}
              onConsumeFocus={() => setLibraryFocus(null)}
            />
          ) : null}

          {activeView === 'preferences' ? (
            <PreferencesPage
              user={user}
              onReloadSession={reloadSession}
              initialChatPreferences={chatPreferences}
              initialAppearance={appearancePreferences}
              onChatPreferencesChange={handleChatPreferencesChange}
              onThemeChange={handleThemeChange}
            />
          ) : null}

          {activeView === 'settings' ? (
            <SystemSettingsPage user={user} />
          ) : null}
        </div>
      </div>

      {authVisible ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 px-4">
          <div className="absolute inset-0" onMouseDown={closeAuth} />
          <div className="relative z-10 w-full max-w-md">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={closeAuth}
                className="rounded-full border border-border px-3 py-1 text-sm text-muted transition hover:border-accent hover:text-accent"
              >
                Close
              </button>
            </div>
            <AuthPage
              embedded
              mode={authMode}
              setMode={setAuthMode}
              pending={pending}
              error={authError}
              onLogin={(identifier, password) => {
                clearAuthError();
                return login(identifier, password);
              }}
              onRegister={(username, email, password) => {
                clearAuthError();
                return register(username, email, password);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export default App;
