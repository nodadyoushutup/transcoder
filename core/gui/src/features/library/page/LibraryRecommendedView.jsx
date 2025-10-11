import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import HomeRow from '../components/HomeRow.jsx';

export default function LibraryRecommendedView({
  rows,
  loading,
  error,
  onSelectItem,
  onNavigateRow,
}) {
  const hasRows = rows.some((row) => Array.isArray(row.items) && row.items.length > 0);

  return (
    <div className="flex flex-1 overflow-y-auto px-6 py-6">
      <div className="flex w-full flex-col gap-6">
        {error ? (
          <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
        ) : null}

        {loading && !hasRows ? (
          <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
            <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
          </div>
        ) : null}

        {!loading && !hasRows ? (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
            <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
            <p>No recommendations yet.</p>
          </div>
        ) : null}

        {rows.map((row) => {
          const hasItems = Array.isArray(row.items) && row.items.length > 0;
          if (!hasItems) {
            return null;
          }
          return (
            <section key={row.id} className="space-y-4 rounded-2xl border border-border/40 bg-surface/70 p-5 shadow-sm">
              <HomeRow
                title={row.title}
                items={row.items}
                onSelect={onSelectItem}
                metaFormatter={row.meta}
                actions={
                  <button
                    type="button"
                    onClick={() => onNavigateRow?.(row)}
                    className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-semibold text-muted transition hover:border-accent hover:text-accent"
                  >
                    View Library
                  </button>
                }
              />
            </section>
          );
        })}

        {loading && hasRows ? (
          <div className="flex items-center justify-center gap-2 text-xs text-muted">
            <FontAwesomeIcon icon={faCircleNotch} spin />
            Updating…
          </div>
        ) : null}
      </div>
    </div>
  );
}
