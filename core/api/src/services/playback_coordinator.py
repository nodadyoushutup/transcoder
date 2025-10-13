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

        self._playback_state.update(
            rating_key=rating_key,
            source=source,
            details=details_payload,
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

        bundle = self._settings_service.get_transcoder_settings_bundle()
        effective = bundle.effective
        derived = bundle.derived

        output_dir = self._coerce_optional_str(effective.get("TRANSCODER_LOCAL_OUTPUT_DIR"))
        if not output_dir:
            output_dir = self._coerce_optional_str(config.get("TRANSCODER_LOCAL_OUTPUT_DIR")) \
                or self._coerce_optional_str(config.get("TRANSCODER_OUTPUT"))
        if output_dir:
            overrides["output_dir"] = output_dir

        publish_base = self._coerce_optional_str(effective.get("TRANSCODER_PUBLISH_BASE_URL"))
        if not publish_base:
            publish_base = self._coerce_optional_str(config.get("TRANSCODER_PUBLISH_BASE_URL"))
        if publish_base:
            overrides["publish_base_url"] = publish_base

        overrides["auto_keyframing"] = bool(effective.get("TRANSCODER_AUTO_KEYFRAMING", True))

        video_options: dict[str, Any] = {}
        codec = self._coerce_optional_str(effective.get("TRANSCODER_VIDEO_CODEC"))
        if codec:
            video_options["codec"] = codec
        bitrate = self._coerce_optional_str(effective.get("TRANSCODER_VIDEO_BITRATE"))
        if bitrate:
            video_options["bitrate"] = bitrate
        maxrate = self._coerce_optional_str(effective.get("TRANSCODER_VIDEO_MAXRATE"))
        if maxrate:
            video_options["maxrate"] = maxrate
        bufsize = self._coerce_optional_str(effective.get("TRANSCODER_VIDEO_BUFSIZE"))
        if bufsize:
            video_options["bufsize"] = bufsize
        preset = self._coerce_optional_str(effective.get("TRANSCODER_VIDEO_PRESET"))
        if preset:
            video_options["preset"] = preset
        video_options["sc_threshold"] = effective.get("TRANSCODER_VIDEO_SC_THRESHOLD")
        video_options["scene_cut"] = effective.get("TRANSCODER_VIDEO_SCENECUT")
        overrides["video"] = video_options

        audio_options: dict[str, Any] = {}
        audio_codec = self._coerce_optional_str(effective.get("TRANSCODER_AUDIO_CODEC"))
        if audio_codec:
            audio_options["codec"] = audio_codec
        audio_bitrate = self._coerce_optional_str(effective.get("TRANSCODER_AUDIO_BITRATE"))
        if audio_bitrate:
            audio_options["bitrate"] = audio_bitrate
        channels = effective.get("TRANSCODER_AUDIO_CHANNELS")
        if isinstance(channels, int) and channels > 0:
            audio_options["channels"] = channels
        overrides["audio"] = audio_options

        segment_seconds = float(effective.get("TRANSCODER_SEGMENT_DURATION_SECONDS", 2.0))
        dash_options: dict[str, Any] = {
            "segment_duration": segment_seconds,
            "fragment_duration": segment_seconds,
        }
        overrides["dash"] = dash_options

        packager_options: dict[str, Any] = {
            "binary": self._coerce_optional_str(effective.get("TRANSCODER_PACKAGER_BINARY")) or "packager",
            "segment_duration": segment_seconds,
            "minimum_update_period": effective.get("TRANSCODER_MINIMUM_UPDATE_PERIOD_SECONDS"),
            "time_shift_buffer_depth": effective.get("TRANSCODER_TIME_SHIFT_BUFFER_SECONDS"),
            "suggested_presentation_delay": derived.get("suggested_presentation_delay_seconds"),
        }
        overrides["packager"] = packager_options

        timing_overrides: dict[str, Any] = {
            "segment_seconds": segment_seconds,
            "fragment_duration_us": derived.get("fragment_duration_us"),
            "keep_segments": effective.get("TRANSCODER_KEEP_SEGMENTS"),
            "cleanup_interval_seconds": effective.get("TRANSCODER_CLEANUP_INTERVAL_SECONDS"),
            "minimum_update_period_seconds": effective.get("TRANSCODER_MINIMUM_UPDATE_PERIOD_SECONDS"),
            "time_shift_buffer_seconds": effective.get("TRANSCODER_TIME_SHIFT_BUFFER_SECONDS"),
            "suggested_presentation_delay_seconds": derived.get("suggested_presentation_delay_seconds"),
            "force_keyframe_expression": derived.get("force_keyframe_expression"),
        }
        overrides["timing"] = timing_overrides

        layout_overrides: dict[str, Any] = {
            "manifest_name": self._coerce_optional_str(effective.get("TRANSCODER_MANIFEST_NAME")) or "manifest.mpd",
            "video_segment_template": self._coerce_optional_str(effective.get("TRANSCODER_VIDEO_SEGMENT_TEMPLATE")) or "video_$Number$.m4s",
            "audio_segment_template": self._coerce_optional_str(effective.get("TRANSCODER_AUDIO_SEGMENT_TEMPLATE")) or "audio_$Number$.m4s",
        }
        overrides["layout"] = layout_overrides

        segment_prefix: Optional[str] = None
        segment_root = self._coerce_optional_str(effective.get("TRANSCODER_SESSION_SUBDIR")) or "sessions"
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
                segment_prefix = f"{segment_root}/{session_id}"

            if segment_prefix is None and session_id is None:
                session_id = uuid.uuid4().hex
                normalized_session.setdefault("id", session_id)
                segment_prefix = f"{segment_root}/{session_id}"

            if segment_prefix is not None:
                normalized_session["segment_prefix"] = segment_prefix

            overrides["session"] = normalized_session

        if segment_prefix is None:
            generated_id = uuid.uuid4().hex
            segment_prefix = f"{segment_root}/{generated_id}"
            overrides["session"] = {
                "id": generated_id,
                "segment_prefix": segment_prefix,
            }

        overrides["layout"]["session_segment_prefix"] = segment_prefix
        if output_dir and segment_prefix:
            manifest_name = overrides["layout"].get("manifest_name")
            if manifest_name:
                manifest_path = Path(output_dir) / segment_prefix / manifest_name
                overrides["manifest_target"] = str(manifest_path)

        return overrides

    @staticmethod
    def _coerce_optional_str(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _normalize_vsync_value(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        text = value.strip().lower()
        if not text:
            return None
        mapping = {
            "-1": "auto",
            "auto": "auto",
            "0": "passthrough",
            "passthrough": "passthrough",
            "passthru": "passthrough",
            "keep": "passthrough",
            "1": "cfr",
            "cfr": "cfr",
            "dup": "cfr",
            "2": "vfr",
            "vfr": "vfr",
            "drop": "drop",
        }
        normalized = mapping.get(text)
        if normalized is not None:
            return normalized
        if text in {"auto", "passthrough", "cfr", "vfr", "drop"}:
            return text
        return None

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
