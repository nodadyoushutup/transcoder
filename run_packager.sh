#!/usr/bin/env bash
set -euo pipefail

SESSION_ID="e5423f1cdf534b91a7810695e5a16728"
SESSION_ROOT="/home/nodadyoushutup/transcode_data/sessions/${SESSION_ID}"
PIPE_DIR="${SESSION_ROOT}/.pipes"
VIDEO_PIPE="${PIPE_DIR}/video_0.mp4"
AUDIO_PIPE="${PIPE_DIR}/audio_0.mp4"

SEGMENT_SECONDS=${SEGMENT_SECONDS:-2}
KEEP_SEGMENTS=${KEEP_SEGMENTS:-20}
MINIMUM_UPDATE_PERIOD=${MINIMUM_UPDATE_PERIOD:-$SEGMENT_SECONDS}
SUGGESTED_DELAY=${SUGGESTED_DELAY:-$(( SEGMENT_SECONDS * 5 ))}
TIME_SHIFT_DEPTH=${TIME_SHIFT_DEPTH:-$(( SEGMENT_SECONDS * KEEP_SEGMENTS ))}

PACKAGER_PID=""
CLEANER_PID=""

mkdir -p "${PIPE_DIR}"

for fifo in "${VIDEO_PIPE}" "${AUDIO_PIPE}"; do
  if [[ -e "${fifo}" && ! -p "${fifo}" ]]; then
    rm -f "${fifo}"
  fi
  if [[ ! -p "${fifo}" ]]; then
    mkfifo "${fifo}"
  fi
done

rm -f "${SESSION_ROOT}/manifest.mpd" \
      "${SESSION_ROOT}/video_init.mp4" \
      "${SESSION_ROOT}/audio_init.mp4" \
      "${SESSION_ROOT}"/video_*.m4s \
      "${SESSION_ROOT}"/audio_*.m4s

cleanup() {
  if [[ -n "${CLEANER_PID}" ]]; then
    kill "${CLEANER_PID}" 2>/dev/null || true
    wait "${CLEANER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${PACKAGER_PID}" ]]; then
    kill "${PACKAGER_PID}" 2>/dev/null || true
    wait "${PACKAGER_PID}" 2>/dev/null || true
  fi
}

cleanup_segments() {
  local dir=$1
  local keep=$2
  local watch_pid=$3
  while kill -0 "${watch_pid}" 2>/dev/null; do
    python3 - "$dir" "$keep" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
keep = int(sys.argv[2])

def segment_index(path: Path) -> int:
    parts = path.stem.split("_")
    if not parts:
        return -1
    try:
        return int(parts[-1])
    except ValueError:
        return -1

for prefix in ("video", "audio"):
    files = sorted(root.glob(f"{prefix}_*.m4s"), key=segment_index)
    if len(files) > keep:
        for old in files[:-keep]:
            try:
                old.unlink()
            except FileNotFoundError:
                pass
PY
    sleep 5
  done
}

trap cleanup EXIT

packager \
  in="${VIDEO_PIPE}",stream=video,init_segment="${SESSION_ROOT}/video_init.mp4",segment_template="${SESSION_ROOT}/video_\$Number\$.m4s" \
  in="${AUDIO_PIPE}",stream=audio,init_segment="${SESSION_ROOT}/audio_init.mp4",segment_template="${SESSION_ROOT}/audio_\$Number\$.m4s" \
  --segment_duration "${SEGMENT_SECONDS}" \
  --minimum_update_period "${MINIMUM_UPDATE_PERIOD}" \
  --suggested_presentation_delay "${SUGGESTED_DELAY}" \
  --time_shift_buffer_depth "${TIME_SHIFT_DEPTH}" \
  --mpd_output "${SESSION_ROOT}/manifest.mpd" &
PACKAGER_PID=$!

cleanup_segments "${SESSION_ROOT}" "${KEEP_SEGMENTS}" "${PACKAGER_PID}" &
CLEANER_PID=$!

wait "${PACKAGER_PID}" || true
PACKAGER_PID=""
if [[ -n "${CLEANER_PID}" ]]; then
  wait "${CLEANER_PID}" 2>/dev/null || true
  CLEANER_PID=""
fi
