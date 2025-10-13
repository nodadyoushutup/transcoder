# Transcoder Overhaul Implementation Plan

## 1. Goals & Scope
- Replace legacy configuration paths so every FFmpeg and Shaka Packager flag is sourced from the database-backed System Settings.
- Mirror the behaviour of the working prototype scripts (`run_ffmpeg.sh`, `run_packager.sh`) inside the API-driven transcoder while keeping the scripts unchanged as verification controls.
- Remove all subtitle-related functionality (API, services, UI, player) until a future phase.
- Keep the watchdog focused solely on session file lifecycle, and make the custom ingest server the canonical publishing target.

## 2. Prototype Command Breakdown
- **Session orchestration**: session-specific root with `.pipes` fifo directory; video/audio pipes `video_0.mp4`, `audio_0.mp4`.
- **FFmpeg inputs**: single source path; realtime (`-re`); generates keyint using FFprobe-derived frame rate and selected segment duration.
- **Video encoding**: `libx264`, preset `superfast`, bitrate/maxrate `5M`, bufsize `10M`, closed GOP, forced keyframes aligned to segment duration, DASH-friendly MOV flags with fragment duration `segment_seconds * 1_000_000`.
- **Audio encoding**: AAC stereo (`-ac 2`) at `192k`, with identical MOV flags and fragment duration.
- **Packager**: consumes the FIFOs and outputs DASH manifest/segments with shared `segment_duration`; `minimum_update_period` equals segment duration; `suggested_presentation_delay` is `segment_duration * 5`; `time_shift_buffer_depth = segment_duration * keep_segments`; background cleaner prunes to `KEEP_SEGMENTS`.

## 3. System Settings Surface (Database Truth Source)
| Setting Group | Field | Default (from prototype) | Notes |
| --- | --- | --- | --- |
| General | `input_path` | user-specified per job | Provided by API request |
| General | `session_segment_prefix` | generated session UUID | Keep per-run |
| Timing | `segment_duration_seconds` | `2` | Drives FFmpeg force keyframes & Shaka `--segment_duration` |
| Timing | `keep_segments` | `20` | Controls cleanup & Shaka time-shift depth |
| Timing | `suggested_presentation_delay_factor` | `5` | Multiply by segment duration |
| Timing | `minimum_update_period_seconds` | default to `segment_duration` | Allow override |
| Timing | `time_shift_buffer_depth_seconds` | compute `segment_duration * keep_segments` | Derived unless overridden |
| Video | `video_codec` | `libx264` | Restrict to supported values |
| Video | `video_bitrate` | `5M` | Used for `-b:v` and `-maxrate` |
| Video | `video_maxrate` | `5M` | Stored separately for extensibility |
| Video | `video_bufsize` | `10M` | |
| Video | `video_preset` | `superfast` | |
| Video | `force_keyframe_expression` | `expr:gte(t,n_forced*SEGMENT_DURATION)` | Generated from timing |
| Audio | `audio_codec` | `aac` | |
| Audio | `audio_channels` | `2` | |
| Audio | `audio_bitrate` | `192k` | |
| Auto Keyframing | `auto_keyframe_enabled` | `true` | Toggles dynamic KEYINT |
| Auto Keyframing | `auto_keyframe_segment_seconds` | derived from `segment_duration_seconds` | stored for overrides |
| Auto Keyframing | `auto_keyframe_minimum_keyint` | derived | optional manual override |
| Packager | `packager_binary` | `packager` | allow path override |
| Packager | `manifest_name` | `manifest.mpd` | stored in encoder settings |
| Packager | `segment_template` | `video_$Number$.m4s` / `audio_$Number$.m4s` | deterministic naming |
| Packager | `cleanup_interval_seconds` | `5` | Used by watchdog cleaner loop |
| Paths | `session_root` | base `/transcode_data/sessions` | ensure configurable |

> Derived values (e.g., `time_shift_buffer_depth_seconds`) should be recomputed whenever their source fields change, but can be overridden explicitly when necessary. Defaults seeded on first boot must match the above.

## 4. Backend Implementation Plan
- **Data Model**
  - Add migration(s) so the System Settings table carries the fields listed above (remove subtitle columns).
  - Ensure seeding scripts populate defaults matching the prototype.
- **Settings Service**
  - Centralize settings retrieval in `core/api/src/transcoder` ensuring every worker and the API uses the same schema.
  - Expose helper to compute derived timing values (fragment duration microseconds, KEYINT, force keyframe expression).
- **Command Builders**
  - Refactor FFmpeg command assembly to consume settings object only; no hard-coded values outside defaults.
  - Implement auto keyframing helper: run FFprobe when `auto_keyframe_enabled`; compute KEYINT from frame rate × segment duration; fall back to manual numbers if disabled.
  - Ensure preview FFmpeg command (used by GUI/API) reuses the same builder and honours auto keyframing.
  - Update Shaka Packager invocation builder to mirror script flags, including init/segment naming and timing values.
  - Guarantee both commands share segment duration and other coupled values by deriving them once from the settings payload.
- **Watchdog & Publishing**
- Simplify watchdog to: create FIFOs, launch FFmpeg + Packager, prune old segments, and push outputs to the published media destination.
  - Remove side effects unrelated to session file lifecycle; log minimal status for debugging.
- **Legacy Cleanup**
  - Delete subtitle extraction/endpoints, playback subtitle handling, and related DB columns.
  - Strip unused transcoder flags / legacy options that are no longer represented.
  - Update any API contract that currently expects subtitle data to respond gracefully (e.g., empty arrays).

## 5. Frontend Implementation Plan
- **System Settings UI**
  - Rebuild sections to match the new schema; hide auto keyframe details unless manual override toggled.
  - Remove subtitle tabs/components, subtitle extraction actions, and player subtitle menu until the feature returns.
  - Ensure coupled settings (segment duration, packager timings) update together via shared state logic.
  - Provide read-only preview of the resolved FFmpeg command to help operators verify output.
- **Transcode Flow**
- Update request payloads so they no longer include subtitle fields; ensure the UI surfaces the published manifest URL for the active session.
  - Validate preview pipeline uses the final command builder, and display errors/logs from the transcoder service.

## 6. Coordination Rules
- Database values are the single source for every encode; workers fetch settings immediately before each transcode job.
- Changing a coupled value (e.g., segment duration) recomputes dependent fields (KEYINT, fragment duration, Shaka timing) in both API and UI layers.
- Prototype scripts remain untouched for regression checking; automated tests should compare assembled commands against prototype expectations.

## 7. Testing & Validation
- **Unit tests**: cover settings resolver, auto keyframe calculator, FFmpeg/Shaka command builders.
- **Integration tests**: spin up API + transcoder services, trigger jobs via API, assert generated manifests and logs align with prototype.
- **Manual loop**: use dashboard to start encode, monitor `core/transcoder/logs/**`, verify ingest server receives manifest/segments, confirm cleanup respects `keep_segments`.

## 8. Rollout Steps
- Implement backend migrations + service updates.
- Update frontend settings & playback views; remove subtitles.
- Deploy in staging, run full encode via dashboard, compare outputs against control scripts.
- After validation, communicate schema change to operators and deprecate legacy configuration paths.
