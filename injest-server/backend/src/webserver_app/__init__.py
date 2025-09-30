"""Webserver application that stores DASH segments via HTTP PUT."""

from .app import create_app

__all__ = ["create_app"]
