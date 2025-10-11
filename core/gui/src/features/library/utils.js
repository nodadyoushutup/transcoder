import {
  DEFAULT_SECTION_PAGE_LIMIT,
  SECTION_PAGE_LIMIT_MAX,
  SECTION_PAGE_LIMIT_MIN,
  SECTION_VIEW_COLLECTIONS,
  SECTION_VIEW_LIBRARY,
  SECTION_VIEW_RECOMMENDED,
} from './constants.js';
import { plexImageUrl } from '../../lib/api.js';
import imdbLogo from '../../img/imdb.svg';
import tmdbLogo from '../../img/tmdb.svg';
import rtFreshCritic from '../../img/rt_fresh_critic.svg';
import rtPositiveCritic from '../../img/rt_positive_critic.svg';
import rtNegativeCritic from '../../img/rt_negative_critic.svg';
import rtPositiveAudience from '../../img/rt_positive_audience.svg';
import rtNegativeAudience from '../../img/rt_negative_audience.svg';
import {
  faLayerGroup,
  faFilm,
  faTv,
  faMusic,
  faImage,
} from '@fortawesome/free-solid-svg-icons';

export function normalizeSectionViewValue(value, fallback = SECTION_VIEW_LIBRARY) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ([SECTION_VIEW_RECOMMENDED, SECTION_VIEW_LIBRARY, SECTION_VIEW_COLLECTIONS].includes(candidate)) {
    return candidate;
  }
  return [SECTION_VIEW_RECOMMENDED, SECTION_VIEW_LIBRARY, SECTION_VIEW_COLLECTIONS].includes(fallback)
    ? fallback
    : SECTION_VIEW_LIBRARY;
}

export function formatRuntime(duration) {
  if (!duration || Number.isNaN(Number(duration))) {
    return null;
  }
  const totalSeconds = Math.floor(Number(duration) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  const seconds = totalSeconds % 60;
  return `${seconds}s`;
}

export function formatDate(value) {
  if (!value) {
    return null;
  }
  try {
    const date = new Date(value);
    return date.toLocaleDateString();
  } catch (error) {
    return null;
  }
}

export function clampSectionPageLimit(value, fallback = DEFAULT_SECTION_PAGE_LIMIT) {
  const base = Number.isFinite(fallback) ? Number(fallback) : DEFAULT_SECTION_PAGE_LIMIT;
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return Math.min(SECTION_PAGE_LIMIT_MAX, Math.max(SECTION_PAGE_LIMIT_MIN, base));
  }
  return Math.min(SECTION_PAGE_LIMIT_MAX, Math.max(SECTION_PAGE_LIMIT_MIN, numeric));
}

export function formatBitrate(value) {
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  if (numeric >= 1000 * 1000) {
    return `${Math.round(numeric / 1000 / 1000).toLocaleString()} Mbps`;
  }
  if (numeric >= 1000) {
    return `${Math.round(numeric / 1000).toLocaleString()} kbps`;
  }
  return `${Math.round(numeric).toLocaleString()} bps`;
}

export function formatFileSize(bytes) {
  const numeric = Number(bytes);
  if (!numeric || Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let size = numeric;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const formatted = size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2);
  return `${formatted} ${units[unitIndex]}`;
}

export function formatFrameRate(value) {
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric.toFixed(2)} fps`;
}

export function formatChannelLayout(value) {
  if (!value) {
    return null;
  }
  const preset = String(value).toLowerCase();
  const channelMap = {
    stereo: 'Stereo',
    mono: 'Mono',
    surround: 'Surround',
    '5.1': '5.1 Surround',
    '7.1': '7.1 Surround',
  };
  if (preset in channelMap) {
    return channelMap[preset];
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    switch (numeric) {
      case 1:
        return 'Mono';
      case 2:
        return 'Stereo';
      case 6:
        return '5.1 Surround';
      case 7:
        return '6.1 Surround';
      case 8:
        return '7.1 Surround';
      default:
        return `${numeric}-channel`;
    }
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return null;
}

export function formatCount(value) {
  const numeric = Number(value);
  if (!numeric || Number.isNaN(numeric) || numeric < 0) {
    return null;
  }
  return numeric.toLocaleString();
}

export function formatRatingValue(value, decimals = 1) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return String(value);
  }
  if (!decimals || decimals <= 0) {
    return numeric.toString();
  }
  return numeric.toFixed(decimals);
}

export function resolveImageUrl(path, params) {
  if (!path) {
    return null;
  }
  if (/^https?:\/\//i.test(path) || path.startsWith('data:')) {
    return path;
  }
  return plexImageUrl(path, params);
}

export function imageByType(images, type) {
  if (!images?.length || !type) {
    return null;
  }
  const target = type.toLowerCase();
  return images.find((image) => (image?.type ?? '').toLowerCase() === target) ?? null;
}

export const PROVIDER_LABELS = {
  rottentomatoes: 'Rotten Tomatoes',
  imdb: 'IMDb',
  tmdb: 'TMDb',
};

const ROTTEN_TOMATOES_ICONS = {
  critic: {
    positive: rtPositiveCritic,
    neutral: rtFreshCritic,
    negative: rtNegativeCritic,
  },
  audience: {
    positive: rtPositiveAudience,
    negative: rtNegativeAudience,
  },
};

export function resolveRottenTomatoesIcon(image, variant = 'critic') {
  const normalized = (image ?? '').toLowerCase();
  if (variant === 'audience') {
    if (normalized.includes('spilled')) {
      return {
        src: ROTTEN_TOMATOES_ICONS.audience.negative,
        alt: 'Rotten Tomatoes Audience (Spilled)',
      };
    }
    if (normalized.includes('upright')) {
      return {
        src: ROTTEN_TOMATOES_ICONS.audience.positive,
        alt: 'Rotten Tomatoes Audience (Upright)',
      };
    }
    return {
      src: ROTTEN_TOMATOES_ICONS.audience.positive,
      alt: 'Rotten Tomatoes Audience',
    };
  }

  if (normalized.includes('rotten')) {
    return {
      src: ROTTEN_TOMATOES_ICONS.critic.negative,
      alt: 'Rotten Tomatoes Critics (Rotten)',
    };
  }
  if (normalized.includes('ripe')) {
    return {
      src: ROTTEN_TOMATOES_ICONS.critic.positive,
      alt: 'Rotten Tomatoes Critics (Certified Fresh)',
    };
  }
  if (normalized.includes('fresh')) {
    return {
      src: ROTTEN_TOMATOES_ICONS.critic.neutral,
      alt: 'Rotten Tomatoes Critics (Fresh)',
    };
  }
  return {
    src: ROTTEN_TOMATOES_ICONS.critic.positive,
    alt: 'Rotten Tomatoes Critics',
  };
}

export function resolveRatingIcon({ provider, image, variant }) {
  if (!provider) {
    return null;
  }
  switch (provider) {
    case 'rottentomatoes':
      return resolveRottenTomatoesIcon(image, variant);
    case 'imdb':
      return { src: imdbLogo, alt: 'IMDb' };
    case 'tmdb':
      return { src: tmdbLogo, alt: 'TMDb' };
    default:
      return null;
  }
}

export function detectRatingProvider(entry) {
  const image = (entry?.image ?? '').toLowerCase();
  const type = (entry?.type ?? '').toLowerCase();
  const id = (entry?.id ?? '').toLowerCase();

  if (image.includes('rottentomatoes') || id.startsWith('rottentomatoes://')) {
    const variant = type.includes('audience') || image.includes('upright') || image.includes('spilled') ? 'audience' : 'critic';
    return { provider: 'rottentomatoes', variant };
  }

  if (image.includes('imdb') || id.startsWith('imdb://')) {
    return { provider: 'imdb', variant: null };
  }

  if (image.includes('themoviedb') || image.includes('tmdb') || id.startsWith('tmdb://')) {
    return { provider: 'tmdb', variant: null };
  }

  return { provider: null, variant: null };
}

export function formatProviderRating(value, provider) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return typeof value === 'string' ? value : null;
  }
  if (provider === 'rottentomatoes' || provider === 'tmdb') {
    const scaled = Math.round(numeric * 10);
    return `${scaled}%`;
  }
  if (provider === 'imdb') {
    return numeric.toFixed(1);
  }
  const formatted = numeric.toFixed(1);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
}

export function streamTypeValue(stream) {
  if (!stream) {
    return null;
  }
  const candidates = [stream.stream_type, stream.streamType, stream.type];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') {
      continue;
    }
    const numeric = Number(candidate);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }
  return null;
}

export function filterStatEntries(entries) {
  return (entries ?? []).filter((entry) => {
    if (!entry) {
      return false;
    }
    const value = entry.value;
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === 'string' && value.trim() === '') {
      return false;
    }
    return true;
  });
}

export function ensureArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function typeLabel(type) {
  if (!type) {
    return '';
  }
  switch (type) {
    case 'movie':
      return 'Movie';
    case 'show':
      return 'Series';
    case 'season':
      return 'Season';
    case 'episode':
      return 'Episode';
    case 'track':
      return 'Track';
    case 'album':
      return 'Album';
    case 'artist':
      return 'Artist';
    case 'clip':
      return 'Clip';
    case 'video':
      return 'Video';
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

export function typeIcon(type) {
  if (!type) {
    return faLayerGroup;
  }
  switch (type) {
    case 'movie':
      return faFilm;
    case 'show':
    case 'season':
    case 'episode':
      return faTv;
    case 'artist':
    case 'album':
    case 'track':
      return faMusic;
    case 'photo':
    case 'picture':
    case 'image':
      return faImage;
    default:
      return faLayerGroup;
  }
}

export function childGroupLabel(key) {
  switch (key) {
    case 'seasons':
      return 'Seasons';
    case 'episodes':
      return 'Episodes';
    case 'albums':
      return 'Albums';
    case 'tracks':
      return 'Tracks';
    case 'items':
      return 'Items';
    default:
      return key.charAt(0).toUpperCase() + key.slice(1);
  }
}

export function normalizeKey(section) {
  if (!section) {
    return null;
  }
  if (section.id !== null && section.id !== undefined) {
    return section.id;
  }
  return section.key ?? null;
}

export function uniqueKey(item) {
  return item?.rating_key ?? item?.key ?? item?.uuid ?? Math.random().toString(36).slice(2);
}

export function normalizeSnapshotPayload(payload = {}) {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const totalCandidate = Number(payload.total);
  const total = Number.isFinite(totalCandidate) ? totalCandidate : null;
  const cachedCandidate = Number(payload.cached);
  const cached = Number.isFinite(cachedCandidate) ? cachedCandidate : rawItems.length;
  const completed = Boolean(
    payload.completed
      || (Number.isFinite(total) && total !== null && cached >= total),
  );
  return {
    section_id: payload.section_id ?? null,
    cached,
    total,
    completed,
    updated_at: payload.updated_at ?? null,
    items: rawItems,
    request_signature: payload.request_signature ?? null,
    server: payload.server ?? null,
    section: payload.section ?? null,
    sort_options: Array.isArray(payload.sort_options) ? payload.sort_options : null,
  };
}

export function mergeSnapshotSummary(existing, summary) {
  if (!summary) {
    return existing || null;
  }
  const normalized = normalizeSnapshotPayload(summary);
  if (!existing) {
    return normalized;
  }
  const nextItems = normalized.items.length >= (existing.items?.length ?? 0)
    ? normalized.items
    : existing.items ?? [];
  return {
    ...existing,
    section_id: normalized.section_id ?? existing.section_id,
    cached: Math.max(existing.cached ?? 0, normalized.cached ?? 0),
    total: normalized.total ?? existing.total ?? null,
    completed: Boolean(existing.completed || normalized.completed),
    updated_at: normalized.updated_at ?? existing.updated_at ?? null,
    items: nextItems,
    request_signature: normalized.request_signature ?? existing.request_signature ?? null,
    server: normalized.server ?? existing.server ?? null,
    section: normalized.section ?? existing.section ?? null,
    sort_options: normalized.sort_options ?? existing.sort_options ?? null,
  };
}

export function buildItemsPayloadFromSnapshot(snapshot, sectionPageLimit, previousPayload = null) {
  if (!snapshot) {
    return previousPayload;
  }
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const fallbackLimit = Number.isFinite(sectionPageLimit) ? sectionPageLimit : DEFAULT_SECTION_PAGE_LIMIT;
  const previousLimit = previousPayload?.pagination?.limit;
  const limit = Math.max(1, previousLimit ?? fallbackLimit);
  const total = Number.isFinite(snapshot.total)
    ? Number(snapshot.total)
    : previousPayload?.pagination?.total ?? items.length;
  const loaded = items.length;
  const hasMore = !snapshot.completed && (total === null || loaded < total);
  return {
    ...(previousPayload ?? {}),
    server: snapshot.server ?? previousPayload?.server ?? null,
    section: snapshot.section ?? previousPayload?.section ?? null,
    items,
    pagination: {
      offset: 0,
      limit,
      total,
      size: loaded,
      loaded,
      has_more: hasMore,
    },
    sort_options: snapshot.sort_options ?? previousPayload?.sort_options ?? [],
    snapshot_source: true,
  };
}

export function normalizeLetter(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const upper = String(value).trim().toUpperCase();
  if (!upper) {
    return null;
  }
  if (/^[A-Z]$/.test(upper)) {
    return upper;
  }
  if (/^[0-9]$/.test(upper) || upper === '#') {
    return '0-9';
  }
  return null;
}

export function deriveItemLetter(item) {
  const candidates = [item?.sort_title, item?.title];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    for (let index = 0; index < trimmed.length; index += 1) {
      const normalized = normalizeLetter(trimmed[index]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}
