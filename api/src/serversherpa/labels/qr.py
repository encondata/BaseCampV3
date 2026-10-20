"""QR code sizing for the v2 ZPL compiler: how many modules a value needs,
and where the printer draws a symbol relative to its ^FO.

The printer encodes `^BQ` data at error correction M in automatic mode
(`^FDMA,`). The compiler has to know the symbol's size in modules up front
so it can pick a magnification that fills the element's box and center the
symbol on it. The canvas (portal labels code) mirrors this table and the
^FO offset, so change the two together.

Pure: no IO (the laptop edge imports serversherpa.labels from api/src)."""

from serversherpa.labels.model import DesignError


class QrTooLong(DesignError):
    """A QR value no level-M symbol up to version 10 holds: a problem with
    the design's data (422 bad_design on the compile route), not a crash."""

    def __init__(self, message: str):
        super().__init__([message])

# Data capacity at error correction level M for versions 1-10, as
# (numeric digits, alphanumeric characters, bytes):
#   v1  34/20/14     v2  63/38/26     v3 101/61/42     v4 149/90/62
#   v5 202/122/84    v6 255/154/106   v7 293/178/122   v8 365/221/152
#   v9 432/262/180   v10 513/311/213
CAPACITY_M: tuple[tuple[int, int, int], ...] = (
    (34, 20, 14), (63, 38, 26), (101, 61, 42), (149, 90, 62), (202, 122, 84),
    (255, 154, 106), (293, 178, 122), (365, 221, 152), (432, 262, 180),
    (513, 311, 213),
)

# How far below its ^FO y the printer draws a ^BQ symbol's top edge, in
# inches: 60 dots on a ZD421-300dpi (measured with a ruler probe,
# 2026-10-20), the same at magnification 5 and 10, with no sideways shift.
# The compiler sets ^FO this far above where the symbol should print. The
# other DPIs scale it (41 dots at 203, 120 at 600): unverified on hardware.
# The canvas (portal labels/builder/qr.ts) mirrors it.
QR_FO_OFFSET_IN = 0.2


def qr_fo_offset_dots(dpi: int) -> int:
    """The printer's ^BQ offset below ^FO at `dpi`, in dots."""
    return round(QR_FO_OFFSET_IN * dpi)


NUMERIC = frozenset("0123456789")
# the QR alphanumeric set: digits, upper-case letters, space and $ % * + - . / :
ALPHANUMERIC = frozenset("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")


def qr_modules(value: str) -> int:
    """Modules per side (17 + 4 x version) of the smallest version whose
    level-M capacity holds `value`: numeric when it is ASCII digits only,
    alphanumeric when every character is in the QR alphanumeric set, else
    byte mode counting UTF-8 bytes. Raises QrTooLong past version 10."""
    if set(value) <= NUMERIC:
        mode, length = 0, len(value)
    elif set(value) <= ALPHANUMERIC:
        mode, length = 1, len(value)
    else:
        mode, length = 2, len(value.encode("utf-8"))
    for version, capacity in enumerate(CAPACITY_M, start=1):
        if length <= capacity[mode]:
            return 17 + 4 * version
    raise QrTooLong(f"QR data too long for version 10 at error correction M "
                    f"({length} {('digits', 'characters', 'bytes')[mode]})")
