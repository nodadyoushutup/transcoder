# HTTP/2 Integration Guide

This document explains what HTTP/2 brings to the table for the dash-transcoder stack, how to enable it natively, and how to front the services with Nginx Proxy Manager (NPM) in both local and hybrid deployments.

## Why HTTP/2 matters here

- Multiplexes many small manifest and segment requests down a single TCP connection, which keeps latency low when players pull DASH windows from the ingest service.
- Reduces head-of-line blocking for the GUI assets, REST API calls, and artwork thumbnails served by the API.
- Enables header compression and connection reuse, which helps when the control panel issues several parallel requests (auth, Plex metadata, transcoder status).
- Plays nicely with TLS-first deployments; modern browsers only negotiate HTTP/2 over HTTPS, so enabling it dovetails with tightening transport security.

## Native HTTP/2 in the API

The Flask API can serve HTTP/2 directly through Hypercorn.

1. Generate (or provision) a TLS certificate and key that the API can read.
2. Export the HTTP/2 environment variables before launching the API:
   ```bash
   TRANSCODER_HTTP2_ENABLED=1 \
   TRANSCODER_HTTP2_CERT=/absolute/path/to/fullchain.pem \
   TRANSCODER_HTTP2_KEY=/absolute/path/to/privkey.pem \
   core/api/scripts/run.sh
   ```
3. Optional tuning knobs:
   - `TRANSCODER_HTTP2_PORT` (defaults to `5443`)
   - `TRANSCODER_HTTP2_WORKERS` (defaults to CPU cores)
   - `TRANSCODER_HTTP2_KEEPALIVE`, `TRANSCODER_HTTP2_LOG_LEVEL`, `TRANSCODER_HTTP2_ACCESS_LOG`, `TRANSCODER_HTTP2_ERROR_LOG`
   - `TRANSCODER_HTTP2_RELOAD=1` for auto-reload during development
4. Point the GUI or any client at the HTTPS origin, for example:
   ```bash
   VITE_BACKEND_URL=https://localhost:5443 core/gui/scripts/run.sh
   ```

Hypercorn terminates TLS and advertises `h2` over ALPN. Back-end connections to the transcoder, Celery, and ingest services remain unchanged.

## Using Nginx Proxy Manager

Enabling HTTP/2 on Nginx Proxy Manager affects the client-facing side; NPM terminates TLS and usually talks HTTP/1.1 to your upstreams. That is perfectly fine—your services do not need to change anything to benefit from HTTP/2 at the edge.

Prerequisites:

- A domain (or LAN hostname) that resolves to the NPM instance.
- TLS certificates issued through NPM (Let’s Encrypt or custom uploads). HTTP/2 requires HTTPS.
- Forwarded ports from your router to the NPM container/host if you want external access.

To create an HTTP/2-enabled Proxy Host in the NPM UI:

1. `Proxy Hosts → Add Proxy Host`.
2. Enter the domain(s) you want to expose (e.g. `api.example.com`, `ingest.example.com`).
3. Set the scheme and upstream:
   - Scheme: `http`
   - Forward Hostname / IP: where the service lives (see scenarios below)
   - Forward Port: service port (API `5001`, Transcoder `5003`, Ingest `5005`, GUI `5173` by default)
4. Toggle the following options under **Advanced**:
   - **Cache Assets** (optional, but useful for GUI)
   - **Block Common Exploits** (recommended)
   - **Websockets Support** (required for the API’s Socket.IO)
   - **HTTP/2 Support** (this is the key toggle)
5. Under the SSL tab, request or provide a certificate and enable **Force SSL** + **HTTP/2 Support** (again) so browsers are redirected to HTTPS.
6. Save the proxy host.

NPM now negotiates HTTP/2 with clients while speaking HTTP/1.1 to the services.

## Scenario: All services local behind NPM

This setup is handy when you run the entire stack on a workstation but want friendly HTTPS URLs.

1. Start each service with the standard scripts:
   ```bash
   core/ingest/scripts/run.sh
   core/transcoder/scripts/run.sh
   core/api/scripts/run.sh
   core/gui/scripts/run.sh
   ```
2. Determine how NPM reaches the host:
   - If NPM runs via Docker on macOS/Windows, use `host.docker.internal`.
   - If NPM runs via Docker on Linux, use the Docker bridge IP (commonly `172.17.0.1`) or bind the containers to `--network host`.
   - If NPM runs directly on the same machine, use `127.0.0.1`.
3. Create proxy hosts:
   - `api.local.example` → forward to host port `5001`.
   - `gui.local.example` → forward to host port `5173`.
   - `ingest.local.example` → forward to host port `5005`.
4. In the GUI runner, point to the proxied URLs so CORS stays aligned:
   ```bash
   VITE_BACKEND_URL=https://api.local.example \
   VITE_INGEST_URL=https://ingest.local.example \
   core/gui/scripts/run.sh
   ```
5. For the API → ingest hand-off, either leave `TRANSCODER_LOCAL_MEDIA_BASE_URL` unset (the API advertises the ingest host you provide at runtime) or override it with the proxied HTTPS URL if you want clients to consume assets through NPM.

With this configuration, browsers negotiate HTTP/2 with NPM, and NPM forwards traffic over HTTP/1.1 to the services running locally.

## Scenario: Remote ingest, API + GUI local

When the ingest service runs on a remote machine (or CDN) but the API and GUI stay local:

1. Run the ingest service remotely (for example, on a VPS). Ensure port `5005` or your chosen port is reachable from NPM.
2. On the remote ingest host, consider placing it behind its own NPM instance or vanilla Nginx that terminates TLS. If you keep it plain HTTP, the central NPM instance can still terminate TLS as long as it can reach the remote host over HTTP.
3. Launch local services:
   ```bash
   core/transcoder/scripts/run.sh
   core/api/scripts/run.sh
   core/gui/scripts/run.sh
   ```
4. Configure the API so it points at the remote ingest location:
   ```bash
   TRANSCODER_PUBLISH_BASE_URL=https://ingest.example.com/media/ \
   TRANSCODER_LOCAL_MEDIA_BASE_URL=https://ingest.example.com/media/ \
   core/api/scripts/run.sh
   ```
   - `TRANSCODER_PUBLISH_BASE_URL` tells the transcoder where to PUT new segments if the ingest host expects authenticated uploads or sits behind HTTPS.
   - `TRANSCODER_LOCAL_MEDIA_BASE_URL` ensures clients receive URLs that resolve through the proxy.
5. In NPM, create two proxy hosts:
   - `api.example.com` → forward to the local API (`127.0.0.1:5001` or equivalent)
   - `ingest.example.com` → forward to the remote ingest (`ingest-remote.internal:5005`)
   Toggle HTTP/2 support for each.
6. Start the GUI with the remote ingest URL so the player requests media via the proxy:
   ```bash
   VITE_BACKEND_URL=https://api.example.com \
   VITE_INGEST_URL=https://ingest.example.com \
   core/gui/scripts/run.sh
   ```

The API continues to talk to the transcoder over HTTP inside your LAN, but clients load manifests and segments from the remote ingest through NPM over HTTP/2.

## Verifying HTTP/2

- Command line: `curl --http2 -I https://api.example.com` should report `HTTP/2 200`.
- Browser DevTools: check the **Protocol** column under Network to confirm `h2`.
- Logs: inspect the latest files under `core/api/logs` and `core/ingest/logs` to confirm successful requests. NPM access logs should also list `HTTP/2.0` once the toggle is active.

## Troubleshooting tips

- **Handshake fails**: confirm the certificate/key pair matches the domain and that NPM has permission to read them.
- **Mixed-content warnings**: force HTTPS in NPM and ensure environment variables advertise HTTPS URLs (e.g. `TRANSCODER_LOCAL_MEDIA_BASE_URL`).
- **WebSocket disconnects**: enable **Websockets Support** in NPM so Socket.IO upgrades from polling.
- **Ingest PUT failures**: when terminating TLS at NPM, make sure the upstream allows chunked uploads and that credentials match (`TRANSCODER_PUBLISH_BASE_URL` should use HTTPS and the proxied hostname).

HTTP/2 at the proxy edge gives you faster clients without requiring the downstream services to change protocols. Use the native Hypercorn path when you want end-to-end HTTP/2, and rely on NPM when you just need a browser-friendly TLS/H2 front door.
