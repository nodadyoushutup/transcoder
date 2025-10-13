import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock } from '@fortawesome/free-solid-svg-icons';
import { updateSystemSettings } from '../../../lib/api.js';
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
} from '../shared.jsx';

const TRANSCODER_ALLOWED_KEYS = [
  'TRANSCODER_PUBLISH_BASE_URL',
  'TRANSCODER_COPY_TIMESTAMPS',
  'TRANSCODER_START_AT_ZERO',
  'TRANSCODER_DEBUG_ENDPOINT_ENABLED',
  'TRANSCODER_LOCAL_OUTPUT_DIR',
  'TRANSCODER_AUTO_KEYFRAMING',
  'TRANSCODER_AUTO_KEYFRAMING_WINDOW',
  'TRANSCODER_AUTO_KEYFRAMING_MIN_GOP',
  'TRANSCODER_AUTO_KEYFRAMING_MAX_GOP',
  'TRANSCODER_AUTO_KEYFRAMING_SCENE_CUT',
  'TRANSCODER_AUTO_KEYFRAMING_LIVE_LATENCY',
  'TRANSCODER_AUTO_KEYFRAMING_MAX_KEY_INTERVAL',
  'TRANSCODER_AUTO_KEYFRAMING_MIN_KEY_INTERVAL',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_FPS',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_TIMESCALE',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_FRAGMENT',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_SEGMENT',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_PLAYLIST_DEPTH',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_BUFFER',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_LIVE_EDGE',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_MSL',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_AVAILABILITY',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_LOOKAHEAD',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_PREROLL',
  'TRANSCODER_AUTO_KEYFRAMING_DEFAULT_THRESHOLD',
  'SHAKA_PACKAGER_BINARY',
  'SHAKA_SEGMENT_DURATION',
  'SHAKA_PRESERVED_SEGMENTS_OUTSIDE_LIVE_WINDOW',
  'SHAKA_MINIMUM_UPDATE_PERIOD',
  'SHAKA_MIN_BUFFER_TIME',
  'SHAKA_TIME_SHIFT_BUFFER_DEPTH',
  'SHAKA_DEFAULT_AUDIO_LANGUAGE',
  'SHAKA_OUTPUT_SUBDIR',
  'SHAKA_GENERATE_HLS',
  'SHAKA_HLS_MASTER_PLAYLIST',
  'SHAKA_ALLOW_APPROXIMATE_SEGMENT_TIMELINE',
  'SHAKA_ADDITIONAL_ARGS',
  'SHAKA_EXTRA_FLAGS',
  'DASH_AVAILABILITY_OFFSET',
  'DASH_WINDOW_SIZE',
  'DASH_EXTRA_WINDOW_SIZE',
  'DASH_STREAMING',
  'DASH_REMOVE_AT_EXIT',
  'DASH_USE_TEMPLATE',
  'DASH_USE_TIMELINE',
  'DASH_HTTP_USER_AGENT',
  'DASH_ADAPTATION_SETS',
  'DASH_MUX_PRELOAD',
  'DASH_MUX_DELAY',
  'DASH_RETENTION_SEGMENTS',
  'DASH_MEDIA_SEGMENT_NAME',
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
  { key: 'VIDEO_BITRATE', label: 'Bitrate', type: 'text', helpText: 'Target bitrate (e.g. 5M)' },
  { key: 'VIDEO_MAXRATE', label: 'Max Rate', type: 'text', helpText: 'Peak bitrate cap (e.g. 5M)' },
  { key: 'VIDEO_BUFSIZE', label: 'Buffer Size', type: 'text', helpText: 'VBV buffer size (e.g. 10M)' },
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

function renderLockedLabel(label, locked) {
  if (!locked) {
    return label;
  }
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <FontAwesomeIcon icon={faLock} className="text-[11px] text-muted" />
    </span>
  );
}

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
  { key: 'AUDIO_BITRATE', label: 'Bitrate', type: 'text', helpText: 'Audio bitrate (e.g. 192k)' },
  { key: 'AUDIO_CHANNELS', label: 'Channels', type: 'number', helpText: 'Number of output channels (e.g. 2 for stereo)' },
];

function normalizeSequenceValue(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((item) => String(item)).join('\n');
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function filterTranscoderValues(values) {
  return Object.fromEntries(
    Object.entries(values || {}).filter(([key]) => TRANSCODER_KEY_SET.has(key)),
  );
}

export function normalizeTranscoderRecord(values) {
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
  const booleanDefaults = {
    TRANSCODER_AUTO_KEYFRAMING: true,
    TRANSCODER_COPY_TIMESTAMPS: true,
    TRANSCODER_START_AT_ZERO: true,
    TRANSCODER_DEBUG_ENDPOINT_ENABLED: true,
    SHAKA_GENERATE_HLS: false,
    SHAKA_ALLOW_APPROXIMATE_SEGMENT_TIMELINE: true,
  };
  Object.entries(booleanDefaults).forEach(([key, defaultValue]) => {
    const value = record[key];
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      record[key] = ['true', '1', 'yes', 'on'].includes(lowered);
    } else if (typeof value === 'number') {
      record[key] = Boolean(value);
    } else if (typeof value === 'boolean') {
      record[key] = value;
    } else {
      record[key] = defaultValue;
    }
  });

  ['SHAKA_PACKAGER_BINARY', 'SHAKA_HLS_MASTER_PLAYLIST', 'SHAKA_OUTPUT_SUBDIR', 'SHAKA_DEFAULT_AUDIO_LANGUAGE'].forEach((key) => {
    const value = record[key];
    record[key] = value !== undefined && value !== null ? String(value).trim() : '';
  });
  ['SHAKA_EXTRA_FLAGS', 'SHAKA_ADDITIONAL_ARGS'].forEach((key) => {
    const value = record[key];
    record[key] = value !== undefined && value !== null ? String(value) : '';
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
    if (minimum !== undefined && parsed < minimum) {
      return minimum;
    }
    return parsed;
  };

  [
    'SHAKA_SEGMENT_DURATION',
    'SHAKA_TIME_SHIFT_BUFFER_DEPTH',
    'SHAKA_MINIMUM_UPDATE_PERIOD',
    'SHAKA_MIN_BUFFER_TIME',
    'SHAKA_PRESERVED_SEGMENTS_OUTSIDE_LIVE_WINDOW',
    'DASH_WINDOW_SIZE',
    'DASH_EXTRA_WINDOW_SIZE',
    'DASH_MUX_PRELOAD',
    'DASH_MUX_DELAY',
    'DASH_RETENTION_SEGMENTS',
    'DASH_MIN_SEGMENT_DURATION',
    'DASH_FRAGMENT_DURATION',
    'DASH_SEGMENT_DURATION',
  ].forEach((key) => {
    record[key] = normalizeIntField(record[key], 0);
  });

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

  const rawScale = record.VIDEO_SCALE;
  if (rawScale === undefined || rawScale === null || rawScale === '') {
    record.VIDEO_SCALE = 'source';
  } else if (VIDEO_SCALE_OPTIONS.some((option) => option.value === rawScale)) {
    record.VIDEO_SCALE = rawScale;
  } else {
    record.VIDEO_SCALE = 'custom';
  }
  if (record.VIDEO_SCALE !== 'custom' && SCALE_PRESET_FILTERS[record.VIDEO_SCALE] !== undefined) {
    record.VIDEO_FILTERS = SCALE_PRESET_FILTERS[record.VIDEO_SCALE];
  }

  const rawVsync = record.VIDEO_VSYNC;
  if (rawVsync === null || rawVsync === undefined || String(rawVsync).trim() === '') {
    record.VIDEO_VSYNC = '';
  } else {
    record.VIDEO_VSYNC = String(rawVsync).trim();
  }

  return record;
}

export function normalizeTranscoderForm(values) {
  const record = normalizeTranscoderRecord(values);
  const scale = record.VIDEO_SCALE || 'source';
  if (scale !== 'custom' && SCALE_PRESET_FILTERS[scale] !== undefined) {
    record.VIDEO_FILTERS = SCALE_PRESET_FILTERS[scale];
  }
  return record;
}

export default function TranscoderSection({ transcoder, setTranscoder }) {
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
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <SelectWithCustomField
              label="Codec"
              rawValue={form.AUDIO_CODEC ?? ''}
              options={AUDIO_CODEC_OPTIONS}
              onSelect={(choice) => handleSelectWithCustom('AUDIO_CODEC', choice)}
              onCustomChange={(next) => handleFieldChange('AUDIO_CODEC', next)}
              helpText="Choose a codec or leave blank to use FFmpeg default"
            />
            <SelectWithCustomField
              label="Profile"
              rawValue={form.AUDIO_PROFILE ?? ''}
              options={AUDIO_PROFILE_OPTIONS}
              onSelect={(choice) => handleSelectWithCustom('AUDIO_PROFILE', choice)}
              onCustomChange={(next) => handleFieldChange('AUDIO_PROFILE', next)}
              helpText="Select an encoder profile if supported"
            />
            <SelectWithCustomField
              label="Sample rate"
              rawValue={form.AUDIO_SAMPLE_RATE ?? ''}
              options={AUDIO_SAMPLE_RATE_OPTIONS}
              onSelect={(choice) => handleSelectWithCustom('AUDIO_SAMPLE_RATE', choice, 'number')}
              onCustomChange={(next) => handleFieldChange('AUDIO_SAMPLE_RATE', next, 'number')}
              helpText="Force a specific sample rate or use the source value"
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
          <h3 className="text-sm font-semibold text-foreground">Subtitles</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <SelectField
              label="Preferred language"
              value={form.SUBTITLE_PREFERRED_LANGUAGE ?? 'en'}
              onChange={(next) => handleFieldChange('SUBTITLE_PREFERRED_LANGUAGE', next)}
              options={SUBTITLE_LANGUAGE_OPTIONS}
              helpText="Choose the default language to convert when subtitles are extracted"
            />
            <TextField
              label="Subtitle filters"
              value={form.SUBTITLE_FILTERS ?? ''}
              onChange={(next) => handleFieldChange('SUBTITLE_FILTERS', next)}
              helpText="Optional filters applied to subtitle processing"
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
          <h3 className="text-sm font-semibold text-foreground">Packager</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2 lg:grid-cols-4">
            <TextField
              label="Packager Binary"
              value={form.SHAKA_PACKAGER_BINARY ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_PACKAGER_BINARY', next)}
              helpText="Path to the shaka-packager executable. Leave blank to use the binary on $PATH."
            />
            <TextField
              label="Segment duration (seconds)"
              type="number"
              value={form.SHAKA_SEGMENT_DURATION === '' ? '' : form.SHAKA_SEGMENT_DURATION ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_SEGMENT_DURATION', next, 'number')}
              helpText="Override the segment duration if you need wider or shorter GOP windows."
            />
            <TextField
              label="Time-shift buffer depth (seconds)"
              type="number"
              value={form.SHAKA_TIME_SHIFT_BUFFER_DEPTH === '' ? '' : form.SHAKA_TIME_SHIFT_BUFFER_DEPTH ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_TIME_SHIFT_BUFFER_DEPTH', next, 'number')}
              helpText="Total DVR depth shaka-packager keeps in the manifest."
            />
            <TextField
              label="Preserved segments outside live window"
              type="number"
              value={
                form.SHAKA_PRESERVED_SEGMENTS_OUTSIDE_LIVE_WINDOW === ''
                  ? ''
                  : form.SHAKA_PRESERVED_SEGMENTS_OUTSIDE_LIVE_WINDOW ?? ''
              }
              onChange={(next) => handleFieldChange('SHAKA_PRESERVED_SEGMENTS_OUTSIDE_LIVE_WINDOW', next, 'number')}
              helpText="Keep this many segments beyond the main live window before trimming."
            />
            <TextField
              label="Minimum update period (seconds)"
              type="number"
              value={form.SHAKA_MINIMUM_UPDATE_PERIOD === '' ? '' : form.SHAKA_MINIMUM_UPDATE_PERIOD ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_MINIMUM_UPDATE_PERIOD', next, 'number')}
              helpText="Broadcast minimumUpdatePeriod in the MPD. Leave blank to let packager choose automatically."
            />
            <TextField
              label="Minimum buffer time (seconds)"
              type="number"
              value={form.SHAKA_MIN_BUFFER_TIME === '' ? '' : form.SHAKA_MIN_BUFFER_TIME ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_MIN_BUFFER_TIME', next, 'number')}
              helpText="Advertise the player buffer recommendation in the MPD."
            />
            <TextField
              label="Default audio language"
              value={form.SHAKA_DEFAULT_AUDIO_LANGUAGE ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_DEFAULT_AUDIO_LANGUAGE', next)}
              helpText="Two-letter language packager should prefer when tagging default audio renditions."
            />
            <TextField
              label="Output subdirectory"
              value={form.SHAKA_OUTPUT_SUBDIR ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_OUTPUT_SUBDIR', next)}
              helpText="Optional subdirectory under the transcoder output root for packaged segments."
            />
            <BooleanField
              label="Generate HLS playlists"
              value={Boolean(form.SHAKA_GENERATE_HLS ?? false)}
              onChange={(next) => handleFieldChange('SHAKA_GENERATE_HLS', next)}
              helpText="In addition to the MPD, emit HLS playlists for compatible clients."
            />
            <TextField
              label="HLS master playlist output"
              value={form.SHAKA_HLS_MASTER_PLAYLIST ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_HLS_MASTER_PLAYLIST', next)}
              helpText="Optional absolute or relative path for the generated HLS master playlist."
            />
            <BooleanField
              label="Allow approximate segment timeline"
              value={form.SHAKA_ALLOW_APPROXIMATE_SEGMENT_TIMELINE ?? true}
              onChange={(next) => handleFieldChange('SHAKA_ALLOW_APPROXIMATE_SEGMENT_TIMELINE', next)}
              helpText="Disable to force packager to keep exact timeline alignment (useful for strict clients)."
            />
            <TextField
              label="Additional packager args"
              value={form.SHAKA_ADDITIONAL_ARGS ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_ADDITIONAL_ARGS', next)}
              helpText="Space-separated extra arguments appended to the packager command."
            />
            <TextField
              label="Extra flags"
              value={form.SHAKA_EXTRA_FLAGS ?? ''}
              onChange={(next) => handleFieldChange('SHAKA_EXTRA_FLAGS', next)}
              helpText="Comma or space separated packager stream flags applied to every rendition."
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
              helpText="Optional adaptation set definitions passed to the dash muxer."
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
      <div className="mt-6 flex items-center justify-end gap-3">
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
              const updatedEffective = normalizeTranscoderRecord(
                filterTranscoderValues(updated?.effective || transcoder.effective || {}),
              );
              const hydratedSettings = normalizeTranscoderRecord({
                ...updatedEffective,
                ...updatedSettings,
              });
              const updatedForm = normalizeTranscoderForm(
                prepareForm(updatedDefaults, hydratedSettings),
              );
              setTranscoder({
                loading: false,
                data: updatedSettings,
                defaults: updatedDefaults,
                form: updatedForm,
                effective: updatedEffective,
                derived: updated?.derived || transcoder.derived || {},
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
}
