export const WATCH_FILTERS = [
  { id: 'all', label: 'All items' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'watched', label: 'Watched' },
];

export const DEFAULT_SORT = 'title_asc';
export const DEFAULT_SECTION_PAGE_LIMIT = 500;
export const SECTION_PAGE_LIMIT_MIN = 1;
export const SECTION_PAGE_LIMIT_MAX = 1000;
export const SEARCH_PAGE_LIMIT = 60;
export const SEARCH_RESULTS_MAX = 200;
export const HOME_ROW_LIMIT_MIN = 1;
export const HOME_ROW_LIMIT_MAX = 200;
export const DEFAULT_HOME_ROW_LIMIT = 24;
export const COLLECTIONS_PAGE_LIMIT = 120;
export const IMAGE_PREFETCH_RADIUS = 48;
export const DEFAULT_CARD_HEIGHT = 320;
export const DEFAULT_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export const VIEW_GRID = 'grid';
export const VIEW_DETAILS = 'details';
export const SECTIONS_ONLY_MODE = false;

export const SECTION_VIEW_RECOMMENDED = 'recommended';
export const SECTION_VIEW_LIBRARY = 'library';
export const SECTION_VIEW_COLLECTIONS = 'collections';

export const SECTION_VIEW_OPTIONS = [
  { id: SECTION_VIEW_RECOMMENDED, label: 'Recommended' },
  { id: SECTION_VIEW_LIBRARY, label: 'Library' },
  { id: SECTION_VIEW_COLLECTIONS, label: 'Collections' },
];

export const SNAPSHOT_PARALLELISM = 4;
export const SNAPSHOT_POLL_INTERVAL_MS = 1000;
