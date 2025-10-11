import { useCallback, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { uniqueKey } from '../utils.js';
import LibraryGridImage from './LibraryGridImage.jsx';

export default function HomeRow({ title, items, onSelect, metaFormatter, actions = null }) {
  const scrollContainerRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollControls = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = container;
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    setCanScrollLeft(scrollLeft > 2);
    setCanScrollRight(maxScrollLeft - scrollLeft > 2);
  }, []);

  useEffect(() => {
    const handleResize = () => updateScrollControls();
    updateScrollControls();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [updateScrollControls]);

  useEffect(() => {
    updateScrollControls();
  }, [items, updateScrollControls]);

  const scrollByDirection = useCallback((direction) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const scrollAmount = container.clientWidth * 0.8 || 240;
    container.scrollBy({ left: direction * scrollAmount, behavior: 'smooth' });
  }, []);

  if (!items?.length) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold tracking-tight text-foreground">{title}</h4>
          <span className="text-xs uppercase tracking-wide text-subtle">{items.length}</span>
        </div>
        {actions}
      </div>
      <div className="relative">
        {canScrollLeft ? (
          <button
            type="button"
            aria-label={`Scroll ${title} row left`}
            className="absolute left-0 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/90 p-2 text-sm text-foreground shadow-lg shadow-overlay/40 transition hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => scrollByDirection(-1)}
          >
            <FontAwesomeIcon icon={faChevronLeft} />
          </button>
        ) : null}
        <div
          ref={scrollContainerRef}
          className="scrollbar-hidden flex gap-5 overflow-x-auto pb-2 scroll-smooth"
          onScroll={updateScrollControls}
        >
          {items.map((item) => {
            const key = uniqueKey(item);
            const meta = metaFormatter ? metaFormatter(item) : null;
            const metaText = meta ?? ' ';
            return (
              <button
                type="button"
                key={key}
                onClick={() => onSelect(item)}
                className="group flex w-[180px] min-w-[180px] flex-shrink-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface/70 text-left transition hover:border-accent"
              >
                <div className="relative">
                  <LibraryGridImage item={item} shouldLoad />
                  {item.view_count ? (
                    <div className="absolute right-2 top-2 rounded-full border border-success/60 bg-success/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-success">
                      Viewed
                    </div>
                  ) : null}
                </div>
                <div className="px-3 py-3">
                  <p
                    className="truncate text-sm font-semibold leading-tight text-foreground group-hover:text-accent"
                    title={item.title ?? 'Untitled'}
                  >
                    {item.title ?? 'Untitled'}
                  </p>
                  <p className="mt-1 h-4 text-xs text-muted">{metaText}</p>
                </div>
              </button>
            );
          })}
        </div>
        {canScrollRight ? (
          <button
            type="button"
            aria-label={`Scroll ${title} row right`}
            className="absolute right-0 top-1/2 z-10 translate-x-1/2 -translate-y-1/2 rounded-full bg-background/90 p-2 text-sm text-foreground shadow-lg shadow-overlay/40 transition hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => scrollByDirection(1)}
          >
            <FontAwesomeIcon icon={faChevronRight} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
