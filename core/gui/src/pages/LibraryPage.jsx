import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLayerGroup,
  faHouse,
  faPlay,
  faCircleNotch,
  faCircleInfo,
  faChevronLeft,
  faChevronRight,
  faMagnifyingGlass,
  faArrowRotateLeft,
  faFilm,
  faTv,
  faMusic,
  faImage,
  faForward,
  faBackward,
  faArrowUp,
  faArrowDown,
} from '@fortawesome/free-solid-svg-icons';
import placeholderPoster from '../img/placeholder.png';
import imdbLogo from '../img/imdb.svg';
import tmdbLogo from '../img/tmdb.svg';
import rtFreshCritic from '../img/rt_fresh_critic.svg';
import rtPositiveCritic from '../img/rt_positive_critic.svg';
import rtNegativeCritic from '../img/rt_negative_critic.svg';
import rtPositiveAudience from '../img/rt_positive_audience.svg';
import rtNegativeAudience from '../img/rt_negative_audience.svg';
import DockNav from '../components/navigation/DockNav.jsx';
import {
  fetchPlexSections,
  fetchPlexSectionItems,
  fetchPlexItemDetails,
  fetchPlexSearch,
  playPlexItem,
  enqueueQueueItem,
  plexImageUrl,
} from '../lib/api.js';

const WATCH_FILTERS = [
  { id: 'all', label: 'All items' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'watched', label: 'Watched' },
];

const DEFAULT_SORT = 'title_asc';
const DEFAULT_SECTION_PAGE_LIMIT = 500;
const SECTION_PAGE_LIMIT_MIN = 1;
const SECTION_PAGE_LIMIT_MAX = 1000;
const SEARCH_PAGE_LIMIT = 60;
const HOME_ROW_LIMIT = 12;
const IMAGE_PREFETCH_RADIUS = 60;
const DEFAULT_CARD_HEIGHT = 320;
const DEFAULT_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0-9'];
const VIEW_GRID = 'grid';
const VIEW_DETAILS = 'details';
const SECTIONS_ONLY_MODE = false;

function formatRuntime(duration) {
  if (!duration || Number.isNaN(Number(duration))) {
    return null;
  }
  const totalSeconds = Math.floor(Number(duration) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  const seconds = totalSeconds % 60;
  return `${seconds}s`;
}

function formatDate(value) {
  if (!value) {
    return null;
  }
  try {
    const date = new Date(value);
    return date.toLocaleDateString();
  } catch (error) {
    return null;
  }
}

function clampSectionPageLimit(value, fallback = DEFAULT_SECTION_PAGE_LIMIT) {
  const base = Number.isFinite(fallback) ? Number(fallback) : DEFAULT_SECTION_PAGE_LIMIT;
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return Math.min(SECTION_PAGE_LIMIT_MAX, Math.max(SECTION_PAGE_LIMIT_MIN, base));
  }
  return Math.min(SECTION_PAGE_LIMIT_MAX, Math.max(SECTION_PAGE_LIMIT_MIN, numeric));
}

function formatBitrate(value) {
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  if (numeric >= 1000 * 1000) {
    return `${Math.round(numeric / 1000 / 1000).toLocaleString()} Mbps`;
  }
  if (numeric >= 1000) {
    return `${Math.round(numeric / 1000).toLocaleString()} kbps`;
  }
  return `${numeric.toLocaleString()} bps`;
}

function formatFileSize(bytes) {
  const numeric = Number(bytes);
  if (!numeric || Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = numeric;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = unitIndex === 0 ? value.toLocaleString() : value.toFixed(value >= 10 ? 0 : 1);
  return `${formatted} ${units[unitIndex]}`;
}

function formatFrameRate(value) {
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric % 1 === 0 ? numeric : numeric.toFixed(2)} fps`;
}

function formatChannelLayout(value) {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    switch (numeric) {
      case 1:
        return 'Mono';
      case 2:
        return 'Stereo';
      case 6:
        return '5.1 Surround';
      case 7:
        return '6.1 Surround';
      case 8:
        return '7.1 Surround';
      default:
        return `${numeric}-channel`;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return null;
}

function formatCount(value) {
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric) || numeric < 0) {
    return null;
  }
  return numeric.toLocaleString();
}

function formatRatingValue(value, decimals = 1) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return String(value);
  }
  if (!decimals || decimals <= 0) {
    return numeric.toString();
  }
  return numeric.toFixed(decimals);
}

function resolveImageUrl(path, params) {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path) || path.startsWith('data:')) {
    return path;
  }
  return plexImageUrl(path, params);
}

function imageByType(images, type) {
  if (!images?.length || !type) {
    return null;
  }
  const target = type.toLowerCase();
  return images.find((image) => (image?.type ?? '').toLowerCase() === target) ?? null;
}

const PROVIDER_LABELS = {
  rottentomatoes: 'Rotten Tomatoes',
  imdb: 'IMDb',
  tmdb: 'TMDb',
};

const ROTTEN_TOMATOES_ICONS = {
  critic: {
    positive: rtPositiveCritic,
    neutral: rtFreshCritic,
    negative: rtNegativeCritic,
  },
  audience: {
    positive: rtPositiveAudience,
    negative: rtNegativeAudience,
  },
};

function resolveRottenTomatoesIcon(image, variant = 'critic') {
  const normalized = (image ?? '').toLowerCase();
  if (variant === 'audience') {
    if (normalized.includes('spilled')) {
      return {
        src: ROTTEN_TOMATOES_ICONS.audience.negative,
        alt: 'Rotten Tomatoes Audience (Spilled)',
      };
    }
    if (normalized.includes('upright')) {
      return {
        src: ROTTEN_TOMATOES_ICONS.audience.positive,
        alt: 'Rotten Tomatoes Audience (Upright)',
      };
    }
    return {
      src: ROTTEN_TOMATOES_ICONS.audience.positive,
      alt: 'Rotten Tomatoes Audience',
    };
  }

  if (normalized.includes('rotten')) {
    return {
      src: ROTTEN_TOMATOES_ICONS.critic.negative,
      alt: 'Rotten Tomatoes Critics (Rotten)',
    };
  }
  if (normalized.includes('ripe')) {
    return {
      src: ROTTEN_TOMATOES_ICONS.critic.positive,
      alt: 'Rotten Tomatoes Critics (Certified Fresh)',
    };
  }
  if (normalized.includes('fresh')) {
    return {
      src: ROTTEN_TOMATOES_ICONS.critic.neutral,
      alt: 'Rotten Tomatoes Critics (Fresh)',
    };
  }
  return {
    src: ROTTEN_TOMATOES_ICONS.critic.positive,
    alt: 'Rotten Tomatoes Critics',
  };
}

function resolveRatingIcon({ provider, image, variant }) {
  if (!provider) {
    return null;
  }
  switch (provider) {
    case 'rottentomatoes':
      return resolveRottenTomatoesIcon(image, variant);
    case 'imdb':
      return { src: imdbLogo, alt: 'IMDb' };
    case 'tmdb':
      return { src: tmdbLogo, alt: 'TMDb' };
    default:
      return null;
  }
}

function detectRatingProvider(entry) {
  const image = (entry?.image ?? '').toLowerCase();
  const type = (entry?.type ?? '').toLowerCase();
  const id = (entry?.id ?? '').toLowerCase();

  if (image.includes('rottentomatoes') || id.startsWith('rottentomatoes://')) {
    const variant = type.includes('audience') || image.includes('upright') || image.includes('spilled') ? 'audience' : 'critic';
    return { provider: 'rottentomatoes', variant };
  }

  if (image.includes('imdb') || id.startsWith('imdb://')) {
    return { provider: 'imdb', variant: null };
  }

  if (image.includes('themoviedb') || image.includes('tmdb') || id.startsWith('tmdb://')) {
    return { provider: 'tmdb', variant: null };
  }

  return { provider: null, variant: null };
}

function formatProviderRating(value, provider) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return typeof value === 'string' ? value : null;
  }
  if (provider === 'rottentomatoes' || provider === 'tmdb') {
    const scaled = Math.round(numeric * 10);
    return `${scaled}%`;
  }
  if (provider === 'imdb') {
    return numeric.toFixed(1);
  }
  const formatted = numeric.toFixed(1);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
}

function streamTypeValue(stream) {
  if (!stream) {
    return null;
  }
  const candidates = [stream.stream_type, stream.streamType, stream.type];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') {
      continue;
    }
    const numeric = Number(candidate);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }
  return null;
}

function filterStatEntries(entries) {
  return (entries ?? []).filter((entry) => {
    if (!entry) {
      return false;
    }
    const value = entry.value;
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === 'string' && value.trim() === '') {
      return false;
    }
    return true;
  });
}

function StatList({ items }) {
  const filtered = filterStatEntries(items);
  if (!filtered.length) {
    return null;
  }
  return (
    <div className="space-y-2">
      {filtered.map((entry) => (
        <div
          key={entry.label}
          className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/80 px-3 py-2 text-sm"
        >
          <span className="text-[11px] uppercase tracking-wide text-subtle">{entry.label}</span>
          <span className="font-semibold tracking-tight text-foreground">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function ensureArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function typeLabel(type) {
  if (!type) {
    return '';
  }
  switch (type) {
    case 'movie':
      return 'Movie';
    case 'show':
      return 'Series';
    case 'season':
      return 'Season';
    case 'episode':
      return 'Episode';
    case 'track':
      return 'Track';
    case 'album':
      return 'Album';
    case 'artist':
      return 'Artist';
    case 'clip':
      return 'Clip';
    case 'video':
      return 'Video';
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

function typeIcon(type) {
  if (!type) {
    return faLayerGroup;
  }
  switch (type) {
    case 'movie':
      return faFilm;
    case 'show':
    case 'season':
    case 'episode':
      return faTv;
    case 'artist':
    case 'album':
    case 'track':
      return faMusic;
    case 'photo':
    case 'picture':
    case 'image':
      return faImage;
    default:
      return faLayerGroup;
  }
}

function childGroupLabel(key) {
  switch (key) {
    case 'seasons':
      return 'Seasons';
    case 'episodes':
      return 'Episodes';
    case 'albums':
      return 'Albums';
    case 'tracks':
      return 'Tracks';
    case 'items':
      return 'Items';
    default:
      return key.charAt(0).toUpperCase() + key.slice(1);
  }
}

function normalizeKey(section) {
  if (!section) {
    return null;
  }
  if (section.id !== null && section.id !== undefined) {
    return section.id;
  }
  return section.key ?? null;
}

function uniqueKey(item) {
  return item?.rating_key ?? item?.key ?? item?.uuid ?? Math.random().toString(36).slice(2);
}

function normalizeLetter(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const upper = String(value).trim().toUpperCase();
  if (!upper) {
    return null;
  }
  if (/^[A-Z]$/.test(upper)) {
    return upper;
  }
  if (/^[0-9]$/.test(upper) || upper === '#') {
    return '0-9';
  }
  return null;
}

function deriveItemLetter(item) {
  const candidates = [item?.sort_title, item?.title];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    for (let index = 0; index < trimmed.length; index += 1) {
      const normalized = normalizeLetter(trimmed[index]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function TagList({ title, items }) {
  if (!items?.length) {
    return null;
  }
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h4>
      <div className="flex flex-wrap gap-2">
        {items.map((tag) => {
          const key = tag.id ?? tag.tag ?? tag.title;
          const label = tag.title ?? tag.tag;
          if (!label) {
            return null;
          }
          return (
            <span
              key={key}
              className="rounded-full border border-border/40 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground/80 shadow-sm"
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ChildList({ label, items, onSelect, onPlay, playPending }) {
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

function RelatedGroup({ hub, onSelect }) {
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

function PeopleCarousel({ title, people, fallbackRole }) {
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

function HomeRow({ title, items, onSelect, metaFormatter }) {
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
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold tracking-tight text-foreground">{title}</h4>
        <span className="text-xs uppercase tracking-wide text-subtle">{items.length}</span>
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

function HomeSectionBlock({ section, onSelectItem, onBrowseSection }) {
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

function LibraryGridImage({ item, shouldLoad }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [posterError, setPosterError] = useState(false);
  const [posterSrc, setPosterSrc] = useState(null);
  const posterPath = item?.thumb ?? null;
  const showUnavailableMessage = shouldLoad && (posterError || !posterPath);

  useEffect(() => {
    if (!shouldLoad || !posterPath) {
      setPosterSrc(null);
      setImageLoaded(false);
      setPosterError(false);
      return;
    }

    const resolvedUrl = plexImageUrl(posterPath, { width: 360, height: 540, upscale: 1 });
    setPosterSrc(resolvedUrl);
  }, [posterPath, shouldLoad]);

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden bg-border/40">
      <img
        src={placeholderPoster}
        alt=""
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
          imageLoaded && !posterError ? 'opacity-0' : 'opacity-100'
        }`}
      />
      {posterSrc ? (
        <img
          src={posterSrc}
          alt={item.title ?? 'Poster'}
          loading="lazy"
          onLoad={() => setImageLoaded(true)}
          onError={() => {
            setPosterError(true);
            setImageLoaded(false);
          }}
          className={`relative h-full w-full object-cover transition duration-500 group-hover:scale-105 ${
            imageLoaded && !posterError ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ) : null}
      {showUnavailableMessage ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-border/40 text-center">
          <FontAwesomeIcon icon={faImage} className="text-lg text-muted" />
          <span className="px-3 text-xs font-medium uppercase tracking-wide text-subtle">
            Artwork unavailable
          </span>
        </div>
      ) : null}
    </div>
  );
}

export default function LibraryPage({ onStartPlayback, focusItem = null, onConsumeFocus }) {
  const [libraryView, setLibraryView] = useState('home');
  const [navActive, setNavActive] = useState('library');
  const [sections, setSections] = useState([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [sectionsError, setSectionsError] = useState(null);
  const [sectionPageLimit, setSectionPageLimit] = useState(DEFAULT_SECTION_PAGE_LIMIT);
  const [serverInfo, setServerInfo] = useState(null);
  const [letters, setLetters] = useState(DEFAULT_LETTERS);
  const [availableSorts, setAvailableSorts] = useState([]);
  const [activeSectionId, setActiveSectionId] = useState(null);

  const [filters, setFilters] = useState({
    sort: DEFAULT_SORT,
    search: '',
    watch: 'all',
    genre: null,
    collection: null,
    year: null,
  });
  const [activeLetter, setActiveLetter] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [globalSearchInput, setGlobalSearchInput] = useState('');
  const [globalSearchData, setGlobalSearchData] = useState(null);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState(null);

  const [itemsPayload, setItemsPayload] = useState(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState(null);
  const [imageWindow, setImageWindow] = useState({ start: 0, end: -1 });

  const [viewMode, setViewMode] = useState(VIEW_GRID);
  const [itemsPerRow, setItemsPerRow] = useState(8);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsState, setDetailsState] = useState({ loading: false, error: null, data: null });
  const [playPending, setPlayPending] = useState(false);
  const [playError, setPlayError] = useState(null);
  const [queuePending, setQueuePending] = useState(false);
  const [queueNotice, setQueueNotice] = useState({ type: null, message: null });
  const [detailTab, setDetailTab] = useState('metadata');
  const [homeSections, setHomeSections] = useState([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState(null);
  const [homeLoadedSignature, setHomeLoadedSignature] = useState(null);

  const scrollContainerRef = useRef(null);
  const prefetchStateRef = useRef({ token: 0 });
  const letterNodeMap = useRef(new Map());
  const rowHeightRef = useRef(DEFAULT_CARD_HEIGHT);
  const letterScrollPendingRef = useRef(null);
  const scrollFrameRef = useRef(null);

  const navItems = useMemo(
    () => [
      {
        id: 'library',
        label: 'Library',
        icon: ({ active }) => (
          <FontAwesomeIcon
            icon={faLayerGroup}
            size="lg"
            className={active ? 'text-accent' : 'text-muted'}
          />
        ),
      },
    ],
    [],
  );

  const sectionKeysSignature = useMemo(() => {
    return sections
      .map((section) => normalizeKey(section))
      .filter((key) => key !== null && key !== undefined)
      .join('|');
  }, [sections]);

  const isHomeView = libraryView === 'home';

  const buildItemParams = useCallback(
    (overrides = {}) => {
      const params = {
        sort: overrides.sort ?? filters.sort,
        offset: overrides.offset ?? 0,
        limit: overrides.limit ?? sectionPageLimit,
      };

      const searchValue = overrides.search ?? filters.search;
      if (searchValue?.trim()) {
        params.search = searchValue.trim();
      }

      const watchValue = overrides.watch ?? filters.watch;
      if (watchValue && watchValue !== 'all') {
        params.watch = watchValue;
      }

      const genreValue = overrides.genre ?? filters.genre;
      if (genreValue) {
        params.genre = genreValue;
      }

      const collectionValue = overrides.collection ?? filters.collection;
      if (collectionValue) {
        params.collection = collectionValue;
      }

      const yearValue = overrides.year ?? filters.year;
      if (yearValue) {
        params.year = yearValue;
      }

      return params;
    },
    [filters, sectionPageLimit],
  );

  const prefetchRemainingItems = useCallback(
    async (initialPayload, token) => {
      if (!initialPayload?.pagination) {
        return;
      }

      const initialItems = initialPayload.items ?? [];
      let offset = initialItems.length;
      let total =
        typeof initialPayload.pagination.total === 'number'
          ? initialPayload.pagination.total
          : null;
      const baseLimit = initialPayload.pagination.limit ?? sectionPageLimit;

      const shouldPrefetch = () => {
        if (prefetchStateRef.current.token !== token) {
          return false;
        }
        if (total !== null) {
          return offset < total;
        }
        return offset > 0 && offset % baseLimit === 0;
      };

      if (!shouldPrefetch()) {
        if (prefetchStateRef.current.token === token) {
          setItemsPayload((prev) => {
            if (!prev?.pagination) {
              return prev;
            }
            return {
              ...prev,
              pagination: {
                ...prev.pagination,
                loaded: prev.items?.length ?? 0,
              },
            };
          });
        }
        return;
      }

      while (shouldPrefetch()) {
        let nextPayload;
        try {
          nextPayload = await fetchPlexSectionItems(
            activeSectionId,
            buildItemParams({ offset }),
          );
        } catch (error) {
          if (prefetchStateRef.current.token === token) {
            setItemsError((prevError) => prevError ?? error.message ?? 'Failed to load items');
          }
          return;
        }

        if (prefetchStateRef.current.token !== token) {
          return;
        }

        const nextItems = nextPayload?.items ?? [];
        if (!nextItems.length) {
          break;
        }

        offset += nextItems.length;
        if (typeof nextPayload?.pagination?.total === 'number') {
          total = nextPayload.pagination.total;
        }

        const currentLimit = nextPayload.pagination?.limit ?? baseLimit;
        const reachedEnd =
          (total !== null && offset >= total) ||
          (total === null && nextItems.length < currentLimit);

        setItemsPayload((prev) => {
          if (!prev) {
            return {
              ...nextPayload,
              items: [...nextItems],
              pagination: {
                ...nextPayload.pagination,
                loaded: nextItems.length,
              },
            };
          }

          const mergedItems = [...(prev.items ?? []), ...nextItems];
          const nextTotal =
            typeof nextPayload?.pagination?.total === 'number'
              ? nextPayload.pagination.total
              : prev.pagination?.total ?? mergedItems.length;

          return {
            ...prev,
            items: mergedItems,
            pagination: {
              ...prev.pagination,
              limit: currentLimit,
              total: nextTotal,
              size: nextPayload.pagination?.size ?? nextItems.length,
              loaded: mergedItems.length,
            },
            filters: nextPayload.filters ?? prev.filters,
            sort_options: nextPayload.sort_options?.length
              ? nextPayload.sort_options
              : prev.sort_options,
          };
        });

        if (reachedEnd) {
          break;
        }
      }
    },
    [activeSectionId, buildItemParams, sectionPageLimit],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadSections() {
      setSectionsLoading(true);
      setSectionsError(null);
      try {
        const data = await fetchPlexSections();
        if (cancelled) {
          return;
        }
        const allSections = Array.isArray(data?.sections) ? data.sections : [];
        const visibleSections = allSections.filter((section) => !section?.is_hidden);
        setSections(visibleSections);
        setServerInfo(data?.server ?? null);
        setLetters(data?.letters ?? DEFAULT_LETTERS);
        setAvailableSorts(data?.sort_options ?? []);
        const resolvedLimit = clampSectionPageLimit(
          data?.library_settings?.section_page_size ?? DEFAULT_SECTION_PAGE_LIMIT,
          DEFAULT_SECTION_PAGE_LIMIT,
        );
        setSectionPageLimit(resolvedLimit);
        if (!activeSectionId && visibleSections.length) {
          setActiveSectionId(normalizeKey(visibleSections[0]));
        } else if (activeSectionId && visibleSections.every((section) => normalizeKey(section) !== activeSectionId)) {
          setActiveSectionId(visibleSections.length ? normalizeKey(visibleSections[0]) : null);
        }
      } catch (error) {
        if (!cancelled) {
          setSectionsError(error.message ?? 'Failed to load Plex sections');
          setSections([]);
          setSectionPageLimit(DEFAULT_SECTION_PAGE_LIMIT);
        }
      } finally {
        if (!cancelled) {
          setSectionsLoading(false);
        }
      }
    }

    loadSections();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return undefined;
    }
    const handler = window.setTimeout(() => {
      setFilters((prev) => ({
        ...prev,
        search: searchInput.trim(),
      }));
    }, 350);
    return () => {
      window.clearTimeout(handler);
    };
  }, [searchInput]);

  useEffect(() => {
    const query = globalSearchInput.trim();

    if (libraryView !== 'browse') {
      if (query) {
        setLibraryView('browse');
      } else {
        setGlobalSearchLoading(false);
        setGlobalSearchError(null);
        setGlobalSearchData(null);
      }
      return undefined;
    }

    if (!query) {
      setGlobalSearchLoading(false);
      setGlobalSearchError(null);
      setGlobalSearchData(null);
      return undefined;
    }

    setViewMode(VIEW_GRID);
    setSelectedItem(null);
    setPlayError(null);

    let cancelled = false;
    setGlobalSearchLoading(true);
    setGlobalSearchError(null);

    const handler = window.setTimeout(() => {
      (async () => {
        try {
          const data = await fetchPlexSearch(query, { limit: SEARCH_PAGE_LIMIT });
          if (cancelled) {
            return;
          }
          setGlobalSearchData(data);
          setGlobalSearchLoading(false);
        } catch (error) {
          if (!cancelled) {
            setGlobalSearchData(null);
            setGlobalSearchLoading(false);
            setGlobalSearchError(error.message ?? 'Failed to search libraries');
          }
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(handler);
    };
  }, [globalSearchInput, libraryView]);

  useEffect(() => {
    if (!isHomeView) {
      return undefined;
    }
    if (!sectionKeysSignature) {
      setHomeSections([]);
      setHomeError(null);
      setHomeLoadedSignature(null);
      setHomeLoading(false);
      return undefined;
    }
    if (homeLoadedSignature === sectionKeysSignature && homeSections.length) {
      return undefined;
    }

    let cancelled = false;
    setHomeLoading(true);
    setHomeError(null);

    (async () => {
      const results = [];
      const encounteredErrors = [];
      for (const section of sections) {
        const key = normalizeKey(section);
        if (!key && key !== 0) {
          continue;
        }

        const [releasedResult, addedResult] = await Promise.allSettled([
          fetchPlexSectionItems(key, { sort: 'released_desc', limit: HOME_ROW_LIMIT }),
          fetchPlexSectionItems(key, { sort: 'added_desc', limit: HOME_ROW_LIMIT }),
        ]);

        if (cancelled) {
          return;
        }

        const row = {
          id: key,
          title: section.title,
          type: section.type,
          recentlyReleased: [],
          recentlyAdded: [],
        };

        if (releasedResult.status === 'fulfilled') {
          row.recentlyReleased = releasedResult.value?.items ?? [];
        } else {
          encounteredErrors.push(
            releasedResult.reason?.message
              ? `${section.title ?? 'Library'} (recently released): ${releasedResult.reason.message}`
              : `${section.title ?? 'Library'} (recently released): failed to load`,
          );
        }

        if (addedResult.status === 'fulfilled') {
          row.recentlyAdded = addedResult.value?.items ?? [];
        } else {
          encounteredErrors.push(
            addedResult.reason?.message
              ? `${section.title ?? 'Library'} (recently added): ${addedResult.reason.message}`
              : `${section.title ?? 'Library'} (recently added): failed to load`,
          );
        }

        results.push(row);
      }

      if (cancelled) {
        return;
      }

      setHomeSections(results);
      setHomeLoadedSignature(sectionKeysSignature);
      setHomeLoading(false);
      setHomeError(
        encounteredErrors.length
          ? encounteredErrors.length === 1
            ? encounteredErrors[0]
            : 'Some library rows failed to load. Recent data may be incomplete.'
          : null,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [homeLoadedSignature, homeSections.length, isHomeView, sectionKeysSignature, sections]);

  useEffect(() => {
    if (libraryView !== 'home') {
      return;
    }
    setViewMode(VIEW_GRID);
    setSelectedItem(null);
    setPlayError(null);
    setQueueNotice({ type: null, message: null });
  }, [libraryView]);

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return undefined;
    }
    // Reset section-specific filters when changing sections.
    setFilters((prev) => ({
      ...prev,
      genre: null,
      collection: null,
      year: null,
    }));
    setActiveLetter(null);
    letterNodeMap.current.clear();
    setItemsPayload(null);
    setItemsError(null);
    setSelectedItem(null);
    setViewMode(VIEW_GRID);
    setDetailsState({ loading: false, error: null, data: null });
    setImageWindow({ start: 0, end: -1 });
    letterScrollPendingRef.current = null;
  }, [activeSectionId]);

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return undefined;
    }
    if (libraryView !== 'browse') {
      return undefined;
    }
    if (!activeSectionId) {
      return undefined;
    }

    prefetchStateRef.current.token += 1;
    const currentToken = prefetchStateRef.current.token;
    let cancelled = false;

    setItemsLoading(true);
    setItemsError(null);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0 });
    }

    (async () => {
      try {
        const payload = await fetchPlexSectionItems(activeSectionId, buildItemParams({ offset: 0 }));
        if (cancelled || prefetchStateRef.current.token !== currentToken) {
          return;
        }
        const nextItems = payload?.items ?? [];
        setItemsPayload({
          ...payload,
          items: nextItems,
          pagination: {
            ...payload.pagination,
            loaded: nextItems.length,
          },
        });
        setAvailableSorts((prev) => (payload?.sort_options?.length ? payload.sort_options : prev));
        prefetchRemainingItems(payload, currentToken);
      } catch (error) {
        if (!cancelled && prefetchStateRef.current.token === currentToken) {
          setItemsError(error.message ?? 'Failed to load items');
          setItemsPayload(null);
        }
      } finally {
        if (!cancelled && prefetchStateRef.current.token === currentToken) {
          setItemsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [SECTIONS_ONLY_MODE, activeSectionId, buildItemParams, prefetchRemainingItems, libraryView]);

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return undefined;
    }
    if (viewMode !== VIEW_DETAILS || !selectedItem?.rating_key) {
      setDetailsState({ loading: false, error: null, data: null });
      return;
    }
    let cancelled = false;
    setDetailsState({ loading: true, error: null, data: null });
    (async () => {
      try {
        const data = await fetchPlexItemDetails(selectedItem.rating_key);
        if (cancelled) {
          return;
        }
        setDetailsState({ loading: false, error: null, data });
        if (data?.item) {
          setSelectedItem((prev) => ({ ...prev, ...data.item }));
        }
      } catch (error) {
        if (!cancelled) {
          setDetailsState({
            loading: false,
            error: error.message ?? 'Failed to load item details',
            data: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedItem?.rating_key, viewMode]);

  useEffect(() => {
    if (!focusItem?.ratingKey) {
      return undefined;
    }

    const normalizedRatingKey = String(focusItem.ratingKey);
    setGlobalSearchInput('');
    setSearchInput('');
    setLibraryView('browse');
    setViewMode(VIEW_DETAILS);
    setPlayError(null);
    setDetailTab('metadata');
    if (selectedItem?.rating_key && String(selectedItem.rating_key) === normalizedRatingKey) {
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      onConsumeFocus?.();
      return undefined;
    }

    let cancelled = false;
    setSelectedItem(null);
    setDetailsState({ loading: true, error: null, data: null });

    (async () => {
      try {
        const data = await fetchPlexItemDetails(normalizedRatingKey);
        if (cancelled) {
          return;
        }
        const detailItem = data?.item ?? null;
        const targetSection =
          focusItem.librarySectionId ?? detailItem?.library_section_id ?? activeSectionId;
        if (targetSection !== null && targetSection !== undefined) {
          setActiveSectionId(targetSection);
        }
        if (detailItem) {
          setSelectedItem(detailItem);
        }
        setDetailsState({ loading: false, error: null, data });
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load item details';
          setDetailsState({ loading: false, error: message, data: null });
          setSelectedItem(null);
        }
      } finally {
        if (!cancelled) {
          onConsumeFocus?.();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusItem?.librarySectionId, focusItem?.ratingKey]);

  const items = itemsPayload?.items ?? [];
  const globalSearchItems = globalSearchData?.items ?? [];
  const isGlobalSearching = !isHomeView && Boolean(globalSearchInput.trim());
  const visibleItems = isGlobalSearching ? globalSearchItems : items;
  const visibleItemCount = visibleItems.length;
  const hasImageWindow = imageWindow.end >= imageWindow.start;
  const totalItemCount = isGlobalSearching
    ? globalSearchData?.pagination?.total ?? globalSearchItems.length
    : itemsPayload?.pagination?.total ?? items.length;
  const currentLoading = isGlobalSearching ? globalSearchLoading : itemsLoading;
  const currentError = isGlobalSearching ? globalSearchError : itemsError;
  const loadedItemCount = isGlobalSearching
    ? visibleItemCount
    : itemsPayload?.pagination?.loaded ?? visibleItemCount;
  const countLabel = (() => {
    if (isHomeView) {
      const libraryCount = sections.length;
      if (!libraryCount) {
        return 'No libraries available';
      }
      const suffix = libraryCount === 1 ? 'library' : 'libraries';
      return `${libraryCount.toLocaleString()} ${suffix}`;
    }
    if (isGlobalSearching) {
      const suffix = totalItemCount === 1 ? 'result' : 'results';
      return `${visibleItemCount.toLocaleString()} of ${totalItemCount.toLocaleString()} ${suffix}`;
    }
    if (typeof totalItemCount === 'number' && totalItemCount >= 0) {
      const cappedLoaded = Math.min(loadedItemCount, totalItemCount);
      return `${cappedLoaded.toLocaleString()} of ${totalItemCount.toLocaleString()} items`;
    }
    return `${loadedItemCount.toLocaleString()} items`;
  })();
  const activeSearchQuery = isGlobalSearching ? globalSearchData?.query ?? globalSearchInput.trim() : '';
  const countPillTitle = isGlobalSearching && activeSearchQuery ? `Search results for “${activeSearchQuery}”` : undefined;
  const shouldShowFilters = !isGlobalSearching && !isHomeView;
  const emptyStateMessage = isGlobalSearching
    ? 'No results match this search.'
    : 'No items match the current filters.';

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return;
    }
    if (!activeSectionId) {
      return;
    }
    if (isGlobalSearching) {
      return;
    }
    const trimmedInput = searchInput.trim();
    const activeSearchValue = filters.search ?? '';
    if (trimmedInput !== activeSearchValue) {
      setItemsLoading(true);
    }
  }, [SECTIONS_ONLY_MODE, activeSectionId, isGlobalSearching, searchInput, filters.search]);
  const sortOptions = useMemo(() => {
    if (itemsPayload?.sort_options?.length) {
      return itemsPayload.sort_options;
    }
    if (availableSorts.length) {
      return availableSorts;
    }
    return [
      { id: 'title_asc', label: 'Title (A-Z)' },
      { id: 'title_desc', label: 'Title (Z-A)' },
      { id: 'added_desc', label: 'Recently Added' },
    ];
  }, [itemsPayload?.sort_options, availableSorts]);

  const measureCardRef = useCallback((node) => {
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    if (!rect.height) {
      return;
    }
    let gap = 0;
    const parent = node.parentElement;
    if (parent && typeof window !== 'undefined') {
      const styles = window.getComputedStyle(parent);
      const rowGapValue = parseFloat(styles.rowGap || styles.gap || '0');
      if (!Number.isNaN(rowGapValue)) {
        gap = rowGapValue;
      }
    }
    const nextHeight = rect.height + gap;
    if (nextHeight > 0 && Math.abs(nextHeight - rowHeightRef.current) > 0.5) {
      rowHeightRef.current = nextHeight;
    }
  }, []);

  const updateImageWindow = useCallback(() => {
    if (viewMode !== VIEW_GRID || visibleItemCount === 0) {
      setImageWindow((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
      return;
    }

    const totalItems = visibleItemCount;

    const container = scrollContainerRef.current;
    const rowHeight = rowHeightRef.current || DEFAULT_CARD_HEIGHT;
    const effectiveColumns = Math.max(itemsPerRow, 1);
    const totalRows = Math.ceil(totalItems / effectiveColumns);
    let firstRow = 0;
    let lastRow = totalRows - 1;

    if (container && rowHeight > 0) {
      const scrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;
      firstRow = Math.max(0, Math.floor(scrollTop / rowHeight));
      const visibleRows = Math.max(1, Math.ceil(containerHeight / rowHeight) + 1);
      lastRow = Math.min(totalRows - 1, firstRow + visibleRows);
    }

    const visibleStart = firstRow * effectiveColumns;
    const visibleEnd = Math.min(totalItems - 1, (lastRow + 1) * effectiveColumns - 1);
    const windowStart = Math.max(0, visibleStart - IMAGE_PREFETCH_RADIUS);
    const windowEnd = Math.min(totalItems - 1, visibleEnd + IMAGE_PREFETCH_RADIUS);

    if (windowEnd < windowStart) {
      setImageWindow((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
      return;
    }

    setImageWindow((prev) =>
      prev.start === windowStart && prev.end === windowEnd
        ? prev
        : { start: windowStart, end: windowEnd },
    );
  }, [itemsPerRow, viewMode, visibleItemCount]);

  const registerLetterRef = useCallback(
    (letter) => (node) => {
      if (!letter) {
        return;
      }
      if (node) {
        letterNodeMap.current.set(letter, node);
      } else {
        letterNodeMap.current.delete(letter);
      }
    },
    [],
  );

  const scrollToLetter = useCallback(
    (letter) => {
      const container = scrollContainerRef.current;
      if (!container) {
        return false;
      }
      if (!letter) {
        container.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
      }
      const targetNode = letterNodeMap.current.get(letter);
      if (!targetNode) {
        return false;
      }
      const containerRect = container.getBoundingClientRect();
      const targetRect = targetNode.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(offset - 16, 0), behavior: 'smooth' });
      return true;
    },
    [],
  );

  useEffect(() => {
    if (viewMode !== VIEW_GRID || visibleItemCount === 0) {
      if (scrollFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      setImageWindow((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
      return undefined;
    }

    const container = scrollContainerRef.current;
    if (!container || typeof window === 'undefined') {
      updateImageWindow();
      return undefined;
    }

    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        updateImageWindow();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    updateImageWindow();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [updateImageWindow, viewMode, visibleItemCount]);

  useEffect(() => {
    if (!shouldShowFilters) {
      letterScrollPendingRef.current = null;
      return;
    }
    if (activeLetter === null) {
      letterScrollPendingRef.current = null;
      return;
    }
    const scrolled = scrollToLetter(activeLetter);
    if (!scrolled) {
      letterScrollPendingRef.current = activeLetter;
    } else {
      letterScrollPendingRef.current = null;
    }
  }, [activeLetter, scrollToLetter, shouldShowFilters]);

  useEffect(() => {
    if (!shouldShowFilters) {
      letterScrollPendingRef.current = null;
      return;
    }
    const pendingLetter = letterScrollPendingRef.current;
    if (!pendingLetter) {
      return;
    }
    if (scrollToLetter(pendingLetter)) {
      letterScrollPendingRef.current = null;
    }
  }, [scrollToLetter, shouldShowFilters, visibleItemCount]);

  const handleSelectItem = useCallback((item) => {
    if (!item) {
      setSelectedItem(null);
      setViewMode(VIEW_GRID);
      setPlayError(null);
      setQueueNotice({ type: null, message: null });
      return;
    }
    setSelectedItem(item);
    setViewMode(VIEW_DETAILS);
    setPlayError(null);
    setQueueNotice({ type: null, message: null });
    setDetailTab('metadata');
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  const handleBrowseSection = useCallback((sectionId) => {
    if (sectionId === null || sectionId === undefined) {
      return;
    }
    setActiveSectionId(sectionId);
    setLibraryView('browse');
    setGlobalSearchInput('');
    setSearchInput('');
  }, []);

  const handleGoHome = useCallback(() => {
    setLibraryView('home');
    setGlobalSearchInput('');
    setSearchInput('');
    setSelectedItem(null);
    setViewMode(VIEW_GRID);
    setPlayError(null);
    setQueueNotice({ type: null, message: null });
  }, []);

  const handleHomeSelect = useCallback(
    (item) => {
      if (!item) {
        return;
      }
      const targetSectionId = item.library_section_id ?? item.librarySectionId ?? activeSectionId;
      if (targetSectionId !== null && targetSectionId !== undefined) {
        setActiveSectionId(targetSectionId);
      }
      setLibraryView('browse');
      handleSelectItem(item);
    },
    [activeSectionId, handleSelectItem],
  );

  const handlePlay = useCallback(
    async (item) => {
      if (!item?.rating_key) {
        return;
      }
      setPlayPending(true);
      setPlayError(null);
      try {
        const response = await playPlexItem(item.rating_key, {});
        setPlayPending(false);
        onStartPlayback?.(response);
      } catch (error) {
        setPlayPending(false);
        setPlayError(error.message ?? 'Failed to start playback');
      }
    },
    [onStartPlayback],
  );

  const handleQueueAction = useCallback(
    async (item, mode) => {
      if (!item?.rating_key) {
        return;
      }
      setQueuePending(true);
      setQueueNotice({ type: null, message: null });
      try {
        const response = await enqueueQueueItem(item.rating_key, { mode });
        const queued = response?.item ?? null;
        const labelParts = [];
        if (queued?.grandparent_title) {
          labelParts.push(queued.grandparent_title);
        }
        if (queued?.title) {
          labelParts.push(queued.title);
        }
        const label = labelParts.length ? labelParts.join(' — ') : item?.title ?? 'Item';
        const successMessage =
          mode === 'next'
            ? `${label} will play next.`
            : `${label} added to the end of the queue.`;
        setQueueNotice({ type: 'success', message: successMessage });
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
          setQueueNotice({ type: 'error', message: 'Sign in required to manage the queue.' });
        } else {
          const message =
            (error && typeof error === 'object' && 'message' in error && error.message)
              || 'Failed to add item to queue';
          setQueueNotice({ type: 'error', message });
        }
      } finally {
        setQueuePending(false);
      }
    },
    [],
  );

  const handleCloseDetails = useCallback(() => {
    setViewMode(VIEW_GRID);
    setSelectedItem(null);
    setPlayError(null);
  }, []);

  const handleLetterChange = useCallback(
    (letter) => {
      if (!shouldShowFilters) {
        return;
      }
      if (letter === null) {
        letterScrollPendingRef.current = null;
        scrollToLetter(null);
        if (activeLetter !== null) {
          setActiveLetter(null);
        }
        return;
      }
      if (activeLetter === letter) {
        scrollToLetter(letter);
        return;
      }
      letterScrollPendingRef.current = letter;
      setActiveLetter(letter);
    },
    [activeLetter, scrollToLetter, shouldShowFilters],
  );

  const letterAnchorTracker = new Set();

  const handleClearFilters = useCallback(() => {
    setFilters({
      sort: DEFAULT_SORT,
      search: '',
      watch: 'all',
      genre: null,
      collection: null,
      year: null,
    });
    setSearchInput('');
    setActiveLetter(null);
  }, []);

  const details = detailsState.data;
  const children = details?.children ?? {};
  const mediaItems = details?.media ?? [];
  const detailImages = Array.isArray(details?.images) ? details.images : [];
  const ratingEntries = Array.isArray(details?.ratings) ? details.ratings : [];
  const guidEntries = Array.isArray(details?.guids) ? details.guids : [];
  const ultraBlur = details?.ultra_blur ?? null;

  const preferredBackdrop =
    imageByType(detailImages, 'background') ??
    imageByType(detailImages, 'art') ??
    imageByType(detailImages, 'fanart');
  const heroBackdrop = preferredBackdrop
    ? resolveImageUrl(preferredBackdrop.url, { width: 1920, height: 1080, min: 1, upscale: 1, blur: 200 })
    : selectedItem
    ? resolveImageUrl(selectedItem.art, { width: 1920, height: 1080, min: 1, upscale: 1, blur: 200 })
    : null;
  const fallbackBackdrop = selectedItem
    ? resolveImageUrl(selectedItem.grandparent_thumb ?? selectedItem.thumb, {
        width: 1920,
        height: 1080,
        min: 1,
        upscale: 1,
        blur: 120,
      })
    : null;
  const heroImage = heroBackdrop ?? fallbackBackdrop;
  const preferredPoster =
    imageByType(detailImages, 'coverposter') ??
    imageByType(detailImages, 'coverart') ??
    imageByType(detailImages, 'poster');
  const posterImage = preferredPoster
    ? resolveImageUrl(preferredPoster.url, { width: 600, height: 900, min: 1, upscale: 1 })
    : selectedItem
    ? resolveImageUrl(selectedItem.thumb, { width: 600, height: 900, min: 1, upscale: 1 })
    : null;
  const heroFallbackStyle = ultraBlur
    ? {
        background: `linear-gradient(135deg, #${(ultraBlur.top_left ?? '202020').replace('#', '')} 0%, #${(ultraBlur.top_right ?? ultraBlur.top_left ?? '292929').replace('#', '')} 35%, #${(ultraBlur.bottom_right ?? ultraBlur.bottom_left ?? '1a1a1a').replace('#', '')} 100%)`,
      }
    : undefined;

  const runtimeLabel = selectedItem ? formatRuntime(selectedItem.duration) : null;
  const addedDate = selectedItem ? formatDate(selectedItem.added_at) : null;
  const updatedDate = selectedItem ? formatDate(selectedItem.updated_at) : null;
  const lastViewedDate = selectedItem ? formatDate(selectedItem.last_viewed_at) : null;
  const releaseDate = selectedItem ? formatDate(selectedItem.originally_available_at) : null;
  const viewCount = selectedItem ? formatCount(selectedItem.view_count) : null;
  const ratingBadgeMap = new Map();

  const addRatingBadge = (key, { label, provider, variant, image, rawValue }) => {
    const displayValue = formatProviderRating(rawValue, provider);
    if (!displayValue) {
      return;
    }
    const normalizedKey = key ?? label ?? displayValue;
    if (ratingBadgeMap.has(normalizedKey)) {
      return;
    }
    ratingBadgeMap.set(normalizedKey, {
      key: normalizedKey,
      label,
      value: displayValue,
      icon: resolveRatingIcon({ provider, image, variant }),
    });
  };

  const criticProvider = selectedItem?.rating_image?.includes('rottentomatoes') ? 'rottentomatoes' : null;
  addRatingBadge('critic', {
    label: 'Critic Rating',
    provider: criticProvider,
    variant: 'critic',
    image: selectedItem?.rating_image,
    rawValue: selectedItem?.rating,
  });

  const audienceProvider = selectedItem?.audience_rating_image?.includes('rottentomatoes') ? 'rottentomatoes' : null;
  addRatingBadge('audience', {
    label: 'Audience Rating',
    provider: audienceProvider,
    variant: 'audience',
    image: selectedItem?.audience_rating_image,
    rawValue: selectedItem?.audience_rating,
  });

  addRatingBadge('user', {
    label: 'User Rating',
    provider: null,
    variant: null,
    image: null,
    rawValue: selectedItem?.user_rating,
  });

  ratingEntries.forEach((entry, index) => {
    const providerInfo = detectRatingProvider(entry);
    const providerLabel = providerInfo.provider ? PROVIDER_LABELS[providerInfo.provider] : 'Rating';
    const typeLabel = entry.type ? String(entry.type).replaceAll('_', ' ') : null;
    const label = typeLabel ? `${providerLabel} ${typeLabel}` : providerLabel;
    const badgeKey = providerInfo.provider
      ? `${providerInfo.provider}-${providerInfo.variant ?? typeLabel ?? index}`
      : `external-${index}`;
    addRatingBadge(badgeKey, {
      label,
      provider: providerInfo.provider,
      variant: providerInfo.variant,
      image: entry.image,
      rawValue: entry.value,
    });
  });

  const ratingBadges = Array.from(ratingBadgeMap.values());

  const tagGroups = [
    { title: 'Genres', items: selectedItem?.genres },
    { title: 'Collections', items: selectedItem?.collections },
    { title: 'Labels', items: selectedItem?.labels },
    { title: 'Moods', items: selectedItem?.moods },
    { title: 'Countries', items: selectedItem?.countries },
  ].filter((group) => group.items?.length);

  const relatedHubs = Array.isArray(details?.related) ? details.related : [];
  const directors = selectedItem?.directors ?? [];
  const directorNames = directors
    .map((person) => person.title ?? person.tag)
    .filter(Boolean);

  const coreStatEntries = [
    { label: 'Content Rating', value: selectedItem?.content_rating },
    { label: 'Studio', value: selectedItem?.studio },
    { label: 'Runtime', value: runtimeLabel },
    { label: 'Library', value: selectedItem?.library_section_title },
    { label: 'View Count', value: viewCount },
  ];

  const timelineStatEntries = [
    { label: 'Released', value: releaseDate },
    { label: 'Added', value: addedDate },
    { label: 'Last Viewed', value: lastViewedDate },
    { label: 'Updated', value: updatedDate },
  ];

  const identifierChips = guidEntries
    .map((guid) => {
      if (!guid?.id) {
        return null;
      }
      const [scheme, rawValue] = String(guid.id).split('://');
      const label = scheme ? scheme.toUpperCase() : 'ID';
      const value = rawValue ?? guid.id;
      return { label, value };
    })
    .filter((chip) => chip?.value);

  const detailStats = filterStatEntries(coreStatEntries);
  const timelineStats = filterStatEntries(timelineStatEntries);

  const metadataPanel = (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {detailStats.length ? (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Details</h4>
            <StatList items={detailStats} />
          </div>
        ) : null}
        {timelineStats.length ? (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Timeline</h4>
            <StatList items={timelineStats} />
          </div>
        ) : null}
      </div>
      {tagGroups.length ? (
        <div className="space-y-4 pt-2">
          {tagGroups.map((group) => (
            <TagList key={group.title} title={group.title} items={group.items} />
          ))}
        </div>
      ) : null}
      {identifierChips.length ? (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Identifiers</h4>
          <div className="flex flex-wrap gap-2">
            {identifierChips.map((chip) => (
              <span
                key={`${chip.label}-${chip.value}`}
                className="rounded-full border border-border/40 bg-background/70 px-3 py-1 text-xs font-semibold text-foreground/80 shadow-sm"
              >
                {chip.label}: {chip.value}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  const mediaPanel = mediaItems.length ? (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-subtle">
        <span>
          {mediaItems.length} {mediaItems.length === 1 ? 'Version' : 'Versions'}
        </span>
      </div>
      {mediaItems.map((medium, index) => {
        const versionLabel = medium.video_resolution ? `${medium.video_resolution}p` : `Version ${index + 1}`;
        const dimensions = medium.width && medium.height ? `${medium.width}×${medium.height}` : null;
        const bitrate = formatBitrate(medium.bitrate);
        const aspectRatio = medium.aspect_ratio ? `AR ${medium.aspect_ratio}` : null;
        const audioCodec = medium.audio_codec ? medium.audio_codec.toUpperCase() : null;
        const videoCodec = medium.video_codec ? medium.video_codec.toUpperCase() : null;
        const container = medium.container ? medium.container.toUpperCase() : null;
        const parts = medium.parts ?? [];
        return (
          <div
            key={medium.id ?? `${medium.video_resolution ?? 'version'}-${index}`}
            className="space-y-4 rounded-xl border border-border/30 bg-background/70 px-4 py-4"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle">
              <span className="rounded-full bg-background/80 px-3 py-1 text-foreground">{versionLabel}</span>
              {dimensions ? (
                <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                  {dimensions}
                </span>
              ) : null}
              {videoCodec ? (
                <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                  {videoCodec}
                </span>
              ) : null}
              {audioCodec ? (
                <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                  {audioCodec}
                </span>
              ) : null}
              {bitrate ? (
                <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                  {bitrate}
                </span>
              ) : null}
              {aspectRatio ? (
                <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                  {aspectRatio}
                </span>
              ) : null}
              {container ? (
                <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                  {container}
                </span>
              ) : null}
            </div>
            {parts.map((part, partIndex) => {
              const partId = part.id ?? part.key ?? partIndex;
              const partSize = formatFileSize(part.size);
              const partDuration = formatRuntime(part.duration);
              const partStreams = ensureArray(part.streams ?? part.Stream);
              const videoStreams = partStreams.filter((stream) => streamTypeValue(stream) === 1);
              const audioStreams = partStreams.filter((stream) => streamTypeValue(stream) === 2);
              const subtitleStreams = partStreams.filter((stream) => streamTypeValue(stream) === 3);
              return (
                <div
                  key={partId}
                  className="space-y-4 rounded-xl border border-border/20 bg-background px-3 py-3 text-sm text-muted"
                >
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                      Part {partIndex + 1}
                    </span>
                    {partSize ? (
                      <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                        {partSize}
                      </span>
                    ) : null}
                    {partDuration ? (
                      <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                        {partDuration}
                      </span>
                    ) : null}
                    {part.container ? (
                      <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                        {part.container.toUpperCase?.() ?? part.container}
                      </span>
                    ) : null}
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Video</p>
                      {videoStreams.length ? (
                        <div className="space-y-1">
                          {videoStreams.map((stream) => {
                            const pieces = [
                              stream.display_title || stream.title,
                              stream.codec ? stream.codec.toUpperCase() : null,
                              stream.profile ? `Profile ${stream.profile}` : null,
                              stream.width && stream.height ? `${stream.width}×${stream.height}` : null,
                              stream.frame_rate ? formatFrameRate(stream.frame_rate) : null,
                              stream.bitrate ? formatBitrate(stream.bitrate) : null,
                            ].filter(Boolean);
                            const key = stream.id ?? `${partId}-video-${stream.index}`;
                            return (
                              <div
                                key={key}
                                className="rounded-lg border border-border/30 bg-background px-3 py-1 text-xs text-foreground/80"
                              >
                                {pieces.join(' • ')}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-muted">No video streams</p>
                      )}
                    </div>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Audio</p>
                        {audioStreams.length ? (
                          <div className="space-y-1">
                            {audioStreams.map((stream) => {
                              const pieces = [
                                stream.display_title || stream.title,
                                stream.language,
                                stream.codec ? stream.codec.toUpperCase() : null,
                                formatChannelLayout(stream.channels),
                                stream.bitrate ? formatBitrate(stream.bitrate) : null,
                              ].filter(Boolean);
                              const key = stream.id ?? `${partId}-audio-${stream.index}`;
                              return (
                                <div
                                  key={key}
                                  className="rounded-lg border border-border/30 bg-background px-3 py-1 text-xs text-foreground/80"
                                >
                                  {pieces.join(' • ')}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-muted">No audio streams</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Subtitles</p>
                        {subtitleStreams.length ? (
                          <div className="space-y-1">
                            {subtitleStreams.map((stream) => {
                              const pieces = [
                                stream.display_title || stream.title,
                                stream.language,
                                stream.codec ? stream.codec.toUpperCase() : null,
                              ].filter(Boolean);
                              const key = stream.id ?? `${partId}-sub-${stream.index}`;
                              return (
                                <div
                                  key={key}
                                  className="rounded-lg border border-border/30 bg-background px-3 py-1 text-xs text-foreground/80"
                                >
                                  {pieces.join(' • ')}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-xs text-muted">No subtitle streams</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  ) : (
    <p className="text-sm text-muted">No media details available.</p>
  );

  const crewPeople = useMemo(() => {
    const roleMap = new Map();
    const addPeople = (list, roleLabel) => {
      (list ?? []).forEach((person) => {
        const key = person.id ?? person.tag ?? person.title;
        if (!key) {
          return;
        }
        const name = person.title ?? person.tag ?? 'Unknown';
        const entry = roleMap.get(key);
        if (entry) {
          if (roleLabel && !entry.roles.includes(roleLabel)) {
            entry.roles.push(roleLabel);
          }
          if (!entry.thumb && person.thumb) {
            entry.thumb = person.thumb;
          }
        } else {
          roleMap.set(key, {
            id: person.id ?? key,
            tag: name,
            title: name,
            thumb: person.thumb,
            roles: roleLabel ? [roleLabel] : [],
          });
        }
      });
    };

    addPeople(selectedItem?.directors, 'Director');
    addPeople(selectedItem?.writers, 'Writer');
    addPeople(selectedItem?.producers, 'Producer');

    return Array.from(roleMap.values()).map((person) => ({
      ...person,
      role: person.roles.join(', '),
    }));
  }, [selectedItem?.directors, selectedItem?.producers, selectedItem?.writers]);

  const serverLabel = serverInfo?.name ?? serverInfo?.title ?? serverInfo?.product ?? null;

  const renderSectionSidebar = () => (
    <aside className="flex w-64 flex-col border-r border-border/80 bg-surface/80">
      <header className="flex min-h-[56px] items-center border-b border-border/60 px-4 py-3">
        <div className="flex w-full items-center gap-3">
          <div className="flex flex-1 items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted focus-within:border-accent">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs text-subtle" />
            <input
              type="search"
              value={globalSearchInput}
              onChange={(event) => setGlobalSearchInput(event.target.value)}
              placeholder=""
              className="w-full bg-transparent text-sm text-foreground outline-none"
              aria-label="Search all libraries"
            />
            {globalSearchLoading ? <FontAwesomeIcon icon={faCircleNotch} spin className="text-xs text-muted" /> : null}
          </div>
          {sectionsLoading ? <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" /> : null}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {sectionsError ? (
          <div className="rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger">
            {sectionsError}
          </div>
        ) : null}
        {!sectionsLoading && !sections.length ? (
          <div className="rounded-lg border border-border/60 bg-surface px-3 py-2 text-xs text-muted">
            No libraries available.
          </div>
        ) : null}
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              onClick={handleGoHome}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                isHomeView
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border/70 bg-surface/70 text-muted hover:border-accent/60 hover:text-foreground'
              }`}
            >
              <FontAwesomeIcon icon={faHouse} className="h-4 w-4 shrink-0" />
              <span className="truncate text-sm font-semibold">Home</span>
            </button>
          </li>
          <li aria-hidden="true" className="mx-3 my-2 h-px bg-border/60" />
          {sections.map((section) => {
            const key = normalizeKey(section);
            const isActive = !isHomeView && key === activeSectionId;
            return (
              <li key={key ?? section.title}>
                <button
                  type="button"
                  onClick={() => handleBrowseSection(key)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                    isActive
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border/70 bg-surface/70 text-muted hover:border-accent/60 hover:text-foreground'
                  }`}
                >
                  <FontAwesomeIcon icon={typeIcon(section.type)} className="h-4 w-4 shrink-0" />
                  <span className="truncate text-sm font-semibold">{section.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );

  if (SECTIONS_ONLY_MODE) {
    return (
      <div className="flex h-full w-full bg-background text-foreground">
        <DockNav
          items={navItems}
          activeId={navActive}
          onChange={(nextId) => setNavActive(nextId)}
          position="left"
          className="border-r border-border/60"
        />
        {navActive ? renderSectionSidebar() : null}
        <div className="flex flex-1 items-center justify-center px-6 py-6">
          <div className="max-w-md space-y-3 rounded-xl border border-border/70 bg-surface/70 p-6 text-center">
            <h2 className="text-lg font-semibold text-foreground">Library sections loaded</h2>
            <p className="text-sm text-muted">
              Section browsing is temporarily limited to listing Plex libraries while we simplify the
              workflow.
            </p>
            {sectionsLoading ? (
              <div className="flex items-center justify-center gap-2 text-sm text-muted">
                <FontAwesomeIcon icon={faCircleNotch} spin />
                Fetching sections…
              </div>
            ) : null}
            {!sectionsLoading && sections.length ? (
              <p className="text-xs text-subtle">
                Select a library from the left to confirm it is available. Additional browsing tools
                will return in a later iteration.
              </p>
            ) : null}
            {sectionsError ? (
              <div className="rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger">
                {sectionsError}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <DockNav
        items={navItems}
        activeId={navActive}
        onChange={(nextId) => setNavActive(nextId)}
        position="left"
        className="border-r border-border/60"
      />

      {navActive ? renderSectionSidebar() : null}

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-surface/70 px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {(isHomeView ? homeLoading : currentLoading) ? (
              <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" />
            ) : null}
            <span
              className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-foreground"
              title={countPillTitle}
            >
              {countLabel}
            </span>
            {!isHomeView && isGlobalSearching && activeSearchQuery ? (
              <span className="truncate text-xs text-muted">for “{activeSearchQuery}”</span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isHomeView ? (
              <>
                {serverLabel ? (
                  <span className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs text-muted">
                    {serverLabel}
                  </span>
                ) : null}
              </>
            ) : viewMode === VIEW_DETAILS ? (
              <>
                <button
                  type="button"
                  onClick={() => handlePlay(selectedItem)}
                  disabled={playPending || !selectedItem?.playable}
                  className="flex items-center gap-2 rounded-full border border-transparent bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90 disabled:opacity-60"
                >
                  <FontAwesomeIcon icon={faPlay} />
                  {playPending ? 'Starting…' : 'Start'}
                </button>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-2 py-1 text-xs text-muted">
                    <button
                      type="button"
                      onClick={() => handleQueueAction(selectedItem, 'next')}
                      disabled={queuePending || !selectedItem?.playable}
                      className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40 disabled:opacity-50"
                    >
                      <FontAwesomeIcon icon={faArrowUp} className="text-xs" />
                      Queue Next
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQueueAction(selectedItem, 'last')}
                      disabled={queuePending || !selectedItem?.playable}
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
                    <span
                      className={`px-2 text-[11px] ${queueNotice.type === 'error' ? 'text-danger' : 'text-muted'}`}
                    >
                      {queueNotice.message}
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted focus-within:border-accent">
                  <FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs text-subtle" />
                  <input
                    type="search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Filter titles…"
                    className="w-40 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
                  />
                </div>
                <select
                  value={filters.sort}
                  onChange={(event) => setFilters((prev) => ({ ...prev, sort: event.target.value }))}
                  className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
                >
                  {sortOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  value={filters.watch}
                  onChange={(event) => setFilters((prev) => ({ ...prev, watch: event.target.value }))}
                  className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
                >
                  {WATCH_FILTERS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted">
                  <span className="text-xs">Columns</span>
                  <input
                    type="range"
                    min="4"
                    max="12"
                    step="1"
                    value={itemsPerRow}
                    onChange={(event) => setItemsPerRow(Number(event.target.value))}
                    className="h-1.5 w-28 appearance-none accent-accent"
                    aria-label="Columns per row"
                    title={`Columns per row: ${itemsPerRow}`}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleClearFilters}
                  className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent hover:text-accent"
                >
                  <FontAwesomeIcon icon={faArrowRotateLeft} className="mr-2 text-xs" />
                  Reset
                </button>
              </>
            )}
          </div>
        </header>

        {isHomeView ? (
          <div className="flex flex-1 overflow-y-auto px-6 py-6">
            <div className="flex w-full flex-col gap-6">
              {homeError ? (
                <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                  {homeError}
                </div>
              ) : null}
              {homeLoading && !homeSections.length ? (
                <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
                  <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
                </div>
              ) : null}
              {!homeLoading && !homeSections.length ? (
                <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
                  <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
                  <p>No recent activity yet.</p>
                </div>
              ) : null}
              {homeSections.map((section) => (
                <HomeSectionBlock
                  key={section.id ?? section.title}
                  section={section}
                  onSelectItem={handleHomeSelect}
                  onBrowseSection={handleBrowseSection}
                />
              ))}
              {homeLoading && homeSections.length ? (
                <div className="flex items-center justify-center gap-2 text-xs text-muted">
                  <FontAwesomeIcon icon={faCircleNotch} spin />
                  Refreshing…
                </div>
              ) : null}
            </div>
          </div>
        ) : viewMode === VIEW_GRID ? (
          <div className="relative flex flex-1 overflow-hidden">
            <div ref={scrollContainerRef} className="relative flex-1 overflow-y-auto px-6 py-6">
              {currentError ? (
                <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                  {currentError}
                </div>
              ) : null}

              {currentLoading ? (
                <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
                  <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
                </div>
              ) : null}

              {!currentLoading && !visibleItems.length ? (
                <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
                  <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
                  <p>{emptyStateMessage}</p>
                </div>
              ) : null}

              {visibleItems.length ? (
                <div
                  className="library-grid"
                  style={{ '--library-columns': String(itemsPerRow) }}
                >
                  {visibleItems.map((item, index) => {
                    const itemKey = uniqueKey(item);
                    const itemLetter = deriveItemLetter(item);
                    let anchorRef;
                    if (shouldShowFilters && itemLetter && !letterAnchorTracker.has(itemLetter)) {
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
                    const shouldLoadImage = hasImageWindow && index >= imageWindow.start && index <= imageWindow.end;
                    return (
                      <button
                        key={itemKey}
                        ref={refHandler}
                        type="button"
                        onClick={() => handleSelectItem(item)}
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
            {shouldShowFilters ? (
              <div className="relative hidden lg:flex lg:w-14 lg:flex-col lg:border-l lg:border-border/60 lg:bg-surface/80 lg:px-1 lg:py-4">
                <div className="sticky top-24 flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleLetterChange(null)}
                    className={`w-8 rounded-full px-2 py-1 text-xs font-semibold transition ${
                      activeLetter === null ? 'bg-accent text-accent-foreground' : 'text-muted hover:text-foreground'
                    }`}
                  >
                    ★
                  </button>
                  {(letters ?? DEFAULT_LETTERS).map((letter) => (
                    <button
                      key={letter}
                      type="button"
                      onClick={() => handleLetterChange(letter)}
                      className={`w-8 rounded-full px-2 py-1 text-xs font-semibold transition ${
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
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedItem ? (
              <div className="flex flex-1 flex-col overflow-hidden">
                <section className="relative isolate overflow-hidden bg-background">
                  <div className="absolute inset-0">
                    {heroImage ? (
                      <img
                        src={heroImage}
                        alt=""
                        className="h-full w-full object-cover object-center"
                        loading="lazy"
                      />
                    ) : (
                      <div
                        className="h-full w-full bg-gradient-to-br from-border/30 via-background to-background"
                        style={heroFallbackStyle}
                      />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-b from-background/30 via-background/80 to-background" />
                    <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />
                  </div>
                  <div className="relative z-10 px-4 pt-4 pb-20 sm:px-6 md:px-10 lg:px-14">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={handleCloseDetails}
                        className="flex items-center gap-2 rounded-full bg-background/70 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-subtle transition hover:text-foreground"
                      >
                        <FontAwesomeIcon icon={faChevronLeft} />
                        Back
                      </button>
                      {/** Play button handled in header for detail view */}
                    </div>

                    <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] lg:items-start">
                      <div className="order-2 flex flex-col gap-4 lg:order-1 lg:sticky lg:top-24 lg:self-start">
                        <div className="overflow-hidden rounded-3xl border border-border/40 bg-border/30 shadow-2xl">
                          {posterImage ? (
                            <img
                              src={posterImage}
                              alt={selectedItem.title ?? 'Poster'}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-6 py-12 text-center text-xs font-semibold uppercase tracking-wide text-muted">
                              No artwork available
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="order-1 flex-1 space-y-8 text-foreground lg:order-2 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-4 lg:pb-16">
                        <div className="space-y-4">
                          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
                            {selectedItem.title ?? 'Untitled'}
                          </h1>
                          {directorNames.length ? (
                            <p className="text-sm font-semibold text-foreground/80">
                              Directed by {directorNames.join(', ')}
                            </p>
                          ) : null}
                          {ratingBadges.length ? (
                            <div className="flex flex-wrap items-center gap-2">
                              {ratingBadges.map((entry) => (
                                <span
                                  key={entry.key ?? entry.label}
                                  className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-background/80 px-3 py-1 text-xs font-semibold text-foreground/80 shadow-sm"
                                  title={entry.label ?? entry.value}
                                >
                                  {entry.icon ? (
                                    <img
                                      src={entry.icon.src}
                                      alt={entry.icon.alt}
                                      className="h-4 w-4 object-contain"
                                      loading="lazy"
                                    />
                                  ) : null}
                                  <span>{entry.value}</span>
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {selectedItem.tagline ? (
                            <p className="text-lg font-medium text-foreground/90">{selectedItem.tagline}</p>
                          ) : null}
                          {selectedItem.summary ? (
                            <p className="max-w-3xl text-sm leading-relaxed text-muted">{selectedItem.summary}</p>
                          ) : null}
                        </div>

                        {playError ? (
                          <div className="rounded-2xl border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                            {playError}
                          </div>
                        ) : null}

                        <div className="rounded-2xl border border-border/30 bg-background/60 shadow-lg backdrop-blur-sm">
                          <div className="flex items-center gap-2 border-b border-border/30 bg-background/40 px-4 py-3">
                            <button
                              type="button"
                              onClick={() => setDetailTab('metadata')}
                              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                                detailTab === 'metadata'
                                  ? 'bg-accent text-accent-foreground shadow'
                                  : 'bg-background/40 text-muted hover:text-foreground'
                              }`}
                            >
                              Metadata
                            </button>
                            <button
                              type="button"
                              onClick={() => setDetailTab('media')}
                              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                                detailTab === 'media'
                                  ? 'bg-accent text-accent-foreground shadow'
                                  : 'bg-background/40 text-muted hover:text-foreground'
                              }`}
                            >
                              Media
                            </button>
                          </div>
                          <div className="p-5">
                            {detailTab === 'metadata' ? metadataPanel : mediaPanel}
                          </div>
                        </div>

                        {selectedItem?.actors?.length ? (
                          <PeopleCarousel title="Cast" people={selectedItem.actors} fallbackRole="Cast" />
                        ) : null}

                        {crewPeople.length ? <PeopleCarousel title="Crew" people={crewPeople} fallbackRole="Crew" /> : null}

                        {relatedHubs.length ? (
                          <div className="space-y-8">
                            {relatedHubs.map((hub, index) => {
                              const hubKey = hub.hub_identifier ?? hub.key ?? `${hub.title ?? 'related'}-${index}`;
                              return <RelatedGroup key={hubKey} hub={hub} onSelect={handleSelectItem} />;
                            })}
                          </div>
                        ) : null}

                        {detailsState.loading ? (
                          <div className="flex items-center gap-2 text-sm text-muted">
                            <FontAwesomeIcon icon={faCircleNotch} spin />
                            Loading detailed metadata…
                          </div>
                        ) : null}

                        {detailsState.error ? (
                          <div className="rounded-2xl border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                            {detailsState.error}
                          </div>
                        ) : null}

                        {Object.entries(children).map(([key, list]) => (
                          <ChildList
                            key={key}
                            label={childGroupLabel(key)}
                            items={list}
                            onSelect={handleSelectItem}
                            onPlay={handlePlay}
                            playPending={playPending}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted">
                Select an item to view details.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
