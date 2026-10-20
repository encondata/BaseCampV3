"""P-touch Template data stream — FIRST PASS, approximate until verified
on hardware. Assumes a template stored ON the printer whose objects are
named obj1..objN in canvas reading order (y, then x); we send template
select + per-object data + print. Template number is fixed at 001 for
v1. Golden tests pin the stream as a regression baseline only. NUL bytes
cannot round-trip through Postgres TEXT, so literal \\x00 bytes are
emitted as the printable four-character escape "\\x00"; the future print
driver decodes \\xNN escapes before sending the stream to hardware.

Zebra-only element properties (`reverse`, `lines`, `module_in`) are
ignored here by design — a P-touch template's objects own their own
appearance on the printer; we only send data. A schema 2 design sends
each field's value after Split and its rules (fonts, inverted boxes and
pads ignored); a hidden field sends no data but keeps its object number."""

from serversherpa.labels.model import (
    BarcodeEl, Design, FieldEl, TextEl, element_hidden, element_value,
)
from serversherpa.labels.tokens import resolve_tokens


def _byte(n: int) -> str:
    return "\\x00" if n == 0 else chr(n)


def compile_ptouch(design: Design,
                   substitutions: dict[str, str] | None = None) -> str:
    v2 = design.schema >= 2
    if v2 and substitutions is None:
        raise ValueError("v2 designs render with values")
    els = sorted((e for e in design.elements
                  if isinstance(e, (TextEl, BarcodeEl))
                  or (isinstance(e, FieldEl) and e.display != "qr")),
                 key=lambda e: (e.y, e.x))
    parts = ["^II", "^TS001"]  # initialize; select template 001
    for i, el in enumerate(els, start=1):
        if v2:
            data = ("" if element_hidden(el, substitutions)
                    else element_value(el, substitutions))
        else:
            raw = el.content if isinstance(el, TextEl) else el.data
            data = resolve_tokens(raw, substitutions)
        parts.append(f"^ONobj{i}\\x00")
        n = len(data.encode("utf-8"))
        parts.append(f"^DI{_byte(n & 0xFF)}{_byte((n >> 8) & 0xFF)}{data}")
    parts.append("^FF")  # print
    return "".join(parts)
