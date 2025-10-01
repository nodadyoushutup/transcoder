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
        className="h-9 w-9 rounded-full border border-zinc-800 object-cover"
      />
    );
  }
  const fallback = (user?.username || 'User').charAt(0).toUpperCase();
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-sm font-semibold text-amber-200">
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
    <header className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/90 px-6 py-4 md:px-10">
      <div className="flex items-center gap-4">
        <span className="text-lg font-semibold text-white">{brand}</span>
      </div>

      <div className="flex items-center gap-3 text-sm text-zinc-300">
        {isAuthenticated ? (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((current) => !current)}
              className="flex items-center gap-2 rounded-full border border-zinc-700/80 bg-zinc-900 px-2 py-1.5 pl-1 pr-3 text-left text-sm font-medium text-zinc-100 transition hover:border-amber-400 hover:text-amber-100"
            >
              <UserAvatar user={user} />
              <span className="hidden flex-col text-xs leading-tight md:flex">
                <span className="text-amber-300">{user?.username}</span>
                <span className="text-zinc-500">Account</span>
              </span>
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-48 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl">
                <nav className="flex flex-col divide-y divide-zinc-800">
                  {menuItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        onNavigate?.(item.id);
                      }}
                      className={`flex items-center justify-between px-4 py-2 text-sm transition hover:bg-zinc-800/60 ${
                        activeView === item.id ? 'text-amber-300' : 'text-zinc-200'
                      }`}
                    >
                      {item.label}
                      {activeView === item.id ? <span className="text-xs text-amber-400">•</span> : null}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout?.();
                    }}
                    className="px-4 py-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800/60 hover:text-amber-200"
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
              className="rounded-full border border-amber-500/40 px-4 py-1.5 text-sm font-medium text-amber-200 transition hover:border-amber-400 hover:text-amber-100"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => onRegister?.('register')}
              className="rounded-full border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 transition hover:border-amber-500 hover:text-amber-300"
            >
              Register
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
