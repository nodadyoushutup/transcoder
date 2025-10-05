import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faVolumeXmark, faVolumeLow, faVolumeHigh, faClosedCaptioning, faExpand, faCompress } from '@fortawesome/free-solid-svg-icons';

function volumeIcon(volume, isMuted) {
  if (isMuted || volume === 0) {
    return faVolumeXmark;
  }
  if (volume < 0.5) {
    return faVolumeLow;
  }
  return faVolumeHigh;
}

export default function PlayerControlBar({
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  isFullscreen,
  onToggleFullscreen,
  subtitleMenuOpen,
  onToggleSubtitleMenu,
  resolvedSubtitleTracks,
  activeSubtitleId,
  onSelectSubtitle,
}) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/40 to-transparent pb-4 pt-12 transition-opacity duration-200 ${
        subtitleMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}
    >
      <div className="pointer-events-auto mx-6 flex items-center gap-4 text-xs text-white">
        <span className="rounded-full border border-emerald-400 bg-emerald-500/80 px-3 py-1 text-xs font-semibold text-white">
          LIVE
        </span>

        <div className="ml-auto flex items-center gap-3">
          {resolvedSubtitleTracks.length ? (
            <div id="subtitle-toggle" className="relative">
              <button
                type="button"
                className={`flex items-center gap-1 rounded-full border border-white/30 bg-black/60 px-3 py-2 text-xs font-medium hover:bg-black/80 ${
                  subtitleMenuOpen ? 'text-accent' : ''
                }`}
                onClick={onToggleSubtitleMenu}
              >
                <FontAwesomeIcon icon={faClosedCaptioning} />
              </button>
              {subtitleMenuOpen ? (
                <div className="absolute bottom-12 right-0 max-h-64 min-w-[11rem] overflow-y-auto rounded-lg border border-border/70 bg-background/95 p-2 text-xs shadow-xl">
                  <button
                    type="button"
                    onClick={() => onSelectSubtitle('off')}
                    className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-surface/80 ${
                      activeSubtitleId === 'off' ? 'bg-surface/80 text-accent' : ''
                    }`}
                  >
                    <span>Off</span>
                  </button>
                  {resolvedSubtitleTracks.map((track) => {
                    const label = track.label || track.language?.toUpperCase() || track.id;
                    return (
                      <button
                        key={`subtitle-option-${track.id}`}
                        type="button"
                        onClick={() => onSelectSubtitle(track.id)}
                        className={`mt-1 flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-surface/80 ${
                          activeSubtitleId === track.id ? 'bg-surface/80 text-accent' : ''
                        }`}
                      >
                        <span>{label}</span>
                        {track.forced ? (
                          <span className="text-[0.65rem] uppercase text-muted">forced</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-full border border-white/30 bg-black/60 px-2 py-1 text-sm hover:bg-black/80"
              onClick={onToggleMute}
            >
              <FontAwesomeIcon icon={volumeIcon(volume, isMuted)} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round((isMuted ? 0 : volume) * 100)}
              onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
              className="h-1 w-24 cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            />
          </div>

          <button
            type="button"
            className="rounded-full border border-white/30 bg-black/60 px-3 py-1 text-xs hover:bg-black/80"
            onClick={onToggleFullscreen}
          >
            <FontAwesomeIcon icon={isFullscreen ? faCompress : faExpand} />
          </button>
        </div>
      </div>
    </div>
  );
}
