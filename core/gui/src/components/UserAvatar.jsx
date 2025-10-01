import { BACKEND_BASE } from '../lib/env.js';

const SIZE_CLASSES = {
  xs: 'h-6 w-6 text-xs',
  sm: 'h-8 w-8 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
};

function getAvatarUrl(user) {
  if (!user?.avatar_url) {
    return null;
  }
  if (user.avatar_url.startsWith('http')) {
    return user.avatar_url;
  }
  return `${BACKEND_BASE}${user.avatar_url}`;
}

function combineClasses(...values) {
  return values.filter(Boolean).join(' ');
}

export default function UserAvatar({ user, size = 'md', className = '' }) {
  const avatarUrl = getAvatarUrl(user);
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const baseClass = combineClasses('rounded-full border border-border/80', sizeClass, className);

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={user?.username || 'Avatar'}
        className={combineClasses(baseClass, 'object-cover')}
      />
    );
  }

  const fallback = (user?.username || 'User').charAt(0).toUpperCase();
  return (
    <span
      className={combineClasses(
        baseClass,
        'flex items-center justify-center bg-surface font-semibold text-accent',
      )}
    >
      {fallback}
    </span>
  );
}
