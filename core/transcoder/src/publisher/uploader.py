#!/usr/bin/env python3
"""Thin CLI wrapper for the upload watchdog runtime."""
from __future__ import annotations

import sys

from .watchdog import run_watchdog


def main() -> int:
    return run_watchdog()


if __name__ == "__main__":
    sys.exit(main())
