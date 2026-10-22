"""ZPL II compiler for the label element model.

Pure: Design + dpi (+ optional substitutions) -> ZPL string.
substitutions=None leaves {tokens} intact (storage/generation form); a
dict substitutes values (sample preview / generation output). Literal
text rides behind ^FH_ hex escaping so ^ ~ _ and non-ASCII survive;
tokens pass through untouched. Bold is approximated by a 1.2x glyph
width (font 0 has no weight); canvas preview owns true bold rendering.

A schema 2 design (the label builder's, spec §4.2 and §4.8) compiles
differently and only with values (there is no token form): text sits on
its baseline with `^FT`, in a named TrueType font (`^A@…,E:<object>`);
center/right alignment is a one-line `^FB` over the reserved width
(the element's w; the compiler never measures text); Bold on a family
with no Bold file overprints one dot along the reading direction, or on
an inverted element widens the glyphs 15%; inverted text is a filled
`^GB` (the element box plus its pad) under `^FR` text; each field value
goes through Split and its rules first (labels.field_rules). Barcodes,
QR codes and shapes are placed top-left with `^FO`; a Code 128 barcode's
data starts in the subset labels.barcode counted (`>;` C, `>:` B), so it
prints exactly as wide as the canvas draws it.

A schema 3 design adds images (spec 2026-10-20-badge-templates §4.5,
§4.12). The compiler stays pure: the caller resolves each image element to
an already-dithered, already-rotated 1-bit bitmap (labels.dither) and
passes them in by element id (`images=`), each exactly the element's
footprint in dots (its box, turned at 90/270; any other size is a
ValueError). Each prints as `^GFA` with Z64
data at the footprint's top-left (`^FO`), banded when one `^GF` would
pass 99,999 bytes; white dots are transparent, so the element order is
the stacking order, as on the canvas. A graphic has no `^FH` (its data is
never escaped). An image with no bitmap prints nothing, or a 2-dot outline
of its footprint when its hideWhenEmpty is off.

`image_placeholders` is the builder's preview (rendered by Labelary, which
must never be sent a picture): every image element, whatever its source,
its bitmap and its hideWhenEmpty, prints as a placeholder, its footprint's
2-dot outline with both diagonals (`^GB` and two `^GD`)."""

import base64
import binascii
import zlib
from collections.abc import Mapping

from serversherpa.labels.barcode import code128_data
from serversherpa.labels.dither import Bitmap, bytes_per_row
from serversherpa.labels.fonts import font_object
from serversherpa.labels.model import (
    BarcodeEl,
    BoxEl,
    Design,
    FieldEl,
    ImageEl,
    LineEl,
    QrEl,
    TextEl,
    element_hidden,
    element_value,
)
from serversherpa.labels.qr import QrTooLong, qr_fo_offset_dots, qr_modules
from serversherpa.labels.tokens import TOKEN_RE

_ROT = {0: "N", 90: "R", 180: "I", 270: "B"}


def _dots(v: float, dpi: int) -> int:
    return round(v * dpi)


def _esc(literal: str) -> str:
    out = []
    for ch in literal:
        if ch in "^~_\\" or not (32 <= ord(ch) <= 126):
            out.extend(f"_{b:02x}" for b in ch.encode("utf-8"))
        else:
            out.append(ch)
    return "".join(out)


def _fd(value: str, subs: dict[str, str] | None) -> str:
    parts: list[str] = []
    pos = 0
    for m in TOKEN_RE.finditer(value):
        parts.append(_esc(value[pos:m.start()]))
        parts.append(m.group(0) if subs is None
                     else _esc(subs.get(m.group(1), "")))
        pos = m.end()
    parts.append(_esc(value[pos:]))
    return "".join(parts)


_JUST = {"left": "L", "center": "C", "right": "R"}


def _text(el: TextEl, dpi: int, subs) -> str:
    h = round(el.font_size_pt * dpi / 72)
    w = round(h * 1.2) if el.bold else h
    line = f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}"
    # A ^FB is needed for justification OR for wrapping. Left-aligned
    # single-line fields still emit none, so existing designs are untouched.
    if el.align != "left" or el.lines > 1:
        line += f"^FB{_dots(el.w, dpi)},{el.lines},0,{_JUST[el.align]},0"
    line += f"^A0{_ROT[el.rotation]},{h},{w}"
    if el.reverse:
        line += "^FR"
    return line + f"^FH_^FD{_fd(el.content, subs)}^FS"


def _barcode_field(el: BarcodeEl | FieldEl, dpi: int, fd: str, *, start: bool = False) -> str:
    """A barcode field around already-escaped data `fd`. In Code 128 data a
    `>` starts an invocation code (`>;` subset C, `>8` FNC1, …), so a
    literal one goes as `>0` (escaping never makes a `>`, so this is safe
    on escaped data). With `start` (schema 2, whose data is a value) the
    data also opens with its subset's start code (labels.barcode); schema
    1 data may still hold {tokens}, so it can't be counted and has none."""
    if el.symbology == "code128":
        fd = code128_data(fd) if start else fd.replace(">", ">0")
    hd = _dots(el.h, dpi)
    flag = "Y" if el.show_text else "N"
    # None keeps the historical ^BY2 exactly; a module width in inches is
    # converted per dpi so the barcode holds its PHYSICAL width across dpi.
    module = 2 if el.module_in is None else max(1, min(10, _dots(el.module_in, dpi)))
    cmd = (f"^BC{_ROT[el.rotation]},{hd},{flag},N,N"
           if el.symbology == "code128"
           else f"^B3{_ROT[el.rotation]},N,{hd},{flag},N")
    return (f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^BY{module}{cmd}"
            f"^FH_^FD{fd}^FS")


def _barcode(el: BarcodeEl, dpi: int, subs) -> str:
    return _barcode_field(el, dpi, _fd(el.data, subs))


def _qr(el: QrEl, dpi: int, subs) -> str:
    mag = min(10, max(1, round(_dots(el.w, dpi) / 25)))
    return (f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^BQ{_ROT[el.rotation]},2,{mag}"
            f"^FH_^FDQA,{_fd(el.data, subs)}^FS")


def _shape(el, dpi: int) -> str:
    t = max(1, _dots(el.stroke_in, dpi))
    w = max(t, _dots(el.w, dpi))
    h = max(t, _dots(el.h, dpi))
    return f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^GB{w},{h},{t}^FS"


# ---- schema 2 ---------------------------------------------------------

# one dot along each rotation's reading direction (the faux-bold overprint)
_STEP = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}


def _origin(el: TextEl | FieldEl, dpi: int, baseline_in: float) -> tuple[int, int]:
    """The ^FT point: the start of the baseline. x, y is the footprint's
    top-left; w runs along the text and h across it (model.py)."""
    x, y, w, h, b = el.x, el.y, el.w, el.h, baseline_in
    if el.rotation == 90:      # reads down, glyph tops to the right
        pos = (x + h - b, y)
    elif el.rotation == 180:   # upside down, starts at the right
        pos = (x + w, y + h - b)
    elif el.rotation == 270:   # reads up, glyph tops to the left
        pos = (x + b, y + w)
    else:
        pos = (x, y + b)
    return _dots(pos[0], dpi), _dots(pos[1], dpi)


def _invert_box(el: TextEl | FieldEl, dpi: int) -> str:
    """The filled block under inverted text: the element box plus its pad
    (x along the text, y across), turned with the element."""
    px, py = _dots(el.invert_pad.x, dpi), _dots(el.invert_pad.y, dpi)
    along = _dots(el.w, dpi) + 2 * px
    across = _dots(el.h, dpi) + 2 * py
    x, y = _dots(el.x, dpi), _dots(el.y, dpi)
    if el.rotation in (90, 270):
        bx, by, bw, bh = x - py, y - px, across, along
    else:
        bx, by, bw, bh = x - px, y - py, along, across
    # a pad past the label's top or left edge stops at the edge
    if bx < 0:
        bw, bx = bw + bx, 0
    if by < 0:
        bh, by = bh + by, 0
    bw, bh = max(1, bw), max(1, bh)
    # thickness = the short side fills the box (a thicker border would grow it)
    return f"^FO{bx},{by}^GB{bw},{bh},{min(bw, bh)}^FS"


def _text_data(el: TextEl | FieldEl, value: str, lines: int) -> str:
    """The escaped ^FD of a text: a newline typed into static text is the
    ^FB line break `\\&` when the text has lines to break onto, and
    dropped on a one-line text (a hex LF would print as nothing or a box)."""
    if not isinstance(el, TextEl):
        return _esc(value)
    parts = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return ("\\&" if lines > 1 else "").join(_esc(part) for part in parts)


def _v2_text(el: TextEl | FieldEl, value: str, dpi: int) -> list[str]:
    obj, faux = font_object(el.font.family, el.font.weight)
    h = round(el.font_size_pt * dpi / 72)
    w = round(h * 1.15) if faux and el.inverted else h
    lines = el.lines if isinstance(el, TextEl) else 1
    # with a ^FB, ^FT marks the LAST line's baseline; lines sit one font
    # height apart (^FB line spacing 0)
    ox, oy = _origin(el, dpi, el.baseline_in + (lines - 1) * el.font_size_pt / 72)
    block = (f"^FB{_dots(el.w, dpi)},{lines},0,{_JUST[el.align]},0"
             if el.align != "left" or lines > 1 else "")
    rest = (f"{block}^A@{_ROT[el.rotation]},{h},{w},E:{obj}"
            + ("^FR" if el.inverted else "") + f"^FH_^FD{_text_data(el, value, lines)}^FS")
    out = [_invert_box(el, dpi)] if el.inverted else []
    out.append(f"^FT{ox},{oy}{rest}")
    if faux and not el.inverted:
        dx, dy = _STEP[el.rotation]
        out.append(f"^FT{max(0, ox + dx)},{max(0, oy + dy)}{rest}")
    return out


def _v2_qr(el: QrEl | FieldEl, value: str, dpi: int) -> str:
    """Error correction M, automatic input (`MA,`). Magnification fills the
    box for the symbol size the value needs (labels.qr), capped at the
    printer's 10; the symbol is centered on the box, so a capped one stays
    where the design put it. The printer draws the symbol QR_FO_OFFSET_IN
    below its ^FO, so ^FO goes that far above where it should print; a
    symbol nearer the top edge than that can't print where drawn, and its
    ^FO y stays at 0 (the builder warns). ^BQ prints upright only (N): a
    square symbol looks the same at any rotation, which stays in the model
    for the canvas."""
    try:
        modules = qr_modules(value)
    except QrTooLong as e:
        raise QrTooLong(f"{el.id}: {e.problems[0]}") from e
    wd, hd = _dots(el.w, dpi), _dots(el.h, dpi)
    mag = min(10, max(1, round(wd / modules)))
    side = modules * mag
    x = max(0, _dots(el.x, dpi) + (wd - side) // 2)
    top = _dots(el.y, dpi) + (hd - side) // 2
    y = max(0, top - qr_fo_offset_dots(dpi))
    return f"^FO{x},{y}^BQN,2,{mag}^FH_^FDMA,{_esc(value)}^FS"


def _v2_shape(el: LineEl | BoxEl, dpi: int) -> str:
    t = max(1, _dots(el.stroke_in, dpi))
    along, across = _dots(el.w, dpi), _dots(el.h, dpi)
    w, h = (across, along) if el.rotation in (90, 270) else (along, across)
    w, h = max(t, w), max(t, h)
    if isinstance(el, BoxEl) and el.fill:
        t = min(w, h)
    return f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^GB{w},{h},{t}^FS"


# ---- schema 3: images ---------------------------------------------------

# ^GFa,b,c,d: c (the graphic's bytes) runs 1 to 99,999
GF_MAX_BYTES = 99_999
# the outline an empty photo or logo prints when hideWhenEmpty is off, and
# a preview's placeholder
EMPTY_IMAGE_STROKE = 2


def crc16(data: bytes) -> str:
    """CRC-16/XMODEM (CCITT, initial 0) as 4 upper-case hex digits: the
    checksum a Z64 field ends with, taken over its base64 text."""
    return f"{binascii.crc_hqx(data, 0):04X}"


def z64(raw: bytes) -> str:
    """A ^GF data field in Zebra's Z64 form: `:Z64:`, the zlib stream (not
    raw deflate) in base64, `:`, then the CRC of that base64 text."""
    b64 = base64.b64encode(zlib.compress(raw)).decode("ascii")
    return f":Z64:{b64}:{crc16(b64.encode('ascii'))}"


def box_dots(w_in: float, h_in: float, dpi: int) -> tuple[int, int]:
    """A w x h inch box in whole dots at `dpi`, rounded as every element is."""
    return _dots(w_in, dpi), _dots(h_in, dpi)


def image_box_dots(el: ImageEl, dpi: int) -> tuple[int, int]:
    """The image's unrotated w x h box in dots: the size its picture is
    fitted to before it is turned (the bitmap is then that, transposed at
    90 and 270)."""
    return box_dots(el.w, el.h, dpi)


def image_footprint_dots(el: ImageEl, dpi: int) -> tuple[int, int]:
    """The dots the image covers on the label: its box, turned at 90 and 270."""
    along, across = image_box_dots(el, dpi)
    return (across, along) if el.rotation in (90, 270) else (along, across)


def _graphic(x: int, y: int, bitmap: Bitmap) -> list[str]:
    """`bitmap` as ^GFA fields with its top-left at x, y: one band of whole
    rows per GF_MAX_BYTES, each band placed one band height further down."""
    width, height, bits = bitmap
    d = bytes_per_row(width)
    if len(bits) != d * height:
        raise ValueError(f"a {width} x {height} bitmap has {d * height} bytes, not {len(bits)}")
    rows = GF_MAX_BYTES // d
    if rows < 1:
        raise ValueError(f"a {width}-dot row is wider than one ^GF holds")
    out = []
    for top in range(0, height, rows):
        band = bits[top * d:(top + rows) * d]
        out.append(f"^FO{x},{y + top}^GFA,{len(band)},{len(band)},{d},{z64(band)}^FS")
    return out


def _v2_image(el: ImageEl, dpi: int, bitmap: Bitmap | None) -> list[str]:
    x, y = _dots(el.x, dpi), _dots(el.y, dpi)
    w, h = image_footprint_dots(el, dpi)
    if bitmap is not None and bitmap[0] > 0 and bitmap[1] > 0:
        if (bitmap[0], bitmap[1]) != (w, h):
            # prepped for another box, DPI or turn: it would print off its place
            raise ValueError(f"image {el.id}: a {bitmap[0]} x {bitmap[1]} bitmap for a "
                             f"{w} x {h} footprint")
        return _graphic(x, y, Bitmap(*bitmap))
    if el.hide_when_empty:
        return []
    t = EMPTY_IMAGE_STROKE
    return [f"^FO{x},{y}^GB{max(t, w)},{max(t, h)},{t}^FS"]


def _image_placeholder(el: ImageEl, dpi: int) -> list[str]:
    """The footprint outlined, with both diagonals: a picture's place on a
    preview, which never carries the picture."""
    x, y = _dots(el.x, dpi), _dots(el.y, dpi)
    t = EMPTY_IMAGE_STROKE
    w, h = (max(t, n) for n in image_footprint_dots(el, dpi))
    return [f"^FO{x},{y}^GB{w},{h},{t}^FS",
            f"^FO{x},{y}^GD{w},{h},{t},B,R^FS",
            f"^FO{x},{y}^GD{w},{h},{t},B,L^FS"]


def _v2_element(el: object, dpi: int, values: Mapping[str, str],
                images: Mapping[str, Bitmap], image_placeholders: bool) -> list[str]:
    if isinstance(el, ImageEl):
        if image_placeholders:
            return _image_placeholder(el, dpi)
        return _v2_image(el, dpi, images.get(el.id))
    if isinstance(el, (LineEl, BoxEl)):
        return [_v2_shape(el, dpi)]
    if element_hidden(el, values):
        return []
    value = element_value(el, values)
    display = el.display if isinstance(el, FieldEl) else None
    if isinstance(el, BarcodeEl) or display == "barcode":
        return [_barcode_field(el, dpi, _esc(value), start=True)]
    if isinstance(el, QrEl) or display == "qr":
        return [_v2_qr(el, value, dpi)]
    return _v2_text(el, value, dpi)


def compile_zpl(design: Design, dpi: int,
                substitutions: dict[str, str] | None = None, *,
                images: Mapping[str, Bitmap] | None = None,
                image_placeholders: bool = False) -> str:
    """`images` maps an image element's id to its bitmap (schema 3); an
    image element with none prints as empty. With `image_placeholders`
    every image element prints as a placeholder instead, and `images` is
    not looked at (module docstring)."""
    lines = ["^XA",
             f"^PW{_dots(design.width_in, dpi)}",
             f"^LL{_dots(design.height_in, dpi)}",
             "^CI28"]
    if design.schema >= 2:
        if substitutions is None:
            raise ValueError("v2 designs render with values")
        for el in design.elements:
            lines.extend(_v2_element(el, dpi, substitutions, images or {}, image_placeholders))
        lines.append("^XZ")
        return "\n".join(lines)
    for el in design.elements:
        if isinstance(el, TextEl):
            lines.append(_text(el, dpi, substitutions))
        elif isinstance(el, BarcodeEl):
            lines.append(_barcode(el, dpi, substitutions))
        elif isinstance(el, QrEl):
            lines.append(_qr(el, dpi, substitutions))
        elif isinstance(el, (LineEl, BoxEl)):
            lines.append(_shape(el, dpi))
    lines.append("^XZ")
    return "\n".join(lines)
