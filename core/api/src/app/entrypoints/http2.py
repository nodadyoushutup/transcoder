"""ASGI bridge for serving the Flask app via Hypercorn with HTTP/2 support."""
from __future__ import annotations

from asgiref.wsgi import WsgiToAsgi

from .wsgi import app as wsgi_app


app = WsgiToAsgi(wsgi_app)


__all__ = ["app"]
