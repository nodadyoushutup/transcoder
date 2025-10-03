# Plex HTTP API Reference

This document captures the most commonly used Plex Media Server HTTP endpoints so we can reason about future integrations without scraping community wikis. It focuses on the local server API that listens on `http(s)://<plex-host>:32400` and the plex.tv relay endpoints that surface account-level data.

> The Plex API is not officially frozen. Fields, resource paths, and required headers can change between versions. Treat this as a living document and verify against your running server before shipping production code.

<a id="table-of-contents"></a>
## Table of Contents

- [Server & Account Discovery](#server-account-discovery)
  - [GET /identity](#get-identity)
  - [GET /servers](#get-servers)
  - [GET /resources](#get-resources)
  - [GET /clients](#get-clients)
  - [GET /devices.xml](#get-devices-xml)
  - [POST /myplex/account/signin](#post-myplex-account-signin)
- [Sessions & Activity](#sessions-activity)
  - [GET /status/sessions](#get-status-sessions)
  - [GET /status/sessions/history/all](#get-status-sessions-history-all)
  - [GET /status/sessions/history/{ratingKey}](#get-status-sessions-history-ratingkey)
  - [GET /status/sessions/history/status](#get-status-sessions-history-status)
  - [GET /status/sessions/activity/{id}](#get-status-sessions-activity-id)
  - [POST /:/timeline](#post-timeline)
  - [POST /:/scrobble](#post-scrobble)
  - [POST /:/unscrobble](#post-unscrobble)
  - [POST /:/progress](#post-progress)
- [Library Navigation (Read)](#library-navigation-read)
  - [GET /library/sections](#get-library-sections)
  - [GET /library/sections/{sectionKey}](#get-library-sections-sectionkey)
  - [GET /library/sections/{sectionKey}/all](#get-library-sections-sectionkey-all)
  - [GET /library/sections/{sectionKey}/recentlyAdded](#get-library-sections-sectionkey-recentlyadded)
  - [GET /library/sections/{sectionKey}/onDeck](#get-library-sections-sectionkey-ondeck)
  - [GET /library/sections/{sectionKey}/collection](#get-library-sections-sectionkey-collection)
  - [GET /library/sections/{sectionKey}/search](#get-library-sections-sectionkey-search)
  - [GET /library/search](#get-library-search)
  - [GET /hubs/home](#get-hubs-home)
  - [GET /hubs/search](#get-hubs-search)
  - [GET /library/onDeck](#get-library-ondeck)
- [Library Metadata (Read)](#library-metadata-read)
  - [GET /library/metadata/{ratingKey}](#get-library-metadata-ratingkey)
  - [GET /library/metadata/{ratingKey}/children](#get-library-metadata-ratingkey-children)
  - [GET /library/metadata/{ratingKey}/grandchildren](#get-library-metadata-ratingkey-grandchildren)
  - [GET /library/metadata/{ratingKey}/related](#get-library-metadata-ratingkey-related)
  - [GET /library/metadata/{ratingKey}/similar](#get-library-metadata-ratingkey-similar)
  - [GET /library/metadata/{ratingKey}/extras](#get-library-metadata-ratingkey-extras)
  - [GET /library/metadata/{ratingKey}/tree](#get-library-metadata-ratingkey-tree)
  - [GET /library/parts/{partId}](#get-library-parts-partid)
  - [GET /library/parts/{partId}/file](#get-library-parts-partid-file)
  - [GET /library/metadata/{ratingKey}/theme](#get-library-metadata-ratingkey-theme)
  - [GET /library/metadata/{ratingKey}/thumb](#get-library-metadata-ratingkey-thumb)
- [Library Management (Write)](#library-management-write)
  - [POST /library/sections/{sectionKey}/refresh](#post-library-sections-sectionkey-refresh)
  - [POST /library/sections/{sectionKey}/analyze](#post-library-sections-sectionkey-analyze)
  - [POST /library/sections/{sectionKey}/emptyTrash](#post-library-sections-sectionkey-emptytrash)
  - [POST /library/sections/{sectionKey}/unmatchAll](#post-library-sections-sectionkey-unmatchall)
  - [POST /library/metadata/{ratingKey}](#post-library-metadata-ratingkey)
  - [POST /library/metadata/{ratingKey}/refresh](#post-library-metadata-ratingkey-refresh)
  - [POST /library/metadata/{ratingKey}/match](#post-library-metadata-ratingkey-match)
  - [POST /library/metadata/{ratingKey}/actions/unmatch](#post-library-metadata-ratingkey-actions-unmatch)
  - [POST /library/metadata/{ratingKey}/actions/fetch](#post-library-metadata-ratingkey-actions-fetch)
  - [POST /library/metadata/{ratingKey}/delete](#post-library-metadata-ratingkey-delete)
  - [POST /library/collections](#post-library-collections)
  - [POST /library/collections/{collectionKey}/items](#post-library-collections-collectionkey-items)
  - [POST /library/collections/{collectionKey}](#post-library-collections-collectionkey)
  - [POST /library/collections/{collectionKey}/delete](#post-library-collections-collectionkey-delete)
- [Playlists & PlayQueues](#playlists-playqueues)
  - [GET /playlists](#get-playlists)
  - [GET /playlists/{playlistId}](#get-playlists-playlistid)
  - [GET /playlists/{playlistId}/items](#get-playlists-playlistid-items)
  - [POST /playlists](#post-playlists)
  - [POST /playlists/{playlistId}/items](#post-playlists-playlistid-items)
  - [POST /playlists/{playlistId}/refresh](#post-playlists-playlistid-refresh)
  - [POST /playlists/{playlistId}/delete](#post-playlists-playlistid-delete)
  - [POST /playQueues](#post-playqueues)
  - [GET /playQueues/{id}](#get-playqueues-id)
  - [POST /playQueues/{id}/shuffle](#post-playqueues-id-shuffle)
  - [POST /playQueues/{id}/repeat](#post-playqueues-id-repeat)
- [Playback Control](#playback-control)
  - [POST /player/playback/start](#post-player-playback-start)
  - [POST /player/playback/stop](#post-player-playback-stop)
  - [POST /player/playback/pause](#post-player-playback-pause)
  - [POST /player/playback/seekTo](#post-player-playback-seekto)
  - [POST /player/playback/setParameters](#post-player-playback-setparameters)
  - [POST /player/application/updateConnection](#post-player-application-updateconnection)
  - [POST /player/timeline/seekTo](#post-player-timeline-seekto)
- [Transcoding & Downloads](#transcoding-downloads)
  - [GET /video/:/transcode/universal/start](#get-video-transcode-universal-start)
  - [GET /video/:/transcode/universal/decision](#get-video-transcode-universal-decision)
  - [GET /video/:/transcode/universal/done](#get-video-transcode-universal-done)
  - [GET /audio/:/transcode/universal/start](#get-audio-transcode-universal-start)
  - [GET /video/:/transcode/universal/subtitles](#get-video-transcode-universal-subtitles)
  - [GET /video/:/transcode/universal/segmented/start.m3u8](#get-video-transcode-universal-segmented-start-m3u8)
  - [GET /library/parts/{partId}/download](#get-library-parts-partid-download)
- [Live TV & DVR](#live-tv-dvr)
  - [GET /livetv/dvrs](#get-livetv-dvrs)
  - [GET /livetv/settings](#get-livetv-settings)
  - [GET /livetv/channels](#get-livetv-channels)
  - [GET /livetv/programs](#get-livetv-programs)
  - [GET /livetv/hubs](#get-livetv-hubs)
  - [POST /livetv/dvrs/{dvrId}/scanners/refresh](#post-livetv-dvrs-dvrid-scanners-refresh)
  - [POST /livetv/dvrs/{dvrId}/schedulers](#post-livetv-dvrs-dvrid-schedulers)
  - [POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/cancel](#post-livetv-dvrs-dvrid-schedulers-schedulerid-cancel)
  - [POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/pause](#post-livetv-dvrs-dvrid-schedulers-schedulerid-pause)
  - [POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/resume](#post-livetv-dvrs-dvrid-schedulers-schedulerid-resume)
- [Users, Sharing & Home](#users-sharing-home)
  - [GET /accounts](#get-accounts)
  - [GET /users](#get-users)
  - [GET /security/resources](#get-security-resources)
  - [POST /friends/invite](#post-friends-invite)
  - [POST /friends/{friendId}](#post-friends-friendid)
  - [POST /home/invite](#post-home-invite)
  - [POST /home/users/{id}/switch](#post-home-users-id-switch)
- [Webhooks & Events](#webhooks-events)
  - [GET /events/subscriptions](#get-events-subscriptions)
  - [POST /events/subscriptions](#post-events-subscriptions)
  - [POST /events/subscriptions/{id}/delete](#post-events-subscriptions-id-delete)
- [Common Query Parameters](#common-query-parameters)
- [Example: Creating A Collection](#example-creating-a-collection)
- [Example: Building And Playing A Queue](#example-building-and-playing-a-queue)
- [Additional Resources](#additional-resources)

<a id="reading-this-document"></a>
## Reading This Document

- Every endpoint lists the HTTP method, path, short behavior summary, and the query parameters you can supply. Required parameters are tagged `required`; optional parameters show the default when Plex supplies one.
- Unless stated otherwise, include `X-Plex-Token` (required when the server enforces authentication). Device metadata headers such as `X-Plex-Client-Identifier`, `X-Plex-Product`, `X-Plex-Version`, and `X-Plex-Platform` are omitted for brevity but should accompany most remote requests.
- All responses are XML unless you request JSON with `Accept: application/json` or operate on plex.tv endpoints that already return JSON.

<a id="server-account-discovery"></a>
## Server & Account Discovery

<a id="get-identity"></a>**GET /identity**  
Returns the current server's `machineIdentifier`, version, and advertised capabilities.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Conditional | none | required if the server restricts unauthenticated discovery |

<a id="get-servers"></a>**GET /servers** (plex.tv)  
Lists Plex Media Servers shared with the authenticated account.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeLite` | No | `1` | Return a reduced payload when set to `1`. |
| `includeHttps` | No | `1` | Include HTTPS-capable connection URIs. |

<a id="get-resources"></a>**GET /resources** (plex.tv)  
Returns a superset of devices (servers, players, managed users).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeHttps` | No | `1` | — |
| `includeRelay` | No | `1` | — |
| `includeManaged` | No | `1` | — |
| `includeInactive` | No | `0` | — |

<a id="get-clients"></a>**GET /clients**  
Lists players currently paired with the server.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Conditional | — | required when the server is secured |

<a id="get-devices-xml"></a>**GET /devices.xml** (plex.tv)  
Legacy device directory for the signed-in account.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-myplex-account-signin"></a>**POST /myplex/account/signin** (plex.tv)  
Authenticates a Plex account and returns an auth token. Use only for tooling (Plex now prefers OAuth).  
Parameters: none
Form fields:
- `user[login]` (required) – Username or email.
- `user[password]` (required)
- `rememberMe` (optional; default: `false`)

<a id="sessions-activity"></a>
## Sessions & Activity

<a id="get-status-sessions"></a>**GET /status/sessions**  
Active playback sessions with metadata, stream bitrates, and transcode state.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Conditional | — | required on secured servers |

<a id="get-status-sessions-history-all"></a>**GET /status/sessions/history/all**  
Complete playback history with filters.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `accountID` | No | all accounts | — |
| `librarySectionID` | No | all sections | — |
| `type` | No | all item types | — |
| `startAt` | No | server-defined start of dataset | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |
| `sort` | No | `viewedAt:desc` | — |

<a id="get-status-sessions-history-ratingkey"></a>**GET /status/sessions/history/{ratingKey}**  
Playback history for a specific item.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `accountID` | No | all accounts | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |

<a id="get-status-sessions-history-status"></a>**GET /status/sessions/history/status**  
Aggregated playback metrics grouped by day.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `window` | No | `all` | One of `day`, `week`, `month`, `year`, `all`. |
| `sort` | No | `viewedAt:desc` | — |

<a id="get-status-sessions-activity-id"></a>**GET /status/sessions/activity/{id}**  
Detailed context for a session ID, including timeline and bitrate.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-timeline"></a>**POST /:/timeline**  
Used by Plex clients to push timeline/progress updates to the server.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `key` | Conditional | — | required when `ratingKey` is omitted; Item key (`/library/metadata/<ratingKey>`). |
| `ratingKey` | Conditional | — | required when `key` is omitted |
| `time` | Yes | — | Current playback position in milliseconds. |
| `duration` | No | `0` | Total media length in milliseconds. |
| `state` | Yes | — | `playing`, `paused`, or `stopped`. |
| `X-Plex-Client-Identifier` | Yes | — | Client device ID. |
| `X-Plex-Device-Name` | No | none | — |
| `hasMDE` | No | `0` | Flag to indicate metadata enhancements present. |

<a id="post-scrobble"></a>**POST /:/scrobble** / <a id="post-unscrobble"></a>**POST /:/unscrobble**  
Marks an item as watched (`scrobble`) or unwatched (`unscrobble`).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `key` | Conditional | — | required when `identifier` is omitted |
| `identifier` | No | — | alternative to `key` for certain agents |
| `ratingKey` | No | — | accepted by newer servers |
| `X-Plex-Client-Identifier` | Yes | — | — |

<a id="post-progress"></a>**POST /:/progress**  
Persists partial playback progress.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `key` | Conditional | — | required when `ratingKey` is omitted |
| `ratingKey` | Conditional | — | required when `key` is omitted |
| `time` | Yes | — | Playback offset in milliseconds. |
| `state` | Yes | — | `playing`, `paused`, or `buffering`. |
| `duration` | No | `0` | — |
| `X-Plex-Client-Identifier` | Yes | — | — |

<a id="library-navigation-read"></a>
## Library Navigation (Read)

<a id="get-library-sections"></a>**GET /library/sections**  
Enumerates all libraries on the server.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Conditional | — | required on secured servers |
| `includeLocation` | No | `0` | Include filesystem paths. |
| `includeTypeCount` | No | `0` | — |

<a id="get-library-sections-sectionkey"></a>**GET /library/sections/{sectionKey}**  
Returns metadata and preferences for a single library.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeLocation` | No | `0` | — |
| `includePreferences` | No | `0` | — |

<a id="get-library-sections-sectionkey-all"></a>**GET /library/sections/{sectionKey}/all**  
Full listing of items in a library section.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | No | section default | — |
| `genre` | No | — | , `year`, `title`, `label`, etc. (optional filters; default: none) |
| `unwatched` | No | `0` | — |
| `sort` | No | `addedAt:desc` | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |
| `includeGuids` | No | `0` | — |
| `includeMarkers` | No | `0` | — |

<a id="get-library-sections-sectionkey-recentlyadded"></a>**GET /library/sections/{sectionKey}/recentlyAdded**  
Items ordered by import date.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |
| `Additional filters` | No | — | `type`, `unwatched`, etc.; match those from `/all`. |

<a id="get-library-sections-sectionkey-ondeck"></a>**GET /library/sections/{sectionKey}/onDeck**  
Next-up episodes or partially watched movies for the section.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |

<a id="get-library-sections-sectionkey-collection"></a>**GET /library/sections/{sectionKey}/collection**  
Collections defined inside a library.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | No | all collections | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |

<a id="get-library-sections-sectionkey-search"></a>**GET /library/sections/{sectionKey}/search**  
Section-scoped search. Supports the same filters used by the web app.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `query` | No | empty | — |
| `type` | No | section default | — |
| `year` | No | — | , `actor`, `album`, `label`, etc. (optional filters) |
| `sort` | No | `relevance:desc` | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `20` | — |

<a id="get-library-search"></a>**GET /library/search**  
Global search across all libraries.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `query` | Yes | — | — |
| `type` | No | all types | — |
| `limit` | No | `20` per hub | — |
| `includeGuids` | No | `0` | — |

<a id="get-hubs-home"></a>**GET /hubs/home**  
Aggregated hubs for the Plex home screen.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `X-Plex-Language` | No | server locale | — |
| `count` | No | `10` | Number of items per hub. |
| `includeMeta` | No | `1` | — |

<a id="get-hubs-search"></a>**GET /hubs/search**  
Search hubs suitable for UI auto-complete.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `query` | Yes | — | — |
| `limit` | No | `10` | — |

<a id="get-library-ondeck"></a>**GET /library/onDeck**  
On Deck entries consolidated across every library.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |

<a id="library-metadata-read"></a>
## Library Metadata (Read)

<a id="get-library-metadata-ratingkey"></a>**GET /library/metadata/{ratingKey}**  
Primary metadata for an item.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeGuids` | No | `0` | — |
| `includeMarkers` | No | `0` | — |
| `includePreferences` | No | `0` | — |
| `X-Plex-Language` | No | server locale | — |
| `checkFiles` | No | `0` | Adds file availability data. |

<a id="get-library-metadata-ratingkey-children"></a>**GET /library/metadata/{ratingKey}/children**  
Fetches episodes, tracks, or child items.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `sort` | No | `index:asc` | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |

<a id="get-library-metadata-ratingkey-grandchildren"></a>**GET /library/metadata/{ratingKey}/grandchildren**  
Convenience helper that jumps directly to grandchildren (e.g., show → episodes).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `sort` | No | `index:asc` | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |

<a id="get-library-metadata-ratingkey-related"></a>**GET /library/metadata/{ratingKey}/related**  
Returns related items and extras.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | No | all related types | — |
| `X-Plex-Language` | No | server locale | — |

<a id="get-library-metadata-ratingkey-similar"></a>**GET /library/metadata/{ratingKey}/similar**  
Recommendation hub for the item.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `X-Plex-Language` | No | server locale | — |
| `limit` | No | `10` | — |

<a id="get-library-metadata-ratingkey-extras"></a>**GET /library/metadata/{ratingKey}/extras**  
Trailers, interviews, and other extras.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeExtras` | No | `1` | — |
| `X-Plex-Language` | No | server locale | — |

<a id="get-library-metadata-ratingkey-tree"></a>**GET /library/metadata/{ratingKey}/tree**  
Returns parent, siblings, and children for breadcrumb navigation.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeRelated` | No | `0` | — |

<a id="get-library-parts-partid"></a>**GET /library/parts/{partId}**  
Raw media part information for a given file.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeStats` | No | `0` | — |

<a id="get-library-parts-partid-file"></a>**GET /library/parts/{partId}/file**  
Directly downloads the media part.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `download` | No | `0` | When set to `1`, force download disposition. |
| `acceptRanges` | No | `1` | — |

<a id="get-library-metadata-ratingkey-theme"></a>**GET /library/metadata/{ratingKey}/theme**  
Returns the theme audio stream for TV shows.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="get-library-metadata-ratingkey-thumb"></a>**GET /library/metadata/{ratingKey}/thumb** / **art** / **banner**  
Fetches artwork assets.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `width` | No | original width | — |
| `height` | No | original height | — |
| `minSize` | No | `0` | — |

<a id="library-management-write"></a>
## Library Management (Write)

<a id="post-library-sections-sectionkey-refresh"></a>**POST /library/sections/{sectionKey}/refresh**  
Triggers a metadata refresh.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `force` | No | `0` | When `1`, rescan files even if unchanged. |

<a id="post-library-sections-sectionkey-analyze"></a>**POST /library/sections/{sectionKey}/analyze**  
Starts media analysis jobs (loudness, thumbnails, etc.).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-library-sections-sectionkey-emptytrash"></a>**POST /library/sections/{sectionKey}/emptyTrash**  
Permanently deletes trashed items from the section.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-library-sections-sectionkey-unmatchall"></a>**POST /library/sections/{sectionKey}/unmatchAll**  
Clears agent matches for every item in the section.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-library-metadata-ratingkey"></a>**POST /library/metadata/{ratingKey}**  
Updates item metadata. Fields are supplied in the form body (`title`, `summary`, `collection[]`, etc.).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-library-metadata-ratingkey-refresh"></a>**POST /library/metadata/{ratingKey}/refresh**  
Refreshes a single metadata item.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `force` | No | `0` | — |

<a id="post-library-metadata-ratingkey-match"></a>**POST /library/metadata/{ratingKey}/match**  
Matches an item to a specific agent GUID.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `guid` | Yes | — | Agent GUID to match against. |

<a id="post-library-metadata-ratingkey-actions-unmatch"></a>**POST /library/metadata/{ratingKey}/actions/unmatch**  
Removes the current agent match and switches to local metadata.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-library-metadata-ratingkey-actions-fetch"></a>**POST /library/metadata/{ratingKey}/actions/fetch**  
Fetches artwork from a remote URL.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `field` | Yes | — | One of `poster`, `art`, `banner`, `theme`, `background`. |
| `url` | Yes | — | Remote image URL. |
| `replaceAll` | No | `0` | — |

<a id="post-library-metadata-ratingkey-delete"></a>**POST /library/metadata/{ratingKey}/delete**  
Deletes the item (moves to trash or permanently deletes if `async=0`).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `async` | No | `0` | When `1`, run deletions asynchronously. |

<a id="post-library-collections"></a>**POST /library/collections**  
Creates a new collection. Accepts query or form parameters.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `title` | Yes | — | — |
| `sectionId` | Yes | — | — |
| `smart` | No | `0` | — |
| `smartFilter` | Conditional | — | required when `smart=1`; JSON payload describing the filter. |
| `summary` | No | none | — |

<a id="post-library-collections-collectionkey-items"></a>**POST /library/collections/{collectionKey}/items**  
Adds items to a collection.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `uri` | Conditional | — | required when `ratingKey` is omitted; `server://...` URI reference. |
| `ratingKey` | Conditional | — | required when `uri` is omitted |
| `ratingKeys[]` | No | — | add multiple items in one request |

<a id="post-library-collections-collectionkey"></a>**POST /library/collections/{collectionKey}**  
Updates collection metadata (commonly used for renaming).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `title` | No | current title | — |
| `summary` | No | current summary | — |

<a id="post-library-collections-collectionkey-delete"></a>**POST /library/collections/{collectionKey}/delete**  
Deletes a collection.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="playlists-playqueues"></a>
## Playlists & PlayQueues

<a id="get-playlists"></a>**GET /playlists**  
Lists playlists (static, smart, play queues).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `playlistType` | No | `all` | — |
| `type` | No | all media types | — |
| `smart` | No | `0` | — |
| `sort` | No | `titleSort:asc` | — |

<a id="get-playlists-playlistid"></a>**GET /playlists/{playlistId}**  
Fetches metadata for a playlist.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeGuids` | No | `0` | — |
| `includeMarkers` | No | `0` | — |

<a id="get-playlists-playlistid-items"></a>**GET /playlists/{playlistId}/items**  
Returns playlist items.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `50` | — |
| `sort` | No | `playlistOrder:asc` | — |

<a id="post-playlists"></a>**POST /playlists**  
Creates a static or smart playlist.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | Yes | — | `audio`, `video`, or `photo`. |
| `title` | Yes | — | — |
| `smart` | No | `0` | — |
| `smartFilter` | Conditional | — | required when `smart=1` |
| `uri` | Conditional | — | required when `smart=0`; `server://...` URI or `library://` filter URI. |

<a id="post-playlists-playlistid-items"></a>**POST /playlists/{playlistId}/items**  
Appends items to a playlist.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `uri` | Conditional | — | required when `ratingKey`/`ratingKeys[]` is omitted |
| `ratingKey` | No | — | — |
| `ratingKeys[]` | No | — | batch add |

<a id="post-playlists-playlistid-refresh"></a>**POST /playlists/{playlistId}/refresh**  
Rebuilds a smart playlist.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `async` | No | `0` | — |

<a id="post-playlists-playlistid-delete"></a>**POST /playlists/{playlistId}/delete**  
Deletes a playlist.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-playqueues"></a>**POST /playQueues**  
Builds a play queue from an item or filter.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | Yes | — | `video`, `audio`, or `photo`. |
| `key` | Conditional | — | required when `uri` is omitted |
| `uri` | Conditional | — | required when `key` is omitted |
| `continuous` | No | `0` | — |
| `shuffle` | No | `0` | — |
| `repeat` | No | `0` | — |
| `own` | No | `0` | Restrict queue to the calling account. |
| `protocol` | No | `hls` for video, `http` for others | — |

<a id="get-playqueues-id"></a>**GET /playQueues/{id}**  
Inspects a previously created play queue.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `own` | No | `0` | — |

<a id="post-playqueues-id-shuffle"></a>**POST /playQueues/{id}/shuffle**  
Toggles shuffle mode.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `mode` | No | `toggle` | Accepts `0`, `1`, or `toggle`. |

<a id="post-playqueues-id-repeat"></a>**POST /playQueues/{id}/repeat**  
Sets the repeat mode for the queue.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `mode` | Yes | — | `0` (off), `1` (repeat all), `2` (repeat item). |

<a id="playback-control"></a>
## Playback Control

All player control endpoints require `X-Plex-Target-Identifier` in the request headers to select the target client.

<a id="post-player-playback-start"></a>**POST /player/playback/start**  
Starts playback on a remote Plex client.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | Yes | — | `video`, `audio`, or `photo`. |
| `playQueueID` | Conditional | — | required when `key` is omitted |
| `key` | Conditional | — | required when `playQueueID` is omitted |
| `offset` | No | `0` | Start position in milliseconds. |
| `commandID` | Yes | — | Incrementing integer used by Plex clients. |
| `machineIdentifier` | No | none | Target server when relaying across servers. |

<a id="post-player-playback-stop"></a>**POST /player/playback/stop**  
Stops playback on the target client.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `commandID` | Yes | — | — |

<a id="post-player-playback-pause"></a>**POST /player/playback/pause** / **play** / **skipNext** / **skipPrevious**  
Transport controls for the active session.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `commandID` | Yes | — | — |

<a id="post-player-playback-seekto"></a>**POST /player/playback/seekTo**  
Seeks to a specific timestamp.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `commandID` | Yes | — | — |
| `offset` | Yes | — | Position in milliseconds. |

<a id="post-player-playback-setparameters"></a>**POST /player/playback/setParameters**  
Adjusts playback parameters (audio/subtitle stream, shuffle, repeat).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `commandID` | Yes | — | — |
| `audioStreamID` | No | current stream | — |
| `subtitleStreamID` | No | current stream | — |
| `shuffle` | No | `inherit` | — |
| `repeat` | No | `inherit` | — |

<a id="post-player-application-updateconnection"></a>**POST /player/application/updateConnection**  
Updates the connection details between controller and player.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `commandID` | Yes | — | — |
| `address` | Yes | — | Player IP. |
| `port` | Yes | — | Player port. |
| `protocol` | No | `http` | — |

<a id="post-player-timeline-seekto"></a>**POST /player/timeline/seekTo**  
Legacy timeline seek API for older clients.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `offset` | Yes | — | — |
| `commandID` | Yes | — | — |

<a id="transcoding-downloads"></a>
## Transcoding & Downloads

<a id="get-video-transcode-universal-start"></a>**GET /video/:/transcode/universal/start**  
Starts a universal video transcode session and returns session metadata.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `path` | Conditional | — | required when `key` is omitted; Fully qualified URL to the media. |
| `key` | Conditional | — | required when `path` is omitted; `/library/metadata/<ratingKey>`. |
| `protocol` | No | `http` | — |
| `offset` | No | `0` | Start time in milliseconds. |
| `session` | Yes | — | Client-defined session identifier. |
| `quality` | No | `0` | Streaming quality preference. |
| `autoAdjustQuality` | No | `1` | — |
| `directPlay` | No | `1` | — |
| `directStream` | No | `1` | — |
| `subtitleSize` | No | `100` | — |
| `videoQuality` | No | server profile | — |
| `videoResolution` | No | source resolution | — |
| `maxVideoBitrate` | No | `20000` kbps | — |
| `audioBoost` | No | `100` | — |

<a id="get-video-transcode-universal-decision"></a>**GET /video/:/transcode/universal/decision**  
Dry-run endpoint that reports how the server will handle a playback request. Uses the same parameters as `/universal/start`.  
Parameters: identical to `/video/:/transcode/universal/start`.

<a id="get-video-transcode-universal-done"></a>**GET /video/:/transcode/universal/done**  
Stops a universal video transcode session.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `session` | Yes | — | — |
| `reason` | No | `stopped` | `stopped`, `ended`, etc. |

<a id="get-audio-transcode-universal-start"></a>**GET /audio/:/transcode/universal/start**  
Starts an audio-first universal transcode.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `path` | Conditional | — | One of `path` or `key` must be provided; fully qualified media URL. |
| `key` | Conditional | — | One of `path` or `key` must be provided; `/library/metadata/<ratingKey>`. |
| `session` | Yes | — | — |
| `protocol` | No | `http` | — |
| `offset` | No | `0` | — |
| `quality` | No | server profile | — |
| `directPlay` | No | `1` | — |
| `directStream` | No | `1` | — |
| `audioBoost` | No | `100` | — |

<a id="get-video-transcode-universal-subtitles"></a>**GET /video/:/transcode/universal/subtitles**  
Downloads a converted subtitle stream for an active session.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `session` | Yes | — | — |
| `subtitleIndex` | Yes | — | Index of the subtitle stream. |
| `copy` | No | `0` | When `1`, deliver the original file without conversion. |

<a id="get-video-transcode-universal-segmented-start-m3u8"></a>**GET /video/:/transcode/universal/segmented/start.m3u8**  
Returns the segmented playlist for HLS transcode sessions.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `session` | Yes | — | — |
| `protocol` | No | `http` | — |
| `offset` | No | `0` | — |

<a id="get-library-parts-partid-download"></a>**GET /library/parts/{partId}/download**  
Downloads the raw media file.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `download` | No | `1` | — |
| `X-Plex-Drm` | No | none | DRM flag for certain clients. |

<a id="live-tv-dvr"></a>
## Live TV & DVR

<a id="get-livetv-dvrs"></a>**GET /livetv/dvrs**  
Lists configured DVR instances.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeSettings` | No | `1` | — |

<a id="get-livetv-settings"></a>**GET /livetv/settings**  
Returns Live TV global settings.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="get-livetv-channels"></a>**GET /livetv/channels**  
EPG channel list across tuners.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | No | all | — |
| `sectionID` | No | all sections | — |
| `channelIdentifier` | No | all channels | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `100` | — |

<a id="get-livetv-programs"></a>**GET /livetv/programs**  
Program guide for one or more channels.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `channelIdentifier` | No | all channels | — |
| `start` | No | current time | Unix timestamp. |
| `end` | No | `start + 6h` | — |
| `type` | No | all program types | — |
| `X-Plex-Container-Start` | No | `0` | — |
| `X-Plex-Container-Size` | No | `200` | — |

<a id="get-livetv-hubs"></a>**GET /livetv/hubs**  
Hubs tailored for the Live TV experience (continue watching, news, etc.).  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `count` | No | `10` | — |
| `X-Plex-Language` | No | server locale | — |

<a id="post-livetv-dvrs-dvrid-scanners-refresh"></a>**POST /livetv/dvrs/{dvrId}/scanners/refresh**  
Refreshes the channel lineup.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `force` | No | `0` | — |

<a id="post-livetv-dvrs-dvrid-schedulers"></a>**POST /livetv/dvrs/{dvrId}/schedulers**  
Creates a recording schedule.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `type` | Yes | — | `show`, `movie`, `sports`, etc. |
| `channelIdentifier` | Yes | — | — |
| `start` | Yes | — | Unix timestamp. |
| `end` | Yes | — | Unix timestamp. |
| `title` | Yes | — | — |
| `summary` | No | none | — |
| `priority` | No | `100` | — |
| `postPadding` | No | `0` | Seconds to keep recording after end. |
| `prePadding` | No | `0` | — |

<a id="post-livetv-dvrs-dvrid-schedulers-schedulerid-cancel"></a>**POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/cancel**  
Cancels a scheduled recording.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `deleteSeries` | No | `0` | — |

<a id="post-livetv-dvrs-dvrid-schedulers-schedulerid-pause"></a>**POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/pause**  
Pauses a scheduled recording.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-livetv-dvrs-dvrid-schedulers-schedulerid-resume"></a>**POST /livetv/dvrs/{dvrId}/schedulers/{schedulerId}/resume**  
Resumes a paused recording.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="users-sharing-home"></a>
## Users, Sharing & Home

<a id="get-accounts"></a>**GET /accounts** (plex.tv)  
Returns profile data and Plex Pass state.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeSubscriptions` | No | `1` | — |

<a id="get-users"></a>**GET /users** (plex.tv)  
Lists users who share servers with the owner.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `includeHome` | No | `1` | — |
| `includeFriends` | No | `1` | — |
| `includeSharedServers` | No | `1` | — |

<a id="get-security-resources"></a>**GET /security/resources**  
Returns server resources shared with a specific user.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `userID` | Yes | — | — |

<a id="post-friends-invite"></a>**POST /friends/invite** (plex.tv)  
Invites a Plex friend to share a server.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `friend[username]` | Yes | — | Plex username or email. |
| `server_ids[]` | Yes | — | Server IDs to share. |
| `library_section_ids[]` | No | share all | Section IDs to grant access to. |
| `allowSync` | No | `0` | — |
| `allowCameraUpload` | No | `0` | — |
| `allowChannels` | No | `0` | — |

<a id="post-friends-friendid"></a>**POST /friends/{friendId}** (plex.tv)  
Updates permissions for an existing friend.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `server_ids[]` | Yes | — | Servers to keep shared. |
| `library_section_ids[]` | No | no change | — |
| `allowSync` | No | current value | — |
| `allowCameraUpload` | No | current value | — |
| `allowChannels` | No | current value | — |

<a id="post-home-invite"></a>**POST /home/invite**  
Invites a managed user into a Plex Home.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `email` | Yes | — | Address of the invited user. |
| `managed` | No | `0` | When `1`, create a managed user. |

<a id="post-home-users-id-switch"></a>**POST /home/users/{id}/switch**  
Switches the active Plex Home user.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `pin` | No | none | Required when the home user is pin-protected. |
| `source` | No | `controller` | — |

<a id="webhooks-events"></a>
## Webhooks & Events

<a id="get-events-subscriptions"></a>**GET /events/subscriptions**  
Lists Event Hub webhook subscriptions.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="post-events-subscriptions"></a>**POST /events/subscriptions**  
Registers a new webhook listener.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |
| `event` | Yes | — | Event type (`library.new`, `timeline`, etc.). |
| `callbackUrl` | Yes | — | Listener URL. |
| `secret` | No | none | Shared secret used to sign payloads. |

<a id="post-events-subscriptions-id-delete"></a>**POST /events/subscriptions/{id}/delete**  
Deletes a webhook subscription.  
Parameters:
| Parameter | Required | Default | Notes |
|-----------|----------|---------|-------|
| `X-Plex-Token` | Yes | — | — |

<a id="common-query-parameters"></a>
## Common Query Parameters

These parameters appear across multiple endpoints and are not repeated in every list above:

- `X-Plex-Token` – Authentication token; include on every request unless the server permits anonymous access.
- `X-Plex-Client-Identifier` – Unique device identifier; required for timeline, progress, and player control endpoints.
- `X-Plex-Device`, `X-Plex-Device-Name`, `X-Plex-Product`, `X-Plex-Version`, `X-Plex-Platform` – Provide device metadata for analytics and to unlock certain capabilities.
- `X-Plex-Language` – Response localization hint; defaults to the server locale.
- `X-Plex-Container-Start` / `X-Plex-Container-Size` – Pagination controls; default to `0` and `50` respectively unless otherwise noted.
- `includeGuids`, `includeMarkers`, `includePreferences` – Toggle additional metadata blocks in library responses.
- `async` – In write endpoints, when `1` the server queues work in the background.

<a id="example-creating-a-collection"></a>
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

<a id="example-building-and-playing-a-queue"></a>
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

<a id="additional-resources"></a>
## Additional Resources

- Unofficial Plex API reference: https://github.com/Arcanemagus/plex-api/wiki
- Plex Web App inspector: open Plex in a browser, run Playback or Library actions, and copy the requests from the Network tab to discover new endpoints.
- `plexapi` Python client: https://python-plexapi.readthedocs.io/ – Useful for cross-checking arguments and supported filters.

Keep this document updated as we discover new endpoints or parameters in our instrumentation.
