#!/usr/bin/env python3
"""
plex.py - Connect to a Plex Media Server using PlexAPI

Usage:
    python plex.py <PLEX_URL> <PLEX_TOKEN>
"""

import sys
from plexapi.server import PlexServer


def connect_to_plex(base_url: str, token: str):
    """Connect to Plex server and print some basic details."""
    try:
        plex = PlexServer(base_url, token)
        print(f"Connected to Plex: {plex.friendlyName}")
        print(f"Version: {plex.version}")
        return plex
    except Exception as e:
        print(f"Failed to connect to Plex: {e}")
        sys.exit(1)


if __name__ == "__main__":
    plex_url = "http://192.168.1.100:32400"
    plex_token = "95UyExwoDnZgFyA8csXr"

    plex = connect_to_plex(plex_url, plex_token)
    # print(plex)
    plex.library.sections()[0].all()
