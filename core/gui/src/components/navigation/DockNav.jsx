function renderIcon(icon, isActive) {
  if (typeof icon === 'function') {
    return icon({ active: isActive });
  }
  return icon ?? null;
}

export default function DockNav({
  items = [],
  activeId,
  onChange,
  position = 'right',
  allowCollapse = true,
  className = '',
}) {
  if (!items.length) {
    return null;
  }

  const isRight = position === 'right';
  const containerClasses = [
    'dock-nav',
    isRight ? 'border-l' : 'border-r',
    'border-border',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <nav className={containerClasses} aria-orientation="vertical">
      {items.map((item) => {
        const isActive = activeId === item.id;
        const nextId = allowCollapse && isActive ? null : item.id;
        const showIndicator = item.showActiveBar !== false;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange?.(nextId, { previous: activeId })}
            className={`dock-trigger ${isActive ? 'dock-trigger-active' : ''}`}
            aria-pressed={isActive}
            aria-label={item.label}
          >
            {renderIcon(item.icon, isActive)}
            {isActive && showIndicator ? (
              <span className="dock-trigger-indicator" aria-hidden="true" />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
