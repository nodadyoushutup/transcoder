import { useEffect, useMemo, useState } from 'react';
import {
  changePassword,
  deleteAvatar,
  fetchPreferences,
  updateChatPreferences,
  updateAppearancePreferences,
  updateProfile,
  uploadAvatar,
} from '../lib/api.js';
import { BACKEND_BASE } from '../lib/env.js';

const SOUND_MODULES = import.meta.glob('../audio/*', {
  eager: true,
  import: 'default',
  query: '?url',
});

const THEME_OPTIONS = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'High contrast styling suited for darker rooms.',
    preview: ['#0f0f0f', '#3f3f46', '#f4f4f5'],
  },
  {
    id: 'light',
    label: 'Light Grey',
    description: 'Soft grey palette designed for daylight viewing.',
    preview: ['#eaeee6', '#c8c3b8', '#26231e'],
  },
  {
    id: 'monokai',
    label: 'Monokai',
    description: 'Vibrant editor theme with neon accents.',
    preview: ['#272822', '#f92672', '#a6e22e'],
  },
  {
    id: 'darcula',
    label: 'Darcula',
    description: 'JetBrains-inspired charcoal with cool blues.',
    preview: ['#2b2b2b', '#6a9fb5', '#ffc66d'],
  },
];

const THEME_ALIASES = {
  monaki: 'monokai',
  dracula: 'darcula',
};

const DEFAULT_THEME = 'dark';

function normalizeTheme(value) {
  if (!value) {
    return DEFAULT_THEME;
  }
  const lower = String(value).toLowerCase();
  const resolved = THEME_ALIASES[lower] || lower;
  return THEME_OPTIONS.some((option) => option.id === resolved) ? resolved : DEFAULT_THEME;
}

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

function Section({ title, description, children, className = '' }) {
  return (
    <section className={`panel-card p-6 ${className}`}>
      <div className="mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {description ? <p className="mt-1 text-xs text-subtle">{description}</p> : null}
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
    info: 'text-info',
    error: 'text-danger',
    success: 'text-success',
  };
  return <p className={`mt-3 text-xs ${toneClasses[tone] || toneClasses.info}`}>{message}</p>;
}

export default function PreferencesPage({
  user,
  onReloadSession,
  initialChatPreferences = null,
  initialAppearance = null,
  onChatPreferencesChange,
  onThemeChange,
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
  const [appearanceSettings, setAppearanceSettings] = useState(() => ({
    theme: normalizeTheme(initialAppearance?.theme),
  }));
  const [appearanceFeedback, setAppearanceFeedback] = useState(null);
  const [appearancePending, setAppearancePending] = useState(false);

  const selectTheme = (value) => {
    const normalized = normalizeTheme(value);
    if (appearanceSettings.theme === normalized || appearancePending) {
      return;
    }
    const previousTheme = appearanceSettings.theme;
    setAppearanceSettings({ theme: normalized });
    onThemeChange?.(normalized);
    setAppearanceFeedback(null);

    if (!user) {
      return;
    }

    setAppearanceFeedback({ tone: 'info', message: 'Saving theme…' });
    setAppearancePending(true);

    (async () => {
      try {
        await updateAppearancePreferences({ theme: normalized });
        setAppearanceFeedback({ tone: 'success', message: 'Theme updated.' });
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : 'Unable to update appearance.';
        setAppearanceFeedback({ tone: 'error', message });
        setAppearanceSettings({ theme: previousTheme });
        onThemeChange?.(previousTheme);
      } finally {
        setAppearancePending(false);
      }
    })();
  };

  useEffect(() => {
    if (!initialAppearance?.theme) {
      return;
    }
    setAppearanceSettings({ theme: normalizeTheme(initialAppearance.theme) });
  }, [initialAppearance?.theme]);

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
        const themeChoiceRaw = String(
          data?.appearance?.settings?.theme
          ?? data?.appearance?.defaults?.theme
          ?? 'dark',
        ).toLowerCase();
        const appearance = {
          theme: normalizeTheme(themeChoiceRaw),
        };
        setProfile(resolvedProfile);
        setChatSettings(chat);
        setAppearanceSettings(appearance);
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
  }, [user, onChatPreferencesChange, onThemeChange]);

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
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Sign in to manage your preferences.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Loading preferences…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col overflow-y-auto px-4 py-6 md:px-10">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Preferences</h1>
        <p className="mt-1 text-sm text-subtle">Manage your account details, password, chat behaviour, and avatar.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Appearance"
          description="Choose how the interface should look."
          className="lg:col-span-2"
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {THEME_OPTIONS.map((option) => {
              const isActive = appearanceSettings.theme === option.id;
              return (
                <label
                  key={option.id}
                  className={`group relative flex h-full cursor-pointer flex-col gap-3 rounded-2xl border px-4 py-3 transition ${
                    isActive ? 'border-accent bg-surface/70 shadow-inner' : 'border-border bg-surface/40 hover:border-accent/80'
                  } ${appearancePending && !isActive ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-foreground">{option.label}</span>
                      <span className="text-xs text-subtle">{option.description}</span>
                    </div>
                    <span className="flex items-center gap-1">
                      {option.preview.map((hex) => (
                        <span
                          key={hex}
                          className="h-4 w-4 rounded-full border border-border/60"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </span>
                  </div>
                  <input
                    type="radio"
                    name="theme-preference"
                    value={option.id}
                    checked={isActive}
                    onChange={() => selectTheme(option.id)}
                    disabled={appearancePending && !isActive}
                    className="sr-only"
                  />
                  <span
                    className={`absolute right-3 top-3 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold transition ${
                      isActive ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-background text-subtle'
                    }`}
                  >
                    {isActive ? '✓' : ''}
                  </span>
                </label>
              );
            })}
          </div>
          <Feedback message={appearanceFeedback?.message} tone={appearanceFeedback?.tone} />
        </Section>

        <Section title="Profile" description="Update your username and email address.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-subtle">
              Username
              <input
                type="text"
                value={profile.username}
                onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-subtle">
              Email
              <input
                type="email"
                value={profile.email}
                onChange={(event) => setProfile((current) => ({ ...current, email: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleProfileSave}
              disabled={savingProfile}
              className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-foreground transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-subtle"
            >
              {savingProfile ? 'Saving…' : 'Save profile'}
            </button>
          </div>
          <Feedback message={profileFeedback?.message} tone={profileFeedback?.tone} />
        </Section>

        <Section title="Password" description="Update your password to keep your account secure.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-subtle">
              Current password
              <input
                type="password"
                value={passwordForm.current_password}
                onChange={(event) => setPasswordForm((current) => ({ ...current, current_password: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
              />
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-subtle">
              New password
              <input
                type="password"
                value={passwordForm.new_password}
                onChange={(event) => setPasswordForm((current) => ({ ...current, new_password: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handlePasswordSave}
              className="rounded-full border border-accent px-5 py-2 text-sm font-semibold text-accent transition hover:bg-accent/10"
            >
              Update password
            </button>
          </div>
          <Feedback message={passwordFeedback?.message} tone={passwordFeedback?.tone} />
        </Section>

        <Section title="Chat preferences" description="Adjust how Publex notifies you about chat activity.">
          <div className="grid gap-4">
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
              Notification sound
              <select
                value={chatSettings.notification_sound}
                onChange={(event) => setChatSettings((current) => ({ ...current, notification_sound: event.target.value }))}
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
              >
                {SOUND_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-subtle">Notification volume</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={chatSettings.notification_volume}
                onChange={(event) => setChatSettings((current) => ({ ...current, notification_volume: Number(event.target.value) }))}
                className="mt-2 w-full"
              />
              <p className="mt-1 text-xs text-subtle">{Math.round(chatSettings.notification_volume * 100)}%</p>
            </div>

            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-subtle">Notify on</span>
              <div className="mt-2 flex flex-col gap-2">
                {NOTIFY_OPTIONS.map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="radio"
                      name="notify-scope"
                      value={option.id}
                      checked={chatSettings.notify_scope === option.id}
                      onChange={() => setChatSettings((current) => ({ ...current, notify_scope: option.id }))}
                      className="h-4 w-4 text-accent focus:outline-none"
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
            ) : <span className="text-xs text-subtle">No preview available.</span>}
            <button
              type="button"
              onClick={handleChatSave}
              className="rounded-full border border-accent px-5 py-2 text-sm font-semibold text-accent transition hover:bg-accent/10"
            >
              Save chat preferences
            </button>
          </div>
          <Feedback message={chatFeedback?.message} tone={chatFeedback?.tone} />
        </Section>

        <Section title="Avatar" description="Upload an image to personalize your account.">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 overflow-hidden rounded-full border border-border bg-background">
              {resolveAvatarUrl(user) ? (
                <img
                  src={resolveAvatarUrl(user)}
                  alt="Avatar preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-accent">
                  {(user?.username || 'U').charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 text-xs text-muted">
              <label className="flex w-full cursor-pointer items-center justify-center rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:border-accent hover:text-accent">
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
                className="rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:border-border/70 disabled:text-subtle"
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
