"""P-touch Template data stream — FIRST PASS, approximate until verified
on hardware. Assumes a template stored ON the printer whose objects are
named obj1..objN in canvas reading order (y, then x); we send template
select + per-object data + print. Template number is fixed at 001 for
v1. Golden tests pin the stream as a regression baseline only."""

from serversherpa.labels.model import BarcodeEl, Design, TextEl
from serversherpa.labels.tokens import resolve_tokens


def compile_ptouch(design: Design,
                   substitutions: dict[str, str] | None = None) -> str:
    els = sorted((e for e in design.elements
                  if isinstance(e, (TextEl, BarcodeEl))),
                 key=lambda e: (e.y, e.x))
    parts = ["^II", "^TS001"]  # initialize; select template 001
    for i, el in enumerate(els, start=1):
        raw = el.content if isinstance(el, TextEl) else el.data
        data = resolve_tokens(raw, substitutions)
        parts.append(f"^ONobj{i}\x00")
        n = len(data.encode("utf-8"))
        parts.append(f"^DI{chr(n & 0xFF)}{chr((n >> 8) & 0xFF)}{data}")
    parts.append("^FF")  # print
    return "".join(parts)
