import { filterStatEntries } from '../utils.js';

export default function StatList({ items }) {
  const filtered = filterStatEntries(items);
  if (!filtered.length) {
    return null;
  }
  return (
    <div className="space-y-2">
      {filtered.map((entry) => (
        <div
          key={entry.label}
          className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/80 px-3 py-2 text-sm"
        >
          <span className="text-[11px] uppercase tracking-wide text-subtle">{entry.label}</span>
          <span className="font-semibold tracking-tight text-foreground">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}
