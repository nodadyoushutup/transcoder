"""ASGI bridge for serving the Flask app via Hypercorn with HTTP/2 support."""

from asgiref.wsgi import WsgiToAsgi

from importlib import import_module


def _load_wsgi_app():
    """Resolve the Flask WSGI app regardless of module path."""

    module_candidates = ("src.wsgi", "wsgi")
    for module_name in module_candidates:
        try:
            module = import_module(module_name)
        except ModuleNotFoundError:
            continue
        app_obj = getattr(module, "app", None)
        if app_obj is not None:
            return app_obj
    raise RuntimeError("Unable to locate the WSGI app for HTTP/2 bridge.")


wsgi_app = _load_wsgi_app()

# Expose an ASGI-compatible wrapper around the existing Flask WSGI app.
app = WsgiToAsgi(wsgi_app)

__all__ = ["app"]
