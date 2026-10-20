"""Barcode widths for the v2 ZPL compiler: how many narrow modules a value
prints as, so the builder's canvas draws the width the printer prints
(spec §4.2). The printer draws modules × the ^BY module whatever the
element's box says; the compiler never reads a barcode's w.

Code 128 (`^BC`, mode N): the compiler starts the data in the subset it
counted (`code128_data`), so the count is known: digits only, an even
count of 2 or more, go in subset C (`>;`, two digits a character);
anything else in subset B (`>:`). A character is 11 modules, plus start
and check (11 each) and stop (13). A literal `>` goes as `>0`, one
character, and each byte the compiler hex-escapes behind `^FH_` is one
character, so a value counts as its UTF-8 bytes.

Code 39 (`^B3`, the ^BY ratio's default 3.0): 16 modules a character
(three wide elements of 3, six narrow of 1, the gap of 1), the value plus
start and stop, less the last gap.

An empty value is 0 modules: nothing prints.

Pure: no IO (the laptop edge imports serversherpa.labels from api/src).
The portal mirrors it (labels/builder/barcode.ts) and
fixtures/barcode_modules.json pins both."""

_DIGITS = frozenset("0123456789")
_START = {"B": ">:", "C": ">;"}


def code128_subset(data: str) -> str:
    """"C" for ASCII digits only, an even count of 2 or more; else "B"."""
    even = len(data) >= 2 and len(data) % 2 == 0
    return "C" if even and all(ch in _DIGITS for ch in data) else "B"


def barcode_modules(symbology: str, data: str) -> int:
    """The narrow modules `data` prints as in `symbology` (code128 | code39)."""
    if not data:
        return 0
    n = len(data.encode("utf-8"))
    if symbology == "code39":
        return 16 * (n + 2) - 1
    chars = n // 2 if code128_subset(data) == "C" else n
    return 11 * (chars + 2) + 13


def code128_data(fd: str) -> str:
    """Code 128 ^FD data: a literal `>` as `>0`, behind the start code of
    the subset `code128_subset` picks. `fd` may already be ^FH-escaped:
    escaping never makes a digit or a `>`, and any escape is a non-digit,
    so the subset is the raw value's. Empty stays empty."""
    if not fd:
        return ""
    return _START[code128_subset(fd)] + fd.replace(">", ">0")
