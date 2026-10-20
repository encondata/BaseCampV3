"""Glyph metrics of a TrueType font for the label builder (spec §4.2
Positions, §4.4): the canvas reserves widths and places baselines from
them. The resident Swiss 721 (printer built-in) is drawn with a stand-in face,
so its real metrics come from here, read from the library copy.

Every value is in font units; scale by font size / `unitsPerEm`. `ascent`
and `descent` are the hhea line metrics as positive distances above and
below the baseline. `advances` covers printable ASCII (32-126); a
character the font has no glyph for gets the advance of `.notdef`, which
is what the printer draws in its place."""

import io

from fontTools.ttLib import TTFont

FIRST_CODEPOINT, LAST_CODEPOINT = 32, 126
# the range the OpenType spec allows for head.unitsPerEm
MIN_UPEM, MAX_UPEM = 16, 16384


class UnreadableFont(ValueError):
    """The bytes are not a TrueType font fontTools can read."""


def metrics(ttf_bytes: bytes) -> dict:
    """{"unitsPerEm", "ascent", "descent", "advances": {char: advance}}."""
    try:
        font = TTFont(io.BytesIO(ttf_bytes), lazy=True)
        upem = int(font["head"].unitsPerEm)
        if not MIN_UPEM <= upem <= MAX_UPEM:
            raise UnreadableFont(f"unitsPerEm {upem} is outside {MIN_UPEM}..{MAX_UPEM}")
        hhea = font["hhea"]
        hmtx = font["hmtx"]
        cmap = font.getBestCmap() or {}
        notdef = font.getGlyphOrder()[0]
        return {
            "unitsPerEm": upem,
            "ascent": abs(int(hhea.ascent)),
            "descent": abs(int(hhea.descent)),
            "advances": {chr(cp): int(hmtx[cmap.get(cp, notdef)][0])
                         for cp in range(FIRST_CODEPOINT, LAST_CODEPOINT + 1)},
        }
    except UnreadableFont:
        raise
    except Exception as exc:
        # fontTools reports a damaged or foreign file through many exception
        # types (TTLibError, struct.error, KeyError, AssertionError, ...).
        raise UnreadableFont(str(exc) or type(exc).__name__) from exc
