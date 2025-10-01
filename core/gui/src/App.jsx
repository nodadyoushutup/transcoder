import { useCallback, useEffect, useMemo, useState } from 'react';
import AppHeader from './components/AppHeader.jsx';
import { useAuthSession } from './hooks/useAuthSession.js';
import useViewerPresence from './hooks/useViewerPresence.js';
import AuthPage from './pages/AuthPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PreferencesPage from './pages/PreferencesPage.jsx';
import SystemSettingsPage from './pages/SystemSettingsPage.jsx';
import { fetchPreferences } from './lib/api.js';

const DEFAULT_VIEW = 'dashboard';

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
  const [activeView, setActiveView] = useState(DEFAULT_VIEW);
  const [chatPreferences, setChatPreferences] = useState(null);

  const canAccessSettings = useMemo(() => determineCanAccessSettings(user), [user]);

  useEffect(() => {
    if (!user && activeView !== DEFAULT_VIEW) {
      setActiveView(DEFAULT_VIEW);
    }
  }, [user, activeView]);

  useEffect(() => {
    if (!canAccessSettings && activeView === 'settings') {
      setActiveView(DEFAULT_VIEW);
    }
  }, [canAccessSettings, activeView]);

  useEffect(() => {
    let ignore = false;
    if (!user) {
      setChatPreferences(null);
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
        }
      } catch {
        if (!ignore) {
          setChatPreferences(null);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [user]);

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
  }, [logout]);

  useEffect(() => {
    if (user && authVisible) {
      setAuthVisible(false);
    }
  }, [authVisible, user]);

  const isAuthenticated = Boolean(user);

  const handleChatPreferencesChange = useCallback((prefs) => {
    setChatPreferences(prefs);
  }, []);

  if (initializing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-300">
        <span className="text-sm">Checking session…</span>
      </main>
    );
  }

  return (
    <>
      <div className="flex h-screen w-full flex-col bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-100">
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
          {activeView === 'dashboard' ? (
            <DashboardPage
              user={user}
              viewer={viewer}
              viewerReady={viewerReady}
              loadingViewer={loadingViewer}
              onLogout={handleLogout}
              onUnauthorized={handleUnauthorizedPrompt}
              onRequestAuth={openAuth}
              showHeader={false}
              chatPreferences={chatPreferences}
            />
          ) : null}

          {activeView === 'preferences' ? (
            <PreferencesPage
              user={user}
              onReloadSession={reloadSession}
              initialChatPreferences={chatPreferences}
              onChatPreferencesChange={handleChatPreferencesChange}
            />
          ) : null}

          {activeView === 'settings' ? (
            <SystemSettingsPage user={user} />
          ) : null}
        </div>
      </div>

      {authVisible ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="absolute inset-0" onMouseDown={closeAuth} />
          <div className="relative z-10 w-full max-w-md">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={closeAuth}
                className="rounded-full border border-zinc-700 px-3 py-1 text-sm text-zinc-200 transition hover:border-amber-400 hover:text-amber-200"
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
