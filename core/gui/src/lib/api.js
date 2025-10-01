import { BACKEND_BASE } from './env.js';

async function apiRequest(path, { method = 'GET', headers, body, json = true } = {}) {
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
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message = data?.error || `Request failed (${response.status})`;
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

export async function fetchSystemSettings(namespace) {
  return apiRequest(`/settings/system/${namespace}`);
}

export async function updateSystemSettings(namespace, values) {
  return apiRequest(`/settings/system/${namespace}`, {
    method: 'PUT',
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

export async function fetchChatMentions() {
  return apiRequest('/chat/mentions');
}

export { apiRequest };
