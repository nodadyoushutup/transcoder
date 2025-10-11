import { updateSystemSettings, stopTask } from '../../../lib/api.js';
import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  TextField,
  summarizeArgs,
  summarizeKwargs,
} from '../shared.jsx';

export const TASK_SCHEDULE_MIN_SECONDS = 1;
export const TASK_SCHEDULE_MAX_SECONDS = 86400 * 30;
export const TASK_DEFAULT_REFRESH_INTERVAL = 15;

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

export function sanitizeTasksRecord(record = {}, defaults = {}) {
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

export function cloneTasksForm(record) {
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

export function hasTaskChanges(original, current) {
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
  if (value >= 1) {
    return `${value.toFixed(1)}s`;
  }
  return `${(value * 1000).toFixed(0)}ms`;
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

export default function TasksSection({ tasksState, setTasksState, loadTasksSettings, isMountedRef }) {
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
                      onChange={(value) => updateJob(
                        job.id,
                        { schedule_seconds: clampTaskSchedule(value, job.schedule_seconds) },
                      )}
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
}
