# Transcoder encode helpers

The standalone FFmpeg smoke-test scripts have been retired. Trigger encodes through the API or dashboard so the transcoder respects the database-backed System Settings, then review the resulting output under `core/transcoder/logs/`.

Use `core/transcoder/scripts/run.sh` when you need to run the microservice in isolation; orchestrated runs will emit the live FFmpeg command in the corresponding log file.
