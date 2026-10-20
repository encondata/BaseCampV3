"""Brother ESC/P compiler — FIRST PASS, approximate until verified on
hardware (spec: 'text + barcodes, refined when real Brother printers are
in hand'). ESC/P on QL/PT printers is line-oriented, so x/y positions
collapse to reading order (y, then x); shapes and rotation are ignored.
Golden tests pin this output as a regression baseline only. NUL bytes
cannot round-trip through Postgres TEXT, so literal \\x00 bytes are
emitted as the printable four-character escape "\\x00"; the future print
driver decodes \\xNN escapes before sending the stream to hardware.

Zebra-only element properties (`reverse`, `lines`, `module_in`) are
ignored here by design — ESC/P has no field-reverse or narrow-module
concept, and this compiler is line-oriented so wrapping is the
printer's business. A schema 2 design compiles the same way, from its
values: fields print their value after Split and their rules; fonts,
inverted boxes and pads are ignored; hidden fields drop out."""

from serversherpa.labels.model import (
    BarcodeEl, Design, FieldEl, TextEl, element_hidden, element_value,
)
from serversherpa.labels.tokens import resolve_tokens

ESC = "\x1b"


def _ordered(design: Design) -> list:
    els = [e for e in design.elements if isinstance(e, (TextEl, BarcodeEl))
           or (isinstance(e, FieldEl) and e.display != "qr")]
    return sorted(els, key=lambda e: (e.y, e.x))


def compile_escp(design: Design,
                 substitutions: dict[str, str] | None = None) -> str:
    v2 = design.schema >= 2
    if v2 and substitutions is None:
        raise ValueError("v2 designs render with values")
    parts = [f"{ESC}@", f"{ESC}ia\\x00"]  # initialize; select ESC/P mode
    for el in _ordered(design):
        if v2 and element_hidden(el, substitutions):
            continue
        barcode = isinstance(el, BarcodeEl) or (isinstance(el, FieldEl)
                                                and el.display == "barcode")
        if v2:
            data = element_value(el, substitutions)
        else:
            data = resolve_tokens(el.data if barcode else el.content, substitutions)
        if not barcode:
            size = max(1, min(255, round(el.font_size_pt)))
            parts.append(f"{ESC}X\\x00{chr(size)}\\x00")  # point size
            if el.bold:
                parts.append(f"{ESC}E")
            parts.append(data)
            if el.bold:
                parts.append(f"{ESC}F")
            parts.append("\r\n")
        else:
            sym = "5" if el.symbology == "code128" else "0"  # t5=128, t0=39
            h_dots = max(1, min(255, round(el.h * 180)))
            flag = "1" if el.show_text else "0"
            parts.append(f"{ESC}it{sym}h{chr(h_dots)}r{flag}z2b" + data + "\\\\")
            parts.append("\r\n")
    return "".join(parts)
