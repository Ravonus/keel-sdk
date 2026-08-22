#!/usr/bin/env python3
"""Normalize ImageGen tile sheets into native 64px RGBA runtime atlases."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import deque
from pathlib import Path

from PIL import Image


def remove_border_background(cell: Image.Image) -> Image.Image:
    rgba = cell.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size
    pending: deque[tuple[int, int]] = deque()
    seen: set[tuple[int, int]] = set()

    def is_background(x: int, y: int) -> bool:
        red, green, blue, _ = pixels[x, y]
        return min(red, green, blue) >= 218 and max(red, green, blue) - min(red, green, blue) <= 16

    for x in range(width):
        pending.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        pending.extend(((0, y), (width - 1, y)))
    while pending:
        x, y = pending.popleft()
        if (x < 0 or y < 0 or x >= width or y >= height or (x, y) in seen or not is_background(x, y)):
            continue
        seen.add((x, y))
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)
        pending.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return rgba


def normalize_sheet(source: Path, target: Path, columns: int, rows: int, full_rows: set[int]) -> dict:
    image = Image.open(source).convert("RGB")
    if image.width % columns or image.height % rows:
        raise ValueError(f"{source} is not divisible by {columns}x{rows}")
    source_width = image.width // columns
    source_height = image.height // rows
    atlas = Image.new("RGBA", (columns * 64, rows * 64), (0, 0, 0, 0))
    cells = []
    for row in range(rows):
        for column in range(columns):
            crop = image.crop((column * source_width, row * source_height, (column + 1) * source_width, (row + 1) * source_height))
            cutout = remove_border_background(crop)
            alpha = cutout.getchannel("A")
            bounds = alpha.getbbox()
            if not bounds:
                raise ValueError(f"empty cell {row},{column} in {source}")
            if row in full_rows:
                normalized = cutout.crop(bounds).resize((64, 64), Image.Resampling.LANCZOS)
            else:
                subject = cutout.crop(bounds)
                scale = min(60 / subject.width, 60 / subject.height)
                size = (max(1, round(subject.width * scale)), max(1, round(subject.height * scale)))
                subject = subject.resize(size, Image.Resampling.LANCZOS)
                normalized = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
                normalized.alpha_composite(subject, ((64 - size[0]) // 2, (64 - size[1]) // 2))
            atlas.alpha_composite(normalized, (column * 64, row * 64))
            normalized_alpha = normalized.getchannel("A")
            cells.append({
                "column": column,
                "row": row,
                "sourceBounds": list(bounds),
                "opaqueCoverage": round(sum(1 for value in normalized_alpha.getdata() if value > 8) / 4096, 4),
                "edgeOccupancy": {
                    "north": sum(1 for value in list(normalized_alpha.crop((0, 0, 64, 1)).getdata()) if value > 8),
                    "east": sum(1 for value in list(normalized_alpha.crop((63, 0, 64, 64)).getdata()) if value > 8),
                    "south": sum(1 for value in list(normalized_alpha.crop((0, 63, 64, 64)).getdata()) if value > 8),
                    "west": sum(1 for value in list(normalized_alpha.crop((0, 0, 1, 64)).getdata()) if value > 8),
                },
            })
    target.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(target, optimize=True)
    return {
        "source": str(source),
        "target": str(target),
        "sourceSize": list(image.size),
        "runtimeSize": list(atlas.size),
        "grid": [columns, rows],
        "cell": [64, 64],
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "cells": cells,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tile-source", type=Path, required=True)
    parser.add_argument("--animation-source", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    tile_report = normalize_sheet(args.tile_source, args.out_dir / "runtime-tilekit-64.png", 6, 6, {0, 1, 4})
    animation_report = normalize_sheet(args.animation_source, args.out_dir / "runtime-animations-64.png", 8, 6, {0, 1, 2, 3, 4})
    report = {
        "schema": "vault-tilekit-build-report@1",
        "state": "candidate-visual-review",
        "tilekit": tile_report,
        "animations": animation_report,
    }
    (args.out_dir / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
