import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleNotch, faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons';
import {
  fetchGroups,
  fetchSystemSettings,
  fetchUsers,
  updateGroup,
  updateSystemSettings,
  updateUserGroups,
  connectPlex,
  disconnectPlex,
  previewTranscoderCommand,
  fetchPlexSections,
} from '../lib/api.js';
import { getGroupBadgeStyles, getGroupChipStyles } from '../lib/groupColors.js';

const SECTIONS = [
  { id: 'transcoder', label: 'Transcoder' },
  { id: 'plex', label: 'Plex' },
  { id: 'library', label: 'Library' },
  { id: 'users', label: 'Users' },
  { id: 'groups', label: 'Groups' },
  { id: 'chat', label: 'Chat' },
];

const LIBRARY_PAGE_SIZE_MIN = 1;
const LIBRARY_PAGE_SIZE_MAX = 1000;
const DEFAULT_LIBRARY_PAGE_SIZE = 500;
const LIBRARY_SECTION_VIEWS = ['recommended', 'library', 'collections'];

function clampLibraryPageSize(value, fallback = DEFAULT_LIBRARY_PAGE_SIZE) {
  const base = Number.isFinite(fallback) ? Number(fallback) : DEFAULT_LIBRARY_PAGE_SIZE;
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return Math.min(LIBRARY_PAGE_SIZE_MAX, Math.max(LIBRARY_PAGE_SIZE_MIN, base));
  }
  return Math.min(LIBRARY_PAGE_SIZE_MAX, Math.max(LIBRARY_PAGE_SIZE_MIN, numeric));
}

function normalizeSectionView(value, fallback = 'library') {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (LIBRARY_SECTION_VIEWS.includes(candidate)) {
    return candidate;
  }
  return LIBRARY_SECTION_VIEWS.includes(fallback) ? fallback : 'library';
}

function normalizeHiddenSections(raw) {
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

function mapLibrarySections(sections, hiddenIdentifiers) {
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

function sanitizeLibraryRecord(record, fallback = DEFAULT_LIBRARY_PAGE_SIZE) {
  const normalized = { ...(record || {}) };
  normalized.hidden_sections = normalizeHiddenSections(normalized.hidden_sections);
  normalized.section_page_size = clampLibraryPageSize(
    normalized.section_page_size ?? fallback,
    fallback,
  );
  normalized.default_section_view = normalizeSectionView(normalized.default_section_view ?? 'library');
  return normalized;
}

function SectionContainer({ title, children }) {
  return (
    <section className="panel-card p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-4 space-y-4 text-sm text-muted">{children}</div>
    </section>
  );
}

function BooleanField({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(event) => onChange?.(event.target.checked)}
        className="h-4 w-4 text-amber-400 focus:outline-none"
      />
    </label>
  );
}

function TextField({ label, value, onChange, type = 'text', placeholder, helpText }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
      />
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

function SelectField({ label, value, onChange, options, helpText }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <select
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

function TextAreaField({ label, value, onChange, placeholder, disabled = false, rows = 3, helpText }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <textarea
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        rows={rows}
        disabled={disabled}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
          disabled ? 'opacity-60' : ''
        }`}
      />
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

function SelectWithCustomField({
  label,
  rawValue,
  options,
  onSelect,
  onCustomChange,
  customType = 'text',
  customPlaceholder,
  helpText,
  customHelpText,
}) {
  const normalizedValue = rawValue ?? '';
  const optionValues = options.map((option) => option.value);
  const selection = optionValues.includes(normalizedValue) ? normalizedValue : 'custom';
  const extendedOptions = [...options, { value: 'custom', label: 'Custom…' }];

  return (
    <div className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-subtle">
      <span>{label}</span>
      <select
        value={selection}
        onChange={(event) => onSelect?.(event.target.value)}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
      >
        {extendedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {selection === 'custom' ? (
        <input
          type={customType}
          value={normalizedValue}
          placeholder={customPlaceholder}
          onChange={(event) => onCustomChange?.(event.target.value)}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
        />
      ) : null}
      {selection === 'custom' && customHelpText ? (
        <span className="text-[11px] font-normal text-muted normal-case">{customHelpText}</span>
      ) : null}
      {selection !== 'custom' && helpText ? (
        <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span>
      ) : null}
    </div>
  );
}

function DiffButton({ onClick, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-amber-400 px-5 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:border-border disabled:text-subtle"
    >
      {children}
    </button>
  );
}

function Feedback({ message, tone = 'info' }) {
  if (!message) {
    return null;
  }
  const toneClasses = {
    info: 'text-amber-200',
    error: 'text-rose-300',
    success: 'text-emerald-300',
  };
  return <p className={`text-xs ${toneClasses[tone] || toneClasses.info}`}>{message}</p>;
}

function prepareForm(defaults, current) {
  const merged = { ...defaults, ...current };
  return Object.keys(merged).reduce((acc, key) => {
    acc[key] = merged[key];
    return acc;
  }, {});
}

function computeDiff(original, current) {
  const diff = {};
  Object.keys(current).forEach((key) => {
    if (current[key] !== original[key]) {
      diff[key] = current[key];
    }
  });
  return diff;
}

const TRANSCODER_ALLOWED_KEYS = [
  'TRANSCODER_PUBLISH_BASE_URL',
  'VIDEO_CODEC',
  'VIDEO_BITRATE',
  'VIDEO_MAXRATE',
  'VIDEO_BUFSIZE',
  'VIDEO_PRESET',
  'VIDEO_PROFILE',
  'VIDEO_TUNE',
  'VIDEO_GOP_SIZE',
  'VIDEO_KEYINT_MIN',
  'VIDEO_SC_THRESHOLD',
  'VIDEO_VSYNC',
  'VIDEO_FILTERS',
  'VIDEO_EXTRA_ARGS',
  'VIDEO_SCALE',
  'AUDIO_CODEC',
  'AUDIO_BITRATE',
  'AUDIO_CHANNELS',
  'AUDIO_SAMPLE_RATE',
  'AUDIO_PROFILE',
  'AUDIO_FILTERS',
  'AUDIO_EXTRA_ARGS',
];

const TRANSCODER_KEY_SET = new Set(TRANSCODER_ALLOWED_KEYS);

const VIDEO_SCALE_OPTIONS = [
  { value: 'source', label: 'Source (no scaling)' },
  { value: '1080p', label: '1080p (scale=1920:-2)' },
  { value: '720p', label: '720p (scale=1280:-2)' },
  { value: 'custom', label: 'Custom filters' },
];

const SCALE_PRESET_FILTERS = {
  source: '',
  '1080p': 'scale=1920:-2',
  '720p': 'scale=1280:-2',
};

const VIDEO_CODEC_OPTIONS = [
  { value: 'libx264', label: 'libx264 (H.264)' },
  { value: 'libx265', label: 'libx265 (HEVC)' },
  { value: 'h264_nvenc', label: 'h264_nvenc (NVIDIA H.264)' },
  { value: 'hevc_nvenc', label: 'hevc_nvenc (NVIDIA HEVC)' },
  { value: 'h264_qsv', label: 'h264_qsv (Intel H.264)' },
  { value: 'hevc_qsv', label: 'hevc_qsv (Intel HEVC)' },
];

const VIDEO_PRESET_OPTIONS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
].map((value) => ({ value, label: value }));

const VIDEO_FIELD_CONFIG = [
  { key: 'VIDEO_BITRATE', label: 'Bitrate', type: 'text', helpText: "Target bitrate (e.g. 5M)" },
  { key: 'VIDEO_MAXRATE', label: 'Max Rate', type: 'text', helpText: "Peak bitrate cap (e.g. 5M)" },
  { key: 'VIDEO_BUFSIZE', label: 'Buffer Size', type: 'text', helpText: "VBV buffer size (e.g. 10M)" },
  { key: 'VIDEO_PROFILE', label: 'Profile', type: 'text', helpText: "Encoder profile name (e.g. high)" },
  { key: 'VIDEO_TUNE', label: 'Tune', type: 'text', helpText: "FFmpeg tune flag (e.g. zerolatency)" },
  { key: 'VIDEO_GOP_SIZE', label: 'GOP Size', type: 'number', helpText: 'Distance between keyframes in frames (e.g. 48)' },
  { key: 'VIDEO_KEYINT_MIN', label: 'Keyint Min', type: 'number', helpText: 'Minimum keyframe interval in frames' },
  { key: 'VIDEO_SC_THRESHOLD', label: 'Scene Change Threshold', type: 'number', helpText: 'FFmpeg -sc_threshold value (0 disables scene cuts)' },
  { key: 'VIDEO_VSYNC', label: 'VSync', type: 'text', helpText: "FFmpeg vsync value (e.g. 1)" },
];

const AUDIO_CODEC_OPTIONS = [
  { value: 'aac', label: 'aac (Advanced Audio Coding)' },
  { value: 'ac3', label: 'ac3 (Dolby Digital)' },
  { value: 'eac3', label: 'eac3 (Dolby Digital Plus)' },
  { value: 'libopus', label: 'libopus (Opus)' },
  { value: 'flac', label: 'flac' },
];

const AUDIO_PROFILE_OPTIONS = [
  { value: 'aac_low', label: 'aac_low (LC)' },
  { value: 'aac_he', label: 'aac_he (HE-AAC)' },
  { value: 'aac_he_v2', label: 'aac_he_v2 (HE-AAC v2)' },
  { value: 'aac_ld', label: 'aac_ld (Low Delay)' },
  { value: 'aac_eld', label: 'aac_eld (Enhanced Low Delay)' },
];

const AUDIO_SAMPLE_RATE_OPTIONS = [
  { value: '32000', label: '32,000 Hz' },
  { value: '44100', label: '44,100 Hz' },
  { value: '48000', label: '48,000 Hz' },
  { value: '88200', label: '88,200 Hz' },
  { value: '96000', label: '96,000 Hz' },
];

const AUDIO_FIELD_CONFIG = [
  { key: 'AUDIO_BITRATE', label: 'Bitrate', type: 'text', helpText: "Audio bitrate (e.g. 192k)" },
  { key: 'AUDIO_CHANNELS', label: 'Channels', type: 'number', helpText: 'Number of output channels (e.g. 2 for stereo)' },
];

function filterTranscoderValues(values) {
  return Object.fromEntries(
    Object.entries(values || {}).filter(([key]) => TRANSCODER_KEY_SET.has(key)),
  );
}

function normalizeSequenceValue(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((item) => String(item)).join('\n');
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function normalizeTranscoderRecord(values) {
  const record = { ...values };
  const rawScale = record.VIDEO_SCALE !== undefined ? String(record.VIDEO_SCALE).toLowerCase() : undefined;
  if (!rawScale) {
    record.VIDEO_SCALE = '720p';
  } else if (VIDEO_SCALE_OPTIONS.some((option) => option.value === rawScale)) {
    record.VIDEO_SCALE = rawScale;
  } else {
    record.VIDEO_SCALE = 'custom';
  }

  ['VIDEO_FILTERS', 'VIDEO_EXTRA_ARGS', 'AUDIO_FILTERS', 'AUDIO_EXTRA_ARGS'].forEach((key) => {
    record[key] = normalizeSequenceValue(record[key]);
  });

  ['VIDEO_GOP_SIZE', 'VIDEO_KEYINT_MIN', 'VIDEO_SC_THRESHOLD', 'AUDIO_CHANNELS', 'AUDIO_SAMPLE_RATE'].forEach((key) => {
    if (record[key] === '' || record[key] === null || record[key] === undefined) {
      record[key] = '';
      return;
    }
    const parsed = Number(record[key]);
    record[key] = Number.isNaN(parsed) ? record[key] : parsed;
  });

  return record;
}

function normalizeTranscoderForm(values) {
  const record = normalizeTranscoderRecord(values);
  const scale = record.VIDEO_SCALE || '720p';
  if (scale !== 'custom' && SCALE_PRESET_FILTERS[scale] !== undefined) {
    record.VIDEO_FILTERS = SCALE_PRESET_FILTERS[scale];
  }
  return record;
}

export default function SystemSettingsPage({ user }) {
  const [activeSection, setActiveSection] = useState('transcoder');
  const [transcoder, setTranscoder] = useState({
    loading: true,
    data: {},
    defaults: {},
    form: {},
    feedback: null,
    previewCommand: '',
    previewArgs: [],
    previewLoading: false,
    previewError: null,
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

  const filteredUsers = useMemo(() => {
    const query = userFilter.trim().toLowerCase();
    if (!query) {
      return usersState.items;
    }
    return usersState.items.filter((account) => {
      const username = String(account?.username ?? '').toLowerCase();
      const email = String(account?.email ?? '').toLowerCase();
      return username.includes(query) || email.includes(query);
    });
  }, [userFilter, usersState.items]);

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
        || permSet.has('chat.settings.manage')
        || permSet.has('library.settings.manage')
        || permSet.has('users.manage');
  }, [user]);

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

        return {
          ...state,
          data: serverSettings,
          form: {
            ...state.form,
            hidden_sections: hiddenList,
            section_page_size: nextPageSize,
          },
          sections: mappedSections,
          sectionsLoading: false,
          sectionsError: null,
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
        const [transcoderData, chatData, usersData, plexData, libraryData] = await Promise.all([
          fetchSystemSettings('transcoder'),
          fetchSystemSettings('chat'),
          fetchSystemSettings('users'),
          fetchSystemSettings('plex'),
          fetchSystemSettings('library'),
        ]);
        if (ignore) {
          return;
        }
        const transcoderDefaults = normalizeTranscoderRecord(
          filterTranscoderValues(transcoderData?.defaults || {}),
        );
        const transcoderSettings = normalizeTranscoderRecord(
          filterTranscoderValues(transcoderData?.settings || {}),
        );

        const transcoderForm = normalizeTranscoderForm(
          prepareForm(transcoderDefaults, transcoderSettings),
        );

        setTranscoder({
          loading: false,
          data: transcoderSettings,
          defaults: transcoderDefaults,
          form: transcoderForm,
          feedback: null,
          previewCommand: transcoderData?.simulated_command ?? '',
          previewArgs: Array.isArray(transcoderData?.simulated_command_argv)
            ? transcoderData.simulated_command_argv
            : [],
          previewLoading: false,
          previewError: null,
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
        });
        if (!Array.isArray(libraryData?.sections)) {
          void reloadLibrarySections();
        }
      } catch (exc) {
        if (!ignore) {
          const message = exc instanceof Error ? exc.message : 'Unable to load settings';
          setTranscoder((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
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
  }, [canAccess, transcoder.loading, transcoder.form, previewTranscoderCommand]);

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

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        You do not have permission to manage system settings.
      </div>
    );
  }

  const renderTranscoder = () => {
    if (transcoder.loading) {
      return <div className="text-sm text-muted">Loading transcoder settings…</div>;
    }
    const form = transcoder.form;
    const previewArgs = Array.isArray(transcoder.previewArgs) ? transcoder.previewArgs : [];
    let formattedPreview = transcoder.previewCommand || '';
    if (previewArgs.length) {
      formattedPreview = previewArgs
        .map((arg, index) => (index === 0 ? arg : `  ${arg}`))
        .join(" \\n");
    }
    const previewLoading = Boolean(transcoder.previewLoading);
    const previewError = transcoder.previewError;

    const videoScale = String(form.VIDEO_SCALE || '720p');
    const isCustomScale = videoScale === 'custom';

    const handleFieldChange = (key, rawValue, type = 'text') => {
      setTranscoder((state) => {
        const nextForm = { ...state.form };
        let value = rawValue;
        if (type === 'number') {
          if (typeof rawValue === 'string') {
            const trimmed = rawValue.trim();
            value = trimmed === '' ? '' : Number(trimmed);
          } else if (rawValue === null || rawValue === undefined) {
            value = '';
          } else if (Number.isNaN(Number(rawValue))) {
            value = '';
          } else {
            value = Number(rawValue);
          }
        }
        nextForm[key] = value;
        return { ...state, form: nextForm };
      });
    };

    const handleScaleChange = (nextScale) => {
      setTranscoder((state) => {
        const nextForm = { ...state.form, VIDEO_SCALE: nextScale };
        if (nextScale !== 'custom') {
          nextForm.VIDEO_FILTERS = SCALE_PRESET_FILTERS[nextScale] ?? '';
        }
        return { ...state, form: nextForm };
      });
    };

    const handleSelectWithCustom = (key, selection, type = 'text') => {
      if (selection === 'custom') {
        handleFieldChange(key, '', type);
      } else {
        handleFieldChange(key, selection, type);
      }
    };

    return (
      <SectionContainer title="Transcoder settings">
        <div className="space-y-6">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Publish</h3>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <TextField
                label="Publish Base URL"
                value={form.TRANSCODER_PUBLISH_BASE_URL ?? ''}
                onChange={(next) => handleFieldChange('TRANSCODER_PUBLISH_BASE_URL', next)}
                helpText="Full base URL where segments are published (e.g. https://example.com/dash/)"
              />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Video Encoding</h3>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <SelectField
                label="Scale"
                value={videoScale}
                onChange={handleScaleChange}
                options={VIDEO_SCALE_OPTIONS}
                helpText="Select a preset scaling filter or choose Custom to enter filters manually"
              />
              <SelectWithCustomField
                label="Codec"
                rawValue={form.VIDEO_CODEC ?? ''}
                options={VIDEO_CODEC_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('VIDEO_CODEC', choice)}
                onCustomChange={(next) => handleFieldChange('VIDEO_CODEC', next)}
                helpText="FFmpeg encoder name (e.g. libx264, h264_nvenc)"
                customHelpText="Enter the encoder name exactly as FFmpeg expects (e.g. libx265)"
              />
              <SelectWithCustomField
                label="Preset"
                rawValue={form.VIDEO_PRESET ?? ''}
                options={VIDEO_PRESET_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('VIDEO_PRESET', choice)}
                onCustomChange={(next) => handleFieldChange('VIDEO_PRESET', next)}
                helpText="Encoder speed/quality preset"
                customHelpText="Provide a preset string understood by the selected encoder"
              />
              {VIDEO_FIELD_CONFIG.map(({ key, label, type, helpText: hint }) => (
                <TextField
                  key={key}
                  label={label}
                  type={type}
                  value={form[key] ?? ''}
                  onChange={(next) => handleFieldChange(key, next, type)}
                  helpText={hint}
                />
              ))}
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <TextAreaField
                label="Filters"
                value={form.VIDEO_FILTERS ?? ''}
                onChange={(next) => handleFieldChange('VIDEO_FILTERS', next)}
                placeholder={isCustomScale ? 'One filter per line (e.g. scale=1280:-2)' : 'Preset filter applied automatically'}
                disabled={!isCustomScale}
                rows={3}
                helpText={
                  isCustomScale
                    ? 'Each line is appended to -filter:v (e.g. scale=1280:-2)'
                    : 'Scale presets manage this filter; choose Custom to override.'
                }
              />
              <TextAreaField
                label="Extra Arguments"
                value={form.VIDEO_EXTRA_ARGS ?? ''}
                onChange={(next) => handleFieldChange('VIDEO_EXTRA_ARGS', next)}
                placeholder="One argument per line"
                rows={3}
                helpText="Newline separated; each entry is appended after video options"
              />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Audio Encoding</h3>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <SelectWithCustomField
                label="Codec"
                rawValue={form.AUDIO_CODEC ?? ''}
                options={AUDIO_CODEC_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('AUDIO_CODEC', choice)}
                onCustomChange={(next) => handleFieldChange('AUDIO_CODEC', next)}
                helpText="FFmpeg audio encoder (e.g. aac, libopus)"
                customHelpText="Enter the encoder name exactly as FFmpeg expects"
              />
              <SelectWithCustomField
                label="Profile"
                rawValue={form.AUDIO_PROFILE ?? ''}
                options={AUDIO_PROFILE_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('AUDIO_PROFILE', choice)}
                onCustomChange={(next) => handleFieldChange('AUDIO_PROFILE', next)}
                helpText="Codec-specific profile (e.g. aac_low)"
                customHelpText="Enter the profile flag supported by the chosen encoder"
              />
              <SelectWithCustomField
                label="Sample Rate"
                rawValue={
                  form.AUDIO_SAMPLE_RATE !== undefined && form.AUDIO_SAMPLE_RATE !== null
                    ? String(form.AUDIO_SAMPLE_RATE)
                    : ''
                }
                options={AUDIO_SAMPLE_RATE_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('AUDIO_SAMPLE_RATE', choice, 'number')}
                onCustomChange={(next) => handleFieldChange('AUDIO_SAMPLE_RATE', next, 'number')}
                customType="number"
                customPlaceholder="e.g. 48000"
                helpText="Output sample rate in Hz"
                customHelpText="Specify the sample rate in Hz (e.g. 44100)"
              />
              {AUDIO_FIELD_CONFIG.map(({ key, label, type, helpText: hint }) => (
                <TextField
                  key={key}
                  label={label}
                  type={type}
                  value={form[key] ?? ''}
                  onChange={(next) => handleFieldChange(key, next, type)}
                  helpText={hint}
                />
              ))}
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <TextAreaField
                label="Audio Filters"
                value={form.AUDIO_FILTERS ?? ''}
                onChange={(next) => handleFieldChange('AUDIO_FILTERS', next)}
                placeholder="One filter per line"
                rows={3}
                helpText="Each line becomes part of -filter:a (e.g. aresample=async=1:first_pts=0)"
              />
              <TextAreaField
                label="Audio Extra Arguments"
                value={form.AUDIO_EXTRA_ARGS ?? ''}
                onChange={(next) => handleFieldChange('AUDIO_EXTRA_ARGS', next)}
                placeholder="One argument per line"
                rows={3}
                helpText="Newline separated list appended after audio options"
              />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Simulated FFmpeg Command</h3>
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-subtle">Preview</span>
                {previewLoading ? <span className="text-xs text-muted">Updating…</span> : null}
              </div>
              <div className="mt-2 rounded-2xl border border-border bg-background px-4 py-4">
                {previewError ? (
                  <p className="text-xs text-rose-300">{previewError}</p>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted">
                    {formattedPreview || 'Command preview unavailable.'}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3">
          <Feedback message={transcoder.feedback?.message} tone={transcoder.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(transcoder.data, transcoder.form);
              if (Object.keys(diff).length === 0) {
                setTranscoder((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
                return;
              }
              setTranscoder((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
              try {
                const updated = await updateSystemSettings('transcoder', diff);
                const updatedDefaults = normalizeTranscoderRecord(
                  filterTranscoderValues(updated?.defaults || transcoder.defaults),
                );
                const updatedSettings = normalizeTranscoderRecord(
                  filterTranscoderValues(updated?.settings || transcoder.data),
                );
                const updatedForm = normalizeTranscoderForm(
                  prepareForm(updatedDefaults, updatedSettings),
                );
                setTranscoder({
                  loading: false,
                  data: updatedSettings,
                  defaults: updatedDefaults,
                  form: updatedForm,
                  feedback: { tone: 'success', message: 'Transcoder settings saved.' },
                  previewCommand: updated?.simulated_command ?? transcoder.previewCommand ?? '',
                  previewArgs: Array.isArray(updated?.simulated_command_argv)
                    ? updated.simulated_command_argv
                    : Array.isArray(transcoder.previewArgs)
                      ? transcoder.previewArgs
                      : [],
                  previewLoading: false,
                  previewError: null,
                });
              } catch (exc) {
                setTranscoder((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
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

  const renderLibrary = () => {
    if (library.loading) {
      return <div className="text-sm text-muted">Loading library settings…</div>;
    }

    const currentPageSize = clampLibraryPageSize(
      library.form.section_page_size,
      library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE,
    );
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
          feedback: null,
          sections: updatedSections,
        };
      });
    };

    const handlePageSizeChange = (raw) => {
      setLibrary((state) => {
        const fallback = state.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE;
        const value = clampLibraryPageSize(raw, fallback);
        return {
          ...state,
          form: {
            ...state.form,
            section_page_size: value,
          },
          feedback: null,
        };
      });
    };

    const handleDefaultViewChange = (value) => {
      setLibrary((state) => ({
        ...state,
        form: {
          ...state.form,
          default_section_view: normalizeSectionView(
            value,
            state.defaults.default_section_view ?? 'library',
          ),
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
      const preparedForm = {
        ...library.form,
        hidden_sections: hiddenChanged ? currentHidden : library.data.hidden_sections,
        section_page_size: clampLibraryPageSize(
          library.form.section_page_size,
          library.defaults.section_page_size ?? DEFAULT_LIBRARY_PAGE_SIZE,
        ),
        default_section_view: normalizeSectionView(
          library.form.default_section_view,
          library.defaults.default_section_view ?? 'library',
        ),
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

    return (
      <SectionContainer title="Library settings">
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Page size"
            type="number"
            value={currentPageSize}
            onChange={handlePageSizeChange}
            helpText="Number of Plex items fetched per chunk (1-1000)."
          />
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
              const sizeLabel = typeof section?.size === 'number' && section.size > 0
                ? `${section.size.toLocaleString()} items`
                : 'Unknown size';
              const sectionTitle = section?.title || 'Untitled section';
              const sectionType = section?.type ? section.type.toUpperCase() : 'UNKNOWN';
              const key = identifier || `section-${index}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleToggleSection(identifier)}
                  disabled={!identifier}
                  className={`flex w-full items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition ${
                    isHidden
                      ? 'border-border/60 bg-background/40 text-muted hover:border-border'
                      : 'border-border bg-background text-foreground hover:border-amber-400'
                  } ${identifier ? '' : 'cursor-not-allowed opacity-60'}`}
                  title={identifier ? (isHidden ? 'Show this section' : 'Hide this section') : 'Identifier unavailable for toggling'}
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-foreground">{sectionTitle}</span>
                    <span className="text-xs text-muted">{sectionType} · {sizeLabel}</span>
                    {identifier ? null : (
                      <span className="text-[11px] text-rose-300">Cannot toggle this section because it lacks a stable identifier.</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold uppercase tracking-wide ${isHidden ? 'text-rose-300' : 'text-emerald-300'}`}>
                      {isHidden ? 'Hidden' : 'Visible'}
                    </span>
                    <FontAwesomeIcon icon={isHidden ? faEyeSlash : faEye} className={isHidden ? 'text-rose-300' : 'text-emerald-300'} />
                  </div>
                </button>
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
  };

  const renderChat = () => {
    if (chat.loading) {
      return <div className="text-sm text-muted">Loading chat settings…</div>;
    }
    return (
      <SectionContainer title="Chat settings">
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(chat.form).map(([key, value]) => {
            if (typeof chat.defaults[key] === 'boolean' || typeof value === 'boolean') {
              return (
                <BooleanField
                  key={key}
                  label={key}
                  value={Boolean(value)}
                  onChange={(next) => setChat((state) => ({
                    ...state,
                    form: { ...state.form, [key]: next },
                  }))}
                />
              );
            }
            if (typeof chat.defaults[key] === 'number' || typeof value === 'number') {
              return (
                <TextField
                  key={key}
                  label={key}
                  type="number"
                  value={value}
                  onChange={(next) => setChat((state) => ({
                    ...state,
                    form: { ...state.form, [key]: Number(next) },
                  }))}
                />
              );
            }
            return (
              <TextField
                key={key}
                label={key}
                value={value ?? ''}
                onChange={(next) => setChat((state) => ({
                  ...state,
                  form: { ...state.form, [key]: next },
                }))}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Feedback message={chat.feedback?.message} tone={chat.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(chat.data, chat.form);
              if (Object.keys(diff).length === 0) {
                setChat((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
                return;
              }
              setChat((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
              try {
                const updated = await updateSystemSettings('chat', diff);
                setChat({
                  loading: false,
                  data: updated?.settings || {},
                  defaults: updated?.defaults || chat.defaults,
                  form: prepareForm(updated?.defaults || {}, updated?.settings || {}),
                  feedback: { tone: 'success', message: 'Chat settings saved.' },
                });
              } catch (exc) {
                setChat((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
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

  const updatePlexForm = (changes) => {
    setPlex((state) => ({
      ...state,
      form: { ...state.form, ...changes },
      feedback: null,
    }));
  };

  const handleConnectPlex = async () => {
    const serverUrl = plex.form.serverUrl ? plex.form.serverUrl.trim() : '';
    const token = plex.form.token ? plex.form.token.trim() : '';

    if (!serverUrl) {
      setPlex((state) => ({
        ...state,
        feedback: { tone: 'error', message: 'Server URL is required.' },
      }));
      return;
    }
    if (!token) {
      setPlex((state) => ({
        ...state,
        feedback: { tone: 'error', message: 'Plex token is required.' },
      }));
      return;
    }

    setPlex((state) => ({
      ...state,
      saving: true,
      feedback: { tone: 'info', message: 'Connecting to Plex…' },
    }));

    try {
      const response = await connectPlex({
        serverUrl,
        token,
        verifySsl: plex.form.verifySsl,
      });
      const result = response?.result || {};
      const nextSettings = response?.settings || {};
      setPlex((state) => ({
        ...state,
        loading: false,
        status: result.status || nextSettings.status || 'connected',
        account: result.account ?? nextSettings.account ?? state.account,
        server: result.server ?? nextSettings.server ?? state.server,
        hasToken: Boolean(nextSettings.has_token ?? result.has_token ?? true),
        lastConnectedAt:
          result.last_connected_at
          ?? nextSettings.last_connected_at
          ?? new Date().toISOString(),
        feedback: { tone: 'success', message: 'Connected to Plex.' },
        saving: false,
        form: {
          ...state.form,
          serverUrl: nextSettings.server_base_url ?? serverUrl,
          token: '',
          verifySsl:
            nextSettings.verify_ssl !== undefined
              ? Boolean(nextSettings.verify_ssl)
              : (result.verify_ssl !== undefined
                  ? Boolean(result.verify_ssl)
                  : state.form.verifySsl),
        },
      }));
    } catch (exc) {
      let message = 'Unable to connect to Plex.';
      if (exc instanceof TypeError) {
        console.error('Plex connect network error', exc);
        message = 'Could not reach the API. Ensure the backend is running and configure CORS/HTTPS correctly.';
      } else if (exc instanceof Error && exc.message) {
        message = exc.message;
      }
      setPlex((state) => ({
        ...state,
        saving: false,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const handleDisconnectPlex = async () => {
    setPlex((state) => ({
      ...state,
      saving: true,
      feedback: { tone: 'info', message: 'Disconnecting Plex…' },
    }));
    try {
      await disconnectPlex();
      setPlex((state) => ({
        ...state,
        status: 'disconnected',
        account: null,
        server: null,
        hasToken: false,
        lastConnectedAt: null,
        feedback: { tone: 'success', message: 'Plex disconnected.' },
        saving: false,
        form: { ...state.form, token: '' },
      }));
    } catch (exc) {
      let message = 'Unable to disconnect Plex.';
      if (exc instanceof TypeError) {
        console.error('Plex disconnect network error', exc);
        message = 'Could not reach the API. Ensure the backend is running and configure CORS/HTTPS correctly.';
      } else if (exc instanceof Error && exc.message) {
        message = exc.message;
      }
      setPlex((state) => ({
        ...state,
        saving: false,
        feedback: { tone: 'error', message },
      }));
    }
  };

  const renderPlex = () => {
    if (plex.loading) {
      return <div className="text-sm text-muted">Loading Plex integration…</div>;
    }
    const isConnected = plex.status === 'connected';
    const account = plex.account;
    const server = plex.server;
    const lastConnected = plex.lastConnectedAt ? new Date(plex.lastConnectedAt) : null;
    const statusLabel = plex.status.charAt(0).toUpperCase() + plex.status.slice(1);

    return (
      <SectionContainer title="Plex integration">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Provide your Plex server URL and token to browse libraries from the admin console.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Server URL"
              value={plex.form.serverUrl}
              onChange={(value) => updatePlexForm({ serverUrl: value })}
              placeholder="http://localhost:32400"
            />
            <TextField
              label="Plex token"
              type="password"
              value={plex.form.token}
              onChange={(value) => updatePlexForm({ token: value })}
              placeholder={plex.hasToken ? 'Enter token to refresh connection' : 'Required'}
            />
          </div>

          <BooleanField
            label="Verify TLS certificates"
            value={plex.form.verifySsl}
            onChange={(value) => updatePlexForm({ verifySsl: value })}
          />

          {plex.feedback?.message ? (
            <Feedback message={plex.feedback.message} tone={plex.feedback.tone} />
          ) : null}

          <div className="rounded-2xl border border-border bg-background/70 p-4 text-sm text-muted">
            <p className="text-xs uppercase tracking-wide text-subtle">Status</p>
            <p className="text-base font-semibold text-foreground">{statusLabel}</p>
            {lastConnected ? (
              <p className="text-xs text-subtle">Last connected {lastConnected.toLocaleString()}</p>
            ) : null}
          </div>

          {isConnected ? (
            <div className="space-y-3 rounded-2xl border border-border bg-background/70 p-4 text-sm text-muted">
              {account ? (
                <div className="space-y-2">
                  <div>
                    <p className="text-base font-semibold text-foreground">{account.title || account.username}</p>
                    {account.email ? <p className="text-xs text-subtle">{account.email}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-subtle">
                    {account.subscription_status ? <span>Status: {account.subscription_status}</span> : null}
                    {account.subscription_plan ? <span>Plan: {account.subscription_plan}</span> : null}
                    {account.uuid ? <span>UUID: {account.uuid}</span> : null}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-subtle">Connected to Plex server.</p>
              )}
              {server ? (
                <div className="space-y-1 text-xs text-subtle">
                  <p className="text-sm text-muted">
                    <span className="text-foreground font-semibold">{server.name || 'Plex server'}</span>
                    {server.base_url ? ` · ${server.base_url}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {server.machine_identifier ? <span>ID: {server.machine_identifier}</span> : null}
                    {server.version ? <span>Version: {server.version}</span> : null}
                    {server.verify_ssl !== undefined ? <span>TLS: {server.verify_ssl ? 'verified' : 'not verified'}</span> : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {plex.hasToken && !isConnected ? (
            <p className="text-xs text-subtle">
              A Plex token is already stored; submitting a new token will replace it.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <DiffButton onClick={handleConnectPlex} disabled={plex.saving}>
              {plex.saving ? 'Working…' : 'Connect'}
            </DiffButton>
            {plex.hasToken ? (
              <DiffButton onClick={handleDisconnectPlex} disabled={plex.saving}>
                {plex.saving ? 'Working…' : 'Disconnect'}
              </DiffButton>
            ) : null}
          </div>
        </div>
      </SectionContainer>
    );
  };

  const renderGroups = () => {
    if (groupsState.loading) {
      return <div className="text-sm text-muted">Loading groups…</div>;
    }
    return (
      <div className="space-y-4">
        {groupsState.items.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            permissions={groupsState.permissions}
            onSave={async (nextPermissions) => {
              const next = Array.from(new Set(nextPermissions || [])).map((value) => String(value));
              const current = Array.isArray(group.permissions) ? group.permissions : [];
              const sameLength = next.length === current.length;
              const hasSameValues = sameLength && next.every((perm) => current.includes(perm));
              if (hasSameValues) {
                setGroupsState((state) => ({
                  ...state,
                  feedback: { tone: 'info', message: 'No permission changes to save.' },
                }));
                return;
              }
              setGroupsState((state) => ({
                ...state,
                feedback: { tone: 'info', message: `Saving ${group.name} permissions…` },
              }));
              try {
                const updated = await updateGroup(group.id, { permissions: next });
                setGroupsState((state) => ({
                  ...state,
                  items: state.items.map((item) => (item.id === group.id ? updated.group : item)),
                  feedback: { tone: 'success', message: `${updated.group.name} updated.` },
                }));
              } catch (exc) {
                setGroupsState((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update group.' },
                }));
              }
            }}
          />
        ))}
        <Feedback message={groupsState.feedback?.message} tone={groupsState.feedback?.tone} />
      </div>
    );
  };

  const renderUsers = () => {
    if (usersState.loading) {
      return <div className="text-sm text-muted">Loading users…</div>;
    }
    const list = filteredUsers;
    return (
      <div className="space-y-4">
        {list.length ? (
          list.map((account) => (
            <UserRow
              key={account.id}
              user={account}
              groups={groupsState.items}
              pending={usersState.pending[account.id] || account.groups?.map((group) => group.slug) || []}
              onChange={(slugs) => setUsersState((state) => ({
                ...state,
                pending: { ...state.pending, [account.id]: slugs },
              }))}
              onSave={async (slugs) => {
                try {
                  const response = await updateUserGroups(account.id, slugs);
                  setUsersState((state) => ({
                    ...state,
                    items: state.items.map((item) => (item.id === account.id ? response.user : item)),
                    pending: { ...state.pending, [account.id]: response.user.groups.map((group) => group.slug) },
                    feedback: { tone: 'success', message: `${response.user.username} updated.` },
                  }));
                } catch (exc) {
                  setUsersState((state) => ({
                    ...state,
                    feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update user groups.' },
                  }));
                }
              }}
            />
          ))
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-background/40 px-4 py-8 text-center text-sm text-muted">
            No users match your filter.
          </div>
        )}
        <Feedback message={usersState.feedback?.message} tone={usersState.feedback?.tone} />
      </div>
    );
  };

  const renderUserSection = () => {
    if (userSettings.loading) {
      return <div className="text-sm text-muted">Loading user settings…</div>;
    }
    const defaultGroup = userSettings.form.default_group || groupsState.items.find((group) => !group.is_system)?.slug || 'user';
    return (
      <SectionContainer title="User management">
        <BooleanField
          label="Allow registration"
          value={userSettings.form.allow_registration}
          onChange={(next) => setUserSettings((state) => ({
            ...state,
            form: { ...state.form, allow_registration: next },
          }))}
        />
        <label className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Default group
          <select
            value={defaultGroup}
            onChange={(event) => setUserSettings((state) => ({
              ...state,
              form: { ...state.form, default_group: event.target.value },
            }))}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
          >
            {groupsState.items.map((group) => (
              <option key={group.slug} value={group.slug}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-3">
          <Feedback message={userSettings.feedback?.message} tone={userSettings.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(userSettings.data, userSettings.form);
              if (Object.keys(diff).length === 0) {
                setUserSettings((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
                return;
              }
              setUserSettings((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
              try {
                const updated = await updateSystemSettings('users', diff);
                setUserSettings({
                  loading: false,
                  data: updated?.settings || {},
                  defaults: updated?.defaults || userSettings.defaults,
                  form: prepareForm(updated?.defaults || {}, updated?.settings || {}),
                  feedback: { tone: 'success', message: 'User settings saved.' },
                });
              } catch (exc) {
                setUserSettings((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
                }));
              }
            }}
          >
            Save user settings
          </DiffButton>
        </div>
        <div className="mt-6 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">User access</h3>
            <div className="md:w-72">
              <TextField
                label="Filter users"
                value={userFilter}
                placeholder="Search by username or email"
                onChange={(value) => setUserFilter(value)}
              />
            </div>
          </div>
          <div>{renderUsers()}</div>
        </div>
      </SectionContainer>
    );
  };

  const renderGroupSection = () => (
    <SectionContainer title="Group management">{renderGroups()}</SectionContainer>
  );

  return (
    <div className="flex h-full w-full min-h-0 divide-x divide-border">
      <aside className="hidden w-64 flex-shrink-0 flex-col gap-2 border-r border-border bg-background/60 px-4 py-6 text-sm text-muted md:flex">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActiveSection(section.id)}
            className={`rounded-xl px-4 py-2 text-left transition ${
              activeSection === section.id ? 'bg-amber-500/10 text-amber-200' : 'hover:bg-surface hover:text-foreground'
            }`}
          >
            {section.label}
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-10">
        {activeSection === 'transcoder' ? renderTranscoder() : null}
        {activeSection === 'library' ? renderLibrary() : null}
        {activeSection === 'plex' ? renderPlex() : null}
        {activeSection === 'users' ? renderUserSection() : null}
        {activeSection === 'groups' ? renderGroupSection() : null}
        {activeSection === 'chat' ? renderChat() : null}
      </div>
    </div>
  );
}

function GroupCard({ group, permissions, onSave }) {
  const [selection, setSelection] = useState(new Set(group.permissions || []));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelection(new Set(group.permissions || []));
  }, [group.permissions]);

  const togglePermission = (permName) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(permName)) {
        next.delete(permName);
      } else {
        next.add(permName);
      }
      return next;
    });
  };

  const hasChanges = useMemo(() => {
    const current = new Set(group.permissions || []);
    if (current.size !== selection.size) {
      return true;
    }
    for (const value of selection) {
      if (!current.has(value)) {
        return true;
      }
    }
    return false;
  }, [group.permissions, selection]);

  const handleSave = async () => {
    if (!onSave || !hasChanges) {
      return;
    }
    setSaving(true);
    try {
      await onSave(Array.from(selection));
    } finally {
      setSaving(false);
    }
  };

  const badgeStyle = getGroupBadgeStyles(group.slug);

  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <span
            className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
            style={badgeStyle}
          >
            {group.name}
          </span>
          <p className="text-xs text-subtle">Slug: {group.slug}</p>
        </div>
        <div className="text-xs text-subtle">Members: {group.member_count ?? 0}</div>
      </div>
      {group.description ? (
        <p className="mt-3 text-sm text-muted">{group.description}</p>
      ) : (
        <p className="mt-3 text-sm italic text-subtle">No description provided.</p>
      )}
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Permissions</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {permissions.map((permission) => (
            <label
              key={permission.name}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted hover:border-outline hover:bg-surface/60"
            >
              <input
                type="checkbox"
                checked={selection.has(permission.name)}
                onChange={() => togglePermission(permission.name)}
                className="h-4 w-4 text-amber-400 focus:outline-none"
              />
              <span>
                <span className="block text-sm text-foreground">{permission.name}</span>
                <span className="text-[11px] text-subtle">{permission.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end">
        <DiffButton onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? 'Saving…' : 'Save permissions'}
        </DiffButton>
      </div>
    </div>
  );
}

function UserRow({ user, groups, pending, onChange, onSave }) {
  const [saving, setSaving] = useState(false);
  const pendingSet = new Set(pending);
  const handleToggle = (slug) => {
    if (saving || user.is_admin) {
      return;
    }
    const next = new Set(pendingSet);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    onChange?.(Array.from(next));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave?.(pending);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{user.username}</h4>
          <p className="text-xs text-subtle">{user.email}</p>
        </div>
        {user.is_admin ? (
          <span
            className="rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
            style={getGroupBadgeStyles('admin')}
          >
            Administrator
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {groups.map((group) => (
          <button
            key={group.slug}
            type="button"
            disabled={user.is_admin && group.slug === 'admin'}
            onClick={() => handleToggle(group.slug)}
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition text-muted ${
              user.is_admin && group.slug === 'admin' ? 'cursor-not-allowed opacity-70' : 'hover:shadow-sm'
            }`}
            style={getGroupChipStyles(group.slug, { active: pendingSet.has(group.slug) })}
          >
            {group.name}
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <DiffButton onClick={handleSave} disabled={saving || user.is_admin}>
          {saving ? 'Saving…' : 'Save membership'}
        </DiffButton>
      </div>
    </div>
  );
}
