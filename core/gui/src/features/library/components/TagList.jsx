export default function TagList({ title, items }) {
  if (!items?.length) {
    return null;
  }
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h4>
      <div className="flex flex-wrap gap-2">
        {items.map((tag) => {
          const key = tag.id ?? tag.tag ?? tag.title;
          const label = tag.title ?? tag.tag;
          if (!label) {
            return null;
          }
          return (
            <span
              key={key}
              className="rounded-full border border-border/40 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground/80 shadow-sm"
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
