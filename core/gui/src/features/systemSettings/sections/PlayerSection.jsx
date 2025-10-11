import { updateSystemSettings } from '../../../lib/api.js';
import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  SelectField,
  TextAreaField,
  TextField,
} from '../shared.jsx';

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

export const PLAYER_DEFAULT_SETTINGS = Object.freeze(clonePlayerTemplate());

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

export function sanitizePlayerRecord(record = {}) {
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
  base.streaming.text.defaultLanguage = typeof textInput.defaultLanguage === 'string'
    ? textInput.defaultLanguage.trim()
    : base.streaming.text.defaultLanguage;

  const attachRaw = record.attachMinimumSegments;
  const fallbackAttach = base.attachMinimumSegments;
  base.attachMinimumSegments = clampInt(attachRaw, fallbackAttach, 0, 240);

  return base;
}

export function clonePlayerSettings(settings = {}) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(settings);
    } catch {
      // fall through
    }
  }
  const template = clonePlayerTemplate();
  const normalized = sanitizePlayerRecord({ ...template, ...(settings || {}) });
  const placeholder = '__NaN_PLACEHOLDER__';
  const replacer = (_, value) => {
    if (Number.isNaN(value)) {
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
    return JSON.parse(JSON.stringify(normalized, replacer), reviver);
  } catch {
    return clonePlayerTemplate();
  }
}

export default function PlayerSection({ playerSettings, setPlayerSettings }) {
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
      const message = error instanceof Error ? error.message : 'Unable to save player settings.';
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
        <div>
          <h3 className="text-sm font-semibold text-foreground">Live delay</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2 lg:grid-cols-3">
            <TextField
              label="Suggested presentation delay (seconds)"
              value={displayNumeric(delay.liveDelay)}
              onChange={(value) => mutateDelay((delayDraft) => {
                const numeric = value === '' ? Number.NaN : Number.parseFloat(value);
                delayDraft.liveDelay = Number.isFinite(numeric) && numeric >= 0 ? numeric : Number.NaN;
              })}
              helpText="Preferred buffer depth for live playback. Leave blank to let DASH choose automatically."
            />
            <TextField
              label="Fragment count"
              type="number"
              value={delay.liveDelayFragmentCount ?? ''}
              onChange={(value) => mutateDelay((delayDraft) => {
                delayDraft.liveDelayFragmentCount = clampInt(value, 10, 0, 240);
              })}
              helpText="Override the DASH live delay as a number of segments."
            />
            <BooleanField
              label="Use suggested presentation delay"
              value={coerceBoolean(delay.useSuggestedPresentationDelay, true)}
              onChange={(checked) => mutateDelay((delayDraft) => {
                delayDraft.useSuggestedPresentationDelay = Boolean(checked);
              })}
              helpText="Toggle applying suggestedPresentationDelay from the MPD."
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">Live catch-up</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <BooleanField
              label="Enable catch-up"
              value={coerceBoolean(catchup.enabled, true)}
              onChange={(checked) => mutateCatchup((catchupDraft) => {
                catchupDraft.enabled = Boolean(checked);
              })}
              helpText="Allow the player to subtly adjust playback speed to stay near the live edge."
            />
            <TextField
              label="Min drift (seconds)"
              value={displayNumeric(catchup.minDrift)}
              onChange={(value) => mutateCatchup((catchupDraft) => {
                catchupDraft.minDrift = clampFloat(value, 6, 0, 120);
              })}
            />
            <TextField
              label="Max drift (seconds)"
              value={displayNumeric(catchup.maxDrift)}
              onChange={(value) => mutateCatchup((catchupDraft) => {
                catchupDraft.maxDrift = clampFloat(value, 10, 0, 120);
              })}
            />
          </div>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <TextField
              label="Playback rate min"
              value={displayNumeric(playback.min)}
              onChange={(value) => mutatePlayback((playbackDraft) => {
                playbackDraft.min = clampFloat(value, -0.04, -1, 1);
              })}
            />
            <TextField
              label="Playback rate max"
              value={displayNumeric(playback.max)}
              onChange={(value) => mutatePlayback((playbackDraft) => {
                playbackDraft.max = clampFloat(value, 0.04, -1, 1);
              })}
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">Buffering</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2 lg:grid-cols-3">
            <BooleanField
              label="Fast switch"
              value={coerceBoolean(buffer.fastSwitchEnabled, false)}
              onChange={(checked) => mutateBuffer((bufferDraft) => {
                bufferDraft.fastSwitchEnabled = Boolean(checked);
              })}
              helpText="Allow the player to jump to higher quality segments immediately."
            />
            <TextField
              label="Pruning interval (seconds)"
              value={buffer.bufferPruningInterval ?? ''}
              onChange={(value) => mutateBuffer((bufferDraft) => {
                bufferDraft.bufferPruningInterval = clampInt(value, 10, 0, 86400);
              })}
            />
            <TextField
              label="Buffer to keep (seconds)"
              value={buffer.bufferToKeep ?? ''}
              onChange={(value) => mutateBuffer((bufferDraft) => {
                bufferDraft.bufferToKeep = clampInt(value, 10, 0, 86400);
              })}
            />
            <TextField
              label="Top quality buffer (seconds)"
              value={buffer.bufferTimeAtTopQuality ?? ''}
              onChange={(value) => mutateBuffer((bufferDraft) => {
                bufferDraft.bufferTimeAtTopQuality = clampInt(value, 14, 0, 86400);
              })}
            />
            <TextField
              label="Top quality buffer (long form)"
              value={buffer.bufferTimeAtTopQualityLongForm ?? ''}
              onChange={(value) => mutateBuffer((bufferDraft) => {
                bufferDraft.bufferTimeAtTopQualityLongForm = clampInt(value, 18, 0, 86400);
              })}
            />
            <TextField
              label="Stable buffer time (seconds)"
              value={buffer.stableBufferTime ?? ''}
              onChange={(value) => mutateBuffer((bufferDraft) => {
                bufferDraft.stableBufferTime = clampInt(value, 10, 0, 86400);
              })}
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">Subtitle defaults</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <BooleanField
              label="Enable by default"
              value={coerceBoolean(textPrefs.defaultEnabled, false)}
              onChange={(checked) => mutateText((textDraft) => {
                textDraft.defaultEnabled = Boolean(checked);
              })}
            />
            <TextField
              label="Default language"
              value={textPrefs.defaultLanguage ?? ''}
              onChange={(value) => mutateText((textDraft) => {
                textDraft.defaultLanguage = value;
              })}
              helpText="ISO language code to auto-enable (e.g. en, es)."
            />
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-foreground">Segment attachment</h3>
          <div className="mt-3 grid gap-4 items-start md:grid-cols-2">
            <TextField
              label="Attach minimum segments"
              type="number"
              value={displayNumeric(form.attachMinimumSegments)}
              onChange={(value) => {
                const nextValue = clampInt(value, 3, 0, 240);
                setPlayerSettings((state) => ({
                  ...state,
                  form: {
                    ...state.form,
                    attachMinimumSegments: nextValue,
                  },
                  feedback: null,
                }));
              }}
              helpText="Segments to append before advertising playback readiness."
            />
          </div>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Feedback message={playerSettings.feedback?.message} tone={playerSettings.feedback?.tone} />
        <DiffButton onClick={handleSave} disabled={playerSettings.saving}>
          {playerSettings.saving ? 'Saving…' : 'Save changes'}
        </DiffButton>
      </div>
    </SectionContainer>
  );
}
