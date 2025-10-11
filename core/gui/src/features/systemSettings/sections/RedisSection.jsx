import { SectionContainer, TextField, Feedback } from '../shared.jsx';

const REDIS_DEFAULT_MAX_ENTRIES = 0;
const REDIS_DEFAULT_TTL_SECONDS = 0;

export function sanitizeRedisRecord(record = {}, defaults = {}) {
  const merged = {
    redis_url: '',
    max_entries: REDIS_DEFAULT_MAX_ENTRIES,
    ttl_seconds: REDIS_DEFAULT_TTL_SECONDS,
    ...(defaults || {}),
    ...(record || {}),
  };
  const redisUrl = typeof merged.redis_url === 'string' ? merged.redis_url.trim() : '';
  const maxEntries = Number.parseInt(merged.max_entries, 10);
  const ttlSeconds = Number.parseInt(merged.ttl_seconds, 10);
  return {
    redis_url: redisUrl,
    max_entries: Number.isFinite(maxEntries) && maxEntries >= 0 ? maxEntries : 0,
    ttl_seconds: Number.isFinite(ttlSeconds) && ttlSeconds >= 0 ? ttlSeconds : 0,
    backend: redisUrl ? 'redis' : 'disabled',
  };
}

export default function RedisSection({ redisSettings }) {
  if (redisSettings.loading) {
    return <div className="text-sm text-muted">Loading Redis settings…</div>;
  }

  const defaults = sanitizeRedisRecord(redisSettings.defaults || {});
  const current = sanitizeRedisRecord(redisSettings.data || {}, defaults);
  const snapshot = redisSettings.snapshot || {};
  const redisAvailable = Boolean(snapshot.available);
  const lastError = snapshot.last_error || (redisAvailable ? null : 'Redis URL not configured');
  const managedBy = String(redisSettings.managedBy || 'environment');

  const resolvedUrl = current.redis_url ?? defaults.redis_url ?? '';
  const resolvedMaxEntries = current.max_entries ?? defaults.max_entries ?? 0;
  const resolvedTtlSeconds = current.ttl_seconds ?? defaults.ttl_seconds ?? 0;
  const statusLabel = redisAvailable ? 'Connected' : 'Unavailable';
  const managerLabel = managedBy === 'environment' ? 'Environment variables' : managedBy;

  return (
    <SectionContainer title="Redis status">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Redis URL"
          value={resolvedUrl}
          disabled
          readOnly
          helpText="Managed via environment (e.g. TRANSCODER_REDIS_URL)."
        />
        <TextField
          label="Max entries"
          type="number"
          value={String(resolvedMaxEntries)}
          disabled
          readOnly
          helpText="Total cached payloads to retain. Set via TRANSCODER_REDIS_MAX_ENTRIES."
        />
        <TextField
          label="TTL (seconds)"
          type="number"
          value={String(resolvedTtlSeconds)}
          disabled
          readOnly
          helpText="Expiration time for cached entries. Set via TRANSCODER_REDIS_TTL_SECONDS."
        />
      </div>
      <div className="mt-4 space-y-2 text-xs text-muted">
        <p>
          <span className="font-semibold text-foreground">Connection status:</span>{' '}
          {statusLabel}
          {lastError ? (
            <span className="ml-1 text-rose-300">({lastError})</span>
          ) : null}
        </p>
        <p>
          <span className="font-semibold text-foreground">Managed by:</span>{' '}
          {managerLabel}
        </p>
        {!redisAvailable ? (
          <p className="text-rose-300">
            Redis is required for caching, chat, and task coordination. Update the environment configuration
            and restart the services to restore connectivity.
          </p>
        ) : null}
      </div>
      <div className="mt-4 text-xs text-muted">
        <p>
          Environment-managed settings apply at startup. Edit your `.env` or deployment variables and restart
          the API/transcoder services to change Redis connectivity.
        </p>
      </div>
      {redisSettings.feedback ? (
        <div className="mt-4 text-xs">
          <Feedback {...redisSettings.feedback} />
        </div>
      ) : null}
    </SectionContainer>
  );
}
