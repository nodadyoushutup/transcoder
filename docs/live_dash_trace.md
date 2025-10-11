# Live DASH Trace Checklist

Use this runbook whenever playback still stutters so we can capture a full picture of what the pipeline is doing. Each step produces an artefact (log lines, numbers, screenshots) we can compare between runs.

## 1. Prep the environment

1. Ensure the nginx WebDAV origin and transcoder service are running (`cd docker && docker compose up -d webdav`, `core/transcoder/scripts/run.sh`). Let them settle for 10 s so new log files are created.
2. Note the newest log names:
   ```bash
   ls -t core/transcoder/logs | head -n 1
   ls -t docker/logs | head -n 1
   ```
   Keep these filenames handy; all later commands reference them.
3. Confirm the transcoder poll interval and grace settings match expectations by grepping the repo:
   ```bash
   rg "poll_interval" core/api/src/transcoder/pipeline.py
   rg "future_sequence_grace" core/api/src/transcoder/publishing.py
   ```
   We should see `poll_interval: float = 0.5` and `future_sequence_grace: int = 3`. If not, stop and fix the code before gathering traces.

## 2. Trigger a fresh playback session

1. In the GUI, start a new stream from the Dashboard. If credentials are required, use the seeded admin account unless you have a custom user.
2. Immediately capture the transcoder session ID from the log line:
   ```
   Transcoder session <SESSION_ID> starting (retain=…)
   ```
   We reference this ID in later steps.

## 3. Measure segment publishing latency

1. Tail the transcoder log with timestamps:
   ```bash
   tail -f core/transcoder/logs/<latest-transcoder-log> | rg --color=never "Discovered 2 new segment|PUT chunk"
   ```
2. For each pair of lines, record:
   * `age_ms` reported when the segment is discovered.
   * The time difference between “Discovered …” and the subsequent `PUT chunk` completion line.
3. Healthy runs should show `age_ms` consistently below ~600 ms and PUT completion gaps under ~150 ms. Anything higher implies the publisher still lags; jot down the offending sequence numbers.

## 4. Verify manifest refresh cadence

1. Keep a second tail for manifest updates:
   ```bash
   tail -f core/transcoder/logs/<latest-transcoder-log> | rg --color=never "Manifest window session"
   ```
2. Confirm the `start`, `last`, and `count` fields advance monotonically and that `last - start + 1 == count` (24 in the default configuration). Note any gaps or regressions.

## 5. Inspect ingest persistence

1. Tail the nginx access log associated with the run:
   ```bash
   tail -f docker/logs/<latest-nginx-log> | rg --color=never "PUT /media/sessions|DELETE /media/sessions"
   ```
2. For each DELETE, ensure the sequence number being removed is at least three less than the highest PUT seen so far (the grace window we expect). Record cases where DELETEs fire sooner; that indicates the publisher is still dropping chunks too early.

## 6. Capture client telemetry

1. In the browser DevTools console, retain the diagnostics emitted by `StreamPage` (buffer state, diagnostic objects, gap warnings).
2. Take a screenshot that includes the timestamps, the manifest URL, and any `GapController` warnings. Name it with the session ID for cross‑reference.
3. Note the current playback time when buffering occurs; we can correlate it with the manifest window from step 4.

## 7. Collect configuration snapshot

1. Export the current transcoder system settings (from the GUI or via API) into a JSON file. At minimum capture:
   * `TRANSCODER_AUTO_KEYFRAMING`
   * `VIDEO_FPS`, `VIDEO_GOP_SIZE`, `DASH_SEGMENT_DURATION`
   * `DASH_WINDOW_SIZE`, `DASH_EXTRA_WINDOW_SIZE`, `DASH_RETENTION_SEGMENTS`
2. Save the export alongside the logs; mismatched settings are a common source of off‑by‑one behaviour.

## 8. Summarise the run

Create a short report (Markdown or plain text) with:

| Observation | Value |
|-------------|-------|
| Session ID | `<SESSION_ID>` |
| Average age_ms at discovery | e.g. `420 ms` |
| Max PUT latency | e.g. `110 ms` |
| Earliest DELETE vs highest PUT | e.g. `DELETE chunk-0-00041` while highest PUT `chunk-0-00065` |
| Buffer gaps seen | e.g. `GapController jump 1.89 s at t=48 s` |

Attach the DevTools screenshot and the exported settings. This package makes it straightforward to diff problem runs against healthy baselines.

---

Following this checklist every time playback stalls will let us pinpoint whether the issue is rooted in publisher timing, ingest retention, manifest shaping, or the client player. Update this document with any additional metrics that prove useful so future debugging runs stay repeatable.***
