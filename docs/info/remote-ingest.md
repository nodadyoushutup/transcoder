# Remote Ingest Deployment Guide

## Overview

The ingest service publishes manifests and media segments under `/media/` so that browsers and TV apps can stream the output produced by the transcoder. Running the ingest component on a remote host lets you serve assets from a network location that is closer to viewers or backed by faster storage or CDN tooling while keeping the API, transcoder, and GUI on their existing nodes.

A remote ingest host participates in the following flow:

1. The transcoder writes manifests and segments via HTTP `PUT` and `DELETE` requests to the ingest service.
2. The API advertises absolute playback URLs based on `TRANSCODER_LOCAL_MEDIA_BASE_URL` so clients know where to fetch assets.
3. Players request manifests and segments from the remote ingest over HTTP or HTTPS. TLS termination is typically handled by a reverse proxy such as Nginx Proxy Manager (NPM) or a CDN edge.

## Preparing the ingest host

### Prerequisites

- Linux host (bare metal, VM, or container) with Python 3.10+ and `pip`.
- Stable disk or object storage mounted for the media output directory.
- Inbound firewall rule for the ingest port (defaults to `5005`) from the transcoder or API node or upstream proxy.

### Bootstrapping the service

1. Copy or clone the repository to the remote machine.
2. (Recommended) create a virtual environment inside `core/ingest` and install dependencies:
   ```bash
   cd core/ingest
   python3 -m venv venv
   ./venv/bin/pip install --upgrade pip
   ./venv/bin/pip install -r requirements.txt
   ```
3. Export the runtime configuration and launch the service:
   ```bash
   export TRANSCODER_API_URL=https://api.example.com
   export TRANSCODER_INTERNAL_TOKEN="super-secret-token"
   export TRANSCODER_INGEST_HOST=0.0.0.0
   export TRANSCODER_INGEST_PORT=5005
   export INGEST_OUTPUT_DIR=/srv/transcoder/media
   export INGEST_LOG_DIR=/var/log/transcoder-ingest
   ./venv/bin/python -m pip install gunicorn  # if not already present
   core/ingest/scripts/run.sh
   ```
   - `TRANSCODER_API_URL` points the ingest service at the main API so it can pull the canonical output path from the system settings database.
   - `TRANSCODER_INTERNAL_TOKEN` must match the value configured for the API process; it authenticates internal requests to the `/internal/settings` endpoint.
   - `INGEST_OUTPUT_DIR` remains available as a fallback when the API is unreachable, but once connectivity is restored the database value supersedes it.
   - `INGEST_LOG_DIR` controls where Gunicorn writes access and error logs. Review the newest file in that directory after each deploy to confirm healthy traffic.
   - `INGEST_GUNICORN_WORKERS`, `INGEST_GUNICORN_WORKER_CLASS`, and `INGEST_GUNICORN_WORKER_CONNECTIONS` allow per-host tuning. The script defaults to `eventlet` workers with a starting connection pool of `CPU_CORES * 200`.
4. (Optional) Wrap the script in a process supervisor (systemd, Docker, PM2) so the service restarts automatically.

### Fronting with HTTPS

Expose the ingest endpoint through a reverse proxy or CDN so viewers negotiate TLS. NPM works well:

- Forward `ingest.example.com` to the remote host and port `5005`.
- Enable HTTP/2 and WebSocket support (the ingest service itself does not use WebSockets, but sharing a proxy template keeps the configuration consistent).
- If the proxy runs in a different network, ensure it can reach the ingest host over plain HTTP.

## Connecting the rest of the stack

### API and transcoder

On the API or transcoder node, point the publishing pipeline at the remote ingest before launching `core/api/scripts/run.sh`:

```bash
export TRANSCODER_PUBLISH_BASE_URL=https://ingest.example.com/media/
export TRANSCODER_LOCAL_MEDIA_BASE_URL=https://ingest.example.com/media/
export TRANSCODER_INTERNAL_TOKEN="super-secret-token"
core/api/scripts/run.sh
```

- `TRANSCODER_PUBLISH_BASE_URL` controls where the transcoder performs authenticated uploads (PUT and DELETE). Use the HTTPS URL if the ingest host sits behind TLS; the API will forward the correct credentials.
- `TRANSCODER_LOCAL_MEDIA_BASE_URL` ensures playback URLs in API responses match the viewer-facing hostname so browsers never see private IPs.
- `TRANSCODER_INTERNAL_TOKEN` exposes the same shared secret the ingest and transcoder services use when requesting settings from the API. Choose a random value and keep it private.

### GUI and player configuration

When launching the control panel or any embedded player, advertise the same ingest origin:

```bash
GUI_BACKEND_URL=https://api.example.com \
GUI_INGEST_URL=https://ingest.example.com \
core/gui/scripts/run.sh
```

The GUI then requests manifests and media segments directly from the remote ingest while keeping authenticated API calls pointed at the main backend.

### Service-to-service settings sync

Both the ingest and transcoder microservices now fetch their runtime configuration from the API on startup. Ensure each host exports the following variables before launching `core/ingest/scripts/run.sh` or `core/transcoder/scripts/run.sh`:

```bash
export TRANSCODER_API_URL=https://api.example.com
export TRANSCODER_INTERNAL_TOKEN="super-secret-token"
```

The token must match the value supplied to the API. When the API is unreachable the services fall back to any locally provided environment overrides, but as soon as the API responds the database value becomes authoritative.

### Validation loop

1. Start the remote ingest and confirm it is reachable: `curl -I https://ingest.example.com/media/` should return `200` or `403` depending on auth settings.
2. Launch the API and transcoder with the environment overrides above.
3. Trigger an encode via the dashboard or API so the transcoder publishes using the database-backed settings. When the job starts, inspect the newest entry under `core/transcoder/logs/` and the ingest log under `INGEST_LOG_DIR` to confirm the PUT and DELETE operations hit the remote host.

## Capacity planning and sizing

The ingest role is primarily network and filesystem bound. Gunicorn with the default `eventlet` workers scales well for concurrent keep-alive connections, while CPU use stays modest because the service streams files instead of transcoding them. Plan for peak bitrate, viewer count, and storage retention.

### Baseline recommendations

| Deployment tier | Suggested host | Estimated concurrent 1080p viewers* | Notes |
| ---------------- | -------------- | ----------------------------------- | ----- |
| Lab or staging | 2 vCPU, 2 GB RAM, SATA SSD, 1 Gbps NIC | ~50 | Adequate for QA streams up to 6 Mbps each. Increase worker connections if you see 429 or 503 responses. |
| Mid-size production | 4 vCPU, 8 GB RAM, NVMe SSD, 1-2 Gbps NIC | ~150 | Keep eventlet workers (4) with default connections (800). Monitor disk I/O and free space for 3-6 hour retention windows. |
| Large edge | 8 vCPU, 16 GB RAM, NVMe SSD or RAM disk cache, bonded 2+ Gbps | ~300 | Consider fronting with a CDN or HTTP cache, raise `INGEST_GUNICORN_WORKERS` to 8, and ensure upstream bandwidth matches aggregate bitrate. |

*Assumes a sustained 1080p ladder around 6 Mbps. Reduce expectations proportionally for higher bitrates or allocate more bandwidth and headroom when you publish multiple renditions.

### Additional sizing tips

- **Bandwidth rules everything**: peak concurrent viewers are roughly `(available egress Mbps) / (target rendition Mbps)`. Always keep 20-30% headroom so new sessions do not stall existing viewers.
- **Disk throughput**: place `INGEST_OUTPUT_DIR` on SSD or NVMe storage. HDD-only setups suffer when the transcoder frequently updates manifests across many renditions.
- **CPU tuning**: if TLS terminates on the ingest machine instead of a proxy, allocate at least one additional vCPU for cryptography and switch to `gthread` workers with more threads (`INGEST_GUNICORN_THREADS=16`).
- **Scaling out**: for audiences beyond a few hundred viewers, deploy multiple ingest nodes behind a CDN or geo-balanced proxy and point `TRANSCODER_PUBLISH_BASE_URL` at an object store or WebDAV cluster that replicates content across edges.

## Maintenance checklist

- Rotate logs in `INGEST_LOG_DIR` and monitor for `4xx` or `5xx` spikes that could indicate proxy or auth drift.
- Prune old media segments if you extend the retention window; the ingest service does not automatically expire files outside the transcoder's trimming logic.
- Keep the ingest virtual environment updated with security patches (`pip install --upgrade -r requirements.txt`).
- Re-run an encode through the API or GUI after modifying proxy rules or TLS settings to confirm uploads still succeed.

With a remote ingest in place you can keep the CPU-intensive transcoder close to your media sources while pushing playback traffic to infrastructure that is tuned for HTTP delivery and horizontal scale.
