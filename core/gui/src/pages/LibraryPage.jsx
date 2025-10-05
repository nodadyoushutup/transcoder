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
  faArrowsRotate,
  faTableColumns,
  faClosedCaptioning,
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
  fetchPlexSectionCollections,
  fetchPlexItemDetails,
  fetchPlexSearch,
  refreshPlexItemDetails,
  fetchPlexSectionSnapshot,
  buildPlexSectionSnapshot,
  playPlexItem,
  enqueueQueueItem,
  extractPlexItemSubtitles,
  fetchTranscoderTask,
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
const HOME_ROW_LIMIT = 24;
const COLLECTIONS_PAGE_LIMIT = 120;
const IMAGE_PREFETCH_RADIUS = 48;
const DEFAULT_CARD_HEIGHT = 320;
const DEFAULT_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const VIEW_GRID = 'grid';
const VIEW_DETAILS = 'details';
const SECTIONS_ONLY_MODE = false;
const SECTION_VIEW_RECOMMENDED = 'recommended';
const SECTION_VIEW_LIBRARY = 'library';
const SECTION_VIEW_COLLECTIONS = 'collections';
const SECTION_VIEW_OPTIONS = [
  { id: SECTION_VIEW_RECOMMENDED, label: 'Recommended' },
  { id: SECTION_VIEW_LIBRARY, label: 'Library' },
  { id: SECTION_VIEW_COLLECTIONS, label: 'Collections' },
];
const SNAPSHOT_PARALLELISM = 4;
const SNAPSHOT_POLL_INTERVAL_MS = 1000;

const RECOMMENDED_ROW_DEFINITIONS = [
  {
    id: 'recentlyAdded',
    title: 'Recently Added',
    params: { sort: 'added_desc' },
    meta: (item) =>
      formatDate(item?.added_at)
      ?? formatDate(item?.originally_available_at)
      ?? (item?.year ? String(item.year) : ' '),
  },
  {
    id: 'newest',
    title: 'Recently Released',
    params: { sort: 'released_desc' },
    meta: (item) =>
      formatDate(item?.originally_available_at)
      ?? formatDate(item?.added_at)
      ?? (item?.year ? String(item.year) : ' '),
  },
];

function normalizeSectionViewValue(value, fallback = SECTION_VIEW_LIBRARY) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ([SECTION_VIEW_RECOMMENDED, SECTION_VIEW_LIBRARY, SECTION_VIEW_COLLECTIONS].includes(candidate)) {
    return candidate;
  }
  return [SECTION_VIEW_RECOMMENDED, SECTION_VIEW_LIBRARY, SECTION_VIEW_COLLECTIONS].includes(fallback)
    ? fallback
    : SECTION_VIEW_LIBRARY;
}

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

function normalizeSnapshotPayload(payload = {}) {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const totalCandidate = Number(payload.total);
  const total = Number.isFinite(totalCandidate) ? totalCandidate : null;
  const cachedCandidate = Number(payload.cached);
  const cached = Number.isFinite(cachedCandidate) ? cachedCandidate : rawItems.length;
  const completed = Boolean(
    payload.completed
      || (Number.isFinite(total) && total !== null && cached >= total),
  );
  return {
    section_id: payload.section_id ?? null,
    cached,
    total,
    completed,
    updated_at: payload.updated_at ?? null,
    items: rawItems,
    request_signature: payload.request_signature ?? null,
    server: payload.server ?? null,
    section: payload.section ?? null,
    sort_options: Array.isArray(payload.sort_options) ? payload.sort_options : null,
  };
}

function mergeSnapshotSummary(existing, summary) {
  if (!summary) {
    return existing || null;
  }
  const normalized = normalizeSnapshotPayload(summary);
  if (!existing) {
    return normalized;
  }
  const nextItems = normalized.items.length >= (existing.items?.length ?? 0)
    ? normalized.items
    : existing.items ?? [];
  return {
    ...existing,
    section_id: normalized.section_id ?? existing.section_id,
    cached: Math.max(existing.cached ?? 0, normalized.cached ?? 0),
    total: normalized.total ?? existing.total ?? null,
    completed: Boolean(existing.completed || normalized.completed),
    updated_at: normalized.updated_at ?? existing.updated_at ?? null,
    items: nextItems,
    request_signature: normalized.request_signature ?? existing.request_signature ?? null,
    server: normalized.server ?? existing.server ?? null,
    section: normalized.section ?? existing.section ?? null,
    sort_options: normalized.sort_options ?? existing.sort_options ?? null,
  };
}

function buildItemsPayloadFromSnapshot(snapshot, sectionPageLimit, previousPayload = null) {
  if (!snapshot) {
    return previousPayload;
  }
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const fallbackLimit = Number.isFinite(sectionPageLimit) ? sectionPageLimit : DEFAULT_SECTION_PAGE_LIMIT;
  const previousLimit = previousPayload?.pagination?.limit;
  const limit = Math.max(1, previousLimit ?? fallbackLimit);
  const total = Number.isFinite(snapshot.total)
    ? Number(snapshot.total)
    : previousPayload?.pagination?.total ?? items.length;
  const loaded = items.length;
  const hasMore = !snapshot.completed && (total === null || loaded < total);
  return {
    ...(previousPayload ?? {}),
    server: snapshot.server ?? previousPayload?.server ?? null,
    section: snapshot.section ?? previousPayload?.section ?? null,
    items,
    pagination: {
      offset: 0,
      limit,
      total,
      size: loaded,
      loaded,
      has_more: hasMore,
    },
    sort_options: snapshot.sort_options ?? previousPayload?.sort_options ?? [],
    snapshot_source: true,
  };
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

function HomeRow({ title, items, onSelect, metaFormatter, actions = null }) {
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

    const resolvedUrl = plexImageUrl(posterPath, {
      width: 360,
      height: 540,
      upscale: 1,
      variant: 'grid',
    });
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
  const [sectionView, setSectionView] = useState(SECTION_VIEW_LIBRARY);
  const [defaultSectionView, setDefaultSectionView] = useState(SECTION_VIEW_LIBRARY);
  const [navActive, setNavActive] = useState('library');
  const [sections, setSections] = useState([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [sectionsError, setSectionsError] = useState(null);
  const [sectionPageLimit, setSectionPageLimit] = useState(DEFAULT_SECTION_PAGE_LIMIT);
  const [serverInfo, setServerInfo] = useState(null);
  const [letters, setLetters] = useState(DEFAULT_LETTERS);
  const visibleLetters = useMemo(() => {
    const source = Array.isArray(letters) && letters.length ? letters : DEFAULT_LETTERS;
    return source.filter((letter) => letter && letter !== '0-9');
  }, [letters]);
  const [availableSorts, setAvailableSorts] = useState([]);
  const [activeSectionId, setActiveSectionId] = useState(null);
  const [sectionSnapshot, setSectionSnapshot] = useState({
    loading: false,
    building: false,
    data: null,
    error: null,
    taskId: null,
  });

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
  const hadItemsBeforeRef = useRef(false);
  const hadItemsBefore = hadItemsBeforeRef.current;
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState(null);
  const [sectionRefreshPending, setSectionRefreshPending] = useState(false);
  const [sectionRefreshError, setSectionRefreshError] = useState(null);
  const [imageWindow, setImageWindow] = useState({ start: 0, end: -1 });

  const [viewMode, setViewMode] = useState(VIEW_GRID);
  const [itemsPerRow, setItemsPerRow] = useState(8);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsState, setDetailsState] = useState({ loading: false, error: null, data: null });
  const [detailRefreshPending, setDetailRefreshPending] = useState(false);
  const [detailRefreshError, setDetailRefreshError] = useState(null);
  const [playPending, setPlayPending] = useState(false);
  const [playError, setPlayError] = useState(null);
  const [playPhase, setPlayPhase] = useState('idle');
  const [queuePending, setQueuePending] = useState(false);
  const [queueNotice, setQueueNotice] = useState({ type: null, message: null });
  const [subtitleExtractPending, setSubtitleExtractPending] = useState(false);
  const [subtitleExtractNotice, setSubtitleExtractNotice] = useState(null);
  const [detailTab, setDetailTab] = useState('metadata');
  const [homeSections, setHomeSections] = useState([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState(null);
  const [homeLoadedSignature, setHomeLoadedSignature] = useState(null);
  const [recommendedState, setRecommendedState] = useState({
    sectionId: null,
    rows: [],
    loading: false,
    error: null,
  });
  const [collectionsState, setCollectionsState] = useState({
    sectionId: null,
    section: null,
    items: [],
    pagination: null,
    loading: false,
    error: null,
  });

  const scrollContainerRef = useRef(null);
  const prefetchStateRef = useRef({ token: 0 });
  const letterNodeMap = useRef(new Map());
  const rowHeightRef = useRef(DEFAULT_CARD_HEIGHT);
  const letterScrollPendingRef = useRef(null);
  const scrollFrameRef = useRef(null);
  const initialSectionViewResolvedRef = useRef(false);
  const recommendedCacheRef = useRef(new Map());
  const collectionsCacheRef = useRef(new Map());
  const snapshotBuildRef = useRef(false);
  const sectionRefreshTokenRef = useRef(null);
  const loadingTokenRef = useRef(null);
  const playTimerRef = useRef(null);

  const beginSectionTransition = useCallback(
    (nextSectionId, { preserveView = false } = {}) => {
      if (nextSectionId === null || nextSectionId === undefined) {
        return false;
      }
      setItemsLoading(true);
      setItemsError(null);
      setSectionSnapshot((state) => ({
        ...state,
        loading: true,
        error: null,
      }));
      if (!preserveView) {
        setSelectedItem(null);
        setViewMode(VIEW_GRID);
      }
      setPlayError(null);
      setQueueNotice({ type: null, message: null });
      return true;
    },
    [setQueueNotice, setPlayError],
  );

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

  const clearPlayResetTimer = useCallback(() => {
    if (playTimerRef.current) {
      window.clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearPlayResetTimer();
  }, [clearPlayResetTimer]);

  const isHomeView = libraryView === 'home';
  const isLibraryViewActive = !isHomeView && sectionView === SECTION_VIEW_LIBRARY;
  const isRecommendedViewActive = !isHomeView && sectionView === SECTION_VIEW_RECOMMENDED;
  const isCollectionsViewActive = !isHomeView && sectionView === SECTION_VIEW_COLLECTIONS;

  const snapshotMergeEnabled = useMemo(() => {
    if (!isLibraryViewActive) {
      return false;
    }
    const hasSearch = Boolean(filters.search?.trim());
    const watchValue = filters.watch ?? 'all';
    const hasGenre = Boolean(filters.genre);
    const hasCollection = Boolean(filters.collection);
    const hasYear = Boolean(filters.year);
    return !hasSearch && (watchValue === 'all' || !watchValue)
      && !hasGenre
      && !hasCollection
      && !hasYear;
  }, [
    filters.collection,
    filters.genre,
    filters.search,
    filters.watch,
    filters.year,
    isLibraryViewActive,
  ]);

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

      const snapshotPreference =
        overrides.snapshot === false
          ? false
          : overrides.snapshot === true
            ? true
            : snapshotMergeEnabled;

      if (snapshotPreference) {
        params.snapshot = 1;
      }

      return params;
    },
    [filters, sectionPageLimit, snapshotMergeEnabled],
  );

  const startSnapshotBuild = useCallback(
    async ({ reason = 'manual' } = {}) => {
      if (!activeSectionId || snapshotBuildRef.current) {
        return;
      }
      snapshotBuildRef.current = true;
      setSectionSnapshot((state) => ({
        ...state,
        building: true,
        error: null,
      }));
      try {
        const resolvedReason = reason ?? 'manual';
        const cachedCount = sectionSnapshot.data?.cached ?? 0;
        const shouldReset = (() => {
          if (resolvedReason === 'manual' || resolvedReason === 'refresh') {
            return true;
          }
          if (resolvedReason === 'auto' && cachedCount === 0) {
            return true;
          }
          return false;
        })();
        const result = await buildPlexSectionSnapshot(activeSectionId, {
          sort: filters.sort,
          page_size: sectionPageLimit,
          reason: resolvedReason,
          parallelism: SNAPSHOT_PARALLELISM,
          async: true,
          reset: shouldReset,
        });
        if (result && typeof result === 'object' && 'status' in result && result.status === 'queued') {
          setSectionSnapshot((state) => ({
            ...state,
            loading: false,
            building: true,
            error: null,
            taskId: result.task_id ?? state.taskId ?? null,
          }));
        } else if (result) {
          const normalized = normalizeSnapshotPayload(result);
          setSectionSnapshot({
            loading: false,
            building: false,
            data: normalized,
            error: null,
            taskId: null,
          });
          setItemsPayload((prev) => buildItemsPayloadFromSnapshot(normalized, sectionPageLimit, prev));
          setAvailableSorts((prev) => (
            normalized.sort_options?.length ? normalized.sort_options : prev
          ));
        } else {
          setSectionSnapshot((state) => ({
            ...state,
            building: false,
          }));
        }
      } catch (error) {
        setSectionSnapshot((state) => ({
          ...state,
          building: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to cache section snapshot.',
        }));
      } finally {
        snapshotBuildRef.current = false;
      }
    },
    [activeSectionId, filters.sort, sectionPageLimit, sectionSnapshot.data?.cached],
  );

  useEffect(() => {
    if (!activeSectionId) {
      setSectionSnapshot({ loading: false, building: false, data: null, error: null, taskId: null });
      return;
    }
    let cancelled = false;
    setSectionSnapshot((state) => ({
      ...state,
      loading: true,
      error: null,
    }));
    (async () => {
      try {
        const snapshot = await fetchPlexSectionSnapshot(activeSectionId, { include_items: 1 });
        if (cancelled) {
          return;
        }
        const normalized = normalizeSnapshotPayload(snapshot);
        setSectionSnapshot((state) => ({
          ...state,
          loading: false,
          building: !normalized.completed,
          data: normalized,
          error: null,
        }));
        setItemsPayload((prev) => buildItemsPayloadFromSnapshot(normalized, sectionPageLimit, prev));
        setAvailableSorts((prev) => (
          normalized.sort_options?.length ? normalized.sort_options : prev
        ));
        if (!normalized.completed && !snapshotBuildRef.current) {
          const nextReason = normalized.cached > 0 ? 'resume' : 'auto';
          void startSnapshotBuild({ reason: nextReason });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Failed to load snapshot.';
        setSectionSnapshot((state) => ({
          ...state,
          loading: false,
          building: false,
          error: message,
          data: state.data ?? null,
        }));
        setItemsError((prev) => prev ?? message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSectionId, sectionPageLimit, setAvailableSorts, startSnapshotBuild]);

  useEffect(() => {
    if (!activeSectionId) {
      return undefined;
    }
    const snapshotIncomplete = Boolean(sectionSnapshot.data) && !sectionSnapshot.data.completed;
    const shouldPoll = sectionSnapshot.building || snapshotIncomplete;
    if (!shouldPoll) {
      return undefined;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const snapshot = await fetchPlexSectionSnapshot(activeSectionId, { include_items: 1 });
        if (cancelled) {
          return;
        }
        const normalized = normalizeSnapshotPayload(snapshot);
        let mergedSnapshot = normalized;
        let stillBuilding = true;
        setSectionSnapshot((state) => {
          mergedSnapshot = mergeSnapshotSummary(state.data, normalized);
          const nextBuilding = state.building && !normalized.completed;
          stillBuilding = nextBuilding;
          return {
            ...state,
            loading: false,
            building: nextBuilding,
            data: mergedSnapshot,
            error: null,
          };
        });
        setItemsPayload((prev) => buildItemsPayloadFromSnapshot(mergedSnapshot, sectionPageLimit, prev));
        setAvailableSorts((prev) => (
          mergedSnapshot?.sort_options?.length ? mergedSnapshot.sort_options : prev
        ));
        if (!stillBuilding) {
          if (loadingTokenRef.current === prefetchStateRef.current.token) {
            loadingTokenRef.current = null;
            setItemsLoading(false);
          }
          if (sectionRefreshTokenRef.current !== null) {
            sectionRefreshTokenRef.current = null;
            setSectionRefreshPending(false);
          }
        }
        if (mergedSnapshot?.completed) {
          cancelled = true;
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load snapshot.';
          setSectionSnapshot((state) => ({
            ...state,
            loading: false,
            building: false,
            error: state.error ?? message,
          }));
          setItemsError((prev) => prev ?? message);
          const matchesActiveLoad = loadingTokenRef.current === prefetchStateRef.current.token;
          loadingTokenRef.current = null;
          sectionRefreshTokenRef.current = null;
          setSectionRefreshPending(false);
          if (matchesActiveLoad) {
            setItemsLoading(false);
          }
        }
      }
    };

    poll();
    const timer = window.setInterval(poll, SNAPSHOT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeSectionId,
    fetchPlexSectionSnapshot,
    sectionPageLimit,
    sectionSnapshot.building,
    sectionSnapshot.data?.completed,
  ]);

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
        const librarySettings = data?.library_settings ?? {};
        const configuredDefaultView = normalizeSectionViewValue(
          librarySettings?.default_section_view,
          SECTION_VIEW_LIBRARY,
        );
        setDefaultSectionView(configuredDefaultView);
        if (!initialSectionViewResolvedRef.current) {
          setSectionView(configuredDefaultView);
          initialSectionViewResolvedRef.current = true;
        }
        const resolvedLimit = clampSectionPageLimit(
          data?.library_settings?.section_page_size ?? DEFAULT_SECTION_PAGE_LIMIT,
          DEFAULT_SECTION_PAGE_LIMIT,
        );
        setSectionPageLimit(resolvedLimit);
        if (!activeSectionId && visibleSections.length) {
          const firstSectionId = normalizeKey(visibleSections[0]);
          if (beginSectionTransition(firstSectionId)) {
            setActiveSectionId(firstSectionId);
          }
        } else if (activeSectionId && visibleSections.every((section) => normalizeKey(section) !== activeSectionId)) {
          const fallbackSection = visibleSections.length ? normalizeKey(visibleSections[0]) : null;
          if (beginSectionTransition(fallbackSection)) {
            setActiveSectionId(fallbackSection);
          } else {
            setActiveSectionId(null);
          }
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
    if (!isLibraryViewActive) {
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
  }, [SECTIONS_ONLY_MODE, isLibraryViewActive, searchInput]);

  useEffect(() => {
    const query = globalSearchInput.trim();

    if (libraryView !== 'browse') {
      if (query) {
        if (sectionView !== SECTION_VIEW_LIBRARY) {
          setSectionView(SECTION_VIEW_LIBRARY);
        }
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

    if (sectionView !== SECTION_VIEW_LIBRARY) {
      setSectionView(SECTION_VIEW_LIBRARY);
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
  }, [globalSearchInput, libraryView, sectionView]);

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
          fetchPlexSectionItems(key, {
            sort: 'released_desc',
            limit: HOME_ROW_LIMIT,
            snapshot: false,
          }),
          fetchPlexSectionItems(key, {
            sort: 'added_desc',
            limit: HOME_ROW_LIMIT,
            snapshot: false,
          }),
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
    setSectionRefreshError(null);
    setSectionRefreshPending(false);
  }, [activeSectionId, libraryView, sectionView]);

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return undefined;
    }
    if (libraryView !== 'browse') {
      return undefined;
    }
    if (!isLibraryViewActive) {
      setItemsLoading(false);
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
    setSectionSnapshot((state) => ({
      ...state,
      loading: true,
    }));
    if (!hadItemsBefore && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0 });
    }

    (async () => {
      let shouldContinueLoading = true;
      try {
        const snapshotResponse = await fetchPlexSectionSnapshot(activeSectionId, { include_items: 1 });
        if (cancelled || prefetchStateRef.current.token !== currentToken) {
          return;
        }
        const normalized = normalizeSnapshotPayload(snapshotResponse);
        let stillBuilding = true;
        setSectionSnapshot((state) => {
          const merged = mergeSnapshotSummary(state.data, normalized);
          const nextBuilding = state.building || !normalized.completed;
          stillBuilding = nextBuilding;
          return {
            ...state,
            loading: false,
            building: nextBuilding,
            data: merged,
            error: null,
            taskId: state.taskId ?? null,
          };
        });
        setItemsPayload((prev) => buildItemsPayloadFromSnapshot(normalized, sectionPageLimit, prev));
        setItemsError(null);
        shouldContinueLoading = stillBuilding;
        setItemsLoading(stillBuilding);
        if (stillBuilding) {
          loadingTokenRef.current = currentToken;
        } else if (loadingTokenRef.current === currentToken) {
          loadingTokenRef.current = null;
        }
        if (!normalized.completed && !snapshotBuildRef.current) {
          const nextReason = normalized.cached > 0 ? 'resume' : 'auto';
          void startSnapshotBuild({ reason: nextReason });
        }
      } catch (error) {
        if (cancelled || prefetchStateRef.current.token !== currentToken) {
          return;
        }
        shouldContinueLoading = false;
        const message = error instanceof Error ? error.message : 'Failed to load snapshot';
        setItemsError(message);
        setSectionSnapshot((state) => ({
          ...state,
          loading: false,
          building: false,
          error: state.error ?? message,
        }));
        setItemsLoading(false);
        if (loadingTokenRef.current === currentToken) {
          loadingTokenRef.current = null;
        }
        try {
          const fallback = await fetchPlexSectionItems(
            activeSectionId,
            buildItemParams({ offset: 0, snapshot: 1 }),
          );
          if (cancelled || prefetchStateRef.current.token !== currentToken) {
            return;
          }
          if (fallback?.snapshot) {
            setSectionSnapshot((state) => ({
              ...state,
              loading: false,
              data: mergeSnapshotSummary(state.data, fallback.snapshot),
              error: state.error,
              taskId: state.taskId ?? null,
            }));
          }
          const nextItems = Array.isArray(fallback?.items) ? fallback.items : [];
          const nextPagination = fallback?.pagination ?? {};
          setItemsPayload({
            ...fallback,
            items: nextItems,
            pagination: {
              ...nextPagination,
              loaded: nextItems.length,
              limit: nextPagination.limit ?? sectionPageLimit,
              total: typeof nextPagination.total === 'number' ? nextPagination.total : nextItems.length,
              size: nextPagination.size ?? nextItems.length,
            },
          });
          setAvailableSorts((prev) => (fallback?.sort_options?.length ? fallback.sort_options : prev));
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : null;
          if (fallbackMessage) {
            setItemsError((prev) => prev ?? fallbackMessage);
          }
        }
      } finally {
        if (!cancelled && prefetchStateRef.current.token === currentToken) {
          if (!shouldContinueLoading) {
            setItemsLoading(false);
            if (loadingTokenRef.current === currentToken) {
              loadingTokenRef.current = null;
            }
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    SECTIONS_ONLY_MODE,
    activeSectionId,
    buildItemParams,
    fetchPlexSectionItems,
    fetchPlexSectionSnapshot,
    libraryView,
    isLibraryViewActive,
    sectionPageLimit,
    startSnapshotBuild,
    hadItemsBefore,
  ]);

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
    if (!isRecommendedViewActive) {
      return undefined;
    }
    if (!activeSectionId) {
      setRecommendedState({ sectionId: null, rows: [], loading: false, error: null });
      return undefined;
    }

    const cacheKey = String(activeSectionId);
    const cached = recommendedCacheRef.current.get(cacheKey);
    if (cached) {
      setRecommendedState({
        sectionId: activeSectionId,
        rows: Array.isArray(cached.rows) ? cached.rows : [],
        loading: false,
        error: cached.error ?? null,
      });
      return undefined;
    }

    let cancelled = false;
    setRecommendedState((state) => ({
      sectionId: activeSectionId,
      rows: state.sectionId === activeSectionId ? state.rows : [],
      loading: true,
      error: null,
    }));

    (async () => {
      const tasks = await Promise.all(
        RECOMMENDED_ROW_DEFINITIONS.map(async (definition) => {
          try {
            const data = await fetchPlexSectionItems(activeSectionId, {
              ...definition.params,
              limit: HOME_ROW_LIMIT,
              snapshot: false,
            });
            return {
              definition,
              items: Array.isArray(data?.items) ? data.items : [],
              error: null,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Failed to load recommended items';
            return {
              definition,
              items: [],
              error: message,
            };
          }
        }),
      );

      if (cancelled) {
        return;
      }

      const rows = tasks.map(({ definition, items }) => ({
        id: definition.id,
        title: definition.title,
        meta: definition.meta,
        params: definition.params,
        items,
      }));
      const errorMessages = tasks
        .filter((task) => task.error)
        .map((task) => `${task.definition.title}: ${task.error}`);
      const combinedError = errorMessages.length ? errorMessages.join(' · ') : null;

      const payload = {
        rows,
        error: combinedError,
      };
      recommendedCacheRef.current.set(cacheKey, payload);
      setRecommendedState({
        sectionId: activeSectionId,
        rows,
        loading: false,
        error: combinedError,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSectionId, isRecommendedViewActive]);

  useEffect(() => {
    if (!isCollectionsViewActive) {
      return undefined;
    }
    if (!activeSectionId) {
      setCollectionsState((state) => ({
        ...state,
        sectionId: null,
        section: null,
        items: [],
        pagination: null,
        loading: false,
        error: null,
      }));
      return undefined;
    }

    const cacheKey = String(activeSectionId);
    const cached = collectionsCacheRef.current.get(cacheKey);
    if (cached) {
      setCollectionsState({
        sectionId: activeSectionId,
        section: cached.section ?? null,
        items: Array.isArray(cached.items) ? cached.items : [],
        pagination: cached.pagination ?? null,
        loading: false,
        error: cached.error ?? null,
      });
      return undefined;
    }

    let cancelled = false;
    setCollectionsState((state) => ({
      sectionId: activeSectionId,
      section: state.sectionId === activeSectionId ? state.section : null,
      items: state.sectionId === activeSectionId ? state.items : [],
      pagination: state.sectionId === activeSectionId ? state.pagination : null,
      loading: true,
      error: null,
    }));

    (async () => {
      try {
        const data = await fetchPlexSectionCollections(activeSectionId, {
          offset: 0,
          limit: COLLECTIONS_PAGE_LIMIT,
        });
        if (cancelled) {
          return;
        }
        const payload = {
          sectionId: activeSectionId,
          section: data?.section ?? null,
          items: Array.isArray(data?.items) ? data.items : [],
          pagination: data?.pagination ?? null,
          loading: false,
          error: null,
        };
        collectionsCacheRef.current.set(cacheKey, payload);
        setCollectionsState(payload);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Failed to load collections';
        setCollectionsState({
          sectionId: activeSectionId,
          section: null,
          items: [],
          pagination: null,
          loading: false,
          error: message,
        });
        collectionsCacheRef.current.set(cacheKey, {
          section: null,
          items: [],
          pagination: null,
          error: message,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSectionId, isCollectionsViewActive]);

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
          beginSectionTransition(targetSection, { preserveView: true });
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

  useEffect(() => {
    setDetailRefreshError(null);
    setDetailRefreshPending(false);
  }, [selectedItem?.rating_key]);

  useEffect(() => {
    hadItemsBeforeRef.current = Boolean(itemsPayload?.items?.length);
  }, [itemsPayload?.items?.length]);
  const items = itemsPayload?.items ?? [];
  const globalSearchItems = globalSearchData?.items ?? [];
  const isGlobalSearching =
    !isHomeView && sectionView === SECTION_VIEW_LIBRARY && Boolean(globalSearchInput.trim());
  const visibleItems = isLibraryViewActive ? (isGlobalSearching ? globalSearchItems : items) : [];
  const visibleItemCount = visibleItems.length;
  const hasImageWindow = imageWindow.end >= imageWindow.start;
  const totalItemCount = isLibraryViewActive
    ? isGlobalSearching
      ? globalSearchData?.pagination?.total ?? globalSearchItems.length
      : itemsPayload?.pagination?.total ?? items.length
    : 0;
  const currentLoading = isLibraryViewActive
    ? isGlobalSearching
      ? globalSearchLoading
      : itemsLoading
    : false;
  const overlayActive = currentLoading && visibleItemCount === 0;
  const currentError = isLibraryViewActive
    ? isGlobalSearching
      ? globalSearchError
      : itemsError
    : null;
  const loadedItemCount = isLibraryViewActive
    ? isGlobalSearching
      ? visibleItemCount
      : itemsPayload?.pagination?.loaded ?? visibleItemCount
    : 0;
  const recommendedRows = recommendedState.sectionId === activeSectionId ? recommendedState.rows : [];
  const recommendedLoading = recommendedState.sectionId === activeSectionId ? recommendedState.loading : false;
  const recommendedError = recommendedState.sectionId === activeSectionId ? recommendedState.error : null;
  const activeCollections = collectionsState.sectionId === activeSectionId ? collectionsState : { items: [] };
  const collectionsLoading = collectionsState.sectionId === activeSectionId ? collectionsState.loading : false;
  const collectionsError = collectionsState.sectionId === activeSectionId ? collectionsState.error : null;
  const recommendedRowCount = Array.isArray(recommendedRows) ? recommendedRows.length : 0;
  const recommendedItemCount = Array.isArray(recommendedRows)
    ? recommendedRows.reduce((sum, row) => sum + ((row?.items?.length ?? 0)), 0)
    : 0;
  const collectionsCount = Array.isArray(activeCollections.items) ? activeCollections.items.length : 0;
  const countLabel = (() => {
    if (isHomeView) {
      const libraryCount = sections.length;
      if (!libraryCount) {
        return 'No libraries available';
      }
      const suffix = libraryCount === 1 ? 'library' : 'libraries';
      return `${libraryCount.toLocaleString()} ${suffix}`;
    }
    if (isRecommendedViewActive) {
      if (!recommendedRowCount) {
        return recommendedLoading ? 'Recommended • Loading…' : 'Recommended • No rows';
      }
      const rowLabel = recommendedRowCount === 1 ? 'row' : 'rows';
      if (recommendedItemCount > 0) {
        const itemLabel = recommendedItemCount === 1 ? 'item' : 'items';
        return `Recommended • ${recommendedRowCount.toLocaleString()} ${rowLabel} · ${recommendedItemCount.toLocaleString()} ${itemLabel}`;
      }
      return `Recommended • ${recommendedRowCount.toLocaleString()} ${rowLabel}`;
    }
    if (isCollectionsViewActive) {
      if (!collectionsCount && collectionsLoading) {
        return 'Collections • Loading…';
      }
      const suffix = collectionsCount === 1 ? 'collection' : 'collections';
      return `Collections • ${collectionsCount.toLocaleString()} ${suffix}`;
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
  const libraryStillLoading = isLibraryViewActive
    ? isGlobalSearching
      ? globalSearchLoading
      : itemsLoading
    : false;
  const headerLoading = isHomeView
    ? homeLoading
    : isRecommendedViewActive
      ? recommendedLoading
      : isCollectionsViewActive
        ? collectionsLoading
        : libraryStillLoading;
  const sectionViewToggle = !isHomeView ? (
    <div className="flex items-center gap-1 rounded-full border border-border/70 bg-background/80 p-1 text-xs">
      {SECTION_VIEW_OPTIONS.map((option) => {
        const active = sectionView === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => handleSectionViewChange(option.id)}
            className={`rounded-full px-3 py-1 font-semibold transition ${
              active ? 'bg-accent text-accent-foreground shadow' : 'text-muted hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  ) : null;
  const normalizedSort = String(filters.sort ?? '').toLowerCase();
  const isTitleSortActive =
    normalizedSort.startsWith('title')
    || normalizedSort.includes('title:')
    || normalizedSort.includes('title_');
  const shouldShowAlphabetBar = isLibraryViewActive && !isGlobalSearching && isTitleSortActive;
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

  const updateActiveLetterFromScroll = useCallback(() => {
    if (!shouldShowAlphabetBar || overlayActive) {
      return;
    }
    if (letterScrollPendingRef.current) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const entries = Array.from(letterNodeMap.current.entries());
    if (!entries.length) {
      setActiveLetter((prev) => (prev === null ? prev : null));
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const referenceOffset = container.scrollTop + 48;
    let nextLetter = null;
    const sortedEntries = entries
      .map(([letter, node]) => {
        if (!node) {
          return null;
        }
        const nodeRect = node.getBoundingClientRect();
        const offsetTop = nodeRect.top - containerRect.top + container.scrollTop;
        return Number.isFinite(offsetTop) ? { letter, offsetTop } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.offsetTop - b.offsetTop);

    for (const { letter, offsetTop } of sortedEntries) {
      if (offsetTop <= referenceOffset) {
        nextLetter = letter;
      } else {
        break;
      }
    }

    setActiveLetter((prev) => {
      const normalizedNext = nextLetter === '0-9' ? '0-9' : nextLetter ?? null;
      return prev === normalizedNext ? prev : normalizedNext;
    });
  }, [overlayActive, shouldShowAlphabetBar]);

  useEffect(() => {
    if (viewMode !== VIEW_GRID || visibleItemCount === 0) {
      if (scrollFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      setImageWindow((prev) => (prev.start === 0 && prev.end === -1 ? prev : { start: 0, end: -1 }));
      setActiveLetter((prev) => (prev === null ? prev : null));
      return undefined;
    }

    const container = scrollContainerRef.current;
    if (!container || typeof window === 'undefined') {
      updateImageWindow();
      updateActiveLetterFromScroll();
      return undefined;
    }

    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        updateImageWindow();
        updateActiveLetterFromScroll();
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    updateImageWindow();
    updateActiveLetterFromScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [updateActiveLetterFromScroll, updateImageWindow, viewMode, visibleItemCount]);

  useEffect(() => {
    if (!shouldShowAlphabetBar) {
      letterScrollPendingRef.current = null;
      return;
    }
    const pendingLetter = letterScrollPendingRef.current;
    if (!pendingLetter) {
      return;
    }
    if (pendingLetter !== activeLetter) {
      return;
    }
    if (scrollToLetter(pendingLetter)) {
      letterScrollPendingRef.current = null;
    }
  }, [activeLetter, scrollToLetter, shouldShowAlphabetBar]);

  useEffect(() => {
    if (!shouldShowAlphabetBar) {
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
  }, [scrollToLetter, shouldShowAlphabetBar, visibleItemCount]);

  useEffect(() => {
    if (shouldShowAlphabetBar) {
      return;
    }
    letterScrollPendingRef.current = null;
    setActiveLetter((prev) => (prev === null ? prev : null));
  }, [shouldShowAlphabetBar]);

  useEffect(() => {
    if (!shouldShowAlphabetBar) {
      return;
    }
    if (letterScrollPendingRef.current) {
      return;
    }
    updateActiveLetterFromScroll();
  }, [
    shouldShowAlphabetBar,
    updateActiveLetterFromScroll,
    visibleItemCount,
    itemsPerRow,
    overlayActive,
  ]);

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

  useEffect(() => {
    snapshotBuildRef.current = false;
  }, [activeSectionId]);

  const handleBrowseSection = useCallback(
    (sectionId) => {
      if (sectionId === null || sectionId === undefined) {
        return;
      }
      beginSectionTransition(sectionId);
      setActiveSectionId(sectionId);
      setLibraryView('browse');
      const nextView = normalizeSectionViewValue(defaultSectionView, SECTION_VIEW_LIBRARY);
      setSectionView(nextView);
      setGlobalSearchInput('');
      setSearchInput('');
    },
    [beginSectionTransition, defaultSectionView],
  );

  const handleGoHome = useCallback(() => {
    setLibraryView('home');
    setGlobalSearchInput('');
    setSearchInput('');
    setSelectedItem(null);
    setViewMode(VIEW_GRID);
    setPlayError(null);
    setQueueNotice({ type: null, message: null });
    setSectionView(normalizeSectionViewValue(defaultSectionView, SECTION_VIEW_LIBRARY));
  }, [defaultSectionView, setQueueNotice, setPlayError]);

  const handleHomeSelect = useCallback(
    (item) => {
      if (!item) {
        return;
      }
      const targetSectionId = item.library_section_id ?? item.librarySectionId ?? activeSectionId;
      if (targetSectionId !== null && targetSectionId !== undefined) {
        beginSectionTransition(targetSectionId, { preserveView: true });
        setActiveSectionId(targetSectionId);
      }
      setLibraryView('browse');
      setSectionView(normalizeSectionViewValue(defaultSectionView, SECTION_VIEW_LIBRARY));
      handleSelectItem(item);
    },
    [activeSectionId, beginSectionTransition, defaultSectionView, handleSelectItem],
  );

  const handleSectionViewChange = useCallback(
    (nextView) => {
      const normalized = normalizeSectionViewValue(nextView, SECTION_VIEW_LIBRARY);
      setSectionView((prev) => (prev === normalized ? prev : normalized));
      setViewMode(VIEW_GRID);
      setSelectedItem(null);
      setPlayError(null);
      setQueueNotice({ type: null, message: null });
      if (normalized !== SECTION_VIEW_LIBRARY) {
        setGlobalSearchInput('');
        setSearchInput('');
        setFilters((prev) => ({
          ...prev,
          search: '',
        }));
      }
    },
    [
      setQueueNotice,
      setPlayError,
      setFilters,
      setViewMode,
      setSelectedItem,
      setGlobalSearchInput,
      setSearchInput,
    ],
  );

  useEffect(() => {
    setSubtitleExtractPending(false);
    setSubtitleExtractNotice(null);
  }, [selectedItem?.rating_key]);

  const pollTranscoderTask = useCallback(async (taskId, { interval = 1000, attempts = 180 } = {}) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const status = await fetchTranscoderTask(taskId);
        if (status?.error) {
          throw new Error(status.error);
        }
        if (status?.ready && status?.successful) {
          return status.result;
        }
        if (status?.ready && !status?.successful) {
          throw new Error(status?.result || 'Task failed.');
        }
      } catch (error) {
        if (error instanceof Error && attempt === attempts - 1) {
          throw error;
        }
        if (error instanceof Error && !/not found/i.test(error.message)) {
          throw error;
        }
      }
      // wait before next poll
      await new Promise((resolve) => {
        setTimeout(resolve, interval);
      });
    }
    throw new Error('Timed out waiting for subtitle task.');
  }, []);

  const handleRecommendedRowNavigate = useCallback(
    (row) => {
      const definition = row ?? null;
      handleSectionViewChange(SECTION_VIEW_LIBRARY);
      setLibraryView('browse');
      setGlobalSearchInput('');
      setSearchInput('');
      setActiveLetter(null);
      letterScrollPendingRef.current = null;
      setFilters((prev) => ({
        ...prev,
        sort: definition?.params?.sort ?? DEFAULT_SORT,
        watch: definition?.params?.watch ?? 'all',
        genre: null,
        collection: null,
        year: null,
        search: '',
      }));
    },
    [handleSectionViewChange, setFilters, setLibraryView, setGlobalSearchInput, setSearchInput],
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
      if (!shouldShowAlphabetBar) {
        return;
      }
      if (overlayActive) {
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
    [activeLetter, overlayActive, scrollToLetter, shouldShowAlphabetBar],
  );

  const letterAnchorTracker = new Set();

  const handleRefreshSectionItems = useCallback(() => {
    if (!activeSectionId || !isLibraryViewActive) {
      return;
    }
    prefetchStateRef.current.token += 1;
    const currentToken = prefetchStateRef.current.token;
    setSectionRefreshPending(true);
    setSectionRefreshError(null);
    setItemsError(null);
    setItemsLoading(true);
    sectionRefreshTokenRef.current = currentToken;

    void startSnapshotBuild({ reason: 'refresh' });

    (async () => {
      let shouldContinueLoading = true;
      try {
        const snapshot = await fetchPlexSectionSnapshot(activeSectionId, { include_items: 1 });
        if (prefetchStateRef.current.token !== currentToken) {
          if (sectionRefreshTokenRef.current === currentToken) {
            sectionRefreshTokenRef.current = null;
            setSectionRefreshPending(false);
          }
          if (loadingTokenRef.current === currentToken) {
            loadingTokenRef.current = null;
          }
          return;
        }
        const normalized = normalizeSnapshotPayload(snapshot);
        let stillBuilding = true;
        setSectionSnapshot((state) => {
          const merged = mergeSnapshotSummary(state.data, normalized);
          const nextBuilding = state.building || !normalized.completed;
          stillBuilding = nextBuilding;
          return {
            ...state,
            loading: false,
            building: nextBuilding,
            data: merged,
            error: null,
            taskId: state.taskId ?? null,
          };
        });
        setItemsPayload((prev) => buildItemsPayloadFromSnapshot(normalized, sectionPageLimit, prev));
        setAvailableSorts((prev) => (
          normalized.sort_options?.length ? normalized.sort_options : prev
        ));
        shouldContinueLoading = stillBuilding;
        setItemsLoading(stillBuilding);
        if (stillBuilding) {
          loadingTokenRef.current = currentToken;
        } else if (loadingTokenRef.current === currentToken) {
          loadingTokenRef.current = null;
        }
        if (!normalized.completed && !snapshotBuildRef.current) {
          const resumeReason = normalized.cached > 0 ? 'resume' : 'refresh';
          void startSnapshotBuild({ reason: resumeReason });
        }
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
      } catch (error) {
        if (prefetchStateRef.current.token !== currentToken) {
          if (sectionRefreshTokenRef.current === currentToken) {
            sectionRefreshTokenRef.current = null;
            setSectionRefreshPending(false);
          }
          if (loadingTokenRef.current === currentToken) {
            loadingTokenRef.current = null;
          }
          return;
        }
        shouldContinueLoading = false;
        const message =
          error instanceof Error ? error.message : 'Failed to refresh section items';
        setSectionRefreshError(message);
        setItemsError((prev) => prev ?? message);
        setItemsLoading(false);
        if (loadingTokenRef.current === currentToken) {
          loadingTokenRef.current = null;
        }
      } finally {
        if (prefetchStateRef.current.token === currentToken) {
          if (!shouldContinueLoading) {
            sectionRefreshTokenRef.current = null;
            setSectionRefreshPending(false);
            if (loadingTokenRef.current === currentToken) {
              loadingTokenRef.current = null;
            }
          }
        }
      }
    })();
  }, [
    activeSectionId,
    fetchPlexSectionSnapshot,
    isLibraryViewActive,
    startSnapshotBuild,
    sectionPageLimit,
  ]);

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

  const handleRefreshDetails = useCallback(() => {
    const ratingKey = selectedItem?.rating_key;
    if (!ratingKey) {
      return;
    }
    setDetailRefreshPending(true);
    setDetailRefreshError(null);
    setDetailsState((state) => ({ ...state, loading: true }));

    (async () => {
      try {
        const data = await refreshPlexItemDetails(ratingKey);
        setDetailsState({ loading: false, error: null, data });
        if (data?.item) {
          setSelectedItem(data.item);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to refresh item metadata';
        setDetailRefreshError(message);
        setDetailsState((state) => ({ ...state, loading: false, error: message }));
      } finally {
        setDetailRefreshPending(false);
      }
    })();
  }, [refreshPlexItemDetails, selectedItem?.rating_key]);

  const details = detailsState.data ?? {};
  const {
    children,
    mediaItems,
    detailImages,
    ratingEntries,
    guidEntries,
    ultraBlur,
    heroImage,
    posterImage,
    hasSubtitleTracks,
  } = useMemo(() => {
    const safeDetails = detailsState.data ?? {};
    const mediaItems = Array.isArray(safeDetails.media) ? safeDetails.media : [];
    const detailImages = Array.isArray(safeDetails.images) ? safeDetails.images : [];
    const ratingEntries = Array.isArray(safeDetails.ratings) ? safeDetails.ratings : [];
    const guidEntries = Array.isArray(safeDetails.guids) ? safeDetails.guids : [];
    const ultraBlur = safeDetails.ultra_blur ?? null;

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

    let subtitleCount = 0;
    mediaItems.forEach((mediaItem) => {
      const parts = Array.isArray(mediaItem?.parts) ? mediaItem.parts : [];
      parts.forEach((part) => {
        const streams = Array.isArray(part?.streams) ? part.streams : [];
        streams.forEach((stream) => {
          const streamType = Number(stream?.stream_type ?? stream?.streamType ?? stream?.type);
          const normalizedType = typeof stream?.type === 'string' ? stream.type.toLowerCase() : '';
          const isSubtitleStream = streamType === 3 || normalizedType === 'subtitle';
          if (isSubtitleStream) {
            subtitleCount += 1;
          }
        });
      });
    });

    return {
      children: safeDetails.children ?? {},
      mediaItems,
      detailImages,
      ratingEntries,
      guidEntries,
      ultraBlur,
      heroImage,
      posterImage,
      hasSubtitleTracks: subtitleCount > 0,
    };
  }, [detailsState.data, selectedItem]);

  const handleExtractSubtitles = useCallback(() => {
    const ratingKey = selectedItem?.rating_key;
    if (!ratingKey || !hasSubtitleTracks) {
      return;
    }
    setSubtitleExtractPending(true);
    setSubtitleExtractNotice(null);

    (async () => {
      try {
        const response = await extractPlexItemSubtitles(ratingKey, {});
        const taskId = response?.task_id;
        let trackCount = 0;
        if (taskId) {
          const result = await pollTranscoderTask(taskId);
          const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
          trackCount = tracks.length;
        }
        const message = trackCount
          ? `Prepared ${trackCount} subtitle ${trackCount === 1 ? 'track' : 'tracks'}.`
          : 'Subtitle extraction task started.';
        setSubtitleExtractNotice({ tone: 'success', message });
        // Refresh metadata so newly extracted tracks are visible in the UI.
        handleRefreshDetails();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to extract subtitles';
        setSubtitleExtractNotice({ tone: 'error', message });
      } finally {
        setSubtitleExtractPending(false);
      }
    })();
  }, [extractPlexItemSubtitles, handleRefreshDetails, hasSubtitleTracks, pollTranscoderTask, selectedItem?.rating_key]);

  const handlePlay = useCallback(
    async (item) => {
      if (!item?.rating_key) {
        return;
      }
      clearPlayResetTimer();
      setPlayPending(true);
      setPlayError(null);
      setPlayPhase(hasSubtitleTracks ? 'extracting' : 'starting');
      try {
        const response = await playPlexItem(item.rating_key, {});
        setPlayPhase('starting');
        onStartPlayback?.(response);
        playTimerRef.current = window.setTimeout(() => {
          setPlayPending(false);
          setPlayPhase('idle');
          playTimerRef.current = null;
        }, 300);
      } catch (error) {
        clearPlayResetTimer();
        setPlayPending(false);
        setPlayPhase('idle');
        setPlayError(error?.message ?? 'Failed to start playback');
      }
    },
    [clearPlayResetTimer, hasSubtitleTracks, onStartPlayback],
  );
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
          <li aria-hidden="true" className="mx-3 my-6 h-px bg-border/60" />
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
            {sectionViewToggle}
            <span
              className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-foreground"
              title={countPillTitle}
            >
              {countLabel}
            </span>
            {headerLoading ? (
              <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" />
            ) : null}
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
                  {playPending
                    ? playPhase === 'extracting'
                      ? 'Extracting subtitles…'
                      : 'Starting…'
                    : 'Start'}
                </button>
                <button
                  type="button"
                  onClick={handleRefreshDetails}
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
                  onClick={handleExtractSubtitles}
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
                {subtitleExtractNotice?.message ? (
                  <span
                    className={`text-xs ${
                      subtitleExtractNotice.tone === 'error' ? 'text-rose-300' : 'text-muted'
                    }`}
                  >
                    {subtitleExtractNotice.message}
                  </span>
                ) : null}
                {detailRefreshError ? (
                  <span className="text-xs text-rose-300">{detailRefreshError}</span>
                ) : null}
              </>
            ) : isLibraryViewActive ? (
              <>
                <button
                  type="button"
                  onClick={handleRefreshSectionItems}
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
                {sectionRefreshError ? (
                  <span className="text-xs text-rose-300">{sectionRefreshError}</span>
                ) : null}
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
                  <FontAwesomeIcon icon={faTableColumns} className="text-xs" aria-hidden="true" />
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
            ) : null}
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
          isRecommendedViewActive ? (
            <div className="flex flex-1 overflow-y-auto px-6 py-6">
              <div className="flex w-full flex-col gap-6">
                {recommendedError ? (
                  <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {recommendedError}
                  </div>
                ) : null}
                {recommendedLoading && !recommendedRows.length ? (
                  <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
                    <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
                  </div>
                ) : null}
                {!recommendedLoading && !recommendedRows.length ? (
                  <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
                    <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
                    <p>No recommendations yet.</p>
                  </div>
                ) : null}
                {recommendedRows.map((row) => {
                  const hasItems = Array.isArray(row.items) && row.items.length > 0;
                  if (!hasItems) {
                    return null;
                  }
                  return (
                    <section
                      key={row.id}
                      className="space-y-4 rounded-2xl border border-border/40 bg-surface/70 p-5 shadow-sm"
                    >
                      <HomeRow
                        title={row.title}
                        items={row.items}
                        onSelect={handleSelectItem}
                        metaFormatter={row.meta}
                        actions={(
                          <button
                            type="button"
                            onClick={() => handleRecommendedRowNavigate(row)}
                            className="rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-semibold text-muted transition hover:border-accent hover:text-accent"
                          >
                            View Library
                          </button>
                        )}
                      />
                    </section>
                  );
                })}
                {recommendedLoading && recommendedRows.length ? (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted">
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    Updating…
                  </div>
                ) : null}
              </div>
            </div>
          ) : isCollectionsViewActive ? (
            <div className="flex flex-1 overflow-y-auto px-6 py-6">
              <div className="flex w-full flex-col gap-6">
                {collectionsError ? (
                  <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {collectionsError}
                  </div>
                ) : null}
                {collectionsState.loading && !collectionsState.items.length ? (
                  <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
                    <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
                  </div>
                ) : null}
                {!collectionsState.loading && !collectionsState.items.length ? (
                  <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
                    <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
                    <p>No collections available.</p>
                  </div>
                ) : null}
                {collectionsState.items.length ? (
                  <div className="library-grid" style={{ '--library-columns': '6' }}>
                    {collectionsState.items.map((collection, index) => {
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
                          onClick={() => handleSelectItem(collection)}
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
                            <p className="mt-1 h-4 text-xs text-muted">
                              {collection.summary ?? ' '}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {collectionsState.loading && collectionsState.items.length ? (
                  <div className="flex items-center justify-center gap-2 text-xs text-muted">
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    Updating…
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
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
                  <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {currentError}
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
              {shouldShowAlphabetBar ? (
                <div className="relative hidden lg:flex lg:w-14 lg:flex-col lg:border-l lg:border-border/60 lg:bg-surface/80 lg:px-1 lg:py-4">
                  <div className="sticky top-24 flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleLetterChange('0-9')}
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
                        onClick={() => handleLetterChange(letter)}
                        disabled={overlayActive}
                        className={`w-8 rounded-full px-2 py-1 text-xs font-semibold transition disabled:pointer-events-none disabled:opacity-60 ${
                          activeLetter === letter
                            ? 'bg-accent text-accent-foreground'
                            : 'text-muted hover:text-foreground'
                        }`}
                      >
                        {letter}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )
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
