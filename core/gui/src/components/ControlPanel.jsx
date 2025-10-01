export default function ControlPanel({
  backendBase,
  manifestUrl,
  badgeClassName,
  statusInfo,
  status,
  user,
  pending,
  onStart,
  onStop,
  statsText,
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-10 lg:px-8">
      <header className="space-y-4">
        <div>
          <h1 className="text-3xl font-semibold text-amber-500">Transcoder Control Panel</h1>
          <p className="mt-2 text-sm text-zinc-300">
            Backend:&nbsp;
            <code className="rounded bg-zinc-900 px-2 py-1 text-xs text-amber-400">{backendBase}</code>
          </p>
          <p className="text-sm text-zinc-300">
            Manifest:&nbsp;
            <code className="rounded bg-zinc-900 px-2 py-1 text-xs text-amber-400">{manifestUrl ?? 'pending…'}</code>
          </p>
        </div>
        <span className={badgeClassName}>{statusInfo.message}</span>
      </header>

      <div className="grid gap-3 rounded-2xl border border-amber-500/30 bg-zinc-900/80 p-5">
        <button
          type="button"
          onClick={onStart}
          disabled={pending || status?.running}
          className="inline-flex items-center justify-center rounded-full bg-amber-500 px-6 py-2.5 text-base font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          Play / Start Transcoder
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={pending || !status?.running}
          className="inline-flex items-center justify-center rounded-full bg-rose-500 px-6 py-2.5 text-base font-semibold text-zinc-50 transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          Stop Transcoder
        </button>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-200">Player Metrics</h2>
          <span className="text-xs text-zinc-400">
            Signed in as <span className="font-medium text-amber-400">{user.username}</span>
          </span>
        </div>
        <p className="text-sm text-zinc-300">{statsText || 'Awaiting playback…'}</p>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-200">Backend Status</h2>
          <span className="text-xs text-zinc-500">User: {user.email}</span>
        </div>
        <pre className="max-h-[50vh] overflow-auto break-words rounded-2xl bg-zinc-950/90 p-5 text-xs text-zinc-200">
          {status ? JSON.stringify(status, null, 2) : 'Fetching backend status…'}
        </pre>
      </div>
    </div>
  );
}

