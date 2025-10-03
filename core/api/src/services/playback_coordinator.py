"""High-level helpers for coordinating playback start and stop events."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any, Mapping, MutableMapping, Optional, Tuple

from .playback_state import PlaybackState
from .plex_service import PlexNotConnectedError, PlexService, PlexServiceError
from .transcoder_client import TranscoderClient, TranscoderServiceError

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
    ) -> None:
        self._plex = plex_service
        self._client = transcoder_client
        self._playback_state = playback_state
        self._config = config

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
        return overrides


__all__ = [
    "PlaybackCoordinator",
    "PlaybackCoordinatorError",
    "PlaybackResult",
]
