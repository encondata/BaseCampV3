"""QR code sizing for the v2 ZPL compiler: how many modules a value needs.

The printer encodes `^BQ` data in automatic mode (`^FDMA,`): it splits the
value into the shortest run of numeric, alphanumeric and byte segments
("SN" + "0000001"), takes the smallest version that holds them at error
correction M, then raises the level as far as that version allows (checked
module for module against Labelary, 2026-11-09). The compiler has to know
the symbol's size in modules up front so it can pick a magnification that
fills the element's box and center the symbol on it. The canvas (portal
labels/builder/qr.ts) and the kiosk port (kiosk/src/labelgen/qr.ts) mirror
this, so change them together.

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

NUMERIC = frozenset("0123456789")
# the QR alphanumeric set: digits, upper-case letters, space and $ % * + - . / :
ALPHANUMERIC = frozenset("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")


# A ^BQ symbol prints this many dots below its ^FO y: 10 at 203, 300 and
# 600 dpi and magnification 2-10, with no sideways shift (Labelary,
# 2026-11-09; the 203 dpi print matches the render). The compiler sets ^FO
# this far above the QR's box so the symbol prints where the box is; the
# canvas (portal qr.ts QR_PRINT_DROP_DOTS) draws it there.
QR_PRINT_DROP_DOTS = 10

# Data bits at error correction M for versions 1-10 (data codewords x 8).
# CAPACITY_M above is these for a value in one mode.
DATA_BITS_M: tuple[int, ...] = (128, 224, 352, 512, 688, 864, 992, 1232, 1456, 1728)

# Character count indicator bits (numeric, alphanumeric, byte): versions
# 1-9, then 10 (10-26 in the standard).
_COUNT_BITS = ((10, 9, 8), (12, 11, 16))
# the bits a numeric (0-2 digits) or alphanumeric (0-1 characters) remainder
# adds when its segment ends
_TAIL = ((0, 4, 7), (0, 6), (0,))
_GROUP = (3, 2, 1)   # characters per full group: 10, 11 or 8 x bytes bits


def _modes_for(ch: str) -> tuple[int, ...]:
    if ch in NUMERIC:
        return (0, 1, 2)
    return (1, 2) if ch in ALPHANUMERIC else (2,)


def segmented_bits(value: str, count_bits: tuple[int, int, int]) -> int:
    """The fewest data bits `value` takes split into numeric, alphanumeric
    and byte segments, each with its 4-bit mode and its count indicator
    (`count_bits` per mode): an exact dynamic program over (mode, characters
    left over in the current group)."""
    if not value:
        return 0
    inf = float("inf")
    # cost[mode][remainder]: bits so far, the open group not yet counted
    cost: list[list[float]] = [[inf] * 3, [inf] * 2, [inf]]
    first = True
    for ch in value:
        nxt: list[list[float]] = [[inf] * 3, [inf] * 2, [inf]]
        byte_bits = 8 * len(ch.encode("utf-8"))
        # the cheapest way to have closed the previous segment
        closed = 0.0 if first else min(
            c + _TAIL[m][r] for m in range(3) for r, c in enumerate(cost[m]))
        for m2 in _modes_for(ch):
            # start a new segment of m2 with this character
            start = closed + 4 + count_bits[m2]
            if m2 == 2:
                nxt[2][0] = min(nxt[2][0], start + byte_bits)
            else:
                nxt[m2][1] = min(nxt[m2][1], start)
            # or carry on the open segment of m2
            if not first:
                for r, c in enumerate(cost[m2]):
                    if c == inf:
                        continue
                    if m2 == 2:
                        nxt[2][0] = min(nxt[2][0], c + byte_bits)
                    elif r + 1 == _GROUP[m2]:
                        nxt[m2][0] = min(nxt[m2][0], c + (10 if m2 == 0 else 11))
                    else:
                        nxt[m2][r + 1] = min(nxt[m2][r + 1], c)
        cost = nxt
        first = False
    return int(min(c + _TAIL[m][r] for m in range(3) for r, c in enumerate(cost[m])))


def qr_modules(value: str) -> int:
    """Modules per side (17 + 4 x version) of the smallest version whose
    level-M data bits hold `value` split into its shortest segments
    (`segmented_bits`). Raises QrTooLong past version 10, describing the
    value in one mode: digits when it is ASCII digits only, characters when
    every one is in the QR alphanumeric set, else UTF-8 bytes."""
    short = segmented_bits(value, _COUNT_BITS[0])
    for version, data_bits in enumerate(DATA_BITS_M, start=1):
        bits = short if version < 10 else segmented_bits(value, _COUNT_BITS[1])
        if bits <= data_bits:
            return 17 + 4 * version
    if set(value) <= NUMERIC:
        mode, length = 0, len(value)
    elif set(value) <= ALPHANUMERIC:
        mode, length = 1, len(value)
    else:
        mode, length = 2, len(value.encode("utf-8"))
    raise QrTooLong(f"QR data too long for version 10 at error correction M "
                    f"({length} {('digits', 'characters', 'bytes')[mode]})")
