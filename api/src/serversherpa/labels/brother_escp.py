"""Brother ESC/P compiler — FIRST PASS, approximate until verified on
hardware (spec: 'text + barcodes, refined when real Brother printers are
in hand'). ESC/P on QL/PT printers is line-oriented, so x/y positions
collapse to reading order (y, then x); shapes and rotation are ignored.
Golden tests pin this output as a regression baseline only."""

from serversherpa.labels.model import BarcodeEl, Design, TextEl
from serversherpa.labels.tokens import resolve_tokens

ESC = "\x1b"


def _ordered(design: Design) -> list:
    els = [e for e in design.elements if isinstance(e, (TextEl, BarcodeEl))]
    return sorted(els, key=lambda e: (e.y, e.x))


def compile_escp(design: Design,
                 substitutions: dict[str, str] | None = None) -> str:
    parts = [f"{ESC}@", f"{ESC}ia\x00"]  # initialize; select ESC/P mode
    for el in _ordered(design):
        if isinstance(el, TextEl):
            size = max(1, min(255, round(el.font_size_pt)))
            parts.append(f"{ESC}X\x00{chr(size)}\x00")  # point size
            if el.bold:
                parts.append(f"{ESC}E")
            parts.append(resolve_tokens(el.content, substitutions))
            if el.bold:
                parts.append(f"{ESC}F")
            parts.append("\r\n")
        else:  # BarcodeEl
            sym = "5" if el.symbology == "code128" else "0"  # t5=128, t0=39
            h_dots = max(1, min(255, round(el.h * 180)))
            flag = "1" if el.show_text else "0"
            parts.append(f"{ESC}it{sym}h{chr(h_dots)}r{flag}z2b"
                         + resolve_tokens(el.data, substitutions)
                         + "\\\\")
            parts.append("\r\n")
    return "".join(parts)
