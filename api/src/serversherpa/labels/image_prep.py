"""A stored picture as the gray raster a badge image prints from (spec
2026-10-20-badge-templates §4.5, §4.11, §4.12).

The one place Pillow is used for labels. The API imports this module
lazily (only a request that preps or probes a picture loads it) and the
laptop edge never does: the shared core (zpl, model, compile, render,
fields, dither) stays standard-library-only.

`gray_raster` takes any stored picture (a portal avatar, a raw V2 avatar
with EXIF orientation, a transparent PNG logo, a library image) to exactly
the element's dot box:
- decode (PNG, JPEG, WebP or GIF; an MPO, the multi-picture JPEG phones and
  cameras save, is a JPEG; the first frame of anything with several),
  refusing anything past MAX_PIXELS from its header, before decoding;
- a picture past twice the box is decoded or reduced smaller first (a JPEG
  at 1/2, 1/4 or 1/8; anything else by a whole-factor box reduction, alpha
  premultiplied), never below twice the box: a 40 MP upload never makes
  full-size copies for the steps below. A picture under four times the box
  is never reduced, so its raster is exactly what the steps below make;
- composite any transparency onto white (a clear pixel stored as black
  would otherwise print black), 16-bit gray's included;
- 8-bit gray by ITU-R 601 luma (Pillow's L: 299/587/114);
- apply the EXIF orientation (an exact transposition);
- fit to the unrotated box: `cover` scales to fill and crops the center,
  `contain` scales to fit and letterboxes in white; box-filter resampling;
- turn by exact transposition, clockwise as every element turns (ZPL `R`
  is 90), so at 90 and 270 the raster is h wide and w tall.

The builder's canvas and the compile both dither this same raster with the
shared integer dither, so what the canvas shows is what prints.

Pillow's own decompression-bomb warning (past ~89 MP) is left to the
warnings filter: MAX_PIXELS refuses those pictures anyway, and a filter
that turns the warning into an error gets ImageTooLarge too. (A
`warnings.catch_warnings` here would not be thread-safe: prep runs in
worker threads.)"""

from __future__ import annotations

import io
from typing import NamedTuple

from PIL import Image, ImageMath

# a decompression-bomb guard: a picture past this many pixels is refused
# from its header, at upload and at prep
MAX_PIXELS = 40_000_000

# the decoders tried, and what each decoded format is stored and served as
OPEN_FORMATS = ("PNG", "JPEG", "WEBP", "GIF")
TYPES = {"PNG": ("image/png", ".png"), "JPEG": ("image/jpeg", ".jpg"),
         "MPO": ("image/jpeg", ".jpg"), "WEBP": ("image/webp", ".webp"),
         "GIF": ("image/gif", ".gif")}
_JPEG_FORMATS = ("JPEG", "MPO")
FITS = ("cover", "contain")
# clockwise turns as Pillow's (counter-clockwise) transposes
_TURN = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180,
         270: Image.Transpose.ROTATE_90}
# EXIF orientation -> the transposition that makes the picture upright
# (as ImageOps.exif_transpose); 5-8 swap width and height
_EXIF_ORIENTATION = 0x0112
_UPRIGHT = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
            4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
            6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE,
            8: Image.Transpose.ROTATE_90}
_SWAPPED = {5, 6, 7, 8}
_ALPHA_MODES = ("RGBA", "LA", "PA", "RGBa", "La")


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


def _unreadable(exc: BaseException) -> UnreadableImage:
    return UnreadableImage(str(exc) or type(exc).__name__)


def _open(data: bytes) -> tuple[Image.Image, tuple[str, str]]:
    """The picture opened (its header read, nothing decoded yet) and its
    type, refused when it is past MAX_PIXELS or isn't one of TYPES."""
    try:
        im = Image.open(io.BytesIO(data), formats=list(OPEN_FORMATS))
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageTooLarge(str(exc)) from exc
    except Exception as exc:   # whatever the decoder raises, the picture is unreadable
        raise _unreadable(exc) from exc
    width, height = im.size
    if width * height > MAX_PIXELS:
        raise ImageTooLarge(f"a {width} x {height} picture is past {MAX_PIXELS:,} pixels")
    kind = TYPES.get(im.format)
    if kind is None:
        raise UnreadableImage(f"a {im.format} picture")
    return im, kind


def _orientation(im: Image.Image) -> int | None:
    """The EXIF orientation, or None (also for EXIF too broken to read)."""
    try:
        return im.getexif().get(_EXIF_ORIENTATION)
    except Exception:  # noqa: BLE001 - a broken EXIF block only loses the turn
        return None


def _load(im: Image.Image) -> None:
    try:
        im.load()
    except Exception as exc:   # any decoder failure is "unreadable"
        raise _unreadable(exc) from exc


def probe(data: bytes) -> ImageInfo:
    """An upload's upright size and type, after checking it decodes. Raises
    ImageTooLarge or UnreadableImage."""
    im, (mime, ext) = _open(data)
    _load(im)
    width, height = im.size
    if _orientation(im) in _SWAPPED:
        width, height = height, width
    return ImageInfo(width, height, mime, ext)


def _reduced(im: Image.Image, want: tuple[int, int]) -> Image.Image:
    """`im` box-reduced by the largest whole factor that keeps it at least
    `want` both ways (RGBA and LA premultiplied, as Pillow's reduce does);
    `im` itself under a factor of 2."""
    factor = min(im.width // want[0], im.height // want[1])
    return im.reduce(factor) if factor >= 2 else im


def _gray(im: Image.Image, want: tuple[int, int]) -> Image.Image:
    """8-bit gray, transparency over white, reduced toward `want` first."""
    if im.mode.startswith("I;16"):
        im = im.convert("I")
    if im.mode == "I":                         # 16-bit gray: scale, don't clip
        gray = im.point(lambda v: v * (1 / 257)).convert("L")
        clear = im.info.get("transparency")
        if isinstance(clear, int):             # a tRNS level: those dots are white
            mask = ImageMath.lambda_eval(lambda a: a["equal"](a["im"], clear), im=im)
            gray.paste(255, mask=mask.convert("L").point(lambda v: 255 if v else 0))
        return _reduced(gray, want)
    if im.mode in _ALPHA_MODES or "transparency" in im.info:
        rgba = _reduced(im if im.mode == "RGBA" else im.convert("RGBA"), want)
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        white.alpha_composite(rgba)
        return white.convert("L")
    return _reduced(im.convert("L"), want)


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
    im, _kind = _open(data)
    orientation = _orientation(im)
    # twice the box, as the picture is stored (before its EXIF turn)
    want = (2 * h_dots, 2 * w_dots) if orientation in _SWAPPED else (2 * w_dots, 2 * h_dots)
    if im.format in _JPEG_FORMATS and min(im.width // want[0], im.height // want[1]) >= 2:
        # decode at 1/2, 1/4 or 1/8, never below `want`, in its own mode
        # (asking for L would change how a color JPEG turns gray)
        im.draft(im.mode, want)
    _load(im)
    gray = _gray(im, want)
    if orientation in _UPRIGHT:
        gray = gray.transpose(_UPRIGHT[orientation])
    out = _fit(gray, w_dots, h_dots, fit)
    if rotation:
        out = out.transpose(_TURN[rotation])
    return Raster(out.width, out.height, out.tobytes())
