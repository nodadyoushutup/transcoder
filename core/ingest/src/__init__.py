"""Ingest service application factory."""
from __future__ import annotations

import hmac
import logging
import os
import shutil
import signal
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory

from .config import build_default_config
from .logging_config import configure_logging

LOGGER = logging.getLogger(__name__)


def create_app() -> Flask:
    """Create and configure the ingest Flask application."""

    configure_logging("ingest")
    app = Flask(__name__)
    app.config.from_mapping(build_default_config())

    restart_delay = 0.75

    def _expected_internal_token() -> Optional[str]:
        token = app.config.get("TRANSCODER_INTERNAL_TOKEN")
        if isinstance(token, str):
            trimmed = token.strip()
            if trimmed:
                return trimmed
        env_token = os.getenv("TRANSCODER_INTERNAL_TOKEN")
        if isinstance(env_token, str):
            trimmed = env_token.strip()
            if trimmed:
                return trimmed
        return None

    def _extract_internal_token() -> Optional[str]:
        auth_header = request.headers.get("Authorization")
        if isinstance(auth_header, str) and auth_header.lower().startswith("bearer "):
            candidate = auth_header[7:].strip()
            if candidate:
                return candidate
        header = request.headers.get("X-Internal-Token")
        if isinstance(header, str):
            candidate = header.strip()
            if candidate:
                return candidate
        return None

    def _require_internal_token() -> Optional[tuple[Any, int]]:
        expected = _expected_internal_token()
        if not expected:
            app.logger.warning("Internal restart blocked: token not configured")
            return jsonify({"error": "internal access not configured"}), 503

        provided = _extract_internal_token()
        if not provided:
            return jsonify({"error": "missing token"}), 401

        if not hmac.compare_digest(provided, expected):
            app.logger.warning("Internal restart blocked: invalid token provided")
            return jsonify({"error": "invalid token"}), 403

        return None

    def _schedule_restart() -> None:
        parent_pid = os.getppid()
        target_pid = parent_pid if parent_pid > 1 else os.getpid()

        def _worker(pid: int) -> None:
            time.sleep(restart_delay)
            try:
                os.kill(pid, signal.SIGHUP)
                app.logger.info("Sent SIGHUP to pid %s to trigger restart", pid)
            except OSError as exc:
                app.logger.warning("Restart via SIGHUP failed for pid %s: %s", pid, exc)
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError as fallback_exc:
                    app.logger.error("SIGTERM fallback failed for pid %s: %s", pid, fallback_exc)

        threading.Thread(target=_worker, args=(target_pid,), daemon=True).start()

    output_root = Path(app.config["TRANSCODER_OUTPUT"]).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    cors_origin = app.config.get("TRANSCODER_CORS_ORIGIN", "*")

    cache_max_age = int(app.config.get("INGEST_CACHE_MAX_AGE", 0))
    raw_cache_exts: Iterable[str]
    cache_config = app.config.get("INGEST_CACHE_EXTENSIONS", ())
    if isinstance(cache_config, str):
        raw_cache_exts = [piece.strip() for piece in cache_config.split(",") if piece.strip()]
    else:
        raw_cache_exts = cache_config
    cache_extensions = {ext.lower().lstrip(".") for ext in raw_cache_exts}

    def resolve_target(name: str) -> Path:
        candidate = (output_root / name).expanduser().resolve()
        try:
            candidate.relative_to(output_root)
        except ValueError:
            abort(400, description="Invalid media path")
        return candidate

    def _should_cache(name: str) -> bool:
        if not cache_extensions:
            return False
        if "." not in name:
            return False
        extension = name.rsplit(".", 1)[-1].lower()
        if extension == "mpd":
            return False
        return extension in cache_extensions

    def _remote_addr() -> str:
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return request.remote_addr or "unknown"

    def _retention_segments() -> int:
        value = app.config.get("INGEST_RETENTION_SEGMENTS", 0)
        try:
            retain = int(value)
        except (TypeError, ValueError):
            return 0
        return retain if retain > 0 else 0

    def _segment_metadata(name: str) -> tuple[str | None, int | None]:
        if not name.startswith("chunk-"):
            return None, None
        remainder = name[6:]
        if "-" not in remainder:
            return None, None
        rep_part, rest = remainder.split("-", 1)
        if not rep_part:
            return None, None
        number_str = rest.split(".", 1)[0]
        if not number_str:
            return None, None
        try:
            return rep_part, int(number_str)
        except ValueError:
            return None, None

    def _prune_segment(target_path: Path) -> None:
        retain = _retention_segments()
        if retain <= 0:
            return
        if target_path.suffix.lower() != ".m4s":
            return
        if target_path.name.startswith("init-"):
            return

        rep_id, _sequence = _segment_metadata(target_path.name)
        if rep_id is None:
            return

        session_dir = target_path.parent
        if not session_dir.exists():
            return

        candidates: list[tuple[int, Path]] = []
        for candidate in session_dir.glob(f"chunk-{rep_id}-*.m4s"):
            _, number = _segment_metadata(candidate.name)
            if number is None:
                continue
            candidates.append((number, candidate))

        if len(candidates) <= retain:
            return

        candidates.sort(key=lambda item: item[0])
        stale_candidates = candidates[:-retain]
        removed = 0
        for _, stale_path in stale_candidates:
            try:
                stale_path.unlink()
            except FileNotFoundError:
                continue
            except OSError as exc:
                LOGGER.warning("Failed to prune stale segment %s: %s", stale_path, exc)
            else:
                removed += 1

        if removed:
            LOGGER.info(
                "Pruned %d stale segment(s) in %s for representation %s (retain=%d)",
                removed,
                session_dir,
                rep_id,
                retain,
            )

    @app.before_request
    def track_request_start() -> None:
        g.ingest_started = time.perf_counter()

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        origin = request.headers.get("Origin")
        allowed_origin = cors_origin
        if cors_origin == "*" and origin:
            allowed_origin = origin
        response.headers["Access-Control-Allow-Origin"] = allowed_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,PUT,DELETE,HEAD,OPTIONS"
        if allowed_origin != "*":
            response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        if origin:
            response.headers.add("Vary", "Origin")

        duration_ms: float | None = None
        if hasattr(g, "ingest_started"):
            duration_ms = (time.perf_counter() - g.ingest_started) * 1000

        content_length = response.calculate_content_length()
        if content_length is None:
            header_length = response.headers.get("Content-Length")
            if header_length is not None:
                try:
                    content_length = int(header_length)
                except ValueError:
                    content_length = None

        size_display = str(content_length) if content_length is not None else "?"
        duration_display = f"{duration_ms:.2f}" if duration_ms is not None else "?"

        LOGGER.info(
            "%s %s -> %s (%s bytes) in %s ms (client=%s)",
            request.method,
            request.path,
            response.status_code,
            size_display,
            duration_display,
            _remote_addr(),
        )
        return response

    @app.post("/internal/restart")
    def internal_restart() -> Any:
        auth_error = _require_internal_token()
        if auth_error:
            return auth_error
        app.logger.info("Internal restart requested", extra={"event": "service_restart_requested", "service": "ingest"})
        _schedule_restart()
        return jsonify({"status": "scheduled"}), 202

    @app.get("/health")
    def health() -> Any:
        return jsonify({
            "status": "ok",
            "output_dir": str(output_root),
            "enable_put": bool(app.config.get("INGEST_ENABLE_PUT", True)),
            "enable_delete": bool(app.config.get("INGEST_ENABLE_DELETE", True)),
        })

    @app.route("/media/<path:filename>", methods=["GET", "HEAD", "PUT", "DELETE", "OPTIONS"])
    def media(filename: str):  # type: ignore[override]
        if request.method == "OPTIONS":
            return "", 204

        target = resolve_target(filename)

        if request.method in {"GET", "HEAD"}:
            if not target.exists() or not target.is_file():
                abort(404)
            should_cache = _should_cache(filename)
            response = send_from_directory(
                str(output_root),
                filename,
                conditional=True,
                max_age=cache_max_age if should_cache and cache_max_age > 0 else None,
            )
            if should_cache:
                if cache_max_age > 0:
                    response.headers["Cache-Control"] = f"public, max-age={cache_max_age}"
                else:
                    response.headers.setdefault("Cache-Control", "no-cache")

                etag, _ = response.get_etag()
                if etag is None:
                    # Use nanosecond precision mtime so clients can short-circuit re-downloads quickly.
                    response.set_etag(str(target.stat().st_mtime_ns))

                if response.last_modified is None:
                    response.last_modified = datetime.fromtimestamp(
                        target.stat().st_mtime, tz=timezone.utc
                    )

            return response

        if request.method == "PUT":
            if not app.config.get("INGEST_ENABLE_PUT", True):
                abort(405)
            was_existing = target.exists()
            target.parent.mkdir(parents=True, exist_ok=True)

            tmp_fd = None
            tmp_path: Path | None = None
            try:
                tmp_fd, tmp_name = tempfile.mkstemp(
                    dir=str(target.parent),
                    prefix=f".{target.name}.",
                    suffix=".tmp",
                )
                tmp_path = Path(tmp_name)
                with os.fdopen(tmp_fd, "wb") as handle:
                    tmp_fd = None  # ownership transferred to the file object
                    shutil.copyfileobj(request.stream, handle, length=1024 * 1024)
                    handle.flush()
                    os.fsync(handle.fileno())

                os.replace(tmp_path, target)
                tmp_path = None
            except Exception:
                if tmp_fd is not None:
                    os.close(tmp_fd)
                if tmp_path is not None and tmp_path.exists():
                    try:
                        tmp_path.unlink()
                    except OSError:
                        LOGGER.warning("Failed to clean up temporary upload %s", tmp_path)
                raise

            size_bytes = target.stat().st_size
            LOGGER.info(
                "Stored %s (%s) size=%d bytes (client=%s)",
                target,
                "replace" if was_existing else "create",
                size_bytes,
                _remote_addr(),
            )
            _prune_segment(target)
            return "", 200 if was_existing else 201

        if request.method == "DELETE":
            if not app.config.get("INGEST_ENABLE_DELETE", True):
                return "", 204
            if target.exists():
                try:
                    target.unlink()
                    LOGGER.info("Deleted %s (client=%s)", target, _remote_addr())
                except OSError as exc:
                    LOGGER.exception("Failed to delete %s", target)
                    abort(500, description=str(exc))
            return "", 204

        abort(405)

    return app


__all__ = ["create_app"]
