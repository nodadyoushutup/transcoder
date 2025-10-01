/** @type {import('tailwindcss').Config} */
const withOpacityValue = (variable) => {
  return ({ opacityValue }) => {
    if (opacityValue !== undefined) {
      return `rgb(var(${variable}) / ${opacityValue})`;
    }
    return `rgb(var(${variable}) / 1)`;
  };
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: withOpacityValue('--color-background'),
        surface: withOpacityValue('--color-surface'),
        'surface-muted': withOpacityValue('--color-surface-muted'),
        border: withOpacityValue('--color-border'),
        outline: withOpacityValue('--color-outline'),
        overlay: withOpacityValue('--color-overlay'),
        foreground: withOpacityValue('--color-foreground'),
        muted: withOpacityValue('--color-muted-foreground'),
        subtle: withOpacityValue('--color-subtle-foreground'),
        accent: withOpacityValue('--color-accent'),
        'accent-foreground': withOpacityValue('--color-accent-foreground'),
        success: withOpacityValue('--color-success'),
        'success-foreground': withOpacityValue('--color-success-foreground'),
        warning: withOpacityValue('--color-warning'),
        'warning-foreground': withOpacityValue('--color-warning-foreground'),
        danger: withOpacityValue('--color-danger'),
        'danger-foreground': withOpacityValue('--color-danger-foreground'),
        info: withOpacityValue('--color-info'),
        'info-foreground': withOpacityValue('--color-info-foreground'),
      },
      ringColor: {
        DEFAULT: withOpacityValue('--color-ring'),
      },
    },
  },
  plugins: [],
};
