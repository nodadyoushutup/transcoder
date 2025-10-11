import { typeLabel, uniqueKey } from '../utils.js';
import LibraryGridImage from './LibraryGridImage.jsx';

export default function RelatedGroup({ hub, onSelect }) {
  if (!hub) {
    return null;
  }
  const items = hub.items ?? [];
  if (!items.length) {
    return null;
  }
  const title = hub.title ?? 'Related';
  const moreLabel = hub.more ? 'More available' : null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        {moreLabel ? <span className="text-xs uppercase tracking-wide text-subtle">{moreLabel}</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => {
          const itemKey = uniqueKey(item);
          const metaBits = [item.year, typeLabel(item.type)].filter(Boolean);
          return (
            <button
              key={itemKey}
              type="button"
              onClick={() => onSelect?.(item)}
              className="group flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-surface/70 transition hover:border-accent"
            >
              <div className="relative">
                <LibraryGridImage item={item} shouldLoad />
                {item.view_count ? (
                  <div className="absolute right-2 top-2 rounded-full border border-success/60 bg-success/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-success">
                    Viewed
                  </div>
                ) : null}
              </div>
              <div className="px-3 py-3 text-left">
                <h4
                  className="truncate text-sm font-semibold leading-tight text-foreground group-hover:text-accent"
                  title={item.title ?? 'Untitled'}
                >
                  {item.title ?? 'Untitled'}
                </h4>
                <p className="mt-1 h-4 text-xs text-muted">{metaBits.length ? metaBits.join(' • ') : ' '}</p>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
