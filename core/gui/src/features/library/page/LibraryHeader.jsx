import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDown,
  faArrowRotateLeft,
  faArrowUp,
  faArrowsRotate,
  faBackward,
  faCircleNotch,
  faClosedCaptioning,
  faForward,
  faMagnifyingGlass,
  faPlay,
  faTableColumns,
} from '@fortawesome/free-solid-svg-icons';
import { WATCH_FILTERS, SECTION_VIEW_OPTIONS, VIEW_DETAILS } from '../constants.js';
import LibrarySectionViewToggle from './LibrarySectionViewToggle.jsx';

export default function LibraryHeader({
  showSectionViewToggle,
  sectionView,
  onSectionViewChange,
  countLabel,
  countPillTitle,
  headerLoading,
  isHomeView,
  isGlobalSearching,
  activeSearchQuery,
  serverLabel,
  viewMode,
  selectedItem,
  onPlay,
  playPending,
  playPhase,
  onRefreshDetails,
  detailRefreshPending,
  onExtractSubtitles,
  subtitleExtractPending,
  hasSubtitleTracks,
  subtitleExtractNotice,
  detailRefreshError,
  queueNotice,
  queuePending,
  onQueueAction,
  isLibraryViewActive,
  onRefreshSection,
  sectionRefreshPending,
  sectionRefreshError,
  itemsLoading,
  searchInput,
  onSearchInputChange,
  sortOptions,
  sortValue,
  onSortChange,
  watchValue,
  onWatchChange,
  itemsPerRow,
  onItemsPerRowChange,
  onClearFilters,
}) {
  const handleSearchChange = (event) => {
    onSearchInputChange?.(event.target.value);
  };

  const handleSortChange = (event) => {
    onSortChange?.(event.target.value);
  };

  const handleWatchChange = (event) => {
    onWatchChange?.(event.target.value);
  };

  const handleItemsPerRowChange = (event) => {
    onItemsPerRowChange?.(Number(event.target.value));
  };

  const canPlay = Boolean(selectedItem?.playable) && !playPending;
  const canQueue = Boolean(selectedItem?.playable) && !queuePending;
  const showDetailActions = !isHomeView && viewMode === VIEW_DETAILS;

  return (
    <header className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-surface/70 px-6 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {showSectionViewToggle ? (
          <LibrarySectionViewToggle
            sectionView={sectionView}
            onChange={onSectionViewChange}
            options={SECTION_VIEW_OPTIONS}
          />
        ) : null}
        <span className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-foreground" title={countPillTitle}>
          {countLabel}
        </span>
        {headerLoading ? <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" /> : null}
        {!isHomeView && isGlobalSearching && activeSearchQuery ? (
          <span className="truncate text-xs text-muted">for “{activeSearchQuery}”</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isHomeView ? (
          serverLabel ? (
            <span className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs text-muted">{serverLabel}</span>
          ) : null
        ) : showDetailActions ? (
          <>
            <button
              type="button"
              onClick={() => onPlay?.(selectedItem)}
              disabled={!canPlay}
              className="flex items-center gap-2 rounded-full border border-transparent bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90 disabled:opacity-60"
            >
              <FontAwesomeIcon icon={faPlay} />
              {playPending ? (playPhase === 'extracting' ? 'Extracting subtitles…' : 'Starting…') : 'Start'}
            </button>
            <button
              type="button"
              onClick={onRefreshDetails}
              disabled={detailRefreshPending}
              className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-4 py-2 text-sm font-semibold text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FontAwesomeIcon
                icon={detailRefreshPending ? faCircleNotch : faArrowsRotate}
                spin={detailRefreshPending}
                className="text-xs"
              />
              {detailRefreshPending ? 'Refreshing…' : 'Refresh Metadata'}
            </button>
            <button
              type="button"
              onClick={onExtractSubtitles}
              disabled={subtitleExtractPending || !hasSubtitleTracks || !selectedItem?.rating_key}
              className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-4 py-2 text-sm font-semibold text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              title={!hasSubtitleTracks ? 'No subtitle tracks detected for this item' : undefined}
            >
              <FontAwesomeIcon
                icon={subtitleExtractPending ? faCircleNotch : faClosedCaptioning}
                spin={subtitleExtractPending}
                className="text-xs"
              />
              {subtitleExtractPending ? 'Extracting…' : 'Extract Subtitles'}
            </button>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-2 py-1 text-xs text-muted">
                <button
                  type="button"
                  onClick={() => onQueueAction?.(selectedItem, 'next')}
                  disabled={!canQueue}
                  className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40 disabled:opacity-50"
                >
                  <FontAwesomeIcon icon={faArrowUp} className="text-xs" />
                  Queue Next
                </button>
                <button
                  type="button"
                  onClick={() => onQueueAction?.(selectedItem, 'last')}
                  disabled={!canQueue}
                  className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40 disabled:opacity-50"
                >
                  <FontAwesomeIcon icon={faArrowDown} className="text-xs" />
                  Queue Last
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40"
                >
                  <FontAwesomeIcon icon={faForward} className="text-xs" />
                  Vote Next
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40"
                >
                  <FontAwesomeIcon icon={faBackward} className="text-xs" />
                  Vote Last
                </button>
              </div>
              {queueNotice?.message ? (
                <span className={`px-2 text-[11px] ${queueNotice.type === 'error' ? 'text-danger' : 'text-muted'}`}>
                  {queueNotice.message}
                </span>
              ) : null}
            </div>
            {subtitleExtractNotice?.message ? (
              <span className={`text-xs ${subtitleExtractNotice.tone === 'error' ? 'text-rose-300' : 'text-muted'}`}>
                {subtitleExtractNotice.message}
              </span>
            ) : null}
            {detailRefreshError ? <span className="text-xs text-rose-300">{detailRefreshError}</span> : null}
          </>
        ) : isLibraryViewActive ? (
          <>
            <button
              type="button"
              onClick={onRefreshSection}
              disabled={sectionRefreshPending || itemsLoading}
              className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-sm font-semibold text-muted transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FontAwesomeIcon
                icon={sectionRefreshPending ? faCircleNotch : faArrowsRotate}
                spin={sectionRefreshPending}
                className="text-xs"
              />
              {sectionRefreshPending ? 'Refreshing…' : 'Refresh'}
            </button>
            {sectionRefreshError ? <span className="text-xs text-rose-300">{sectionRefreshError}</span> : null}
            <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted focus-within:border-accent">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs text-subtle" />
              <input
                type="search"
                value={searchInput}
                onChange={handleSearchChange}
                placeholder="Filter titles…"
                className="w-40 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
              />
            </div>
            <select
              value={sortValue}
              onChange={handleSortChange}
              className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
            >
              {sortOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={watchValue}
              onChange={handleWatchChange}
              className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
            >
              {WATCH_FILTERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted">
              <FontAwesomeIcon icon={faTableColumns} className="text-xs" aria-hidden="true" />
              <input
                type="range"
                min="4"
                max="12"
                step="1"
                value={itemsPerRow}
                onChange={handleItemsPerRowChange}
                className="h-1.5 w-28 appearance-none accent-accent"
                aria-label="Columns per row"
                title={`Columns per row: ${itemsPerRow}`}
              />
            </div>
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent hover:text-accent"
            >
              <FontAwesomeIcon icon={faArrowRotateLeft} className="mr-2 text-xs" />
              Reset
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}
