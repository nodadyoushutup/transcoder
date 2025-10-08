# FFmpeg Lessons Learned (DASH Live Streaming)

## TL;DR

- Segment cadence must line up with the encoder’s GOP cadence. For a 2 s DASH segment window at 29.97 fps, that means forcing a keyframe every 60 frames exactly, not “about” every 2 seconds.
- `-seg_duration` (FFmpeg dash muxer) is a hint. If the encoder does not hand the muxer an IDR at the requested interval the muxer stretches the fragment to the next keyframe, producing 4 s+ chunks that every player treats as buffer underruns.
- Re-encoding the video is the only reliable way to enforce that cadence when the source GOP layout is longer than the target segment length.
- When we enforce the cadence we must use the *true* frame period (e.g. 1001/30000) in any math; rounding to “2.0 seconds” reintroduces drift.
- Audio segments naturally vary a few milliseconds (AAC frame packing). That is fine as long as video is steady; players tolerate the audio variance.

## What we changed to get smooth playback

1. **Re-encode video with a fixed GOP**
   - `-c:v libx264 -preset veryfast -b:v 5M`
   - `-x264-params 'keyint=60:min-keyint=60:scenecut=0:open-gop=0:intra-refresh=0:rc-lookahead=0:bf=0'`
   - `-r 30000/1001 -g 60`
2. **Force keyframes using the exact frame duration**
   - `-force_key_frames 'expr:gte(t,n_forced*60060/30000)'`
   - 60060 / 30000 = 2.002 s (the true 60-frame span at 29.97 fps)
3. **Keep the dash muxer settings we already use**
   - `-seg_duration 2 -frag_duration 2 -use_timeline 1 -use_template 1 -streaming 1`
4. **Deliver to a clean session directory**
   - Remove prior manifest & chunks before each raw FFmpeg run to ensure we analyse fresh output.

After those adjustments:

- Video `SegmentTimeline` entries remained `d="60060"` throughout the session (2.002 s each).
- Audio reported durations between 1.94–2.01 s (normal for AAC).
- VLC and in-browser playback ran continuously with no stalls once the first two chunks were available.

## Automating the math inside the app

To make this work for *any* source file we need to calculate the keyframe & segment parameters from metadata at run time:

1. **Probe the input**
   - Use `ffprobe` (already part of the transcoder pipeline) to read:
     - Exact frame rate as a rational (`avg_frame_rate` or `r_frame_rate`, e.g. `30000/1001`).
     - Codec, resolution, etc. (already done for other reasons).
2. **Apply desired segment duration (`seg_duration`)**
   - Current default: 2 seconds.
   - Convert to frames: `segment_frames = round(segment_duration * frame_rate)`
     - For rationals: `segment_frames = segment_duration * numerator / denominator`. For 2 s @ 30000/1001 → 60000/1001 ≈ 59.94 frames → round to 60 frames.
   - Compute the precise seconds that those frames span so we avoid slippage: `segment_seconds_exact = segment_frames * denominator / numerator`.
3. **Example table**

| Source fps (rational) | Frames per 2 s segment | Exact seconds used in `force_key_frames` | Notes |
|-----------------------|------------------------|-------------------------------------------|-------|
| 24000/1001 (23.976)   | 48                     | `48*(1001/24000)` = `48048/24000` ≈ 2.002 | Classic film cadence |
| 25/1                  | 50                     | `50/25` = 2.0                              | PAL / 25 fps sources |
| 30000/1001 (29.97)    | 60                     | `60*(1001/30000)` = `60060/30000` ≈ 2.002 | NTSC video cadence |
| 30/1                  | 60                     | `60/30` = 2.0                              | Exact 30 fps |
| 60000/1001 (59.94)    | 120                    | `120*(1001/60000)` = `120120/60000` ≈ 2.002 | High frame-rate NTSC |
| 60/1                  | 120                    | `120/60` = 2.0                             | Exact 60 fps |

Other segment durations work the same way—multiply the desired seconds by the frame rate, round to the nearest integer frame count, then compute the exact rational seconds from the frame count.

3. **Populate encoder settings**
   - `keyint = keyint_min = segment_frames`
   - `force_key_frames = expr:gte(t, n_forced * segment_seconds_exact)`
     - `segment_seconds_exact = segment_frames * denominator / numerator`. Example: `60060/30000`.
   - Set scene cut to 0 and open_gop to 0 so x264 cannot introduce stray IDRs.
   - Disable B-frames/rc-lookahead if we see the encoder still deviating.
4. **Guard rails**
   - If the requested segment duration is shorter than the source GOP interval *and* the user disables re-encoding, warn or refuse. We can only deliver template-friendly segments when we control keyframes.

### Implementation outline

1. **Transcoder settings service**
   - Add an “Auto Keyframing” toggle (default on). While it is enabled we compute keyframe/duration parameters from probed metadata, mark the advanced timing fields as system-managed, and ignore manual overrides from the API.
   - Store the rational `frame_rate` we probed so we can reuse it.
2. **Pipeline / encoder command builder**
   - If `auto_keyframes` is on:
     - Derive `segment_frames` as described.
     - Set `EncoderSettings.video.gop_size` and `keyint_min`.
     - Inject `force_key_frames` expression with the rational fraction.
     - Populate `x264-params` keys above.
     - Optionally bump audio `-ar` to match source if we ever support non-48 kHz content.
   - If auto is off:
     - Use stored settings or user overrides. We should still validate them (warn if they clash with the segment duration).
3. **UI**
   - Present an “Auto Keyframing (recommended)” toggle.
   - When enabled, render the dependent inputs (segment duration, GOP size, force keyframe expression, related `x264-params`) as disabled read-only fields with helper text explaining that the system is managing them.
   - When disabled, allow expert users to edit the raw fields (segment duration, GOP, force keyframe expression) with inline warnings and validation.
4. **Testing**
   - Unit tests for the math (rational frame rate inputs, odd segment durations, PAL/NTSC differences).
   - End-to-end tests on a sample 25 fps, 29.97 fps, 30 fps, 60 fps source to ensure generated commands yield constant segment durations.

## Recommendation: Auto-first, but overridable

Path (1) gives us the best of both worlds:

- **Auto Keyframing ON** (default): 99% of users get smooth playback with no manual tuning. The transcoder computes the right values per source file, so we stop publishing bad manifests.
- **Auto Keyframing OFF** (expert mode): anyone who intentionally needs odd GOP/segment pairings can toggle auto off, edit the advanced fields, and accept responsibility for the results. We can still run validation to highlight dangerous combinations.

Path (2) (no manual override) is simpler to maintain but could frustrate advanced users who need special-case behaviour (e.g. HLS fallback, archival workflows). Given the time we’ve spent debugging the defaults, having an auto guardrail plus an optional override feels like the right compromise.

## Checklist before shipping Auto mode

- [ ] Add `auto_keyframe_alignment` (or similar) setting in the database + API.
- [ ] Surface toggle and read-only derived values in the System Settings UI.
- [ ] Update encoder command builder to plug auto-derived values into `EncoderSettings`.
- [ ] Hold validation errors/warnings when auto is off and settings look unsafe.
- [ ] Update docs / onboarding to reference the new auto behaviour.

Once those tasks are complete we can rely on the automation for future ingest tests and use the debug `/media` endpoint to verify raw output quickly if anything goes sideways again.
