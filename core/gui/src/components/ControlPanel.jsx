import { useMemo } from 'react';

const TONE_CLASSES = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  err: 'text-rose-300',
  info: 'text-zinc-300',
  idle: 'text-zinc-400',
};

function getToneClass(tone = 'info') {
  return TONE_CLASSES[tone] ?? TONE_CLASSES.info;
}

export default function ControlPanel({
  backendBase,
  manifestUrl,
  statusInfo,
  statusFetchError,
  status,
  statsText,
  user,
  pending,
  onStart,
  onStop,
}) {
  const serviceCards = useMemo(() => {
    const playerMetrics = statsText || 'Awaiting playback…';

    const backendState = statusFetchError
      ? { label: 'API State', value: statusFetchError, tone: 'err' }
      : { label: 'API State', value: 'Operational', tone: 'ok' };

    const transcoderRunning = status?.running === true;
    const transcoderTone = statusFetchError ? 'err' : transcoderRunning ? 'ok' : 'warn';
    const transcoderStateLabel = statusFetchError
      ? 'Unavailable'
      : transcoderRunning
        ? 'Running'
        : 'Stopped';

    const transcoderItems = [
      { label: 'Process', value: transcoderStateLabel, tone: transcoderTone },
      { label: 'Manifest', value: manifestUrl ?? 'Pending…', tone: manifestUrl ? 'info' : 'idle' },
    ];
    if (status?.last_error) {
      transcoderItems.push({ label: 'Last Error', value: status.last_error, tone: 'warn' });
    }

    return [
      {
        title: 'Player Status',
        items: [
          { label: 'State', value: statusInfo.message, tone: statusInfo.type ?? 'info', isRich: true },
          { label: 'Metrics', value: playerMetrics, tone: playerMetrics ? 'info' : 'idle' },
        ],
      },
      {
        title: 'Backend Status',
        items: [
          backendState,
          { label: 'Endpoint', value: backendBase, tone: 'idle' },
          { label: 'Account', value: `${user.username} · ${user.email}`, tone: 'idle' },
        ],
      },
      {
        title: 'Transcoder Status',
        items: transcoderItems,
      },
    ];
  }, [backendBase, manifestUrl, statsText, status, statusFetchError, statusInfo.message, statusInfo.type, user.email, user.username]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center justify-between border-b border-zinc-900/80 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Control Panel</h2>
          <p className="text-xs text-zinc-400">Monitor and control transcoder services from here.</p>
        </div>
        <div className="text-right text-xs text-zinc-400">
          <span className="block text-zinc-200">
            Signed in as <span className="font-semibold text-zinc-100">{user.username}</span>
          </span>
          <span className="block text-zinc-500">{user.email}</span>
        </div>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <div className="grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <button
            type="button"
            onClick={onStart}
            disabled={pending || status?.running}
            className="inline-flex items-center justify-center rounded-full bg-zinc-200 px-6 py-2.5 text-base font-semibold text-zinc-900 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            Play / Start Transcoder
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={pending || !status?.running}
            className="inline-flex items-center justify-center rounded-full bg-zinc-800 px-6 py-2.5 text-base font-semibold text-zinc-100 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            Stop Transcoder
          </button>
        </div>

        <div className="grid gap-4">
          {serviceCards.map((card) => (
            <section key={card.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{card.title}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {card.items.map((item) => (
                  <div key={`${card.title}-${item.label}`} className="flex flex-col gap-1 border-b border-zinc-800/60 pb-3 last:border-none last:pb-0">
                    <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{item.label}</dt>
                    <dd className={`text-sm ${getToneClass(item.tone)}`}>
                      {item.isRich ? item.value : <span className="break-words">{item.value}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Raw Backend Status</h3>
            <span className="text-xs text-zinc-500">Endpoint: {backendBase}</span>
          </div>
          <pre className="max-h-[40vh] overflow-auto rounded-2xl bg-zinc-950/80 p-4 text-xs text-zinc-300">
            {status ? JSON.stringify(status, null, 2) : statusFetchError ?? 'No status data available.'}
          </pre>
        </section>
      </div>
    </div>
  );
}
