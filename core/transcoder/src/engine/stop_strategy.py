"""Signal orchestration used to stop live transcoder runs."""
from __future__ import annotations

import logging
import signal
from dataclasses import dataclass
from subprocess import TimeoutExpired
from typing import Optional

from transcoder import LiveEncodingHandle

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class StopResult:
    """Outcome of attempting to stop the FFmpeg encoder and packager."""

    returncode: Optional[int]
    packager_returncode: Optional[int]


class StopStrategy:
    """Coordinate graceful shutdown of the encoder and auxiliary processes."""

    def __init__(
        self,
        *,
        graceful_timeout: float = 5.0,
        terminate_timeout: float = 5.0,
        kill_timeout: float = 2.0,
    ) -> None:
        self._graceful_timeout = max(0.0, graceful_timeout)
        self._terminate_timeout = max(0.0, terminate_timeout)
        self._kill_timeout = max(0.0, kill_timeout)

    def shutdown(self, handle: LiveEncodingHandle) -> StopResult:
        """Attempt to stop the encoder and packager processes."""

        process = handle.process
        try:
            LOGGER.info("Sending SIGINT to transcoder (pid=%s)", process.pid)
            process.send_signal(signal.SIGINT)
        except Exception as exc:  # pragma: no cover - system dependent
            LOGGER.exception("Failed to signal transcoder process: %s", exc)

        returncode = self._wait_for_exit(process, self._graceful_timeout)
        if returncode is None and process.poll() is None:
            LOGGER.warning("Transcoder still running after SIGINT; sending SIGTERM")
            try:
                process.terminate()
            except Exception as exc:  # pragma: no cover - system dependent
                LOGGER.exception("Failed to terminate transcoder process: %s", exc)
            returncode = self._wait_for_exit(process, self._terminate_timeout)

        if returncode is None and process.poll() is None:
            LOGGER.error("Transcoder ignored SIGTERM; sending SIGKILL")
            try:
                process.kill()
            except Exception as exc:  # pragma: no cover - system dependent
                LOGGER.exception("Failed to kill transcoder process: %s", exc)
            returncode = self._wait_for_exit(process, self._kill_timeout)
            if returncode is None:
                LOGGER.error("Transcoder process still running after SIGKILL attempt")
                returncode = process.returncode

        if returncode is not None:
            LOGGER.info("Transcoder exited with %s", returncode)
        else:
            LOGGER.warning("Transcoder exit code unknown after stop sequence")

        packager_returncode = self._shutdown_packager(handle)
        return StopResult(returncode=returncode, packager_returncode=packager_returncode)

    def _wait_for_exit(self, process, timeout: float) -> Optional[int]:
        try:
            return process.wait(timeout=timeout)
        except TimeoutExpired:
            return None

    def _shutdown_packager(self, handle: LiveEncodingHandle) -> Optional[int]:
        packager_process = handle.packager_process
        if not packager_process or packager_process.poll() is not None:
            return packager_process.returncode if packager_process else None

        try:
            LOGGER.info("Sending SIGINT to packager (pid=%s)", packager_process.pid)
            packager_process.send_signal(signal.SIGINT)
        except Exception:  # pragma: no cover - system dependent
            LOGGER.exception("Failed to signal packager process")

        returncode = self._wait_for_exit(packager_process, self._terminate_timeout)
        if returncode is not None:
            return returncode

        LOGGER.warning("Packager still running after SIGINT; sending SIGTERM")
        try:
            packager_process.terminate()
        except Exception:  # pragma: no cover - system dependent
            LOGGER.exception("Failed to terminate packager process")
        returncode = self._wait_for_exit(packager_process, self._kill_timeout)
        if returncode is not None:
            return returncode

        LOGGER.error("Packager process still running after SIGTERM; sending SIGKILL")
        try:
            packager_process.kill()
        except Exception:
            LOGGER.exception("Failed to kill packager process")
        returncode = self._wait_for_exit(packager_process, self._kill_timeout)
        if returncode is None:
            LOGGER.error("Packager process still running after SIGKILL attempt")
            return packager_process.returncode
        return returncode


__all__ = ["StopResult", "StopStrategy"]
