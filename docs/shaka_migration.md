# Shaka Packager Migration Plan

This document lays out how we can replace the bespoke DASH segment publisher with [Shaka Packager](https://github.com/google/shaka-packager) while preserving our current queue-driven workflow, ingest service, and React/Vite dashboard.

---

## 1. Goals & Scope

- **Primary objective:** delegate manifest/segment window management to Shaka Packager so playback no longer stalls after ~120 s and we gain first-class subtitle handling.
- **Secondary objectives:**
  - Keep our queue semantics (finish Item A before Item B) without re-encoding or replay loops.
  - Maintain the ingest service as the HTTP origin, but simplify it to static file serving.
  - Preserve the existing FFmpeg real-time (`-re`) encoding path with Celery orchestration.
  - Surface captions and multi-audio cleanly in the dashboard player.

Out of scope for the first iteration: DRM, low-latency CMAF, multi-CDN distribution. We will capture them as follow-ups where relevant.

---

## 2. Current vs Target Architecture (High-Level)

| Aspect | Today | Target with Shaka |
| --- | --- | --- |
| Encoder | FFmpeg (live, `-re`) launched by Celery worker | **Same** |
| Packager | Custom Python `SegmentPublisher` + ingest PUTs | Shaka Packager writing DASH/HLS segments to ingest staging directory |
| Ingest | Flask app handling PUT/DELETE/GET, trimming, and manifest edits | Flask app becomes a thin static origin (PUT for uploads only if we keep HTTP ingest) |
| Control plane | API schedules FFmpeg, front-end polls `/transcode/status` | **Same**, but packager lifecycle/health tracked alongside FFmpeg |
| Player | dash.js polling manifest, manual DVR math | dash.js reads Shaka-generated MPD (native timeline, subtitle tracks) |

---

## 3. Prerequisites

1. **Build environment:** GCC/Clang, CMake, OpenSSL (for HTTPS outputs) on the transcoder host. Alternatively, Docker runtime if we containerise packager runs.
2. **Disk layout:** shared filesystem (e.g. `/home/nodadyoushutup/transcode_data`) accessible to Shaka and the ingest service with sufficient write throughput.
3. **Network ports:** ensure Shaka can write to local disk or push to an HTTP endpoint if desired. No inbound ports required unless we adopt its experimental gRPC ingest.
4. **FFmpeg >= 4.4:** we rely on stable piping behaviour and WebVTT extraction.
5. **dash.js & GUI:** confirm the frontend can load captions/audio track metadata exposed by Shaka (dash.js already supports that out of the box).

---

## 4. Shaka Packager Installation

### Option A — Prebuilt Binary

```bash
curl -LO https://github.com/google/shaka-packager/releases/download/v3.1.0/packager-linux-x64
install -m 0755 packager-linux-x64 /usr/local/bin/packager
```

Verify:

```bash
packager --version
```

### Option B — Build from Source

```bash
sudo apt-get install gcc g++ python3 python3-pip cmake ninja-build libssl-dev
git clone https://github.com/google/shaka-packager.git
cd shaka-packager
python3 build.py --type=Release
sudo ninja -C out/Release install
```

### Option C — Container Runtime

Create a lightweight image to keep dependencies isolated:

```Dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y curl && \
    curl -LO https://.../packager-linux-x64 && \
    install -m 0755 packager-linux-x64 /usr/local/bin/packager && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /data
ENTRYPOINT ["packager"]
```

Publish to our registry and reference it from Celery tasks if we prefer containerised packager runs.

---

## 5. End-to-End Migration Plan

### Phase 0 — Discovery (1–2 days)

- Benchmark current FFmpeg command lines (video/audio bitrates, subtitles, segment duration).
- Capture manifest samples that highlight the 118 s stall behaviour.
- Inventory dashboard requirements: subtitle toggles, audio track selection, queue semantics.

**Deliverables:** tech spec updates, baseline metrics (startup latency, segment publish time).

### Phase 1 — Local Prototype (2–3 days)

1. Use a sample input to drive FFmpeg in real time, writing to named pipes:

   ```bash
   mkfifo /tmp/video.mp4 /tmp/audio.aac
   ffmpeg -re -i input.mkv \
     -map 0:v:0 -c:v libx264 -preset veryfast -g 60 -keyint_min 60 \
     -map 0:a:0 -c:a aac -b:a 256k \
     -f mp4 -movflags frag_keyframe+empty_moov /tmp/video.mp4 \
     -f adts /tmp/audio.aac
   ```

2. Launch Shaka Packager to read those pipes and produce DASH + WebVTT:

   ```bash
   packager \
     in=/tmp/video.mp4,stream=video,init_segment=video/init.mp4,segment_template=video/seg-\$Number$.m4s \
     in=/tmp/audio.aac,stream=audio,init_segment=audio/init.mp4,segment_template=audio/seg-\$Number$.m4s,language=en \
     in=/tmp/subs.vtt,stream=text,init_segment=text/init.vtt,segment_template=text/seg-\$Number$.vtt \
     --segment_duration 2 \
     --time_shift_buffer_depth 3600 \
     --dash_force_segment_list \
     --mpd_output /tmp/output.mpd
   ```

3. Serve `/tmp` via a static HTTP server and test playback in dash.js with subtitles toggled.

**Success criteria:** manifest remains valid past 120 s; subtitles selectable; DVR window obeys chosen depth.

### Phase 2 — Integrate with Existing Ingest Service (3–5 days)

- Decide on output directory: likely `/home/nodadyoushutup/transcode_data/shaka/<session>/`.
- Update ingest service configuration so PUT/DELETE logic either:
  - trusts Shaka to prune old segments (preferred), or
  - simply mirrors Shaka outputs if we still want to keep HTTP PUTs for analytics.
- Ensure ingest static serving path matches Shaka’s output layout (e.g. `video/seg-00001.m4s`).
- Add health endpoint to confirm segments and MPD are being refreshed (e.g. check `mtime` recency).

**Dependencies:** might need to disable existing manifest pruning cron jobs.

### Phase 3 — Backend Orchestration (5–7 days)

- Extend the Celery transcoder worker to spawn Shaka Packager alongside FFmpeg:
  - Start FFmpeg with named pipes.
  - Start packager process, watch for exit codes.
  - Collect logs (redirect Shaka stdout/stderr to our log directory).
  - Manage lifecycle (terminate packager when `stop_av` invoked).
- Update `core/api/src/transcoder` models to store Shaka config (segment duration, buffer depth, text tracks).
- Add telemetry to `/transcode/status` reporting packager PID, current MPD URL, subtitles list.
- Deprecate/remove custom `SegmentPublisher` timeline rebuilding logic once Shaka is authoritative.

**Fallback plan:** keep old pipeline behind a feature flag so we can revert if packaging fails.

### Phase 4 — Frontend Updates (2–3 days)

- Update `StreamPage.jsx` to:
  - Read the new MPD URL (likely similar to today’s but may include different path layout).
  - Use dash.js track APIs (`getTracksFor('text')`) to populate subtitle toggles.
  - Handle queue transitions without forcing `seek(0)`—Shaka maintains manifest continuity.
- Add UI cues for live DVR depth (optional) by reading `availabilityStartTime` and `timeShiftBufferDepth`.
- Test HLS fallback if we decide to expose `.m3u8` in addition to `.mpd`.

### Phase 5 — Operationalisation & Rollout (ongoing)

- **Monitoring:** add Prometheus exporters or log scrapers for Shaka (e.g. check MPD timestamp, segment counts).
- **Scaling:**
  - Single-host: run FFmpeg+Shaka per queue item on the transcoder node.
  - Multi-host: replicate the packager container, push outputs to shared storage (NFS/S3); ingest service becomes a reverse proxy/CDN frontend.
- **Deployment sequencing:**
  1. Ship to staging, run end-to-end encode → watch >10 min.
  2. Exercise subtitles, multiple queue transitions.
  3. Deploy to production behind feature flag; roll to full once metrics stable.
- **Rollback:** stop Shaka, re-enable old `SegmentPublisher`, restart services. Keep both code paths available until after production validation.

---

## 6. Configuration & Secrets Checklist

- New system settings (with defaults):
  - `SHAKA_SEGMENT_DURATION` (seconds) — default 2.002 to match GOP.
  - `SHAKA_TIME_SHIFT_BUFFER_DEPTH` — default 360 (6 min) or per-channel.
  - `SHAKA_TEXT_LANGUAGES` — optional list for WebVTT tracks.
  - `SHAKA_OUTPUT_ROOT` — base directory or S3 bucket.
- API/Celery environment variables:
  - `SHAKA_BINARY_PATH` (if not on `$PATH`).
  - Optional S3 credentials if outputs migrate to object storage.
- Logging levels for packager stdout/stderr.

---

## 7. Testing Strategy

| Layer | Tests |
| --- | --- |
| Unit | new orchestration helpers (pipe creation, process supervision) in `core/transcoder` |
| Integration | Celery task launching FFmpeg + Shaka, verifying MPD endpoint returns 200 and contains expected adaptations |
| E2E | Simulated queue run: encode Item A → switch to Item B → confirm playback continues without gaps and subtitles remain selectable |
| Load | Soak test >1 h encode to ensure MPD rotation, disk cleanup, and ingest GET latencies remain stable |

---

## 8. Risks & Mitigations

- **Process lifecycle deadlocks (pipes).** Use `asyncio`/threads to read packager stderr; ensure FFmpeg terminates cleanly if packager exits.
- **Disk usage creep.** Configure Shaka `--preserved_segments_outside_live_window` to minimal values and run periodic cleanup on ingest.
- **Frontend manifest caching.** Preserve cache-busting query logic in `StreamPage.jsx` to avoid stale MPDs.
- **Subtitle availability.** Validate that upstream content actually contains subtitles; log a warning when text adaptation is missing.
- **Operational complexity.** Containerising the packager and defining a clear health check simplifies on-call runbooks.

---

## 9. Timeline (Rough)

| Week | Milestone |
| --- | --- |
| 1 | Prototype pipeline (Phase 1) complete; document findings |
| 2 | Phase 2 & Phase 3 implemented in staging |
| 3 | Frontend adjustments merged; begin end-to-end testing |
| 4 | Production rollout behind feature flag, monitor, then cut over |

Timelines assume one engineer dedicated; adjust as needed.

---

## 10. Next Actions

1. Approve this migration plan and schedule Phase 0 discovery.
2. Produce a proof-of-concept `packager` command line with current encode settings.
3. Add feature flag plumbing in the API/GUI to switch between legacy and Shaka pipelines.
4. Begin implementation following the phased approach above.

---

_Document owner: Transcoder team • Last updated: 2025-10-08_
