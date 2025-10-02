import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLayerGroup,
  faPlay,
  faCircleNotch,
  faCircleInfo,
  faChevronLeft,
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
import placeholderPoster from '../../placeholder.png';
import DockNav from '../components/navigation/DockNav.jsx';
import {
  fetchPlexSections,
  fetchPlexSectionItems,
  fetchPlexItemDetails,
  fetchPlexSearch,
  playPlexItem,
  plexImageUrl,
} from '../lib/api.js';

const WATCH_FILTERS = [
  { id: 'all', label: 'All items' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'watched', label: 'Watched' },
];

const DEFAULT_SORT = 'title_asc';
const DEFAULT_LIMIT = 60;
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
                <LibraryGridImage item={item} />
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

function PeopleCarousel({ title, people, fallbackRole }) {
  if (!people?.length) {
    return null;
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
        <span className="text-xs uppercase tracking-wide text-subtle">{people.length}</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex gap-4 pb-2">
          {people.map((person) => {
            const key = person.id ?? person.tag ?? person.title;
            const name = person.title ?? person.tag;
            if (!name) {
              return null;
            }
            const thumbUrl = resolveImageUrl(person.thumb, { width: 160, height: 160, min: 1 });
            const initials = name
              .split(' ')
              .filter(Boolean)
              .slice(0, 2)
              .map((segment) => segment[0])
              .join('')
              .toUpperCase();
            const role = person.role ?? fallbackRole ?? '';
            return (
              <div key={key ?? name} className="flex w-28 shrink-0 flex-col items-center text-center">
                <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-border/40 bg-border/30 text-sm font-semibold uppercase tracking-wide text-muted">
                  {thumbUrl ? (
                    <img src={thumbUrl} alt={name} className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    initials || name.charAt(0).toUpperCase()
                  )}
                </div>
                <p className="mt-2 line-clamp-2 text-xs font-semibold text-foreground">{name}</p>
                {role ? <p className="mt-1 line-clamp-2 text-[11px] text-subtle">{role}</p> : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function LibraryGridImage({ item }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [posterError, setPosterError] = useState(false);
  const posterSrc = item?.thumb
    ? plexImageUrl(item.thumb, { width: 360, height: 540, upscale: 1 })
    : null;

  useEffect(() => {
    setImageLoaded(false);
    setPosterError(false);
  }, [posterSrc]);

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
      {!posterSrc || posterError ? (
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

export default function LibraryPage({ onStartPlayback }) {
  const [navActive, setNavActive] = useState('library');
  const [sections, setSections] = useState([]);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [sectionsError, setSectionsError] = useState(null);
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

  const [viewMode, setViewMode] = useState(VIEW_GRID);
  const [itemsPerRow, setItemsPerRow] = useState(8);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsState, setDetailsState] = useState({ loading: false, error: null, data: null });
  const [playPending, setPlayPending] = useState(false);
  const [playError, setPlayError] = useState(null);

  const scrollContainerRef = useRef(null);
  const prefetchStateRef = useRef({ token: 0 });
  const letterNodeMap = useRef(new Map());

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

  const buildItemParams = useCallback(
    (overrides = {}) => {
      const params = {
        sort: overrides.sort ?? filters.sort,
        offset: overrides.offset ?? 0,
        limit: overrides.limit ?? DEFAULT_LIMIT,
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
    [filters],
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
      const baseLimit = initialPayload.pagination.limit ?? DEFAULT_LIMIT;

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
          break;
        }

        if (prefetchStateRef.current.token !== token) {
          break;
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

        if (
          (total !== null && offset >= total) ||
          (total === null && nextItems.length < currentLimit)
        ) {
          break;
        }
      }
    },
    [activeSectionId, buildItemParams],
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
        setSections(data?.sections ?? []);
        setServerInfo(data?.server ?? null);
        setLetters(data?.letters ?? DEFAULT_LETTERS);
        setAvailableSorts(data?.sort_options ?? []);
        if (!activeSectionId && data?.sections?.length) {
          setActiveSectionId(normalizeKey(data.sections[0]));
        }
      } catch (error) {
        if (!cancelled) {
          setSectionsError(error.message ?? 'Failed to load Plex sections');
          setSections([]);
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
          const data = await fetchPlexSearch(query, { limit: DEFAULT_LIMIT });
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
  }, [globalSearchInput]);

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
  }, [activeSectionId]);

  useEffect(() => {
    if (SECTIONS_ONLY_MODE) {
      return undefined;
    }
    if (!activeSectionId) {
      return;
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
  }, [SECTIONS_ONLY_MODE, activeSectionId, buildItemParams, prefetchRemainingItems]);

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

  const items = itemsPayload?.items ?? [];
  const globalSearchItems = globalSearchData?.items ?? [];
  const isGlobalSearching = Boolean(globalSearchInput.trim());
  const visibleItems = isGlobalSearching ? globalSearchItems : items;
  const totalItemCount = isGlobalSearching
    ? globalSearchData?.pagination?.total ?? globalSearchItems.length
    : itemsPayload?.pagination?.total ?? items.length;
  const currentLoading = isGlobalSearching ? globalSearchLoading : itemsLoading;
  const currentError = isGlobalSearching ? globalSearchError : itemsError;
  const countSuffix = isGlobalSearching
    ? totalItemCount === 1
      ? 'result'
      : 'results'
    : totalItemCount === 1
      ? 'item'
      : 'items';
  const countLabel = `${totalItemCount.toLocaleString()} ${countSuffix}`;
  const activeSearchQuery = isGlobalSearching ? globalSearchData?.query ?? globalSearchInput.trim() : '';
  const countPillTitle = isGlobalSearching && activeSearchQuery ? `Search results for “${activeSearchQuery}”` : undefined;
  const shouldShowFilters = !isGlobalSearching;
  const emptyStateMessage = isGlobalSearching
    ? 'No results match this search.'
    : 'No items match the current filters.';
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
        return;
      }
      if (!letter) {
        container.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const targetNode = letterNodeMap.current.get(letter);
      if (!targetNode) {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const targetRect = targetNode.getBoundingClientRect();
      const offset = targetRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({ top: Math.max(offset - 16, 0), behavior: 'smooth' });
    },
    [],
  );

  useEffect(() => {
    if (!shouldShowFilters) {
      return;
    }
    if (activeLetter === null) {
      scrollToLetter(null);
      return;
    }
    scrollToLetter(activeLetter);
  }, [activeLetter, scrollToLetter, shouldShowFilters, visibleItems]);

  const handleSelectItem = useCallback((item) => {
    if (!item) {
      setSelectedItem(null);
      setViewMode(VIEW_GRID);
      setPlayError(null);
      return;
    }
    setSelectedItem(item);
    setViewMode(VIEW_DETAILS);
    setPlayError(null);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

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
        if (activeLetter === null) {
          scrollToLetter(null);
        }
        setActiveLetter(null);
        return;
      }
      if (activeLetter === letter) {
        scrollToLetter(letter);
        return;
      }
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

  const heroBackdrop = selectedItem
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
  const posterImage = selectedItem
    ? resolveImageUrl(selectedItem.thumb, { width: 600, height: 900, min: 1, upscale: 1 })
    : null;

  const runtimeLabel = selectedItem ? formatRuntime(selectedItem.duration) : null;
  const addedDate = selectedItem ? formatDate(selectedItem.added_at) : null;
  const updatedDate = selectedItem ? formatDate(selectedItem.updated_at) : null;
  const lastViewedDate = selectedItem ? formatDate(selectedItem.last_viewed_at) : null;
  const viewCount = selectedItem ? formatCount(selectedItem.view_count) : null;

  const ratingBadges = [
    { label: 'Critic', value: formatRatingValue(selectedItem?.rating) },
    { label: 'Audience', value: formatRatingValue(selectedItem?.audience_rating) },
    { label: 'User', value: formatRatingValue(selectedItem?.user_rating) },
  ].filter((entry) => entry.value);

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
    { label: 'View Count', value: viewCount },
  ];

  const timelineStatEntries = [
    { label: 'Added', value: addedDate },
    { label: 'Last Viewed', value: lastViewedDate },
    { label: 'Updated', value: updatedDate },
  ];

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

  const detailStats = filterStatEntries(coreStatEntries);
  const timelineStats = filterStatEntries(timelineStatEntries);

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
          {sections.map((section) => {
            const key = normalizeKey(section);
            const isActive = key === activeSectionId;
            return (
              <li key={key ?? section.title}>
                <button
                  type="button"
                  onClick={() => setActiveSectionId(key)}
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
            {currentLoading ? <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" /> : null}
            <span
              className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-foreground"
              title={countPillTitle}
            >
              {countLabel}
            </span>
            {isGlobalSearching && activeSearchQuery ? (
              <span className="truncate text-xs text-muted">for “{activeSearchQuery}”</span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {viewMode === VIEW_DETAILS ? (
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
                <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background px-2 py-1 text-xs text-muted">
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40"
                  >
                    <FontAwesomeIcon icon={faArrowUp} className="text-xs" />
                    Queue Next
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-full bg-background/80 px-3 py-1 font-semibold text-foreground transition hover:bg-border/40"
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
                <div className="flex h-8 items-center rounded-full border border-border/70 bg-background px-3">
                  <input
                    id="library-columns"
                    type="range"
                    min="5"
                    max="12"
                    value={itemsPerRow}
                    onChange={(event) => setItemsPerRow(Number(event.target.value))}
                    className="h-1.5 w-28 appearance-none accent-accent"
                    aria-label="Columns per row"
                    title={`Columns per row: ${itemsPerRow}`}
                  />
                </div>
              </>
            )}
          </div>
        </header>

        {viewMode === VIEW_GRID ? (
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
                  {visibleItems.map((item) => {
                    const itemKey = uniqueKey(item);
                    const itemLetter = deriveItemLetter(item);
                    let anchorRef;
                    if (shouldShowFilters && itemLetter && !letterAnchorTracker.has(itemLetter)) {
                      letterAnchorTracker.add(itemLetter);
                      anchorRef = registerLetterRef(itemLetter);
                    }
                    return (
                      <button
                        key={itemKey}
                        ref={anchorRef}
                        type="button"
                        onClick={() => handleSelectItem(item)}
                        className="group flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-surface/70 transition hover:border-accent"
                        data-letter={itemLetter ?? undefined}
                      >
                        <div className="relative">
                          <LibraryGridImage item={item} />
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
              <div className="flex flex-1 flex-col overflow-y-auto">
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
                      <div className="h-full w-full bg-gradient-to-br from-border/30 via-background to-background" />
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
                        Back to results
                      </button>
                      {/** Play button handled in header for detail view */}
                    </div>

                    <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] lg:items-start">
                      <div className="order-2 flex flex-col gap-4 lg:order-1">
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
                      <div className="order-1 flex-1 space-y-8 text-foreground lg:order-2">
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
                                  key={entry.label}
                                  className="rounded-full border border-border/40 bg-background/80 px-3 py-1 text-xs font-semibold text-foreground/80 shadow-sm"
                                >
                                  {entry.label}: {entry.value}
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

                        <div className="grid gap-6 xl:grid-cols-2">
                          <div className="space-y-4 rounded-2xl border border-border/40 bg-background/80 p-5">
                            <div className="flex items-center justify-between">
                              <h3 className="text-base font-semibold tracking-tight text-foreground">Metadata</h3>
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
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
                          </div>

                          <div className="space-y-4 rounded-2xl border border-border/40 bg-background/80 p-5">
                            <div className="flex items-center justify-between">
                              <h3 className="text-base font-semibold tracking-tight text-foreground">Media</h3>
                              <span className="text-xs uppercase tracking-wide text-subtle">
                                {mediaItems.length} {mediaItems.length === 1 ? 'version' : 'versions'}
                              </span>
                            </div>
                            {mediaItems.length ? (
                              <div className="space-y-4">
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
                                      className="space-y-4 rounded-xl border border-border/30 bg-background/70 p-4"
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
                            )}
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
