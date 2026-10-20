"""The per-field value pipeline a designed label applies before it places a
value: Split → Strip → Max characters (trim) → Number padding, in that
order (spec §4.2). Alignment inside the reserved width happens later, in
the compiler.

Stdlib only: the ZPL compiler imports this on the portal and on the laptop
edge (which imports serversherpa.labels straight from api/src). The
portal's labels/fieldRules.ts is the same pipeline for the canvas; both
are pinned by labels/fixtures/field_rules.json, so change the two together.

Lengths count characters (code points), never bytes or UTF-16 units."""

from typing import Literal, TypedDict


class FieldRules(TypedDict, total=False):
    """One placement's formatting. Every key is optional; a missing key
    turns its step off, except that a Strip with no side strips the front
    and Max characters with no side trims the rear."""

    display: Literal["text", "number", "barcode", "qr"]
    expected_length: int
    max_chars: int
    trim: Literal["front", "rear"]
    strip: str
    strip_where: Literal["front", "rear", "anywhere"]


def split_value(value: str) -> list[str]:
    """Split breaks on `.` only; `""` is one empty piece."""
    return value.split(".")


def piece(value: str, index: int) -> str:
    """The 0-based piece of a split value. A value with fewer pieces than
    the sample prints the missing ones blank."""
    pieces = split_value(value)
    return pieces[index] if 0 <= index < len(pieces) else ""


def _strip(value: str, rules: FieldRules) -> str:
    strip = rules.get("strip") or ""
    if not strip:
        return value
    where = rules.get("strip_where") or "front"
    if where == "anywhere":
        return value.replace(strip, "")
    if where == "rear":
        while value.endswith(strip):
            value = value[: -len(strip)]
        return value
    while value.startswith(strip):
        value = value[len(strip):]
    return value


def _max_trim(value: str, rules: FieldRules) -> str:
    # 0 (or unset) means no limit — and value[-0:] would keep everything anyway
    max_chars = rules.get("max_chars") or 0
    if max_chars <= 0 or len(value) <= max_chars:
        return value
    if rules.get("trim") == "front":
        return value[-max_chars:]
    return value[:max_chars]


def _pad_number(value: str, rules: FieldRules) -> str:
    """Leading zeros on the integer part only (`3.5` → `03.5`); never
    truncates."""
    length = rules.get("expected_length") or 0
    if rules.get("display") != "number" or length <= 0:
        return value
    head, dot, tail = value.partition(".")
    return head.rjust(length, "0") + dot + tail


def apply_rules(value: str, rules: FieldRules) -> str:
    """Strip → Max/Trim → Number padding. Split is the caller's (`piece`)."""
    return _pad_number(_max_trim(_strip(value, rules), rules), rules)


def is_blank(value: str, rules: FieldRules) -> bool:
    """Hide-when-empty's test: blank after Strip and Max/Trim, before
    padding, so a stripped-away number is still blank."""
    return _max_trim(_strip(value, rules), rules) == ""
