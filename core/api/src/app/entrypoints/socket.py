"""Socket.IO-enabled development server entrypoint."""
from __future__ import annotations

import os

from .. import create_app
from ..providers import socketio


app = create_app()


def main() -> None:
    host = os.getenv("FLASK_RUN_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_RUN_PORT", "5001"))
    run_kwargs = {}
    if socketio.async_mode == "threading":
        run_kwargs["allow_unsafe_werkzeug"] = True
    socketio.run(app, host=host, port=port, **run_kwargs)


if __name__ == "__main__":  # pragma: no cover - manual entrypoint
    main()


__all__ = ["app", "main"]
