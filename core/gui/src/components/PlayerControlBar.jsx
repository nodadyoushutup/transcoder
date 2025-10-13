import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faVolumeXmark, faVolumeLow, faVolumeHigh, faExpand, faCompress } from '@fortawesome/free-solid-svg-icons';

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
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/40 to-transparent pb-4 pt-12 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
    >
      <div className="pointer-events-auto mx-6 flex items-center gap-4 text-xs text-white">
        <span className="rounded-full border border-accent/70 bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">
          LIVE
        </span>

        <div className="ml-auto flex items-center gap-3">
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
