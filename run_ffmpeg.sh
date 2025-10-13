#!/usr/bin/env bash
set -euo pipefail

SESSION_ID="e5423f1cdf534b91a7810695e5a16728"
SESSION_ROOT="/home/nodadyoushutup/transcode_data/sessions/${SESSION_ID}"
PIPE_DIR="${SESSION_ROOT}/.pipes"
VIDEO_PIPE="${PIPE_DIR}/video_0.mp4"
AUDIO_PIPE="${PIPE_DIR}/audio_0.mp4"
# SOURCE="/media/movies/mainstream/V H S HALLOWEEN (2025) {imdb-tt37676033}/V H S HALLOWEEN (2025) {imdb-tt37676033} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-KHN.mkv"
SOURCE="/media/movies/mainstream/Pulp Fiction (1994) {imdb-tt0110912}/Pulp Fiction (1994) {imdb-tt0110912} [Bluray-1080p][DTS 5.1][x264]-DON.mkv"
SEGMENT_SECONDS=2
FRAG_DURATION_US=$(( SEGMENT_SECONDS * 1000000 ))

fps_value=$(
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=r_frame_rate \
    -of default=noprint_wrappers=1:nokey=1 \
    "${SOURCE}" || echo ""
)

if [[ -z "${fps_value}" ]]; then
  fps_value="30000/1001"
fi

KEYINT=$(
  python3 - <<'PY' "${fps_value}" "${SEGMENT_SECONDS}"
import sys
from fractions import Fraction

fps_str = sys.argv[1]
segment_seconds = float(sys.argv[2])
try:
    fps = float(Fraction(fps_str))
except Exception:
    try:
        fps = float(fps_str)
    except Exception:
        fps = 29.97

keyint = max(1, round(fps * segment_seconds))
print(keyint)
PY
)

mkdir -p "${PIPE_DIR}"

for fifo in "${VIDEO_PIPE}" "${AUDIO_PIPE}"; do
  if [[ -e "${fifo}" && ! -p "${fifo}" ]]; then
    rm -f "${fifo}"
  fi
  if [[ ! -p "${fifo}" ]]; then
    mkfifo "${fifo}"
  fi
done

ffmpeg -y -re \
  -i "${SOURCE}" \
  -map 0:v:0 -c:v libx264 -preset superfast -b:v 5M -maxrate 5M -bufsize 10M \
  -g "${KEYINT}" -keyint_min "${KEYINT}" -sc_threshold 0 \
  -x264-params "keyint=${KEYINT}:min-keyint=${KEYINT}:scenecut=0:open-gop=0" \
  -force_key_frames "expr:gte(t,n_forced*${SEGMENT_SECONDS})" -an \
  -movflags +empty_moov+default_base_moof -frag_duration "${FRAG_DURATION_US}" -flush_packets 1 \
  -f mp4 "${VIDEO_PIPE}" \
  -map 0:a:0 -c:a aac -ac 2 -b:a 192k -vn \
  -movflags +empty_moov+default_base_moof -frag_duration "${FRAG_DURATION_US}" -flush_packets 1 \
  -f mp4 "${AUDIO_PIPE}"
