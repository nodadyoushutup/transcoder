import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate, faBroom, faCircleNotch, faEye, faEyeSlash, faImage, faLock } from '@fortawesome/free-solid-svg-icons';
import {
  fetchGroups,
  fetchSystemSettings,
  fetchUsers,
  restartService,
  updateGroup,
  updateSystemSettings,
  updateUserGroups,
  connectPlex,
  disconnectPlex,
  previewTranscoderCommand,
  cachePlexSectionImages,
  buildPlexSectionSnapshot,
  clearPlexSectionSnapshot,
  fetchPlexSections,
  stopTask,
} from '../lib/api.js';
import { getGroupBadgeStyles, getGroupChipStyles } from '../lib/groupColors.js';

const ADMIN_GROUP_SLUG = 'admin';
const GROUP_DISPLAY_ORDER = ['moderator', 'user', 'guest'];

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

const LIBRARY_PAGE_SIZE_MIN = 1;
const LIBRARY_PAGE_SIZE_MAX = 1000;
const DEFAULT_LIBRARY_PAGE_SIZE = 500;
const LIBRARY_SECTION_VIEWS = ['recommended', 'library', 'collections'];
const REDIS_DEFAULT_MAX_ENTRIES = 0;
const REDIS_DEFAULT_TTL_SECONDS = 0;
const TASK_SCHEDULE_MIN_SECONDS = 1;
const TASK_SCHEDULE_MAX_SECONDS = 86400 * 30;
const TASK_DEFAULT_REFRESH_INTERVAL = 15;
const LIBRARY_DEFAULT_SORT = 'title_asc';
const SNAPSHOT_PARALLELISM = 4;

function clonePlayerTemplate() {
  return {
    attachMinimumSegments: 3,
    streaming: {
      delay: {
        liveDelay: Number.NaN,
        liveDelayFragmentCount: 10,
        useSuggestedPresentationDelay: true,
      },
      liveCatchup: {
        enabled: true,
        minDrift: 6.0,
        maxDrift: 10.0,
        playbackRate: {
          min: -0.04,
          max: 0.04,
        },
      },
      buffer: {
        fastSwitchEnabled: true,
        bufferPruningInterval: 10,
        bufferToKeep: 10,
        bufferTimeAtTopQuality: 14,
        bufferTimeAtTopQualityLongForm: 18,
        stableBufferTime: 10,
      },
      text: {
        defaultEnabled: false,
        defaultLanguage: '',
      },
    },
  };
}

const PLAYER_DEFAULT_SETTINGS = Object.freeze(clonePlayerTemplate());

function clampInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  let result = Number.isNaN(parsed) ? fallback : parsed;
  if (Number.isNaN(result)) {
    result = fallback;
  }
  if (maximum !== undefined && result > maximum) {
    result = maximum;
  }
  if (minimum !== undefined && result < minimum) {
    result = minimum;
  }
  return result;
}

function clampFloat(value, fallback, minimum, maximum) {
  const parsed = Number.parseFloat(value);
  let result = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isFinite(result)) {
    result = fallback;
  }
  if (maximum !== undefined && result > maximum) {
    result = maximum;
  }
  if (minimum !== undefined && result < minimum) {
    result = minimum;
  }
  return result;
}

function coerceBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return fallback;
}

function sanitizePlayerRecord(record = {}) {
  const base = clonePlayerTemplate();
  const streamingInput = record?.streaming ?? {};
  const delayInput = streamingInput.delay ?? {};

  const liveDelayRaw = delayInput.liveDelay;
  if (liveDelayRaw === null || liveDelayRaw === undefined || liveDelayRaw === '') {
    base.streaming.delay.liveDelay = Number.NaN;
  } else {
    const parsedDelay = Number.parseFloat(liveDelayRaw);
    base.streaming.delay.liveDelay = Number.isFinite(parsedDelay) && parsedDelay >= 0
      ? parsedDelay
      : Number.NaN;
  }
  base.streaming.delay.liveDelayFragmentCount = clampInt(
    delayInput.liveDelayFragmentCount,
    base.streaming.delay.liveDelayFragmentCount,
    0,
    240,
  );
  base.streaming.delay.useSuggestedPresentationDelay = coerceBoolean(
    delayInput.useSuggestedPresentationDelay,
    base.streaming.delay.useSuggestedPresentationDelay,
  );

  const catchupInput = streamingInput.liveCatchup ?? {};
  base.streaming.liveCatchup.enabled = coerceBoolean(
    catchupInput.enabled,
    base.streaming.liveCatchup.enabled,
  );
  base.streaming.liveCatchup.minDrift = clampFloat(
    catchupInput.minDrift,
    base.streaming.liveCatchup.minDrift,
    0,
    120,
  );
  base.streaming.liveCatchup.maxDrift = clampFloat(
    catchupInput.maxDrift,
    base.streaming.liveCatchup.maxDrift,
    0,
    30,
  );
  const playbackInput = catchupInput.playbackRate ?? {};
  let rateMin = clampFloat(
    playbackInput.min,
    base.streaming.liveCatchup.playbackRate.min,
    -1,
    1,
  );
  let rateMax = clampFloat(
    playbackInput.max,
    base.streaming.liveCatchup.playbackRate.max,
    -1,
    1,
  );
  if (rateMin > rateMax) {
    const temp = rateMin;
    rateMin = rateMax;
    rateMax = temp;
  }
  base.streaming.liveCatchup.playbackRate = { min: rateMin, max: rateMax };
  if (base.streaming.liveCatchup.minDrift > base.streaming.liveCatchup.maxDrift) {
    base.streaming.liveCatchup.maxDrift = base.streaming.liveCatchup.minDrift;
  }

  const bufferInput = streamingInput.buffer ?? {};
  base.streaming.buffer.fastSwitchEnabled = coerceBoolean(
    bufferInput.fastSwitchEnabled,
    base.streaming.buffer.fastSwitchEnabled,
  );
  base.streaming.buffer.bufferPruningInterval = clampInt(
    bufferInput.bufferPruningInterval,
    base.streaming.buffer.bufferPruningInterval,
    0,
    86400,
  );
  base.streaming.buffer.bufferToKeep = clampInt(
    bufferInput.bufferToKeep,
    base.streaming.buffer.bufferToKeep,
    0,
    86400,
  );
  base.streaming.buffer.bufferTimeAtTopQuality = clampInt(
    bufferInput.bufferTimeAtTopQuality,
    base.streaming.buffer.bufferTimeAtTopQuality,
    0,
    86400,
  );
  base.streaming.buffer.bufferTimeAtTopQualityLongForm = clampInt(
    bufferInput.bufferTimeAtTopQualityLongForm,
    base.streaming.buffer.bufferTimeAtTopQualityLongForm,
    0,
    86400,
  );
  base.streaming.buffer.stableBufferTime = clampInt(
    bufferInput.stableBufferTime,
    base.streaming.buffer.stableBufferTime,
    0,
    86400,
  );

  const textInput = streamingInput.text ?? {};
  base.streaming.text.defaultEnabled = coerceBoolean(
    textInput.defaultEnabled,
    base.streaming.text.defaultEnabled,
  );
  const textLanguageSource =
    Object.prototype.hasOwnProperty.call(textInput, 'defaultLanguage')
      ? textInput.defaultLanguage
      : textInput.preferredLanguage;
  if (typeof textLanguageSource === 'string') {
    base.streaming.text.defaultLanguage = textLanguageSource.trim();
  } else if (textLanguageSource == null) {
    base.streaming.text.defaultLanguage = '';
  } else {
    base.streaming.text.defaultLanguage = String(textLanguageSource).trim();
  }

  Object.keys(record || {}).forEach((key) => {
    if (key !== 'streaming' && key !== 'attachMinimumSegments') {
      base[key] = record[key];
    }
  });

  const attachRaw = record?.attachMinimumSegments;
  const fallbackAttach = Number.isFinite(base.attachMinimumSegments) ? base.attachMinimumSegments : 0;
  base.attachMinimumSegments = clampInt(attachRaw, fallbackAttach, 0, 240);

  return base;
}

function clonePlayerSettings(settings = {}) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(settings);
    } catch {
      // fall through to JSON strategy
    }
  }
  const placeholder = '__JSON_NAN__';
  const replacer = (_, value) => {
    if (typeof value === 'number' && Number.isNaN(value)) {
      return placeholder;
    }
    return value;
  };
  const reviver = (_, value) => {
    if (value === placeholder) {
      return Number.NaN;
    }
    return value;
  };
  try {
    return JSON.parse(JSON.stringify(settings, replacer), reviver);
  } catch {
    return clonePlayerTemplate();
  }
}

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

function resolveSectionKey(section) {
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

function sanitizeRedisRecord(record = {}, defaults = {}) {
  const merged = {
    redis_url: '',
    max_entries: REDIS_DEFAULT_MAX_ENTRIES,
    ttl_seconds: REDIS_DEFAULT_TTL_SECONDS,
    ...(defaults || {}),
    ...(record || {}),
  };
  const redisUrl = typeof merged.redis_url === 'string' ? merged.redis_url.trim() : '';
  const maxEntries = Number.parseInt(merged.max_entries, 10);
  const ttlSeconds = Number.parseInt(merged.ttl_seconds, 10);
  return {
    redis_url: redisUrl,
    max_entries: Number.isFinite(maxEntries) && maxEntries >= 0 ? maxEntries : 0,
    ttl_seconds: Number.isFinite(ttlSeconds) && ttlSeconds >= 0 ? ttlSeconds : 0,
    backend: redisUrl ? 'redis' : 'disabled',
  };
}

function SectionContainer({ title, children }) {
  return (
    <section className="panel-card p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-4 space-y-4 text-sm text-muted">{children}</div>
    </section>
  );
}

function clampTaskSchedule(value, fallback = TASK_SCHEDULE_MIN_SECONDS) {
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return Math.min(TASK_SCHEDULE_MAX_SECONDS, Math.max(TASK_SCHEDULE_MIN_SECONDS, fallback));
  }
  return Math.min(TASK_SCHEDULE_MAX_SECONDS, Math.max(TASK_SCHEDULE_MIN_SECONDS, numeric));
}

function clampTaskRefreshInterval(value, fallback = TASK_DEFAULT_REFRESH_INTERVAL) {
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return Math.min(300, Math.max(5, fallback));
  }
  return Math.min(300, Math.max(5, numeric));
}

function sanitizeTaskJobs(jobs = []) {
  if (!Array.isArray(jobs)) {
    return [];
  }
  const dedup = new Map();
  jobs.forEach((job) => {
    if (!job || typeof job !== 'object') {
      return;
    }
    const identifier = (job.id ?? job.task ?? '').toString().trim();
    const taskName = (job.task ?? '').toString().trim();
    if (!identifier || !taskName) {
      return;
    }
    const name = (job.name ?? identifier).toString().trim();
    const scheduleSeconds = clampTaskSchedule(job.schedule_seconds ?? job.interval ?? TASK_SCHEDULE_MIN_SECONDS);
    const enabled = job.enabled !== undefined ? Boolean(job.enabled) : true;
    const queue = typeof job.queue === 'string' ? job.queue.trim() : '';
    const priorityValue = Number.parseInt(job.priority, 10);
    const priority = Number.isFinite(priorityValue) ? priorityValue : null;
    const args = Array.isArray(job.args) ? job.args.map((item) => item) : [];
    const kwargs = job.kwargs && typeof job.kwargs === 'object' ? { ...job.kwargs } : {};
    dedup.set(identifier, {
      id: identifier,
      name: name || identifier,
      task: taskName,
      schedule_seconds: scheduleSeconds,
      enabled,
      queue,
      priority,
      args,
      kwargs,
      run_on_start: Boolean(job.run_on_start),
    });
  });
  return Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeTasksRecord(record = {}, defaults = {}) {
  const merged = {
    beat_jobs: [],
    refresh_interval_seconds: TASK_DEFAULT_REFRESH_INTERVAL,
    ...(defaults || {}),
    ...(record || {}),
  };
  return {
    beat_jobs: sanitizeTaskJobs(merged.beat_jobs),
    refresh_interval_seconds: clampTaskRefreshInterval(
      merged.refresh_interval_seconds,
      TASK_DEFAULT_REFRESH_INTERVAL,
    ),
  };
}

function cloneTasksForm(record) {
  return {
    refresh_interval_seconds: record?.refresh_interval_seconds ?? TASK_DEFAULT_REFRESH_INTERVAL,
    beat_jobs: Array.isArray(record?.beat_jobs)
      ? record.beat_jobs.map((job) => ({
          ...job,
          args: Array.isArray(job.args) ? job.args.map((item) => item) : [],
          kwargs: job.kwargs && typeof job.kwargs === 'object' ? { ...job.kwargs } : {},
          run_on_start: Boolean(job.run_on_start),
        }))
      : [],
  };
}

function hasTaskChanges(original, current) {
  try {
    return JSON.stringify(original) !== JSON.stringify(current);
  } catch {
    return true;
  }
}

function formatRuntimeSeconds(runtime) {
  if (runtime === null || runtime === undefined) {
    return '';
  }
  const value = Number(runtime);
  if (!Number.isFinite(value) || value < 0) {
    return '';
  }
  if (value >= 120) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.round(value % 60);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 60) {
    const seconds = value % 60;
    return `1m ${Math.round(seconds)}s`;
  }
  if (value >= 10) {
    return `${value.toFixed(0)}s`;
  }
  return `${value.toFixed(1)}s`;
}

function formatEta(eta) {
  if (!eta) {
    return '';
  }
  const date = new Date(eta);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
}

function summarizeArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return '';
  }
  const json = JSON.stringify(args);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

function summarizeKwargs(kwargs) {
  if (!kwargs || typeof kwargs !== 'object') {
    return '';
  }
  const entries = Object.entries(kwargs);
  if (!entries.length) {
    return '';
  }
  const json = JSON.stringify(kwargs);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

function BooleanField({ label, value, onChange, disabled = false, helpText }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      <span>{label}</span>
      <span
        className={`flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3 text-sm ${disabled ? 'opacity-60 bg-surface-muted' : ''}`}
      >
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange?.(event.target.checked)}
          disabled={disabled}
          className="h-4 w-4 text-amber-400 focus:outline-none"
        />
      </span>
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

function TextField({ label, value, onChange, type = 'text', placeholder, helpText, disabled = false, readOnly = false }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${disabled || readOnly ? 'opacity-60 bg-surface-muted' : ''}`}
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
          disabled ? 'opacity-60 bg-surface-muted' : ''
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
  disabled = false,
}) {
  const normalizedValue = rawValue ?? '';
  const optionValues = options.map((option) => option.value);
  const selection = optionValues.includes(normalizedValue) ? normalizedValue : 'custom';
  const extendedOptions = [...options, { value: 'custom', label: 'Custom…' }];

  return (
    <div className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      <span>{label}</span>
      <select
        value={selection}
        onChange={(event) => onSelect?.(event.target.value)}
        disabled={disabled}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
          disabled ? 'opacity-60 bg-surface-muted' : ''
        }`}
      >
        {extendedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {selection === 'custom'
        ? (
          <input
            type={customType}
            value={normalizedValue}
            placeholder={customPlaceholder}
            onChange={(event) => onCustomChange?.(event.target.value)}
            disabled={disabled}
            className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
              disabled ? 'opacity-60 bg-surface-muted' : ''
            }`}
          />
        )
        : null}
      {selection === 'custom' && customHelpText
        ? (
          <span className="text-[11px] font-normal text-muted normal-case">{customHelpText}</span>
        )
        : null}
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
  'TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION',
  'TRANSCODER_AUTO_KEYFRAMING',
  'TRANSCODER_COPY_TIMESTAMPS',
  'TRANSCODER_START_AT_ZERO',
  'TRANSCODER_DEBUG_ENDPOINT_ENABLED',
  'TRANSCODER_LOCAL_OUTPUT_DIR',
  'DASH_AVAILABILITY_OFFSET',
  'DASH_WINDOW_SIZE',
  'DASH_EXTRA_WINDOW_SIZE',
  'DASH_SEGMENT_DURATION',
  'DASH_FRAGMENT_DURATION',
  'DASH_MIN_SEGMENT_DURATION',
  'DASH_STREAMING',
  'DASH_REMOVE_AT_EXIT',
  'DASH_USE_TEMPLATE',
  'DASH_USE_TIMELINE',
  'DASH_HTTP_USER_AGENT',
  'DASH_MUX_PRELOAD',
  'DASH_MUX_DELAY',
  'DASH_RETENTION_SEGMENTS',
  'DASH_EXTRA_ARGS',
  'DASH_INIT_SEGMENT_NAME',
  'DASH_MEDIA_SEGMENT_NAME',
  'DASH_ADAPTATION_SETS',
  'SUBTITLE_PREFERRED_LANGUAGE',
  'SUBTITLE_INCLUDE_FORCED',
  'SUBTITLE_INCLUDE_COMMENTARY',
  'SUBTITLE_INCLUDE_SDH',
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
  'VIDEO_SCENE_CUT',
  'VIDEO_VSYNC',
  'VIDEO_FILTERS',
  'VIDEO_EXTRA_ARGS',
  'VIDEO_SCALE',
  'VIDEO_FPS',
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
  { value: '720p', label: '720p (scale=1280:-2)' },
  { value: '1080p', label: '1080p (scale=1920:-2)' },
  { value: '4k', label: '4K (scale=3840:-2)' },
  { value: 'custom', label: 'Custom filters' },
];

const SCALE_PRESET_FILTERS = {
  source: '',
  '1080p': 'scale=1920:-2',
  '720p': 'scale=1280:-2',
  '4k': 'scale=3840:-2',
};

const VIDEO_FPS_OPTIONS = [
  { value: 'source', label: 'Source (original)' },
  { value: '23.976', label: '23.976 fps (NTSC film)' },
  { value: '24', label: '24 fps (cinema)' },
  { value: '25', label: '25 fps (PAL)' },
  { value: '29.97', label: '29.97 fps (NTSC video)' },
  { value: '30', label: '30 fps' },
  { value: '50', label: '50 fps' },
  { value: '59.94', label: '59.94 fps (NTSC high frame)' },
  { value: '60', label: '60 fps' },
];

const SUBTITLE_LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese (Simplified)' },
];

const VIDEO_CODEC_OPTIONS = [
  { value: '', label: 'Use encoder default' },
  { value: 'libx264', label: 'libx264 (H.264)' },
  { value: 'libx265', label: 'libx265 (HEVC)' },
  { value: 'h264_nvenc', label: 'h264_nvenc (NVIDIA H.264)' },
  { value: 'hevc_nvenc', label: 'hevc_nvenc (NVIDIA HEVC)' },
  { value: 'h264_qsv', label: 'h264_qsv (Intel H.264)' },
  { value: 'hevc_qsv', label: 'hevc_qsv (Intel HEVC)' },
];

const VIDEO_PROFILE_OPTIONS = [
  { value: '', label: 'None (use encoder default)' },
  { value: 'baseline', label: 'baseline' },
  { value: 'main', label: 'main' },
  { value: 'high', label: 'high' },
  { value: 'high10', label: 'high10' },
  { value: 'high422', label: 'high422' },
  { value: 'high444', label: 'high444' },
  { value: 'constrained_baseline', label: 'constrained_baseline' },
];

const VIDEO_TUNE_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'film', label: 'film' },
  { value: 'animation', label: 'animation' },
  { value: 'grain', label: 'grain' },
  { value: 'stillimage', label: 'stillimage' },
  { value: 'fastdecode', label: 'fastdecode' },
  { value: 'zerolatency', label: 'zerolatency' },
];

const VIDEO_VSYNC_OPTIONS = [
  { value: '', label: 'Use FFmpeg default' },
  { value: '-1', label: 'Auto (-1)' },
  { value: '0', label: 'Passthrough (0)' },
  { value: '1', label: 'Constant frame rate (1)' },
  { value: '2', label: 'Variable frame rate (2)' },
  { value: 'drop', label: 'Drop frames (drop)' },
  { value: 'dup', label: 'Duplicate frames (dup)' },
  { value: 'cfr', label: 'Force CFR (cfr)' },
  { value: 'vfr', label: 'Force VFR (vfr)' },
];

const VIDEO_PRESET_OPTIONS = [
  { value: '', label: 'Use encoder default' },
  ...[
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
  ].map((value) => ({ value, label: value })),
];

const VIDEO_FIELD_CONFIG = [
  { key: 'VIDEO_BITRATE', label: 'Bitrate', type: 'text', helpText: "Target bitrate (e.g. 5M)" },
  { key: 'VIDEO_MAXRATE', label: 'Max Rate', type: 'text', helpText: "Peak bitrate cap (e.g. 5M)" },
  { key: 'VIDEO_BUFSIZE', label: 'Buffer Size', type: 'text', helpText: "VBV buffer size (e.g. 10M)" },
  { key: 'VIDEO_GOP_SIZE', label: 'GOP Size', type: 'number', helpText: 'Distance between keyframes in frames (e.g. 48)' },
  { key: 'VIDEO_KEYINT_MIN', label: 'Keyint Min', type: 'number', helpText: 'Minimum keyframe interval in frames' },
  { key: 'VIDEO_SC_THRESHOLD', label: 'Scene Change Threshold', type: 'number', helpText: 'FFmpeg -sc_threshold value (0 disables scene cuts)' },
  { key: 'VIDEO_SCENE_CUT', label: 'Scene Cut (x264)', type: 'number', helpText: 'x264 scenecut parameter; set to 0 to disable encoder-driven cuts' },
];

const AUTO_KEYFRAME_LOCKED_VIDEO_FIELDS = new Set([
  'VIDEO_CODEC',
  'VIDEO_GOP_SIZE',
  'VIDEO_KEYINT_MIN',
  'VIDEO_SC_THRESHOLD',
  'VIDEO_SCENE_CUT',
  'VIDEO_FPS',
  'VIDEO_EXTRA_ARGS',
]);

const AUTO_KEYFRAME_LOCKED_DASH_FIELDS = new Set([
  'DASH_SEGMENT_DURATION',
  'DASH_FRAGMENT_DURATION',
  'DASH_MIN_SEGMENT_DURATION',
]);

const AUTO_KEYFRAME_LOCK_NOTE = 'Managed automatically while Auto Keyframing is enabled.';

const renderLockedLabel = (label, locked) => {
  if (!locked) {
    return label;
  }
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <FontAwesomeIcon icon={faLock} className="text-[11px] text-muted" />
    </span>
  );
};

function lockHelpText(base, locked) {
  const trimmed = (base || '').trim();
  if (!locked) {
    return trimmed;
  }
  if (!trimmed) {
    return AUTO_KEYFRAME_LOCK_NOTE;
  }
  return `${trimmed} ${AUTO_KEYFRAME_LOCK_NOTE}`;
}

const AUDIO_CODEC_OPTIONS = [
  { value: '', label: 'Use encoder default' },
  { value: 'aac', label: 'aac (Advanced Audio Coding)' },
  { value: 'ac3', label: 'ac3 (Dolby Digital)' },
  { value: 'eac3', label: 'eac3 (Dolby Digital Plus)' },
  { value: 'libopus', label: 'libopus (Opus)' },
  { value: 'flac', label: 'flac' },
];

const AUDIO_PROFILE_OPTIONS = [
  { value: '', label: 'None (use encoder default)' },
  { value: 'aac_low', label: 'aac_low (LC)' },
  { value: 'aac_he', label: 'aac_he (HE-AAC)' },
  { value: 'aac_he_v2', label: 'aac_he_v2 (HE-AAC v2)' },
  { value: 'aac_ld', label: 'aac_ld (Low Delay)' },
  { value: 'aac_eld', label: 'aac_eld (Enhanced Low Delay)' },
];

const AUDIO_SAMPLE_RATE_OPTIONS = [
  { value: '', label: 'Use source sample rate' },
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
  if (record.TRANSCODER_LOCAL_OUTPUT_DIR !== undefined && record.TRANSCODER_LOCAL_OUTPUT_DIR !== null) {
    record.TRANSCODER_LOCAL_OUTPUT_DIR = String(record.TRANSCODER_LOCAL_OUTPUT_DIR).trim();
  } else {
    record.TRANSCODER_LOCAL_OUTPUT_DIR = '';
  }
  if (record.SUBTITLE_PREFERRED_LANGUAGE !== undefined && record.SUBTITLE_PREFERRED_LANGUAGE !== null) {
    const normalized = String(record.SUBTITLE_PREFERRED_LANGUAGE).trim().toLowerCase();
    const supportedLanguages = SUBTITLE_LANGUAGE_OPTIONS.map((option) => option.value);
    record.SUBTITLE_PREFERRED_LANGUAGE = normalized && supportedLanguages.includes(normalized)
      ? normalized
      : 'en';
  } else {
    record.SUBTITLE_PREFERRED_LANGUAGE = 'en';
  }
  ['SUBTITLE_INCLUDE_FORCED', 'SUBTITLE_INCLUDE_COMMENTARY', 'SUBTITLE_INCLUDE_SDH'].forEach((key) => {
    const value = record[key];
    if (typeof value === 'string') {
      record[key] = ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    } else if (typeof value === 'number') {
      record[key] = Boolean(value);
    } else {
      record[key] = Boolean(value);
    }
  });
  const forceNewConn = record.TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION;
  if (typeof forceNewConn === 'string') {
    const lowered = forceNewConn.trim().toLowerCase();
    record.TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION = ['true', '1', 'yes', 'on'].includes(lowered);
  } else if (typeof forceNewConn === 'number') {
    record.TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION = Boolean(forceNewConn);
  } else {
    record.TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION = Boolean(forceNewConn);
  }

  ['TRANSCODER_AUTO_KEYFRAMING', 'TRANSCODER_COPY_TIMESTAMPS', 'TRANSCODER_START_AT_ZERO', 'TRANSCODER_DEBUG_ENDPOINT_ENABLED'].forEach((key) => {
    const value = record[key];
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      record[key] = ['true', '1', 'yes', 'on'].includes(lowered);
    } else if (typeof value === 'number') {
      record[key] = Boolean(value);
    } else {
      record[key] = value !== undefined ? Boolean(value) : true;
    }
  });

  if (record.DASH_AVAILABILITY_OFFSET === undefined || record.DASH_AVAILABILITY_OFFSET === null) {
    record.DASH_AVAILABILITY_OFFSET = '';
  } else {
    record.DASH_AVAILABILITY_OFFSET = String(record.DASH_AVAILABILITY_OFFSET).trim();
  }

  const normalizeIntField = (value, minimum) => {
    if (value === undefined || value === null || value === '') {
      return '';
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return '';
    }
    if (minimum !== undefined) {
      return Math.max(parsed, minimum);
    }
    return parsed;
  };
  const dashWindow = normalizeIntField(record.DASH_WINDOW_SIZE, 1);
  record.DASH_WINDOW_SIZE = dashWindow === '' ? '' : dashWindow;
  const dashExtraWindow = normalizeIntField(record.DASH_EXTRA_WINDOW_SIZE, 0);
  record.DASH_EXTRA_WINDOW_SIZE = dashExtraWindow === '' ? '' : dashExtraWindow;

  const normalizeFloatField = (value) => {
    if (value === undefined || value === null || value === '') {
      return '';
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? '' : String(parsed);
  };

  record.DASH_SEGMENT_DURATION = normalizeFloatField(record.DASH_SEGMENT_DURATION);
  record.DASH_FRAGMENT_DURATION = normalizeFloatField(record.DASH_FRAGMENT_DURATION);
  const minSeg = normalizeIntField(record.DASH_MIN_SEGMENT_DURATION, 0);
  record.DASH_MIN_SEGMENT_DURATION = minSeg === '' ? '' : minSeg;

  const retentionOverride = normalizeIntField(record.DASH_RETENTION_SEGMENTS, 0);
  record.DASH_RETENTION_SEGMENTS = retentionOverride === '' ? '' : retentionOverride;

  record.DASH_STREAMING = coerceBoolean(record.DASH_STREAMING, false);
  record.DASH_REMOVE_AT_EXIT = coerceBoolean(record.DASH_REMOVE_AT_EXIT, false);
  record.DASH_USE_TEMPLATE = coerceBoolean(record.DASH_USE_TEMPLATE, false);
  record.DASH_USE_TIMELINE = coerceBoolean(record.DASH_USE_TIMELINE, false);

  record.DASH_HTTP_USER_AGENT = record.DASH_HTTP_USER_AGENT !== undefined && record.DASH_HTTP_USER_AGENT !== null
    ? String(record.DASH_HTTP_USER_AGENT).trim()
    : '';

  record.DASH_MUX_PRELOAD = normalizeFloatField(record.DASH_MUX_PRELOAD);
  record.DASH_MUX_DELAY = normalizeFloatField(record.DASH_MUX_DELAY);
  record.DASH_EXTRA_ARGS = record.DASH_EXTRA_ARGS !== undefined && record.DASH_EXTRA_ARGS !== null
    ? String(record.DASH_EXTRA_ARGS)
    : '';
  record.DASH_INIT_SEGMENT_NAME = record.DASH_INIT_SEGMENT_NAME !== undefined && record.DASH_INIT_SEGMENT_NAME !== null
    ? String(record.DASH_INIT_SEGMENT_NAME)
    : '';
  record.DASH_MEDIA_SEGMENT_NAME = record.DASH_MEDIA_SEGMENT_NAME !== undefined && record.DASH_MEDIA_SEGMENT_NAME !== null
    ? String(record.DASH_MEDIA_SEGMENT_NAME)
    : '';
  record.DASH_ADAPTATION_SETS = record.DASH_ADAPTATION_SETS !== undefined && record.DASH_ADAPTATION_SETS !== null
    ? String(record.DASH_ADAPTATION_SETS)
    : '';

  record.TRANSCODER_CORS_ORIGIN = record.TRANSCODER_CORS_ORIGIN !== undefined && record.TRANSCODER_CORS_ORIGIN !== null
    ? String(record.TRANSCODER_CORS_ORIGIN).trim()
    : '';
  record.INGEST_ENABLE_PUT = coerceBoolean(record.INGEST_ENABLE_PUT, true);
  record.INGEST_ENABLE_DELETE = coerceBoolean(record.INGEST_ENABLE_DELETE, true);

  const cacheMaxAgeRaw = record.INGEST_CACHE_MAX_AGE;
  if (cacheMaxAgeRaw === undefined || cacheMaxAgeRaw === null || cacheMaxAgeRaw === '') {
    record.INGEST_CACHE_MAX_AGE = '';
  } else {
    const parsedMaxAge = Number.parseInt(cacheMaxAgeRaw, 10);
    record.INGEST_CACHE_MAX_AGE = Number.isNaN(parsedMaxAge) ? '' : Math.max(parsedMaxAge, 0);
  }

  const cacheExtensions = record.INGEST_CACHE_EXTENSIONS;
  if (Array.isArray(cacheExtensions)) {
    record.INGEST_CACHE_EXTENSIONS = cacheExtensions.join(', ');
  } else if (cacheExtensions === undefined || cacheExtensions === null) {
    record.INGEST_CACHE_EXTENSIONS = '';
  } else {
    record.INGEST_CACHE_EXTENSIONS = String(cacheExtensions);
  }

  const rawScale = record.VIDEO_SCALE !== undefined ? String(record.VIDEO_SCALE).toLowerCase() : undefined;
  if (!rawScale) {
    record.VIDEO_SCALE = 'source';
  } else if (VIDEO_SCALE_OPTIONS.some((option) => option.value === rawScale)) {
    record.VIDEO_SCALE = rawScale;
  } else {
    record.VIDEO_SCALE = 'custom';
  }

  if (record.VIDEO_FPS !== undefined && record.VIDEO_FPS !== null) {
    const fpsValue = String(record.VIDEO_FPS).trim();
    record.VIDEO_FPS = fpsValue || 'source';
  } else {
    record.VIDEO_FPS = 'source';
  }

  if (record.VIDEO_PROFILE !== undefined && record.VIDEO_PROFILE !== null) {
    const profileValue = String(record.VIDEO_PROFILE).trim();
    record.VIDEO_PROFILE = profileValue === '' ? '' : profileValue;
  } else {
    record.VIDEO_PROFILE = '';
  }

  if (record.VIDEO_TUNE !== undefined && record.VIDEO_TUNE !== null) {
    const tuneValue = String(record.VIDEO_TUNE).trim();
    record.VIDEO_TUNE = tuneValue === '' ? '' : tuneValue;
  } else {
    record.VIDEO_TUNE = '';
  }

  if (Object.prototype.hasOwnProperty.call(values, 'VIDEO_VSYNC')) {
    const rawVsync = values.VIDEO_VSYNC;
    if (rawVsync === null || rawVsync === undefined || String(rawVsync).trim() === '') {
      record.VIDEO_VSYNC = '';
    } else {
      record.VIDEO_VSYNC = String(rawVsync).trim();
    }
  } else if (record.VIDEO_VSYNC !== undefined && record.VIDEO_VSYNC !== null) {
    const normalized = String(record.VIDEO_VSYNC).trim();
    record.VIDEO_VSYNC = normalized === '' ? '' : normalized;
  } else {
    record.VIDEO_VSYNC = '';
  }

  ['VIDEO_FILTERS', 'VIDEO_EXTRA_ARGS', 'AUDIO_FILTERS', 'AUDIO_EXTRA_ARGS'].forEach((key) => {
    record[key] = normalizeSequenceValue(record[key]);
  });

  ['VIDEO_GOP_SIZE', 'VIDEO_KEYINT_MIN', 'VIDEO_SC_THRESHOLD', 'VIDEO_SCENE_CUT', 'AUDIO_CHANNELS', 'AUDIO_SAMPLE_RATE'].forEach((key) => {
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
  const scale = record.VIDEO_SCALE || 'source';
  if (scale !== 'custom' && SCALE_PRESET_FILTERS[scale] !== undefined) {
    record.VIDEO_FILTERS = SCALE_PRESET_FILTERS[scale];
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

  const renderTranscoder = () => {
    if (transcoder.loading) {
      return <div className="text-sm text-muted">Loading transcoder settings…</div>;
    }
    const form = transcoder.form;
    const previewArgs = Array.isArray(transcoder.previewArgs) ? transcoder.previewArgs : [];
    let formattedPreview = transcoder.previewCommand || '';
    if (!formattedPreview && previewArgs.length) {
      formattedPreview = previewArgs.join(' ');
    }
    const previewLoading = Boolean(transcoder.previewLoading);
    const previewError = transcoder.previewError;
    const autoKeyframingEnabled = Boolean(form.TRANSCODER_AUTO_KEYFRAMING ?? true);
    const isVideoFieldLocked = (key) => autoKeyframingEnabled && AUTO_KEYFRAME_LOCKED_VIDEO_FIELDS.has(key);
    const isDashFieldLocked = (key) => autoKeyframingEnabled && AUTO_KEYFRAME_LOCKED_DASH_FIELDS.has(key);

    const videoScale = String(form.VIDEO_SCALE || 'source');
    const isCustomScale = videoScale === 'custom';
    const publishBase = typeof form.TRANSCODER_PUBLISH_BASE_URL === 'string'
      ? form.TRANSCODER_PUBLISH_BASE_URL.trim()
      : '';
    const defaultPublishBase = typeof transcoder.defaults?.TRANSCODER_PUBLISH_BASE_URL === 'string'
      ? transcoder.defaults.TRANSCODER_PUBLISH_BASE_URL.trim()
      : '';
    const effectivePublishBase = publishBase || defaultPublishBase;
    const hasEffectivePublishBase = effectivePublishBase.length > 0;

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
        if (key === 'TRANSCODER_PUBLISH_BASE_URL') {
          const trimmed = typeof value === 'string' ? value.trim() : '';
          nextForm[key] = trimmed;
          if (!trimmed) {
            nextForm.TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION = false;
          }
        } else {
          nextForm[key] = value;
        }
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
            <h3 className="text-sm font-semibold text-foreground">Local storage</h3>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
              <TextField
                label="Local output path"
                value={form.TRANSCODER_LOCAL_OUTPUT_DIR ?? ''}
                onChange={(next) => handleFieldChange('TRANSCODER_LOCAL_OUTPUT_DIR', next)}
                helpText="Absolute path on the transcoder host where manifests and segments are written"
              />
              <BooleanField
                label="Expose debug media endpoint"
                value={Boolean(form.TRANSCODER_DEBUG_ENDPOINT_ENABLED ?? true)}
                onChange={(next) => handleFieldChange('TRANSCODER_DEBUG_ENDPOINT_ENABLED', next)}
                helpText="Serve /debug/media for direct access to raw FFmpeg outputs. Disable in production once you've finished debugging."
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              Set this to the path as it exists on the machine running the transcoder service. For remote hosts,
              enter the absolute filesystem location reachable on that node (e.g. /mnt/fastdash).
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Auto keyframing</h3>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
              <BooleanField
                label="Auto Keyframing"
                value={autoKeyframingEnabled}
                onChange={(next) => handleFieldChange('TRANSCODER_AUTO_KEYFRAMING', next)}
                helpText="Lock GOP/keyframe cadence to the source frame rate so DASH segment timing stays consistent."
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              Disable Auto Keyframing only if you need to experiment with custom GOP timing. While enabled, the transcoder
              computes keyframe cadence for you and the dependent fields below are read-only.
            </p>
            <div
              className={`mt-4 rounded-2xl border border-border bg-background/60 p-4 transition ${
                autoKeyframingEnabled ? 'opacity-70' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-foreground">Keyframing controls</h4>
                <span className="rounded-full border border-border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {autoKeyframingEnabled ? 'Managed automatically' : 'Manual overrides active'}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted">
                When Auto Keyframing is enabled the cadence, GOP sizing, and segment timing stay aligned with the source.
                Toggle it off to manually adjust the fields in this section.
              </p>
              <div className="mt-4 grid gap-4 items-start md:grid-cols-2">
                <SelectWithCustomField
                  label={renderLockedLabel('Codec', isVideoFieldLocked('VIDEO_CODEC'))}
                  rawValue={form.VIDEO_CODEC ?? ''}
                  options={VIDEO_CODEC_OPTIONS}
                  onSelect={(choice) => handleSelectWithCustom('VIDEO_CODEC', choice)}
                  onCustomChange={(next) => handleFieldChange('VIDEO_CODEC', next)}
                  disabled={isVideoFieldLocked('VIDEO_CODEC')}
                  helpText={lockHelpText('FFmpeg encoder name (e.g. libx264, h264_nvenc)', isVideoFieldLocked('VIDEO_CODEC'))}
                  customHelpText={lockHelpText('Enter the encoder name exactly as FFmpeg expects (e.g. libx265)', isVideoFieldLocked('VIDEO_CODEC'))}
                />
                <SelectWithCustomField
                  label={renderLockedLabel('FPS', isVideoFieldLocked('VIDEO_FPS'))}
                  rawValue={form.VIDEO_FPS ?? 'source'}
                  options={VIDEO_FPS_OPTIONS}
                  onSelect={(choice) => handleSelectWithCustom('VIDEO_FPS', choice)}
                  onCustomChange={(next) => handleFieldChange('VIDEO_FPS', next)}
                  disabled={isVideoFieldLocked('VIDEO_FPS')}
                  helpText={lockHelpText('Default to the source frame rate or force a common output value', isVideoFieldLocked('VIDEO_FPS'))}
                  customPlaceholder="e.g. 59.94"
                  customHelpText={lockHelpText('Enter the desired output frame rate (e.g. 23.976, 120)', isVideoFieldLocked('VIDEO_FPS'))}
                />
                {VIDEO_FIELD_CONFIG.filter(({ key }) => AUTO_KEYFRAME_LOCKED_VIDEO_FIELDS.has(key)).map(({ key, label, type, helpText: hint }) => {
                  const locked = isVideoFieldLocked(key);
                  const displayLabel = renderLockedLabel(label, locked);
                  return (
                    <TextField
                      key={key}
                      label={displayLabel}
                      type={type}
                      value={form[key] ?? ''}
                      onChange={(next) => handleFieldChange(key, next, type)}
                      disabled={locked}
                      helpText={lockHelpText(hint, locked)}
                    />
                  );
                })}
              </div>
              <div className="mt-4 grid gap-4 items-start md:grid-cols-3">
                {['DASH_SEGMENT_DURATION', 'DASH_FRAGMENT_DURATION', 'DASH_MIN_SEGMENT_DURATION'].map((dashKey) => {
                  const locked = isDashFieldLocked(dashKey);
                  const labelMap = {
                    DASH_SEGMENT_DURATION: 'Segment duration (seconds)',
                    DASH_FRAGMENT_DURATION: 'Fragment duration (seconds)',
                    DASH_MIN_SEGMENT_DURATION: 'Min segment duration (microseconds)',
                  };
                  return (
                    <TextField
                      key={dashKey}
                      label={renderLockedLabel(labelMap[dashKey], locked)}
                      type="number"
                      value={form[dashKey] === '' ? '' : form[dashKey] ?? ''}
                      onChange={(next) => handleFieldChange(dashKey, next, 'number')}
                      disabled={locked}
                      helpText={lockHelpText(
                        dashKey === 'DASH_SEGMENT_DURATION'
                          ? "Override FFmpeg's target segment duration. Leave blank to use the default."
                          : dashKey === 'DASH_FRAGMENT_DURATION'
                            ? 'Optional fragment duration for CMAF outputs (leave blank to follow segment duration).'
                            : 'FFmpeg dash muxer minimum segment duration in microseconds.',
                        locked,
                      )}
                    />
                  );
                })}
              </div>
              <div className="mt-4">
                <TextAreaField
                  label={renderLockedLabel('Extra Arguments', isVideoFieldLocked('VIDEO_EXTRA_ARGS'))}
                  value={form.VIDEO_EXTRA_ARGS ?? ''}
                  onChange={(next) => handleFieldChange('VIDEO_EXTRA_ARGS', next)}
                  placeholder="One argument per line"
                  rows={3}
                  disabled={isVideoFieldLocked('VIDEO_EXTRA_ARGS')}
                  helpText={lockHelpText('Newline separated; each entry is appended after video options', isVideoFieldLocked('VIDEO_EXTRA_ARGS'))}
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Publish</h3>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2 lg:grid-cols-4">
              <TextField
                label="Publish Base URL"
                value={form.TRANSCODER_PUBLISH_BASE_URL ?? ''}
                onChange={(next) => handleFieldChange('TRANSCODER_PUBLISH_BASE_URL', next)}
                helpText={hasEffectivePublishBase
                  ? publishBase
                    ? `Point at your ingest server's /media/ PUT endpoint. Default fallback: ${defaultPublishBase || 'http://localhost:5005/media/'}.`
                    : `Leave blank to use the default ingest endpoint (${effectivePublishBase}). Override it when publishing to another host.`
                  : 'Point at your ingest server\'s /media/ PUT endpoint (e.g. http://localhost:5005/media/).'}
              />
              <BooleanField
                label="Force new HTTP connection per PUT"
                value={Boolean(form.TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION)}
                onChange={(next) => handleFieldChange('TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION', next)}
                helpText={hasEffectivePublishBase
                  ? `Close each HTTP session after uploading a segment or manifest (current target: ${effectivePublishBase}).`
                  : 'Provide an ingest endpoint so we know where to publish segments.'}
              />
              <BooleanField
                label="Copy input timestamps (-copyts)"
                value={Boolean(form.TRANSCODER_COPY_TIMESTAMPS ?? true)}
                onChange={(next) => handleFieldChange('TRANSCODER_COPY_TIMESTAMPS', next)}
                helpText="Forward source timestamps to FFmpeg. Disable to let the encoder regenerate a fresh timeline."
              />
              <BooleanField
                label="Start at zero"
                value={Boolean(form.TRANSCODER_START_AT_ZERO ?? true)}
                onChange={(next) => handleFieldChange('TRANSCODER_START_AT_ZERO', next)}
                helpText="Insert -start_at_zero so output timestamps begin at t=0."
              />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">Live edge</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-3">
            <TextField
              label="Availability offset (seconds)"
              value={form.DASH_AVAILABILITY_OFFSET ?? ''}
              onChange={(next) => handleFieldChange('DASH_AVAILABILITY_OFFSET', next)}
              helpText="Delay manifest availability by this many seconds to keep players a safe distance from the encoder."
            />
            <TextField
              label="Window size (segments)"
              type="number"
              value={form.DASH_WINDOW_SIZE === '' ? '' : form.DASH_WINDOW_SIZE ?? ''}
              onChange={(next) => handleFieldChange('DASH_WINDOW_SIZE', next, 'number')}
              helpText="Core number of segments FFmpeg retains inside the DASH window."
            />
            <TextField
              label="Extra window (segments)"
              type="number"
              value={form.DASH_EXTRA_WINDOW_SIZE === '' ? '' : form.DASH_EXTRA_WINDOW_SIZE ?? ''}
              onChange={(next) => handleFieldChange('DASH_EXTRA_WINDOW_SIZE', next, 'number')}
              helpText="Additional segments advertised beyond the core window before trimming begins."
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Increase the window sizes to expose a deeper live buffer. Pair these values with the ingest retention setting so published segments remain available on disk.
          </p>
        </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">DASH advanced</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-3">
            <TextField
              label="Mux preload (seconds)"
              type="number"
              value={form.DASH_MUX_PRELOAD === '' ? '' : form.DASH_MUX_PRELOAD ?? ''}
              onChange={(next) => handleFieldChange('DASH_MUX_PRELOAD', next, 'number')}
              helpText="Controls ffmpeg -muxpreload to buffer output before writing segments."
            />
            <TextField
              label="Mux delay (seconds)"
              type="number"
              value={form.DASH_MUX_DELAY === '' ? '' : form.DASH_MUX_DELAY ?? ''}
              onChange={(next) => handleFieldChange('DASH_MUX_DELAY', next, 'number')}
              helpText="Controls ffmpeg -muxdelay to limit muxing latency."
            />
            <TextField
              label="Retention override"
              type="number"
              value={form.DASH_RETENTION_SEGMENTS === '' ? '' : form.DASH_RETENTION_SEGMENTS ?? ''}
              onChange={(next) => handleFieldChange('DASH_RETENTION_SEGMENTS', next, 'number')}
              helpText="Optional override for the FFmpeg dash retention window (leave blank to auto-calc)."
            />
          </div>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2 lg:grid-cols-4">
            <BooleanField
              label="Streaming mode"
              value={Boolean(form.DASH_STREAMING ?? false)}
              onChange={(next) => handleFieldChange('DASH_STREAMING', next)}
              helpText="Enable the dash muxer streaming mode (-streaming 1)."
            />
            <BooleanField
              label="Remove at exit"
              value={Boolean(form.DASH_REMOVE_AT_EXIT)}
              onChange={(next) => handleFieldChange('DASH_REMOVE_AT_EXIT', next)}
              helpText="Delete generated segments when the encoder exits."
            />
            <BooleanField
              label="Use template"
              value={Boolean(form.DASH_USE_TEMPLATE ?? false)}
              onChange={(next) => handleFieldChange('DASH_USE_TEMPLATE', next)}
              helpText="Emit SegmentTemplate entries in the MPD."
            />
            <BooleanField
              label="Use timeline"
              value={Boolean(form.DASH_USE_TIMELINE ?? false)}
              onChange={(next) => handleFieldChange('DASH_USE_TIMELINE', next)}
              helpText="Emit SegmentTimeline entries in the MPD."
            />
          </div>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <TextField
              label="HTTP user agent"
              value={form.DASH_HTTP_USER_AGENT ?? ''}
              onChange={(next) => handleFieldChange('DASH_HTTP_USER_AGENT', next)}
              helpText="Custom user agent for FFmpeg HTTP requests (blank uses default)."
            />
            <TextField
              label="Adaptation sets"
              value={form.DASH_ADAPTATION_SETS ?? ''}
              onChange={(next) => handleFieldChange('DASH_ADAPTATION_SETS', next)}
              helpText="Custom adaptation set expression passed to FFmpeg (e.g. id=0,streams=v)."
            />
          </div>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <TextField
              label="Init segment name"
              value={form.DASH_INIT_SEGMENT_NAME ?? ''}
              onChange={(next) => handleFieldChange('DASH_INIT_SEGMENT_NAME', next)}
              helpText="Format string for init segments (leave blank for FFmpeg default)."
            />
            <TextField
              label="Media segment name"
              value={form.DASH_MEDIA_SEGMENT_NAME ?? ''}
              onChange={(next) => handleFieldChange('DASH_MEDIA_SEGMENT_NAME', next)}
              helpText="Format string for media segments."
            />
          </div>
          <div className="mt-3">
            <TextAreaField
              label="Extra DASH args"
              value={form.DASH_EXTRA_ARGS ?? ''}
              onChange={(next) => handleFieldChange('DASH_EXTRA_ARGS', next)}
              rows={3}
              helpText="One extra ffmpeg dash muxer argument per line (e.g. --utc_timing_url http://example.com/time)."
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">Subtitles</h3>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
              <SelectField
                label="Preferred language"
                value={form.SUBTITLE_PREFERRED_LANGUAGE ?? 'en'}
                onChange={(next) => handleFieldChange('SUBTITLE_PREFERRED_LANGUAGE', next)}
                options={SUBTITLE_LANGUAGE_OPTIONS}
                helpText="Prioritise subtitle tracks in this language when extracting VTT files."
              />
            </div>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-3">
              <BooleanField
                label="Include forced"
                value={Boolean(form.SUBTITLE_INCLUDE_FORCED)}
                onChange={(next) => handleFieldChange('SUBTITLE_INCLUDE_FORCED', next)}
                helpText="Also convert forced subtitles in the chosen language."
              />
              <BooleanField
                label="Include commentary"
                value={Boolean(form.SUBTITLE_INCLUDE_COMMENTARY)}
                onChange={(next) => handleFieldChange('SUBTITLE_INCLUDE_COMMENTARY', next)}
                helpText="Convert commentary versions when available."
              />
              <BooleanField
                label="Include SDH"
                value={Boolean(form.SUBTITLE_INCLUDE_SDH)}
                onChange={(next) => handleFieldChange('SUBTITLE_INCLUDE_SDH', next)}
                helpText="Include subtitles for the deaf or hard of hearing."
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              Leaving these toggles off keeps the conversion focused on a single track. Enable specific variants to keep
              them alongside the base subtitles.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Video Encoding</h3>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
              <SelectField
                label="Scale"
                value={videoScale}
                onChange={handleScaleChange}
                options={VIDEO_SCALE_OPTIONS}
                helpText="Select a preset scaling filter or choose Custom to enter filters manually"
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
              <SelectWithCustomField
                label="Profile"
                rawValue={form.VIDEO_PROFILE ?? ''}
                options={VIDEO_PROFILE_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('VIDEO_PROFILE', choice)}
                onCustomChange={(next) => handleFieldChange('VIDEO_PROFILE', next)}
                helpText="Select a standard profile or choose None to keep the encoder default"
                customHelpText="Enter the encoder-specific profile string if it is not listed"
              />
              <SelectWithCustomField
                label="Tune"
                rawValue={form.VIDEO_TUNE ?? ''}
                options={VIDEO_TUNE_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('VIDEO_TUNE', choice)}
                onCustomChange={(next) => handleFieldChange('VIDEO_TUNE', next)}
                helpText="Optional encoder tuning flags"
                customHelpText="Enter a tune flag accepted by the encoder"
              />
              <SelectWithCustomField
                label="VSync"
                rawValue={form.VIDEO_VSYNC ?? ''}
                options={VIDEO_VSYNC_OPTIONS}
                onSelect={(choice) => handleSelectWithCustom('VIDEO_VSYNC', choice)}
                onCustomChange={(next) => handleFieldChange('VIDEO_VSYNC', next)}
                helpText="Control how FFmpeg synchronizes video frames"
                customHelpText="Enter a vsync value supported by FFmpeg"
              />
              {VIDEO_FIELD_CONFIG.filter(({ key }) => !AUTO_KEYFRAME_LOCKED_VIDEO_FIELDS.has(key)).map(
                ({ key, label, type, helpText: hint }) => (
                  <TextField
                    key={key}
                    label={label}
                    type={type}
                    value={form[key] ?? ''}
                    onChange={(next) => handleFieldChange(key, next, type)}
                    helpText={hint}
                  />
                ),
              )}
            </div>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
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
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Audio Encoding</h3>
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
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
            <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
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

  const renderPlayer = () => {
    if (playerSettings.loading) {
      return <div className="text-sm text-muted">Loading player settings…</div>;
    }

    const form = playerSettings.form || {};
    const streaming = form.streaming || {};
    const delay = streaming.delay || {};
    const catchup = streaming.liveCatchup || {};
    const playback = catchup.playbackRate || {};
    const buffer = streaming.buffer || {};
    const textPrefs = streaming.text || {};

    const displayNumeric = (value) => {
      if (typeof value === 'string') {
        return value;
      }
      if (value === null || value === undefined || Number.isNaN(value)) {
        return '';
      }
      return `${value}`;
    };

    const updateForm = (producer) => {
      setPlayerSettings((state) => {
        const nextForm = clonePlayerSettings(state.form);
        producer(nextForm);
        return {
          ...state,
          form: nextForm,
          feedback: null,
        };
      });
    };

    const mutateDelay = (modifier) => {
      updateForm((draft) => {
        const streamingDraft = draft.streaming ?? (draft.streaming = {});
        const delayDraft = streamingDraft.delay ?? (streamingDraft.delay = {});
        modifier(delayDraft);
      });
    };

    const mutateCatchup = (modifier) => {
      updateForm((draft) => {
        const streamingDraft = draft.streaming ?? (draft.streaming = {});
        const catchupDraft = streamingDraft.liveCatchup ?? (streamingDraft.liveCatchup = {});
        modifier(catchupDraft);
      });
    };

    const mutatePlayback = (modifier) => {
      mutateCatchup((catchupDraft) => {
        catchupDraft.playbackRate = catchupDraft.playbackRate ?? {};
        modifier(catchupDraft.playbackRate);
      });
    };

    const mutateBuffer = (modifier) => {
      updateForm((draft) => {
        const streamingDraft = draft.streaming ?? (draft.streaming = {});
        const bufferDraft = streamingDraft.buffer ?? (streamingDraft.buffer = {});
        modifier(bufferDraft);
      });
    };

    const mutateText = (modifier) => {
      updateForm((draft) => {
        const streamingDraft = draft.streaming ?? (draft.streaming = {});
        const textDraft = streamingDraft.text ?? (streamingDraft.text = {});
        modifier(textDraft);
      });
    };

    const handleSave = async () => {
      const sanitizedForm = sanitizePlayerRecord(playerSettings.form);
      const sanitizedCurrent = sanitizePlayerRecord(playerSettings.data);
      if (JSON.stringify(sanitizedForm) === JSON.stringify(sanitizedCurrent)) {
        setPlayerSettings((state) => ({
          ...state,
          feedback: { tone: 'info', message: 'No changes to save.' },
        }));
        return;
      }
      setPlayerSettings((state) => ({
        ...state,
        saving: true,
        feedback: { tone: 'info', message: 'Saving…' },
      }));
      try {
        const updated = await updateSystemSettings('player', sanitizedForm);
        const updatedDefaults = sanitizePlayerRecord(updated?.defaults || playerSettings.defaults);
        const updatedSettings = sanitizePlayerRecord(updated?.settings || sanitizedForm);
        setPlayerSettings({
          loading: false,
          data: updatedSettings,
          defaults: updatedDefaults,
          form: clonePlayerSettings(updatedSettings),
          feedback: { tone: 'success', message: 'Player settings saved.' },
          saving: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save player settings.';
        setPlayerSettings((state) => ({
          ...state,
          saving: false,
          feedback: { tone: 'error', message },
        }));
      }
    };

    return (
      <SectionContainer title="Player settings">
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <TextField
              label="Live delay (seconds)"
              type="number"
              value={displayNumeric(delay.liveDelay)}
              onChange={(next) => {
                const trimmed = typeof next === 'string' ? next.trim() : '';
                mutateDelay((draft) => {
                  draft.liveDelay = trimmed;
                });
              }}
              helpText="Leave blank to let dash.js infer a live delay from the manifest."
            />
            <TextField
              label="Delay fragment count"
              type="number"
              value={displayNumeric(delay.liveDelayFragmentCount)}
              onChange={(next) => {
                mutateDelay((draft) => {
                  draft.liveDelayFragmentCount = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Number of segments dash.js buffers when no explicit delay is provided."
            />
            <BooleanField
              label="Use suggested delay"
              value={coerceBoolean(delay.useSuggestedPresentationDelay, true)}
              onChange={(checked) => {
                mutateDelay((draft) => {
                  draft.useSuggestedPresentationDelay = checked;
                });
              }}
              helpText="Respect the manifest's suggestedPresentationDelay when available."
            />
            <TextField
              label="Attach wait segments"
              type="number"
              value={displayNumeric(form.attachMinimumSegments)}
              onChange={(next) => {
                updateForm((draft) => {
                  draft.attachMinimumSegments = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Delay player attach until at least this many segments are reachable."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <BooleanField
              label="Enable live catch-up"
              value={coerceBoolean(catchup.enabled, true)}
              onChange={(checked) => {
                mutateCatchup((draft) => {
                  draft.enabled = checked;
                });
              }}
              helpText="Allow dash.js to adjust playback speed when the client drifts behind."
            />
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Min drift (seconds)"
                type="number"
                value={displayNumeric(catchup.minDrift)}
                onChange={(next) => {
                  mutateCatchup((draft) => {
                    draft.minDrift = typeof next === 'string' ? next.trim() : next;
                  });
                }}
                helpText="Catch-up stays idle until drift exceeds this threshold."
              />
              <TextField
                label="Max drift (seconds)"
                type="number"
                value={displayNumeric(catchup.maxDrift)}
                onChange={(next) => {
                  mutateCatchup((draft) => {
                    draft.maxDrift = typeof next === 'string' ? next.trim() : next;
                  });
                }}
                helpText="When drift exceeds this threshold, dash.js adjusts playback speed."
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                label="Catch-up rate min"
                type="number"
                value={displayNumeric(playback.min)}
                onChange={(next) => {
                  mutatePlayback((draft) => {
                    draft.min = typeof next === 'string' ? next.trim() : next;
                  });
                }}
                helpText="Lower bound for catch-up playback rate adjustments."
              />
              <TextField
                label="Catch-up rate max"
                type="number"
                value={displayNumeric(playback.max)}
                onChange={(next) => {
                  mutatePlayback((draft) => {
                    draft.max = typeof next === 'string' ? next.trim() : next;
                  });
                }}
                helpText="Upper bound for catch-up playback rate adjustments."
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <BooleanField
              label="Fast switch"
              value={coerceBoolean(buffer.fastSwitchEnabled, false)}
              onChange={(checked) => {
                mutateBuffer((draft) => {
                  draft.fastSwitchEnabled = checked;
                });
              }}
              helpText="Allow dash.js to switch to higher representations mid-stream when bandwidth improves."
            />
            <TextField
              label="Buffer pruning interval"
              type="number"
              value={displayNumeric(buffer.bufferPruningInterval)}
              onChange={(next) => {
                mutateBuffer((draft) => {
                  draft.bufferPruningInterval = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Cadence (seconds) for trimming old segments from the buffer."
            />
            <TextField
              label="Buffer to keep"
              type="number"
              value={displayNumeric(buffer.bufferToKeep)}
              onChange={(next) => {
                mutateBuffer((draft) => {
                  draft.bufferToKeep = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Minimum segment duration to keep buffered behind the current position."
            />
            <TextField
              label="Top quality buffer"
              type="number"
              value={displayNumeric(buffer.bufferTimeAtTopQuality)}
              onChange={(next) => {
                mutateBuffer((draft) => {
                  draft.bufferTimeAtTopQuality = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Ideal buffer length (seconds) when already playing top quality."
            />
            <TextField
              label="Top quality buffer (long form)"
              type="number"
              value={displayNumeric(buffer.bufferTimeAtTopQualityLongForm)}
              onChange={(next) => {
                mutateBuffer((draft) => {
                  draft.bufferTimeAtTopQualityLongForm = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Long-form buffer target for top quality streams."
            />
            <TextField
              label="Stable buffer time"
              type="number"
              value={displayNumeric(buffer.stableBufferTime)}
              onChange={(next) => {
                mutateBuffer((draft) => {
                  draft.stableBufferTime = typeof next === 'string' ? next.trim() : next;
                });
              }}
              helpText="Target buffer (seconds) dash.js tries to maintain before allowing playback."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <BooleanField
              label="Enable text tracks by default"
              value={coerceBoolean(textPrefs.defaultEnabled, false)}
              onChange={(checked) => {
                mutateText((draft) => {
                  draft.defaultEnabled = checked;
                });
              }}
              helpText="Automatically enable subtitles when available."
            />
            <TextField
              label="Preferred subtitle language"
              value={textPrefs.defaultLanguage ?? textPrefs.preferredLanguage ?? ''}
              onChange={(next) => {
                mutateText((draft) => {
                  let resolved = next;
                  if (typeof next === 'string') {
                    resolved = next;
                  } else if (next == null) {
                    resolved = '';
                  } else {
                    resolved = String(next);
                  }
                  draft.defaultLanguage = resolved;
                  if ('preferredLanguage' in draft) {
                    delete draft.preferredLanguage;
                  }
                });
              }}
              helpText="ISO language code (e.g. en, es) to auto-select when subtitles are enabled."
            />
          </div>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <Feedback message={playerSettings.feedback?.message} tone={playerSettings.feedback?.tone} />
          <DiffButton onClick={handleSave} disabled={playerSettings.saving}>
            Save changes
          </DiffButton>
        </div>
      </SectionContainer>
    );
  };

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

  const renderTasks = () => {
    const showInitialPlaceholder = !tasksState.loaded && !tasksState.loading;
    const showLoadingBanner = tasksState.loading;

    const form = tasksState.form || {};
    let jobs = Array.isArray(form.beat_jobs) ? form.beat_jobs : [];
    if (jobs.length === 0 && Array.isArray(tasksState.data?.beat_jobs) && tasksState.data.beat_jobs.length > 0) {
      jobs = cloneTasksForm(tasksState.data).beat_jobs;
    }
    const snapshot = tasksState.snapshot || {};
    const activeTasks = Array.isArray(snapshot.active) ? snapshot.active : [];
    const scheduledTasks = Array.isArray(snapshot.scheduled) ? snapshot.scheduled : [];
    const reservedTasks = Array.isArray(snapshot.reserved) ? snapshot.reserved : [];
    const normalizedForm = sanitizeTasksRecord(
      {
        beat_jobs: jobs,
        refresh_interval_seconds:
          form.refresh_interval_seconds ?? tasksState.defaults.refresh_interval_seconds ?? TASK_DEFAULT_REFRESH_INTERVAL,
      },
      tasksState.defaults,
    );
    const refreshInterval = normalizedForm.refresh_interval_seconds ?? TASK_DEFAULT_REFRESH_INTERVAL;
    const hasChanges = hasTaskChanges(tasksState.data, normalizedForm);
    const snapshotError = snapshot?.error ? String(snapshot.error) : null;
    const stoppingMap = tasksState.stopping || {};

    const updateJob = (jobId, patch) => {
      setTasksState((state) => {
        const existing = Array.isArray(state.form.beat_jobs) ? state.form.beat_jobs : [];
        const nextJobs = existing.map((job) => {
          if (job.id !== jobId) {
            return job;
          }
          const delta = typeof patch === 'function' ? patch(job) : patch;
          const merged = { ...job, ...(delta || {}) };
          const nextQueue = typeof merged.queue === 'string' ? merged.queue.trim() : job.queue ?? '';
          const clampedSchedule = clampTaskSchedule(
            merged.schedule_seconds ?? job.schedule_seconds ?? TASK_SCHEDULE_MIN_SECONDS,
            job.schedule_seconds ?? TASK_SCHEDULE_MIN_SECONDS,
          );
          return {
            ...merged,
            queue: nextQueue,
            schedule_seconds: clampedSchedule,
            enabled: Boolean(merged.enabled),
          };
        });
        return {
          ...state,
          form: {
            ...state.form,
            beat_jobs: nextJobs,
          },
          feedback: null,
        };
      });
    };

    const handleRefreshIntervalChange = (value) => {
      const nextInterval = clampTaskRefreshInterval(value, refreshInterval);
      setTasksState((state) => ({
        ...state,
        form: {
          ...state.form,
          refresh_interval_seconds: nextInterval,
        },
        feedback: null,
      }));
    };

    const payloadForm = cloneTasksForm(normalizedForm);

    const handleSave = async () => {
      if (!hasChanges) {
        setTasksState((state) => ({
          ...state,
          feedback: { tone: 'info', message: 'No changes to save.' },
        }));
        return;
      }
      setTasksState((state) => ({
        ...state,
        saving: true,
        feedback: { tone: 'info', message: 'Saving…' },
      }));
      try {
        const response = await updateSystemSettings('tasks', payloadForm);
        if (!isMountedRef.current) {
          return;
        }
        const nextDefaults = sanitizeTasksRecord(response?.defaults || tasksState.defaults);
        const nextSettings = sanitizeTasksRecord(response?.settings || payloadForm, nextDefaults);
        setTasksState({
          loading: false,
          loaded: true,
          data: nextSettings,
          defaults: nextDefaults,
          form: cloneTasksForm(nextSettings),
          snapshot: response?.snapshot ?? tasksState.snapshot,
          feedback: { tone: 'success', message: 'Task schedule updated.' },
          saving: false,
          stopping: {},
        });
      } catch (err) {
        if (!isMountedRef.current) {
          return;
        }
        setTasksState((state) => ({
          ...state,
          saving: false,
          feedback: { tone: 'error', message: err instanceof Error ? err.message : 'Unable to save schedule.' },
        }));
      }
    };

    const handleRefreshSnapshot = () => {
      void loadTasksSettings({ refresh: true, preserveForm: true });
    };

    const handleStopTaskClick = async (taskId) => {
      if (!taskId) {
        return;
      }
      setTasksState((state) => ({
        ...state,
        stopping: { ...state.stopping, [taskId]: true },
        feedback: { tone: 'info', message: 'Stopping task…' },
      }));
      try {
        const result = await stopTask(taskId, { terminate: false });
        if (!isMountedRef.current) {
          return;
        }
        setTasksState((state) => {
          const nextStopping = { ...state.stopping };
          delete nextStopping[taskId];
          return {
            ...state,
            snapshot: result?.snapshot ?? state.snapshot,
            feedback: { tone: 'success', message: 'Task stop requested.' },
            stopping: nextStopping,
          };
        });
      } catch (err) {
        if (!isMountedRef.current) {
          return;
        }
        setTasksState((state) => {
          const nextStopping = { ...state.stopping };
          delete nextStopping[taskId];
          return {
            ...state,
            feedback: { tone: 'error', message: err instanceof Error ? err.message : 'Unable to stop task.' },
            stopping: nextStopping,
          };
        });
      }
    };

    const renderRuntimeGroup = (title, items, allowStop = false) => (
      <div key={title} className="rounded-2xl border border-border bg-background/60 p-4">
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-subtle">
          <span>{title}</span>
          <span className="text-muted">{items.length}</span>
        </div>
        <div className="mt-3 space-y-3">
          {items.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            items.map((task, index) => {
              const runtimeLabel = formatRuntimeSeconds(task.runtime);
              const etaLabel = formatEta(task.eta);
              const argsLabel = summarizeArgs(task.args);
              const kwargsLabel = summarizeKwargs(task.kwargs);
              const workerLabel = [task.worker, task.queue].filter(Boolean).join(' · ');
              const key = task.id || `${title}-${index}`;
              const stopping = Boolean(stoppingMap[task.id]);
              return (
                <div key={key} className="rounded-xl border border-border bg-background/50 p-3">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{task.name || task.id || 'Unnamed task'}</p>
                      {workerLabel ? <p className="text-xs text-subtle">{workerLabel}</p> : null}
                      {etaLabel ? <p className="text-[11px] text-muted">ETA: {etaLabel}</p> : null}
                      {argsLabel ? <p className="text-[11px] text-muted">Args: {argsLabel}</p> : null}
                      {kwargsLabel ? <p className="text-[11px] text-muted">Kwargs: {kwargsLabel}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {runtimeLabel ? <span className="text-xs text-muted">{runtimeLabel}</span> : null}
                      {allowStop && task.id ? (
                        <button
                          type="button"
                          onClick={() => handleStopTaskClick(task.id)}
                          disabled={stopping}
                          className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {stopping ? 'Stopping…' : 'Stop'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );

    let lastUpdated = 'Not available';
    if (snapshot?.timestamp) {
      const timestampDate = new Date(snapshot.timestamp);
      if (!Number.isNaN(timestampDate.getTime())) {
        lastUpdated = timestampDate.toLocaleString();
      }
    }

    return (
      <SectionContainer title="Background tasks">
        <div className="space-y-6">
          {showInitialPlaceholder ? (
            <div className="text-sm text-muted">Task details load when this section is opened.</div>
          ) : null}
          {showLoadingBanner ? (
            <div className="rounded-xl border border-border bg-background/60 p-4 text-sm text-muted">
              Loading task schedule…
            </div>
          ) : null}
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="md:w-72">
              <TextField
                label="Schedule refresh interval (seconds)"
                type="number"
                value={refreshInterval}
                onChange={handleRefreshIntervalChange}
                helpText="How often workers poll for schedule changes."
              />
            </div>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <button
                type="button"
                onClick={handleRefreshSnapshot}
                disabled={tasksState.loading || tasksState.saving}
                className="rounded-full border border-border px-5 py-2 text-sm font-semibold text-muted transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tasksState.loading ? 'Refreshing…' : 'Refresh status'}
              </button>
              <DiffButton onClick={handleSave} disabled={!hasChanges || tasksState.saving}>
                {tasksState.saving ? 'Saving…' : 'Save changes'}
              </DiffButton>
            </div>
          </div>
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Scheduled jobs</h3>
            {jobs.length === 0 ? (
              <div className="rounded-xl border border-border bg-background/60 p-4 text-sm text-muted">
                No periodic jobs defined.
              </div>
            ) : (
              <div className="space-y-4">
                {jobs.map((job) => (
                  <div key={job.id} className="rounded-2xl border border-border bg-background/70 p-4">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{job.name || job.id}</p>
                        <p className="text-xs text-subtle">{job.task}</p>
                        {job.run_on_start ? (
                          <p className="text-[11px] text-emerald-300">Runs when the API starts</p>
                        ) : null}
                      </div>
                      <BooleanField
                        label="Enabled"
                        value={job.enabled}
                        onChange={(next) => updateJob(job.id, { enabled: next })}
                      />
                    </div>
                    <div className="mt-4 grid gap-4 md:grid-cols-3">
                      <TextField
                        label="Interval (seconds)"
                        type="number"
                        value={job.schedule_seconds}
                        onChange={(value) => updateJob(job.id, { schedule_seconds: clampTaskSchedule(value, job.schedule_seconds) })}
                      />
                      <TextField
                        label="Queue"
                        value={job.queue ?? ''}
                        onChange={(value) => updateJob(job.id, { queue: value })}
                        helpText="Routing key / queue name (optional)."
                      />
                      <TextField
                        label="Priority"
                        type="number"
                        value={job.priority ?? ''}
                        onChange={(value) => {
                          const numeric = Number.parseInt(value, 10);
                          updateJob(job.id, {
                            priority: Number.isNaN(numeric) ? null : numeric,
                          });
                        }}
                        helpText="Celery priority (optional)."
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs uppercase tracking-wide text-subtle">
              <span>Runtime snapshot</span>
              <span className="text-muted">Last updated {lastUpdated}</span>
            </div>
            {snapshotError ? (
              <p className="text-xs text-rose-300">{snapshotError}</p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-3">
              {renderRuntimeGroup('Active', activeTasks, true)}
              {renderRuntimeGroup('Scheduled', scheduledTasks, true)}
              {renderRuntimeGroup('Reserved', reservedTasks, true)}
            </div>
          </div>
          <Feedback message={tasksState.feedback?.message} tone={tasksState.feedback?.tone} />
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
      const finalWidth = thumbnailWidth;
      const finalHeight = deriveHeightFromWidth(finalWidth);
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
          : 'Unable to queue section cache refresh.';
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
                  title={identifier ? (isHidden ? 'Show this section' : 'Hide this section') : 'Identifier unavailable for toggling'}
                  aria-disabled={!identifier}
                  aria-pressed={Boolean(identifier) && !isHidden}
                >
                  <div className="flex flex-col">
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
                    <span className={`text-xs font-semibold uppercase tracking-wide ${isHidden ? 'text-rose-300' : 'text-emerald-300'}`}>
                      {isHidden ? 'Hidden' : 'Visible'}
                    </span>
                    <FontAwesomeIcon icon={isHidden ? faEyeSlash : faEye} className={isHidden ? 'text-rose-300' : 'text-emerald-300'} />
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
    const visibleGroups = groupsState.items.filter((group) => group.slug !== ADMIN_GROUP_SLUG);
    const orderedGroups = [
      ...GROUP_DISPLAY_ORDER.map((slug) => visibleGroups.find((group) => group.slug === slug)).filter(Boolean),
      ...visibleGroups.filter((group) => !GROUP_DISPLAY_ORDER.includes(group.slug)),
    ];
    if (orderedGroups.length === 0) {
      return (
        <div className="rounded-2xl border border-dashed border-border bg-background/40 px-4 py-8 text-center text-sm text-muted">
          No editable groups available.
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {orderedGroups.map((group) => (
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

  const renderSystem = () => (
    <SectionContainer title="System controls">
      <p>
        Restart backend services to apply new settings or recover from a stalled process. Each restart
        takes a few seconds and may briefly interrupt active sessions.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {SYSTEM_SERVICES.map((service) => {
          const status = systemState.statuses?.[service.id] ?? {};
          const state = status.state ?? 'idle';
          const message = status.message ?? '';
          const isPending = state === 'pending';
          const toneClass = state === 'error'
            ? 'text-rose-300'
            : state === 'success'
              ? 'text-emerald-300'
              : 'text-subtle';

          return (
            <div key={service.id} className="rounded-2xl border border-border bg-background/70 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{service.label}</h3>
                  {service.description ? (
                    <p className="text-xs text-subtle">{service.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => handleRestartService(service.id)}
                  disabled={isPending}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    isPending
                      ? 'cursor-wait border-border text-subtle'
                      : 'border-amber-400 text-amber-200 hover:bg-amber-400/10'
                  }`}
                >
                  <FontAwesomeIcon
                    icon={isPending ? faCircleNotch : faArrowsRotate}
                    spin={isPending}
                    className="h-4 w-4"
                  />
                  <span>{isPending ? 'Restarting…' : 'Restart'}</span>
                </button>
              </div>
              {message ? <p className={`mt-3 text-xs ${toneClass}`}>{message}</p> : null}
            </div>
          );
        })}
      </div>
    </SectionContainer>
  );

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
        {activeSection === 'system' ? renderSystem() : null}
        {activeSection === 'transcoder' ? renderTranscoder() : null}
        {activeSection === 'player' ? renderPlayer() : null}
        {activeSection === 'ingest' ? renderIngest() : null}
        {activeSection === 'library' ? renderLibrary() : null}
        {activeSection === 'redis' ? renderRedis() : null}
        {activeSection === 'tasks' ? renderTasks() : null}
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
