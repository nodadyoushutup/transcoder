import { useCallback, useEffect, useMemo, useState } from 'react';

const REFRESH_INTERVAL_MS = 5000;

export default function ViewerPanel({ backendBase, viewer, viewerReady, loadingViewer }) {
  const [activeUsers, setActiveUsers] = useState([]);
  const [guestCount, setGuestCount] = useState(0);
  const [signedInCount, setSignedInCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const baseUrl = useMemo(() => backendBase.replace(/\/$/, ''), [backendBase]);

  const loadViewers = useCallback(async () => {
    try {
      const response = await fetch(`${baseUrl}/viewers/list`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Viewer list failed (${response.status})`);
      }
      const users = Array.isArray(payload?.users)
        ? payload.users
            .map((userItem) => ({
              userId: userItem?.user_id ?? null,
              username: userItem?.username ?? 'Unknown',
              isAdmin: Boolean(userItem?.is_admin),
            }))
        : [];
      setActiveUsers(users);
      const guestTotal = Number.isFinite(payload?.guest_count) ? Number(payload.guest_count) : 0;
      const signedTotal = Number.isFinite(payload?.signed_in_count)
        ? Number(payload.signed_in_count)
        : users.length;
      const aggregate = Number.isFinite(payload?.total_count)
        ? Number(payload.total_count)
        : signedTotal + guestTotal;
      setGuestCount(guestTotal);
      setSignedInCount(signedTotal);
      setTotalCount(aggregate);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load viewers');
    } finally {
      setPending(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (!viewerReady) {
      return undefined;
    }
    setPending(true);
    let cancelled = false;
    const tick = async () => {
      if (!cancelled) {
        await loadViewers();
      }
    };
    void tick();
    const interval = window.setInterval(tick, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadViewers, viewerReady]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center justify-between border-b border-zinc-900/80 px-6 py-4">
        <h2 className="text-lg font-semibold text-zinc-100">Viewers</h2>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
        <section className="grid gap-4 sm:grid-cols-3">
          <ViewerStat label="Total" value={totalCount} subtle={pending} />
          <ViewerStat label="Signed in" value={signedInCount} subtle={pending} />
          <ViewerStat label="Guests" value={guestCount} subtle={pending} />
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Signed-in Viewers</h3>
          {error ? (
            <p className="mt-3 text-xs text-rose-300">{error}</p>
          ) : null}
          {!error && !pending && activeUsers.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-400">No authenticated viewers right now.</p>
          ) : null}
          <ul className="mt-3 space-y-2 text-sm">
            {activeUsers.map((userItem) => {
              const isSelf = viewer?.kind === 'user' && viewer?.senderKey === `user:${userItem.userId}`;
              return (
                <li
                  key={`${userItem.userId}-${userItem.username}`}
                  className="flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-950/60 px-3 py-2"
                >
                  <span className="font-medium text-zinc-200">
                    {userItem.username}
                    {userItem.isAdmin ? <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Admin</span> : null}
                  </span>
                  {isSelf ? <span className="text-[10px] uppercase tracking-wide text-emerald-300">You</span> : null}
                </li>
              );
            })}
          </ul>
        </section>

      </div>
    </div>
  );
}

function ViewerStat({ label, value, subtle }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold text-zinc-100 ${subtle ? 'opacity-70' : ''}`}>{value}</p>
    </div>
  );
}
