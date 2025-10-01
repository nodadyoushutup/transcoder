const GROUP_COLOR_TOKENS = {
  admin: { base: '--group-color-admin', foreground: '--group-color-admin-foreground' },
  moderator: { base: '--group-color-moderator', foreground: '--group-color-moderator-foreground' },
  user: { base: '--group-color-user', foreground: '--group-color-user-foreground' },
  guest: { base: '--group-color-guest', foreground: '--group-color-guest-foreground' },
};

function toCssColor(token) {
  return token ? `rgb(var(${token}) / 1)` : null;
}

export function getGroupColorTokens(slug) {
  if (!slug) {
    return null;
  }
  return GROUP_COLOR_TOKENS[String(slug).toLowerCase()] || null;
}

export function getGroupColor(slug) {
  const tokens = getGroupColorTokens(slug);
  return tokens ? toCssColor(tokens.base) : null;
}

export function getGroupForegroundColor(slug) {
  const tokens = getGroupColorTokens(slug);
  return tokens ? toCssColor(tokens.foreground) : null;
}

export function getGroupTextColor(slug) {
  return getGroupColor(slug);
}

export function getGroupBadgeStyles(slug) {
  const color = getGroupColor(slug);
  if (!color) {
    return {};
  }
  const foreground = getGroupForegroundColor(slug) || 'rgb(var(--color-background) / 1)';
  return {
    backgroundColor: color,
    borderColor: color,
    color: foreground,
  };
}

export function getGroupChipStyles(slug, { active = false } = {}) {
  const color = getGroupColor(slug);
  if (!color) {
    return {};
  }
  if (active) {
    const foreground = getGroupForegroundColor(slug) || 'rgb(var(--color-background) / 1)';
    return {
      backgroundColor: color,
      borderColor: color,
      color: foreground,
    };
  }
  return {
    borderColor: color,
    color,
  };
}

export const KNOWN_GROUP_SLUGS = Object.freeze(Object.keys(GROUP_COLOR_TOKENS));
