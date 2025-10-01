"""Chat message routes and socket broadcasting."""
from __future__ import annotations

import json
import mimetypes
import re
import secrets
from http import HTTPStatus
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import requests
from flask import Blueprint, current_app, jsonify, request, send_file, session, url_for
from flask_login import current_user
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from ..extensions import socketio
from ..models import ChatAttachment, ChatMessage, User
from ..services import ChatService, UserService
from ..services.viewer_service import ViewerService


CHAT_BLUEPRINT = Blueprint("chat", __name__, url_prefix="/chat")

MAX_MESSAGE_LENGTH = 4_096
MAX_ATTACHMENTS = 6
MAX_UPLOAD_BYTES = 6 * 1024 * 1024  # 6 MiB per upload
REMOTE_FETCH_TIMEOUT = 8
REMOTE_MAX_BYTES = 5 * 1024 * 1024
URL_PATTERN = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)
MENTION_PATTERN = re.compile(r"@([a-z0-9_\-]{2,})", re.IGNORECASE)


def _service() -> ChatService:
    svc: ChatService = current_app.extensions["chat_service"]
    return svc


def _user_service() -> UserService:
    svc: UserService = current_app.extensions["user_service"]
    return svc


def _viewer_service() -> ViewerService:
    svc: ViewerService = current_app.extensions["viewer_service"]
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
    reaction_map: Dict[str, Dict[str, Any]] = {}
    for reaction in data.pop("reactions", []):
        emoji = reaction.get("emoji")
        if not emoji:
            continue
        entry = reaction_map.setdefault(
            emoji,
            {
                "emoji": emoji,
                "count": 0,
                "user_ids": [],
                "users": [],
            },
        )
        entry["count"] += 1
        user_id = reaction.get("user_id")
        username = reaction.get("username")
        if user_id is not None:
            entry["user_ids"].append(int(user_id))
        if username:
            entry["users"].append(username)
    for entry in reaction_map.values():
        entry["user_ids"] = sorted(set(entry["user_ids"]))
        entry["users"] = sorted(set(entry["users"]))
    data["reactions"] = sorted(reaction_map.values(), key=lambda item: (-item["count"], item["emoji"]))
    avatar_path = getattr(message.user, "avatar_path", None)
    if avatar_path:
        data["user_avatar_url"] = url_for("users.get_avatar", user_id=message.user_id, _external=False)
    else:
        data["user_avatar_url"] = None
    return data


def _serialize_messages(messages: Iterable[ChatMessage]) -> List[Dict[str, Any]]:
    return [_serialize_message(message) for message in messages]


def _current_user_can_modify(message: ChatMessage, permission: str) -> bool:
    if not current_user.is_authenticated:
        return False
    if getattr(current_user, "is_admin", False):
        return True
    if int(message.user_id) == int(current_user.id):
        return True
    checker = getattr(current_user, "has_permission", None)
    if callable(checker):
        return bool(checker(permission))
    return False


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


def _parse_new_message_request() -> Tuple[Optional[Tuple[Any, int]], str, List[ChatAttachment], Any]:
    attachments: List[ChatAttachment] = []
    body = ""
    mentions_payload: Any = None

    if request.content_type and request.content_type.startswith("multipart/form-data"):
        body = _clean_body(request.form.get("body", ""))
        mentions_raw = request.form.get("mentions")
        if mentions_raw:
            try:
                mentions_payload = json.loads(mentions_raw)
            except json.JSONDecodeError:
                mentions_payload = None
        files = request.files.getlist("attachments")
        if len(files) > MAX_ATTACHMENTS:
            return (jsonify({"error": "too many attachments"}), "", [], mentions_payload)
        for file_obj in files:
            if not file_obj:
                continue
            try:
                attachment = _load_file_storage(file_obj)
            except ValueError as exc:
                return (jsonify({"error": str(exc)}), "", [], mentions_payload)
            attachments.append(attachment)
    else:
        payload = request.get_json(silent=True) or {}
        body = _clean_body(str(payload.get("body", "")))
        mentions_payload = payload.get("mentions")

    error = _validate_body(body, allow_blank=bool(attachments))
    if error:
        return (error, "", attachments, mentions_payload)

    if len(attachments) > MAX_ATTACHMENTS:
        return (jsonify({"error": "too many attachments"}), "", [], mentions_payload)

    return (None, body, attachments, mentions_payload)


def _cleanup_attachments(attachments: Iterable[ChatAttachment]) -> None:
    upload_dir: Path = current_app.config["CHAT_UPLOAD_PATH"]
    for attachment in attachments:
        file_path = upload_dir / attachment.file_path
        if file_path.exists():
            try:
                file_path.unlink()
            except OSError:
                current_app.logger.warning("Failed to remove attachment %s", file_path)


def _resolve_chat_identity() -> Tuple[Any, str, str, bool]:
    if current_user.is_authenticated:
        user = current_user  # type: ignore[assignment]
        sender_key = f"user:{user.id}"
        token = session.get("viewer_token") or None
        if token:
            _viewer_service().heartbeat(token, user=user, username=user.username)
        return user, user.username, sender_key, False

    guest_name = session.get("guest_name")
    if not guest_name:
        guest_name = ViewerService.generate_guest_name()
        session["guest_name"] = guest_name

    viewer_token = session.get("viewer_token") or None
    record = None
    if viewer_token:
        record = _viewer_service().heartbeat(viewer_token, user=None, username=guest_name)
    if not record:
        record = _viewer_service().register(user=None, username=guest_name, token=viewer_token)
        session["viewer_token"] = record.token
    session.modified = True

    placeholder_user = _user_service().get_guest_placeholder()
    sender_key = f"guest:{record.token}"
    return placeholder_user, guest_name, sender_key, True


def _resolve_mentions(body: str, mentions_payload: Any) -> List[User]:
    service = _user_service()
    resolved: dict[int, User] = {}

    if isinstance(mentions_payload, list):
        for entry in mentions_payload:
            candidate: Optional[int] = None
            if isinstance(entry, dict):
                candidate = entry.get("id")
            else:
                candidate = entry
            try:
                user_id = int(candidate)
            except (TypeError, ValueError):
                continue
            user = service.get_by_id(user_id)
            if user and user.username != "__guest__":
                resolved[user.id] = user

    normalized_names: set[str] = set()
    for match in MENTION_PATTERN.finditer(body or ""):
        normalized_names.add(match.group(1).lower())
    if normalized_names:
        for user in service.get_by_usernames(normalized_names):
            if user.username == "__guest__":
                continue
            resolved[user.id] = user

    return list(resolved.values())


@CHAT_BLUEPRINT.get("/mentions")
def mentionable_users() -> Any:
    auth_error = _ensure_authenticated()
    if auth_error:
        return auth_error

    users = _user_service().list_users()
    payload: List[Dict[str, Any]] = []
    for person in users:
        avatar_path = getattr(person, "avatar_path", None)
        avatar_url = (
            url_for("users.get_avatar", user_id=person.id, _external=False)
            if avatar_path
            else None
        )
        payload.append(
            {
                "id": int(person.id),
                "username": person.username,
                "avatar_url": avatar_url,
                "is_admin": bool(person.is_admin),
            }
        )
    return jsonify({"users": payload}), HTTPStatus.OK


def _validate_emoji(payload: Dict[str, Any]) -> Tuple[Optional[Any], Optional[str]]:
    emoji = str(payload.get("emoji", "")).strip()
    if not emoji:
        return jsonify({"error": "emoji required"}), None
    if len(emoji) > 16:
        return jsonify({"error": "emoji invalid"}), None
    return None, emoji


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
    user, username, sender_key, _ = _resolve_chat_identity()
    error_response, body, attachments, mentions_payload = _parse_new_message_request()
    if error_response:
        _cleanup_attachments(attachments)
        return error_response

    mention_users: List[User] = _resolve_mentions(body, mentions_payload)

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
        message = _service().create_message(
            user=user,
            username=username,
            sender_key=sender_key,
            body=body,
            attachments=attachments,
            mentions=mention_users,
        )
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
    if not _current_user_can_modify(message, "chat.message.edit.any"):
        return jsonify({"error": "forbidden"}), HTTPStatus.FORBIDDEN

    payload = request.get_json(silent=True) or {}
    body = _clean_body(str(payload.get("body", message.body)))
    error = _validate_body(body)
    if error:
        return error

    mention_users = _resolve_mentions(body, payload.get("mentions"))
    updated = _service().update_message(message, body=body, mentions=mention_users)
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
    if not _current_user_can_modify(message, "chat.message.delete.any"):
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


@CHAT_BLUEPRINT.route("/messages/<int:message_id>/reactions", methods=["POST", "DELETE"])
def manage_reaction(message_id: int) -> Any:
    auth_error = _ensure_authenticated()
    if auth_error:
        return auth_error

    message = _service().get_message(message_id)
    if not message:
        return jsonify({"error": "message not found"}), HTTPStatus.NOT_FOUND

    payload = request.get_json(silent=True) or {}
    emoji_error, emoji = _validate_emoji(payload)
    if emoji_error:
        return emoji_error, HTTPStatus.BAD_REQUEST

    if request.method == "POST":
        _service().add_reaction(message, current_user, emoji)
        status_code = HTTPStatus.CREATED
    else:
        removed = _service().remove_reaction(message, current_user, emoji)
        if not removed:
            return jsonify({"error": "reaction not found"}), HTTPStatus.NOT_FOUND
        status_code = HTTPStatus.OK

    updated = _service().get_message(message_id)
    if not updated:
        return jsonify({"error": "message not found"}), HTTPStatus.NOT_FOUND
    message_dict = _serialize_message(updated)
    socketio.emit("chat:message:update", message_dict)
    return jsonify({"message": message_dict}), status_code


__all__ = ["CHAT_BLUEPRINT"]


@socketio.on("connect")
def handle_socket_connect():  # pragma: no cover - socketio callback
    current_app.logger.info("Client connected to socket")


@socketio.on("disconnect")
def handle_socket_disconnect():  # pragma: no cover - socketio callback
    current_app.logger.info("Client disconnected from socket")
