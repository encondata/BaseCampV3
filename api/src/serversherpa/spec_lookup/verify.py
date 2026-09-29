"""Code-side checks on what Claude returned. The model is never trusted to
be right: a value survives only if its quote contains it, it is inside sane
bounds, and its source URL was really searched or fetched in that call."""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from serversherpa.spec_lookup.fields import NUMERIC, normalize_number

MOUNT_TYPES = ("rails", "ears", "shelf", "custom")
UNITS = {"ru_size": {None}, "weight": {"lbs", "kg"}, "length": {"in", "cm"},
         "width": {"in", "cm"}, "height": {"in", "cm"},
         "mount_type": {None}, "rail_type": {None}, "knowledge": {None}}
BOUNDS = {("ru_size", None): (1, 60), ("weight", "lbs"): (0.1, 3000),
          ("weight", "kg"): (0.05, 1361)}
for _dim in ("length", "width", "height"):
    BOUNDS[(_dim, "in")] = (0.5, 120)
    BOUNDS[(_dim, "cm")] = (1, 305)
MAX_TEXT = {"rail_type": 100, "knowledge": 1000}

_NUM = re.compile(r"\d+(?:[.,]\d+)*")

IN_PER_RU = 1.75
RU_SLACK_IN = 0.25
HEAVY_KG_PER_RU = 25
KG_PER_LB = 0.453592


@dataclass(frozen=True)
class Verified:
    field: str
    value: str
    unit: str | None
    quote: str
    source_url: str


def _to_float(token: str) -> float:
    if "," in token and "." in token:
        return float(token.replace(",", ""))
    if "," in token:
        head, _, tail = token.rpartition(",")
        # "1,234" is thousands; "17,5" is a decimal comma
        return float(token.replace(",", "")) if len(tail) == 3 else float(f"{head}.{tail}")
    return float(token)


def numbers_in(text: str) -> list[float]:
    out = []
    for t in _NUM.findall(text):
        try:
            out.append(_to_float(t))
        except ValueError:
            pass
    return out


def height_fits_ru(height: float, unit: str, ru: int) -> bool:
    """A cross-field plausibility check: does this height make sense for the
    unit's declared rack size? Guards against a value that survived
    verify_finding (its quote contains it) but is really some other
    dimension — e.g. a 1U server's 43.46 cm width mistaken for its height."""
    height_in = height / 2.54 if unit == "cm" else height
    lo = (ru - 1) * IN_PER_RU - RU_SLACK_IN
    hi = ru * IN_PER_RU + RU_SLACK_IN
    return lo <= height_in <= hi


def weight_is_heavy(weight: float, unit: str, ru: int | None) -> bool:
    """True when the weight-per-RU is implausibly high for typical rack gear,
    so a heavy-weight suggestion is flagged instead of trusted for
    auto-apply. Unknown ru means there's nothing to divide by, so it's never
    flagged."""
    if ru is None or ru < 1:
        return False
    kg = weight * KG_PER_LB if unit == "lbs" else weight
    return (kg / ru) > HEAVY_KG_PER_RU


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def verify_finding(field: str, value: str, unit: str | None, quote: str,
                   source_url: str, seen_urls: set[str]) -> Verified | None:
    if not all(isinstance(x, str) for x in (value, quote, source_url)):
        return None
    quote = (quote or "").strip()
    value = (value or "").strip()
    if field not in UNITS or unit not in UNITS[field] or not quote or not value:
        return None
    if normalize_url(source_url) not in seen_urls:
        return None
    if field in NUMERIC:
        try:
            x = float(value.replace(",", ""))
        except ValueError:
            return None
        lo, hi = BOUNDS[(field, unit)]
        if not lo <= x <= hi:
            return None
        if not any(abs(n - x) < 0.011 for n in numbers_in(quote)):
            return None
        return Verified(field, normalize_number(x, field), unit, quote, source_url)
    if field == "mount_type":
        v = value.lower()
        if v not in MOUNT_TYPES:
            return None
        return Verified(field, v, None, quote, source_url)
    if len(value) > MAX_TEXT[field]:
        return None
    return Verified(field, value, None, quote, source_url)
