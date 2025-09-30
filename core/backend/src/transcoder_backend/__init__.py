"""Backend application that wraps the transcoder in Flask."""

from .app import create_app

__all__ = ["create_app"]
