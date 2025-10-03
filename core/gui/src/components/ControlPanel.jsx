export default function ControlPanel({
  status,
  user,
  pending,
  onStop,
  onRequestAuth,
}) {
  const isSignedIn = Boolean(user);
  const canControl = Boolean(
    user?.is_admin
    || user?.groups?.some((group) => (group?.slug === 'moderator' || group?.slug === 'admin')),
  );
  const handleStopClick = () => {
    if (!isSignedIn) {
      onRequestAuth?.('login');
      return;
    }
    if (!canControl) {
      return;
    }
    onStop?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center justify-between border-b border-border/80 px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">Control Panel</h2>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {canControl ? (
          <div className="panel-section grid gap-3">
            <button
              type="button"
              onClick={handleStopClick}
              disabled={pending || !status?.running}
              className="inline-flex items-center justify-center rounded-full bg-surface-muted px-6 py-2.5 text-base font-semibold text-foreground transition hover:bg-surface-muted/80 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-subtle"
            >
              Stop Transcoder
            </button>
          </div>
        ) : (
          <div className="panel-section text-sm text-muted">
            You do not have permission to control the transcoder.
          </div>
        )}
      </div>
    </div>
  );
}
