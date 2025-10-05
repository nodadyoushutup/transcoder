# Voice Chat Planning

## Goals & Scope

- Introduce a real-time group voice channel that lives alongside the existing stream player UI.
- Reuse authentication, session management, and logging patterns from the current Flask API and React GUI.
- Favor WebRTC via a Selective Forwarding Unit (SFU) to minimize per-user bandwidth and avoid running a heavy MCU.
- Leverage Redis for low-latency state (presence, signaling hints, voice settings cache) while keeping durable configuration in Postgres.
- Deliver a cohesive UX: join flow, microphone permissions, participant list, and voice-specific settings accessible from StreamPage and the global settings modal.

## Current Architecture Touchpoints

| Area | Notes |
| --- | --- |
| `core/gui/src/pages/StreamPage.jsx` | Renders the tab-based UI where the Voice panel will live. Existing context providers handle auth + stream metadata. |
| `core/gui/src/components` | Houses reusable panels; potential home for a `VoiceChatPanel` component and modal fragments. |
| `core/api` | Flask blueprint routing; extend with voice signaling endpoints, tokens, and settings APIs. |
| `core/api/src/transcoder` | Shared Python package; keep voice logic separate but reuse config patterns (e.g., `.env`, logging helpers). |
| Redis (planned) | Already part of the deployment; expand usage for voice presence, ephemeral session data, and pub/sub triggers. |
| Postgres (existing) | Stores user accounts; add durable voice preferences per user/stream. |

## Architectural Strategy

### Components

- **Voice SFU**: Deploy a managed SFU (e.g., LiveKit, mediasoup, Janus) or self-hosted option. It handles RTP, audio routing, and active-speaker detection.
- **API Signaling Layer**: Flask service issues short-lived access tokens, orchestrates room membership, and publishes presence changes to Redis for GUI consumption.
- **Redis Backbone**:
  - `voice:rooms:<stream_id>` hash for metadata (title, host controls, current mode).
  - `voice:presence:<stream_id>` sorted set keyed by user ID → last heartbeat timestamp.
  - Pub/Sub channels (`voice:events:<stream_id>`) for join/leave notifications and VAD updates if sourced from SFU webhooks.
  - Optional `voice:settings:<user_id>` cached object for rapid retrieval of mix/mute preferences across sessions.
- **GUI Voice Panel**: React tab that acquires mic permissions, connects to the SFU using credentials from the API, and reflects live presence via Redis-backed endpoints.
- **System Settings Extension**: Voice section in the settings modal with device selection, default mute state, input gain, and push-to-talk preferences stored via the API.

### Data Flow (Happy Path)

1. Viewer authenticates with the existing session cookie.
2. GUI loads stream metadata, detects voice availability, and renders a disabled "Join Voice" button until assets load.
3. On click, GUI requests a `GET /api/voice/streams/<id>/join` endpoint.
4. API validates permissions, writes presence entry to Redis, persists updated membership in Postgres (`voice_members` table), and returns:
   - SFU URL / room ID
   - Participant roster snapshot (from Redis)
   - Short-lived JWT/credential signed with SFU secret.
5. GUI prompts for mic access via `navigator.mediaDevices.getUserMedia({ audio: true })`.
6. On approval, GUI hands audio track to SFU client SDK, subscribes to active speakers, and renders them in the panel.
7. Periodic heartbeats keep Redis presence current; disconnects trigger cleanup.

## Backend Workstreams

### 1. Signaling & Membership

- Add a `voice` blueprint in `core/api/src/views` with join/leave/heartbeat routes and REST endpoints for fetching room rosters.
- Introduce Celery or background tasks if we need to expire stale Redis presence entries; otherwise a simple TTL sweep can run via cron/management command.
- Model additions:
  - `voice_rooms` table keyed by stream ID (FK) with columns for max speakers, created_at, host_id, and SFU room reference.
  - `voice_members` table capturing user membership, join timestamps, and optional role (host, moderator).
- Use Redis pub/sub to notify GUI clients about membership changes without polling; the API can expose a Server-Sent Events endpoint or WebSocket gateway that bridges Redis events.

### 2. Token & Credential Management

- Store SFU API credentials in `core/api/.env` with entries surfaced in `docs/golden-settings.md` when finalized.
- Implement a helper under `core/api/src/voice/tokens.py` to mint signed tokens for the SFU; ensure alignment with existing config loaders in `transcoder/config.py`.
- Cache issued tokens in Redis with TTL to allow revoke-on-logout semantics.

### 3. Settings API

- Extend `core/api/src/models/user_settings.py` (or create) to persist voice defaults (auto-join, mute on join, preferred input device ID, push-to-talk hotkey).
- Add REST endpoints (`GET/PUT /api/settings/voice`) consumed by the GUI System Settings panel.
- Synchronize Redis cache on update so live participants see the change without full reload.

### 4. Monitoring & Logs

- Follow the existing logging split: write voice-specific logs to `core/api/logs/voice-*.log` and SFU integration logs to `core/transcoder/logs` if the transcoder service ever assists with recordings.
- Capture Redis latency metrics and SFU room statistics (active speakers, packet loss). Pipeline them to the same monitoring stack used for transcoding jobs.

## GUI Integration Plan

### StreamPage Voice Tab

- Introduce a new tab entry `Voice` in `StreamPage.jsx` that mounts a lazy-loaded `VoiceChatPanel`.
- `VoiceChatPanel` responsibilities:
  - Render join/disconnect button and microphone permission state.
  - Display participant list with active-speaker indicator sourced from SFU SDK callbacks.
  - Expose mute/unmute, push-to-talk toggle, and input device selector (respecting defaults from settings API).
  - Show connection status, e.g., ping, packet loss, using telemetry returned by the SFU.
- Utilize existing React Query setup (if present) or add a dedicated client to poll `GET /api/voice/streams/<id>/state` with ETag / SSE fallback.
- Persist ephemeral UI state (e.g., current speaking indicator) in component state; for shareable data rely on Redis-backed APIs.

### System Settings: Voice Section

- Extend the global settings modal (likely under `core/gui/src/components/settings`) with a `Voice` tab/panel.
- Fetch `GET /api/settings/voice` on modal open and pre-fill controls for default mute state, device preference, push-to-talk keybind, noise suppression toggle.
- When submitting updates, optimistically update local state and push to Redis cache via the API response to avoid flashing outdated UI.

### Iconography & UX Notes

- Add a microphone icon to the StreamPage tab bar; ensure the icon library (likely Lucide or similar) contains a consistent style.
- Provide status chips (Connected, Muted, Speaking) mirrored between the player HUD and the panel to keep the experience cohesive.
- When a user leaves the page or stream ends, trigger a cleanup call to `/api/voice/streams/<id>/leave` and disconnect the SFU client.

## Redis Usage Patterns

- **Presence**: Sorted set with timestamps allows quick eviction of stale users (`ZREMRANGEBYSCORE`).
- **Room Metadata**: Hash storing host controls, slow mode flags, and pinned speakers. Replicate to Postgres asynchronously for durability.
- **Pub/Sub**: Channels for membership updates, moderator actions (mute someone), and voice setting changes; the GUI can subscribe via WebSocket gateway.
- **Rate Limiting**: Use Redis tokens to throttle rapid mute/unmute toggles or message spam in future voice text chat overlay.
- **Caching**: Short-lived caches of SFU tokens and device capability checks to reduce load on third-party services.

## Operational Considerations

- **Bandwidth Expectations**: Opus @ 48 kbps upstream per user; downstream scales with concurrent speakers (~200 kbps for 4 active participants). Plan SFU autoscaling for peak concurrency.
- **Server Overhead**: API handles lightweight signaling; heavy lifting stays on SFU. Redis CPU usage may spike with large rooms—enable clustering or sharding if we approach thousands of concurrent members.
- **Resilience**: Implement reconnect logic in GUI; if Redis or SFU connection drops, show banner and attempt exponential backoff reconnects.
- **Security**: Scope tokens per room, enforce permissions (hosts can mute/kick). Log join/leave events with user IDs for auditing.

## Testing & Validation Checklist

1. Unit-test token generation and Redis presence helpers in `core/api`.
2. Integration tests using a mocked SFU SDK to verify join/leave flows and permission enforcement.
3. GUI Cypress tests covering join flow, mic permission denial path, and settings persistence.
4. Manual smoke: run `core/api/scripts/run.sh`, start GUI, use test SFU sandbox, verify logs under `core/api/logs/voice-*.log` and `core/gui/logs` record events.
5. Load-test signaling with scripted clients to ensure Redis and API remain responsive at target concurrency.

## Phased Roadmap

1. **Phase 0** – Finalize SFU provider choice, provision dev credentials, and stub API endpoints returning mock data for GUI development.
2. **Phase 1** – Implement Redis presence + API join/leave; create GUI voice tab with mocked SFU integration.
3. **Phase 2** – Integrate live SFU SDK, add settings persistence, and wire pub/sub updates.
4. **Phase 3** – Harden with monitoring, autoscaling hooks, and moderator tools (force mute, speaker limits).
5. **Phase 4** – Consider recording/archival features, transcription, or voice-to-text overlays using the transcoder stack.

## Open Questions

- Which SFU stack aligns best with our deployment constraints and licensing? (LiveKit self-hosted vs. managed service)
- Do we need voice chat on mobile browsers (Safari iOS limitations)? Define minimum supported platforms.
- How do we expose voice channel availability to the API clients that embed the player? (e.g., new field in stream metadata)
- Should voice settings sync across devices instantly or on next login? (Impacts Redis vs Postgres source of truth)
- Is there a requirement for recording or moderation logging beyond basic auditing?

Keeping these notes current will accelerate implementation once we prioritize the feature. Update this document as decisions solidify and reference the relevant log files per iteration of the development loop.
