"""HTTP route blueprints for the API service."""
from __future__ import annotations

from .chat import CHAT_BLUEPRINT
from .internal import INTERNAL_BLUEPRINT
from .library import LIBRARY_BLUEPRINT
from .queue import QUEUE_BLUEPRINT
from .settings import SETTINGS_BLUEPRINT
from .transcode import api_bp as TRANSCODER_BLUEPRINT
from .users import USERS_BLUEPRINT
from .viewers import VIEWERS_BLUEPRINT

API_BLUEPRINTS = [
    TRANSCODER_BLUEPRINT,
    CHAT_BLUEPRINT,
    SETTINGS_BLUEPRINT,
    USERS_BLUEPRINT,
    VIEWERS_BLUEPRINT,
    LIBRARY_BLUEPRINT,
    QUEUE_BLUEPRINT,
    INTERNAL_BLUEPRINT,
]

__all__ = ["API_BLUEPRINTS"]
