import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleNotch, faMagnifyingGlass, faHouse } from '@fortawesome/free-solid-svg-icons';
import { normalizeKey, typeIcon } from '../utils.js';

export default function LibrarySidebar({
  sections,
  sectionsLoading,
  sectionsError,
  isHomeView,
  isGlobalSearching,
  activeSectionId,
  globalSearchInput,
  onGlobalSearchInput,
  globalSearchLoading,
  onSelectHome,
  onSelectSection,
}) {
  const handleSearchChange = (event) => {
    onGlobalSearchInput?.(event.target.value);
  };

  return (
    <aside className="flex w-64 flex-col border-r border-border/80 bg-surface/80">
      <header className="flex min-h-[56px] items-center border-b border-border/60 px-4 py-3">
        <div className="flex w-full items-center gap-3">
          <div className="flex flex-1 items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1 text-sm text-muted focus-within:border-accent">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs text-subtle" />
            <input
              type="search"
              value={globalSearchInput}
              onChange={handleSearchChange}
              placeholder=""
              className="w-full bg-transparent text-sm text-foreground outline-none"
              aria-label="Search all libraries"
            />
            {globalSearchLoading ? (
              <FontAwesomeIcon icon={faCircleNotch} spin className="text-xs text-muted" />
            ) : null}
          </div>
          {sectionsLoading ? <FontAwesomeIcon icon={faCircleNotch} spin className="text-muted" /> : null}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {sectionsError ? (
          <div className="rounded-lg border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger">{sectionsError}</div>
        ) : null}
        {!sectionsLoading && !sections.length ? (
          <div className="rounded-lg border border-border/60 bg-surface px-3 py-2 text-xs text-muted">No libraries available.</div>
        ) : null}
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              onClick={onSelectHome}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                isHomeView
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border/70 bg-surface/70 text-muted hover:border-accent/60 hover:text-foreground'
              }`}
            >
              <FontAwesomeIcon icon={faHouse} className="h-4 w-4 shrink-0" />
              <span className="truncate text-sm font-semibold">Home</span>
            </button>
          </li>
          <li aria-hidden="true" className="mx-3 my-6 h-px bg-border/60" />
          {sections.map((section) => {
            const key = normalizeKey(section);
            const isActive = !isHomeView && !isGlobalSearching && key === activeSectionId;
            return (
              <li key={key ?? section.title}>
                <button
                  type="button"
                  onClick={() => onSelectSection?.(key)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                    isActive
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border/70 bg-surface/70 text-muted hover:border-accent/60 hover:text-foreground'
                  }`}
                >
                  <FontAwesomeIcon icon={typeIcon(section.type)} className="h-4 w-4 shrink-0" />
                  <span className="truncate text-sm font-semibold">{section.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
