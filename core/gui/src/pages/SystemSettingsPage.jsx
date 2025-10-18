import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchGroups,
  fetchSystemSettings,
  fetchUsers,
  restartService,
  updateSystemSettings,
  previewTranscoderCommand,
  cachePlexSectionImages,
  buildPlexSectionSnapshot,
  clearPlexSectionSnapshot,
  fetchPlexSections,
} from '../lib/api.js';
import TranscoderSection, {
  filterTranscoderValues,
  normalizeTranscoderForm,
  normalizeTranscoderRecord,
} from '../features/systemSettings/sections/TranscoderSection.jsx';
import PlayerSection, {
  PLAYER_DEFAULT_SETTINGS,
  clonePlayerSettings,
  sanitizePlayerRecord,
} from '../features/systemSettings/sections/PlayerSection.jsx';
import LibrarySection, {
  DEFAULT_LIBRARY_PAGE_SIZE,
  clampLibraryPageSize,
  mapLibrarySections,
  normalizeHiddenSections,
  normalizeSectionView,
  resolveSectionKey,
  sanitizeLibraryRecord,
} from '../features/systemSettings/sections/LibrarySection.jsx';
import TasksSection, {
  TASK_DEFAULT_REFRESH_INTERVAL,
  cloneTasksForm,
  hasTaskChanges,
  sanitizeTasksRecord,
} from '../features/systemSettings/sections/TasksSection.jsx';
import SystemSection from '../features/systemSettings/sections/SystemSection.jsx';
import RedisSection, { sanitizeRedisRecord } from '../features/systemSettings/sections/RedisSection.jsx';
import PlexSection from '../features/systemSettings/sections/PlexSection.jsx';
import ChatSection from '../features/systemSettings/sections/ChatSection.jsx';
import UsersSection from '../features/systemSettings/sections/UsersSection.jsx';
import GroupsSection from '../features/systemSettings/sections/GroupsSection.jsx';
import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  SelectField,
  SelectWithCustomField,
  TextAreaField,
  TextField,
  computeDiff,
  prepareForm,
} from '../features/systemSettings/shared.jsx';

const SECTIONS = [
  { id: 'system', label: 'System' },
  { id: 'transcoder', label: 'Transcoder' },
  { id: 'player', label: 'Player' },
  { id: 'ingest', label: 'Ingest' },
  { id: 'plex', label: 'Plex' },
  { id: 'library', label: 'Library' },
  { id: 'redis', label: 'Redis' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'users', label: 'Users' },
  { id: 'groups', label: 'Groups' },
  { id: 'chat', label: 'Chat' },
];

const SYSTEM_SERVICES = [
  {
    id: 'api',
    label: 'API',
    description: 'Flask backend and realtime gateway.',
  },
  {
    id: 'transcoder',
    label: 'Transcoder',
    description: 'FFmpeg orchestrator and worker queue.',
  },
  {
    id: 'ingest',
    label: 'Ingest',
    description: 'Segment server for /media endpoints.',
  },
];

const INGEST_ALLOWED_KEYS = [
  'OUTPUT_DIR',
  'RETENTION_SEGMENTS',
  'TRANSCODER_CORS_ORIGIN',
  'INGEST_ENABLE_PUT',
  'INGEST_ENABLE_DELETE',
  'INGEST_CACHE_MAX_AGE',
  'INGEST_CACHE_EXTENSIONS',
];
const INGEST_KEY_SET = new Set(INGEST_ALLOWED_KEYS);

function filterIngestValues(values) {
  return Object.fromEntries(
    Object.entries(values || {}).filter(([key]) => INGEST_KEY_SET.has(key)),
  );
}

function normalizeIngestRecord(values) {
  const record = { ...values };
  record.OUTPUT_DIR = record.OUTPUT_DIR !== undefined && record.OUTPUT_DIR !== null
    ? String(record.OUTPUT_DIR).trim()
    : '';
  const retentionRaw = record.RETENTION_SEGMENTS;
  if (retentionRaw === undefined || retentionRaw === null || retentionRaw === '') {
    record.RETENTION_SEGMENTS = '';
  } else {
    const parsed = Number.parseInt(retentionRaw, 10);
    record.RETENTION_SEGMENTS = Number.isNaN(parsed) ? '' : Math.max(parsed, 0);
  }
  return record;
}



export default function SystemSettingsPage({ user }) {
  const [activeSection, setActiveSection] = useState('system');
  const [systemState, setSystemState] = useState({ statuses: {} });
  const [transcoder, setTranscoder] = useState({
    loading: true,
    data: {},
    defaults: {},
    form: {},
    effective: {},
    derived: {},
    feedback: null,
    previewCommand: '',
    previewArgs: [],
    previewLoading: false,
    previewError: null,
  });
  const [playerSettings, setPlayerSettings] = useState({
    loading: true,
    data: clonePlayerSettings(PLAYER_DEFAULT_SETTINGS),
    defaults: clonePlayerSettings(PLAYER_DEFAULT_SETTINGS),
    form: clonePlayerSettings(PLAYER_DEFAULT_SETTINGS),
    feedback: null,
    saving: false,
  });
  const [ingestSettings, setIngestSettings] = useState({
    loading: true,
    data: {},
    defaults: {},
    form: {},
    feedback: null,
  });
  const [chat, setChat] = useState({ loading: true, data: {}, defaults: {}, form: {}, feedback: null });
  const [plex, setPlex] = useState({
    loading: true,
    status: 'loading',
    account: null,
    server: null,
    feedback: null,
    hasToken: false,
    lastConnectedAt: null,
    saving: false,
    form: {
      serverUrl: '',
      token: '',
      verifySsl: true,
    },
  });
  const [library, setLibrary] = useState({
    loading: true,
    data: {},
    defaults: {},
    form: {},
    feedback: null,
    sections: [],
    sectionsLoading: false,
    sectionsError: null,
    sectionRefresh: {},
    sectionRefreshError: {},
    sectionSnapshotClear: {},
    sectionSnapshotClearError: {},
    sectionImageCache: {},
    sectionImageCacheError: {},
    homeRefresh: false,
    homeRefreshError: null,
    homeSnapshotClear: false,
    homeSnapshotClearError: null,
    homeImageCache: { loading: false, cancelling: false, taskId: null, startedAt: null },
    homeImageCacheError: null,
  });
  const [redisSettings, setRedisSettings] = useState({
    loading: true,
    data: {},
    defaults: {},
    feedback: null,
    snapshot: null,
    managedBy: 'environment',
  });
  const [tasksState, setTasksState] = useState({
    loading: false,
    loaded: false,
    data: { beat_jobs: [], refresh_interval_seconds: TASK_DEFAULT_REFRESH_INTERVAL },
    defaults: { beat_jobs: [], refresh_interval_seconds: TASK_DEFAULT_REFRESH_INTERVAL },
    form: { beat_jobs: [], refresh_interval_seconds: TASK_DEFAULT_REFRESH_INTERVAL },
    snapshot: null,
    feedback: null,
    saving: false,
    stopping: {},
  });
  const [userSettings, setUserSettings] = useState({
    loading: true,
    data: {},
    defaults: {},
    form: {},
    feedback: null,
  });
  const [groupsState, setGroupsState] = useState({ loading: true, items: [], permissions: [], feedback: null });
  const [usersState, setUsersState] = useState({ loading: true, items: [], feedback: null, pending: {} });
  const [userFilter, setUserFilter] = useState('');
  const isMountedRef = useRef(true);

useEffect(() => () => {
  isMountedRef.current = false;
}, []);

  useEffect(() => {
    if (activeSection === 'tasks') {
      // Surface current state in the console to speed up debugging.
      // eslint-disable-next-line no-console
      console.log('Tasks state updated', tasksState);
    }
  }, [activeSection, tasksState]);

  const loadTasksSettings = useCallback(
    ({ refresh = false, preserveForm = false } = {}) => {
      if (!refresh && tasksState.loading) {
        return;
      }
      setTasksState((state) => ({
        ...state,
        loading: true,
        feedback: refresh ? { tone: 'info', message: 'Refreshing status…' } : state.feedback,
      }));

      let cancelled = false;
      (async () => {
        try {
          const tasksData = await fetchSystemSettings('tasks');
          if (!isMountedRef.current || cancelled) {
            return;
          }
          // eslint-disable-next-line no-console
          console.log('Tasks fetch succeeded', tasksData);
          setTasksState((state) => {
            const nextDefaults = sanitizeTasksRecord(tasksData?.defaults || state.defaults);
            const nextSettings = sanitizeTasksRecord(tasksData?.settings || state.data, nextDefaults);
            const currentNormalized = sanitizeTasksRecord(
              {
                beat_jobs: Array.isArray(state.form?.beat_jobs) ? state.form.beat_jobs : [],
                refresh_interval_seconds: state.form?.refresh_interval_seconds,
              },
              nextDefaults,
            );
            const shouldResetForm = !preserveForm || !hasTaskChanges(currentNormalized, nextSettings);
            const snapshotError = tasksData?.snapshot_error ? String(tasksData.snapshot_error) : null;
            const feedback = snapshotError
              ? { tone: 'error', message: snapshotError }
              : refresh
                ? { tone: 'success', message: 'Task status refreshed.' }
                : null;
            // eslint-disable-next-line no-console
            console.log('Tasks state computed', {
              nextDefaults,
              nextSettings,
              shouldResetForm,
            });
            return {
              loading: false,
              loaded: true,
              data: nextSettings,
              defaults: nextDefaults,
              form: shouldResetForm ? cloneTasksForm(nextSettings) : state.form,
              snapshot: tasksData?.snapshot ?? state.snapshot,
              feedback,
              saving: false,
              stopping: {},
            };
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unable to load tasks.';
          if (!isMountedRef.current || cancelled) {
            return;
          }
          // eslint-disable-next-line no-console
          console.warn('Tasks fetch failed', err);
          setTasksState((state) => ({
            ...state,
            loading: false,
            loaded: true,
            feedback: { tone: 'error', message },
          }));
        }
      })();

      return () => {
        cancelled = true;
      };
    },
    [tasksState.loading],
  );

  const handleRestartService = useCallback((serviceId) => {
    const serviceMeta = SYSTEM_SERVICES.find((service) => service.id === serviceId);
    const friendlyName = serviceMeta?.label ?? serviceId;

    setSystemState((state) => {
      const nextStatuses = { ...state.statuses };
      if (nextStatuses[serviceId]?.state === 'pending') {
        return state;
      }
      nextStatuses[serviceId] = {
        state: 'pending',
        message: `Signalling ${friendlyName} to restart…`,
        timestamp: Date.now(),
      };
      return { statuses: nextStatuses };
    });

    (async () => {
      try {
        const response = await restartService(serviceId);
        const remoteStatus = typeof response?.status === 'string' ? response.status : '';
        const tail = serviceId === 'api'
          ? 'The dashboard may briefly disconnect while the API restarts.'
          : 'Allow a few seconds for the service to come back online.';
        const statusPrefix = remoteStatus
          ? `${remoteStatus.charAt(0).toUpperCase()}${remoteStatus.slice(1)}`
          : 'Restart signal sent';
        const successMessage = `${statusPrefix}. ${tail}`;

        setSystemState((state) => {
          const nextStatuses = { ...state.statuses };
          nextStatuses[serviceId] = {
            state: 'success',
            message: successMessage,
            timestamp: Date.now(),
          };
          return { statuses: nextStatuses };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to restart service.';
        setSystemState((state) => {
          const nextStatuses = { ...state.statuses };
          nextStatuses[serviceId] = {
            state: 'error',
            message,
            timestamp: Date.now(),
          };
          return { statuses: nextStatuses };
        });
      }
    })();
  }, [restartService]);

  const canAccess = useMemo(() => {
    if (!user) {
      return false;
    }
    if (user.is_admin) {
      return true;
    }
    const permSet = new Set(user.permissions || []);
    return permSet.has('system.settings.manage')
      || permSet.has('transcoder.settings.manage')
      || permSet.has('player.settings.manage')
      || permSet.has('ingest.settings.manage')
      || permSet.has('chat.settings.manage')
      || permSet.has('redis.settings.manage')
      || permSet.has('library.settings.manage')
      || permSet.has('tasks.manage')
      || permSet.has('users.manage');
  }, [user]);

  useEffect(() => {
    const snapshot = tasksState.snapshot || {};
    const collectIds = (entries) => {
      if (!Array.isArray(entries)) {
        return [];
      }
      return entries
        .map((task) => String(task?.id || '').trim())
        .filter((id) => id.length > 0);
    };

    const activeIds = new Set([
      ...collectIds(snapshot.active),
      ...collectIds(snapshot.reserved),
      ...collectIds(snapshot.scheduled),
    ]);

    if (activeIds.size === 0 && (!library.sectionImageCache || Object.keys(library.sectionImageCache).length === 0)) {
      return;
    }

    setLibrary((state) => {
      const cacheMap = state.sectionImageCache || {};
      let changed = false;
      const nextCache = { ...cacheMap };
      let feedback = state.feedback;

      Object.entries(cacheMap).forEach(([sectionId, info]) => {
        if (info?.loading && info.taskId && !activeIds.has(info.taskId)) {
          changed = true;
          const sectionTitle = state.sections
            ?.find((entry) => resolveSectionKey(entry) === sectionId)?.title
            || 'Library section';
          nextCache[sectionId] = {
            ...info,
            loading: false,
            cancelling: false,
            taskId: null,
            completedAt: Date.now(),
          };
          feedback = {
            tone: 'success',
            message: `Artwork caching completed for ${sectionTitle}.`,
          };
        }
      });

      if (!changed) {
        return state;
      }

      return {
        ...state,
        sectionImageCache: nextCache,
        feedback,
      };
    });
  }, [library.sectionImageCache, library.sections, tasksState.snapshot]);

  useEffect(() => {
    const entries = Object.values(library.sectionImageCache || {});
    const hasActive = entries.some((info) => info && info.loading && info.taskId);
    if (!hasActive) {
      return undefined;
    }

    let dispose = loadTasksSettings({ refresh: true, preserveForm: true });
    const interval = setInterval(() => {
      if (typeof dispose === 'function') {
        dispose();
      }
      dispose = loadTasksSettings({ refresh: true, preserveForm: true });
    }, 5000);

    return () => {
      if (typeof dispose === 'function') {
        dispose();
      }
      clearInterval(interval);
    };
  }, [library.sectionImageCache, loadTasksSettings]);

  const reloadLibrarySections = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }
    setLibrary((state) => ({
      ...state,
      sectionsLoading: true,
      sectionsError: null,
    }));
    try {
      const payload = await fetchPlexSections();
      if (!isMountedRef.current) {
        return;
      }
      setLibrary((state) => {
        const fallbackPageSize = state.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE;
        const rawServerSettings =
          payload?.library_settings !== undefined
            ? payload.library_settings
            : state.data;
        const serverSettings = sanitizeLibraryRecord(
          rawServerSettings,
          fallbackPageSize,
        );

        const hiddenList = normalizeHiddenSections(
          serverSettings.hidden_sections ?? state.form.hidden_sections,
        );

        const nextPageSize = clampLibraryPageSize(
          serverSettings.section_page_size ?? state.form.section_page_size ?? fallbackPageSize,
          fallbackPageSize,
        );

        const mappedSections = mapLibrarySections(
          Array.isArray(payload?.sections) ? payload.sections : [],
          new Set(hiddenList),
        );

        const identifiers = mappedSections
          .map((entry) => resolveSectionKey(entry))
          .filter((value) => typeof value === 'string' && value.length > 0);
        const existingRefresh = state.sectionRefresh || {};
        const existingErrors = state.sectionRefreshError || {};
        const existingClear = state.sectionSnapshotClear || {};
        const existingClearErrors = state.sectionSnapshotClearError || {};
        const nextRefresh = {};
        const nextErrors = {};
        const nextClear = {};
        const nextClearErrors = {};
        identifiers.forEach((id) => {
          nextRefresh[id] = Boolean(existingRefresh[id]);
          if (existingErrors[id]) {
            nextErrors[id] = existingErrors[id];
          }
          if (existingClear[id]) {
            nextClear[id] = Boolean(existingClear[id]);
          }
          if (existingClearErrors[id]) {
            nextClearErrors[id] = existingClearErrors[id];
          }
        });

        return {
          ...state,
          data: serverSettings,
          form: {
            ...state.form,
            hidden_sections: hiddenList,
            section_page_size: nextPageSize,
            image_cache_thumb_width: (() => {
              const fallback = library.defaults.image_cache_thumb_width ?? 320;
              const raw = serverSettings.image_cache_thumb_width
                ?? state.form.image_cache_thumb_width
                ?? fallback;
              const numeric = Number.parseInt(raw, 10);
              if (Number.isNaN(numeric)) {
                return fallback;
              }
              return Math.min(1920, Math.max(64, numeric));
            })(),
            image_cache_thumb_height: (() => {
              const fallback = library.defaults.image_cache_thumb_height ?? 480;
              const raw = serverSettings.image_cache_thumb_height
                ?? state.form.image_cache_thumb_height
                ?? fallback;
              const numeric = Number.parseInt(raw, 10);
              if (Number.isNaN(numeric)) {
                return fallback;
              }
              return Math.min(1920, Math.max(64, numeric));
            })(),
            image_cache_thumb_quality: (() => {
              const fallback = library.defaults.image_cache_thumb_quality ?? 80;
              const raw = serverSettings.image_cache_thumb_quality
                ?? state.form.image_cache_thumb_quality
                ?? fallback;
              const numeric = Number.parseInt(raw, 10);
              if (Number.isNaN(numeric)) {
                return fallback;
              }
              return Math.min(100, Math.max(10, numeric));
            })(),
          },
          sections: mappedSections,
          sectionsLoading: false,
          sectionsError: null,
          sectionRefresh: nextRefresh,
          sectionRefreshError: nextErrors,
          sectionSnapshotClear: nextClear,
          sectionSnapshotClearError: nextClearErrors,
        };
      });
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Unable to load Plex sections.';
      setLibrary((state) => ({
        ...state,
        sectionsLoading: false,
        sectionsError: message,
      }));
    } finally {
      if (isMountedRef.current) {
        setLibrary((state) => ({
          ...state,
          sectionsLoading: false,
        }));
      }
    }
  }, []);

  useEffect(() => {
    if (!canAccess) {
      return;
    }
    let ignore = false;
    async function load() {
      try {
        const [
          transcoderData,
          playerData,
          ingestData,
          chatData,
          usersData,
          plexData,
          libraryData,
          redisData,
        ] = await Promise.all([
          fetchSystemSettings('transcoder'),
          fetchSystemSettings('player'),
          fetchSystemSettings('ingest'),
          fetchSystemSettings('chat'),
          fetchSystemSettings('users'),
          fetchSystemSettings('plex'),
          fetchSystemSettings('library'),
          fetchSystemSettings('redis'),
        ]);
        if (ignore) {
          return;
        }
        const rawTranscoderDefaults = filterTranscoderValues(transcoderData?.defaults || {});
        const rawTranscoderSettings = filterTranscoderValues(transcoderData?.settings || {});
        const rawTranscoderEffective = filterTranscoderValues(transcoderData?.effective || {});
        const transcoderDefaults = normalizeTranscoderRecord(rawTranscoderDefaults);
        const transcoderSettings = normalizeTranscoderRecord(rawTranscoderSettings);
        const transcoderEffective = normalizeTranscoderRecord(rawTranscoderEffective);
        const hydratedTranscoderSettings = normalizeTranscoderRecord({
          ...transcoderEffective,
          ...transcoderSettings,
        });
        const transcoderForm = normalizeTranscoderForm(
          prepareForm(transcoderDefaults, hydratedTranscoderSettings),
        );

        setTranscoder({
          loading: false,
          data: transcoderSettings,
          defaults: transcoderDefaults,
          form: transcoderForm,
          effective: transcoderEffective,
          derived: transcoderData?.derived || {},
          feedback: null,
          previewCommand: transcoderData?.simulated_command ?? '',
          previewArgs: Array.isArray(transcoderData?.simulated_command_argv)
            ? transcoderData.simulated_command_argv
            : [],
          previewLoading: false,
          previewError: null,
        });
        const playerDefaults = sanitizePlayerRecord(playerData?.defaults || PLAYER_DEFAULT_SETTINGS);
        const playerSanitized = sanitizePlayerRecord(playerData?.settings || playerDefaults);
        setPlayerSettings({
          loading: false,
          data: playerSanitized,
          defaults: playerDefaults,
          form: clonePlayerSettings(playerSanitized),
          feedback: null,
          saving: false,
        });
        const ingestDefaults = normalizeIngestRecord(filterIngestValues(ingestData?.defaults || {}));
        const ingestCurrent = normalizeIngestRecord(filterIngestValues(ingestData?.settings || {}));
        setIngestSettings({
          loading: false,
          data: ingestCurrent,
          defaults: ingestDefaults,
          form: prepareForm(ingestDefaults, ingestCurrent),
          feedback: null,
        });
        setChat({
          loading: false,
          data: chatData?.settings || {},
          defaults: chatData?.defaults || {},
          form: prepareForm(chatData?.defaults || {}, chatData?.settings || {}),
          feedback: null,
        });
        setUserSettings({
          loading: false,
          data: usersData?.settings || {},
          defaults: usersData?.defaults || {},
          form: prepareForm(usersData?.defaults || {}, usersData?.settings || {}),
          feedback: null,
        });
        setGroupsState((state) => ({
          ...state,
          loading: false,
          items: usersData?.groups || [],
          permissions: usersData?.permissions || [],
          feedback: null,
        }));
        const plexSettings = plexData?.settings || {};
        setPlex({
          loading: false,
          status: plexSettings.status || (plexSettings.has_token ? 'connected' : 'disconnected'),
          account: plexSettings.account || null,
          server: plexSettings.server || null,
          feedback: null,
          hasToken: Boolean(plexSettings.has_token),
          lastConnectedAt: plexSettings.last_connected_at || null,
          saving: false,
          form: {
            serverUrl: plexSettings.server_base_url || '',
            token: '',
            verifySsl: plexSettings.verify_ssl !== undefined ? Boolean(plexSettings.verify_ssl) : true,
          },
        });
        const libraryDefaults = sanitizeLibraryRecord(
          libraryData?.defaults || {},
          DEFAULT_LIBRARY_PAGE_SIZE,
        );
        const fallbackPageSize = libraryDefaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE;
        const librarySettings = sanitizeLibraryRecord(
          libraryData?.settings || {},
          fallbackPageSize,
        );
        const libraryForm = prepareForm(libraryDefaults, librarySettings);
        const hiddenIdentifiers = normalizeHiddenSections(libraryForm.hidden_sections);
        const initialSections = mapLibrarySections(
          Array.isArray(libraryData?.sections) ? libraryData.sections : [],
          new Set(hiddenIdentifiers),
        );
        setLibrary({
          loading: false,
          data: librarySettings,
          defaults: libraryDefaults,
          form: libraryForm,
          feedback: libraryData?.sections_error
            ? { tone: 'error', message: libraryData.sections_error }
            : null,
          sections: initialSections,
          sectionsLoading: Array.isArray(libraryData?.sections) ? false : true,
          sectionsError: libraryData?.sections_error || null,
          sectionRefresh: {},
          sectionRefreshError: {},
          sectionSnapshotClear: {},
          sectionSnapshotClearError: {},
          sectionImageCache: {},
          sectionImageCacheError: {},
          homeRefresh: false,
          homeRefreshError: null,
          homeSnapshotClear: false,
          homeSnapshotClearError: null,
          homeImageCache: { loading: false, cancelling: false, taskId: null, startedAt: null },
          homeImageCacheError: null,
        });
        if (!Array.isArray(libraryData?.sections)) {
          void reloadLibrarySections();
        }
        const redisDefaults = sanitizeRedisRecord(redisData?.defaults || {});
        const redisSanitized = sanitizeRedisRecord(redisData?.settings || {}, redisDefaults);
        setRedisSettings({
          loading: false,
          data: redisSanitized,
          defaults: redisDefaults,
          feedback: null,
          snapshot: redisData?.redis_snapshot ?? null,
          managedBy: redisData?.managed_by || 'environment',
        });
      } catch (exc) {
        if (!ignore) {
          const message = exc instanceof Error ? exc.message : 'Unable to load settings';
          setTranscoder((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setPlayerSettings((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setChat((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setUserSettings((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setPlex((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setLibrary({
            loading: false,
            data: {},
            defaults: {},
            form: {},
            feedback: { tone: 'error', message },
            sections: [],
            sectionsLoading: false,
            sectionsError: message,
            sectionRefresh: {},
            sectionRefreshError: {},
            sectionSnapshotClear: {},
            sectionSnapshotClearError: {},
            sectionImageCache: {},
            sectionImageCacheError: {},
            homeRefresh: false,
            homeRefreshError: message,
            homeSnapshotClear: false,
            homeSnapshotClearError: null,
            homeImageCache: { loading: false, cancelling: false, taskId: null, startedAt: null },
            homeImageCacheError: null,
          });
          setRedisSettings({
            loading: false,
            data: {},
            defaults: {},
            feedback: { tone: 'error', message },
            snapshot: null,
            managedBy: 'environment',
          });
        }
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, [canAccess, reloadLibrarySections]);

  useEffect(() => {
    if (!canAccess || transcoder.loading) {
      return;
    }
    const publishOverride = typeof transcoder.form?.TRANSCODER_PUBLISH_BASE_URL === 'string'
      ? transcoder.form.TRANSCODER_PUBLISH_BASE_URL.trim()
      : '';
    const fallbackPublish = typeof transcoder.defaults?.TRANSCODER_PUBLISH_BASE_URL === 'string'
      ? transcoder.defaults.TRANSCODER_PUBLISH_BASE_URL.trim()
      : '';
    const hasPublish = (publishOverride || fallbackPublish).length > 0;
    if (!hasPublish) {
      const message = 'No publish base URL is available. Update your system defaults or provide an ingest endpoint.';
      setTranscoder((state) => {
        if (
          state.previewLoading === false
          && state.previewCommand === ''
          && state.previewError === message
        ) {
          return state;
        }
        return {
          ...state,
          previewLoading: false,
          previewCommand: '',
          previewArgs: [],
          previewError: message,
        };
      });
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(() => {
      setTranscoder((state) => ({
        ...state,
        previewLoading: true,
        previewError: null,
      }));
      previewTranscoderCommand(transcoder.form)
        .then((result) => {
          if (cancelled) {
            return;
          }
          setTranscoder((state) => ({
            ...state,
            previewLoading: false,
            previewCommand: result?.command ?? '',
            previewArgs: Array.isArray(result?.argv) ? result.argv : [],
          }));
        })
        .catch((err) => {
          if (cancelled) {
            return;
          }
          const message = err instanceof Error ? err.message : 'Unable to preview command.';
          setTranscoder((state) => ({
            ...state,
            previewLoading: false,
            previewError: message,
          }));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [canAccess, transcoder.loading, transcoder.form, transcoder.defaults, previewTranscoderCommand]);

  useEffect(() => {
    if (!canAccess) {
      return;
    }
    let ignore = false;
    async function loadUsersAndGroups() {
      try {
        const [groupData, userData] = await Promise.all([fetchGroups(), fetchUsers()]);
        if (ignore) {
          return;
        }
        setGroupsState({
          loading: false,
          items: groupData?.groups || [],
          permissions: groupData?.permissions || [],
          feedback: null,
        });
        setUsersState({
          loading: false,
          items: userData?.users || [],
          feedback: null,
          pending: {},
        });
      } catch (exc) {
        if (!ignore) {
          const message = exc instanceof Error ? exc.message : 'Unable to load user data';
          setGroupsState((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setUsersState((state) => ({ ...state, loading: false, feedback: { tone: 'error', message }, pending: {} }));
        }
      }
    }
    void loadUsersAndGroups();
    return () => {
      ignore = true;
    };
  }, [canAccess]);

  useEffect(() => {
    if (activeSection === 'tasks' && !tasksState.loaded && !tasksState.loading && canAccess) {
      const disposer = loadTasksSettings({ preserveForm: false });
      return () => {
        if (typeof disposer === 'function') {
          disposer();
        }
      };
    }
    return undefined;
  }, [activeSection, tasksState.loaded, tasksState.loading, canAccess, loadTasksSettings]);

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        You do not have permission to manage system settings.
      </div>
    );
  }

    const renderIngest = () => {
    if (ingestSettings.loading) {
      return <div className="text-sm text-muted">Loading ingest settings…</div>;
    }

    const form = ingestSettings.form;

    const handlePathChange = (next) => {
      setIngestSettings((state) => ({
        ...state,
        form: { ...state.form, OUTPUT_DIR: next },
      }));
    };

    const handleRetentionChange = (next) => {
      setIngestSettings((state) => {
        let resolved = state.form?.RETENTION_SEGMENTS ?? '';
        if (typeof next === 'number') {
          resolved = Math.max(next, 0);
        } else if (typeof next === 'string') {
          const trimmed = next.trim();
          if (!trimmed.length) {
            resolved = '';
          } else {
            const parsed = Number.parseInt(trimmed, 10);
            if (!Number.isNaN(parsed)) {
              resolved = Math.max(parsed, 0);
            }
          }
        }
        return {
          ...state,
          form: { ...state.form, RETENTION_SEGMENTS: resolved },
        };
      });
    };

    const handleToggleChange = (key) => (checked) => {
      setIngestSettings((state) => ({
        ...state,
        form: { ...state.form, [key]: Boolean(checked) },
      }));
    };

    const handleCorsChange = (next) => {
      setIngestSettings((state) => ({
        ...state,
        form: { ...state.form, TRANSCODER_CORS_ORIGIN: typeof next === 'string' ? next : String(next ?? '') },
      }));
    };

    const handleCacheMaxAgeChange = (next) => {
      setIngestSettings((state) => {
        let value = next;
        if (typeof next === 'string') {
          const trimmed = next.trim();
          if (!trimmed.length) {
            value = '';
          } else {
            const parsed = Number.parseInt(trimmed, 10);
            value = Number.isNaN(parsed) ? state.form?.INGEST_CACHE_MAX_AGE ?? '' : Math.max(parsed, 0);
          }
        } else if (typeof next === 'number') {
          value = Math.max(next, 0);
        } else {
          value = state.form?.INGEST_CACHE_MAX_AGE ?? '';
        }
        return {
          ...state,
          form: { ...state.form, INGEST_CACHE_MAX_AGE: value },
        };
      });
    };

    const handleExtensionsChange = (next) => {
      setIngestSettings((state) => ({
        ...state,
        form: { ...state.form, INGEST_CACHE_EXTENSIONS: typeof next === 'string' ? next : String(next ?? '') },
      }));
    };

    return (
      <SectionContainer title="Ingest settings">
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="Local output path"
              value={form.OUTPUT_DIR ?? ''}
              onChange={handlePathChange}
              helpText="Absolute path on the ingest host where manifests and segments are served from"
            />
            <TextField
              label="Retention window (segments)"
              type="number"
              value={form.RETENTION_SEGMENTS === '' ? '' : form.RETENTION_SEGMENTS ?? ''}
              onChange={handleRetentionChange}
              helpText="Minimum number of segments to keep per representation before pruning (0 disables pruning)."
            />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <BooleanField
              label="Allow PUT uploads"
              value={Boolean(form.INGEST_ENABLE_PUT)}
              onChange={handleToggleChange('INGEST_ENABLE_PUT')}
              helpText="Enable authenticated clients to upload new segments via HTTP PUT."
            />
            <BooleanField
              label="Allow DELETE requests"
              value={Boolean(form.INGEST_ENABLE_DELETE)}
              onChange={handleToggleChange('INGEST_ENABLE_DELETE')}
              helpText="Allow the publisher to remove stale segments. Disable in read-only deployments."
            />
            <TextField
              label="CORS origin"
              value={form.TRANSCODER_CORS_ORIGIN ?? ''}
              onChange={handleCorsChange}
              helpText="Comma separated origin(s) allowed to fetch media (use * to allow all)."
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="Cache max age (seconds)"
              type="number"
              value={form.INGEST_CACHE_MAX_AGE === '' ? '' : form.INGEST_CACHE_MAX_AGE ?? ''}
              onChange={handleCacheMaxAgeChange}
              helpText="Default Cache-Control max-age header for cached media types."
            />
            <TextAreaField
              label="Cache extensions"
              value={form.INGEST_CACHE_EXTENSIONS ?? ''}
              onChange={handleExtensionsChange}
              rows={3}
              helpText="List of file extensions (comma or newline separated) that should receive Cache-Control headers."
            />
          </div>
          <p className="text-xs text-muted">
            Provide the path exactly as it exists on the ingest service machine. When running ingest remotely,
            this should match the filesystem layout on that host. Restart ingest and transcoder after changing it
            so both pick up the new location.
          </p>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <Feedback message={ingestSettings.feedback?.message} tone={ingestSettings.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(ingestSettings.data, ingestSettings.form);
              if (Object.keys(diff).length === 0) {
                setIngestSettings((state) => ({
                  ...state,
                  feedback: { tone: 'info', message: 'No changes to save.' },
                }));
                return;
              }
              setIngestSettings((state) => ({
                ...state,
                feedback: { tone: 'info', message: 'Saving…' },
              }));
              try {
                const updated = await updateSystemSettings('ingest', diff);
                const updatedDefaults = normalizeIngestRecord(
                  filterIngestValues(updated?.defaults || ingestSettings.defaults),
                );
                const updatedSettings = normalizeIngestRecord(
                  filterIngestValues(updated?.settings || ingestSettings.data),
                );
                setIngestSettings({
                  loading: false,
                  data: updatedSettings,
                  defaults: updatedDefaults,
                  form: prepareForm(updatedDefaults, updatedSettings),
                  feedback: { tone: 'success', message: 'Ingest settings saved.' },
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to save ingest settings.';
                setIngestSettings((state) => ({
                  ...state,
                  feedback: { tone: 'error', message },
                }));
              }
            }}
          >
            Save changes
          </DiffButton>
        </div>
      </SectionContainer>
    );
  };

  const renderRedis = () => {
    if (redisSettings.loading) {
      return <div className="text-sm text-muted">Loading Redis settings…</div>;
    }

    const defaults = sanitizeRedisRecord(redisSettings.defaults || {});
    const current = sanitizeRedisRecord(redisSettings.data || {}, defaults);
    const snapshot = redisSettings.snapshot || {};
    const redisAvailable = Boolean(snapshot.available);
    const lastError = snapshot.last_error || (redisAvailable ? null : 'Redis URL not configured');
    const managedBy = String(redisSettings.managedBy || 'environment');

    const resolvedUrl = current.redis_url ?? defaults.redis_url ?? '';
    const resolvedMaxEntries = current.max_entries ?? defaults.max_entries ?? 0;
    const resolvedTtlSeconds = current.ttl_seconds ?? defaults.ttl_seconds ?? 0;
    const statusLabel = redisAvailable ? 'Connected' : 'Unavailable';
    const managerLabel = managedBy === 'environment' ? 'Environment variables' : managedBy;

    return (
      <SectionContainer title="Redis status">
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Redis URL"
            value={resolvedUrl}
            disabled
            readOnly
            helpText="Managed via environment (e.g. TRANSCODER_REDIS_URL)."
          />
          <TextField
            label="Max entries"
            type="number"
            value={String(resolvedMaxEntries)}
            disabled
            readOnly
            helpText="Total cached payloads to retain. Set via TRANSCODER_REDIS_MAX_ENTRIES."
          />
          <TextField
            label="TTL (seconds)"
            type="number"
            value={String(resolvedTtlSeconds)}
            disabled
            readOnly
            helpText="Expiration time for cached entries. Set via TRANSCODER_REDIS_TTL_SECONDS."
          />
        </div>
        <div className="mt-4 space-y-2 text-xs text-muted">
          <p>
            <span className="font-semibold text-foreground">Connection status:</span>{' '}
            {statusLabel}
            {lastError ? (
              <span className="ml-1 text-rose-300">({lastError})</span>
            ) : null}
          </p>
          <p>
            <span className="font-semibold text-foreground">Managed by:</span>{' '}
            {managerLabel}
          </p>
          {!redisAvailable ? (
            <p className="text-rose-300">
              Redis is required for caching, chat, and task coordination. Update the environment configuration
              and restart the services to restore connectivity.
            </p>
          ) : null}
        </div>
        <div className="mt-4 text-xs text-muted">
          <p>
            Environment-managed settings apply at startup. Edit your `.env` or deployment variables and restart
            the API/transcoder services to change Redis connectivity.
          </p>
        </div>
        {redisSettings.feedback ? (
          <div className="mt-4 text-xs">
            <Feedback {...redisSettings.feedback} />
          </div>
        ) : null}
      </SectionContainer>
    );
  };


  return (
    <div className="flex h-full w-full min-h-0 bg-background text-foreground">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border/80 bg-surface/80">
        <header className="flex min-h-[56px] items-center border-b border-border/60 px-4 py-3">
          <span className="text-sm font-semibold uppercase tracking-wide text-subtle">System Settings</span>
        </header>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-2">
            {SECTIONS.map((section) => {
              const isActive = activeSection === section.id;
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                      isActive
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border/70 bg-surface/70 text-muted hover:border-accent/60 hover:text-foreground'
                    }`}
                  >
                    <span className="truncate text-sm font-semibold">{section.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-10">
        {activeSection === 'system'
          ? (
            <SystemSection
              systemState={systemState}
              onRestartService={handleRestartService}
            />
          )
          : null}
        {activeSection === 'transcoder'
          ? (
            <TranscoderSection
              transcoder={transcoder}
              setTranscoder={setTranscoder}
            />
          )
          : null}
        {activeSection === 'player'
          ? (
            <PlayerSection
              playerSettings={playerSettings}
              setPlayerSettings={setPlayerSettings}
            />
          )
          : null}
        {activeSection === 'ingest' ? renderIngest() : null}
        {activeSection === 'library'
          ? (
            <LibrarySection
              library={library}
              setLibrary={setLibrary}
              reloadLibrarySections={reloadLibrarySections}
              loadTasksSettings={loadTasksSettings}
            />
          )
          : null}
        {activeSection === 'redis'
          ? (
            <RedisSection
              redisSettings={redisSettings}
            />
          )
          : null}
        {activeSection === 'tasks'
          ? (
            <TasksSection
              tasksState={tasksState}
              setTasksState={setTasksState}
              loadTasksSettings={loadTasksSettings}
              isMountedRef={isMountedRef}
            />
          )
          : null}
        {activeSection === 'plex'
          ? (
            <PlexSection
              plex={plex}
              setPlex={setPlex}
            />
          )
          : null}
        {activeSection === 'users'
          ? (
            <UsersSection
              userSettings={userSettings}
              setUserSettings={setUserSettings}
              usersState={usersState}
              setUsersState={setUsersState}
              groupsState={groupsState}
              userFilter={userFilter}
              setUserFilter={setUserFilter}
            />
          )
          : null}
        {activeSection === 'groups'
          ? (
            <GroupsSection
              groupsState={groupsState}
              setGroupsState={setGroupsState}
            />
          )
          : null}
        {activeSection === 'chat'
          ? (
            <ChatSection
              chat={chat}
              setChat={setChat}
            />
          )
          : null}
      </div>
    </div>
  );
}
