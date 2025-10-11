import { formatRuntime, resolveImageUrl, typeLabel, uniqueKey } from '../utils.js';

export default function ChildList({ label, items, onSelect, onPlay, playPending }) {
  if (!items?.length) {
    return null;
  }
  return (
    <section className="mt-10 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{label}</h3>
        <span className="text-xs uppercase tracking-wide text-subtle">{items.length} total</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((child) => {
          const cardKey = uniqueKey(child);
          const artwork = resolveImageUrl(child.thumb, { width: 240, height: 360, min: 1, upscale: 1 });
          const year = child.year ? String(child.year) : null;
          const runtime = formatRuntime(child.duration);
          return (
            <div
              key={cardKey}
              className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border/40 bg-background/70 shadow-sm"
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect?.(child)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect?.(child);
                  }
                }}
                className="flex flex-1 gap-3 px-3 py-3 outline-none transition focus-visible:ring-2 focus-visible:ring-accent"
              >
                <div className="flex h-24 w-16 items-center justify-center overflow-hidden rounded-xl bg-border/40 text-xs font-semibold uppercase tracking-wide text-muted">
                  {artwork ? (
                    <img src={artwork} alt={child.title ?? 'Artwork'} className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    (child.title ?? '?').charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground transition group-hover:text-accent">
                    {child.title ?? 'Untitled'}
                  </p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-subtle">
                    {typeLabel(child.type)}
                    {year ? ` • ${year}` : ''}
                  </p>
                  {runtime ? <p className="mt-1 text-xs text-muted">{runtime}</p> : null}
                </div>
              </div>
              {child.playable ? (
                <div className="flex items-center justify-end border-t border-border/40 bg-background/80 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onPlay?.(child)}
                    disabled={playPending}
                    className="rounded-full border border-accent/60 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition hover:border-accent hover:bg-accent/20 disabled:opacity-60"
                  >
                    {playPending ? 'Starting…' : 'Play'}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
