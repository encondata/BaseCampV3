"""MacroPoint notification emails -> structured truck updates.

Two kinds of email: "Location Update" (coordinates + approximate address)
and "Trip Event Update" (Arrived/Departed at Pickup, Drop-Off or a named
stop). Input is a .eml file or text pasted from a mail client. Pasted text
may hold several emails and may run fields together with no newline
("… PTLocation: …"), so every pattern accepts fields separated by newlines
or by nothing. Pure functions; no database.

The time is the body's "Date/Time" in its zone, converted to UTC (minute
precision). The mail `Date:` header is the send time and is ignored. The
text/plain part of these emails is truncated at the first "&" in some
messages, so a .eml is read from its HTML part. Only the MacroPoint-Lite
"View All Updates" link (`OrderSetup.aspx?…Data=<token>`) carries a stable
per-load order token; newer `visibility.macropoint.com` links differ in
every message and are ignored.
"""

import email
import hashlib
import html
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from email import policy
from typing import Literal
from zoneinfo import ZoneInfo

from serversherpa.trucks.location import LocationError, parse_location

ZONES = {
    "PT": "America/Los_Angeles",
    "MT": "America/Denver",
    "CT": "America/Chicago",
    "ET": "America/New_York",
    "AKT": "America/Anchorage",
    "HT": "Pacific/Honolulu",
}

_HEADER = re.compile(r"(Location|Trip Event) Update from\s+([^\n]{1,120}?)\s*(?=-{3,}|\n|ID Number)")
# An ID ends at the Date/Time field (run-together text), at a newline
# (separate lines) or at the end of the text.
_ID = re.compile(
    r"ID Number\s*(?:'(?P<q>.{1,200}?)'|:\s*(?P<c>.{1,200}?))\s*(?=Date/Time|\n|$)", re.DOTALL)
_TIME = re.compile(
    r"Date/Time:\s*(?P<mo>\d{1,2})/(?P<d>\d{1,2})/(?P<y>\d{4})\s*@\s*"
    r"(?P<h>\d{1,2}):(?P<mi>\d{2})\s*(?P<ap>[AP]M)\s*(?P<zone>[A-Z]{1,4}?)"
    r"(?=\s|Location:|Event:|$)")
_LOCATION = re.compile(
    r"Location:\s*(?P<lat>-?\d+(?:\.\d+)?)\s*,\s*(?P<lng>-?\d+(?:\.\d+)?)")
_ADDRESS = re.compile(
    r"Approximate Address\(if available\):\s*(?P<a>.{0,500}?)\s*(?=Notes:|-{5,}|$)", re.DOTALL)
_EVENT = re.compile(r"Event:\s*(?P<e>.{1,200}?)\s*(?=\(View All Updates\)|Notes:|\n|$)")
_EVENT_PARTS = re.compile(r"^(Arrived|Departed) at (.+)$", re.IGNORECASE)
_ORDER_TOKEN = re.compile(r"OrderSetup\.aspx\?[^\"'<>\s]*?Data=([^\"'&\s<>]+)", re.IGNORECASE)
_STOPS = {"pickup": "pickup", "drop-off": "drop_off", "dropoff": "drop_off",
          "drop off": "drop_off"}

Kind = Literal["location", "trip_event"]


@dataclass(frozen=True)
class ParsedMessage:
    kind: Kind
    source: str
    carrier: str
    id_number: str
    order_token: str | None
    recorded_at: datetime
    source_ref: str
    lat: float | None = None
    lng: float | None = None
    address: str = ""
    event: str | None = None
    event_kind: str | None = None
    stop: str | None = None


@dataclass(frozen=True)
class ParseError:
    source: str
    reason: str


def _squash(value: str) -> str:
    return " ".join(value.split())


def normalize_id(value: str) -> str:
    """Comparison form of a MacroPoint ID Number or a truck's Tracker id."""
    return _squash(value).casefold()


def source_ref_for(kind: str, id_number: str, recorded_at: datetime, *,
                   lat: float | None = None, lng: float | None = None,
                   event: str | None = None) -> str:
    """Dedup key: the same update gives the same key whether it came from a
    .eml or pasted text, so the order token (absent from pasted text) is
    deliberately left out."""
    minute = recorded_at.astimezone(UTC).replace(second=0, microsecond=0).isoformat()
    payload = f"{lat:.5f},{lng:.5f}" if kind == "location" else normalize_id(event or "")
    raw = "|".join(("macropoint", kind, normalize_id(id_number), minute, payload))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def html_to_text(markup: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>", "\n", markup)
    text = re.sub(r"(?is)<(script|style|title)\b.*?</\1>", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).replace("\xa0", " ")


def _parse_time(m: re.Match) -> datetime:
    hour = int(m["h"]) % 12 + (12 if m["ap"] == "PM" else 0)
    local = datetime(int(m["y"]), int(m["mo"]), int(m["d"]), hour, int(m["mi"]),
                     tzinfo=ZoneInfo(ZONES[m["zone"]]))
    return local.astimezone(UTC)


def _parse_block(block: str, source: str,
                 order_token: str | None) -> ParsedMessage | ParseError:
    head = _HEADER.search(block)
    kind: Kind = "location" if head.group(1) == "Location" else "trip_event"
    carrier = _squash(head.group(2))
    idm = _ID.search(block)
    id_number = _squash(idm["q"] if idm["q"] is not None else idm["c"]) if idm else ""
    if not id_number:
        return ParseError(source, "missing_field:id_number")
    tm = _TIME.search(block)
    if not tm:
        return ParseError(source, "missing_field:date_time")
    if tm["zone"] not in ZONES:
        return ParseError(source, "unknown_zone")
    try:
        recorded_at = _parse_time(tm)
    except ValueError:
        return ParseError(source, "bad_time")

    if kind == "location":
        loc = _LOCATION.search(block)
        if not loc:
            return ParseError(source, "missing_field:location")
        try:
            lat, lng = parse_location(f"{loc['lat']}, {loc['lng']}")
        except LocationError:
            return ParseError(source, "bad_location")
        addr = _ADDRESS.search(block)
        return ParsedMessage(
            kind, source, carrier, id_number, order_token, recorded_at,
            source_ref_for(kind, id_number, recorded_at, lat=lat, lng=lng),
            lat=lat, lng=lng, address=_squash(addr["a"]) if addr else "")

    ev = _EVENT.search(block)
    if not ev:
        return ParseError(source, "missing_field:event")
    event = _squash(ev["e"])
    parts = _EVENT_PARTS.match(event)
    event_kind = stop = None
    if parts:
        event_kind = parts.group(1).lower()
        where = parts.group(2).strip()
        stop = _STOPS.get(where.casefold(), where)
    return ParsedMessage(
        kind, source, carrier, id_number, order_token, recorded_at,
        source_ref_for(kind, id_number, recorded_at, event=event),
        event=event, event_kind=event_kind, stop=stop)


def parse_text(text: str, source: str, *,
               order_token: str | None = None) -> list[ParsedMessage | ParseError]:
    """Every MacroPoint email in `text`. Several emails are numbered
    "<source> #1", "#2", …; text with none is one `not_macropoint` error."""
    text = text.replace("\r\n", "\n").replace("\xa0", " ")
    # Every field is squashed anyway; collapsing space/tab runs and
    # any whitespace run holding a newline (to one newline) keeps the
    # lazy-match patterns linear on huge whitespace runs.
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"[ \t]*\n\s*", "\n", text)
    starts = [m.start() for m in _HEADER.finditer(text)]
    if not starts:
        return [ParseError(source, "not_macropoint")]
    out: list[ParsedMessage | ParseError] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        name = source if len(starts) == 1 else f"{source} #{i + 1}"
        out.append(_parse_block(text[start:end], name, order_token))
    return out


def parse_eml(data: bytes, filename: str) -> list[ParsedMessage | ParseError]:
    try:
        msg = email.message_from_bytes(data, policy=policy.default)
        part = msg.get_body(preferencelist=("html", "plain"))
        if part is None:
            return [ParseError(filename, "not_macropoint")]
        content = part.get_content()
        is_html = part.get_content_type() == "text/html"
    except Exception:  # noqa: BLE001 - malformed MIME / unknown charset: one bad file never fails the batch
        return [ParseError(filename, "unreadable")]
    if is_html:
        token = _ORDER_TOKEN.search(content)
        return parse_text(html_to_text(content), filename,
                          order_token=token.group(1) if token else None)
    return parse_text(content, filename)


def parse_inputs(files: list[tuple[str, bytes]],
                 text: str) -> list[ParsedMessage | ParseError]:
    """Uploaded files in order, then the pasted text (if any)."""
    out: list[ParsedMessage | ParseError] = []
    for name, data in files:
        out += parse_eml(data, name)
    if text.strip():
        out += parse_text(text, "Pasted text")
    return out
