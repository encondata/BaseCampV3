"""Writes image_parity.json: what the compiler prints for three image
elements at 203, 300 and 600 DPI, unturned and turned 90 degrees, so
imageParity.test.ts can check the builder canvas draws the very same dots
(spec 2026-10-20-badge-templates §4.5, §4.12).

For each case the Python side of the label core decides everything the
printer gets: model.py parses the element (its source's defaults and its
dither settings, `ImageEl.params`), zpl.py `image_box_dots` sizes the box
the server fits the picture to, the picture is turned by exact
transposition as the server's prep turns it, and dither.py makes the bits.
The gray pictures are integer formulas (`gray`, mirrored in the test), so
the file holds only each result's size, its black-dot count and the
SHA-256 of its packed rows.

Run from the repository root with the standard library only:

    PYTHONPATH=api/src python3 portal/src/labels/builder/fixtures/image_parity.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from serversherpa.labels import dither, model, zpl

OUT = Path(__file__).with_name("image_parity.json")

ELEMENTS = [
    # a photo with its source's defaults: cover, Atkinson dither
    ("portrait", {"id": "photo-1", "type": "image", "source": "photo", "x": 0.1, "y": 0.1,
                  "w": 0.8, "h": 1.0, "rotation": 0}),
    # a logo thresholded harder than the default
    ("bars", {"id": "logo-1", "type": "image", "source": "logo", "x": 0.2, "y": 0.1,
              "w": 1.0, "h": 0.5, "rotation": 0, "contrast": 133, "threshold": 90}),
    # a static picture dithered, darkened, flattened and inverted; odd
    # sizes, so rows end in pad bits, and 0.455 in is 136.5 dots at 300 DPI:
    # Python rounds that half to even (136), never up
    ("ramp", {"id": "static-1", "type": "image", "source": "static", "imageId": "img-1",
              "x": 0.3, "y": 0.2, "w": 0.65, "h": 0.455, "rotation": 0, "mode": "dither",
              "brightness": -13, "contrast": 77, "invert": True}),
]
DPIS = (203, 300, 600)
ROTATIONS = (0, 90)


def lcg(state: int) -> int:
    return (state * 1103515245 + 12345) & 0x7FFFFFFF


def gray(kind: str, w: int, h: int) -> bytes:
    """A w x h picture, row-major 8-bit levels, from integers only."""
    out = bytearray(w * h)
    state = 2026 + w * 7 + h
    for v in range(h):
        for u in range(w):
            state = lcg(state)
            noise = (state >> 16) % 49 - 24
            if kind == "portrait":
                ramp = (u * 255 // max(w - 1, 1) + v * 255 // max(h - 1, 1)) // 2
                du, dv = 2 * u - w, 2 * v - h
                ring = 70 if du * du + dv * dv < (min(w, h) * min(w, h)) // 3 else 0
                level = ramp - ring + noise
            elif kind == "bars":
                level = 20 if (u * 9 // max(w, 1) + v * 5 // max(h, 1)) % 2 == 0 else 230
                level += noise // 3
            else:
                level = (u * 255) // max(w - 1, 1) if v * 3 < h * 2 else 255 - (u * 255) // max(w - 1, 1)
            out[v * w + u] = max(0, min(255, level))
    return bytes(out)


def turned(src: bytes, w: int, h: int) -> tuple[int, int, bytes]:
    """`src` turned 90 degrees clockwise: h wide and w tall."""
    out = bytearray(w * h)
    for y in range(w):
        for x in range(h):
            out[y * h + x] = src[(h - 1 - x) * w + y]
    return h, w, bytes(out)


def case(kind: str, raw: dict, dpi: int, rotation: int) -> dict:
    el_json = {**raw, "rotation": rotation}
    design = model.parse_design({"schema": 3, "size": {"w": 4, "h": 3}, "elements": [el_json]})
    el = design.elements[0]
    w, h = zpl.image_box_dots(el, dpi)
    picture = gray(kind, w, h)
    width, height = w, h
    if rotation == 90:
        width, height, picture = turned(picture, w, h)
    bits = dither.bitmap(picture, width, height, el.params)
    black = sum(bin(b).count("1") for b in bits)
    return {
        "name": f"{kind} {dpi} dpi rotation {rotation}",
        "kind": kind,
        "element": el_json,
        "dpi": dpi,
        "box": [w, h],
        "width": width,
        "height": height,
        "black": black,
        "sha256": hashlib.sha256(bits).hexdigest(),
        "head": bits[:24].hex(),
    }


def main() -> None:
    cases = [case(kind, raw, dpi, rot) for kind, raw in ELEMENTS for dpi in DPIS for rot in ROTATIONS]
    OUT.write_text(json.dumps({
        "about": "Written by image_parity.py next to this file (labels/model.py parses each element, "
                 "labels/zpl.py image_box_dots sizes its box, labels/dither.py makes the bits). "
                 "gray(kind, w, h) and the 90-degree turn are mirrored in imageParity.test.ts. "
                 "head: the first 24 bytes of the packed rows, hex.",
        "cases": cases,
    }, indent=1) + "\n")
    print(f"wrote {len(cases)} cases to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
