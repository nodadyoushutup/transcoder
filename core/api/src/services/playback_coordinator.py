"""High-level helpers for coordinating playback start and stop events."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any, Mapping, MutableMapping, Optional, Tuple

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

    def start_playback(self, rating_key: str, *, part_id: Optional[str] = None) -> PlaybackResult:
        """Start playback for the given Plex rating key."""

        try:
            source = self._plex.resolve_media_source(rating_key, part_id=part_id)
        except PlexNotConnectedError as exc:
            raise PlaybackCoordinatorError(str(exc), status_code=HTTPStatus.BAD_REQUEST) from exc
        except PlexServiceError as exc:
            raise PlaybackCoordinatorError(str(exc), status_code=HTTPStatus.NOT_FOUND) from exc

        overrides = self._build_transcoder_overrides(source)

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

        if status_code in (HTTPStatus.OK, HTTPStatus.CONFLICT):
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

    def _build_transcoder_overrides(self, source: Mapping[str, Any]) -> Mapping[str, Any]:
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

        overrides.update(self._settings_overrides())
        return overrides

    @staticmethod
    def _parse_sequence(value: Any) -> Tuple[str, ...]:
        if value is None:
            return tuple()
        if isinstance(value, (list, tuple, set)):
            return tuple(str(item).strip() for item in value if str(item).strip())
        if isinstance(value, str):
            candidates = value.replace(",", "\n").splitlines()
            entries = [entry.strip() for entry in candidates if entry.strip()]
            return tuple(entries)
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

        video_overrides = self._video_overrides(settings)
        if video_overrides:
            overrides["video"] = video_overrides

        audio_overrides = self._audio_overrides(settings)
        if audio_overrides:
            overrides["audio"] = audio_overrides

        return overrides


__all__ = [
    "PlaybackCoordinator",
    "PlaybackCoordinatorError",
    "PlaybackResult",
]
