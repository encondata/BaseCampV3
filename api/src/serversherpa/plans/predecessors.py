"""Predecessor text for project plans: `3`, `3FS+2d`, `5SS`, `7FF-4h`, `2,3SS`.

This is the MS Project "Predecessors" cell: a comma-separated list of
`ID[type][lag]` entries, the ID being the predecessor's display number in the
plan. Pure parsing and formatting, no I/O. The portal's editor ports these
rules and both sides are held to the same vectors file
(api/tests/fixtures/plans/predecessors.json), so a change here is a change
there.

The type is FS, SS, FF or SF (default FS) and the lag is a signed duration
(`+2d`, `-4h`, a lead is negative) read by `durations.parse_lag`. Only ASCII
whitespace is trimmed or allowed, and the trimmed text is at most
MAX_TEXT_LENGTH characters (the lag inside it keeps the duration limits).
"""

import re
from collections.abc import Container, Iterable
from dataclasses import dataclass

from serversherpa.plans.durations import (
    Duration,
    DurationError,
    Units,
    format_lag,
    parse_lag,
)
from serversherpa.plans.engine import LINK_TYPES

# Input limit, shared with the portal parser through the vectors file: the
# text is trimmed of ASCII whitespace first, then must fit.
_ASCII_WHITESPACE = " \t\n\r\f\v"
MAX_TEXT_LENGTH = 512

_ZERO_LAG = Duration(0, "d", False)

# The ID and the optional type, matched at the start of an already-trimmed
# entry; what follows is the lag. ASCII-only on purpose: without re.ASCII,
# IGNORECASE lets U+017F (long s) match "s", \d match other scripts' digits
# and \s match a no-break space. One optional group after the digits, so
# there is nothing to backtrack through.
_HEAD = re.compile(
    r"(\d+)(?:\s*(" + "|".join(LINK_TYPES) + r"))?",
    re.IGNORECASE | re.ASCII,
)


class PredecessorError(ValueError):
    """The text is not a valid list of predecessors for this task. `detail`
    names the offending entry; it never echoes unbounded input."""

    code = "bad_predecessor"

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class PredSpec:
    display_id: int
    link_type: str     # FS SS FF SF
    lag: Duration      # negative minutes is a lead


def _clip(text: str, limit: int = 40) -> str:
    return text if len(text) <= limit else text[:limit] + "..."


def _quoted(text: str) -> str:
    return repr(_clip(text))


def _parse_entry(part: str, units: Units) -> tuple[str, str, Duration]:
    """One trimmed, non-empty entry to (digits, link type, lag)."""
    head = _HEAD.match(part)
    if head is None:
        raise PredecessorError(
            f"{_quoted(part)} is not a predecessor: start with a task number, "
            "then an optional link type (FS, SS, FF, SF) and lag, like 3FS+2d"
        )
    digits, link_type = head.group(1), head.group(2)
    rest = part[head.end():].strip(_ASCII_WHITESPACE)
    if not rest:
        lag = _ZERO_LAG
    elif rest[0] not in "+-":
        raise PredecessorError(
            f"{_quoted(part)} is not a predecessor: a lag starts with + or -, like 3FS+2d"
        )
    else:
        try:
            lag = parse_lag(rest, units)
        except DurationError as exc:
            raise PredecessorError(f"{_quoted(part)} has a bad lag: {exc}") from exc
    return digits, (link_type or "FS").upper(), lag


def parse_predecessors(
    text: str,
    units: Units,
    *,
    valid_ids: Container[int],
    self_id: int | None,
) -> list[PredSpec]:
    """`3`, `3FS+2d`, `5SS`, `2,3SS` to one PredSpec per entry, in the order
    written; empty or blank text is no links. Every ID must be in `valid_ids`,
    may not be `self_id` (a task cannot precede itself) and may appear once.
    Raises PredecessorError otherwise."""
    if not isinstance(text, str):
        raise PredecessorError(f"predecessors must be text, not <{type(text).__name__}>")
    trimmed = text.strip(_ASCII_WHITESPACE)
    if len(trimmed) > MAX_TEXT_LENGTH:
        raise PredecessorError(f"predecessors are longer than {MAX_TEXT_LENGTH} characters")
    if not trimmed:
        return []
    specs: list[PredSpec] = []
    seen: set[int] = set()
    for raw in trimmed.split(","):
        part = raw.strip(_ASCII_WHITESPACE)
        if not part:
            raise PredecessorError("empty entry: check for a stray comma")
        digits, link_type, lag = _parse_entry(part, units)
        display_id = int(digits)
        shown = _clip(str(display_id), 12)
        if display_id == self_id:
            raise PredecessorError(f"task {shown} cannot depend on itself")
        if display_id not in valid_ids:
            raise PredecessorError(f"task {shown} does not exist in this plan")
        if display_id in seen:
            raise PredecessorError(f"task {shown} is listed more than once")
        seen.add(display_id)
        specs.append(PredSpec(display_id, link_type, lag))
    return specs


def _format_entry(spec: PredSpec, units: Units) -> str:
    if spec.link_type not in LINK_TYPES:
        raise ValueError(f"unknown link type {spec.link_type!r}")
    lag = ""
    if spec.lag.minutes != 0:
        lag = format_lag(spec.lag, units)
        if lag[0] not in "+-":
            # a lag too small to show at two decimals prints as "0 days":
            # keep its sign so the text still parses
            lag = ("-" if spec.lag.minutes < 0 else "+") + lag
    link_type = spec.link_type if lag or spec.link_type != "FS" else ""
    return f"{spec.display_id}{link_type}{lag}"


def format_predecessors(specs: Iterable[PredSpec], units: Units) -> str:
    """`3`, `3FS+2 days`, `5SS`, `7FF-4 hrs`, `2,3SS`: the shortest text that
    parses back to the same links. A zero lag is left out (its unit is not
    kept) and so is an FS type with no lag."""
    return ",".join(_format_entry(spec, units) for spec in specs)
