function combineClasses(...values) {
  return values.filter(Boolean).join(' ');
}

export default function PrimaryNav({ links = [], activeId, onNavigate }) {
  if (!links.length) {
    return null;
  }

  return (
    <nav className="flex items-center gap-1 text-sm">
      {links.map((link) => {
        const isActive = activeId === link.id;
        return (
          <button
            key={link.id}
            type="button"
            onClick={() => {
              if (link.disabled) {
                return;
              }
              onNavigate?.(link.id);
            }}
            className={combineClasses(
              'nav-link',
              isActive ? 'nav-link-active' : null,
              link.disabled ? 'pointer-events-none opacity-60' : null,
            )}
            aria-pressed={isActive}
          >
            {link.label}
          </button>
        );
      })}
    </nav>
  );
}
