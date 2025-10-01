"""Application-wide extensions."""
from __future__ import annotations

from flask_login import LoginManager
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()
login_manager = LoginManager()
login_manager.login_view = None
socketio = SocketIO(cors_allowed_origins="*", cors_credentials=True)


__all__ = ["db", "login_manager", "socketio"]
