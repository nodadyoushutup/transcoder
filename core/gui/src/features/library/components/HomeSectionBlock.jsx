import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import HomeRow from './HomeRow.jsx';
import { formatDate, typeIcon, typeLabel } from '../utils.js';

export default function HomeSectionBlock({ section, onSelectItem, onBrowseSection }) {
  const { id, title, type, recentlyReleased, recentlyAdded } = section;
  const hasRecentContent = (recentlyReleased?.length ?? 0) > 0 || (recentlyAdded?.length ?? 0) > 0;
  const canBrowse = id !== null && id !== undefined;

  return (
    <section className="space-y-6 rounded-2xl border border-border/40 bg-surface/70 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-background/80 text-accent shadow-inner">
            <FontAwesomeIcon icon={typeIcon(type)} />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="text-xs uppercase tracking-wide text-muted">{typeLabel(type)}</p>
          </div>
        </div>
        {canBrowse ? (
          <button
            type="button"
            onClick={() => onBrowseSection(id)}
            className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-semibold text-muted transition hover:border-accent hover:text-accent"
          >
            Browse All
          </button>
        ) : null}
      </div>

      {hasRecentContent ? (
        <div className="space-y-8">
          <HomeRow
            title="Recently Released"
            items={recentlyReleased}
            onSelect={onSelectItem}
            metaFormatter={(item) => formatDate(item.originally_available_at)}
          />
          <HomeRow
            title="Recently Added"
            items={recentlyAdded}
            onSelect={onSelectItem}
            metaFormatter={(item) => formatDate(item.added_at)}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-border/40 bg-background/70 px-4 py-6 text-sm text-muted">
          No recent activity.
        </div>
      )}
    </section>
  );
}
