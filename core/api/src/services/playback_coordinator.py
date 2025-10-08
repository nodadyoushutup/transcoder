"""High-level helpers for coordinating playback start and stop events."""
from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any, Iterable, Mapping, MutableMapping, Optional, Tuple

from .playback_state import PlaybackState
from .plex_service import PlexNotConnectedError, PlexService, PlexServiceError
from .transcoder_client import TranscoderClient, TranscoderServiceError
from .settings_service import SettingsService

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class PlaybackResult:
    """Represents the outcome of a playback start request."""

    status_code: int
    source: Mapping[str, Any]
    transcode: Mapping[str, Any]
    details: Optional[Mapping[str, Any]]


class PlaybackCoordinatorError(RuntimeError):
    """Raised when coordinating playback actions fails."""

    def __init__(self, message: str, *, status_code: int = HTTPStatus.BAD_REQUEST) -> None:
        super().__init__(message)
        self.status_code = status_code


class PlaybackCoordinator:
    """Encapsulates the logic for starting and stopping playback sessions."""

    def __init__(
        self,
        *,
        plex_service: PlexService,
        transcoder_client: TranscoderClient,
        playback_state: PlaybackState,
        config: Mapping[str, Any],
        settings_service: SettingsService,
    ) -> None:
        self._plex = plex_service
        self._client = transcoder_client
        self._playback_state = playback_state
        self._config = config
        self._settings_service = settings_service

    def start_playback(
        self,
        rating_key: str,
        *,
        part_id: Optional[str] = None,
        session: Optional[Mapping[str, Any]] = None,
    ) -> PlaybackResult:
        """Start playback for the given Plex rating key."""

        if session is None:
            generated_id = uuid.uuid4().hex
            session = {
                "id": generated_id,
                "segment_prefix": f"sessions/{generated_id}",
            }
        session_identifier = None
        if isinstance(session, Mapping):
            raw_session_id = session.get("id")
            if isinstance(raw_session_id, str):
                session_identifier = raw_session_id
        LOGGER.info(
            "PlaybackCoordinator.start_playback requested (rating_key=%s part_id=%s session_id=%s)",
            rating_key,
            part_id,
            session_identifier,
        )

        try:
            source = self._plex.resolve_media_source(rating_key, part_id=part_id)
        except PlexNotConnectedError as exc:
            raise PlaybackCoordinatorError(str(exc), status_code=HTTPStatus.BAD_REQUEST) from exc
        except PlexServiceError as exc:
            raise PlaybackCoordinatorError(str(exc), status_code=HTTPStatus.NOT_FOUND) from exc

        overrides = self._build_transcoder_overrides(rating_key, part_id, source, session=session)

        self._ensure_stopped_before_start(rating_key, part_id)

        status_code, payload = self._attempt_start(overrides, rating_key, part_id)

        if payload is None:
            raise PlaybackCoordinatorError(
                "Invalid response from transcoder service.",
                status_code=HTTPStatus.BAD_GATEWAY,
            )

        if status_code not in (HTTPStatus.ACCEPTED, HTTPStatus.OK):
            message = payload.get("error") if isinstance(payload, Mapping) else None
            if not message:
                message = f"transcoder start request failed ({status_code})"
            raise PlaybackCoordinatorError(message, status_code=HTTPStatus.BAD_GATEWAY)

        details_payload = None
        try:
            details_payload = self._plex.item_details(rating_key)
        except PlexServiceError as exc:
            LOGGER.warning("Failed to fetch detailed Plex metadata for %s: %s", rating_key, exc)

        subtitle_tracks: list[dict[str, Any]] = []
        if isinstance(payload, Mapping):
            status_section = payload.get("status") if isinstance(payload.get("status"), Mapping) else payload
            if isinstance(status_section, Mapping):
                session_section = status_section.get("session") if isinstance(status_section.get("session"), Mapping) else None
                if isinstance(session_section, Mapping):
                    subtitles_source = session_section.get("subtitles")
                    if isinstance(subtitles_source, list):
                        subtitle_tracks = [track for track in subtitles_source if isinstance(track, Mapping)]

        self._playback_state.update(
            rating_key=rating_key,
            source=source,
            details=details_payload,
            subtitles=subtitle_tracks,
            session_id=session_identifier,
        )
        LOGGER.info(
            "PlaybackCoordinator.start_playback succeeded (session_id=%s status_code=%s)",
            session_identifier,
            status_code,
        )

        transcode_payload = payload if isinstance(payload, Mapping) else {}
        return PlaybackResult(
            status_code=status_code,
            source=source,
            transcode=transcode_payload,
            details=details_payload,
        )

    def prepare_subtitles(self, rating_key: str, *, part_id: Optional[str] = None) -> Mapping[str, Any]:
        """Trigger subtitle extraction without starting playback."""

        try:
            source = self._plex.resolve_media_source(rating_key, part_id=part_id)
        except PlexNotConnectedError as exc:
            raise PlaybackCoordinatorError(str(exc), status_code=HTTPStatus.BAD_REQUEST) from exc
        except PlexServiceError as exc:
            raise PlaybackCoordinatorError(str(exc), status_code=HTTPStatus.NOT_FOUND) from exc

        overrides = self._build_transcoder_overrides(rating_key, part_id, source, session=None)

        try:
            status_code, payload = self._client.extract_subtitles(overrides)
        except TranscoderServiceError as exc:
            raise PlaybackCoordinatorError(
                "transcoder service unavailable",
                status_code=HTTPStatus.BAD_GATEWAY,
            ) from exc

        if status_code not in (HTTPStatus.ACCEPTED, HTTPStatus.OK):
            message = None
            if isinstance(payload, Mapping):
                message = payload.get("error")
            if not message:
                message = f"subtitle extraction request failed ({status_code})"
            raise PlaybackCoordinatorError(message, status_code=HTTPStatus.BAD_GATEWAY)

        return payload or {}

    def stop_playback(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        """Stop the active transcoder run and clear playback state when appropriate."""

        try:
            status_code, payload = self._client.stop()
        except TranscoderServiceError as exc:
            raise PlaybackCoordinatorError(
                "transcoder service unavailable",
                status_code=HTTPStatus.BAD_GATEWAY,
            ) from exc

        if status_code == HTTPStatus.CONFLICT:
            LOGGER.info("Transcoder stop reported no active run; treating as success.")
            normalized_payload: MutableMapping[str, Any]
            if isinstance(payload, MutableMapping):
                status_section = payload.get("status")
                if isinstance(status_section, Mapping):
                    normalized_payload = dict(status_section)
                else:
                    normalized_payload = dict(payload)
                    normalized_payload.pop("error", None)
            else:
                normalized_payload = {}
            payload = normalized_payload
            status_code = HTTPStatus.OK

        if status_code == HTTPStatus.OK:
            self._playback_state.clear()
        return status_code, payload

    def _ensure_stopped_before_start(self, rating_key: str, part_id: Optional[str]) -> None:
        try:
            stop_code, stop_payload = self._client.stop()
        except TranscoderServiceError as exc:
            raise PlaybackCoordinatorError(
                "transcoder service unavailable",
                status_code=HTTPStatus.BAD_GATEWAY,
            ) from exc

        if stop_code == HTTPStatus.OK:
            LOGGER.info(
                "Stopped active transcoder run prior to starting new playback (rating_key=%s, part_id=%s)",
                rating_key,
                part_id,
            )
            self._playback_state.clear()
            return

        if stop_code in (HTTPStatus.CONFLICT,):
            self._playback_state.clear()
            return

        message = None
        if isinstance(stop_payload, Mapping):
            message = stop_payload.get("error")
        if not message:
            message = f"transcoder stop request failed ({stop_code})"
        raise PlaybackCoordinatorError(message, status_code=HTTPStatus.BAD_GATEWAY)

    def _attempt_start(
        self,
        overrides: Mapping[str, Any],
        rating_key: str,
        part_id: Optional[str],
    ) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        try:
            status_code, payload = self._client.start(overrides)
        except TranscoderServiceError as exc:
            raise PlaybackCoordinatorError(
                "transcoder service unavailable",
                status_code=HTTPStatus.BAD_GATEWAY,
            ) from exc

        if status_code == HTTPStatus.CONFLICT:
            LOGGER.info(
                "Transcoder reported conflict after stop attempt; retrying start (rating_key=%s, part_id=%s)",
                rating_key,
                part_id,
            )
            self._ensure_stopped_before_start(rating_key, part_id)
            try:
                status_code, payload = self._client.start(overrides)
            except TranscoderServiceError as exc:
                raise PlaybackCoordinatorError(
                    "transcoder service unavailable",
                    status_code=HTTPStatus.BAD_GATEWAY,
                ) from exc
        return status_code, payload

    def _build_transcoder_overrides(
        self,
        rating_key: str,
        part_id: Optional[str],
        source: Mapping[str, Any],
        *,
        session: Optional[Mapping[str, Any]] = None,
    ) -> Mapping[str, Any]:
        config = self._config
        overrides: dict[str, Any] = {
            "input_path": source.get("file"),
            "output_basename": config.get("TRANSCODER_OUTPUT_BASENAME"),
            "realtime_input": True,
        }
        media_type = source.get("media_type")
        if media_type == "audio":
            overrides["max_video_tracks"] = 0
            overrides.setdefault("max_audio_tracks", 1)
        else:
            overrides.setdefault("max_video_tracks", 1)
            overrides.setdefault("max_audio_tracks", 1)

        subtitle_meta: dict[str, Any] = {"rating_key": str(rating_key)}
        normalized_part = part_id if part_id is not None else source.get("part_id")
        if normalized_part is not None:
            subtitle_meta["part_id"] = str(normalized_part)
        settings_overrides = self._settings_overrides()
        subtitle_preferences = settings_overrides.pop("subtitle_preferences", None)
        if subtitle_preferences:
            subtitle_meta["preferences"] = subtitle_preferences

        overrides["subtitle"] = subtitle_meta

        overrides.update(settings_overrides)

        segment_prefix: Optional[str] = None
        if session:
            normalized_session: dict[str, Any] = {}
            session_id = session.get("id")
            if session_id is not None:
                normalized_session["id"] = str(session_id)
            retain = session.get("retain")
            if isinstance(retain, Iterable) and not isinstance(retain, (str, bytes)):
                normalized_session["retain"] = [str(entry) for entry in retain if str(entry)]
            prefix = session.get("segment_prefix")
            if prefix:
                segment_prefix = str(prefix).strip("/")
            elif session_id is not None:
                segment_prefix = f"sessions/{session_id}"

            if segment_prefix is None and session_id is None:
                session_id = uuid.uuid4().hex
                normalized_session.setdefault("id", session_id)
                segment_prefix = f"sessions/{session_id}"

            if segment_prefix is not None:
                normalized_session["segment_prefix"] = segment_prefix

            overrides["session"] = normalized_session

        if segment_prefix is None:
            generated_id = uuid.uuid4().hex
            segment_prefix = f"sessions/{generated_id}"
            overrides["session"] = {
                "id": generated_id,
                "segment_prefix": segment_prefix,
            }

        if segment_prefix:
            dash_overrides = dict(overrides.get("dash") or {})
            dash_overrides["init_segment_name"] = f"{segment_prefix}/init-$RepresentationID$.m4s"
            dash_overrides["media_segment_name"] = f"{segment_prefix}/chunk-$RepresentationID$-$Number%05d$.m4s"
            overrides["dash"] = dash_overrides
        return overrides

    @staticmethod
    def _parse_sequence(value: Any) -> Tuple[str, ...]:
        if value is None:
            return tuple()
        if isinstance(value, (list, tuple, set)):
            return tuple(str(item).strip() for item in value if str(item).strip())
        if isinstance(value, str):
            normalized = value.replace("\r\n", "\n")
            tokens: list[str] = []
            buffer: list[str] = []
            in_single = False
            in_double = False
            escape = False

            def flush_buffer() -> None:
                if buffer:
                    token = "".join(buffer)
                    if token:
                        tokens.append(token)
                    buffer.clear()

            for char in normalized:
                if escape:
                    buffer.append(char)
                    escape = False
                    continue
                if char == "\\":
                    escape = True
                    continue
                if char == "'" and not in_double:
                    in_single = not in_single
                    continue
                if char == '"' and not in_single:
                    in_double = not in_double
                    continue
                if char == "\n" and (in_single or in_double):
                    buffer.append(",")
                    continue
                if (char.isspace() or char == ",") and not in_single and not in_double:
                    flush_buffer()
                    continue
                buffer.append(char)

            if escape:
                buffer.append("\\")
            flush_buffer()
            if in_single or in_double:
                # Unbalanced quotes: treat as literal tokens by splitting on whitespace.
                return tuple(part for part in normalized.split() if part)
            return tuple(tokens)
        return (str(value).strip(),) if str(value).strip() else tuple()

    @staticmethod
    def _coerce_optional_str(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _coerce_optional_int(value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
        try:
            text = str(value).strip()
        except Exception:  # pragma: no cover - defensive
            return None
        if not text:
            return None
        try:
            return int(float(text))
        except ValueError:
            return None

    @staticmethod
    def _coerce_optional_float(value: Any) -> Optional[float]:
        if value is None:
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        try:
            text = str(value).strip()
        except Exception:  # pragma: no cover - defensive
            return None
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None

    @staticmethod
    def _coerce_bool(value: Any, fallback: Optional[bool] = None) -> Optional[bool]:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1", "yes", "on"}:
                return True
            if lowered in {"false", "0", "no", "off"}:
                return False
        return fallback

    @staticmethod
    def _normalize_optional_float(
        value: Any,
        fallback: Optional[float],
        *,
        minimum: Optional[float] = None,
        maximum: Optional[float] = None,
        allow_none: bool = False,
    ) -> Optional[float]:
        if value is None:
            return None if allow_none else fallback
        if isinstance(value, str) and not value.strip():
            return None if allow_none else fallback
        try:
            candidate = float(value)
        except (TypeError, ValueError):
            return None if allow_none else fallback
        if not math.isfinite(candidate):
            return None if allow_none else fallback
        if minimum is not None and candidate < minimum:
            candidate = minimum
        if maximum is not None and candidate > maximum:
            candidate = maximum
        return candidate

    @staticmethod
    def _coerce_optional_bool(value: Any) -> Optional[bool]:
        if value is None:
            return None
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1", "yes", "on"}:
                return True
            if lowered in {"false", "0", "no", "off", ""}:
                return False
        return None

    def _video_overrides(self, settings: Mapping[str, Any]) -> Mapping[str, Any]:
        overrides: dict[str, Any] = {}

        codec = self._coerce_optional_str(settings.get("VIDEO_CODEC"))
        if codec:
            overrides["codec"] = codec

        for key, attr in (
            ("VIDEO_BITRATE", "bitrate"),
            ("VIDEO_MAXRATE", "maxrate"),
            ("VIDEO_BUFSIZE", "bufsize"),
            ("VIDEO_PRESET", "preset"),
            ("VIDEO_PROFILE", "profile"),
            ("VIDEO_TUNE", "tune"),
            ("VIDEO_VSYNC", "vsync"),
        ):
            value = self._coerce_optional_str(settings.get(key))
            if value is not None:
                overrides[attr] = value

        frame_rate = self._coerce_optional_str(settings.get("VIDEO_FPS"))
        if frame_rate is not None and frame_rate.lower() not in {"", "source"}:
            overrides["frame_rate"] = frame_rate

        for key, attr in (
            ("VIDEO_GOP_SIZE", "gop_size"),
            ("VIDEO_KEYINT_MIN", "keyint_min"),
            ("VIDEO_SC_THRESHOLD", "sc_threshold"),
            ("VIDEO_SCENE_CUT", "scene_cut"),
        ):
            value = self._coerce_optional_int(settings.get(key))
            if value is not None:
                overrides[attr] = value

        scale = (settings.get("VIDEO_SCALE") or "").strip().lower()
        if scale == "4k":
            filters: Tuple[str, ...] = ("scale=3840:-2",)
        elif scale == "1080p":
            filters = ("scale=1920:-2",)
        elif scale == "720p":
            filters = ("scale=1280:-2",)
        elif scale == "" or scale == "source":
            filters = tuple()
        else:  # custom
            filters = self._parse_sequence(settings.get("VIDEO_FILTERS"))

        if scale == "custom":
            # Respect custom filters, even if the user left the field blank.
            if filters:
                overrides["filters"] = filters
        else:
            overrides["filters"] = filters

        extra_args = self._parse_sequence(settings.get("VIDEO_EXTRA_ARGS"))
        if extra_args:
            overrides["extra_args"] = extra_args

        return overrides

    def _audio_overrides(self, settings: Mapping[str, Any]) -> Mapping[str, Any]:
        overrides: dict[str, Any] = {}

        codec = self._coerce_optional_str(settings.get("AUDIO_CODEC"))
        if codec:
            overrides["codec"] = codec

        bitrate = self._coerce_optional_str(settings.get("AUDIO_BITRATE"))
        if bitrate is not None:
            overrides["bitrate"] = bitrate

        channels = self._coerce_optional_int(settings.get("AUDIO_CHANNELS"))
        if channels is not None:
            overrides["channels"] = channels

        sample_rate = self._coerce_optional_int(settings.get("AUDIO_SAMPLE_RATE"))
        if sample_rate is not None:
            overrides["sample_rate"] = sample_rate

        profile = self._coerce_optional_str(settings.get("AUDIO_PROFILE"))
        if profile is not None:
            overrides["profile"] = profile

        filters = self._parse_sequence(settings.get("AUDIO_FILTERS"))
        if filters:
            overrides["filters"] = filters

        extra_args = self._parse_sequence(settings.get("AUDIO_EXTRA_ARGS"))
        if extra_args:
            overrides["extra_args"] = extra_args

        return overrides

    def _dash_overrides(self, settings: Mapping[str, Any]) -> Mapping[str, Any]:
        overrides: dict[str, Any] = {}

        offset = self._coerce_optional_float(settings.get("DASH_AVAILABILITY_OFFSET"))
        if offset is not None:
            overrides["availability_time_offset"] = max(0.0, offset)

        segment_duration = self._normalize_optional_float(
            settings.get("DASH_SEGMENT_DURATION"),
            fallback=None,
            minimum=0.0,
            allow_none=True,
        )
        if segment_duration is not None:
            overrides["segment_duration"] = segment_duration

        fragment_duration = self._normalize_optional_float(
            settings.get("DASH_FRAGMENT_DURATION"),
            fallback=None,
            minimum=0.0,
            allow_none=True,
        )
        if fragment_duration is not None:
            overrides["fragment_duration"] = fragment_duration

        min_segment_duration = self._coerce_optional_int(settings.get("DASH_MIN_SEGMENT_DURATION"))
        if min_segment_duration is not None and min_segment_duration >= 0:
            overrides["min_segment_duration"] = min_segment_duration

        window_size = self._coerce_optional_int(settings.get("DASH_WINDOW_SIZE"))
        if window_size is not None:
            overrides["window_size"] = max(1, window_size)

        extra_window = self._coerce_optional_int(settings.get("DASH_EXTRA_WINDOW_SIZE"))
        if extra_window is not None:
            overrides["extra_window_size"] = max(0, extra_window)

        retention_override = self._coerce_optional_int(settings.get("DASH_RETENTION_SEGMENTS"))
        if retention_override is not None:
            overrides["retention_segments"] = max(0, retention_override)

        streaming_flag = self._coerce_bool(settings.get("DASH_STREAMING"), None)
        if streaming_flag is not None:
            overrides["streaming"] = streaming_flag

        remove_at_exit = self._coerce_bool(settings.get("DASH_REMOVE_AT_EXIT"), None)
        if remove_at_exit is not None:
            overrides["remove_at_exit"] = remove_at_exit

        use_template = self._coerce_bool(settings.get("DASH_USE_TEMPLATE"), None)
        if use_template is not None:
            overrides["use_template"] = use_template

        use_timeline = self._coerce_bool(settings.get("DASH_USE_TIMELINE"), None)
        if use_timeline is not None:
            overrides["use_timeline"] = use_timeline

        http_user_agent = self._coerce_optional_str(settings.get("DASH_HTTP_USER_AGENT"))
        if http_user_agent is not None:
            agent = http_user_agent.strip()
            overrides["http_user_agent"] = agent or None

        mux_preload = self._normalize_optional_float(
            settings.get("DASH_MUX_PRELOAD"),
            fallback=None,
            minimum=0.0,
            allow_none=True,
        )
        if mux_preload is not None:
            overrides["mux_preload"] = mux_preload

        mux_delay = self._normalize_optional_float(
            settings.get("DASH_MUX_DELAY"),
            fallback=None,
            minimum=0.0,
            allow_none=True,
        )
        if mux_delay is not None:
            overrides["mux_delay"] = mux_delay

        init_name = self._coerce_optional_str(settings.get("DASH_INIT_SEGMENT_NAME"))
        if init_name is not None:
            overrides["init_segment_name"] = init_name.strip() or None

        media_name = self._coerce_optional_str(settings.get("DASH_MEDIA_SEGMENT_NAME"))
        if media_name is not None:
            overrides["media_segment_name"] = media_name.strip() or None

        adaptation_sets = self._coerce_optional_str(settings.get("DASH_ADAPTATION_SETS"))
        if adaptation_sets is not None:
            overrides["adaptation_sets"] = adaptation_sets.strip() or None

        extra_args = self._parse_sequence(settings.get("DASH_EXTRA_ARGS"))
        if extra_args:
            overrides["extra_args"] = extra_args

        return overrides

    def _settings_overrides(self) -> Mapping[str, Any]:
        try:
            settings = self._settings_service.get_system_settings(SettingsService.TRANSCODER_NAMESPACE)
        except Exception:  # pragma: no cover - defensive
            settings = {}

        if not settings:
            return {}

        overrides: dict[str, Any] = {}

        output_dir = self._coerce_optional_str(settings.get("TRANSCODER_LOCAL_OUTPUT_DIR"))
        if output_dir is not None and output_dir != "":
            overrides["output_dir"] = output_dir

        publish_base = self._coerce_optional_str(settings.get("TRANSCODER_PUBLISH_BASE_URL"))
        if publish_base is None:
            publish_base = self._coerce_optional_str(self._config.get("TRANSCODER_PUBLISH_BASE_URL"))
        if publish_base is not None:
            overrides["publish_base_url"] = publish_base

        copy_timestamps = self._coerce_optional_bool(settings.get("TRANSCODER_COPY_TIMESTAMPS"))
        if copy_timestamps is not None:
            overrides["copy_timestamps"] = bool(copy_timestamps)

        start_at_zero = self._coerce_optional_bool(settings.get("TRANSCODER_START_AT_ZERO"))
        if start_at_zero is not None:
            overrides["start_at_zero"] = bool(start_at_zero)

        auto_keyframing = self._coerce_optional_bool(settings.get("TRANSCODER_AUTO_KEYFRAMING"))
        if auto_keyframing is not None:
            overrides["auto_keyframing"] = bool(auto_keyframing)

        video_overrides = self._video_overrides(settings)
        if video_overrides:
            overrides["video"] = video_overrides

        audio_overrides = self._audio_overrides(settings)
        if audio_overrides:
            overrides["audio"] = audio_overrides

        dash_overrides = self._dash_overrides(settings)
        if dash_overrides:
            overrides["dash"] = dash_overrides
            LOGGER.debug(
                "PlaybackCoordinator dash overrides applied: %s",
                dash_overrides,
            )

        subtitle_preferences = self._subtitle_preferences(settings)
        if subtitle_preferences:
            overrides["subtitle_preferences"] = subtitle_preferences

        return overrides

    def _subtitle_preferences(self, settings: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
        preferred_language = self._coerce_optional_str(settings.get("SUBTITLE_PREFERRED_LANGUAGE"))
        if preferred_language:
            preferred_language = preferred_language.lower()

        include_forced = self._coerce_optional_bool(settings.get("SUBTITLE_INCLUDE_FORCED"))
        include_commentary = self._coerce_optional_bool(settings.get("SUBTITLE_INCLUDE_COMMENTARY"))
        include_sdh = self._coerce_optional_bool(settings.get("SUBTITLE_INCLUDE_SDH"))

        if not preferred_language:
            preferred_language = "en"

        return {
            "preferred_language": preferred_language,
            "include_forced": bool(include_forced),
            "include_commentary": bool(include_commentary),
            "include_sdh": bool(include_sdh),
        }

    def _effective_output_dir(self, overrides: Mapping[str, Any]) -> Path:
        candidate = overrides.get("output_dir") or self._config.get("TRANSCODER_OUTPUT")
        if not candidate:
            raise PlaybackCoordinatorError(
                "Transcoder output directory is not configured.",
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
        return Path(str(candidate)).expanduser()

    def _effective_publish_base_url(self, overrides: Mapping[str, Any]) -> Optional[str]:
        candidate = overrides.get("publish_base_url")
        if not candidate:
            candidate = self._config.get("TRANSCODER_PUBLISH_BASE_URL")
        if isinstance(candidate, str):
            trimmed = candidate.strip()
            if trimmed:
                return trimmed.rstrip("/") + "/"
        return None


__all__ = [
    "PlaybackCoordinator",
    "PlaybackCoordinatorError",
    "PlaybackResult",
]
