import { useEffect, useMemo, useRef, useState } from 'react';
import { BACKEND_BASE } from '../lib/env.js';

function getAvatarUrl(user) {
  if (!user?.avatar_url) {
    return null;
  }
  if (user.avatar_url.startsWith('http')) {
    return user.avatar_url;
  }
  return `${BACKEND_BASE}${user.avatar_url}`;
}

function UserAvatar({ user }) {
  const avatarUrl = getAvatarUrl(user);
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={user?.username || 'Avatar'}
        className="h-9 w-9 rounded-full border border-border object-cover"
      />
    );
  }
  const fallback = (user?.username || 'User').charAt(0).toUpperCase();
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-sm font-semibold text-accent">
      {fallback}
    </span>
  );
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const handleClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
    };
  }, [menuOpen]);

  const menuItems = useMemo(() => {
    if (!isAuthenticated) {
      return [];
    }
    const items = [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'preferences', label: 'Preferences' },
    ];
    if (canAccessSettings) {
      items.push({ id: 'settings', label: 'System Settings' });
    }
    return items;
  }, [isAuthenticated, canAccessSettings]);

  return (
    <header className="flex items-center justify-between border-b border-border/80 bg-surface/90 px-5 py-3 md:px-8">
      <div className="flex items-center gap-4">
        <span className="text-lg font-semibold text-foreground">{brand}</span>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted">
        {isAuthenticated ? (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((current) => !current)}
              className="flex items-center gap-2 rounded-full border border-border/80 bg-surface px-2.5 py-1 pl-1.5 pr-3 text-left text-sm font-medium text-foreground transition hover:border-accent hover:text-accent"
            >
              <UserAvatar user={user} />
              <span className="hidden text-sm font-medium text-foreground md:inline">
                {user?.username}
              </span>
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-48 overflow-hidden rounded-2xl border border-border bg-background/95 shadow-2xl">
                <nav className="flex flex-col divide-y divide-border/80">
                  {menuItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onNavigate?.(item.id);
                      }}
                      className={`flex items-center justify-between px-4 py-2 text-sm transition hover:bg-surface-muted/60 ${
                        activeView === item.id ? 'text-accent' : 'text-foreground'
                      }`}
                    >
                      {item.label}
                      {activeView === item.id ? <span className="text-xs text-accent">•</span> : null}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout?.();
                    }}
                    className="px-4 py-2 text-left text-sm text-muted transition hover:bg-surface-muted/60 hover:text-accent"
                  >
                    Sign out
                  </button>
                </nav>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSignIn?.('login')}
              className="rounded-full border border-accent/40 px-4 py-1.5 text-sm font-medium text-accent transition hover:border-accent hover:text-accent"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => onRegister?.('register')}
              className="rounded-full border border-border px-4 py-1.5 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent"
            >
              Register
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
