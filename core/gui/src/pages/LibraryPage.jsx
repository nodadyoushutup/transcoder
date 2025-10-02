import { useCallback, useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLayerGroup,
  faPlay,
  faCircleNotch,
  faCircleInfo,
  faCirclePlay,
  faChevronLeft,
  faMagnifyingGlass,
  faArrowRotateLeft,
} from '@fortawesome/free-solid-svg-icons';
import DockNav from '../components/navigation/DockNav.jsx';
import LazyRender from '../components/LazyRender.jsx';
import {
  fetchPlexSections,
  fetchPlexSectionItems,
  fetchPlexItemDetails,
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
const DEFAULT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0-9'.split('');
const VIEW_GRID = 'grid';
const VIEW_DETAILS = 'details';

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

function DetailMeta({ label, value }) {
  if (!value) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-surface/80 px-3 py-2 text-xs text-muted">
      <span className="text-[10px] uppercase tracking-wide text-subtle">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function TagList({ title, items }) {
  if (!items?.length) {
    return null;
  }
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h4>
      <div className="flex flex-wrap gap-2">
        {items.map((tag) => (
          <span
            key={tag.id ?? tag.tag ?? tag.title}
            className="rounded-full border border-border/60 bg-surface/80 px-3 py-1 text-xs text-muted"
          >
            {tag.title ?? tag.tag}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChildList({ label, items, onSelect, onPlay, playPending }) {
  if (!items?.length) {
    return null;
  }
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <span className="text-xs text-muted">{items.length} total</span>
      </div>
      <div className="max-h-72 overflow-y-auto pr-2">
        <div className="space-y-2">
          {items.map((child) => (
            <button
              key={uniqueKey(child)}
              type="button"
              onClick={() => onSelect?.(child)}
              className="group flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface/70 px-3 py-2 text-left transition hover:border-accent hover:bg-surface"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground group-hover:text-accent">
                  {child.title}
                </p>
                <p className="truncate text-xs uppercase tracking-wide text-subtle">
                  {typeLabel(child.type)}
                </p>
              </div>
              {child.playable ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlay?.(child);
                  }}
                  disabled={playPending}
                  className="rounded-full border border-border/70 px-3 py-1 text-xs font-semibold text-muted transition hover:border-accent hover:text-accent disabled:opacity-60"
                >
                  {playPending ? 'Starting…' : 'Play'}
                </button>
              ) : null}
            </button>
          ))}
        </div>
      </div>
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
    letter: null,
    genre: null,
    collection: null,
    year: null,
  });
  const [searchInput, setSearchInput] = useState('');

  const [itemsPayload, setItemsPayload] = useState(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState(null);

  const [viewMode, setViewMode] = useState(VIEW_GRID);
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsState, setDetailsState] = useState({ loading: false, error: null, data: null });
  const [playPending, setPlayPending] = useState(false);
  const [playError, setPlayError] = useState(null);

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
    // Reset section-specific filters when changing sections.
    setFilters((prev) => ({
      ...prev,
      letter: null,
      genre: null,
      collection: null,
      year: null,
    }));
    setItemsPayload(null);
    setItemsError(null);
    setSelectedItem(null);
    setViewMode(VIEW_GRID);
    setDetailsState({ loading: false, error: null, data: null });
  }, [activeSectionId]);

  useEffect(() => {
    if (!activeSectionId) {
      return;
    }
    let cancelled = false;
    async function loadItems() {
      setItemsLoading(true);
      setItemsError(null);
      try {
        const params = {
          sort: filters.sort,
          offset: 0,
          limit: DEFAULT_LIMIT,
        };
        if (filters.search) {
          params.search = filters.search;
        }
        if (filters.watch && filters.watch !== 'all') {
          params.watch = filters.watch;
        }
        if (filters.letter) {
          params.letter = filters.letter;
        }
        if (filters.genre) {
          params.genre = filters.genre;
        }
        if (filters.collection) {
          params.collection = filters.collection;
        }
        if (filters.year) {
          params.year = filters.year;
        }
        const payload = await fetchPlexSectionItems(activeSectionId, params);
        if (cancelled) {
          return;
        }
        setItemsPayload(payload);
        setAvailableSorts(payload?.sort_options ?? availableSorts);
      } catch (error) {
        if (!cancelled) {
          setItemsError(error.message ?? 'Failed to load items');
          setItemsPayload(null);
        }
      } finally {
        if (!cancelled) {
          setItemsLoading(false);
        }
      }
    }

    loadItems();
    return () => {
      cancelled = true;
    };
  }, [activeSectionId, filters.sort, filters.search, filters.watch, filters.letter, filters.genre, filters.collection, filters.year]);

  useEffect(() => {
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
  const filterOptions = itemsPayload?.filters ?? {};
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

  const handleLetterChange = useCallback((letter) => {
    setFilters((prev) => ({
      ...prev,
      letter,
    }));
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters({
      sort: DEFAULT_SORT,
      search: '',
      watch: 'all',
      letter: null,
      genre: null,
      collection: null,
      year: null,
    });
    setSearchInput('');
  }, []);

  const activeLetter = filters.letter;

  const details = detailsState.data;
  const children = details?.children ?? {};

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <DockNav
        items={navItems}
        activeId={navActive}
        onChange={(nextId) => setNavActive(nextId)}
        position="left"
        className="border-r border-border/60"
      />

      {navActive ? (
        <aside className="flex w-64 flex-col border-r border-border/80 bg-surface/80">
          <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-subtle">Libraries</p>
              <p className="text-sm font-semibold text-foreground">{serverInfo?.name ?? 'Plex'}</p>
            </div>
            {sectionsLoading ? (
              <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" />
            ) : null}
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
                      className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition ${
                        isActive
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border/70 bg-surface/70 text-muted hover:border-accent/60 hover:text-foreground'
                      }`}
                    >
                      <span className="truncate text-sm font-semibold">{section.title}</span>
                      <span className="truncate text-[11px] uppercase tracking-wide text-subtle">
                        {typeLabel(section.type)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      ) : null}

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-surface/70 px-6 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-foreground">Plex Library</h1>
            <p className="truncate text-xs text-muted">
              {itemsPayload?.items?.length ?? 0} results{itemsPayload?.pagination?.total ? ` of ${itemsPayload.pagination.total}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted focus-within:border-accent">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs text-subtle" />
              <input
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search titles…"
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
            {filterOptions.genre?.length ? (
              <select
                value={filters.genre ?? ''}
                onChange={(event) => setFilters((prev) => ({ ...prev, genre: event.target.value || null }))}
                className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
              >
                <option value="">Genre: Any</option>
                {filterOptions.genre.map((option) => (
                  <option key={option.id ?? option.title} value={option.title}>
                    {option.title}
                  </option>
                ))}
              </select>
            ) : null}
            {filterOptions.collection?.length ? (
              <select
                value={filters.collection ?? ''}
                onChange={(event) => setFilters((prev) => ({ ...prev, collection: event.target.value || null }))}
                className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
              >
                <option value="">Collection: Any</option>
                {filterOptions.collection.map((option) => (
                  <option key={option.id ?? option.title} value={option.title}>
                    {option.title}
                  </option>
                ))}
              </select>
            ) : null}
            {filterOptions.year?.length ? (
              <select
                value={filters.year ?? ''}
                onChange={(event) => setFilters((prev) => ({ ...prev, year: event.target.value || null }))}
                className="rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent focus:border-accent focus:outline-none"
              >
                <option value="">Year: Any</option>
                {filterOptions.year.map((option) => (
                  <option key={option.id ?? option.title} value={option.title}>
                    {option.title}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              onClick={handleClearFilters}
              className="flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted transition hover:border-accent hover:text-accent"
            >
              <FontAwesomeIcon icon={faArrowRotateLeft} className="text-xs" />
              Reset
            </button>
          </div>
        </header>

        {viewMode === VIEW_GRID ? (
          <div className="relative flex flex-1 overflow-hidden">
            <div className="relative flex-1 overflow-y-auto px-6 py-6">
              {itemsError ? (
                <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                  {itemsError}
                </div>
              ) : null}

              {itemsLoading ? (
                <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
                  <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
                </div>
              ) : null}

              {!itemsLoading && !items.length ? (
                <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
                  <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
                  <p>No items match the current filters.</p>
                </div>
              ) : null}

              {items.length ? (
                <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {items.map((item) => (
                    <LazyRender
                      key={uniqueKey(item)}
                      className="h-full"
                      placeholder={(
                        <div className="h-full rounded-xl border border-border/60 bg-surface/50" />
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectItem(item)}
                        className="group flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-surface/70 transition hover:border-accent"
                      >
                        <div className="relative aspect-[2/3] w-full overflow-hidden bg-border/40">
                          {item.thumb ? (
                            <img
                              src={plexImageUrl(item.thumb, { width: 360, height: 540, upscale: 1 })}
                              alt={item.title ?? 'Poster'}
                              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-border/30 text-sm text-muted">
                              No artwork
                            </div>
                          )}
                          <div className="absolute left-2 top-2 rounded-full border border-border/70 bg-background/80 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                            {typeLabel(item.type)}
                          </div>
                          {item.view_count ? (
                            <div className="absolute right-2 top-2 rounded-full border border-success/60 bg-success/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-success">
                              Viewed
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-1 flex-col gap-2 px-3 py-3 text-left">
                          <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-accent">
                            {item.title}
                          </h3>
                          <p className="truncate text-xs text-muted">
                            {[item.year, formatRuntime(item.duration), item.content_rating]
                              .filter(Boolean)
                              .join(' • ')}
                          </p>
                          <p className="line-clamp-3 text-xs text-subtle">{item.summary}</p>
                          {item.playable ? (
                            <div className="mt-auto flex justify-end">
                              <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-xs text-muted transition group-hover:border-accent group-hover:text-accent">
                                <FontAwesomeIcon icon={faCirclePlay} />
                                Play
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </button>
                    </LazyRender>
                  ))}
                </div>
              ) : null}
            </div>

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
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-y-auto px-6 py-6">
            {selectedItem ? (
              <div className="mx-auto w-full max-w-5xl">
                <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
                  <button
                    type="button"
                    onClick={handleCloseDetails}
                    className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted transition hover:text-accent"
                  >
                    <FontAwesomeIcon icon={faChevronLeft} />
                    Back to results
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePlay(selectedItem)}
                    disabled={playPending}
                    className="flex items-center gap-2 rounded-full border border-accent/60 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition hover:border-accent hover:bg-accent/20 disabled:opacity-60"
                  >
                    <FontAwesomeIcon icon={faPlay} />
                    {playPending ? 'Starting…' : 'Play'}
                  </button>
                </div>

                {playError ? (
                  <div className="mb-4 rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-sm text-danger">
                    {playError}
                  </div>
                ) : null}

                <div className="mb-6 flex flex-col gap-4 md:flex-row">
                  <div className="w-full max-w-[180px] overflow-hidden rounded-lg border border-border/60 bg-border/30">
                    {selectedItem.thumb ? (
                      <img
                        src={plexImageUrl(selectedItem.thumb, { width: 360, height: 540, upscale: 1 })}
                        alt={selectedItem.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-muted">
                        No artwork
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-foreground">{selectedItem.title}</h2>
                    <p className="text-xs uppercase tracking-wide text-subtle">{typeLabel(selectedItem.type)}</p>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <DetailMeta label="Year" value={selectedItem.year} />
                      <DetailMeta label="Runtime" value={formatRuntime(selectedItem.duration)} />
                      <DetailMeta label="Added" value={formatDate(selectedItem.added_at)} />
                      <DetailMeta label="Rating" value={selectedItem.content_rating} />
                    </div>
                  </div>
                </div>

                <div className="space-y-4 text-sm text-muted">
                  {selectedItem.tagline ? (
                    <p className="text-sm font-medium text-foreground">{selectedItem.tagline}</p>
                  ) : null}
                  {selectedItem.summary ? (
                    <p className="text-sm leading-relaxed text-muted">{selectedItem.summary}</p>
                  ) : null}
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {selectedItem.studio ? <DetailMeta label="Studio" value={selectedItem.studio} /> : null}
                  {selectedItem.view_count ? <DetailMeta label="Views" value={selectedItem.view_count} /> : null}
                  {selectedItem.user_rating ? <DetailMeta label="User Rating" value={selectedItem.user_rating} /> : null}
                  {selectedItem.audience_rating ? (
                    <DetailMeta label="Audience Rating" value={selectedItem.audience_rating} />
                  ) : null}
                </div>

                <div className="mt-6 space-y-4 text-sm">
                  <TagList title="Genres" items={selectedItem.genres} />
                  <TagList title="Collections" items={selectedItem.collections} />
                  <TagList title="Cast" items={selectedItem.actors} />
                  <TagList title="Directors" items={selectedItem.directors} />
                </div>

                {detailsState.loading ? (
                  <div className="mt-6 flex items-center gap-2 text-sm text-muted">
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    Loading details…
                  </div>
                ) : null}
                {detailsState.error ? (
                  <div className="mt-6 rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-sm text-danger">
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
