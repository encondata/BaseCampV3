"""Black and white for a thermal printer: an 8-bit gray raster to packed
1-bit rows (spec 2026-10-20-badge-templates §4.5).

A thermal printer prints black or white, so a picture goes through a
brightness/contrast table, then Atkinson error diffusion (a photo) or a
fixed threshold (a logo), then the optional invert, then packing. Integer
arithmetic only, so portal/src/labels/builder/dither.ts gives exactly the
same bits for the same gray raster; labels/fixtures/dither.json pins both
(api/tests/test_label_dither.py, dither.test.ts). Standard library only:
the laptop edge imports this core and never has Pillow.

The pinned algorithm:
- table: v' = clamp(((v - 128) * contrast) // 100 + 128
  + brightness * 255 // 100, 0, 255), `//` flooring as Python's does
- threshold: black when v' < threshold
- dither: Atkinson in raster order (no serpentine) on an unclamped
  accumulator; black when it is below 128; (acc - (0 if black else 255))
  >> 3 (an arithmetic, flooring shift) goes to each of (+1, 0), (+2, 0),
  (-1, +1), (0, +1), (+1, +1) and (0, +2)
- invert flips each dot after that (never the pad bits)
- pack: MSB = leftmost dot, 1 = black, ceil(width / 8) bytes a row, pad
  bits 0 (a printer prints them)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import NamedTuple

MODES = ("dither", "threshold")
# the inclusive ranges of the element's settings (model.py ImageEl)
BRIGHTNESS = (-100, 100)
CONTRAST = (0, 300)
THRESHOLD = (1, 254)


class Bitmap(NamedTuple):
    """A packed 1-bit picture as `bitmap` returns it, ready to print: already
    rotated, `bits` holding `height` rows of `bytes_per_row(width)`."""
    width: int
    height: int
    bits: bytes


def _whole(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


@dataclass(frozen=True)
class Params:
    """An image element's look: brightness -100..100, contrast 0..300 (a
    percent), threshold 1..254 (the threshold mode's cut), the mode
    (`dither` for a photo, `threshold` for a logo) and invert."""
    brightness: int = 0
    contrast: int = 100
    threshold: int = 128
    mode: str = "dither"
    invert: bool = False

    def __post_init__(self) -> None:
        for name, (lo, hi) in (("brightness", BRIGHTNESS), ("contrast", CONTRAST),
                               ("threshold", THRESHOLD)):
            v = getattr(self, name)
            if not _whole(v) or not lo <= v <= hi:
                raise ValueError(f"{name} must be a whole number from {lo} to {hi}")
        if self.mode not in MODES:
            raise ValueError("mode must be dither or threshold")


def bytes_per_row(width: int) -> int:
    return (width + 7) // 8


def lut(brightness: int, contrast: int) -> bytes:
    """The brightness/contrast table: level v prints as lut[v]."""
    lift = brightness * 255 // 100
    return bytes(max(0, min(255, ((v - 128) * contrast) // 100 + 128 + lift))
                 for v in range(256))


def _atkinson(levels: list[int], width: int, height: int) -> list[bool]:
    acc = levels  # the caller's fresh list, so it may be written
    black = [False] * (width * height)
    for y in range(height):
        row = y * width
        below, below2 = y + 1 < height, y + 2 < height
        for x in range(width):
            i = row + x
            a = acc[i]
            dot = a < 128
            black[i] = dot
            err = (a - (0 if dot else 255)) >> 3
            if not err:
                continue
            if x + 1 < width:
                acc[i + 1] += err
                if x + 2 < width:
                    acc[i + 2] += err
            if below:
                j = i + width
                if x > 0:
                    acc[j - 1] += err
                acc[j] += err
                if x + 1 < width:
                    acc[j + 1] += err
            if below2:
                acc[i + 2 * width] += err
    return black


def bitmap(gray: bytes, width: int, height: int, p: Params) -> bytes:
    """`gray` (row-major 8-bit levels, 0 black, 255 white) as packed 1-bit
    rows (MSB = leftmost dot, 1 = black, pad bits 0)."""
    if not _whole(width) or not _whole(height) or width < 0 or height < 0:
        raise ValueError("width and height must be whole numbers of 0 or more")
    if len(gray) != width * height:
        raise ValueError(f"a {width} x {height} raster has {width * height} levels, "
                         f"not {len(gray)}")
    table = lut(p.brightness, p.contrast)
    levels = [table[v] for v in gray]
    if p.mode == "threshold":
        black = [v < p.threshold for v in levels]
    else:
        black = _atkinson(levels, width, height)
    invert = bool(p.invert)
    stride = bytes_per_row(width)
    out = bytearray(stride * height)
    for y in range(height):
        row, base = y * width, y * stride
        for x in range(width):
            if black[row + x] != invert:
                out[base + (x >> 3)] |= 0x80 >> (x & 7)
    return bytes(out)
