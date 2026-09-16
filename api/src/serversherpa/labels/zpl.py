"""ZPL II compiler for the label element model.

Pure: Design + dpi (+ optional substitutions) -> ZPL string.
substitutions=None leaves {tokens} intact (storage/generation form); a
dict substitutes values (sample preview / generation output). Literal
text rides behind ^FH_ hex escaping so ^ ~ _ and non-ASCII survive;
tokens pass through untouched. Bold is approximated by a 1.2x glyph
width (font 0 has no weight); canvas preview owns true bold rendering."""

from serversherpa.labels.model import (
    BarcodeEl, BoxEl, Design, LineEl, QrEl, TextEl,
)
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


def _barcode(el: BarcodeEl, dpi: int, subs) -> str:
    hd = _dots(el.h, dpi)
    flag = "Y" if el.show_text else "N"
    # None keeps the historical ^BY2 exactly; a module width in inches is
    # converted per dpi so the barcode holds its PHYSICAL width across dpi.
    module = 2 if el.module_in is None else max(1, min(10, _dots(el.module_in, dpi)))
    cmd = (f"^BC{_ROT[el.rotation]},{hd},{flag},N,N"
           if el.symbology == "code128"
           else f"^B3{_ROT[el.rotation]},N,{hd},{flag},N")
    return (f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^BY{module}{cmd}"
            f"^FH_^FD{_fd(el.data, subs)}^FS")


def _qr(el: QrEl, dpi: int, subs) -> str:
    mag = min(10, max(1, round(_dots(el.w, dpi) / 25)))
    return (f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^BQ{_ROT[el.rotation]},2,{mag}"
            f"^FH_^FDQA,{_fd(el.data, subs)}^FS")


def _shape(el, dpi: int) -> str:
    t = max(1, _dots(el.stroke_in, dpi))
    w = max(t, _dots(el.w, dpi))
    h = max(t, _dots(el.h, dpi))
    return f"^FO{_dots(el.x, dpi)},{_dots(el.y, dpi)}^GB{w},{h},{t}^FS"


def compile_zpl(design: Design, dpi: int,
                substitutions: dict[str, str] | None = None) -> str:
    lines = ["^XA",
             f"^PW{_dots(design.width_in, dpi)}",
             f"^LL{_dots(design.height_in, dpi)}",
             "^CI28"]
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
