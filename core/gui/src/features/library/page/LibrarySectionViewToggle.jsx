export default function LibrarySectionViewToggle({ sectionView, onChange, options }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-border/70 bg-background/80 p-1 text-xs">
      {options.map((option) => {
        const active = sectionView === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange?.(option.id)}
            className={`rounded-full px-3 py-1 font-semibold transition ${
              active ? 'bg-accent text-accent-foreground shadow' : 'text-muted hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
