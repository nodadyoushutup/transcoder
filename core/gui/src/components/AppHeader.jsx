import { useMemo } from 'react';
import PrimaryNav from './navigation/PrimaryNav.jsx';
import UserMenu from './navigation/UserMenu.jsx';

export default function AppHeader({
  brand = 'Publex',
  isAuthenticated,
  user,
  onSignIn,
  onRegister,
  onLogout,
  onNavigate,
  activeView,
  canAccessSettings,
}) {
  const primaryLinks = useMemo(() => (
    [
      { id: 'stream', label: 'Stream' },
      { id: 'library', label: 'Library' },
    ]
  ), []);

  return (
    <header className="app-header">
      <div className="flex items-center gap-4">
        <span className="text-lg font-semibold text-foreground">{brand}</span>
      </div>

      <div className="flex items-center gap-3 md:gap-5">
        <PrimaryNav links={primaryLinks} activeId={activeView} onNavigate={onNavigate} />

        {isAuthenticated ? (
          <UserMenu
            user={user}
            activeView={activeView}
            onNavigate={onNavigate}
            onLogout={onLogout}
            canAccessSettings={canAccessSettings}
          />
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSignIn?.('login')}
              className="btn-pill btn-pill-primary"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => onRegister?.('register')}
              className="btn-pill"
            >
              Register
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
