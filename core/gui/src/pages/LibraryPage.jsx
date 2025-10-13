import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleNotch, faLayerGroup } from '@fortawesome/free-solid-svg-icons';
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
} from '../lib/api.js';
import {
  DEFAULT_SORT,
  DEFAULT_SECTION_PAGE_LIMIT,
  SECTION_PAGE_LIMIT_MIN,
  SECTION_PAGE_LIMIT_MAX,
  SEARCH_PAGE_LIMIT,
  HOME_ROW_LIMIT,
  COLLECTIONS_PAGE_LIMIT,
  IMAGE_PREFETCH_RADIUS,
  DEFAULT_CARD_HEIGHT,
  DEFAULT_LETTERS,
  VIEW_GRID,
  VIEW_DETAILS,
  SECTIONS_ONLY_MODE,
  SECTION_VIEW_RECOMMENDED,
  SECTION_VIEW_LIBRARY,
  SECTION_VIEW_COLLECTIONS,
  SNAPSHOT_PARALLELISM,
  SNAPSHOT_POLL_INTERVAL_MS,
} from '../features/library/constants.js';
import {
  normalizeSectionViewValue,
  formatDate,
  clampSectionPageLimit,
  normalizeKey,
  normalizeSnapshotPayload,
  mergeSnapshotSummary,
  buildItemsPayloadFromSnapshot,
} from '../features/library/utils.js';
import LibrarySidebar from '../features/library/page/LibrarySidebar.jsx';
import LibraryHeader from '../features/library/page/LibraryHeader.jsx';
import LibraryHomeView from '../features/library/page/LibraryHomeView.jsx';
import LibraryRecommendedView from '../features/library/page/LibraryRecommendedView.jsx';
import LibraryCollectionsView from '../features/library/page/LibraryCollectionsView.jsx';
import LibraryGridView from '../features/library/page/LibraryGridView.jsx';
import LibraryDetailsPane from '../features/library/page/LibraryDetailsPane.jsx';

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

  const handlePlay = useCallback(
    async (item) => {
      if (!item?.rating_key) {
        return;
      }
      clearPlayResetTimer();
      setPlayPending(true);
      setPlayError(null);
      setPlayPhase('starting');
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
    [clearPlayResetTimer, onStartPlayback],
  );
  const serverLabel = serverInfo?.name ?? serverInfo?.title ?? serverInfo?.product ?? null;

  const renderSectionSidebar = () => (
    <LibrarySidebar
      sections={sections}
      sectionsLoading={sectionsLoading}
      sectionsError={sectionsError}
      isHomeView={isHomeView}
      activeSectionId={activeSectionId}
      globalSearchInput={globalSearchInput}
      onGlobalSearchInput={setGlobalSearchInput}
      globalSearchLoading={globalSearchLoading}
      onSelectHome={handleGoHome}
      onSelectSection={handleBrowseSection}
    />
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
              Section browsing is temporarily limited to listing Plex libraries while we simplify the workflow.
            </p>
            {sectionsLoading ? (
              <div className="flex items-center justify-center gap-2 text-sm text-muted">
                <FontAwesomeIcon icon={faCircleNotch} spin />
                Fetching sections…
              </div>
            ) : null}
            {!sectionsLoading && sections.length ? (
              <p className="text-xs text-subtle">
                Select a library from the left to confirm it is available. Additional browsing tools will return in a later
                iteration.
              </p>
            ) : null}
            {sectionsError ? (
              <div className="rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger">{sectionsError}</div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const collectionsItems = collectionsState.sectionId === activeSectionId ? collectionsState.items : [];

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
        <LibraryHeader
          showSectionViewToggle={!isHomeView}
          sectionView={sectionView}
          onSectionViewChange={handleSectionViewChange}
          countLabel={countLabel}
          countPillTitle={countPillTitle}
          headerLoading={headerLoading}
          isHomeView={isHomeView}
          isGlobalSearching={isGlobalSearching}
          activeSearchQuery={activeSearchQuery}
          serverLabel={serverLabel}
          viewMode={viewMode}
          selectedItem={selectedItem}
          onPlay={handlePlay}
          playPending={playPending}
          playPhase={playPhase}
          onRefreshDetails={handleRefreshDetails}
          detailRefreshPending={detailRefreshPending}
          detailRefreshError={detailRefreshError}
          queueNotice={queueNotice}
          queuePending={queuePending}
          onQueueAction={handleQueueAction}
          isLibraryViewActive={isLibraryViewActive}
          onRefreshSection={handleRefreshSectionItems}
          sectionRefreshPending={sectionRefreshPending}
          sectionRefreshError={sectionRefreshError}
          itemsLoading={itemsLoading}
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          sortOptions={sortOptions}
          sortValue={filters.sort}
          onSortChange={(value) => setFilters((prev) => ({ ...prev, sort: value }))}
          watchValue={filters.watch}
          onWatchChange={(value) => setFilters((prev) => ({ ...prev, watch: value }))}
          itemsPerRow={itemsPerRow}
          onItemsPerRowChange={setItemsPerRow}
          onClearFilters={handleClearFilters}
        />

        {isHomeView ? (
          <LibraryHomeView
            sections={homeSections}
            loading={homeLoading}
            error={homeError}
            onSelectItem={handleHomeSelect}
            onBrowseSection={handleBrowseSection}
          />
        ) : viewMode === VIEW_GRID ? (
          isRecommendedViewActive ? (
            <LibraryRecommendedView
              rows={recommendedRows}
              loading={recommendedLoading}
              error={recommendedError}
              onSelectItem={handleSelectItem}
              onNavigateRow={handleRecommendedRowNavigate}
            />
          ) : isCollectionsViewActive ? (
            <LibraryCollectionsView
              items={collectionsItems}
              loading={collectionsLoading}
              error={collectionsError}
              onSelectItem={handleSelectItem}
            />
          ) : (
            <LibraryGridView
              scrollContainerRef={scrollContainerRef}
              overlayActive={overlayActive}
              currentError={currentError}
              currentLoading={currentLoading}
              visibleItems={visibleItems}
              emptyStateMessage={emptyStateMessage}
              itemsPerRow={itemsPerRow}
              shouldShowAlphabetBar={shouldShowAlphabetBar}
              registerLetterRef={registerLetterRef}
              measureCardRef={measureCardRef}
              hasImageWindow={hasImageWindow}
              imageWindow={imageWindow}
              onSelectItem={handleSelectItem}
              visibleLetters={visibleLetters}
              onLetterChange={handleLetterChange}
              activeLetter={activeLetter}
            />
          )
        ) : (
          <LibraryDetailsPane
            selectedItem={selectedItem}
            detailsState={detailsState}
            detailTab={detailTab}
            onDetailTabChange={setDetailTab}
            onClose={handleCloseDetails}
            onSelectItem={handleSelectItem}
            onPlayChild={handlePlay}
            playPending={playPending}
            playError={playError}
          />
        )}
      </div>
    </div>
  );
}
