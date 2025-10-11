export function SectionContainer({ title, children }) {
  return (
    <section className="panel-card p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-4 space-y-4 text-sm text-muted">{children}</div>
    </section>
  );
}

export function BooleanField({ label, value, onChange, disabled = false, helpText }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      <span>{label}</span>
      <span
        className={`flex items-center justify-between rounded-xl border border-border bg-background px-4 py-3 text-sm ${
          disabled ? 'opacity-60 bg-surface-muted' : ''
        }`}
      >
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange?.(event.target.checked)}
          disabled={disabled}
          className="h-4 w-4 text-amber-400 focus:outline-none"
        />
      </span>
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  helpText,
  disabled = false,
  readOnly = false,
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <input
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        disabled={disabled}
        readOnly={readOnly}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
          disabled || readOnly ? 'opacity-60 bg-surface-muted' : ''
        }`}
      />
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

export function SelectField({ label, value, onChange, options, helpText, disabled = false }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <select
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        disabled={disabled}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
          disabled ? 'opacity-60 bg-surface-muted' : ''
        }`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

export function TextAreaField({ label, value, onChange, placeholder, disabled = false, rows = 3, helpText }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      {label}
      <textarea
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        rows={rows}
        disabled={disabled}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
          disabled ? 'opacity-60 bg-surface-muted' : ''
        }`}
      />
      {helpText ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span> : null}
    </label>
  );
}

export function SelectWithCustomField({
  label,
  rawValue,
  options,
  onSelect,
  onCustomChange,
  customType = 'text',
  customPlaceholder,
  helpText,
  customHelpText,
  disabled = false,
}) {
  const normalizedValue = rawValue ?? '';
  const optionValues = options.map((option) => option.value);
  const selection = optionValues.includes(normalizedValue) ? normalizedValue : 'custom';
  const extendedOptions = [...options, { value: 'custom', label: 'Custom…' }];

  return (
    <div className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-subtle">
      <span>{label}</span>
      <select
        value={selection}
        onChange={(event) => onSelect?.(event.target.value)}
        disabled={disabled}
        className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
          disabled ? 'opacity-60 bg-surface-muted' : ''
        }`}
      >
        {extendedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {selection === 'custom'
        ? (
          <input
            type={customType}
            value={normalizedValue}
            placeholder={customPlaceholder}
            onChange={(event) => onCustomChange?.(event.target.value)}
            disabled={disabled}
            className={`w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-amber-400 focus:outline-none ${
              disabled ? 'opacity-60 bg-surface-muted' : ''
            }`}
          />
        )
        : null}
      {selection === 'custom' && customHelpText
        ? <span className="text-[11px] font-normal text-muted normal-case">{customHelpText}</span>
        : null}
      {selection !== 'custom' && helpText
        ? <span className="text-[11px] font-normal text-muted normal-case">{helpText}</span>
        : null}
    </div>
  );
}

export function DiffButton({ onClick, disabled, children }) {
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

export function Feedback({ message, tone = 'info' }) {
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

export function prepareForm(defaults, current) {
  const merged = { ...defaults, ...current };
  return Object.keys(merged).reduce((acc, key) => {
    acc[key] = merged[key];
    return acc;
  }, {});
}

export function computeDiff(original, current) {
  const diff = {};
  Object.keys(current).forEach((key) => {
    if (current[key] !== original[key]) {
      diff[key] = current[key];
    }
  });
  return diff;
}

export function summarizeArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return '';
  }
  const json = JSON.stringify(args);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}

export function summarizeKwargs(kwargs) {
  if (!kwargs || typeof kwargs !== 'object') {
    return '';
  }
  const entries = Object.entries(kwargs);
  if (!entries.length) {
    return '';
  }
  const json = JSON.stringify(kwargs);
  return json.length > 60 ? `${json.slice(0, 57)}…` : json;
}
