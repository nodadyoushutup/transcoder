import { useEffect, useMemo, useState } from 'react';

export default function EmojiPicker({ emojis, onSelect, onClose, style, className = '' }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query) {
      return emojis.slice(0, 200);
    }
    const lowered = query.toLowerCase();
    return emojis.filter((emoji) => emoji.name.includes(lowered)).slice(0, 200);
  }, [emojis, query]);

  useEffect(() => {
    const listener = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };
    window.addEventListener('keydown', listener);
    return () => {
      window.removeEventListener('keydown', listener);
    };
  }, [onClose]);

  return (
    <div
      style={style}
      className={`z-40 flex w-64 flex-col rounded-2xl border border-zinc-800 bg-zinc-900/95 p-3 shadow-2xl shadow-black/50 ${className}`}
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search emoji"
        className="mb-3 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-zinc-500"
        type="text"
      />
      <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto pr-1">
        {filtered.map((emoji) => (
          <button
            key={emoji.name}
            type="button"
            onClick={() => {
              onSelect?.(emoji);
              onClose?.();
            }}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-xl transition hover:bg-zinc-800"
            title={emoji.colon}
          >
            {emoji.unicode}
          </button>
        ))}
      </div>
    </div>
  );
}

