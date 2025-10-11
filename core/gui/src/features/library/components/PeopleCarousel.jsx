import { useCallback, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { resolveImageUrl } from '../utils.js';

function PersonCard({ person, fallbackRole }) {
  const [imageFailed, setImageFailed] = useState(false);
  const name = person.title ?? person.tag;

  if (!name) {
    return null;
  }

  const thumbUrl = imageFailed ? null : resolveImageUrl(person.thumb, { width: 160, height: 160, min: 1 });
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment[0])
    .join('')
    .toUpperCase();
  const role = person.role ?? fallbackRole ?? '';

  return (
    <div className="flex w-28 shrink-0 flex-col items-center text-center">
      <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-border/40 bg-border/30 text-sm font-semibold uppercase tracking-wide text-muted">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={name}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          initials || name.charAt(0).toUpperCase()
        )}
      </div>
      <p className="mt-2 line-clamp-2 text-xs font-semibold text-foreground">{name}</p>
      {role ? <p className="mt-1 line-clamp-2 text-[11px] text-subtle">{role}</p> : null}
    </div>
  );
}

export default function PeopleCarousel({ title, people, fallbackRole }) {
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
  }, [people, updateScrollControls]);

  const scrollByDirection = useCallback((direction) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const scrollAmount = container.clientWidth * 0.8 || 200;
    container.scrollBy({ left: direction * scrollAmount, behavior: 'smooth' });
  }, []);

  if (!people?.length) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        <span className="text-xs uppercase tracking-wide text-subtle">{people.length}</span>
      </div>
      <div className="relative">
        {canScrollLeft ? (
          <button
            type="button"
            aria-label="Scroll left"
            className="absolute left-2 top-[2.5rem] z-10 -translate-y-1/2 rounded-full bg-background/90 p-2 text-sm text-foreground shadow-lg shadow-overlay/40 transition hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => scrollByDirection(-1)}
          >
            <FontAwesomeIcon icon={faChevronLeft} />
          </button>
        ) : null}
        <div
          ref={scrollContainerRef}
          className="scrollbar-hidden flex gap-4 overflow-x-auto pb-3 pl-6 pr-6 scroll-smooth"
          onScroll={updateScrollControls}
        >
          {people.map((person, index) => {
            const key = person.id ?? person.tag ?? person.title ?? index;
            return <PersonCard key={key} person={person} fallbackRole={fallbackRole} />;
          })}
        </div>
        {canScrollRight ? (
          <button
            type="button"
            aria-label="Scroll right"
            className="absolute right-2 top-[2.5rem] z-10 -translate-y-1/2 rounded-full bg-background/90 p-2 text-sm text-foreground shadow-lg shadow-overlay/40 transition hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => scrollByDirection(1)}
          >
            <FontAwesomeIcon icon={faChevronRight} />
          </button>
        ) : null}
      </div>
    </section>
  );
}
