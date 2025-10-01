import { useCallback, useEffect, useState } from 'react';
import AuthPage from './pages/AuthPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import { useAuthSession } from './hooks/useAuthSession.js';
import useViewerPresence from './hooks/useViewerPresence.js';

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
    handleUnauthorized,
  } = useAuthSession();

  const { viewer, loadingViewer, viewerReady } = useViewerPresence(user);
  const [authVisible, setAuthVisible] = useState(false);

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
    setAuthVisible(false);
  }, [logout]);

  useEffect(() => {
    if (user && authVisible) {
      setAuthVisible(false);
    }
  }, [authVisible, user]);

  if (initializing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-300">
        <span className="text-sm">Checking session…</span>
      </main>
    );
  }

  return (
    <>
      <DashboardPage
        user={user}
        viewer={viewer}
        viewerReady={viewerReady}
        loadingViewer={loadingViewer}
        onLogout={handleLogout}
        onUnauthorized={handleUnauthorizedPrompt}
        onRequestAuth={openAuth}
      />
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
