#!/usr/bin/env python3
"""Génère l'icône de l'application (aucune dépendance externe).

Produit :
  assets/icon.ico   icône multi-tailles pour Windows (16 à 256 px)
  assets/icon.png   image 512 px (utilisée par Linux/macOS et la documentation)

Dessin : carré arrondi dégradé (bleu -> violet) avec une flèche de
téléchargement blanche. Le rendu est lissé par sur-échantillonnage 4x.

Usage : python scripts/make_icons.py
"""

import os
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SIZES_ICO = (16, 24, 32, 48, 64, 128, 256)
SIZE_PNG = 512

TOP_COLOR = (47, 107, 255)      # bleu
BOTTOM_COLOR = (123, 47, 247)   # violet
WHITE = (255, 255, 255)


def _rounded_box_coverage(x, y, size, radius_ratio=0.22):
    """Indique si le point (x, y) est dans le carré arrondi (coordonnées 0..size)."""
    r = size * radius_ratio
    left, right = r, size - r
    cx = min(max(x, left), right)
    cy = min(max(y, left), right)
    dx, dy = x - cx, y - cy
    return (dx * dx + dy * dy) <= r * r


def _in_polygon(x, y, points):
    inside = False
    n = len(points)
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def _arrow_shapes(size):
    """Flèche « téléchargement » : hampe + pointe, et socle, en unités 0..100."""
    s = size / 100.0

    def sc(pts):
        return [(px * s, py * s) for px, py in pts]

    stem = sc([(41.5, 16.0), (58.5, 16.0), (58.5, 55.0), (41.5, 55.0)])
    head = sc([(27.0, 47.0), (73.0, 47.0), (50.0, 78.5)])
    base = sc([(25.0, 84.0), (75.0, 84.0), (75.0, 91.5), (25.0, 91.5)])
    return stem, head, base


def _render(size):
    """Retourne une liste de lignes de pixels RGBA (haut vers bas)."""
    stem, head, base = _arrow_shapes(size)
    ss = 4  # sur-échantillonnage
    step = 1.0 / ss
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            inside_count = 0
            white_count = 0
            gsum = [0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    if not _rounded_box_coverage(x, y, size):
                        continue
                    inside_count += 1
                    is_white = (
                        _in_polygon(x, y, stem)
                        or _in_polygon(x, y, head)
                        or _in_polygon(x, y, base)
                    )
                    if is_white:
                        white_count += 1
                    else:
                        t = y / size
                        gsum[0] += TOP_COLOR[0] + (BOTTOM_COLOR[0] - TOP_COLOR[0]) * t
                        gsum[1] += TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * t
                        gsum[2] += TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * t
            total = ss * ss
            if inside_count == 0:
                row += bytes((0, 0, 0, 0))
                continue
            alpha = int(round(255 * inside_count / total))
            colored = inside_count - white_count
            if colored > 0:
                r = gsum[0] / colored
                g = gsum[1] / colored
                b = gsum[2] / colored
                rw = white_count / inside_count
                r = r * (1 - rw) + WHITE[0] * rw
                g = g * (1 - rw) + WHITE[1] * rw
                b = b * (1 - rw) + WHITE[2] * rw
            else:
                r, g, b = WHITE
            row += bytes((int(round(r)), int(round(g)), int(round(b)), alpha))
        rows.append(bytes(row))
    return rows


def _png_bytes(rows, size):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def _dib_bytes(rows, size):
    """Image BMP (DIB 32 bits) telle qu'attendue dans un fichier .ico."""
    header = struct.pack(
        "<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0
    )
    pixels = bytearray()
    for row in reversed(rows):
        for x in range(0, len(row), 4):
            r, g, b, a = row[x], row[x + 1], row[x + 2], row[x + 3]
            pixels += bytes((b, g, r, a))
    # Masque AND (1 bit par pixel, lignes alignées sur 4 octets) : tout à zéro,
    # la transparence est portée par le canal alpha.
    mask_row = ((size + 31) // 32) * 4
    mask = bytes(mask_row * size)
    return header + bytes(pixels) + mask


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)

    entries = []
    for size in SIZES_ICO:
        entries.append((size, _dib_bytes(_render(size), size)))

    offset = 6 + 16 * len(entries)
    directory = bytearray()
    blobs = bytearray()
    for size, blob in entries:
        directory += struct.pack(
            "<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(blob), offset
        )
        blobs += blob
        offset += len(blob)

    ico = struct.pack("<HHH", 0, 1, len(entries)) + bytes(directory) + bytes(blobs)
    (ASSETS / "icon.ico").write_bytes(ico)
    (ASSETS / "icon.png").write_bytes(_png_bytes(_render(SIZE_PNG), SIZE_PNG))

    print("Icône créée :", ASSETS / "icon.ico", "(%d octets)" % len(ico))
    print("Image créée :", ASSETS / "icon.png")


if __name__ == "__main__":
    main()
