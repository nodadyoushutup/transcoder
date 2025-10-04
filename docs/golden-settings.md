# Golden Playback and Transcode Settings

This document captures the exact web player and transcoder settings that are verified to work well today. Treat these as golden values. Do **not** edit the source files listed below without updating this document and performing a full validation pass. Any deviation should go through review with a clear regression plan.

## Web Player (dash.js)
Source of truth: `core/gui/src/pages/StreamPage.jsx`

- Player lifecycle
  - Player is created via `dashjs.MediaPlayer().create()` and initialised with `player.updateSettings(...)` **before** attaching a source.
  - Autoplay is forced: `player.setAutoPlay(true)` and the `<video>` element sets `muted`, `autoplay`, and `playsInline`.
  - Manifest polling waits for two consecutive successful probes before attaching the stream (1 s interval with a 500 ms grace delay).
  - Default fallback URL comes from `INGEST_BASE` (`VITE_INGEST_URL` or `${protocol}//${hostname}:5005`), ensuring the player points at the ingest service when the API has not yet reported a manifest.
  - On startup the video element auto-plays and retry logic tears down and recreates the player on dash.js error events.
- Streaming delay / catch-up
  - `streaming.delay.liveDelay = NaN` (dash.js falls back to the manifest suggestion).
  - `streaming.delay.liveDelayFragmentCount = 3`.
  - `streaming.delay.useSuggestedPresentationDelay = true`.
  - `streaming.liveCatchup.enabled = true` with `maxDrift = 1.0` seconds and playback rate bounds `{ min: -0.2, max: 0.2 }`.
- Buffering and timeline
  - `streaming.buffer.fastSwitchEnabled = false`.
  - `bufferPruningInterval = 10` seconds.
  - `bufferToKeep = 6` seconds.
  - `bufferTimeAtTopQuality = 8` seconds.
  - `bufferTimeAtTopQualityLongForm = 8` seconds.
  - Text tracks start disabled: `streaming.text.defaultEnabled = false`.
- Live edge resilience
  - A RAF-driven monitor updates latency/buffer stats and displays them in the UI.
  - Stall detection checks once per second; if the player is live and the current position is static for 5 checks, the code seeks to `liveEdge - 0.5` to recover.
  - When the transcoder stops, the overlay is forced back to the offline state and polling is halted.

**Do not change these dash.js settings** (or any related retry/stall logic) without updating both this document and `StreamPage.jsx` together.

## Transcoder (FFmpeg DASH)
Canonical sources: `core/api/src/transcoder/config.py`, `core/transcoder/test/manual_encode.sh`

- Runtime framing
  - `EncoderSettings.realtime_input = True` (forces `-re`).
  - Input arguments: `-copyts -start_at_zero -fflags +genpts` (preserve timestamps and generate PTS).
- Outputs are written under `core/ingest/out/` with basename `audio_video`; manifest path: `core/ingest/out/audio_video.mpd`.
- Every run must publish segments via HTTP PUT to the ingest service (`TRANSCODER_PUBLISH_BASE_URL` points at the `/media/` endpoint, typically `http://localhost:5005/media/`).
  - At most one video track and one audio track are encoded (`max_video_tracks = 1`, `max_audio_tracks = 1`).
- Video encoding defaults (`VideoEncodingOptions`)
  - Codec: `libx264` with preset `ultrafast`.
  - Bitrate ladder: constant 5 Mbps (`-b:v 5M`) with matching `-maxrate 5M` and `-bufsize 10M`.
  - GOP structure: `-g 48`, `-keyint_min 48`, scene-cut disabled (`-sc_threshold 0`).
  - VSync: `-vsync 1` (applied once for the first stream).
  - Scaling filter: `scale=1280:-2` (force 1280 px width, preserve aspect, even height).
  - No extra tune/profile flags beyond defaults.
- Audio encoding defaults (`AudioEncodingOptions`)
  - Codec: `aac` with profile `aac_low`.
  - Bitrate: `192k`.
  - Channels: stereo (`-ac 2`).
  - Sample rate: `48 kHz`.
  - Filter chain: `aresample=async=1:first_pts=0` for sync.
- DASH muxing (`DashMuxingOptions`)
  - Output format: `-f dash` with `-streaming 1`.
  - Segments: `-seg_duration 2`, `-frag_duration 2`, `-min_seg_duration 2000000` (microseconds).
  - Window: `-window_size 10`, `-extra_window_size 5` (keeps ~20 seconds of media plus headroom).
  - Template/timeline enabled: `-use_template 1`, `-use_timeline 1`.
  - Mux timing: `-muxpreload 0`, `-muxdelay 0`.
  - Segment naming: `init-$RepresentationID$.m4s`, `chunk-$RepresentationID$-$Number%05d$.m4s`.
  - Adaptation sets: `id=0,streams=v id=1,streams=a` (video/audio separated).
  - No retention pruning (`retention_segments = None`), no custom user agent.
- Validation script
  - `core/transcoder/test/manual_encode.sh` mirrors the exact FFmpeg invocation above. Leave it untouched; it is the reference command for manual and automated smoke tests.

**Do not change** the values inside `VideoEncodingOptions`, `AudioEncodingOptions`, `DashMuxingOptions`, the encoding input arguments, or the manual encode script without revisiting this document and revalidating the full pipeline.

## Change Control Checklist

1. Review this document and confirm whether the proposed modification alters any golden value.
2. If a change is required, update the relevant source file(s) **and** this document in the same change set.
3. Re-run the validation scripts (`core/transcoder/test/manual_encode.sh` and the web player via `core/gui/scripts/run.sh`) and capture logs under `core/transcoder/logs/` and `core/gui/logs/`.
4. Record the rationale for deviating from a golden setting in the pull request or change description.

Following this checklist prevents accidental drift from the known-good configuration.

## Service Topology & Interfaces
- Control plane: Flask API (`core/api/scripts/run.sh`) listens on port 5001 and proxies `/transcode/*` calls to the standalone transcoder service via `TRANSCODER_SERVICE_URL` (default `http://localhost:5003`).
- Transcoder microservice: single-worker Gunicorn (`core/transcoder/scripts/run.sh`) serving `src.wsgi:app`; never scale horizontally because the controller requires exclusive FFmpeg ownership.
- Ingest service: lightweight Flask app (`core/ingest/scripts/run.sh`) on port 5005 exposing `/media/<path>` for GET/HEAD/PUT/DELETE. It reads and writes directly from `core/ingest/out/`, making it the canonical host for manifests and segments.
- Local media publishing: `TRANSCODER_PUBLISH_BASE_URL` resolves to the ingest endpoint (defaults to `http://localhost:5005/media/`). Leave the System Settings field blank to use that fallback, or override it with a remote ingest/CDN URL when publishing off-box.
- Frontend stream URL: the React app now defaults to `${location.protocol}//${location.hostname}:5005/media/audio_video.mpd`, unless `VITE_STREAM_URL` or `VITE_INGEST_URL` override it. Keep the ingest origin stable to avoid buffering from cross-origin mismatches.

## Environment & Storage Defaults
- Input (`TRANSCODER_INPUT`): `/media/tmp/pulpfiction.mkv` for local dev; change only when the alternate source is verified with `manual_encode.sh`.
- Output (`TRANSCODER_OUTPUT`): `core/ingest/out/` inside the repo; manifests and segments use basename `audio_video`.
- Local output path overrides (System Settings → Transcoder/Ingest): provide absolute paths as they exist on the machines hosting each service (e.g. `/mnt/nvme/publex`). These values are interpreted from the perspective of the remote host when services run off-box.
- Publish base (`TRANSCODER_PUBLISH_BASE_URL`): points at the HTTP PUT ingest target (defaults to `http://localhost:5005/media/`). If the dashboard field is blank the default is used automatically; override it whenever the ingest origin changes so both the API and transcoder agree on the publish destination.
- Publish force-new-connection (`TRANSCODER_PUBLISH_FORCE_NEW_CONNECTION`): toggle to `true` only when remote publishing is enabled and each PUT must tear down the TCP session (useful when keep-alive reuse triggers ingest 400s).
- Local media base (`TRANSCODER_LOCAL_MEDIA_BASE_URL`): ingest server static files at `http://localhost:5005/media/`; ensure the ingest service is running so it can serve and receive PUT/DELETE requests.
- Log directories: `core/api/logs`, `core/transcoder/logs`, `core/gui/logs`, and any new ingest service should follow the same pattern for troubleshooting.

## System Settings

### Library
- Source of truth: `core/gui/src/pages/SystemSettingsPage.jsx`, `core/api/src/services/settings_service.py`.
- Library chunks default to 500 items per request (`section_page_size`) and can be tuned between 1 and 1000 to match Plex responsiveness. This value drives both the API pagination and the React browser (`LibraryPage.jsx`).
- Library sections can be toggled visible/hidden via the System Settings → Library screen. Hidden identifiers are stored as `hidden_sections` and hidden sections are omitted from the Library page navigation by default.
- The default section view controls whether libraries open to Recommended hubs, the familiar Library grid, or Collections. Configure this under System Settings → Library; the Library page header exposes matching toggles so users can switch views on demand.
- The settings UI surfaces an eye/eye-slash toggle (Font Awesome) alongside each Plex section to make visibility changes obvious at a glance.
- The library header now exposes a refresh action that forces a server-side recache of the active section, and the metadata drawer includes a matching refresh button to bust a single item's cache.

### Redis
- Source of truth: `core/gui/src/pages/SystemSettingsPage.jsx`, `core/api/src/services/redis_service.py`, `core/api/src/services/plex_service.py`.
- Redis is a mandatory dependency for metadata caching, chat, and multi-worker Gunicorn deployments. Provide the connection URL under System Settings → Redis (example: `redis://localhost:6379/0`).
- When Redis is unavailable, caching and chat are explicitly disabled; the settings panel surfaces the last connection error so operators can diagnose configuration issues.
- Both library sections and item detail views provide manual refresh buttons that bypass Redis and repopulate it with the latest Plex data once connectivity is restored.
- With Redis online, Socket.IO uses it as a message queue, allowing `run.sh` to start Gunicorn with multiple workers without breaking real-time features. The launcher now auto-detects CPU count, defaulting to `(2 × cores) + 1` workers for sync classes and `cores` workers for async classes (the default `eventlet`). When switching to `gthread`, the script also preconfigures four threads per worker so a 4-core node handles ~16 concurrent requests out of the box.
- `core/api/scripts/run.sh` now supervises the Celery worker automatically so Docker and local runs only need a single entrypoint. Export `ENABLE_EMBEDDED_CELERY=0` before launching if you prefer to start workers via another process manager.

## Operational Guardrails
- Always start both services with their provided scripts so `PYTHONPATH`, env vars, and single-worker guarantees are applied.
- Launch the ingest service (`core/ingest/scripts/run.sh`) before starting playback so `/media` requests resolve locally.
- Before touching encoder/player settings, capture a fresh run of `core/transcoder/test/manual_encode.sh` and archive the resulting FFmpeg command output/log.
- The API `/transcode/status` response is the contract the frontend relies on (`running`, `manifest_url`, `output_dir`, `pid`). Preserve these fields when extending the backend for ingest workflows.
- Maintain `window_size=10`/`extra_window_size=5` parity between FFmpeg and any CDN/edge cache so the player’s three-fragment catch-up window remains valid.

## Validation Checklist (No Buffering Regression)
1. Launch the ingest service, API, transcoder service, and web UI via the standard run scripts.
2. Trigger an encode (API dashboard or manual curl) and confirm `core/transcoder/logs` shows the golden FFmpeg command without overrides.
3. Open the Stream dashboard, verify latency stays within ~3 seconds and buffered media ≥ 2 seconds (`stats` overlay). No repeated recoveries should occur in the last 60 seconds.
4. If publishing remotely, inspect the ingest endpoint logs to ensure PUT/DELETE latency stays below the 2-second segment cadence.
5. Preserve the latest log bundle alongside the code change to document the known-good state for future ingest development.
