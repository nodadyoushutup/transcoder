"""Deployment entrypoints for running the API service."""

from .http2 import app as http2_app
from .socket import app as socketio_app
from .wsgi import app as wsgi_app

__all__ = ["http2_app", "socketio_app", "wsgi_app"]
