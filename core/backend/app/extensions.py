"""Application-wide extensions."""
from __future__ import annotations

from flask_login import LoginManager
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()
login_manager = LoginManager()
login_manager.login_view = None


__all__ = ["db", "login_manager"]
