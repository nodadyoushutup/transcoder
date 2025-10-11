import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import LibraryGridImage from '../components/LibraryGridImage.jsx';
import { deriveItemLetter, uniqueKey } from '../utils.js';

export default function LibraryGridView({
  scrollContainerRef,
  overlayActive,
  currentError,
  currentLoading,
  visibleItems,
  emptyStateMessage,
  itemsPerRow,
  shouldShowAlphabetBar,
  registerLetterRef,
  measureCardRef,
  hasImageWindow,
  imageWindow,
  onSelectItem,
  visibleLetters,
  onLetterChange,
  activeLetter,
}) {
  const letterAnchorTracker = new Set();
  const hasItems = visibleItems.length > 0;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      <div
        ref={scrollContainerRef}
        className={`relative flex-1 px-6 py-6 ${overlayActive ? 'overflow-hidden' : 'overflow-y-auto'}`}
      >
        {overlayActive ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <FontAwesomeIcon icon={faCircleNotch} spin size="2x" className="text-muted" />
          </div>
        ) : null}

        {currentError ? (
          <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">{currentError}</div>
        ) : null}

        {!currentLoading && !hasItems ? (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
            <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
            <p>{emptyStateMessage}</p>
          </div>
        ) : null}

        {hasItems ? (
          <div className="library-grid" style={{ '--library-columns': String(itemsPerRow) }}>
            {visibleItems.map((item, index) => {
              const itemKey = uniqueKey(item);
              const itemLetter = deriveItemLetter(item);
              let anchorRef;
              if (shouldShowAlphabetBar && itemLetter && !letterAnchorTracker.has(itemLetter)) {
                letterAnchorTracker.add(itemLetter);
                anchorRef = registerLetterRef(itemLetter);
              }
              let refHandler;
              if (index === 0 && anchorRef) {
                refHandler = (node) => {
                  measureCardRef(node);
                  anchorRef(node);
                };
              } else if (index === 0) {
                refHandler = measureCardRef;
              } else {
                refHandler = anchorRef;
              }
              const shouldLoadImage =
                hasImageWindow && index >= imageWindow.start && index <= imageWindow.end;
              return (
                <button
                  key={itemKey}
                  ref={refHandler}
                  type="button"
                  onClick={() => onSelectItem?.(item)}
                  className="group flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-surface/70 transition hover:border-accent"
                  data-letter={itemLetter ?? undefined}
                >
                  <div className="relative">
                    <LibraryGridImage item={item} shouldLoad={shouldLoadImage} />
                    {item.view_count ? (
                      <div className="absolute right-2 top-2 rounded-full border border-success/60 bg-success/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-success">
                        Viewed
                      </div>
                    ) : null}
                  </div>
                  <div className="px-3 py-3 text-left">
                    <h3
                      className="truncate text-sm font-semibold leading-tight text-foreground group-hover:text-accent"
                      title={item.title ?? 'Untitled'}
                    >
                      {item.title ?? 'Untitled'}
                    </h3>
                    <p className="mt-1 h-4 text-xs text-muted">{item.year ?? ' '}</p>
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {shouldShowAlphabetBar ? (
        <div className="relative hidden lg:flex lg:w-14 lg:flex-col lg:border-l lg:border-border/60 lg:bg-surface/80 lg:px-1 lg:py-4">
          <div className="sticky top-24 flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => onLetterChange?.('0-9')}
              disabled={overlayActive}
              className={`w-8 rounded-full px-2 py-1 text-xs font-semibold transition disabled:pointer-events-none disabled:opacity-60 ${
                activeLetter === '0-9' || activeLetter === null
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              ★
            </button>
            {visibleLetters.map((letter) => (
              <button
                key={letter}
                type="button"
                onClick={() => onLetterChange?.(letter)}
                disabled={overlayActive}
                className={`w-8 rounded-full px-2 py-1 text-xs font-semibold transition disabled:pointer-events-none disabled:opacity-60 ${
                  activeLetter === letter ? 'bg-accent text-accent-foreground' : 'text-muted hover:text-foreground'
                }`}
              >
                {letter}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
