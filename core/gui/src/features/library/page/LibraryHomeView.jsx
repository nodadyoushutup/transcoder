import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import HomeSectionBlock from '../components/HomeSectionBlock.jsx';

export default function LibraryHomeView({
  sections,
  loading,
  error,
  onSelectItem,
  onBrowseSection,
}) {
  const hasSections = Array.isArray(sections) && sections.length > 0;

  return (
    <div className="flex flex-1 overflow-y-auto px-6 py-6">
      <div className="flex w-full flex-col gap-6">
        {error ? (
          <div className="rounded-lg border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {loading && !hasSections ? (
          <div className="flex h-full min-h-[40vh] items-center justify-center text-muted">
            <FontAwesomeIcon icon={faCircleNotch} spin size="2x" />
          </div>
        ) : null}

        {!loading && !hasSections ? (
          <div className="flex h-full min-h-[40vh] flex-col items-center justify-center text-center text-sm text-muted">
            <FontAwesomeIcon icon={faCircleInfo} className="mb-3 text-lg text-subtle" />
            <p>No recent activity yet.</p>
          </div>
        ) : null}

        {sections.map((section) => (
          <HomeSectionBlock
            key={section.id ?? section.title}
            section={section}
            onSelectItem={onSelectItem}
            onBrowseSection={onBrowseSection}
          />
        ))}

        {loading && hasSections ? (
          <div className="flex items-center justify-center gap-2 text-xs text-muted">
            <FontAwesomeIcon icon={faCircleNotch} spin />
            Refreshing…
          </div>
        ) : null}
      </div>
    </div>
  );
}
