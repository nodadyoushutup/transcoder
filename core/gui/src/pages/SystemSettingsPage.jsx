import { useEffect, useMemo, useState } from 'react';
import {
  createGroup,
  deleteGroup,
  fetchGroups,
  fetchSystemSettings,
  fetchUsers,
  updateGroup,
  updateSystemSettings,
  updateUserGroups,
} from '../lib/api.js';

const SECTIONS = [
  { id: 'transcoder', label: 'Transcoder' },
  { id: 'users', label: 'Users' },
  { id: 'chat', label: 'Chat' },
];

function SectionContainer({ title, children }) {
  return (
    <section className="rounded-2xl border border-border bg-surface/70 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-4 space-y-4 text-sm text-muted">{children}</div>
    </section>
  );
}

function BooleanField({ label, value, onChange }) {
  return (
    <label className="flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(event) => onChange?.(event.target.checked)}
        className="h-4 w-4 text-amber-400 focus:outline-none"
      />
    </label>
  );
}

function TextField({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
      />
    </label>
  );
}

function DiffButton({ onClick, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-amber-400 px-5 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:border-border disabled:text-subtle"
    >
      {children}
    </button>
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
  return <p className={`text-xs ${toneClasses[tone] || toneClasses.info}`}>{message}</p>;
}

function prepareForm(defaults, current) {
  const merged = { ...defaults, ...current };
  return Object.keys(merged).reduce((acc, key) => {
    acc[key] = merged[key];
    return acc;
  }, {});
}

function computeDiff(original, current) {
  const diff = {};
  Object.keys(current).forEach((key) => {
    if (current[key] !== original[key]) {
      diff[key] = current[key];
    }
  });
  return diff;
}

export default function SystemSettingsPage({ user }) {
  const [activeSection, setActiveSection] = useState('transcoder');
  const [transcoder, setTranscoder] = useState({ loading: true, data: {}, defaults: {}, form: {}, feedback: null });
  const [chat, setChat] = useState({ loading: true, data: {}, defaults: {}, form: {}, feedback: null });
  const [userSettings, setUserSettings] = useState({
    loading: true,
    data: {},
    defaults: {},
    form: {},
    feedback: null,
  });
  const [groupsState, setGroupsState] = useState({ loading: true, items: [], permissions: [], feedback: null });
  const [usersState, setUsersState] = useState({ loading: true, items: [], feedback: null, pending: {} });

  const canAccess = useMemo(() => {
    if (!user) {
      return false;
    }
    if (user.is_admin) {
      return true;
    }
    const permSet = new Set(user.permissions || []);
    return permSet.has('system.settings.manage')
      || permSet.has('transcoder.settings.manage')
      || permSet.has('chat.settings.manage')
      || permSet.has('users.manage');
  }, [user]);

  useEffect(() => {
    if (!canAccess) {
      return;
    }
    let ignore = false;
    async function load() {
      try {
        const [transcoderData, chatData, usersData] = await Promise.all([
          fetchSystemSettings('transcoder'),
          fetchSystemSettings('chat'),
          fetchSystemSettings('users'),
        ]);
        if (ignore) {
          return;
        }
        setTranscoder({
          loading: false,
          data: transcoderData?.settings || {},
          defaults: transcoderData?.defaults || {},
          form: prepareForm(transcoderData?.defaults || {}, transcoderData?.settings || {}),
          feedback: null,
        });
        setChat({
          loading: false,
          data: chatData?.settings || {},
          defaults: chatData?.defaults || {},
          form: prepareForm(chatData?.defaults || {}, chatData?.settings || {}),
          feedback: null,
        });
        setUserSettings({
          loading: false,
          data: usersData?.settings || {},
          defaults: usersData?.defaults || {},
          form: prepareForm(usersData?.defaults || {}, usersData?.settings || {}),
          feedback: null,
        });
        setGroupsState((state) => ({
          ...state,
          loading: false,
          items: usersData?.groups || [],
          permissions: usersData?.permissions || [],
          feedback: null,
        }));
      } catch (exc) {
        if (!ignore) {
          const message = exc instanceof Error ? exc.message : 'Unable to load settings';
          setTranscoder((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setChat((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setUserSettings((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
        }
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, [canAccess]);

  useEffect(() => {
    if (!canAccess) {
      return;
    }
    let ignore = false;
    async function loadUsersAndGroups() {
      try {
        const [groupData, userData] = await Promise.all([fetchGroups(), fetchUsers()]);
        if (ignore) {
          return;
        }
        setGroupsState({
          loading: false,
          items: groupData?.groups || [],
          permissions: groupData?.permissions || [],
          feedback: null,
        });
        setUsersState({
          loading: false,
          items: userData?.users || [],
          feedback: null,
          pending: {},
        });
      } catch (exc) {
        if (!ignore) {
          const message = exc instanceof Error ? exc.message : 'Unable to load user data';
          setGroupsState((state) => ({ ...state, loading: false, feedback: { tone: 'error', message } }));
          setUsersState((state) => ({ ...state, loading: false, feedback: { tone: 'error', message }, pending: {} }));
        }
      }
    }
    void loadUsersAndGroups();
    return () => {
      ignore = true;
    };
  }, [canAccess]);

  if (!canAccess) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        You do not have permission to manage system settings.
      </div>
    );
  }

  const renderTranscoder = () => {
    if (transcoder.loading) {
      return <div className="text-sm text-muted">Loading transcoder settings…</div>;
    }
    const entries = Object.entries(transcoder.form);
    return (
      <SectionContainer title="Transcoder settings">
        <div className="grid gap-4 md:grid-cols-2">
          {entries.map(([key, value]) => {
            const defaultValue = transcoder.defaults[key];
            if (typeof defaultValue === 'boolean' || typeof value === 'boolean') {
              return (
                <BooleanField
                  key={key}
                  label={key}
                  value={Boolean(value)}
                  onChange={(next) => setTranscoder((state) => ({
                    ...state,
                    form: { ...state.form, [key]: next },
                  }))}
                />
              );
            }
            const type = typeof defaultValue === 'number' || typeof value === 'number' ? 'number' : 'text';
            return (
              <TextField
                key={key}
                label={key}
                type={type}
                value={value ?? ''}
                onChange={(next) => setTranscoder((state) => ({
                  ...state,
                  form: { ...state.form, [key]: type === 'number' ? Number(next) : next },
                }))}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Feedback message={transcoder.feedback?.message} tone={transcoder.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(transcoder.data, transcoder.form);
              if (Object.keys(diff).length === 0) {
                setTranscoder((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
                return;
              }
              setTranscoder((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
              try {
                const updated = await updateSystemSettings('transcoder', diff);
                setTranscoder({
                  loading: false,
                  data: updated?.settings || {},
                  defaults: updated?.defaults || transcoder.defaults,
                  form: prepareForm(updated?.defaults || {}, updated?.settings || {}),
                  feedback: { tone: 'success', message: 'Transcoder settings saved.' },
                });
              } catch (exc) {
                setTranscoder((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
                }));
              }
            }}
          >
            Save changes
          </DiffButton>
        </div>
      </SectionContainer>
    );
  };

  const renderChat = () => {
    if (chat.loading) {
      return <div className="text-sm text-muted">Loading chat settings…</div>;
    }
    return (
      <SectionContainer title="Chat settings">
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(chat.form).map(([key, value]) => {
            if (typeof chat.defaults[key] === 'boolean' || typeof value === 'boolean') {
              return (
                <BooleanField
                  key={key}
                  label={key}
                  value={Boolean(value)}
                  onChange={(next) => setChat((state) => ({
                    ...state,
                    form: { ...state.form, [key]: next },
                  }))}
                />
              );
            }
            if (typeof chat.defaults[key] === 'number' || typeof value === 'number') {
              return (
                <TextField
                  key={key}
                  label={key}
                  type="number"
                  value={value}
                  onChange={(next) => setChat((state) => ({
                    ...state,
                    form: { ...state.form, [key]: Number(next) },
                  }))}
                />
              );
            }
            return (
              <TextField
                key={key}
                label={key}
                value={value ?? ''}
                onChange={(next) => setChat((state) => ({
                  ...state,
                  form: { ...state.form, [key]: next },
                }))}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-3">
          <Feedback message={chat.feedback?.message} tone={chat.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(chat.data, chat.form);
              if (Object.keys(diff).length === 0) {
                setChat((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
                return;
              }
              setChat((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
              try {
                const updated = await updateSystemSettings('chat', diff);
                setChat({
                  loading: false,
                  data: updated?.settings || {},
                  defaults: updated?.defaults || chat.defaults,
                  form: prepareForm(updated?.defaults || {}, updated?.settings || {}),
                  feedback: { tone: 'success', message: 'Chat settings saved.' },
                });
              } catch (exc) {
                setChat((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
                }));
              }
            }}
          >
            Save changes
          </DiffButton>
        </div>
      </SectionContainer>
    );
  };

  const renderGroups = () => {
    if (groupsState.loading) {
      return <div className="text-sm text-muted">Loading groups…</div>;
    }
    return (
      <div className="space-y-4">
        {groupsState.items.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            permissions={groupsState.permissions}
            onChange={async (nextGroup) => {
              try {
                const payload = {
                  name: nextGroup.name,
                  description: nextGroup.description,
                  permissions: Array.from(nextGroup.permissions || []),
                };
                const updated = await updateGroup(group.id, payload);
                setGroupsState((state) => ({
                  ...state,
                  items: state.items.map((item) => (item.id === group.id ? updated.group : item)),
                  feedback: { tone: 'success', message: `${updated.group.name} updated.` },
                }));
              } catch (exc) {
                setGroupsState((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update group.' },
                }));
              }
            }}
            onDelete={async () => {
              try {
                await deleteGroup(group.id);
                setGroupsState((state) => ({
                  ...state,
                  items: state.items.filter((item) => item.id !== group.id),
                  feedback: { tone: 'success', message: `${group.name} deleted.` },
                }));
              } catch (exc) {
                setGroupsState((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to delete group.' },
                }));
              }
            }}
          />
        ))}
        <CreateGroupCard
          permissions={groupsState.permissions}
          onCreate={async (payload) => {
            try {
              const created = await createGroup(payload);
              setGroupsState((state) => ({
                ...state,
                items: [...state.items, created.group],
                feedback: { tone: 'success', message: `${created.group.name} created.` },
              }));
            } catch (exc) {
              setGroupsState((state) => ({
                ...state,
                feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to create group.' },
              }));
            }
          }}
        />
        <Feedback message={groupsState.feedback?.message} tone={groupsState.feedback?.tone} />
      </div>
    );
  };

  const renderUsers = () => {
    if (usersState.loading) {
      return <div className="text-sm text-muted">Loading users…</div>;
    }
    return (
      <div className="space-y-4">
        {usersState.items.map((account) => (
          <UserRow
            key={account.id}
            user={account}
            groups={groupsState.items}
            pending={usersState.pending[account.id] || account.groups?.map((group) => group.slug) || []}
            onChange={(slugs) => setUsersState((state) => ({
              ...state,
              pending: { ...state.pending, [account.id]: slugs },
            }))}
            onSave={async (slugs) => {
              try {
                const response = await updateUserGroups(account.id, slugs);
                setUsersState((state) => ({
                  ...state,
                  items: state.items.map((item) => (item.id === account.id ? response.user : item)),
                  pending: { ...state.pending, [account.id]: response.user.groups.map((group) => group.slug) },
                  feedback: { tone: 'success', message: `${response.user.username} updated.` },
                }));
              } catch (exc) {
                setUsersState((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to update user groups.' },
                }));
              }
            }}
          />
        ))}
        <Feedback message={usersState.feedback?.message} tone={usersState.feedback?.tone} />
      </div>
    );
  };

  const renderUserSection = () => {
    if (userSettings.loading) {
      return <div className="text-sm text-muted">Loading user settings…</div>;
    }
    const defaultGroup = userSettings.form.default_group || groupsState.items.find((group) => !group.is_system)?.slug || 'user';
    return (
      <SectionContainer title="User management">
        <BooleanField
          label="Allow registration"
          value={userSettings.form.allow_registration}
          onChange={(next) => setUserSettings((state) => ({
            ...state,
            form: { ...state.form, allow_registration: next },
          }))}
        />
        <label className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Default group
          <select
            value={defaultGroup}
            onChange={(event) => setUserSettings((state) => ({
              ...state,
              form: { ...state.form, default_group: event.target.value },
            }))}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none"
          >
            {groupsState.items.map((group) => (
              <option key={group.slug} value={group.slug}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-end gap-3">
          <Feedback message={userSettings.feedback?.message} tone={userSettings.feedback?.tone} />
          <DiffButton
            onClick={async () => {
              const diff = computeDiff(userSettings.data, userSettings.form);
              if (Object.keys(diff).length === 0) {
                setUserSettings((state) => ({ ...state, feedback: { tone: 'info', message: 'No changes to save.' } }));
                return;
              }
              setUserSettings((state) => ({ ...state, feedback: { tone: 'info', message: 'Saving…' } }));
              try {
                const updated = await updateSystemSettings('users', diff);
                setUserSettings({
                  loading: false,
                  data: updated?.settings || {},
                  defaults: updated?.defaults || userSettings.defaults,
                  form: prepareForm(updated?.defaults || {}, updated?.settings || {}),
                  feedback: { tone: 'success', message: 'User settings saved.' },
                });
              } catch (exc) {
                setUserSettings((state) => ({
                  ...state,
                  feedback: { tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to save settings.' },
                }));
              }
            }}
          >
            Save user settings
          </DiffButton>
        </div>
        <div className="mt-6 space-y-6">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Groups</h3>
            <div className="mt-3 space-y-4">{renderGroups()}</div>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">User access</h3>
            <div className="mt-3 space-y-4">{renderUsers()}</div>
          </div>
        </div>
      </SectionContainer>
    );
  };

  return (
    <div className="flex h-full w-full min-h-0 divide-x divide-border">
      <aside className="hidden w-64 flex-shrink-0 flex-col gap-2 border-r border-border bg-background/60 px-4 py-6 text-sm text-muted md:flex">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActiveSection(section.id)}
            className={`rounded-xl px-4 py-2 text-left transition ${
              activeSection === section.id ? 'bg-amber-500/10 text-amber-200' : 'hover:bg-surface hover:text-foreground'
            }`}
          >
            {section.label}
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-10">
        {activeSection === 'transcoder' ? renderTranscoder() : null}
        {activeSection === 'users' ? renderUserSection() : null}
        {activeSection === 'chat' ? renderChat() : null}
      </div>
    </div>
  );
}

function GroupCard({ group, permissions, onChange, onDelete }) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description || '');
  const [selection, setSelection] = useState(new Set(group.permissions || []));
  useEffect(() => {
    setName(group.name);
    setDescription(group.description || '');
    setSelection(new Set(group.permissions || []));
  }, [group.name, group.description, group.permissions]);
  const togglePermission = (permName) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(permName)) {
        next.delete(permName);
      } else {
        next.add(permName);
      }
      return next;
    });
  };

  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{name}</h4>
          <p className="text-xs text-subtle">{group.slug}</p>
        </div>
        <div className="text-xs text-subtle">Members: {group.member_count ?? 0}</div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Description" value={description} onChange={setDescription} />
      </div>
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Permissions</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {permissions.map((permission) => (
            <label key={permission.name} className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={selection.has(permission.name)}
                onChange={() => togglePermission(permission.name)}
                className="h-4 w-4 text-amber-400 focus:outline-none"
              />
              <span>
                <span className="block text-sm text-foreground">{permission.name}</span>
                <span className="text-[11px] text-subtle">{permission.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {!group.is_system ? (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-full border border-rose-500 px-4 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/10"
          >
            Delete
          </button>
        ) : null}
        <DiffButton
          onClick={() => onChange?.({
            name,
            description,
            permissions: Array.from(selection),
          })}
        >
          Save group
        </DiffButton>
      </div>
    </div>
  );
}

function CreateGroupCard({ permissions, onCreate }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selection, setSelection] = useState(new Set());
  const [feedback, setFeedback] = useState(null);

  const togglePermission = (permName) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(permName)) {
        next.delete(permName);
      } else {
        next.add(permName);
      }
      return next;
    });
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted transition hover:border-accent hover:text-accent"
      >
        Create new group
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <h4 className="text-sm font-semibold text-foreground">Create group</h4>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Description" value={description} onChange={setDescription} />
      </div>
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Permissions</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {permissions.map((permission) => (
            <label key={permission.name} className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={selection.has(permission.name)}
                onChange={() => togglePermission(permission.name)}
                className="h-4 w-4 text-amber-400 focus:outline-none"
              />
              <span>
                <span className="block text-sm text-foreground">{permission.name}</span>
                <span className="text-[11px] text-subtle">{permission.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        <Feedback message={feedback?.message} tone={feedback?.tone} />
        <DiffButton
          onClick={async () => {
            if (!name.trim()) {
              setFeedback({ tone: 'error', message: 'Group name is required.' });
              return;
            }
            try {
              await onCreate?.({
                name,
                description,
                permissions: Array.from(selection),
              });
              setName('');
              setDescription('');
              setSelection(new Set());
              setExpanded(false);
            } catch (exc) {
              setFeedback({ tone: 'error', message: exc instanceof Error ? exc.message : 'Unable to create group.' });
            }
          }}
        >
          Save group
        </DiffButton>
      </div>
    </div>
  );
}

function UserRow({ user, groups, pending, onChange, onSave }) {
  const [saving, setSaving] = useState(false);
  const pendingSet = new Set(pending);
  const handleToggle = (slug) => {
    if (saving || user.is_admin) {
      return;
    }
    const next = new Set(pendingSet);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    onChange?.(Array.from(next));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave?.(pending);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{user.username}</h4>
          <p className="text-xs text-subtle">{user.email}</p>
        </div>
        {user.is_admin ? (
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">Administrator</span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {groups.map((group) => (
          <button
            key={group.slug}
            type="button"
            disabled={user.is_admin && group.slug === 'admin'}
            onClick={() => handleToggle(group.slug)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              pendingSet.has(group.slug)
                ? 'border-amber-400 bg-amber-500/10 text-amber-200'
                : 'border-border text-muted hover:border-accent hover:text-accent'
            } ${user.is_admin && group.slug === 'admin' ? 'cursor-not-allowed opacity-70' : ''}`}
          >
            {group.name}
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <DiffButton onClick={handleSave} disabled={saving || user.is_admin}>
          {saving ? 'Saving…' : 'Save membership'}
        </DiffButton>
      </div>
    </div>
  );
}
