import { BACKEND_BASE } from './env.js';

async function apiRequest(path, { method = 'GET', headers, body, json = true, signal } = {}) {
  const finalHeaders = new Headers(headers || {});
  let payload = body;
  if (json && body && !(body instanceof FormData)) {
    finalHeaders.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${BACKEND_BASE}${path}`, {
    method,
    headers: finalHeaders,
    body: payload,
    credentials: 'include',
    signal,
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const expectsJson = contentType.toLowerCase().includes('application/json');
  const needsFallbackText = !response.ok;
  const fallbackSource = needsFallbackText ? response.clone() : null;

  let data = null;
  if (expectsJson) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    const textBody = await response.text();
    data = textBody ? textBody : null;
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    if (data && typeof data === 'object' && 'error' in data && data.error) {
      message = data.error;
    } else if (typeof data === 'string' && data.trim()) {
      message = data.trim();
    } else if (fallbackSource) {
      try {
        const fallbackText = await fallbackSource.text();
        if (fallbackText.trim()) {
          message = fallbackText.trim();
          data = data ?? fallbackText;
        }
      } catch {
        // ignore fallback errors; keep default message
      }
    }
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data;
}

export async function fetchPreferences() {
  return apiRequest('/users/me/preferences');
}

export async function updateProfile(profile) {
  return apiRequest('/users/me/profile', {
    method: 'PATCH',
    body: profile,
  });
}

export async function changePassword(payload) {
  return apiRequest('/users/me/password', {
    method: 'PATCH',
    body: payload,
  });
}

export async function updateChatPreferences(preferences) {
  return apiRequest('/users/me/settings/chat', {
    method: 'PATCH',
    body: preferences,
  });
}

export async function updateAppearancePreferences(preferences) {
  return apiRequest('/users/me/settings/appearance', {
    method: 'PATCH',
    body: preferences,
  });
}

export async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('avatar', file);
  return apiRequest('/users/me/avatar', {
    method: 'POST',
    body: formData,
    json: false,
  });
}

export async function deleteAvatar() {
  return apiRequest('/users/me/avatar', { method: 'DELETE' });
}

export async function fetchSystemSettings(namespace, options = {}) {
  return apiRequest(`/settings/system/${namespace}`, options);
}

export async function updateSystemSettings(namespace, values) {
  return apiRequest(`/settings/system/${namespace}`, {
    method: 'PUT',
    body: { values },
  });
}

export async function previewTranscoderCommand(values) {
  return apiRequest('/settings/system/transcoder/preview', {
    method: 'POST',
    body: { values },
  });
}

export async function fetchGroups() {
  return apiRequest('/settings/groups');
}

export async function createGroup(payload) {
  return apiRequest('/settings/groups', {
    method: 'POST',
    body: payload,
  });
}

export async function updateGroup(groupId, payload) {
  return apiRequest(`/settings/groups/${groupId}`, {
    method: 'PATCH',
    body: payload,
  });
}

export async function deleteGroup(groupId) {
  return apiRequest(`/settings/groups/${groupId}`, {
    method: 'DELETE',
  });
}

export async function fetchUsers() {
  return apiRequest('/settings/users');
}

export async function updateUserGroups(userId, groups) {
  return apiRequest(`/settings/users/${userId}/groups`, {
    method: 'PATCH',
    body: { groups },
  });
}

export async function connectPlex({ serverUrl, token, verifySsl }) {
  const body = {
    server_url: serverUrl,
    token,
  };
  if (verifySsl !== undefined) {
    body.verify_ssl = verifySsl;
  }
  return apiRequest('/settings/plex/connect', {
    method: 'POST',
    body,
  });
}

export async function disconnectPlex() {
  return apiRequest('/settings/plex/disconnect', {
    method: 'POST',
  });
}

export async function fetchChatMentions() {
  return apiRequest('/chat/mentions');
}

export { apiRequest };

function buildQuery(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== undefined && entry !== null && entry !== '') {
          searchParams.append(key, entry);
        }
      });
      return;
    }
    searchParams.set(key, value);
  });
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

export async function fetchPlexSections() {
  return apiRequest('/library/plex/sections');
}

export async function fetchPlexSectionItems(sectionId, params = {}) {
  const query = buildQuery(params);
  return apiRequest(`/library/plex/sections/${encodeURIComponent(sectionId)}/items${query}`);
}

export async function fetchPlexSectionCollections(sectionId, params = {}) {
  const query = buildQuery(params);
  return apiRequest(`/library/plex/sections/${encodeURIComponent(sectionId)}/collections${query}`);
}

export async function fetchPlexSectionSnapshot(sectionId, params = {}) {
  const query = buildQuery(params);
  return apiRequest(`/library/plex/sections/${encodeURIComponent(sectionId)}/snapshot${query}`);
}

export async function buildPlexSectionSnapshot(sectionId, body = {}) {
  return apiRequest(`/library/plex/sections/${encodeURIComponent(sectionId)}/snapshot/build`, {
    method: 'POST',
    body,
  });
}

export async function cachePlexSectionImages(sectionId, body = {}) {
  return apiRequest(`/library/plex/sections/${encodeURIComponent(sectionId)}/images`, {
    method: 'POST',
    body,
  });
}

export async function refreshPlexSectionItems(sectionId, body = {}) {
  return apiRequest(`/library/plex/sections/${encodeURIComponent(sectionId)}/items/refresh`, {
    method: 'POST',
    body,
  });
}

export async function stopTask(taskId, { terminate = false } = {}) {
  return apiRequest('/settings/tasks/stop', {
    method: 'POST',
    body: { task_id: taskId, terminate },
  });
}

export async function fetchPlexSearch(query, params = {}) {
  const queryString = buildQuery({
    query,
    offset: params.offset,
    limit: params.limit,
  });
  return apiRequest(`/library/plex/search${queryString}`);
}

export async function fetchPlexItemDetails(ratingKey) {
  return apiRequest(`/library/plex/items/${encodeURIComponent(ratingKey)}`);
}

export async function refreshPlexItemDetails(ratingKey) {
  return apiRequest(`/library/plex/items/${encodeURIComponent(ratingKey)}/refresh`, {
    method: 'POST',
  });
}

export async function playPlexItem(ratingKey, body = {}) {
  return apiRequest(`/library/plex/items/${encodeURIComponent(ratingKey)}/play`, {
    method: 'POST',
    body,
  });
}

export async function fetchQueue() {
  return apiRequest('/queue');
}

export async function enqueueQueueItem(ratingKey, { partId, mode = 'last', index } = {}) {
  const body = { rating_key: ratingKey };
  if (partId) {
    body.part_id = partId;
  }
  if (mode) {
    body.mode = mode;
  }
  if (index !== undefined && index !== null) {
    body.index = index;
  }
  return apiRequest('/queue/items', {
    method: 'POST',
    body,
  });
}

export async function moveQueueItem(itemId, direction) {
  return apiRequest(`/queue/items/${itemId}/move`, {
    method: 'PATCH',
    body: { direction },
  });
}

export async function deleteQueueItem(itemId) {
  return apiRequest(`/queue/items/${itemId}`, {
    method: 'DELETE',
  });
}

export async function playQueue() {
  return apiRequest('/queue/play', { method: 'POST' });
}

export async function skipQueue() {
  return apiRequest('/queue/skip', { method: 'POST' });
}

export async function fetchCurrentPlayback() {
  return apiRequest('/transcode/current-item');
}

export function plexImageUrl(path, params = {}) {
  if (!path) {
    return null;
  }
  const url = new URL(`${BACKEND_BASE}/library/plex/image`);
  url.searchParams.set('path', path);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    url.searchParams.set(key, value);
  });
  return url.toString();
}
