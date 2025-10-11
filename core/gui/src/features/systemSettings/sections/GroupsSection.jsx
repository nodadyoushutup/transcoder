import { useEffect, useMemo, useState } from 'react';
import { updateGroup } from '../../../lib/api.js';
import {
  DiffButton,
  Feedback,
  SectionContainer,
} from '../shared.jsx';
import { getGroupBadgeStyles, getGroupChipStyles } from '../../../lib/groupColors.js';

const ADMIN_GROUP_SLUG = 'admin';
const GROUP_DISPLAY_ORDER = ['moderator', 'user', 'guest'];

function GroupCard({ group, permissions, onSave }) {
  const [selection, setSelection] = useState(new Set(group.permissions || []));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelection(new Set(group.permissions || []));
  }, [group.permissions]);

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

  const hasChanges = useMemo(() => {
    const current = new Set(group.permissions || []);
    if (current.size !== selection.size) {
      return true;
    }
    for (const value of selection) {
      if (!current.has(value)) {
        return true;
      }
    }
    return false;
  }, [group.permissions, selection]);

  const handleSave = async () => {
    if (!onSave || !hasChanges) {
      return;
    }
    setSaving(true);
    try {
      await onSave(Array.from(selection));
    } finally {
      setSaving(false);
    }
  };

  const badgeStyle = getGroupBadgeStyles(group.slug);

  return (
    <div className="rounded-2xl border border-border bg-background/70 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <span
            className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
            style={badgeStyle}
          >
            {group.name}
          </span>
          <p className="text-xs text-subtle">Slug: {group.slug}</p>
        </div>
        <div className="text-xs text-subtle">Members: {group.member_count ?? 0}</div>
      </div>
      {group.description ? (
        <p className="mt-3 text-sm text-muted">{group.description}</p>
      ) : (
        <p className="mt-3 text-sm italic text-subtle">No description provided.</p>
      )}
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Permissions</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {permissions.map((permission) => (
            <label
              key={permission.name}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted hover:border-outline hover:bg-surface/60"
            >
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
      <div className="mt-4 flex items-center justify-end">
        <DiffButton onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? 'Saving…' : 'Save permissions'}
        </DiffButton>
      </div>
    </div>
  );
}

export default function GroupsSection({ groupsState, setGroupsState }) {
  if (groupsState.loading) {
    return <div className="text-sm text-muted">Loading groups…</div>;
  }

  const visibleGroups = groupsState.items.filter((group) => group.slug !== ADMIN_GROUP_SLUG);
  const orderedGroups = [
    ...GROUP_DISPLAY_ORDER.map((slug) => visibleGroups.find((group) => group.slug === slug)).filter(Boolean),
    ...visibleGroups.filter((group) => !GROUP_DISPLAY_ORDER.includes(group.slug)),
  ];

  const handleSavePermissions = async (group, nextPermissions) => {
    const next = Array.from(new Set(nextPermissions || [])).map((value) => String(value));
    const current = Array.isArray(group.permissions) ? group.permissions : [];
    const sameLength = next.length === current.length;
    const hasSameValues = sameLength && next.every((perm) => current.includes(perm));
    if (hasSameValues) {
      setGroupsState((state) => ({
        ...state,
        feedback: { tone: 'info', message: 'No permission changes to save.' },
      }));
      return;
    }
    setGroupsState((state) => ({
      ...state,
      feedback: { tone: 'info', message: `Saving ${group.name} permissions…` },
    }));
    try {
      const updated = await updateGroup(group.id, { permissions: next });
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
  };

  return (
    <SectionContainer title="Group management">
      {orderedGroups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-background/40 px-4 py-8 text-center text-sm text-muted">
          No editable groups available.
        </div>
      ) : (
        <div className="space-y-4">
          {orderedGroups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              permissions={groupsState.permissions}
              onSave={(nextPermissions) => handleSavePermissions(group, nextPermissions)}
            />
          ))}
        </div>
      )}
      <Feedback message={groupsState.feedback?.message} tone={groupsState.feedback?.tone} />
    </SectionContainer>
  );
}
