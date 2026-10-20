"""A stored picture as the gray raster a badge image prints from (spec
2026-10-20-badge-templates §4.5, §4.11, §4.12).

The one place Pillow is used for labels. The API imports this module
lazily (only a request that preps or probes a picture loads it) and the
laptop edge never does: the shared core (zpl, model, compile, render,
fields, dither) stays standard-library-only.

`gray_raster` takes any stored picture (a portal avatar, a raw V2 avatar
with EXIF orientation, a transparent PNG logo, a library image) to exactly
the element's dot box:
- decode (PNG, JPEG, WebP or GIF only; the first frame of an animation),
  refusing anything past MAX_PIXELS from its header, before decoding;
- apply the EXIF orientation;
- composite any transparency onto white (a clear pixel stored as black
  would otherwise print black);
- 8-bit gray by ITU-R 601 luma (Pillow's L: 299/587/114);
- fit to the unrotated box: `cover` scales to fill and crops the center,
  `contain` scales to fit and letterboxes in white; box-filter resampling;
- turn by exact transposition, clockwise as every element turns (ZPL `R`
  is 90), so at 90 and 270 the raster is h wide and w tall.

The builder's canvas and the compile both dither this same raster with the
shared integer dither, so what the canvas shows is what prints."""

from __future__ import annotations

import io
import warnings
from typing import NamedTuple

from PIL import Image, ImageOps

# a decompression-bomb guard: a picture past this many pixels is refused
# from its header, at upload and at prep
MAX_PIXELS = 40_000_000

FORMATS = {"PNG": ("image/png", ".png"), "JPEG": ("image/jpeg", ".jpg"),
           "WEBP": ("image/webp", ".webp"), "GIF": ("image/gif", ".gif")}
FITS = ("cover", "contain")
# clockwise turns as Pillow's (counter-clockwise) transposes
_TURN = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180,
         270: Image.Transpose.ROTATE_90}
# EXIF orientations that swap width and height
_SWAPPED = {5, 6, 7, 8}
_EXIF_ORIENTATION = 0x0112


class ImageTooLarge(ValueError):
    """The picture has more than MAX_PIXELS pixels."""


class UnreadableImage(ValueError):
    """Not a PNG, JPEG, WebP or GIF that decodes."""


class Raster(NamedTuple):
    """8-bit gray levels, row-major (0 black, 255 white), already turned."""
    width: int
    height: int
    gray: bytes


class ImageInfo(NamedTuple):
    """A picture's upright size (EXIF orientation applied), type and file
    extension."""
    width: int
    height: int
    mime: str
    ext: str


def _open(data: bytes) -> Image.Image:
    """The picture opened (its header read, nothing decoded yet), refused
    when it is past MAX_PIXELS or isn't one of FORMATS."""
    try:
        with warnings.catch_warnings():
            # Pillow's own bomb warning: MAX_PIXELS below decides
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            im = Image.open(io.BytesIO(data), formats=list(FORMATS))
    except Image.DecompressionBombError as exc:
        raise ImageTooLarge(str(exc)) from exc
    except Exception as exc:   # whatever the decoder raises, the picture is unreadable
        raise UnreadableImage(str(exc) or type(exc).__name__) from exc
    width, height = im.size
    if width * height > MAX_PIXELS:
        raise ImageTooLarge(f"a {width} x {height} picture is past {MAX_PIXELS:,} pixels")
    return im


def _decoded(data: bytes) -> Image.Image:
    im = _open(data)
    try:
        im.load()
        return ImageOps.exif_transpose(im)
    except Exception as exc:
        raise UnreadableImage(str(exc) or type(exc).__name__) from exc


def probe(data: bytes) -> ImageInfo:
    """An upload's upright size and type, after checking it decodes. Raises
    ImageTooLarge or UnreadableImage."""
    im = _open(data)
    mime, ext = FORMATS[im.format]
    try:
        im.load()
        orientation = im.getexif().get(_EXIF_ORIENTATION)
    except Exception as exc:
        raise UnreadableImage(str(exc) or type(exc).__name__) from exc
    width, height = im.size
    if orientation in _SWAPPED:
        width, height = height, width
    return ImageInfo(width, height, mime, ext)


def _gray(im: Image.Image) -> Image.Image:
    """8-bit gray, transparency over white."""
    if im.mode.startswith("I;16"):
        im = im.convert("I")
    if im.mode == "I":                         # 16-bit gray: scale, don't clip
        return im.point(lambda v: v * (1 / 257)).convert("L")
    if im.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in im.info:
        rgba = im.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        white.alpha_composite(rgba)
        im = white
    return im.convert("L")


def _fit(im: Image.Image, width: int, height: int, fit: str) -> Image.Image:
    iw, ih = im.size
    if fit == "cover":
        scale = max(width / iw, height / ih)
        cw, ch = width / scale, height / scale       # the source area kept
        left, top = (iw - cw) / 2, (ih - ch) / 2
        return im.resize((width, height), Image.Resampling.BOX,
                         box=(left, top, left + cw, top + ch))
    scale = min(width / iw, height / ih)
    nw = max(1, min(width, round(iw * scale)))
    nh = max(1, min(height, round(ih * scale)))
    out = Image.new("L", (width, height), 255)
    out.paste(im.resize((nw, nh), Image.Resampling.BOX), ((width - nw) // 2, (height - nh) // 2))
    return out


def gray_raster(data: bytes, w_dots: int, h_dots: int, fit: str, rotation: int) -> Raster:
    """`data` fitted to the unrotated w_dots x h_dots box, then turned
    `rotation` degrees clockwise (module docstring). Raises ImageTooLarge,
    UnreadableImage, or ValueError for a bad box, fit or rotation."""
    if not (isinstance(w_dots, int) and isinstance(h_dots, int) and w_dots > 0 and h_dots > 0):
        raise ValueError(f"the box must be whole dots above 0, not {w_dots} x {h_dots}")
    if fit not in FITS:
        raise ValueError(f"fit must be cover or contain, not {fit!r}")
    if rotation not in (0, *_TURN):
        raise ValueError(f"rotation must be 0, 90, 180 or 270, not {rotation!r}")
    im = _fit(_gray(_decoded(data)), w_dots, h_dots, fit)
    if rotation:
        im = im.transpose(_TURN[rotation])
    return Raster(im.width, im.height, im.tobytes())
