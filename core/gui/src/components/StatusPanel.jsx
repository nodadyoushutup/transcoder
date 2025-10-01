import { useMemo } from 'react';

const TONE_CLASSES = {
  ok: 'text-success',
  warn: 'text-warning',
  err: 'text-danger',
  info: 'text-muted',
  idle: 'text-subtle',
};

function getToneClass(tone = 'info') {
  return TONE_CLASSES[tone] ?? TONE_CLASSES.info;
}

export default function StatusPanel({
  backendBase,
  manifestUrl,
  statusInfo,
  statusFetchError,
  status,
  statsText,
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
        title: 'API Status',
        items: [
          backendState,
          { label: 'Endpoint', value: backendBase, tone: 'idle' },
        ],
      },
      {
        title: 'Transcoder Status',
        items: transcoderItems,
      },
    ];
  }, [
    backendBase,
    manifestUrl,
    statsText,
    status,
    statusFetchError,
    statusInfo.message,
    statusInfo.type,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center justify-between border-b border-border/80 px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">Status</h2>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <div className="grid gap-4">
          {serviceCards.map((card) => (
            <section key={card.title} className="panel-section">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{card.title}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {card.items.map((item) => (
                  <div
                    key={`${card.title}-${item.label}`}
                    className="flex flex-col gap-1 border-b border-border/60 pb-3 last:border-none last:pb-0"
                  >
                    <dt className="text-xs font-medium uppercase tracking-wide text-subtle">{item.label}</dt>
                    <dd className={`text-sm ${getToneClass(item.tone)}`}>
                      {item.isRich ? item.value : <span className="break-words">{item.value}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
