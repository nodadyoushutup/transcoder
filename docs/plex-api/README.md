# Plex HTTP API Reference

This document captures the most commonly used Plex Media Server HTTP endpoints so we can reason about future integrations without scraping community wikis. It focuses on the local server API that listens on `http(s)://<plex-host>:32400` and the plex.tv relay endpoints that surface account-level data.

> The Plex API is not officially frozen. Fields, resource paths, and required headers can change between versions. Treat this as a living document and verify against your running server before shipping production code.

## Reading This Document

- Every endpoint lists the HTTP method, path, short behavior summary, and the query parameters you can supply. Required parameters are tagged `required`; optional parameters show the default when Plex supplies one.
- Unless stated otherwise, include `X-Plex-Token` (required when the server enforces authentication). Device metadata headers such as `X-Plex-Client-Identifier`, `X-Plex-Product`, `X-Plex-Version`, and `X-Plex-Platform` are omitted for brevity but should accompany most remote requests.
- All responses are XML unless you request JSON with `Accept: application/json` or operate on plex.tv endpoints that already return JSON.

## Server & Account Discovery

**GET /identity**  
Returns the current server's `machineIdentifier`, version, and advertised capabilities.  
Query parameters:
- `X-Plex-Token` (optional; required if the server restricts unauthenticated discovery; default: none)

**GET /servers** (plex.tv)  
Lists Plex Media Servers shared with the authenticated account.  
Query parameters:
- `X-Plex-Token` (required)
- `includeLite` (optional; default: `1`) – Return a reduced payload when set to `1`.
- `includeHttps` (optional; default: `1`) – Include HTTPS-capable connection URIs.

**GET /resources** (plex.tv)  
Returns a superset of devices (servers, players, managed users).  
Query parameters:
- `X-Plex-Token` (required)
- `includeHttps` (optional; default: `1`)
- `includeRelay` (optional; default: `1`)
- `includeManaged` (optional; default: `1`)
- `includeInactive` (optional; default: `0`)

**GET /clients**  
Lists players currently paired with the server.  
Query parameters:
- `X-Plex-Token` (optional; required when the server is secured)

**GET /devices.xml** (plex.tv)  
Legacy device directory for the signed-in account.  
Query parameters:
- `X-Plex-Token` (required)

**POST /myplex/account/signin** (plex.tv)  
Authenticates a Plex account and returns an auth token. Use only for tooling (Plex now prefers OAuth).  
Query parameters: none  
Form fields:
- `user[login]` (required) – Username or email.
- `user[password]` (required)
- `rememberMe` (optional; default: `false`)

## Sessions & Activity

**GET /status/sessions**  
Active playback sessions with metadata, stream bitrates, and transcode state.  
Query parameters:
- `X-Plex-Token` (optional; required on secured servers)

**GET /status/sessions/history/all**  
Complete playback history with filters.  
Query parameters:
- `X-Plex-Token` (required)
- `accountID` (optional; default: all accounts)
- `librarySectionID` (optional; default: all sections)
- `type` (optional; default: all item types)
- `startAt` (optional; default: server-defined start of dataset)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)
- `sort` (optional; default: `viewedAt:desc`)

**GET /status/sessions/history/{ratingKey}**  
Playback history for a specific item.  
Query parameters:
- `X-Plex-Token` (required)
- `accountID` (optional; default: all accounts)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)

**GET /status/sessions/history/status**  
Aggregated playback metrics grouped by day.  
Query parameters:
- `X-Plex-Token` (required)
- `window` (optional; default: `all`) – One of `day`, `week`, `month`, `year`, `all`.
- `sort` (optional; default: `viewedAt:desc`)

**GET /status/sessions/activity/{id}**  
Detailed context for a session ID, including timeline and bitrate.  
Query parameters:
- `X-Plex-Token` (required)

**POST /:/timeline**  
Used by Plex clients to push timeline/progress updates to the server.  
Query parameters:
- `X-Plex-Token` (required)
- `key` (optional; required when `ratingKey` is omitted) – Item key (`/library/metadata/<ratingKey>`).
- `ratingKey` (optional; required when `key` is omitted)
- `time` (required) – Current playback position in milliseconds.
- `duration` (optional; default: `0`) – Total media length in milliseconds.
- `state` (required) – `playing`, `paused`, or `stopped`.
- `X-Plex-Client-Identifier` (required) – Client device ID.
- `X-Plex-Device-Name` (optional; default: none)
- `hasMDE` (optional; default: `0`) – Flag to indicate metadata enhancements present.

**POST /:/scrobble** / **POST /:/unscrobble**  
Marks an item as watched (`scrobble`) or unwatched (`unscrobble`).  
Query parameters:
- `X-Plex-Token` (required)
- `key` (optional; required when `identifier` is omitted)
- `identifier` (optional; alternative to `key` for certain agents)
- `ratingKey` (optional; accepted by newer servers)
- `X-Plex-Client-Identifier` (required)

**POST /:/progress**  
Persists partial playback progress.  
Query parameters:
- `X-Plex-Token` (required)
- `key` (optional; required when `ratingKey` is omitted)
- `ratingKey` (optional; required when `key` is omitted)
- `time` (required) – Playback offset in milliseconds.
- `state` (required) – `playing`, `paused`, or `buffering`.
- `duration` (optional; default: `0`)
- `X-Plex-Client-Identifier` (required)

## Library Navigation (Read)

**GET /library/sections**  
Enumerates all libraries on the server.  
Query parameters:
- `X-Plex-Token` (required on secured servers)
- `includeLocation` (optional; default: `0`) – Include filesystem paths.
- `includeTypeCount` (optional; default: `0`)

**GET /library/sections/{sectionKey}**  
Returns metadata and preferences for a single library.  
Query parameters:
- `X-Plex-Token` (required)
- `includeLocation` (optional; default: `0`)
- `includePreferences` (optional; default: `0`)

**GET /library/sections/{sectionKey}/all**  
Full listing of items in a library section.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (optional; default: section default)
- `genre`, `year`, `title`, `label`, etc. (optional filters; default: none)
- `unwatched` (optional; default: `0`)
- `sort` (optional; default: `addedAt:desc`)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)
- `includeGuids` (optional; default: `0`)
- `includeMarkers` (optional; default: `0`)

**GET /library/sections/{sectionKey}/recentlyAdded**  
Items ordered by import date.  
Query parameters:
- `X-Plex-Token` (required)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)
- Additional filters (`type`, `unwatched`, etc.) match those from `/all`.

**GET /library/sections/{sectionKey}/onDeck**  
Next-up episodes or partially watched movies for the section.  
Query parameters:
- `X-Plex-Token` (required)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)

**GET /library/sections/{sectionKey}/collection**  
Collections defined inside a library.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (optional; default: all collections)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)

**GET /library/sections/{sectionKey}/search**  
Section-scoped search. Supports the same filters used by the web app.  
Query parameters:
- `X-Plex-Token` (required)
- `query` (optional; default: empty)
- `type` (optional; default: section default)
- `year`, `actor`, `album`, `label`, etc. (optional filters)
- `sort` (optional; default: `relevance:desc`)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `20`)

**GET /library/search**  
Global search across all libraries.  
Query parameters:
- `X-Plex-Token` (required)
- `query` (required)
- `type` (optional; default: all types)
- `limit` (optional; default: `20` per hub)
- `includeGuids` (optional; default: `0`)

**GET /hubs/home**  
Aggregated hubs for the Plex home screen.  
Query parameters:
- `X-Plex-Token` (required)
- `X-Plex-Language` (optional; default: server locale)
- `count` (optional; default: `10`) – Number of items per hub.
- `includeMeta` (optional; default: `1`)

**GET /hubs/search**  
Search hubs suitable for UI auto-complete.  
Query parameters:
- `X-Plex-Token` (required)
- `query` (required)
- `limit` (optional; default: `10`)

**GET /library/onDeck**  
On Deck entries consolidated across every library.  
Query parameters:
- `X-Plex-Token` (required)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)

## Library Metadata (Read)

**GET /library/metadata/{ratingKey}**  
Primary metadata for an item.  
Query parameters:
- `X-Plex-Token` (required)
- `includeGuids` (optional; default: `0`)
- `includeMarkers` (optional; default: `0`)
- `includePreferences` (optional; default: `0`)
- `X-Plex-Language` (optional; default: server locale)
- `checkFiles` (optional; default: `0`) – Adds file availability data.

**GET /library/metadata/{ratingKey}/children**  
Fetches episodes, tracks, or child items.  
Query parameters:
- `X-Plex-Token` (required)
- `sort` (optional; default: `index:asc`)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)

**GET /library/metadata/{ratingKey}/grandchildren**  
Convenience helper that jumps directly to grandchildren (e.g., show → episodes).  
Query parameters:
- `X-Plex-Token` (required)
- `sort` (optional; default: `index:asc`)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)

**GET /library/metadata/{ratingKey}/related**  
Returns related items and extras.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (optional; default: all related types)
- `X-Plex-Language` (optional; default: server locale)

**GET /library/metadata/{ratingKey}/similar**  
Recommendation hub for the item.  
Query parameters:
- `X-Plex-Token` (required)
- `X-Plex-Language` (optional; default: server locale)
- `limit` (optional; default: `10`)

**GET /library/metadata/{ratingKey}/extras**  
Trailers, interviews, and other extras.  
Query parameters:
- `X-Plex-Token` (required)
- `includeExtras` (optional; default: `1`)
- `X-Plex-Language` (optional; default: server locale)

**GET /library/metadata/{ratingKey}/tree**  
Returns parent, siblings, and children for breadcrumb navigation.  
Query parameters:
- `X-Plex-Token` (required)
- `includeRelated` (optional; default: `0`)

**GET /library/parts/{partId}**  
Raw media part information for a given file.  
Query parameters:
- `X-Plex-Token` (required)
- `includeStats` (optional; default: `0`)

**GET /library/parts/{partId}/file**  
Directly downloads the media part.  
Query parameters:
- `X-Plex-Token` (required)
- `download` (optional; default: `0`) – When set to `1`, force download disposition.
- `acceptRanges` (optional; default: `1`)

**GET /library/metadata/{ratingKey}/theme**  
Returns the theme audio stream for TV shows.  
Query parameters:
- `X-Plex-Token` (required)

**GET /library/metadata/{ratingKey}/thumb** / **art** / **banner**  
Fetches artwork assets.  
Query parameters:
- `X-Plex-Token` (required)
- `width` (optional; default: original width)
- `height` (optional; default: original height)
- `minSize` (optional; default: `0`)

## Library Management (Write)

**POST /library/sections/{sectionKey}/refresh**  
Triggers a metadata refresh.  
Query parameters:
- `X-Plex-Token` (required)
- `force` (optional; default: `0`) – When `1`, rescan files even if unchanged.

**POST /library/sections/{sectionKey}/analyze**  
Starts media analysis jobs (loudness, thumbnails, etc.).  
Query parameters:
- `X-Plex-Token` (required)

**POST /library/sections/{sectionKey}/emptyTrash**  
Permanently deletes trashed items from the section.  
Query parameters:
- `X-Plex-Token` (required)

**POST /library/sections/{sectionKey}/unmatchAll**  
Clears agent matches for every item in the section.  
Query parameters:
- `X-Plex-Token` (required)

**POST /library/metadata/{ratingKey}**  
Updates item metadata. Fields are supplied in the form body (`title`, `summary`, `collection[]`, etc.).  
Query parameters:
- `X-Plex-Token` (required)

**POST /library/metadata/{ratingKey}/refresh**  
Refreshes a single metadata item.  
Query parameters:
- `X-Plex-Token` (required)
- `force` (optional; default: `0`)

**POST /library/metadata/{ratingKey}/match**  
Matches an item to a specific agent GUID.  
Query parameters:
- `X-Plex-Token` (required)
- `guid` (required) – Agent GUID to match against.

**POST /library/metadata/{ratingKey}/actions/unmatch**  
Removes the current agent match and switches to local metadata.  
Query parameters:
- `X-Plex-Token` (required)

**POST /library/metadata/{ratingKey}/actions/fetch**  
Fetches artwork from a remote URL.  
Query parameters:
- `X-Plex-Token` (required)
- `field` (required) – One of `poster`, `art`, `banner`, `theme`, `background`.
- `url` (required) – Remote image URL.
- `replaceAll` (optional; default: `0`)

**POST /library/metadata/{ratingKey}/delete**  
Deletes the item (moves to trash or permanently deletes if `async=0`).  
Query parameters:
- `X-Plex-Token` (required)
- `async` (optional; default: `0`) – When `1`, run deletions asynchronously.

**POST /library/collections**  
Creates a new collection. Accepts query or form parameters.  
Query parameters:
- `X-Plex-Token` (required)
- `title` (required)
- `sectionId` (required)
- `smart` (optional; default: `0`)
- `smartFilter` (required when `smart=1`) – JSON payload describing the filter.
- `summary` (optional; default: none)

**POST /library/collections/{collectionKey}/items**  
Adds items to a collection.  
Query parameters:
- `X-Plex-Token` (required)
- `uri` (optional; required when `ratingKey` is omitted) – `server://...` URI reference.
- `ratingKey` (optional; required when `uri` is omitted)
- `ratingKeys[]` (optional; add multiple items in one request)

**POST /library/collections/{collectionKey}**  
Updates collection metadata (commonly used for renaming).  
Query parameters:
- `X-Plex-Token` (required)
- `title` (optional; default: current title)
- `summary` (optional; default: current summary)

**POST /library/collections/{collectionKey}/delete**  
Deletes a collection.  
Query parameters:
- `X-Plex-Token` (required)

## Playlists & PlayQueues

**GET /playlists**  
Lists playlists (static, smart, play queues).  
Query parameters:
- `X-Plex-Token` (required)
- `playlistType` (optional; default: `all`)
- `type` (optional; default: all media types)
- `smart` (optional; default: `0`)
- `sort` (optional; default: `titleSort:asc`)

**GET /playlists/{playlistId}**  
Fetches metadata for a playlist.  
Query parameters:
- `X-Plex-Token` (required)
- `includeGuids` (optional; default: `0`)
- `includeMarkers` (optional; default: `0`)

**GET /playlists/{playlistId}/items**  
Returns playlist items.  
Query parameters:
- `X-Plex-Token` (required)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `50`)
- `sort` (optional; default: `playlistOrder:asc`)

**POST /playlists**  
Creates a static or smart playlist.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (required) – `audio`, `video`, or `photo`.
- `title` (required)
- `smart` (optional; default: `0`)
- `smartFilter` (required when `smart=1`)
- `uri` (required when `smart=0`) – `server://...` URI or `library://` filter URI.

**POST /playlists/{playlistId}/items**  
Appends items to a playlist.  
Query parameters:
- `X-Plex-Token` (required)
- `uri` (optional; required when `ratingKey`/`ratingKeys[]` is omitted)
- `ratingKey` (optional)
- `ratingKeys[]` (optional; batch add)

**POST /playlists/{playlistId}/refresh**  
Rebuilds a smart playlist.  
Query parameters:
- `X-Plex-Token` (required)
- `async` (optional; default: `0`)

**POST /playlists/{playlistId}/delete**  
Deletes a playlist.  
Query parameters:
- `X-Plex-Token` (required)

**POST /playQueues**  
Builds a play queue from an item or filter.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (required) – `video`, `audio`, or `photo`.
- `key` (optional; required when `uri` is omitted)
- `uri` (optional; required when `key` is omitted)
- `continuous` (optional; default: `0`)
- `shuffle` (optional; default: `0`)
- `repeat` (optional; default: `0`)
- `own` (optional; default: `0`) – Restrict queue to the calling account.
- `protocol` (optional; default: `hls` for video, `http` for others)

**GET /playQueues/{id}**  
Inspects a previously created play queue.  
Query parameters:
- `X-Plex-Token` (required)
- `own` (optional; default: `0`)

**POST /playQueues/{id}/shuffle**  
Toggles shuffle mode.  
Query parameters:
- `X-Plex-Token` (required)
- `mode` (optional; default: `toggle`) – Accepts `0`, `1`, or `toggle`.

**POST /playQueues/{id}/repeat**  
Sets the repeat mode for the queue.  
Query parameters:
- `X-Plex-Token` (required)
- `mode` (required) – `0` (off), `1` (repeat all), `2` (repeat item).

## Playback Control

All player control endpoints require `X-Plex-Target-Identifier` in the request headers to select the target client.

**POST /player/playback/start**  
Starts playback on a remote Plex client.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (required) – `video`, `audio`, or `photo`.
- `playQueueID` (optional; required when `key` is omitted)
- `key` (optional; required when `playQueueID` is omitted)
- `offset` (optional; default: `0`) – Start position in milliseconds.
- `commandID` (required) – Incrementing integer used by Plex clients.
- `machineIdentifier` (optional; default: none) – Target server when relaying across servers.

**POST /player/playback/stop**  
Stops playback on the target client.  
Query parameters:
- `X-Plex-Token` (required)
- `commandID` (required)

**POST /player/playback/pause** / **play** / **skipNext** / **skipPrevious**  
Transport controls for the active session.  
Query parameters:
- `X-Plex-Token` (required)
- `commandID` (required)

**POST /player/playback/seekTo**  
Seeks to a specific timestamp.  
Query parameters:
- `X-Plex-Token` (required)
- `commandID` (required)
- `offset` (required) – Position in milliseconds.

**POST /player/playback/setParameters**  
Adjusts playback parameters (audio/subtitle stream, shuffle, repeat).  
Query parameters:
- `X-Plex-Token` (required)
- `commandID` (required)
- `audioStreamID` (optional; default: current stream)
- `subtitleStreamID` (optional; default: current stream)
- `shuffle` (optional; default: `inherit`)
- `repeat` (optional; default: `inherit`)

**POST /player/application/updateConnection**  
Updates the connection details between controller and player.  
Query parameters:
- `X-Plex-Token` (required)
- `commandID` (required)
- `address` (required) – Player IP.
- `port` (required) – Player port.
- `protocol` (optional; default: `http`)

**POST /player/timeline/seekTo**  
Legacy timeline seek API for older clients.  
Query parameters:
- `X-Plex-Token` (required)
- `offset` (required)
- `commandID` (required)

## Transcoding & Downloads

**GET /video/:/transcode/universal/start**  
Starts a universal video transcode session and returns session metadata.  
Query parameters:
- `X-Plex-Token` (required)
- `path` (optional; required when `key` is omitted) – Fully qualified URL to the media.
- `key` (optional; required when `path` is omitted) – `/library/metadata/<ratingKey>`.
- `protocol` (optional; default: `http`)
- `offset` (optional; default: `0`) – Start time in milliseconds.
- `session` (required) – Client-defined session identifier.
- `quality` (optional; default: `0`) – Streaming quality preference.
- `autoAdjustQuality` (optional; default: `1`)
- `directPlay` (optional; default: `1`)
- `directStream` (optional; default: `1`)
- `subtitleSize` (optional; default: `100`)
- `videoQuality` (optional; default: server profile)
- `videoResolution` (optional; default: source resolution)
- `maxVideoBitrate` (optional; default: `20000` kbps)
- `audioBoost` (optional; default: `100`)

**GET /video/:/transcode/universal/decision**  
Dry-run endpoint that reports how the server will handle a playback request. Uses the same parameters as `/universal/start`.  
Query parameters: identical to `/video/:/transcode/universal/start`.

**GET /video/:/transcode/universal/done**  
Stops a universal video transcode session.  
Query parameters:
- `X-Plex-Token` (required)
- `session` (required)
- `reason` (optional; default: `stopped`) – `stopped`, `ended`, etc.

**GET /audio/:/transcode/universal/start**  
Starts an audio-first universal transcode.  
Query parameters:
- `X-Plex-Token` (required)
- `path` or `key` (one required)
- `session` (required)
- `protocol` (optional; default: `http`)
- `offset` (optional; default: `0`)
- `quality` (optional; default: server profile)
- `directPlay` (optional; default: `1`)
- `directStream` (optional; default: `1`)
- `audioBoost` (optional; default: `100`)

**GET /video/:/transcode/universal/subtitles**  
Downloads a converted subtitle stream for an active session.  
Query parameters:
- `X-Plex-Token` (required)
- `session` (required)
- `subtitleIndex` (required) – Index of the subtitle stream.
- `copy` (optional; default: `0`) – When `1`, deliver the original file without conversion.

**GET /video/:/transcode/universal/segmented/start.m3u8**  
Returns the segmented playlist for HLS transcode sessions.  
Query parameters:
- `X-Plex-Token` (required)
- `session` (required)
- `protocol` (optional; default: `http`)
- `offset` (optional; default: `0`)

**GET /library/parts/{partId}/download**  
Downloads the raw media file.  
Query parameters:
- `X-Plex-Token` (required)
- `download` (optional; default: `1`)
- `X-Plex-Drm` (optional; default: none) – DRM flag for certain clients.

## Live TV & DVR

**GET /livetv/dvrs**  
Lists configured DVR instances.  
Query parameters:
- `X-Plex-Token` (required)
- `includeSettings` (optional; default: `1`)

**GET /livetv/settings**  
Returns Live TV global settings.  
Query parameters:
- `X-Plex-Token` (required)

**GET /livetv/channels**  
EPG channel list across tuners.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (optional; default: all)
- `sectionID` (optional; default: all sections)
- `channelIdentifier` (optional; default: all channels)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `100`)

**GET /livetv/programs**  
Program guide for one or more channels.  
Query parameters:
- `X-Plex-Token` (required)
- `channelIdentifier` (optional; default: all channels)
- `start` (optional; default: current time) – Unix timestamp.
- `end` (optional; default: `start + 6h`)
- `type` (optional; default: all program types)
- `X-Plex-Container-Start` (optional; default: `0`)
- `X-Plex-Container-Size` (optional; default: `200`)

**GET /livetv/hubs**  
Hubs tailored for the Live TV experience (continue watching, news, etc.).  
Query parameters:
- `X-Plex-Token` (required)
- `count` (optional; default: `10`)
- `X-Plex-Language` (optional; default: server locale)

**POST /livetv/dvrs/{dvrId}/scanners/refresh**  
Refreshes the channel lineup.  
Query parameters:
- `X-Plex-Token` (required)
- `force` (optional; default: `0`)

**POST /livetv/dvrs/{dvrId}/schedulers**  
Creates a recording schedule.  
Query parameters:
- `X-Plex-Token` (required)
- `type` (required) – `show`, `movie`, `sports`, etc.
- `channelIdentifier` (required)
- `start` (required) – Unix timestamp.
- `end` (required) – Unix timestamp.
- `title` (required)
- `summary` (optional; default: none)
- `priority` (optional; default: `100`)
- `postPadding` (optional; default: `0`) – Seconds to keep recording after end.
- `prePadding` (optional; default: `0`)

**POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/cancel**  
Cancels a scheduled recording.  
Query parameters:
- `X-Plex-Token` (required)
- `deleteSeries` (optional; default: `0`)

**POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/pause**  
Pauses a scheduled recording.  
Query parameters:
- `X-Plex-Token` (required)

**POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/resume**  
Resumes a paused recording.  
Query parameters:
- `X-Plex-Token` (required)

## Users, Sharing & Home

**GET /accounts** (plex.tv)  
Returns profile data and Plex Pass state.  
Query parameters:
- `X-Plex-Token` (required)
- `includeSubscriptions` (optional; default: `1`)

**GET /users** (plex.tv)  
Lists users who share servers with the owner.  
Query parameters:
- `X-Plex-Token` (required)
- `includeHome` (optional; default: `1`)
- `includeFriends` (optional; default: `1`)
- `includeSharedServers` (optional; default: `1`)

**GET /security/resources**  
Returns server resources shared with a specific user.  
Query parameters:
- `X-Plex-Token` (required)
- `userID` (required)

**POST /friends/invite** (plex.tv)  
Invites a Plex friend to share a server.  
Query parameters:
- `X-Plex-Token` (required)
- `friend[username]` (required) – Plex username or email.
- `server_ids[]` (required) – Server IDs to share.
- `library_section_ids[]` (optional; default: share all) – Section IDs to grant access to.
- `allowSync` (optional; default: `0`)
- `allowCameraUpload` (optional; default: `0`)
- `allowChannels` (optional; default: `0`)

**POST /friends/{friendId}** (plex.tv)  
Updates permissions for an existing friend.  
Query parameters:
- `X-Plex-Token` (required)
- `server_ids[]` (required) – Servers to keep shared.
- `library_section_ids[]` (optional; default: no change)
- `allowSync` (optional; default: current value)
- `allowCameraUpload` (optional; default: current value)
- `allowChannels` (optional; default: current value)

**POST /home/invite**  
Invites a managed user into a Plex Home.  
Query parameters:
- `X-Plex-Token` (required)
- `email` (required) – Address of the invited user.
- `managed` (optional; default: `0`) – When `1`, create a managed user.

**POST /home/users/{id}/switch**  
Switches the active Plex Home user.  
Query parameters:
- `X-Plex-Token` (required)
- `pin` (optional; default: none) – Required when the home user is pin-protected.
- `source` (optional; default: `controller`)

## Webhooks & Events

**GET /events/subscriptions**  
Lists Event Hub webhook subscriptions.  
Query parameters:
- `X-Plex-Token` (required)

**POST /events/subscriptions**  
Registers a new webhook listener.  
Query parameters:
- `X-Plex-Token` (required)
- `event` (required) – Event type (`library.new`, `timeline`, etc.).
- `callbackUrl` (required) – Listener URL.
- `secret` (optional; default: none) – Shared secret used to sign payloads.

**POST /events/subscriptions/{id}/delete**  
Deletes a webhook subscription.  
Query parameters:
- `X-Plex-Token` (required)

## Common Query Parameters

These parameters appear across multiple endpoints and are not repeated in every list above:

- `X-Plex-Token` – Authentication token; include on every request unless the server permits anonymous access.
- `X-Plex-Client-Identifier` – Unique device identifier; required for timeline, progress, and player control endpoints.
- `X-Plex-Device`, `X-Plex-Device-Name`, `X-Plex-Product`, `X-Plex-Version`, `X-Plex-Platform` – Provide device metadata for analytics and to unlock certain capabilities.
- `X-Plex-Language` – Response localization hint; defaults to the server locale.
- `X-Plex-Container-Start` / `X-Plex-Container-Size` – Pagination controls; default to `0` and `50` respectively unless otherwise noted.
- `includeGuids`, `includeMarkers`, `includePreferences` – Toggle additional metadata blocks in library responses.
- `async` – In write endpoints, when `1` the server queues work in the background.

## Example: Creating A Collection

```bash
curl -X POST \
  "http://localhost:32400/library/collections" \
  -H "X-Plex-Token: ${PLEX_TOKEN}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "title=Neo-Noir" \
  --data-urlencode "sectionId=1" \
  --data-urlencode "smart=0"
```

Add items to the new collection:

```bash
curl -X POST \
  "http://localhost:32400/library/collections/12345/items" \
  -H "X-Plex-Token: ${PLEX_TOKEN}" \
  --data-urlencode "uri=server://${MACHINE_ID}/com.plexapp.plugins.library/library/metadata/67890"
```

## Example: Building And Playing A Queue

```bash
# Build the play queue
PLAY_QUEUE=$(curl -sS -X POST \
  "http://localhost:32400/playQueues" \
  -H "X-Plex-Token: ${PLEX_TOKEN}" \
  --data-urlencode "type=video" \
  --data-urlencode "key=/library/metadata/67890" \
  --data-urlencode "continuous=0" \
  --data-urlencode "shuffle=0")

PLAY_QUEUE_ID=$(echo "$PLAY_QUEUE" | xmlstarlet sel -t -v '/MediaContainer/@playQueueID')

# Start playback on a specific Plex client
curl -X POST \
  "http://localhost:32400/player/playback/start" \
  -H "X-Plex-Token: ${PLEX_TOKEN}" \
  -H "X-Plex-Target-Identifier: ${CLIENT_UUID}" \
  --data-urlencode "type=video" \
  --data-urlencode "commandID=1" \
  --data-urlencode "playQueueID=${PLAY_QUEUE_ID}"
```

## Additional Resources

- Unofficial Plex API reference: https://github.com/Arcanemagus/plex-api/wiki
- Plex Web App inspector: open Plex in a browser, run Playback or Library actions, and copy the requests from the Network tab to discover new endpoints.
- `plexapi` Python client: https://python-plexapi.readthedocs.io/ – Useful for cross-checking arguments and supported filters.

Keep this document updated as we discover new endpoints or parameters in our instrumentation.
