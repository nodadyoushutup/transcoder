import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import { SectionContainer } from '../shared.jsx';

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

export default function SystemSection({ systemState, onRestartService }) {
  return (
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
                  onClick={() => onRestartService?.(service.id)}
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
}
