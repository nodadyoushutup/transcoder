#!/usr/bin/env python3
"""Quick analysis helper for section-1-all.json library exports."""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Mapping, MutableMapping


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect a Plex library export (e.g. section-1-all.json) and "
            "print a quick breakdown of useful stats."
        )
    )
    parser.add_argument(
        "json_path",
        nargs="?",
        default="section-1-all.json",
        help="Path to the exported JSON file (default: section-1-all.json).",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of entries to show for ranked categories (default: 10).",
    )
    return parser.parse_args()


def load_metadata(json_path: Path) -> List[MutableMapping]:
    if not json_path.exists():
        raise SystemExit(f"File not found: {json_path}")

    try:
        with json_path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Could not decode JSON in {json_path}: {exc}") from exc

    try:
        metadata = data["MediaContainer"]["Metadata"]
    except KeyError as exc:
        raise SystemExit("Expected MediaContainer.Metadata array in JSON payload") from exc

    if not isinstance(metadata, list):
        metadata = [metadata]

    if not metadata:
        raise SystemExit("No library entries found in the JSON file.")

    return metadata


def extract_tag_counts(
    items: Iterable[Mapping],
    field_name: str,
) -> Counter:
    """Count how many unique items include each tag in the nested list."""
    counter: Counter = Counter()
    for item in items:
        seen = set()
        raw_tags = item.get(field_name)
        if not isinstance(raw_tags, list):
            continue
        for tag in raw_tags:
            name = tag.get("tag")
            if not name or name in seen:
                continue
            counter[name] += 1
            seen.add(name)
    return counter


def percent(numerator: int, denominator: int) -> float:
    return (numerator / denominator * 100) if denominator else 0.0


def render_counter(
    title: str,
    counter: Counter,
    total_reference: int,
    top: int,
) -> None:
    print(f"\n=== {title} ===")
    if not counter:
        print("No data available.")
        return

    for name, count in counter.most_common(top):
        label = name or "Unknown"
        pct = percent(count, total_reference)
        print(f"{label}: {count:,} ({pct:.1f}%)")


def main() -> None:
    args = parse_args()
    metadata = load_metadata(Path(args.json_path))
    total_items = len(metadata)

    type_counts = Counter(item.get("type", "unknown") for item in metadata)
    content_ratings = Counter(
        (item.get("contentRating") or "Unrated") for item in metadata
    )

    studios = Counter(
        item.get("studio") for item in metadata if isinstance(item.get("studio"), str)
    )

    years = [
        item.get("year") for item in metadata if isinstance(item.get("year"), int)
    ]
    durations_ms = [
        item.get("duration")
        for item in metadata
        if isinstance(item.get("duration"), int) and item.get("duration") > 0
    ]

    added_at = [
        int(item["addedAt"])
        for item in metadata
        if str(item.get("addedAt", "")).isdigit()
    ]
    updated_at = [
        int(item["updatedAt"])
        for item in metadata
        if str(item.get("updatedAt", "")).isdigit()
    ]

    media_video_res = Counter()
    media_video_codec = Counter()
    media_audio_codec = Counter()

    for item in metadata:
        media_entries = item.get("Media")
        if not isinstance(media_entries, list):
            continue
        if not media_entries:
            continue
        primary = media_entries[0]
        media_video_res[primary.get("videoResolution")] += 1
        media_video_codec[primary.get("videoCodec")] += 1
        media_audio_codec[primary.get("audioCodec")] += 1

    genres = extract_tag_counts(metadata, "Genre")
    countries = extract_tag_counts(metadata, "Country")
    directors = extract_tag_counts(metadata, "Director")
    writers = extract_tag_counts(metadata, "Writer")

    runtimes_min = [duration / 60000 for duration in durations_ms]

    print("=== Basic Stats ===")
    print(f"Items: {total_items:,}")
    print(f"Types represented: {len(type_counts)}")
    if years:
        print(
            "Year span: "
            f"{min(years)} – {max(years)} "
            f"(median {statistics.median(years):.0f})"
        )
    if durations_ms:
        total_hours = sum(runtimes_min) / 60
        mean_minutes = statistics.mean(runtimes_min)
        print(
            "Runtime: "
            f"{total_hours:.1f} hours total | "
            f"{mean_minutes:.1f} minutes average"
        )
    if added_at:
        first_added = datetime.fromtimestamp(min(added_at))
        last_added = datetime.fromtimestamp(max(added_at))
        print(
            "Added dates: "
            f"{first_added.isoformat(sep=' ', timespec='seconds')} – "
            f"{last_added.isoformat(sep=' ', timespec='seconds')}"
        )
    if updated_at:
        last_updated = datetime.fromtimestamp(max(updated_at))
        print(
            "Last update: "
            f"{last_updated.isoformat(sep=' ', timespec='seconds')}"
        )

    render_counter("Item Types", type_counts, total_items, args.top)
    render_counter("Content Ratings", content_ratings, total_items, args.top)
    render_counter("Studios", studios, total_items, args.top)
    render_counter("Video Resolution (primary media)", media_video_res, total_items, args.top)
    render_counter("Video Codec (primary media)", media_video_codec, total_items, args.top)
    render_counter("Audio Codec (primary media)", media_audio_codec, total_items, args.top)

    render_counter("Genres", genres, total_items, args.top)
    render_counter("Countries", countries, total_items, args.top)
    render_counter("Directors", directors, total_items, args.top)
    render_counter("Writers", writers, total_items, args.top)


if __name__ == "__main__":
    main()
