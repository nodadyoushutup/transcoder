import { useEffect, useMemo, useState } from 'react';
import {
  changePassword,
  deleteAvatar,
  fetchPreferences,
  updateChatPreferences,
  updateProfile,
  uploadAvatar,
} from '../lib/api.js';
import { BACKEND_BASE } from '../lib/env.js';

const SOUND_MODULES = import.meta.glob('../audio/*', {
  eager: true,
  import: 'default',
  query: '?url',
});

const SOUND_OPTIONS = Object.entries(SOUND_MODULES).map(([path, url]) => {
  const fileName = path.split('/').pop();
  const baseName = fileName.replace(/\.[a-z0-9]+$/i, '');
  const label = baseName
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return {
    id: fileName,
    label,
    url,
  };
});

const AVATAR_MAX_DIMENSION = 256;

function resolveAvatarUrl(user) {
  if (!user?.avatar_url) {
    return null;
  }
  if (user.avatar_url.startsWith('http')) {
    return user.avatar_url;
  }
  return `${BACKEND_BASE}${user.avatar_url}`;
}

const NOTIFY_OPTIONS = [
  { id: 'all', label: 'All messages' },
  { id: 'mentions', label: 'Mentions only' },
  { id: 'none', label: 'Mute notifications' },
];

function Section({ title, description, children }) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
        {description ? <p className="mt-1 text-xs text-zinc-500">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Feedback({ message, tone = 'info' }) {
  if (!message) {
    return null;
  }
  const toneClasses = {
    info: 'text-amber-200',
    error: 'text-rose-300',
    success: 'text-emerald-300',
  };
  return <p className={`mt-3 text-xs ${toneClasses[tone] || toneClasses.info}`}>{message}</p>;
}

export default function PreferencesPage({
  user,
  onReloadSession,
  initialChatPreferences = null,
  onChatPreferencesChange,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState({ username: '', email: '' });
  const [chatSettings, setChatSettings] = useState(() => ({
    notification_sound: initialChatPreferences?.notification_sound
      || SOUND_OPTIONS[0]?.id
      || 'notification_chat.mp3',
    notification_volume: initialChatPreferences?.notification_volume ?? 0.6,
    notify_scope: initialChatPreferences?.notify_scope || 'mentions',
  }));
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState(null);
  const [passwordFeedback, setPasswordFeedback] = useState(null);
  const [chatFeedback, setChatFeedback] = useState(null);
  const [avatarFeedback, setAvatarFeedback] = useState(null);
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '' });

  useEffect(() => {
    let ignore = false;
    async function load() {
      if (!user) {
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await fetchPreferences();
        if (ignore) {
          return;
        }
        const resolvedProfile = {
          username: data?.user?.username ?? '',
          email: data?.user?.email ?? '',
        };
        const chat = {
          notification_sound: data?.chat?.settings?.notification_sound
            || data?.chat?.defaults?.notification_sound
            || SOUND_OPTIONS[0]?.id
            || '',
          notification_volume: Number(
            data?.chat?.settings?.notification_volume
            ?? data?.chat?.defaults?.notification_volume
            ?? 0.6,
          ),
          notify_scope: data?.chat?.settings?.notify_scope
            || data?.chat?.defaults?.notify_scope
            || 'mentions',
        };
        setProfile(resolvedProfile);
        setChatSettings(chat);
        onChatPreferencesChange?.(chat);
      } catch (exc) {
        if (!ignore) {
          setError(exc instanceof Error ? exc.message : 'Unable to load preferences');
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, [user]);

  const handleProfileSave = async () => {
    setSavingProfile(true);
    setProfileFeedback(null);
    try {
      await updateProfile(profile);
      await onReloadSession?.();
      setProfileFeedback({ tone: 'success', message: 'Profile updated successfully.' });
    } catch (exc) {
      setProfileFeedback({ tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update profile.' });
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSave = async () => {
    if (!passwordForm.current_password || !passwordForm.new_password) {
      setPasswordFeedback({ tone: 'error', message: 'Both password fields are required.' });
      return;
    }
    setPasswordFeedback(null);
    try {
      await changePassword(passwordForm);
      setPasswordFeedback({ tone: 'success', message: 'Password updated successfully.' });
      setPasswordForm({ current_password: '', new_password: '' });
    } catch (exc) {
      setPasswordFeedback({ tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update password.' });
    }
  };

  const handleChatSave = async () => {
    setChatFeedback(null);
    try {
      await updateChatPreferences(chatSettings);
      setChatFeedback({ tone: 'success', message: 'Chat preferences saved.' });
      onChatPreferencesChange?.(chatSettings);
    } catch (exc) {
      setChatFeedback({ tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save chat preferences.' });
    }
  };

  const handleAvatarUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setAvatarFeedback(null);
    try {
      await uploadAvatar(file);
      await onReloadSession?.();
      setAvatarFeedback({ tone: 'success', message: 'Avatar updated.' });
    } catch (exc) {
      setAvatarFeedback({ tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update avatar.' });
    }
  };

  const handleAvatarDelete = async () => {
    setAvatarFeedback(null);
    try {
      await deleteAvatar();
      await onReloadSession?.();
      setAvatarFeedback({ tone: 'success', message: 'Avatar removed.' });
    } catch (exc) {
      setAvatarFeedback({ tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to remove avatar.' });
    }
  };

  const selectedSound = useMemo(
    () => SOUND_OPTIONS.find((option) => option.id === chatSettings.notification_sound) || SOUND_OPTIONS[0],
    [chatSettings.notification_sound],
  );

  if (!user) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        Sign in to manage your preferences.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        Loading preferences…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-rose-300">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto px-4 py-6 md:px-10">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Preferences</h1>
        <p className="mt-1 text-sm text-zinc-500">Manage your account details, password, chat behaviour, and avatar.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Profile" description="Update your username and email address.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Username
              <input
                type="text"
                value={profile.username}
                onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-400 focus:outline-none"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Email
              <input
                type="email"
                value={profile.email}
                onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-400 focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleProfileSave}
              disabled={savingProfile}
              className="rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {savingProfile ? 'Saving…' : 'Save profile'}
            </button>
          </div>
          <Feedback message={profileFeedback?.message} tone={profileFeedback?.tone} />
        </Section>

        <Section title="Password" description="Update your password to keep your account secure.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Current password
              <input
                type="password"
                value={passwordForm.current_password}
                onChange={(event) => setPasswordForm((current) => ({ ...current, current_password: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-400 focus:outline-none"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              New password
              <input
                type="password"
                value={passwordForm.new_password}
                onChange={(event) => setPasswordForm((current) => ({ ...current, new_password: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-400 focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handlePasswordSave}
              className="rounded-full border border-amber-400 px-5 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/10"
            >
              Update password
            </button>
          </div>
          <Feedback message={passwordFeedback?.message} tone={passwordFeedback?.tone} />
        </Section>

        <Section title="Chat preferences" description="Adjust how Publex notifies you about chat activity.">
          <div className="grid gap-4">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Notification sound
              <select
                value={chatSettings.notification_sound}
                onChange={(event) => setChatSettings((current) => ({ ...current, notification_sound: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-400 focus:outline-none"
              >
                {SOUND_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Notification volume</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={chatSettings.notification_volume}
                onChange={(event) => setChatSettings((current) => ({ ...current, notification_volume: Number(event.target.value) }))}
                className="mt-2 w-full"
              />
              <p className="mt-1 text-xs text-zinc-500">{Math.round(chatSettings.notification_volume * 100)}%</p>
            </div>

            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Notify on</span>
              <div className="mt-2 flex flex-col gap-2">
                {NOTIFY_OPTIONS.map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm text-zinc-200">
                    <input
                      type="radio"
                      name="notify-scope"
                      value={option.id}
                      checked={chatSettings.notify_scope === option.id}
                      onChange={() => setChatSettings((current) => ({ ...current, notify_scope: option.id }))}
                      className="h-4 w-4 text-amber-400 focus:outline-none"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            {selectedSound?.url ? (
              <audio controls className="h-9 max-w-[200px]">
                <source src={selectedSound.url} />
              </audio>
            ) : <span className="text-xs text-zinc-500">No preview available.</span>}
            <button
              type="button"
              onClick={handleChatSave}
              className="rounded-full border border-amber-400 px-5 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/10"
            >
              Save chat preferences
            </button>
          </div>
          <Feedback message={chatFeedback?.message} tone={chatFeedback?.tone} />
        </Section>

        <Section title="Avatar" description="Upload an image to personalize your account.">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 overflow-hidden rounded-full border border-zinc-800 bg-zinc-950">
              {resolveAvatarUrl(user) ? (
                <img
                  src={resolveAvatarUrl(user)}
                  alt="Avatar preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-amber-200">
                  {(user?.username || 'U').charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 text-xs text-zinc-400">
              <label className="flex w-full cursor-pointer items-center justify-center rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-amber-400 hover:text-amber-200">
                Upload avatar
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </label>
              <button
                type="button"
                onClick={handleAvatarDelete}
                disabled={!user?.avatar_url}
                className="rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-rose-500 hover:text-rose-200 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
              >
                Remove avatar
              </button>
              <span>Images are resized automatically. Maximum dimension {AVATAR_MAX_DIMENSION}px.</span>
            </div>
          </div>
          <Feedback message={avatarFeedback?.message} tone={avatarFeedback?.tone} />
        </Section>
      </div>
    </div>
  );
}
