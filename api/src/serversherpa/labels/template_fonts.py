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
