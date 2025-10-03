import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faImage,
  faRotateRight,
  faCircleInfo,
} from '@fortawesome/free-solid-svg-icons';
import placeholderPoster from '../img/placeholder.png';
import { plexImageUrl } from '../lib/api.js';

function resolveImageUrl(path, params = {}) {
  if (!path) {
    return null;
  }
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('data:')) {
    return path;
  }
  return plexImageUrl(path, params);
}

function pickPoster(metadata) {
  const images = Array.isArray(metadata?.details?.images) ? metadata.details.images : [];
  const findByType = (type) => {
    const needle = String(type || '').toLowerCase();
    return images.find((image) => (image?.type ?? '').toLowerCase() === needle) ?? null;
  };

  const candidate =
    findByType('coverposter') ||
    findByType('coverart') ||
    findByType('poster') ||
    (metadata?.item?.thumb ? { url: metadata.item.thumb } : null) ||
    (metadata?.item?.grandparent_thumb ? { url: metadata.item.grandparent_thumb } : null);

  if (!candidate?.url) {
    return null;
  }
  return resolveImageUrl(candidate.url, { width: 600, height: 900, min: 1, upscale: 1 });
}

function formatRuntime(durationMs) {
  const numeric = Number(durationMs);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const totalSeconds = Math.floor(numeric / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function metadataDurationSeconds(metadata) {
  const candidates = [
    metadata?.item?.duration,
    metadata?.details?.item?.duration,
    metadata?.source?.duration,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric / 1000;
    }
  }
  return null;
}

function coerceDurationSeconds(progress, metadata) {
  const fromMetadata = metadataDurationSeconds(metadata);
  if (fromMetadata !== null) {
    return fromMetadata;
  }
  if (Number.isFinite(progress?.durationSeconds) && progress.durationSeconds > 0) {
    return progress.durationSeconds;
  }
  return null;
}

function coerceCurrentSeconds(progress, durationSeconds) {
  if (Number.isFinite(progress?.currentSeconds) && progress.currentSeconds >= 0) {
    const current = progress.currentSeconds;
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      return Math.min(current, durationSeconds);
    }
    return current;
  }
  return 0;
}

export default function MetadataPanel({
  metadata,
  loading,
  error,
  progress,
  onReload,
  onViewLibrary,
}) {
  const item = metadata?.item && Object.keys(metadata.item).length ? metadata.item : null;
  const runtimeLabel = item ? formatRuntime(item.duration ?? metadata?.source?.duration) : null;
  const releaseYear = item?.year ? String(item.year) : null;
  const contentRating = item?.content_rating ?? null;
  const tagline = item?.tagline ?? null;
  const summary = item?.summary ?? null;
  const posterUrl = pickPoster(metadata);
  const genres = Array.isArray(item?.genres)
    ? item.genres
        .map((genre) => genre?.title || genre?.tag)
        .filter((genre, index, arr) => genre && arr.indexOf(genre) === index)
    : [];
  const directors = Array.isArray(item?.directors)
    ? item.directors
        .map((director) => director?.title || director?.tag)
        .filter((director, index, arr) => director && arr.indexOf(director) === index)
    : [];

  const durationSeconds = coerceDurationSeconds(progress, metadata);
  const currentSeconds = coerceCurrentSeconds(progress, durationSeconds);
  const progressPercent = durationSeconds
    ? Math.min(100, Math.max(0, (currentSeconds / durationSeconds) * 100))
    : 0;
  const formattedCurrent = formatClock(currentSeconds);
  const formattedDuration = durationSeconds ? formatClock(durationSeconds) : null;

  const infoBadges = [releaseYear, contentRating, runtimeLabel].filter(Boolean);

  let updatedLabel = null;
  if (metadata?.updated_at) {
    const parsed = new Date(metadata.updated_at);
    if (!Number.isNaN(parsed.getTime())) {
      updatedLabel = parsed.toLocaleTimeString();
    }
  }

  let bodyContent = null;
  if (loading) {
    bodyContent = (
      <div className="panel-section flex items-center gap-3 text-sm text-muted">
        <FontAwesomeIcon icon={faRotateRight} spin fixedWidth />
        <span>Loading metadata…</span>
      </div>
    );
  } else if (error) {
    bodyContent = (
      <div className="panel-section space-y-3 text-sm text-danger">
        <p>{error}</p>
        <button
          type="button"
          onClick={onReload}
          className="inline-flex items-center gap-2 rounded-full border border-danger/50 px-4 py-1.5 text-sm font-medium text-danger transition hover:border-danger"
        >
          <FontAwesomeIcon icon={faRotateRight} fixedWidth />
          Retry
        </button>
      </div>
    );
  } else if (!item) {
    bodyContent = (
      <div className="panel-section flex items-center gap-3 text-sm text-muted">
        <FontAwesomeIcon icon={faCircleInfo} fixedWidth />
        <span>No active playback</span>
      </div>
    );
  } else {
    bodyContent = (
      <div className="space-y-6">
        {durationSeconds ? (
          <section className="panel-section space-y-2">
            <div className="flex items-center justify-between text-xs text-muted">
              <span>Progress</span>
              <span>
                {formattedCurrent}
                {formattedDuration ? ` / ${formattedDuration}` : ''}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-border/60">
              <div
                className="h-2 rounded-full bg-accent transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </section>
        ) : null}

        <section className="panel-section">
          <div className="w-full overflow-hidden rounded-xl border border-border/60 bg-border/30 shadow-sm">
            <div className="relative aspect-[2/3] w-full">
              {posterUrl ? (
                <img
                  src={posterUrl}
                  alt={item.title ?? 'Poster'}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-border/30 text-center">
                  <FontAwesomeIcon icon={faImage} className="text-lg text-muted" />
                  <img src={placeholderPoster} alt="" className="h-0 w-0 opacity-0" aria-hidden="true" />
                  <span className="px-3 text-xs font-medium uppercase tracking-wide text-subtle">
                    Artwork unavailable
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel-section space-y-3">
          <div>
            <h3 className="text-xl font-semibold text-foreground">
              {item.show_title ? (
                <>
                  <span className="text-base text-muted">{item.show_title}</span>
                  <br />
                  {item.season_number && item.episode_number ? (
                    <span className="text-sm text-muted">
                      S{String(item.season_number).padStart(2, '0')}E{String(item.episode_number).padStart(2, '0')}
                      {' '}
                    </span>
                  ) : null}
                  {item.title}
                </>
              ) : (
                item.title
              )}
            </h3>
            {tagline ? <p className="text-sm text-muted">{tagline}</p> : null}
          </div>

          {infoBadges.length ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-wide text-subtle">
              {infoBadges.map((badge) => (
                <span key={badge}>{badge}</span>
              ))}
            </p>
          ) : null}

          {summary ? (
            <div className="space-y-2 text-sm leading-relaxed text-muted">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Summary</h4>
              <p>{summary}</p>
            </div>
          ) : null}

          {directors.length ? (
            <div className="space-y-2 text-sm text-muted">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Director{directors.length > 1 ? 's' : ''}</h4>
              <p>{directors.join(', ')}</p>
            </div>
          ) : null}

          {genres.length ? (
            <div className="space-y-2 text-sm text-muted">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Genres</h4>
              <div className="flex flex-wrap gap-2">
                {genres.map((genre) => (
                  <span
                    key={genre}
                    className="rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-foreground"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <div className="panel-section">
          <button
            type="button"
            onClick={onViewLibrary}
            className="inline-flex items-center gap-2 rounded-full bg-accent/10 px-4 py-2 text-sm font-semibold text-accent transition hover:bg-accent/20"
          >
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} fixedWidth />
            View in library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex items-center justify-between border-b border-border/80 px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">Metadata</h2>
        {updatedLabel ? (
          <span className="text-xs text-muted">Updated {updatedLabel}</span>
        ) : null}
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {bodyContent}
      </div>
    </div>
  );
}
