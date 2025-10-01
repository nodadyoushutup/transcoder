import AuthPage from './pages/AuthPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import { useAuthSession } from './hooks/useAuthSession.js';

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

  if (initializing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 text-zinc-300">
        <span className="text-sm">Checking session…</span>
      </main>
    );
  }

  if (!user) {
    return (
      <AuthPage
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
    );
  }

  return <DashboardPage user={user} onLogout={logout} onUnauthorized={handleUnauthorized} />;
}

export default App;
