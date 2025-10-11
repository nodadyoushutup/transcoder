#!/usr/bin/env python3
"""Thin wrapper around the transcoder publisher watchdog."""
from __future__ import annotations

from src.publisher import main


def cli() -> int:
    return main()


if __name__ == "__main__":
    raise SystemExit(cli())
