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
    return [_to_float(t) for t in _NUM.findall(text)]


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def verify_finding(field: str, value: str, unit: str | None, quote: str,
                   source_url: str, seen_urls: set[str]) -> Verified | None:
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
