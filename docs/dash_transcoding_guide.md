# Smooth DASH Transcoding Guide

This guide walks you through how the transcoder keeps DASH playback smooth, why segment timing matters, and what knobs you can tweak when you need custom behaviour.

## Why keyframe cadence matters

DASH players fetch fixed-duration fragments (segments). If a segment claims to span 2 seconds but the underlying video fragment actually lasts 4 seconds, the player stalls waiting for the rest of the data to arrive. That is exactly what happens when FFmpeg’s dash muxer cannot cut on the desired boundaries—usually because the encoder never produced a keyframe at the requested timestamp.

To guarantee 2-second segments we must:

1. **Know the source frame rate** (e.g. 30000/1001 ≈ 29.97 fps).
2. **Force the encoder to emit an IDR every N frames** where `N = segment_duration_seconds * frame_rate`.
3. **Use that exact cadence inside the dash muxer** so each fragment aligns with the encoder’s GOP.

If we skip any of those steps, VLC and browser players will buffer every time they hit a “long” fragment.

## Auto Keyframing (recommended)

The transcoder now includes an **Auto Keyframing** switch (enabled by default). When it’s on:

- The service probes your source with `ffprobe` and reads the precise frame rate as a rational fraction (e.g. `30000/1001`).
- It computes the segment cadence automatically. For the default 2-second segments we round `segment_frames = segment_duration * frame_rate` to the nearest whole frame:

  | Source fps      | Frames per 2 s segment | Exact seconds used |
  |-----------------|------------------------|--------------------|
  | 24000/1001      | 48                     | 48048/24000 ≈ 2.002 |
  | 25              | 50                     | 50/25 = 2.0         |
  | 30000/1001      | 60                     | 60060/30000 ≈ 2.002 |
  | 30              | 60                     | 60/30 = 2.0         |
  | 60000/1001      | 120                    | 120120/60000 ≈ 2.002 |
  | 60              | 120                    | 120/60 = 2.0        |

- It injects matching encoder arguments:
  - `-c:v libx264 -preset veryfast -b:v …` (or another codec if configured)
  - `-x264-params 'keyint={segment_frames}:min-keyint={segment_frames}:scenecut=0:open-gop=0:intra-refresh=0:rc-lookahead=0:bf=0'`
  - `-r <frame_rate>` and `-g <segment_frames>`
  - `-force_key_frames 'expr:gte(t,n_forced*{segment_seconds_exact})'`
- It locks the dash muxer to the same cadence (`-seg_duration`, `-frag_duration`, timeline/template flags).
- The UI disables the manual timing fields so you can’t accidentally create mismatched settings. You’ll still see the derived values for reference.

With Auto Keyframing enabled you should never see the “stall every few chunks” behaviour we debugged—regardless of the source file’s original GOP layout.

## Expert mode (Auto Keyframing OFF)

There are rare cases where you might want to override the cadence (e.g. experimenting with longer segments or a different muxer). When you toggle Auto Keyframing off:

- The segment duration, GOP size, `force_key_frames` expression, and any codec-specific parameters become editable.
- The UI will warn you if the numbers look unsafe (for example, if your GOP is shorter than the requested segment duration).
- The transcoder will still publish whatever you ask for, so it’s your responsibility to keep the math consistent. If you copy/paste values, remember the three rules from above.

**Tip:** If you need 4-second segments for a special workflow, set `segment_duration=4`, let Auto compute the cadence, then turn Auto off and adjust the bitrate or other settings. Re-enable Auto when you are done so the next job goes back to safe defaults.

## How to verify your output

1. Inspect the manifest (`audio_video.mpd` by default). Under each `SegmentTimeline` the `d=` values should be identical for the video representation. For the 2-second default you’ll see `d="60060"` when the timescale is 30000.
2. Spot-check a few segment files on disk. There should be no gaps (e.g. `chunk-0-00037.m4s` followed immediately by `chunk-0-00038.m4s`).
3. Optional: play the stream through the debug `/media` endpoint (or a simple `python -m http.server`). If the manifest is clean, VLC and browser players should start and continue without pauses after the initial buffer.

## When to tweak segment duration

- **Lower latency**: Use smaller segments (e.g. 1 s). The auto calculation will set GOP/keyframe cadence to match, but remember that smaller segments increase HTTP overhead.
- **Higher throughput / archival**: Use larger segments (e.g. 4 s or more) if your player supports it. Auto Keyframing will increase the GOP accordingly.

After changing the segment duration, leave Auto Keyframing on so FFmpeg continues to respect the new cadence.

## Summary

- Auto Keyframing keeps DASH live streams smooth by matching FFmpeg’s keyframe cadence to the segment duration derived from your source’s frame rate.
- Leave Auto Keyframing on unless you have a specific reason to experiment—then toggle it off temporarily and double-check your math.
- Use the manifest/segment checks above whenever you diagnose playback issues. If the video entries are anything other than steady 2-second durations (or the correct value for your chosen segment length), the player will buffer.

Following these steps lets you focus on the content, not on fighting dash segment math. Happy transcoding!
