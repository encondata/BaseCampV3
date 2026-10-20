"""Which printer-installed fonts a compiled label template references
(spec docs/superpowers/specs/2026-10-19-label-station-printing-design.md,
the Label Station fonts check).

Only fonts on the printer's E: drive count: those are the ones installed
from the portal's font library (`~DY`, Labels → Printers › Install Fonts).
Resident fonts (`^A0`, `^AD`, `R:`/`Z:` objects) are never reported.

Two ZPL forms reference an E: font:
- `^A@o,h,w,E:NAME.TTF` — the field font by object name. The comma before
  the drive is optional (`^A@N,30,30E:NAME.TTF` parses on a Zebra too);
- `^CWa,E:NAME.TTF` — an alias letter or digit for the font, used later
  by `^Aa`.

Matching ignores case; names come back upper-cased, the way
`label_fonts.name` stores them (routes/labels.py `font_object_name`). The
name part is not limited to 8.3 here, so a reference to an over-long name
is still reported (as missing) rather than silently skipped."""

import re

from serversherpa.labels.fonts import font_object
from serversherpa.labels.model import FieldEl, parse_design

_NAME = r"([A-Z0-9_\-]+\.TTF)"
# ^A@ then its parameters (no other command in between) then the E: drive.
_A_AT_RE = re.compile(r"\^A@[^\^~]*?E:" + _NAME, re.IGNORECASE)
# ^CW, a one-character alias, a comma, the E: drive.
_CW_RE = re.compile(r"\^CW[A-Z0-9],\s*E:" + _NAME, re.IGNORECASE)


def fonts_used(code: str) -> set[str]:
    """The E: drive TrueType font object names `code` references,
    upper-cased (`NAME.TTF`)."""
    text = code or ""
    return {m.upper() for rx in (_A_AT_RE, _CW_RE) for m in rx.findall(text)}


def design_fonts(design: dict | None) -> set[str]:
    """The printer objects a schema 2 design's text prints with: one per
    family and weight its static text and text fields use (labels.fonts;
    Bold on a family with no Bold file prints its Regular file). A field
    shown as a barcode or QR code prints no font. Nothing for a schema 1
    design (its fonts are in its compiled code) or one that doesn't parse."""
    if not isinstance(design, dict) or design.get("schema", 1) < 2:
        return set()
    try:
        parsed = parse_design(design)
    except ValueError:
        return set()
    names: set[str] = set()
    for el in parsed.elements:
        if isinstance(el, FieldEl) and el.display not in ("text", "number"):
            continue
        font = getattr(el, "font", None)
        if font is not None:
            names.add(font_object(font.family, font.weight)[0])
    return names
