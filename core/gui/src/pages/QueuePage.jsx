import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDown,
  faArrowUp,
  faArrowUpRightFromSquare,
  faCircleNotch,
  faForward,
  faPlay,
  faRotateRight,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import {
  deleteQueueItem,
  fetchQueue,
  moveQueueItem,
  playQueue,
  skipQueue,
  plexImageUrl,
} from '../lib/api.js';

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function formatTime(value) {
  const date = parseDate(value);
  if (!date) {
    return '—';
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatRelative(value) {
  const date = parseDate(value);
  if (!date) {
    return null;
  }
  const now = Date.now();
  const diff = date.getTime() - now;
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) {
    return 'now';
  }
  if (minutes > 0) {
    return `in ${minutes} min`;
  }
  return `${Math.abs(minutes)} min ago`;
}

function describeItem(item) {
  if (!item) {
    return '';
  }
  const { title, grandparent_title: grandparent } = item;
  if (grandparent) {
    return `${grandparent} — ${title}`;
  }
  return title || item.rating_key;
}

function resolvePosterPath(item) {
  if (!item) {
    return null;
  }
  return item.thumb || item.art || null;
}

function buildPosterUrl(item, dimensions = { width: 260, height: 390 }) {
  const path = resolvePosterPath(item);
  if (!path) {
    return null;
  }
  return plexImageUrl(path, { ...dimensions, min: 1, upscale: 1 });
}

function buildQueuePoster(item) {
  if (!item) {
    return null;
  }
  const directPath = resolvePosterPath(item);
  if (directPath) {
    return buildPosterUrl(item, { width: 200, height: 300 });
  }
  const embeddedDetails = item.details?.item;
  if (embeddedDetails) {
    return buildPosterUrl(embeddedDetails, { width: 200, height: 300 });
  }
  return null;
}

function buildCurrentPoster(current) {
  if (!current) {
    return null;
  }
  const pseudoItem = {
    thumb: current.thumb,
    art: current.art,
  };
  if (!pseudoItem.thumb && !pseudoItem.art) {
    const detailsItem = current.details?.item;
    if (detailsItem) {
      pseudoItem.thumb = detailsItem.thumb;
      pseudoItem.art = detailsItem.art;
    }
  }
  return buildPosterUrl(pseudoItem, { width: 320, height: 480 });
}

function coalesce(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    return value;
  }
  return null;
}

function resolveLibraryTarget(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const ratingKey = coalesce(
    payload.ratingKey,
    payload.rating_key,
    payload.item?.ratingKey,
    payload.item?.rating_key,
    payload.details?.item?.ratingKey,
    payload.details?.item?.rating_key,
    payload.details?.ratingKey,
    payload.details?.rating_key,
    payload.source?.item?.ratingKey,
    payload.source?.item?.rating_key,
  );
  if (!ratingKey) {
    return null;
  }
  const librarySectionId = coalesce(
    payload.librarySectionId,
    payload.library_section_id,
    payload.item?.library_section_id,
    payload.details?.item?.library_section_id,
    payload.details?.library_section_id,
    payload.source?.item?.library_section_id,
  );
  return {
    ratingKey: String(ratingKey),
    librarySectionId: librarySectionId ?? null,
  };
}

function formatMetadataLine({ startLabel, endLabel, durationLabel }) {
  const parts = [];
  if (startLabel && startLabel !== '—') {
    parts.push(`Starts ${startLabel}`);
  }
  if (endLabel && endLabel !== '—') {
    parts.push(`Ends ${endLabel}`);
  }
  if (durationLabel) {
    parts.push(durationLabel);
  }
  if (!parts.length) {
    return null;
  }
  return parts.join(' • ');
}

function formatTitleWithYear(item) {
  const base = describeItem(item);
  if (!item?.year) {
    return base;
  }
  return `${base} (${item.year})`;
}

export default function QueuePage({ onNavigateToStream, onViewLibraryItem }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingAction, setPendingAction] = useState(false);
  const pollTimerRef = useRef(null);

  const refreshQueue = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchQueue();
      setSnapshot(data);
      setError(null);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshQueue();
    pollTimerRef.current = window.setInterval(() => {
      void refreshQueue();
    }, 8000);
    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [refreshQueue]);

  const handleMove = useCallback(async (itemId, direction) => {
    setPendingAction(true);
    try {
      const data = await moveQueueItem(itemId, direction);
      setSnapshot(data);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setPendingAction(false);
    }
  }, []);

  const handleRemove = useCallback(async (itemId) => {
    setPendingAction(true);
    try {
      const data = await deleteQueueItem(itemId);
      setSnapshot(data);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setPendingAction(false);
    }
  }, []);

  const handlePlayQueue = useCallback(async () => {
    setPendingAction(true);
    try {
      const data = await playQueue();
      setSnapshot(data);
      onNavigateToStream?.();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setPendingAction(false);
    }
  }, [onNavigateToStream]);

  const handleSkip = useCallback(async () => {
    setPendingAction(true);
    try {
      const data = await skipQueue();
      setSnapshot(data);
      onNavigateToStream?.();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
    } finally {
      setPendingAction(false);
    }
  }, [onNavigateToStream]);

  const handleViewLibrary = useCallback(
    (payload) => {
      if (!payload) {
        return;
      }
      const target = resolveLibraryTarget(payload);
      if (!target) {
        return;
      }
      onViewLibraryItem?.(target);
    },
    [onViewLibraryItem],
  );

  const current = snapshot?.current ?? null;
  const currentStart = useMemo(() => parseDate(current?.started_at), [current?.started_at]);
  const currentEnd = useMemo(() => {
    if (!currentStart || !Number.isFinite(current?.duration_ms)) {
      return null;
    }
    return new Date(currentStart.getTime() + current.duration_ms);
  }, [currentStart, current?.duration_ms]);

  const queueItems = snapshot?.items ?? [];
  const generatedAt = snapshot?.generated_at ? formatRelative(snapshot.generated_at) : null;
  const autoAdvanceEnabled = snapshot?.auto_advance === true;
  const headerSubtitle = snapshot
    ? `Manage the upcoming playback order • ${autoAdvanceEnabled ? 'Auto-advance enabled' : 'Auto-advance paused'}`
    : 'Manage the upcoming playback order';
  const currentItem = useMemo(() => {
    if (!current) {
      return null;
    }
    if (current.item && Object.keys(current.item).length) {
      return current.item;
    }
    if (current.details?.item && Object.keys(current.details.item).length) {
      return current.details.item;
    }
    return null;
  }, [current]);
  const currentPosterUrl = useMemo(() => buildCurrentPoster(current), [current]);
  const currentSummary = current?.summary
    || currentItem?.summary
    || current?.details?.item?.summary
    || current?.source?.item?.summary
    || null;
  const currentYear = current?.year || currentItem?.year || null;
  const currentLibraryTarget = useMemo(
    () => resolveLibraryTarget(current) || resolveLibraryTarget(currentItem),
    [current, currentItem],
  );

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/60 bg-surface/60 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Queue</h1>
          <p className="text-xs text-muted">{headerSubtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshQueue()}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 px-4 py-1.5 text-sm text-foreground transition hover:border-accent hover:text-accent"
            disabled={pendingAction}
          >
            <FontAwesomeIcon icon={faRotateRight} spin={loading} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handlePlayQueue}
            disabled={pendingAction}
            className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90 disabled:opacity-60"
          >
            <FontAwesomeIcon icon={faPlay} />
            Play Queue
          </button>
          <button
            type="button"
            onClick={handleSkip}
            disabled={pendingAction}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 px-5 py-2 text-sm font-semibold text-foreground transition hover:border-accent hover:text-accent disabled:opacity-60"
          >
            <FontAwesomeIcon icon={faForward} />
            Skip
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {error ? (
          <div className="m-6 rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : null}

        <section className="m-6 rounded-xl border border-border/60 bg-surface/50 px-6 py-5 shadow-sm">
          <header className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-foreground">Now Playing</h2>
            {generatedAt ? (
              <span className="text-xs text-muted">Updated {generatedAt}</span>
            ) : null}
          </header>
          {current ? (
            <div className="flex items-start gap-4">
              {currentPosterUrl ? (
                <img
                  src={currentPosterUrl}
                  alt={describeItem(currentItem)}
                  className="h-60 w-40 flex-shrink-0 rounded-lg object-cover shadow-md"
                />
              ) : null}
              <div className="flex flex-col gap-2 text-sm">
                <div className="font-semibold text-foreground text-base">
                  {formatTitleWithYear({ ...currentItem, year: currentYear })}
                </div>
                <div className="text-xs text-muted">
                  {formatMetadataLine({
                    startLabel: formatTime(current?.started_at),
                    endLabel: currentEnd ? formatTime(currentEnd.toISOString()) : null,
                    durationLabel: current?.duration_ms ? formatDuration(current.duration_ms) : null,
                  })}
                </div>
                {currentSummary ? (
                  <p className="text-sm text-muted/90 line-clamp-4">
                    {currentSummary}
                  </p>
                ) : null}
                <div>
                  <button
                    type="button"
                    onClick={() => currentLibraryTarget && handleViewLibrary(currentLibraryTarget)}
                    disabled={!currentLibraryTarget}
                    className="inline-flex items-center gap-2 rounded-full border border-border/60 px-4 py-1.5 text-xs font-semibold text-foreground transition hover:border-accent hover:text-accent disabled:opacity-40"
                  >
                    <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
                    View in library
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted">No active playback</div>
          )}
        </section>

        <section className="mx-6 mb-6 rounded-xl border border-border/60 bg-surface/40 shadow-sm">
          <header className="flex items-center justify-between border-b border-border/60 px-6 py-4">
            <h2 className="text-base font-semibold text-foreground">Upcoming</h2>
            <span className="text-xs text-muted">{queueItems.length} item{queueItems.length === 1 ? '' : 's'}</span>
          </header>
          {loading && !queueItems.length ? (
            <div className="flex items-center gap-2 px-6 py-6 text-sm text-muted">
              <FontAwesomeIcon icon={faCircleNotch} spin />
              Loading queue…
            </div>
          ) : null}
          {!loading && !queueItems.length ? (
            <div className="px-6 py-6 text-sm text-muted">Queue is empty</div>
          ) : null}
          {queueItems.length ? (
            <ol className="divide-y divide-border/60">
              {queueItems.map((item, index) => {
                const startLabel = formatTime(item.start_at);
                const endLabel = formatTime(item.end_at);
                const durationLabel = formatDuration(item.duration_ms);
                const metadataLine = formatMetadataLine({ startLabel, endLabel, durationLabel });
                const posterUrl = buildQueuePoster(item);
                const itemLibraryTarget = resolveLibraryTarget(item);
                const canViewLibrary = Boolean(itemLibraryTarget);
                return (
                  <li key={item.id} className="flex items-center justify-between gap-4 px-6 py-4">
                    <div className="flex min-w-0 flex-1 items-start gap-4">
                      {posterUrl ? (
                        <img
                          src={posterUrl}
                          alt={describeItem(item)}
                          className="h-36 w-24 flex-shrink-0 rounded-lg object-cover shadow-md"
                        />
                      ) : null}
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {formatTitleWithYear(item)}
                        </span>
                        {metadataLine ? (
                          <span className="text-xs text-muted">{metadataLine}</span>
                        ) : null}
                        {(
                          item.summary
                          || item.details?.item?.summary
                          || item.details?.summary
                        ) ? (
                          <p className="text-xs text-muted/90 line-clamp-3">
                            {item.summary
                              || item.details?.item?.summary
                              || item.details?.summary}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => itemLibraryTarget && handleViewLibrary(itemLibraryTarget)}
                        disabled={!canViewLibrary}
                        className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3 py-1.5 text-xs font-semibold text-foreground transition hover:border-accent hover:text-accent disabled:opacity-40"
                        title="View in library"
                      >
                        <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
                        View in library
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(item.id, 'up')}
                        disabled={pendingAction || index === 0}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 text-muted transition hover:border-accent hover:text-accent disabled:opacity-40"
                        title="Move up"
                      >
                        <FontAwesomeIcon icon={faArrowUp} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(item.id, 'down')}
                        disabled={pendingAction || index === queueItems.length - 1}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 text-muted transition hover:border-accent hover:text-accent disabled:opacity-40"
                        title="Move down"
                      >
                        <FontAwesomeIcon icon={faArrowDown} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(item.id)}
                        disabled={pendingAction}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 text-danger transition hover:border-danger hover:text-danger disabled:opacity-40"
                        title="Remove"
                      >
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>
      </div>
    </div>
  );
}
