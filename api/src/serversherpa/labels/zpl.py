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
QR codes and shapes are placed top-left with `^FO`."""

from collections.abc import Mapping

from serversherpa.labels.fonts import font_object
from serversherpa.labels.model import (
    BarcodeEl, BoxEl, Design, FieldEl, LineEl, QrEl, TextEl, element_hidden,
    element_value,
)
from serversherpa.labels.qr import qr_modules
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


def _barcode_field(el: BarcodeEl | FieldEl, dpi: int, fd: str) -> str:
    """A barcode field around already-escaped data `fd`."""
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

FontObjects = Mapping[str, Mapping[str, str | None]]


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


def _v2_text(el: TextEl | FieldEl, value: str, dpi: int,
             font_objects: FontObjects | None) -> list[str]:
    family, weight = el.font.family, el.font.weight
    obj, faux = font_object(family, weight, objects=(font_objects or {}).get(family))
    h = round(el.font_size_pt * dpi / 72)
    w = round(h * 1.15) if faux and el.inverted else h
    lines = el.lines if isinstance(el, TextEl) else 1
    # with a ^FB, ^FT marks the LAST line's baseline; lines sit one font
    # height apart (^FB line spacing 0)
    ox, oy = _origin(el, dpi, el.baseline_in + (lines - 1) * el.font_size_pt / 72)
    block = (f"^FB{_dots(el.w, dpi)},{lines},0,{_JUST[el.align]},0"
             if el.align != "left" or lines > 1 else "")
    rest = (f"{block}^A@{_ROT[el.rotation]},{h},{w},E:{obj}"
            + ("^FR" if el.inverted else "") + f"^FH_^FD{_esc(value)}^FS")
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
    where the design put it. ^BQ prints upright only (N): a square symbol
    looks the same at any rotation, which stays in the model for the canvas."""
    modules = qr_modules(value)
    wd, hd = _dots(el.w, dpi), _dots(el.h, dpi)
    mag = min(10, max(1, round(wd / modules)))
    side = modules * mag
    x = max(0, _dots(el.x, dpi) + (wd - side) // 2)
    y = max(0, _dots(el.y, dpi) + (hd - side) // 2)
    return f"^FO{x},{y}^BQN,2,{mag}^FH_^FDMA,{_esc(value)}^FS"


def _v2_shape(el: LineEl | BoxEl, dpi: int) -> str:
    t = max(1, _dots(el.stroke_in, dpi))
    along, across = _dots(el.w, dpi), _dots(el.h, dpi)
    w, h = (across, along) if el.rotation in (90, 270) else (along, across)
    w, h = max(t, w), max(t, h)
    if isinstance(el, BoxEl) and el.fill:
        t = min(w, h)
    return f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^GB{w},{h},{t}^FS"


def _v2_element(el: object, dpi: int, values: Mapping[str, str],
                font_objects: FontObjects | None) -> list[str]:
    if isinstance(el, (LineEl, BoxEl)):
        return [_v2_shape(el, dpi)]
    if element_hidden(el, values):
        return []
    value = element_value(el, values)
    display = el.display if isinstance(el, FieldEl) else None
    if isinstance(el, BarcodeEl) or display == "barcode":
        return [_barcode_field(el, dpi, _esc(value))]
    if isinstance(el, QrEl) or display == "qr":
        return [_v2_qr(el, value, dpi)]
    return _v2_text(el, value, dpi, font_objects)


def compile_zpl(design: Design, dpi: int,
                substitutions: dict[str, str] | None = None, *,
                font_objects: FontObjects | None = None) -> str:
    """`font_objects` ({family: {"regular", "bold"}}) overrides a schema 2
    family's object names with what the font library holds."""
    lines = ["^XA",
             f"^PW{_dots(design.width_in, dpi)}",
             f"^LL{_dots(design.height_in, dpi)}",
             "^CI28"]
    if design.schema >= 2:
        if substitutions is None:
            raise ValueError("v2 designs render with values")
        for el in design.elements:
            lines.extend(_v2_element(el, dpi, substitutions, font_objects))
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
