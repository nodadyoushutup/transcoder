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

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 10.0,
        internal_token: Optional[str] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._session = requests.Session()
        token = internal_token.strip() if isinstance(internal_token, str) else None
        self._internal_token = token or None

    def _url(self, path: str) -> str:
        return f"{self._base_url}/{path.lstrip('/')}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        url = self._url(path)
        try:
            response = self._session.request(
                method,
                url,
                json=json,
                headers=headers,
                timeout=self._timeout,
            )
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
        return self._request("GET", "/status")

    def start(self, body: Mapping[str, Any]) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("POST", "/transcode", json=body)

    def stop(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("POST", "/transcode/stop")

    def task_status(self, task_id: str) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        return self._request("GET", f"/tasks/{task_id}")

    def restart(self) -> Tuple[int, Optional[MutableMapping[str, Any]]]:
        headers = None
        if self._internal_token:
            headers = {
                "Authorization": f"Bearer {self._internal_token}",
                "X-Internal-Token": self._internal_token,
            }
        return self._request("POST", "/internal/restart", headers=headers)


__all__ = ["TranscoderClient", "TranscoderServiceError"]
