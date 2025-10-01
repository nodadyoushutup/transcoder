import { useEffect, useRef, useState } from 'react';
import UserAvatar from '../UserAvatar.jsx';

function combineClasses(...values) {
  return values.filter(Boolean).join(' ');
}

export default function UserMenu({ user, activeView, onNavigate, onLogout, canAccessSettings }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handleClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const menuItems = [
    { id: 'preferences', label: 'Preferences' },
  ];
  if (canAccessSettings) {
    menuItems.push({ id: 'settings', label: 'System Settings' });
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="nav-trigger"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <UserAvatar user={user} size="md" />
        <span className="hidden text-sm font-medium text-foreground md:inline">{user?.username}</span>
      </button>

      {open ? (
        <div className="dropdown-panel">
          <nav className="flex flex-col divide-y divide-border/80">
            {menuItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigate?.(item.id);
                }}
                className={combineClasses(
                  'dropdown-item',
                  activeView === item.id ? 'dropdown-item-active' : null,
                )}
              >
                {item.label}
                {activeView === item.id ? <span className="ml-auto text-xs text-accent">•</span> : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onLogout?.();
              }}
              className="dropdown-item text-muted hover:text-accent"
            >
              Sign out
            </button>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
