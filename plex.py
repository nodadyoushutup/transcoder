#!/usr/bin/env python3
"""Simple helper to query a Plex Media Server over HTTP."""

import sys
from typing import Any
from urllib.parse import urljoin

import requests


DEFAULT_HEADERS = {
    "Accept": "application/json",
    "X-Plex-Accept": "application/json",
    "X-Plex-Product": "Publex",
    "X-Plex-Client-Identifier": "publex-cli",
    "X-Plex-Device": "Publex CLI",
    "X-Plex-Device-Name": "Publex CLI",
    "X-Plex-Platform": "Publex",
    "X-Plex-Version": "1.0",
}


def fetch_sections(base_url: str, token: str) -> Any:
    """Return the parsed sections payload from a Plex server."""
    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)
    url = urljoin(base_url.rstrip("/") + "/", "library/sections")
    response = session.get(url, params={"X-Plex-Token": token}, timeout=30)
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as exc:  # pragma: no cover - convenience script only
        raise RuntimeError("Plex returned a non-JSON response.") from exc
    finally:
        response.close()
    return (payload or {}).get("MediaContainer", {}).get("Directory", [])


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: python plex.py <PLEX_URL> <PLEX_TOKEN>")
        sys.exit(1)

    base_url, token = sys.argv[1], sys.argv[2]
    try:
        sections = fetch_sections(base_url, token)
    except Exception as exc:  # pragma: no cover - convenience script
        print(f"Failed to query Plex: {exc}")
        sys.exit(2)

    if not sections:
        print("No sections returned from Plex server.")
        return

    print(f"Fetched {len(sections)} sections from {base_url}")
    for section in sections:
        title = section.get("@title") or section.get("title")
        key = section.get("@key") or section.get("key")
        print(f"- {title} ({key})")


if __name__ == "__main__":
    main()
