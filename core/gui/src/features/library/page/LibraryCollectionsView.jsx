import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import LibraryGridImage from '../components/LibraryGridImage.jsx';
import { formatCount, uniqueKey } from '../utils.js';

export default function LibraryCollectionsView({ items, loading, error, onSelectItem }) {
  const hasItems = Array.isArray(items) && items.length > 0;

  return (
    <div className="flex flex-1 overflow-y-auto px-6 py-6">
      <div className="flex w-full flex-col gap-6">
        {error ? (
          <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
        ) : null}

        {loading && !hasItems ? (
          <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
            <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
          </div>
        ) : null}

        {!loading && !hasItems ? (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
            <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
            <p>No collections available.</p>
          </div>
        ) : null}

        {hasItems ? (
          <div className="library-grid" style={{ '--library-columns': '6' }}>
            {items.map((collection, index) => {
              const itemKey = uniqueKey(collection) ?? `collection-${index}`;
              const rawCount = collection.child_count ?? collection.leaf_count ?? collection.size;
              const numericCount = Number(rawCount);
              const hasCount = Number.isFinite(numericCount) && numericCount >= 0;
              const countLabel = hasCount
                ? numericCount === 1
                  ? '1 item'
                  : `${formatCount(numericCount)} items`
                : null;
              return (
                <button
                  key={itemKey}
                  type="button"
                  onClick={() => onSelectItem?.(collection)}
                  className="group flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-surface/70 transition hover:border-accent"
                >
                  <div className="relative">
                    <LibraryGridImage item={collection} shouldLoad />
                    {countLabel ? (
                      <div className="absolute right-2 top-2 rounded-full border border-border/60 bg-background/80 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted group-hover:text-accent">
                        {countLabel}
                      </div>
                    ) : null}
                  </div>
                  <div className="px-3 py-3 text-left">
                    <h3
                      className="truncate text-sm font-semibold leading-tight text-foreground group-hover:text-accent"
                      title={collection.title ?? 'Unnamed collection'}
                    >
                      {collection.title ?? 'Unnamed collection'}
                    </h3>
                    <p className="mt-1 h-4 text-xs text-muted">{collection.summary ?? ' '}</p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}

        {loading && hasItems ? (
          <div className="flex items-center justify-center gap-2 text-xs text-muted">
            <FontAwesomeIcon icon={faCircleNotch} spin />
            Updating…
          </div>
        ) : null}
      </div>
    </div>
  );
}
