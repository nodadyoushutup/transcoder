"""Chat message routes and socket broadcasting."""
from __future__ import annotations

import mimetypes
import re
import secrets
from http import HTTPStatus
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import requests
from flask import Blueprint, current_app, jsonify, request, send_file, url_for
from flask_login import current_user
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from ..extensions import socketio
from ..models import ChatAttachment, ChatMessage
from ..services import ChatService


CHAT_BLUEPRINT = Blueprint("chat", __name__, url_prefix="/chat")

MAX_MESSAGE_LENGTH = 4_096
MAX_ATTACHMENTS = 6
MAX_UPLOAD_BYTES = 6 * 1024 * 1024  # 6 MiB per upload
REMOTE_FETCH_TIMEOUT = 8
REMOTE_MAX_BYTES = 5 * 1024 * 1024
URL_PATTERN = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)


def _service() -> ChatService:
    svc: ChatService = current_app.extensions["chat_service"]
    return svc


def _serialize_message(message: ChatMessage) -> Dict[str, Any]:
    data = message.to_dict()
    attachments_payload = []
    for item in data.pop("attachments", []):
        attachment_id = item.get("id")
        attachments_payload.append(
            {
                **item,
                "url": url_for("chat.get_attachment", attachment_id=attachment_id, _external=False),
            }
        )
    data["attachments"] = attachments_payload
    return data


def _serialize_messages(messages: Iterable[ChatMessage]) -> List[Dict[str, Any]]:
    return [_serialize_message(message) for message in messages]


def _current_user_can_modify(message: ChatMessage) -> bool:
    if not current_user.is_authenticated:
        return False
    if getattr(current_user, "is_admin", False):
        return True
    return int(message.user_id) == int(current_user.id)


def _ensure_authenticated() -> Optional[Tuple[Any, int]]:
    if not current_user.is_authenticated:
        return jsonify({"error": "authentication required"}), HTTPStatus.UNAUTHORIZED
    return None


def _clean_body(body: str) -> str:
    return body.strip()


def _validate_body(body: str, *, allow_blank: bool = False) -> Optional[Tuple[Any, int]]:
    if not body and not allow_blank:
        return jsonify({"error": "message body required"}), HTTPStatus.BAD_REQUEST
    if len(body) > MAX_MESSAGE_LENGTH:
        return jsonify({"error": "message too long"}), HTTPStatus.BAD_REQUEST
    return None


def _generate_filename(original_name: Optional[str], mime_type: str) -> str:
    token = secrets.token_hex(16)
    guessed_ext = None
    if mime_type:
        guessed_ext = mimetypes.guess_extension(mime_type.split(";")[0].strip())
    if not guessed_ext and original_name:
        guessed_ext = Path(secure_filename(original_name)).suffix
    guessed_ext = guessed_ext or ""
    return f"{token}{guessed_ext}"


def _store_attachment(data: bytes, mime_type: str, original_name: Optional[str] = None) -> ChatAttachment:
    upload_dir: Path = current_app.config["CHAT_UPLOAD_PATH"]
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_name = _generate_filename(original_name, mime_type)
    file_path = upload_dir / file_name
    file_path.write_bytes(data)
    return ChatAttachment(
        file_path=file_name,
        mime_type=mime_type,
        file_size=len(data),
        original_name=original_name,
    )


def _load_file_storage(file_obj: FileStorage) -> ChatAttachment:
    stream = file_obj.stream
    stream.seek(0, 2)
    size = stream.tell()
    stream.seek(0)
    if size > MAX_UPLOAD_BYTES:
        raise ValueError("attachment exceeds maximum size")
    data = stream.read()
    if not data:
        raise ValueError("empty attachment")
    mime_type = file_obj.mimetype or mimetypes.guess_type(file_obj.filename or "")[0]
    if not mime_type or not mime_type.startswith("image/"):
        raise ValueError("only image attachments are supported")
    return _store_attachment(data, mime_type, original_name=file_obj.filename)


def _fetch_remote_image(url: str) -> Optional[ChatAttachment]:
    try:
        response = requests.get(url, stream=True, timeout=REMOTE_FETCH_TIMEOUT)
    except requests.RequestException:
        return None
    try:
        content_type = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if not content_type.startswith("image/"):
            return None
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > REMOTE_MAX_BYTES:
            return None
        data_chunks = []
        total = 0
        for chunk in response.iter_content(32 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > REMOTE_MAX_BYTES:
                return None
            data_chunks.append(chunk)
        if not data_chunks:
            return None
        data = b"".join(data_chunks)
        original_name = urlparse(url).path.split("/")[-1] or None
        return _store_attachment(data, content_type, original_name=original_name)
    finally:
        response.close()


def _collect_attachments_from_urls(body: str, remaining_slots: int) -> List[ChatAttachment]:
    attachments: List[ChatAttachment] = []
    if remaining_slots <= 0:
        return attachments
    seen_urls: set[str] = set()
    for match in URL_PATTERN.finditer(body):
        url = match.group(0)
        if url in seen_urls:
            continue
        seen_urls.add(url)
        attachment = _fetch_remote_image(url)
        if attachment:
            attachments.append(attachment)
        if len(attachments) >= remaining_slots:
            break
    return attachments


def _parse_new_message_request() -> Tuple[Optional[Tuple[Any, int]], str, List[ChatAttachment]]:
    attachments: List[ChatAttachment] = []
    body = ""

    if request.content_type and request.content_type.startswith("multipart/form-data"):
        body = _clean_body(request.form.get("body", ""))
        files = request.files.getlist("attachments")
        if len(files) > MAX_ATTACHMENTS:
            return (jsonify({"error": "too many attachments"}), "", [])
        for file_obj in files:
            if not file_obj:
                continue
            try:
                attachment = _load_file_storage(file_obj)
            except ValueError as exc:
                return (jsonify({"error": str(exc)}), "", [])
            attachments.append(attachment)
    else:
        payload = request.get_json(silent=True) or {}
        body = _clean_body(str(payload.get("body", "")))

    error = _validate_body(body, allow_blank=bool(attachments))
    if error:
        return (error, "", attachments)

    if len(attachments) > MAX_ATTACHMENTS:
        return (jsonify({"error": "too many attachments"}), "", [])

    return (None, body, attachments)


def _cleanup_attachments(attachments: Iterable[ChatAttachment]) -> None:
    upload_dir: Path = current_app.config["CHAT_UPLOAD_PATH"]
    for attachment in attachments:
        file_path = upload_dir / attachment.file_path
        if file_path.exists():
            try:
                file_path.unlink()
            except OSError:
                current_app.logger.warning("Failed to remove attachment %s", file_path)


@CHAT_BLUEPRINT.get("/messages")
def list_messages() -> Any:
    limit = request.args.get("limit", default=50, type=int)
    before_id = request.args.get("before_id", default=None, type=int)
    limit = max(1, min(limit, 100))
    records, has_more = _service().fetch_messages(limit=limit, before_id=before_id)
    serialized = _serialize_messages(records)
    next_before_id: Optional[int]
    if records and has_more:
        next_before_id = int(records[0].id)
    else:
        next_before_id = None
    payload: Dict[str, Any] = {
        "messages": serialized,
        "next_before_id": next_before_id,
        "has_more": has_more,
    }
    return jsonify(payload), HTTPStatus.OK


@CHAT_BLUEPRINT.route("/messages", methods=["POST", "OPTIONS"])
def post_message() -> Any:
    if request.method == "OPTIONS":
        return "", HTTPStatus.NO_CONTENT
    auth_error = _ensure_authenticated()
    if auth_error:
        return auth_error

    error_response, body, attachments = _parse_new_message_request()
    if error_response:
        _cleanup_attachments(attachments)
        return error_response

    remaining_slots = MAX_ATTACHMENTS - len(attachments)
    try:
        url_attachments = _collect_attachments_from_urls(body, remaining_slots)
        attachments.extend(url_attachments)
        if len(attachments) > MAX_ATTACHMENTS:
            overflow = attachments[MAX_ATTACHMENTS:]
            _cleanup_attachments(overflow)
            del attachments[MAX_ATTACHMENTS:]
    except Exception:
        # On failure to download remote images we still proceed without them
        pass

    try:
        message = _service().create_message(user=current_user, body=body, attachments=attachments)
    except Exception:
        _cleanup_attachments(attachments)
        raise

    message_dict = _serialize_message(message)
    socketio.emit("chat:message", message_dict)
    return jsonify({"message": message_dict}), HTTPStatus.CREATED


@CHAT_BLUEPRINT.route("/messages/<int:message_id>", methods=["PATCH"])
def patch_message(message_id: int) -> Any:
    auth_error = _ensure_authenticated()
    if auth_error:
        return auth_error

    message = _service().get_message(message_id)
    if not message:
        return jsonify({"error": "message not found"}), HTTPStatus.NOT_FOUND
    if not _current_user_can_modify(message):
        return jsonify({"error": "forbidden"}), HTTPStatus.FORBIDDEN

    payload = request.get_json(silent=True) or {}
    body = _clean_body(str(payload.get("body", message.body)))
    error = _validate_body(body)
    if error:
        return error

    updated = _service().update_message(message, body=body)
    message_dict = _serialize_message(updated)
    socketio.emit("chat:message:update", message_dict)
    return jsonify({"message": message_dict}), HTTPStatus.OK


@CHAT_BLUEPRINT.route("/messages/<int:message_id>", methods=["DELETE"])
def delete_message(message_id: int) -> Any:
    auth_error = _ensure_authenticated()
    if auth_error:
        return auth_error

    message = _service().get_message(message_id)
    if not message:
        return jsonify({"error": "message not found"}), HTTPStatus.NOT_FOUND
    if not _current_user_can_modify(message):
        return jsonify({"error": "forbidden"}), HTTPStatus.FORBIDDEN

    _cleanup_attachments(message.attachments)
    _service().delete_message(message)
    socketio.emit("chat:message:delete", {"id": message_id})
    return jsonify({"ok": True}), HTTPStatus.OK


@CHAT_BLUEPRINT.get("/attachments/<int:attachment_id>")
def get_attachment(attachment_id: int) -> Any:
    attachment = ChatAttachment.query.get(attachment_id)
    if not attachment:
        return jsonify({"error": "attachment not found"}), HTTPStatus.NOT_FOUND
    upload_dir: Path = current_app.config["CHAT_UPLOAD_PATH"]
    file_path = upload_dir / attachment.file_path
    if not file_path.exists():
        return jsonify({"error": "attachment missing"}), HTTPStatus.NOT_FOUND
    return send_file(str(file_path), mimetype=attachment.mime_type)


__all__ = ["CHAT_BLUEPRINT"]


@socketio.on("connect")
def handle_socket_connect():  # pragma: no cover - socketio callback
    current_app.logger.info("Client connected to socket")


@socketio.on("disconnect")
def handle_socket_disconnect():  # pragma: no cover - socketio callback
    current_app.logger.info("Client disconnected from socket")
