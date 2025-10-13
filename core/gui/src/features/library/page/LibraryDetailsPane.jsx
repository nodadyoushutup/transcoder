import { useMemo } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faCircleNotch } from '@fortawesome/free-solid-svg-icons';
import StatList from '../components/StatList.jsx';
import TagList from '../components/TagList.jsx';
import ChildList from '../components/ChildList.jsx';
import RelatedGroup from '../components/RelatedGroup.jsx';
import PeopleCarousel from '../components/PeopleCarousel.jsx';
import {
  childGroupLabel,
  detectRatingProvider,
  ensureArray,
  filterStatEntries,
  formatBitrate,
  formatChannelLayout,
  formatCount,
  formatDate,
  formatFileSize,
  formatFrameRate,
  formatProviderRating,
  formatRuntime,
  imageByType,
  resolveImageUrl,
  resolveRatingIcon,
  streamTypeValue,
  PROVIDER_LABELS,
} from '../utils.js';

export default function LibraryDetailsPane({
  selectedItem,
  detailsState,
  detailTab,
  onDetailTabChange,
  onClose,
  onSelectItem,
  onPlayChild,
  playPending,
  playError,
}) {
  const {
    heroImage,
    posterImage,
    heroFallbackStyle,
    ratingBadges,
    directorNames,
    detailStats,
    timelineStats,
    tagGroups,
    identifierChips,
    mediaItems,
    children,
    relatedHubs,
    crewPeople,
  } = useMemo(() => {
    const details = detailsState?.data ?? {};
    const mediaItems = Array.isArray(details.media) ? details.media : [];
    const detailImages = Array.isArray(details.images) ? details.images : [];
    const ratingEntries = Array.isArray(details.ratings) ? details.ratings : [];
    const guidEntries = Array.isArray(details.guids) ? details.guids : [];
    const ultraBlur = details.ultra_blur ?? null;

    const preferredBackdrop =
      imageByType(detailImages, 'background') ??
      imageByType(detailImages, 'art') ??
      imageByType(detailImages, 'fanart');
    const heroBackdrop = preferredBackdrop
      ? resolveImageUrl(preferredBackdrop.url, { width: 1920, height: 1080, min: 1, upscale: 1, blur: 200 })
      : selectedItem
        ? resolveImageUrl(selectedItem.art, { width: 1920, height: 1080, min: 1, upscale: 1, blur: 200 })
        : null;
    const fallbackBackdrop = selectedItem
      ? resolveImageUrl(selectedItem.grandparent_thumb ?? selectedItem.thumb, {
          width: 1920,
          height: 1080,
          min: 1,
          upscale: 1,
          blur: 120,
        })
      : null;
    const heroImage = heroBackdrop ?? fallbackBackdrop;

    const preferredPoster =
      imageByType(detailImages, 'coverposter') ??
      imageByType(detailImages, 'coverart') ??
      imageByType(detailImages, 'poster');
    const posterImage = preferredPoster
      ? resolveImageUrl(preferredPoster.url, { width: 600, height: 900, min: 1, upscale: 1 })
      : selectedItem
        ? resolveImageUrl(selectedItem.thumb, { width: 600, height: 900, min: 1, upscale: 1 })
        : null;

    const heroFallbackStyle = ultraBlur
      ? {
          background: `linear-gradient(135deg, #${(ultraBlur.top_left ?? '202020').replace('#', '')} 0%, #${(ultraBlur.top_right ?? ultraBlur.top_left ?? '292929').replace('#', '')} 35%, #${(ultraBlur.bottom_right ?? ultraBlur.bottom_left ?? '1a1a1a').replace('#', '')} 100%)`,
        }
      : undefined;

    const runtimeLabel = selectedItem ? formatRuntime(selectedItem.duration) : null;
    const addedDate = selectedItem ? formatDate(selectedItem.added_at) : null;
    const updatedDate = selectedItem ? formatDate(selectedItem.updated_at) : null;
    const lastViewedDate = selectedItem ? formatDate(selectedItem.last_viewed_at) : null;
    const releaseDate = selectedItem ? formatDate(selectedItem.originally_available_at) : null;
    const viewCount = selectedItem ? formatCount(selectedItem.view_count) : null;

    const ratingBadgeMap = new Map();
    const addRatingBadge = (key, { label, provider, variant, image, type, rawValue }) => {
      const displayValue = formatProviderRating(rawValue, provider);
      if (!displayValue) {
        return;
      }
      const normalizedKey = key ?? label ?? displayValue;
      if (ratingBadgeMap.has(normalizedKey)) {
        return;
      }
      ratingBadgeMap.set(normalizedKey, {
        key: normalizedKey,
        label,
        value: displayValue,
        icon: resolveRatingIcon({ provider, image, variant, type }),
      });
    };

    ratingEntries.forEach((entry, index) => {
      const providerInfo = detectRatingProvider(entry);
      const providerLabel = providerInfo.provider ? PROVIDER_LABELS[providerInfo.provider] : 'Rating';
      const typeLabelValue = entry.type ? String(entry.type).replaceAll('_', ' ') : null;
      const badgeLabel = typeLabelValue ? `${providerLabel} ${typeLabelValue}` : providerLabel;
      const badgeKey = providerInfo.provider
        ? `${providerInfo.provider}-${providerInfo.variant ?? typeLabelValue ?? index}`
        : `external-${index}`;
      addRatingBadge(badgeKey, {
        label: badgeLabel,
        provider: providerInfo.provider,
        variant: providerInfo.variant,
        image: entry.image,
        type: entry.type,
        rawValue: entry.value,
      });
    });

    const ratingBadges = Array.from(ratingBadgeMap.values());
    const directorNames = (selectedItem?.directors ?? [])
      .map((person) => person.title ?? person.tag)
      .filter(Boolean);

    const coreStatEntries = [
      { label: 'Content Rating', value: selectedItem?.content_rating },
      { label: 'Studio', value: selectedItem?.studio },
      { label: 'Runtime', value: runtimeLabel },
      { label: 'Library', value: selectedItem?.library_section_title },
      { label: 'View Count', value: viewCount },
    ];

    const timelineStatEntries = [
      { label: 'Released', value: releaseDate },
      { label: 'Added', value: addedDate },
      { label: 'Last Viewed', value: lastViewedDate },
      { label: 'Updated', value: updatedDate },
    ];

    const tagGroups = [
      { title: 'Genres', items: selectedItem?.genres },
      { title: 'Collections', items: selectedItem?.collections },
      { title: 'Labels', items: selectedItem?.labels },
      { title: 'Moods', items: selectedItem?.moods },
      { title: 'Countries', items: selectedItem?.countries },
    ].filter((group) => group.items?.length);

    const identifierChips = guidEntries
      .map((guid) => {
        if (!guid?.id) {
          return null;
        }
        const [scheme, rawValue] = String(guid.id).split('://');
        const label = scheme ? scheme.toUpperCase() : 'ID';
        const value = rawValue ?? guid.id;
        return { label, value };
      })
      .filter((chip) => chip?.value);

    const detailStats = filterStatEntries(coreStatEntries);
    const timelineStats = filterStatEntries(timelineStatEntries);

    const children = details.children ?? {};
    const relatedHubs = Array.isArray(details.related) ? details.related : [];

    const crewMap = new Map();
    const addPeople = (list, roleLabel) => {
      (list ?? []).forEach((person) => {
        const key = person.id ?? person.tag ?? person.title;
        if (!key) {
          return;
        }
        const name = person.title ?? person.tag ?? 'Unknown';
        const entry = crewMap.get(key);
        if (entry) {
          if (roleLabel && !entry.roles.includes(roleLabel)) {
            entry.roles.push(roleLabel);
          }
          if (!entry.thumb && person.thumb) {
            entry.thumb = person.thumb;
          }
        } else {
          crewMap.set(key, {
            id: person.id ?? key,
            tag: name,
            title: name,
            thumb: person.thumb,
            roles: roleLabel ? [roleLabel] : [],
          });
        }
      });
    };

    addPeople(selectedItem?.directors, 'Director');
    addPeople(selectedItem?.writers, 'Writer');
    addPeople(selectedItem?.producers, 'Producer');

    const crewPeople = Array.from(crewMap.values()).map((person) => ({
      ...person,
      role: person.roles.join(', '),
    }));

    return {
      heroImage,
      posterImage,
      heroFallbackStyle,
      ratingBadges,
      directorNames,
      detailStats,
      timelineStats,
      tagGroups,
      identifierChips,
      mediaItems,
      children,
      relatedHubs,
      crewPeople,
    };
  }, [detailsState?.data, selectedItem]);

  if (!selectedItem) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted">Select an item to view details.</div>;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">
        <section className="relative isolate overflow-hidden bg-background">
          <div className="absolute inset-0">
            {heroImage ? (
              <img src={heroImage} alt="" className="h-full w-full object-cover object-center" loading="lazy" />
            ) : (
              <div
                className="h-full w-full bg-gradient-to-br from-border/30 via-background to-background"
                style={heroFallbackStyle}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-b from-background/30 via-background/80 to-background" />
            <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />
          </div>
          <div className="relative z-10 px-4 pt-3 pb-20 sm:px-6 md:px-10 lg:px-14">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-2 rounded-full bg-background/70 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-subtle transition hover:text-foreground"
              >
                <FontAwesomeIcon icon={faChevronLeft} />
                Back
              </button>
              {/** Play button handled in header for detail view */}
            </div>

            <div className="mt-2 grid gap-8 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] lg:items-start">
              <div className="order-2 flex flex-col gap-4 lg:order-1 lg:-mt-12 lg:sticky lg:top-14 lg:self-start">
                <div className="overflow-hidden rounded-3xl border border-border/40 bg-border/30 shadow-2xl">
                  {posterImage ? (
                    <img
                      src={posterImage}
                      alt={selectedItem.title ?? 'Poster'}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center px-6 py-12 text-center text-xs font-semibold uppercase tracking-wide text-muted">
                      No artwork available
                    </div>
                  )}
                </div>
              </div>
              <div className="order-1 flex-1 space-y-8 text-foreground lg:order-2 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-4 lg:pb-16">
                <div className="space-y-4">
                  <h1 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
                    {selectedItem.title ?? 'Untitled'}
                  </h1>
                  {directorNames.length ? (
                    <p className="text-sm font-semibold text-foreground/80">Directed by {directorNames.join(', ')}</p>
                  ) : null}
                  {ratingBadges.length ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {ratingBadges.map((entry) => (
                        <span
                          key={entry.key ?? entry.label}
                          className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-background/80 px-3 py-1 text-xs font-semibold text-foreground/80 shadow-sm"
                          title={entry.label ?? entry.value}
                        >
                          {entry.icon ? (
                            <img src={entry.icon.src} alt={entry.icon.alt} className="h-4 w-4 object-contain" loading="lazy" />
                          ) : null}
                          <span>{entry.value}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {selectedItem.tagline ? (
                    <p className="text-lg font-medium text-foreground/90">{selectedItem.tagline}</p>
                  ) : null}
                  {selectedItem.summary ? (
                    <p className="max-w-3xl text-sm leading-relaxed text-muted">{selectedItem.summary}</p>
                  ) : null}
                </div>

                {playError ? (
                  <div className="rounded-2xl border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {playError}
                  </div>
                ) : null}

                <div className="rounded-2xl border border-border/30 bg-background/60 shadow-lg backdrop-blur-sm">
                  <div className="flex items-center gap-2 border-b border-border/30 bg-background/40 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onDetailTabChange?.('metadata')}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                        detailTab === 'metadata' ? 'bg-accent text-accent-foreground shadow' : 'bg-background/40 text-muted hover:text-foreground'
                      }`}
                    >
                      Metadata
                    </button>
                    <button
                      type="button"
                      onClick={() => onDetailTabChange?.('media')}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                        detailTab === 'media' ? 'bg-accent text-accent-foreground shadow' : 'bg-background/40 text-muted hover:text-foreground'
                      }`}
                    >
                      Media
                    </button>
                  </div>
                  <div className="p-5">
                    {detailTab === 'metadata' ? (
                      <div className="space-y-6">
                        <div className="grid gap-6 lg:grid-cols-2">
                          {detailStats.length ? (
                            <div className="space-y-3">
                              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Details</h4>
                              <StatList items={detailStats} />
                            </div>
                          ) : null}
                          {timelineStats.length ? (
                            <div className="space-y-3">
                              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Timeline</h4>
                              <StatList items={timelineStats} />
                            </div>
                          ) : null}
                        </div>
                        {tagGroups.length ? (
                          <div className="space-y-4 pt-2">
                            {tagGroups.map((group) => (
                              <TagList key={group.title} title={group.title} items={group.items} />
                            ))}
                          </div>
                        ) : null}
                        {identifierChips.length ? (
                          <div className="space-y-3">
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Identifiers</h4>
                            <div className="flex flex-wrap gap-2">
                              {identifierChips.map((chip) => (
                                <span
                                  key={`${chip.label}-${chip.value}`}
                                  className="rounded-full border border-border/40 bg-background/70 px-3 py-1 text-xs font-semibold text-foreground/80 shadow-sm"
                                >
                                  {chip.label}: {chip.value}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : mediaItems.length ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-subtle">
                          <span>
                            {mediaItems.length} {mediaItems.length === 1 ? 'Version' : 'Versions'}
                          </span>
                        </div>
                        {mediaItems.map((medium, index) => {
                          const versionLabel = medium.video_resolution ? `${medium.video_resolution}p` : `Version ${index + 1}`;
                          const dimensions = medium.width && medium.height ? `${medium.width}×${medium.height}` : null;
                          const bitrate = formatBitrate(medium.bitrate);
                          const aspectRatio = medium.aspect_ratio ? `AR ${medium.aspect_ratio}` : null;
                          const audioCodec = medium.audio_codec ? medium.audio_codec.toUpperCase() : null;
                          const videoCodec = medium.video_codec ? medium.video_codec.toUpperCase() : null;
                          const container = medium.container ? medium.container.toUpperCase() : null;
                          const parts = medium.parts ?? [];
                          return (
                            <div
                              key={medium.id ?? `${medium.video_resolution ?? 'version'}-${index}`}
                              className="space-y-4 rounded-xl border border-border/30 bg-background/70 px-4 py-4"
                            >
                              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                                <span className="rounded-full bg-background/80 px-3 py-1 text-foreground">
                                  {versionLabel}
                                </span>
                                {dimensions ? (
                                  <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                                    {dimensions}
                                  </span>
                                ) : null}
                                {videoCodec ? (
                                  <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                                    {videoCodec}
                                  </span>
                                ) : null}
                                {audioCodec ? (
                                  <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                                    {audioCodec}
                                  </span>
                                ) : null}
                                {bitrate ? (
                                  <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                                    {bitrate}
                                  </span>
                                ) : null}
                                {aspectRatio ? (
                                  <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                                    {aspectRatio}
                                  </span>
                                ) : null}
                                {container ? (
                                  <span className="rounded-full border border-border/40 bg-background/80 px-2 py-0.5 text-[11px] text-subtle">
                                    {container}
                                  </span>
                                ) : null}
                              </div>
                              {parts.map((part, partIndex) => {
                                const partId = part.id ?? part.key ?? partIndex;
                                const partSize = formatFileSize(part.size);
                                const partDuration = formatRuntime(part.duration);
                                const partStreams = ensureArray(part.streams ?? part.Stream);
                                const videoStreams = partStreams.filter((stream) => streamTypeValue(stream) === 1);
                                const audioStreams = partStreams.filter((stream) => streamTypeValue(stream) === 2);
                                const subtitleStreams = partStreams.filter((stream) => streamTypeValue(stream) === 3);
                                return (
                                  <div
                                    key={partId}
                                    className="space-y-4 rounded-xl border border-border/20 bg-background px-3 py-3 text-sm text-muted"
                                  >
                                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                                      <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                                        Part {partIndex + 1}
                                      </span>
                                      {partSize ? (
                                        <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                                          {partSize}
                                        </span>
                                      ) : null}
                                      {partDuration ? (
                                        <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                                          {partDuration}
                                        </span>
                                      ) : null}
                                      {part.container ? (
                                        <span className="rounded-full border border-border/30 bg-background px-2 py-0.5 text-[11px] text-subtle">
                                          {part.container.toUpperCase?.() ?? part.container}
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                      <div className="space-y-2">
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Video</p>
                                        {videoStreams.length ? (
                                          <div className="space-y-1">
                                            {videoStreams.map((stream) => {
                                              const pieces = [
                                                stream.display_title || stream.title,
                                                stream.codec ? stream.codec.toUpperCase() : null,
                                                stream.profile ? `Profile ${stream.profile}` : null,
                                                stream.width && stream.height ? `${stream.width}×${stream.height}` : null,
                                                stream.frame_rate ? formatFrameRate(stream.frame_rate) : null,
                                                stream.bitrate ? formatBitrate(stream.bitrate) : null,
                                              ].filter(Boolean);
                                              const key = stream.id ?? `${partId}-video-${stream.index}`;
                                              return (
                                                <div
                                                  key={key}
                                                  className="rounded-lg border border-border/30 bg-background px-3 py-1 text-xs text-foreground/80"
                                                >
                                                  {pieces.join(' • ')}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        ) : (
                                          <p className="text-xs text-muted">No video streams</p>
                                        )}
                                      </div>
                                      <div className="space-y-4">
                                        <div className="space-y-2">
                                          <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Audio</p>
                                          {audioStreams.length ? (
                                            <div className="space-y-1">
                                              {audioStreams.map((stream) => {
                                                const pieces = [
                                                  stream.display_title || stream.title,
                                                  stream.language,
                                                  stream.codec ? stream.codec.toUpperCase() : null,
                                                  formatChannelLayout(stream.channels),
                                                  stream.bitrate ? formatBitrate(stream.bitrate) : null,
                                                ].filter(Boolean);
                                                const key = stream.id ?? `${partId}-audio-${stream.index}`;
                                                return (
                                                  <div
                                                    key={key}
                                                    className="rounded-lg border border-border/30 bg-background px-3 py-1 text-xs text-foreground/80"
                                                  >
                                                    {pieces.join(' • ')}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          ) : (
                                            <p className="text-xs text-muted">No audio streams</p>
                                          )}
                                        </div>
                                        <div className="space-y-2">
                                          <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Subtitles</p>
                                          {subtitleStreams.length ? (
                                            <div className="space-y-1">
                                              {subtitleStreams.map((stream) => {
                                                const pieces = [
                                                  stream.display_title || stream.title,
                                                  stream.language,
                                                  stream.codec ? stream.codec.toUpperCase() : null,
                                                ].filter(Boolean);
                                                const key = stream.id ?? `${partId}-sub-${stream.index}`;
                                                return (
                                                  <div
                                                    key={key}
                                                    className="rounded-lg border border-border/30 bg-background px-3 py-1 text-xs text-foreground/80"
                                                  >
                                                    {pieces.join(' • ')}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          ) : (
                                            <p className="text-xs text-muted">No subtitle streams</p>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted">No media details available.</p>
                    )}
                  </div>
                </div>

                {selectedItem?.actors?.length ? (
                  <PeopleCarousel title="Cast" people={selectedItem.actors} fallbackRole="Cast" />
                ) : null}

                {crewPeople.length ? <PeopleCarousel title="Crew" people={crewPeople} fallbackRole="Crew" /> : null}

                {relatedHubs.length ? (
                  <div className="space-y-8">
                    {relatedHubs.map((hub, index) => {
                      const hubKey = hub.hub_identifier ?? hub.key ?? `${hub.title ?? 'related'}-${index}`;
                      return <RelatedGroup key={hubKey} hub={hub} onSelect={onSelectItem} />;
                    })}
                  </div>
                ) : null}

                {detailsState.loading ? (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <FontAwesomeIcon icon={faCircleNotch} spin />
                    Loading detailed metadata…
                  </div>
                ) : null}

                {detailsState.error ? (
                  <div className="rounded-2xl border border-danger/60 bg-danger/10 px-4 py-3 text-sm text-danger">
                    {detailsState.error}
                  </div>
                ) : null}

                {Object.entries(children).map(([key, list]) => (
                  <ChildList
                    key={key}
                    label={childGroupLabel(key)}
                    items={list}
                    onSelect={onSelectItem}
                    onPlay={onPlayChild}
                    playPending={playPending}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
