import { useMemo, useState } from 'react';
import {
  BooleanField,
  DiffButton,
  Feedback,
  SectionContainer,
  TextField,
  computeDiff,
  prepareForm,
} from '../shared.jsx';
import { updateSystemSettings, updateUserGroups } from '../../../lib/api.js';
import { getGroupChipStyles, getGroupBadgeStyles } from '../../../lib/groupColors.js';

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
          <span
            className="rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
            style={getGroupBadgeStyles('admin')}
          >
            Administrator
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {groups.map((group) => (
          <button
            key={group.slug}
            type="button"
            disabled={user.is_admin && group.slug === 'admin'}
            onClick={() => handleToggle(group.slug)}
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition text-muted ${
              user.is_admin && group.slug === 'admin' ? 'cursor-not-allowed opacity-70' : 'hover:shadow-sm'
            }`}
            style={getGroupChipStyles(group.slug, { active: pendingSet.has(group.slug) })}
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

export default function UsersSection({
  userSettings,
  setUserSettings,
  usersState,
  setUsersState,
  groupsState,
  userFilter,
  setUserFilter,
}) {
  if (userSettings.loading) {
    return <div className="text-sm text-muted">Loading user settings…</div>;
  }

  const filteredUsers = useMemo(() => {
    const query = userFilter.trim().toLowerCase();
    if (!query) {
      return usersState.items;
    }
    return usersState.items.filter((account) => {
      const username = String(account?.username ?? '').toLowerCase();
      const email = String(account?.email ?? '').toLowerCase();
      return username.includes(query) || email.includes(query);
    });
  }, [userFilter, usersState.items]);

  const defaultGroup = userSettings.form.default_group
    || groupsState.items.find((group) => !group.is_system)?.slug
    || 'user';

  const handleSaveSettings = async () => {
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
  };

  const handleMembershipSave = async (account, slugs) => {
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
  };

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
        <DiffButton onClick={handleSaveSettings}>
          Save user settings
        </DiffButton>
      </div>

      <div className="mt-6 space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">User access</h3>
          <div className="md:w-72">
            <TextField
              label="Filter users"
              value={userFilter}
              placeholder="Search by username or email"
              onChange={(value) => setUserFilter(value)}
            />
          </div>
        </div>
        <div>
          {usersState.loading ? (
            <div className="text-sm text-muted">Loading users…</div>
          ) : (
            <div className="space-y-4">
              {filteredUsers.length ? (
                filteredUsers.map((account) => (
                  <UserRow
                    key={account.id}
                    user={account}
                    groups={groupsState.items}
                    pending={usersState.pending[account.id] || account.groups?.map((group) => group.slug) || []}
                    onChange={(slugs) => setUsersState((state) => ({
                      ...state,
                      pending: { ...state.pending, [account.id]: slugs },
                    }))}
                    onSave={(slugs) => handleMembershipSave(account, slugs)}
                  />
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border bg-background/40 px-4 py-8 text-center text-sm text-muted">
                  No users match your filter.
                </div>
              )}
            </div>
          )}
        </div>
        <Feedback message={usersState.feedback?.message} tone={usersState.feedback?.tone} />
      </div>
    </SectionContainer>
  );
}
