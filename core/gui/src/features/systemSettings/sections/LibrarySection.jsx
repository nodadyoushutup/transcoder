import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowsRotate,
  faBroom,
  faCircleNotch,
  faEye,
  faEyeSlash,
  faImage,
} from '@fortawesome/free-solid-svg-icons';
import {
  buildPlexHomeSnapshot,
  buildPlexSectionSnapshot,
  cachePlexHomeImages,
  cachePlexSectionImages,
  clearPlexHomeSnapshot,
  clearPlexSectionSnapshot,
  stopTask,
  updateSystemSettings,
} from '../../../lib/api.js';
import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  SelectField,
  TextField,
  computeDiff,
  prepareForm,
} from '../shared.jsx';
import {
  DEFAULT_HOME_ROW_LIMIT,
  HOME_ROW_LIMIT_MAX,
  HOME_ROW_LIMIT_MIN,
} from '../../library/constants.js';
import { clampHomeRowLimit } from '../../library/utils.js';

export const LIBRARY_PAGE_SIZE_MIN = 1;
export const LIBRARY_PAGE_SIZE_MAX = 1000;
export const DEFAULT_LIBRARY_PAGE_SIZE = 500;
export const LIBRARY_SECTION_VIEWS = ['recommended', 'library', 'collections'];
export const LIBRARY_DEFAULT_SORT = 'title_asc';
export const SNAPSHOT_PARALLELISM = 4;

export function clampLibraryPageSize(value, fallback = DEFAULT_LIBRARY_PAGE_SIZE) {
  const base = Number.isFinite(fallback) ? Number(fallback) : DEFAULT_LIBRARY_PAGE_SIZE;
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return Math.min(LIBRARY_PAGE_SIZE_MAX, Math.max(LIBRARY_PAGE_SIZE_MIN, base));
  }
  return Math.min(LIBRARY_PAGE_SIZE_MAX, Math.max(LIBRARY_PAGE_SIZE_MIN, numeric));
}

export function normalizeSectionView(value, fallback = 'library') {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (LIBRARY_SECTION_VIEWS.includes(candidate)) {
    return candidate;
  }
  return LIBRARY_SECTION_VIEWS.includes(fallback) ? fallback : 'library';
}

export function normalizeHiddenSections(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  raw.forEach((entry) => {
    if (entry === null || entry === undefined) {
      return;
    }
    const identifier = String(entry).trim();
    if (!identifier || seen.has(identifier)) {
      return;
    }
    normalized.push(identifier);
    seen.add(identifier);
  });
  normalized.sort((a, b) => a.localeCompare(b));
  return normalized;
}

export function mapLibrarySections(sections, hiddenIdentifiers) {
  const hiddenSet = hiddenIdentifiers instanceof Set ? hiddenIdentifiers : new Set(hiddenIdentifiers || []);
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections.map((section) => {
    const identifier = section?.identifier
      ?? (section?.id !== undefined && section?.id !== null ? String(section.id) : null)
      ?? (section?.uuid ? String(section.uuid) : null)
      ?? (section?.key ? String(section.key).replace(/^\/library\/sections\//, '').trim() : null);
    return {
      ...section,
      identifier,
      is_hidden: identifier ? hiddenSet.has(identifier) : Boolean(section?.is_hidden),
    };
  });
}

export function resolveSectionKey(section) {
  if (!section) {
    return null;
  }
  if (section.id !== undefined && section.id !== null) {
    return String(section.id);
  }
  const keyCandidate = section.key ?? section.identifier ?? null;
  if (!keyCandidate) {
    return null;
  }
  const keyString = String(keyCandidate).trim();
  if (!keyString) {
    return null;
  }
  if (keyString.startsWith('/')) {
    const parts = keyString.split('/').filter(Boolean);
    if (parts.length) {
      return parts[parts.length - 1];
    }
  }
  return keyString;
}

export function sanitizeLibraryRecord(record, fallback = DEFAULT_LIBRARY_PAGE_SIZE) {
  const normalized = { ...(record || {}) };
  normalized.hidden_sections = normalizeHiddenSections(normalized.hidden_sections);
  normalized.section_page_size = clampLibraryPageSize(
    normalized.section_page_size ?? fallback,
    fallback,
  );
  normalized.home_row_limit = clampHomeRowLimit(
    normalized.home_row_limit ?? DEFAULT_HOME_ROW_LIMIT,
    DEFAULT_HOME_ROW_LIMIT,
  );
  normalized.default_section_view = normalizeSectionView(normalized.default_section_view ?? 'library');
  return normalized;
}

export default function LibrarySection({
  library,
  setLibrary,
  reloadLibrarySections,
  loadTasksSettings,
}) {
  if (library.loading) {
    return <div className="text-sm text-muted">Loading library settings…</div>;
  }

  const currentPageSize = clampLibraryPageSize(
    library.form.section_page_size,
    library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE,
  );
  const currentHomeRowLimit = clampHomeRowLimit(
    library.form.home_row_limit,
    library.defaults.home_row_limit ?? DEFAULT_HOME_ROW_LIMIT,
  );
  const clampThumbDimension = (value, fallback) => {
    const numeric = Number.parseInt(value, 10);
    if (Number.isNaN(numeric)) {
      return fallback;
    }
    return Math.min(1920, Math.max(64, numeric));
  };
  const clampThumbQuality = (value, fallback) => {
    const numeric = Number.parseInt(value, 10);
    if (Number.isNaN(numeric)) {
      return fallback;
    }
    return Math.min(100, Math.max(10, numeric));
  };
  const thumbnailWidth = clampThumbDimension(
    library.form.image_cache_thumb_width ?? library.defaults.image_cache_thumb_width ?? 320,
    library.defaults.image_cache_thumb_width ?? 320,
  );
  const thumbnailHeight = clampThumbDimension(
    library.form.image_cache_thumb_height ?? library.defaults.image_cache_thumb_height ?? 480,
    library.defaults.image_cache_thumb_height ?? 480,
  );
  const thumbnailQuality = clampThumbQuality(
    library.form.image_cache_thumb_quality ?? library.defaults.image_cache_thumb_quality ?? 80,
    library.defaults.image_cache_thumb_quality ?? 80,
  );

  const THUMB_ASPECT_WIDTH = 2;
  const THUMB_ASPECT_HEIGHT = 3;
  const deriveHeightFromWidth = (widthValue) => Math.round((widthValue * THUMB_ASPECT_HEIGHT) / THUMB_ASPECT_WIDTH);
  const deriveWidthFromHeight = (heightValue) => Math.round((heightValue * THUMB_ASPECT_WIDTH) / THUMB_ASPECT_HEIGHT);
  const sortedSections = [...(library.sections || [])].sort((a, b) => {
    const left = (a?.title || '').toLowerCase();
    const right = (b?.title || '').toLowerCase();
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });

  const handleThumbnailWidthChange = (nextValue) => {
    const rawValue = typeof nextValue === 'string' ? nextValue : String(nextValue ?? '');
    setLibrary((state) => {
      const trimmed = rawValue.trim();
      let nextHeight = state.form.image_cache_thumb_height ?? '';
      const numeric = Number.parseInt(trimmed, 10);
      if (trimmed === '') {
        nextHeight = '';
      } else if (!Number.isNaN(numeric)) {
        const derived = deriveHeightFromWidth(numeric);
        nextHeight = String(derived);
      }
      return {
        ...state,
        form: {
          ...state.form,
          image_cache_thumb_width: trimmed,
          image_cache_thumb_height: nextHeight,
        },
        feedback: null,
      };
    });
  };

  const handleThumbnailHeightChange = (nextValue) => {
    const rawValue = typeof nextValue === 'string' ? nextValue : String(nextValue ?? '');
    setLibrary((state) => {
      const trimmed = rawValue.trim();
      let nextWidth = state.form.image_cache_thumb_width ?? '';
      const numeric = Number.parseInt(trimmed, 10);
      if (trimmed === '') {
        nextWidth = '';
      } else if (!Number.isNaN(numeric)) {
        const derived = deriveWidthFromHeight(numeric);
        nextWidth = String(derived);
      }
      return {
        ...state,
        form: {
          ...state.form,
          image_cache_thumb_height: trimmed,
          image_cache_thumb_width: nextWidth,
        },
        feedback: null,
      };
    });
  };

  const handleThumbnailQualityChange = (nextValue) => {
    const rawValue = typeof nextValue === 'string' ? nextValue : String(nextValue ?? '');
    setLibrary((state) => ({
      ...state,
      form: {
        ...state.form,
        image_cache_thumb_quality: rawValue.trim(),
      },
      feedback: null,
    }));
  };

  const handleToggleSection = (identifier) => {
    if (!identifier) {
      return;
    }
    setLibrary((state) => {
      const currentHidden = normalizeHiddenSections(state.form.hidden_sections);
      const nextSet = new Set(currentHidden);
      if (nextSet.has(identifier)) {
        nextSet.delete(identifier);
      } else {
        nextSet.add(identifier);
      }
      const nextHidden = Array.from(nextSet).sort((a, b) => a.localeCompare(b));
      const updatedSections = mapLibrarySections(state.sections, new Set(nextHidden));
      return {
        ...state,
        form: {
          ...state.form,
          hidden_sections: nextHidden,
        },
        sections: updatedSections,
        feedback: null,
      };
    });
  };

  const handleSectionVisibilityChange = (identifier, visible) => {
    if (!identifier) {
      return;
    }
    setLibrary((state) => {
      const currentHidden = new Set(normalizeHiddenSections(state.form.hidden_sections));
      if (visible) {
        currentHidden.delete(identifier);
      } else {
        currentHidden.add(identifier);
      }
      const nextHidden = Array.from(currentHidden).sort((a, b) => a.localeCompare(b));
      const updatedSections = mapLibrarySections(state.sections, new Set(nextHidden));
      return {
        ...state,
        form: {
          ...state.form,
          hidden_sections: nextHidden,
        },
        sections: updatedSections,
        feedback: null,
      };
    });
  };

  const handlePageSizeChange = (value) => {
    const nextPageSize = clampLibraryPageSize(
      value,
      library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE,
    );
    setLibrary((state) => ({
      ...state,
      form: {
        ...state.form,
        section_page_size: nextPageSize,
      },
      feedback: null,
    }));
  };

  const handleHomeRowLimitChange = (value) => {
    const nextLimit = clampHomeRowLimit(
      value,
      library.defaults.home_row_limit ?? DEFAULT_HOME_ROW_LIMIT,
    );
    setLibrary((state) => ({
      ...state,
      form: {
        ...state.form,
        home_row_limit: nextLimit,
      },
      feedback: null,
    }));
  };

  const handleDefaultViewChange = (view) => {
    const normalized = normalizeSectionView(view, library.defaults.default_section_view ?? 'library');
    setLibrary((state) => ({
      ...state,
      form: {
        ...state.form,
        default_section_view: normalized,
      },
      feedback: null,
    }));
  };

  const handleSaveLibrary = async () => {
    const currentHidden = normalizeHiddenSections(library.form.hidden_sections);
    const originalHidden = normalizeHiddenSections(library.data.hidden_sections);
    const hiddenChanged =
      currentHidden.length !== originalHidden.length
      || currentHidden.some((value, index) => value !== originalHidden[index]);
    const finalWidth = thumbnailWidth;
    const finalHeight = deriveHeightFromWidth(finalWidth);
    const preparedForm = {
      ...library.form,
      hidden_sections: hiddenChanged ? currentHidden : library.data.hidden_sections,
      section_page_size: clampLibraryPageSize(
        library.form.section_page_size,
        library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE,
      ),
      home_row_limit: clampHomeRowLimit(
        library.form.home_row_limit,
        library.defaults.home_row_limit ?? DEFAULT_HOME_ROW_LIMIT,
      ),
      default_section_view: normalizeSectionView(
        library.form.default_section_view,
        library.defaults.default_section_view ?? 'library',
      ),
      image_cache_thumb_width: finalWidth,
      image_cache_thumb_height: finalHeight,
      image_cache_thumb_quality: thumbnailQuality,
    };

    const diff = computeDiff(library.data, preparedForm);
    if (Object.keys(diff).length === 0) {
      setLibrary((state) => ({
        ...state,
        feedback: { tone: 'info', message: 'No changes to save.' },
      }));
      return;
    }

    setLibrary((state) => ({
      ...state,
      feedback: { tone: 'info', message: 'Saving…' },
    }));

    try {
      const updated = await updateSystemSettings('library', diff);
      const updatedDefaults = sanitizeLibraryRecord(updated?.defaults || {}, DEFAULT_LIBRARY_PAGE_SIZE);
      const fallback = updatedDefaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE;
      const updatedSettings = sanitizeLibraryRecord(updated?.settings || {}, fallback);
      const updatedForm = prepareForm(updatedDefaults, updatedSettings);
      const nextHidden = normalizeHiddenSections(updatedForm.hidden_sections);
      setLibrary((state) => ({
        ...state,
        loading: false,
        data: updatedSettings,
        defaults: updatedDefaults,
        form: updatedForm,
        feedback: { tone: 'success', message: 'Library settings saved.' },
        sections: mapLibrarySections(state.sections, new Set(nextHidden)),
      }));
      void reloadLibrarySections();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save settings.';
      setLibrary((state) => ({
        ...state,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleRefreshHomeSnapshot = async () => {
    const rowLimit = clampHomeRowLimit(
      library.form.home_row_limit,
      library.defaults.home_row_limit ?? DEFAULT_HOME_ROW_LIMIT,
    );
    setLibrary((state) => ({
      ...state,
      homeRefresh: true,
      homeRefreshError: null,
      feedback: null,
    }));
    try {
      const response = await buildPlexHomeSnapshot({
        async: true,
        row_limit: rowLimit,
        force_refresh: true,
      });
      const queued = response?.status === 'queued';
      setLibrary((state) => ({
        ...state,
        homeRefresh: false,
        homeRefreshError: null,
        feedback: {
          tone: 'success',
          message: queued ? 'Home metadata caching queued.' : 'Home metadata cached.',
        },
      }));
      if (!queued && response?.sections) {
        // Nothing additional for now; placeholder for future.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to cache home metadata.';
      setLibrary((state) => ({
        ...state,
        homeRefresh: false,
        homeRefreshError: message,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleClearHomeSnapshot = async () => {
    setLibrary((state) => ({
      ...state,
      homeSnapshotClear: true,
      homeSnapshotClearError: null,
      feedback: null,
    }));
    try {
      await clearPlexHomeSnapshot();
      setLibrary((state) => ({
        ...state,
        homeSnapshotClear: false,
        homeSnapshotClearError: null,
        feedback: { tone: 'success', message: 'Home metadata cache cleared.' },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to clear home metadata cache.';
      setLibrary((state) => ({
        ...state,
        homeSnapshotClear: false,
        homeSnapshotClearError: message,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleCacheHomeImages = async () => {
    const rowLimit = clampHomeRowLimit(
      library.form.home_row_limit,
      library.defaults.home_row_limit ?? DEFAULT_HOME_ROW_LIMIT,
    );
    const detailParams = { width: 600, height: 900, min: 1, upscale: 1 };
    const derivedGridHeight = deriveHeightFromWidth(thumbnailWidth);
    const gridParams = {
      width: String(thumbnailWidth),
      height: String(derivedGridHeight),
      upscale: 1,
    };

    setLibrary((state) => ({
      ...state,
      homeImageCache: {
        ...(state.homeImageCache || {}),
        loading: true,
        cancelling: false,
        taskId: null,
        startedAt: Date.now(),
        width: thumbnailWidth,
        height: thumbnailHeight,
        quality: thumbnailQuality,
      },
      homeImageCacheError: null,
    }));

    try {
      const response = await cachePlexHomeImages({
        async: true,
        row_limit: rowLimit,
        detail_params: detailParams,
        grid_params: gridParams,
      });
      const taskId = response?.task_id || null;
      const shouldTrack = Boolean(taskId);
      setLibrary((state) => ({
        ...state,
        homeImageCache: {
          ...(state.homeImageCache || {}),
          loading: shouldTrack,
          cancelling: false,
          taskId,
          startedAt: state.homeImageCache?.startedAt ?? Date.now(),
          width: thumbnailWidth,
          height: thumbnailHeight,
          quality: thumbnailQuality,
        },
        homeImageCacheError: null,
        feedback: {
          tone: 'success',
          message: taskId ? 'Home artwork caching queued.' : 'Home artwork cached.',
        },
      }));
      if (taskId) {
        loadTasksSettings({ refresh: true, preserveForm: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to queue home artwork caching.';
      setLibrary((state) => ({
        ...state,
        homeImageCache: {
          ...(state.homeImageCache || {}),
          loading: false,
          cancelling: false,
          taskId: state.homeImageCache?.taskId ?? null,
        },
        homeImageCacheError: message,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleCancelHomeImages = async () => {
    const taskId = library.homeImageCache?.taskId;
    if (!taskId) {
      return;
    }
    setLibrary((state) => ({
      ...state,
      homeImageCache: {
        ...(state.homeImageCache || {}),
        loading: true,
        cancelling: true,
        taskId,
      },
    }));
    try {
      await stopTask(taskId, { terminate: true });
      setLibrary((state) => ({
        ...state,
        homeImageCache: {
          ...(state.homeImageCache || {}),
          loading: false,
          cancelling: false,
          taskId: null,
          cancelledAt: Date.now(),
        },
        feedback: {
          tone: 'success',
          message: 'Home artwork caching cancelled.',
        },
      }));
      loadTasksSettings({ refresh: true, preserveForm: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to cancel home artwork caching.';
      setLibrary((state) => ({
        ...state,
        homeImageCache: {
          ...(state.homeImageCache || {}),
          loading: false,
          cancelling: false,
          taskId,
        },
        homeImageCacheError: message,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleRefreshSectionCache = async (section) => {
    const sectionKey = resolveSectionKey(section);
    if (!sectionKey) {
      return;
    }
    const sectionTitle = section?.title || 'Library section';
    const fallbackPageSize = library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE;
    const pageSize = clampLibraryPageSize(
      library.form.section_page_size,
      fallbackPageSize,
    );
    setLibrary((state) => ({
      ...state,
      sectionRefresh: {
        ...(state.sectionRefresh || {}),
        [sectionKey]: true,
      },
      sectionRefreshError: {
        ...(state.sectionRefreshError || {}),
        [sectionKey]: null,
      },
    }));
    try {
      await buildPlexSectionSnapshot(sectionKey, {
        reason: 'manual',
        sort: LIBRARY_DEFAULT_SORT,
        page_size: pageSize,
        parallelism: SNAPSHOT_PARALLELISM,
        async: true,
        reset: true,
      });
      setLibrary((state) => ({
        ...state,
        sectionRefresh: {
          ...(state.sectionRefresh || {}),
          [sectionKey]: false,
        },
        sectionRefreshError: {
          ...(state.sectionRefreshError || {}),
          [sectionKey]: null,
        },
        feedback: {
          tone: 'success',
          message: `Section cache refresh queued for ${sectionTitle}.`,
        },
      }));
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to refresh section cache.';
      setLibrary((state) => ({
        ...state,
        sectionRefresh: {
          ...(state.sectionRefresh || {}),
          [sectionKey]: false,
        },
        sectionRefreshError: {
          ...(state.sectionRefreshError || {}),
          [sectionKey]: message,
        },
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleClearSectionCache = async (section) => {
    const sectionKey = resolveSectionKey(section);
    if (!sectionKey) {
      return;
    }
    const sectionTitle = section?.title || 'Library section';
    setLibrary((state) => ({
      ...state,
      sectionSnapshotClear: {
        ...(state.sectionSnapshotClear || {}),
        [sectionKey]: true,
      },
      sectionSnapshotClearError: {
        ...(state.sectionSnapshotClearError || {}),
        [sectionKey]: null,
      },
    }));
    try {
      await clearPlexSectionSnapshot(sectionKey);
      setLibrary((state) => ({
        ...state,
        sectionSnapshotClear: {
          ...(state.sectionSnapshotClear || {}),
          [sectionKey]: false,
        },
        sectionSnapshotClearError: {
          ...(state.sectionSnapshotClearError || {}),
          [sectionKey]: null,
        },
        sectionRefresh: {
          ...(state.sectionRefresh || {}),
          [sectionKey]: false,
        },
        feedback: {
          tone: 'success',
          message: `Section metadata cache cleared for ${sectionTitle}.`,
        },
      }));
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to clear metadata cache.';
      setLibrary((state) => ({
        ...state,
        sectionSnapshotClear: {
          ...(state.sectionSnapshotClear || {}),
          [sectionKey]: false,
        },
        sectionSnapshotClearError: {
          ...(state.sectionSnapshotClearError || {}),
          [sectionKey]: message,
        },
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleCacheSectionImages = async (section) => {
    const sectionKey = resolveSectionKey(section);
    if (!sectionKey) {
      return;
    }
    const sectionTitle = section?.title || 'Library section';
    const fallbackPageSize = library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE;
    const pageSize = clampLibraryPageSize(
      library.form.section_page_size,
      fallbackPageSize,
    );
    const detailParams = { width: 600, height: 900, min: 1, upscale: 1 };
    const derivedGridHeight = deriveHeightFromWidth(thumbnailWidth);
    const gridParams = {
      width: String(thumbnailWidth),
      height: String(derivedGridHeight),
      upscale: 1,
    };

    setLibrary((state) => ({
      ...state,
      sectionImageCache: {
        ...(state.sectionImageCache || {}),
        [sectionKey]: {
          ...(state.sectionImageCache?.[sectionKey] || {}),
          loading: true,
          cancelling: false,
          taskId: null,
          startedAt: Date.now(),
          width: thumbnailWidth,
          height: thumbnailHeight,
          quality: thumbnailQuality,
        },
      },
      sectionImageCacheError: {
        ...(state.sectionImageCacheError || {}),
        [sectionKey]: null,
      },
    }));

    try {
      const response = await cachePlexSectionImages(sectionKey, {
        async: true,
        page_size: pageSize,
        detail_params: detailParams,
        grid_params: gridParams,
      });
      const taskId = response?.task_id || null;
      setLibrary((state) => ({
        ...state,
        sectionImageCache: {
          ...(state.sectionImageCache || {}),
          [sectionKey]: {
            ...(state.sectionImageCache?.[sectionKey] || {}),
            loading: true,
            cancelling: false,
            taskId,
            startedAt: state.sectionImageCache?.[sectionKey]?.startedAt ?? Date.now(),
            width: thumbnailWidth,
            height: thumbnailHeight,
            quality: thumbnailQuality,
          },
        },
        sectionImageCacheError: {
          ...(state.sectionImageCacheError || {}),
          [sectionKey]: null,
        },
        feedback: {
          tone: 'success',
          message: `Section artwork caching queued for ${sectionTitle}.`,
        },
      }));
      if (taskId) {
        loadTasksSettings({ refresh: true, preserveForm: true });
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Unable to queue artwork caching.';
      setLibrary((state) => ({
        ...state,
        sectionImageCache: {
          ...(state.sectionImageCache || {}),
          [sectionKey]: {
            ...(state.sectionImageCache?.[sectionKey] || {}),
            loading: false,
            cancelling: false,
            taskId: state.sectionImageCache?.[sectionKey]?.taskId ?? null,
          },
        },
        sectionImageCacheError: {
          ...(state.sectionImageCacheError || {}),
          [sectionKey]: message,
        },
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleCancelSectionImages = async (section, taskId) => {
    if (!taskId) {
      return;
    }
    const sectionKey = resolveSectionKey(section);
    if (!sectionKey) {
      return;
    }
    const sectionTitle = section?.title || 'Library section';

    setLibrary((state) => ({
      ...state,
      sectionImageCache: {
        ...(state.sectionImageCache || {}),
        [sectionKey]: {
          ...(state.sectionImageCache?.[sectionKey] || {}),
          loading: true,
          cancelling: true,
          taskId,
        },
      },
    }));

    try {
      await stopTask(taskId, { terminate: true });
      setLibrary((state) => ({
        ...state,
        sectionImageCache: {
          ...(state.sectionImageCache || {}),
          [sectionKey]: {
            ...(state.sectionImageCache?.[sectionKey] || {}),
            loading: false,
            cancelling: false,
            taskId: null,
            cancelledAt: Date.now(),
          },
        },
        feedback: {
          tone: 'success',
          message: `Artwork caching cancelled for ${sectionTitle}.`,
        },
      }));
      loadTasksSettings({ refresh: true, preserveForm: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to cancel artwork caching.';
      setLibrary((state) => ({
        ...state,
        sectionImageCache: {
          ...(state.sectionImageCache || {}),
          [sectionKey]: {
            ...(state.sectionImageCache?.[sectionKey] || {}),
            loading: false,
            cancelling: false,
            taskId,
          },
        },
        sectionImageCacheError: {
          ...(state.sectionImageCacheError || {}),
          [sectionKey]: message,
        },
        feedback: { tone: 'error', message },
      }));
    }
  };

  const hiddenSections = normalizeHiddenSections(library.form.hidden_sections);
  const homeImageCacheState = library.homeImageCache ?? {};
  const isHomeCachingImages = Boolean(homeImageCacheState.loading);
  const isHomeCancellingImages = Boolean(homeImageCacheState.cancelling);
  const homeImageTaskId = homeImageCacheState.taskId || null;

  return (
    <SectionContainer title="Library settings">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Cache page size"
          type="number"
          value={currentPageSize}
          onChange={handlePageSizeChange}
          helpText="Number of Plex items fetched per chunk (1-1000)."
        />
        <TextField
          label="Home row limit"
          type="number"
          value={currentHomeRowLimit}
          onChange={handleHomeRowLimitChange}
          helpText={`Number of items fetched per home row (${HOME_ROW_LIMIT_MIN}-${HOME_ROW_LIMIT_MAX}).`}
        />
      </div>

      <div className="mt-4">
        <SelectField
          label="Default section view"
          value={
            normalizeSectionView(
              library.form.default_section_view ?? library.defaults.default_section_view ?? 'library',
            )
          }
          onChange={handleDefaultViewChange}
          options={LIBRARY_SECTION_VIEWS.map((option) => ({
            value: option,
            label:
              option === 'recommended'
                ? 'Recommended'
                : option === 'collections'
                  ? 'Collections'
                  : 'Library',
          }))}
          helpText="Initial layout when opening a Plex section."
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <TextField
          label="Cache thumbnail width"
          type="number"
          value={library.form.image_cache_thumb_width ?? ''}
          onChange={handleThumbnailWidthChange}
          helpText="Grid thumbnail width (px)."
        />
        <TextField
          label="Cache thumbnail height"
          type="number"
          value={library.form.image_cache_thumb_height ?? ''}
          onChange={handleThumbnailHeightChange}
          helpText="Grid thumbnail height (px)."
        />
        <TextField
          label="Cache thumbnail quality"
          type="number"
          value={library.form.image_cache_thumb_quality ?? ''}
          onChange={handleThumbnailQualityChange}
          helpText="JPEG quality for cached thumbnails (10-100)."
        />
      </div>

      <div className="mt-6 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Home page</h3>
          <p className="text-xs text-muted">
            Prefetch metadata and artwork used by the library home dashboard.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => {
              void handleRefreshHomeSnapshot();
            }}
            disabled={library.homeRefresh || library.homeSnapshotClear}
            className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FontAwesomeIcon
              icon={library.homeRefresh ? faCircleNotch : faArrowsRotate}
              spin={library.homeRefresh}
              className="text-[10px]"
            />
            {library.homeRefresh ? 'Caching…' : 'Cache Metadata'}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleClearHomeSnapshot();
            }}
            disabled={library.homeSnapshotClear || library.homeRefresh}
            className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FontAwesomeIcon
              icon={library.homeSnapshotClear ? faCircleNotch : faBroom}
              spin={library.homeSnapshotClear}
              className="text-[10px]"
            />
            {library.homeSnapshotClear ? 'Clearing…' : 'Clear Metadata'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (isHomeCachingImages && homeImageTaskId) {
                void handleCancelHomeImages();
              } else {
                void handleCacheHomeImages();
              }
            }}
            disabled={isHomeCachingImages && !homeImageTaskId}
            className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FontAwesomeIcon
              icon={isHomeCachingImages ? faCircleNotch : faImage}
              spin={isHomeCachingImages}
              className="text-[10px]"
            />
            {isHomeCachingImages
              ? isHomeCancellingImages
                ? 'Cancelling…'
                : homeImageTaskId
                  ? 'Cancel'
                  : 'Caching…'
              : 'Cache Images'}
          </button>
        </div>
        {library.homeRefreshError ? (
          <p className="text-[11px] text-rose-300">{library.homeRefreshError}</p>
        ) : null}
        {library.homeSnapshotClearError ? (
          <p className="text-[11px] text-rose-300">{library.homeSnapshotClearError}</p>
        ) : null}
        {library.homeImageCacheError ? (
          <p className="text-[11px] text-rose-300">{library.homeImageCacheError}</p>
        ) : null}
      </div>

      <div>
        <div className="mt-6 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">Sections</h3>
          <button
            type="button"
            onClick={() => {
              void reloadLibrarySections();
            }}
            disabled={library.sectionsLoading}
            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-200 transition hover:text-amber-100 disabled:text-subtle"
          >
            {library.sectionsLoading ? (
              <>
                <FontAwesomeIcon icon={faCircleNotch} spin className="text-xs" />
                Refreshing…
              </>
            ) : (
              'Refresh'
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Toggle visibility to control which Plex sections appear in the Library browser.
        </p>
        {library.sectionsError ? (
          <p className="mt-3 text-xs text-rose-300">{library.sectionsError}</p>
        ) : null}
        <div className="mt-4 space-y-3">
          {library.sectionsLoading && !sortedSections.length ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <FontAwesomeIcon icon={faCircleNotch} spin />
              Loading sections…
            </div>
          ) : null}
          {!library.sectionsLoading && !sortedSections.length ? (
            <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-center text-sm text-muted">
              No sections returned from Plex. Connect a server and refresh to manage visibility.
            </div>
          ) : null}
          {sortedSections.map((section, index) => {
            const identifier = section?.identifier;
            const isHidden = Boolean(section?.is_hidden);
            const sizeCandidate = section?.size ?? section?.total_size ?? section?.totalSize ?? section?.count;
            const numericSize = Number(sizeCandidate);
            const hasValidSize = Number.isFinite(numericSize) && sizeCandidate !== null && sizeCandidate !== undefined;
            const sizeValue = hasValidSize ? Math.max(0, numericSize) : null;
            const sizeLabel = sizeValue !== null
              ? `${sizeValue.toLocaleString()} ${sizeValue === 1 ? 'item' : 'items'}`
              : 'Unknown size';
            const sectionTitle = section?.title || 'Untitled section';
            const sectionType = section?.type ? section.type.toUpperCase() : 'UNKNOWN';
            const key = identifier || `section-${index}`;
            const sectionKey = resolveSectionKey(section);
            const refreshKey = sectionKey || identifier || null;
            const isRefreshing = refreshKey ? Boolean(library.sectionRefresh?.[refreshKey]) : false;
            const refreshError = refreshKey ? library.sectionRefreshError?.[refreshKey] : null;
            const isClearing = refreshKey ? Boolean(library.sectionSnapshotClear?.[refreshKey]) : false;
            const clearError = refreshKey ? library.sectionSnapshotClearError?.[refreshKey] : null;
            const imageCacheState = refreshKey ? library.sectionImageCache?.[refreshKey] : null;
            const isCachingImages = Boolean(imageCacheState?.loading);
            const isCancellingImages = Boolean(imageCacheState?.cancelling);
            const activeTaskId = imageCacheState?.taskId || null;
            const imageCacheError = refreshKey ? library.sectionImageCacheError?.[refreshKey] : null;
            return (
              <div
                key={key}
                role="button"
                tabIndex={identifier ? 0 : -1}
                onClick={() => {
                  if (!identifier) {
                    return;
                  }
                  handleToggleSection(identifier);
                }}
                onKeyDown={(event) => {
                  if (!identifier) {
                    return;
                  }
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleToggleSection(identifier);
                  }
                }}
                className={`flex w-full items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition ${
                  isHidden
                    ? 'border-border/60 bg-background/40 text-muted hover:border-border'
                    : 'border-border bg-background text-foreground hover:border-amber-400'
                } ${identifier ? '' : 'cursor-not-allowed opacity-60'}`}
              >
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-foreground">{sectionTitle}</span>
                  <span className="text-xs text-muted">{sectionType} · {sizeLabel}</span>
                  {identifier ? null : (
                    <span className="text-[11px] text-rose-300">Cannot toggle this section because it lacks a stable identifier.</span>
                  )}
                  {refreshError ? (
                    <span className="text-[11px] text-rose-300">{refreshError}</span>
                  ) : null}
                  {clearError ? (
                    <span className="text-[11px] text-rose-300">{clearError}</span>
                  ) : null}
                  {imageCacheError ? (
                    <span className="text-[11px] text-rose-300">{imageCacheError}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        void handleRefreshSectionCache(section);
                      }}
                      disabled={isRefreshing || isClearing || !refreshKey}
                      className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FontAwesomeIcon
                        icon={isRefreshing ? faCircleNotch : faArrowsRotate}
                        spin={isRefreshing}
                        className="text-[10px]"
                      />
                      {isRefreshing ? 'Caching…' : 'Cache Metadata'}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        void handleClearSectionCache(section);
                      }}
                      disabled={isClearing || isRefreshing || !refreshKey}
                      className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FontAwesomeIcon
                        icon={isClearing ? faCircleNotch : faBroom}
                        spin={isClearing}
                        className="text-[10px]"
                      />
                      {isClearing ? 'Clearing…' : 'Clear Metadata'}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        if (isCachingImages && activeTaskId) {
                          void handleCancelSectionImages(section, activeTaskId);
                        } else {
                          void handleCacheSectionImages(section);
                        }
                      }}
                      disabled={!refreshKey}
                      className="flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FontAwesomeIcon
                        icon={isCachingImages ? faCircleNotch : faImage}
                        spin={isCachingImages}
                        className="text-[10px]"
                      />
                      {isCachingImages
                        ? isCancellingImages
                          ? 'Cancelling…'
                          : 'Cancel'
                        : 'Cache Images'}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      handleSectionVisibilityChange(identifier, isHidden);
                    }}
                    className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${
                      isHidden
                        ? 'border-border/50 text-muted hover:border-emerald-300 hover:text-emerald-200'
                        : 'border-emerald-300 text-emerald-200 hover:border-emerald-200 hover:text-emerald-100'
                    }`}
                    disabled={!identifier}
                  >
                    <FontAwesomeIcon icon={isHidden ? faEyeSlash : faEye} className="text-xs" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Feedback message={library.feedback?.message} tone={library.feedback?.tone} />
        <DiffButton onClick={handleSaveLibrary}>Save changes</DiffButton>
      </div>
    </SectionContainer>
  );
}
