"""Route blueprints for the backend service."""

from .auth import register_auth
from .chat import CHAT_BLUEPRINT
from .settings import SETTINGS_BLUEPRINT
from .library import LIBRARY_BLUEPRINT
from .transcode import api_bp
from .users import USERS_BLUEPRINT
from .viewers import VIEWERS_BLUEPRINT

__all__ = [
    "register_auth",
    "api_bp",
    "CHAT_BLUEPRINT",
    "SETTINGS_BLUEPRINT",
    "VIEWERS_BLUEPRINT",
    "USERS_BLUEPRINT",
    "LIBRARY_BLUEPRINT",
]
