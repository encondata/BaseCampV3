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
  at 1/2, 1/4 or 1/8; anything else by a whole-factor box reduction, the
  factor at most MAX_REDUCE, alpha premultiplied, the remainder dropped
  evenly from both sides so the picture stays centered), never below twice
  the box: a 40 MP upload never makes full-size copies for the steps below.
  A picture under four times the box is never reduced, so its raster is
  exactly what the steps below make;
- composite any transparency onto white (a clear pixel stored as black
  would otherwise print black), 16-bit gray's included;
- 8-bit gray by ITU-R 601 luma (Pillow's L: 299/587/114);
- apply the EXIF orientation (an exact transposition);
- fit to the unrotated box: `cover` scales to fill and crops the center
  (the crop held inside the picture), `contain` scales to fit and
  letterboxes in white; box-filter resampling;
- turn by exact transposition, clockwise as every element turns (ZPL `R`
  is 90), so at 90 and 270 the raster is h wide and w tall.

`gray_rasters` preps one picture for several boxes (the elements of one
design that show it): it is opened and decoded once (a JPEG once per scale
it is drafted at), and each box gets exactly the raster `gray_raster` makes
for that box alone. The builder's canvas (one box at a time) and the
compile both dither this same raster with the shared integer dither, so
what the canvas shows is what prints.

Only a decoder error makes a picture unreadable: damage the decoder papers
over prints as decoded (libjpeg fills the rest of a JPEG whose data stops
early at an end marker with mid-gray; a corrupt lossy WebP can decode to
noise), as it shows anywhere else the picture is displayed.

Pillow's own decompression-bomb warning (past ~89 MP) is left to the
warnings filter: MAX_PIXELS refuses those pictures anyway, and a filter
that turns the warning into an error gets ImageTooLarge too. (A
`warnings.catch_warnings` here would not be thread-safe: prep runs in
worker threads.)"""

from __future__ import annotations

import io
from collections.abc import Sequence
from typing import NamedTuple

from PIL import Image

# a decompression-bomb guard: a picture past this many pixels is refused
# from its header, at upload and at prep
MAX_PIXELS = 40_000_000
# the largest whole-factor box reduction: past it Pillow's fixed-point
# average drifts (white comes out 254 at 300), and the fit's resampling
# does the rest of the shrinking
MAX_REDUCE = 255

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
# 16-bit gray levels to 8 (v // 257, a level never rounds up past its band)
_SIXTEEN_TO_EIGHT = [v // 257 for v in range(65536)]


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
    """The EXIF orientation, or None (also for an EXIF block too broken to
    parse). Anything but a JPEG is decoded first: reading a PNG's EXIF can
    decode it (no early eXIf chunk), and a broken stream must surface here
    as UnreadableImage, not be swallowed with the EXIF and leave an empty
    picture. A JPEG's EXIF is in its header, so it can still be drafted
    after this."""
    if im.format not in _JPEG_FORMATS:
        _load(im)
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
    """`im` box-reduced by the largest whole factor (at most MAX_REDUCE)
    that keeps it at least `want` both ways (RGBA and LA premultiplied, as
    Pillow's reduce does); `im` itself under a factor of 2. The rows and
    columns past a whole number of blocks are dropped evenly from both
    sides, so the picture stays centered (rounding the size up would shift
    it by up to half a reduced pixel)."""
    factor = min(MAX_REDUCE, im.width // want[0], im.height // want[1])
    if factor < 2:
        return im
    width, height = im.width // factor * factor, im.height // factor * factor
    left, top = (im.width - width) // 2, (im.height - height) // 2
    return im.reduce(factor, (left, top, left + width, top + height))


def _on_white(im: Image.Image) -> Image.Image:
    """A picture with alpha (RGBA or LA) composited onto white, as L."""
    rgba = im if im.mode == "RGBA" else im.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    white.alpha_composite(rgba)
    return white.convert("L")


def _base(im: Image.Image) -> tuple[Image.Image, bool]:
    """What every box of a decoded picture starts from, and whether it still
    has transparency to put on white: 8-bit gray (False), or RGBA or LA
    (True). Nothing here depends on the box, so a picture shown in several
    boxes makes this once."""
    if im.mode.startswith("I;16"):
        im = im.convert("I")
    if im.mode == "I":                         # 16-bit gray: scale, don't clip
        gray = im.point(_SIXTEEN_TO_EIGHT, "L")
        clear = im.info.get("transparency")
        if not isinstance(clear, int):
            return gray, False
        # a tRNS level: those dots are clear. One 8-bit alpha band; the
        # reduction and the white composite then work on the gray + alpha
        alpha = im.point([0 if v == clear else 255 for v in range(65536)], "L")
        return Image.merge("LA", (gray, alpha)), True
    if im.mode in _ALPHA_MODES or "transparency" in im.info:
        return (im if im.mode == "RGBA" else im.convert("RGBA")), True
    return im.convert("L"), False


def _gray(base: Image.Image, clear: bool, want: tuple[int, int]) -> Image.Image:
    """8-bit gray, reduced toward `want` first, then (when the picture has
    transparency) composited onto white: the composite works on the smaller
    picture."""
    reduced = _reduced(base, want)
    return _on_white(reduced) if clear else reduced


def _fit(im: Image.Image, width: int, height: int, fit: str) -> Image.Image:
    iw, ih = im.size
    if fit == "cover":
        scale = max(width / iw, height / ih)
        cw, ch = width / scale, height / scale       # the source area kept
        # one side is the whole picture: float error can put its edges a
        # hair outside it, which Pillow refuses
        left, top = max(0.0, (iw - cw) / 2), max(0.0, (ih - ch) / 2)
        return im.resize((width, height), Image.Resampling.BOX,
                         box=(left, top, min(float(iw), left + cw), min(float(ih), top + ch)))
    scale = min(width / iw, height / ih)
    nw = max(1, min(width, round(iw * scale)))
    nh = max(1, min(height, round(ih * scale)))
    out = Image.new("L", (width, height), 255)
    out.paste(im.resize((nw, nh), Image.Resampling.BOX), ((width - nw) // 2, (height - nh) // 2))
    return out


def _check_box(w_dots: int, h_dots: int, fit: str, rotation: int) -> None:
    if not (isinstance(w_dots, int) and isinstance(h_dots, int) and w_dots > 0 and h_dots > 0):
        raise ValueError(f"the box must be whole dots above 0, not {w_dots} x {h_dots}")
    if fit not in FITS:
        raise ValueError(f"fit must be cover or contain, not {fit!r}")
    if rotation not in (0, *_TURN):
        raise ValueError(f"rotation must be 0, 90, 180 or 270, not {rotation!r}")


class _Picture:
    """One stored picture, opened once and decoded once for every box it is
    prepped to (a JPEG once per scale it is drafted at: 1/2, 1/4 or 1/8 for
    a small box, whole for a large one). Each box's raster is exactly what
    prepping that box alone makes, so the canvas (one box at a time) and a
    compile (every element of a design together) get the same raster.
    Raises ImageTooLarge or UnreadableImage."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._im, _kind = _open(data)
        self._jpeg = self._im.format in _JPEG_FORMATS
        # anything but a JPEG is decoded here (module docstring, _orientation)
        self._orientation = _orientation(self._im)
        # the decoded picture's _base, by its decoded size (a JPEG drafted
        # smaller decodes smaller)
        self._bases: dict[tuple[int, int], tuple[Image.Image, bool]] = {}

    def _base_for(self, want: tuple[int, int]) -> tuple[Image.Image, bool]:
        im = self._im
        if self._jpeg and min(im.width // want[0], im.height // want[1]) >= 2:
            # decode at 1/2, 1/4 or 1/8, never below `want`, in its own
            # mode (asking for L would change how a color JPEG turns gray).
            # A draft is set once, before decoding: a fresh open per scale
            im, _kind = _open(self._data)
            im.draft(im.mode, want)
        base = self._bases.get(im.size)
        if base is None:
            _load(im)
            base = self._bases[im.size] = _base(im)
        return base

    def raster(self, w_dots: int, h_dots: int, fit: str, rotation: int) -> Raster:
        # twice the box, as the picture is stored (before its EXIF turn)
        want = ((2 * h_dots, 2 * w_dots) if self._orientation in _SWAPPED
                else (2 * w_dots, 2 * h_dots))
        gray = _gray(*self._base_for(want), want)
        if self._orientation in _UPRIGHT:
            gray = gray.transpose(_UPRIGHT[self._orientation])
        out = _fit(gray, w_dots, h_dots, fit)
        if rotation:
            out = out.transpose(_TURN[rotation])
        return Raster(out.width, out.height, out.tobytes())


def gray_raster(data: bytes, w_dots: int, h_dots: int, fit: str, rotation: int) -> Raster:
    """`data` fitted to the unrotated w_dots x h_dots box, then turned
    `rotation` degrees clockwise (module docstring). Raises ImageTooLarge,
    UnreadableImage, or ValueError for a bad box, fit or rotation."""
    _check_box(w_dots, h_dots, fit, rotation)
    return _Picture(data).raster(w_dots, h_dots, fit, rotation)


def gray_rasters(data: bytes, boxes: Sequence[tuple[int, int, str, int]],
                 ) -> list[Raster | ImageTooLarge | UnreadableImage]:
    """`gray_raster` for each (w_dots, h_dots, fit, rotation) box of one
    picture, which is opened and decoded once for all of them (`_Picture`):
    each box's raster, or the ImageTooLarge or UnreadableImage it gets.
    Raises ValueError, before anything is decoded, for a bad box."""
    for box in boxes:
        _check_box(*box)
    if not boxes:
        return []
    try:
        picture = _Picture(data)
    except (ImageTooLarge, UnreadableImage) as exc:
        return [exc] * len(boxes)
    out: list[Raster | ImageTooLarge | UnreadableImage] = []
    for box in boxes:
        try:
            out.append(picture.raster(*box))
        except (ImageTooLarge, UnreadableImage) as exc:
            out.append(exc)
    return out
