"""HTTP client for interacting with the transcoder microservice."""
from __future__ import annotations

import logging
from typing import Any, Mapping, MutableMapping, Optional, Tuple

import requests

LOGGER = logging.getLogger(__name__)


class TranscoderServiceError(RuntimeError):
    """Raised when the transcoder service cannot be reached."""


class TranscoderClient:
    """Thin wrapper around the transcoder HTTP API."""

    def __init__(self, base_url: str, *, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._session = requests.Session()

    def _url(self, path: str) -> str:
        return f"{self._base_url}/{path.lstrip('/')}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Mapping[str, Any]] = None,
    ) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        url = self._url(path)
        try:
            response = self._session.request(method, url, json=json, timeout=self._timeout)
        except requests.RequestException as exc:  # pragma: no cover - network failure path
            LOGGER.error("Transcoder service request failed: %s", exc)
            raise TranscoderServiceError("transcoder service unavailable") from exc

        try:
            payload = response.json()
        except ValueError:  # pragma: no cover - service returned non-JSON response
            payload = None
        return response.status_code, payload

    def health(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("GET", "/health")

    def status(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("GET", "/transcode/status")

    def start(self, body: Mapping[str, Any]) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("POST", "/transcode/start", json=body)

    def stop(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("POST", "/transcode/stop")


__all__ = ["TranscoderClient", "TranscoderServiceError"]
