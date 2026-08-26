"""Import sites (+ their locations/client/partner links) from a legacy
BaseCamp V2 pg_dump.

One-shot seeding helper behind `serversherpa import-v2-sites` — like
`assets/v2_import.py`, NOT the designed bulk-import feature. Unlike the
assets dump (pg_dump COPY blocks), the sites dump is INSERT-statement
format: `INSERT INTO <table> (<cols>) VALUES (<v1>, <v2>, ...);`, one
statement per row, so this module has its own small SQL-literal parser
instead of reusing `copy_rows`. As with the assets importer, anything that
doesn't map cleanly onto the V3 schema is left visible (appended to the
site's notes) rather than silently dropped.
"""

import json
import re
from decimal import Decimal
from typing import Iterator

_VALUES_MARKER = "VALUES ("


def parse_values_tuple(raw: str) -> list[str | int | float | None]:
    """Parse the comma-separated content between the outer `VALUES ( ... )`
    parens of one INSERT statement into typed Python values.

    Scans character-by-character (rather than a single regex) tracking
    single-quote-string state, so commas/braces/quotes inside a quoted
    string never split a field. `''` inside a string unescapes to a
    literal `'`; everything else in a string (including `"` and embedded
    newlines) is left untouched — JSON-looking string values are NOT
    decoded here, that's the mapping layer's job.
    """
    fields: list[str | int | float | None] = []
    buf: list[str] = []
    in_string = False
    quoted = False                  # did the current field come from '...'
    i, n = 0, len(raw)
    while i < n:
        ch = raw[i]
        if in_string:
            if ch == "'" and i + 1 < n and raw[i + 1] == "'":
                buf.append("'")     # '' -> literal quote, stays in the string
                i += 2
                continue
            if ch == "'":
                in_string = False   # closing quote
                i += 1
                continue
            buf.append(ch)
            i += 1
            continue
        if ch == "'":
            in_string = True
            quoted = True
            buf = []                # discard any whitespace collected before it
            i += 1
            continue
        if ch == ",":
            fields.append(_typed_field("".join(buf), quoted))
            buf, quoted = [], False
            i += 1
            continue
        if not quoted:
            buf.append(ch)          # bare literal char (digit/sign/NULL/etc.)
        i += 1                      # else: stray char after a closed quote, ignore
    fields.append(_typed_field("".join(buf), quoted))
    return fields


def _typed_field(text: str, quoted: bool) -> str | int | float | None:
    if quoted:
        return text                 # quotes already stripped, escapes resolved
    text = text.strip()
    if text == "NULL":
        return None
    if "." in text:
        return float(text)
    return int(text)


def _find_tuple_end(text: str, start: int) -> int | None:
    """Index of the `)` matching the already-open VALUES paren (depth starts
    at 1), scanning from `start`, quote-aware. None if not found yet (the
    caller should read more of the file and retry)."""
    depth = 1
    in_string = False
    i, n = start, len(text)
    while i < n:
        ch = text[i]
        if in_string:
            if ch == "'" and i + 1 < n and text[i + 1] == "'":
                i += 2
                continue
            if ch == "'":
                in_string = False
            i += 1
            continue
        if ch == "'":
            in_string = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _pop_statement(buf: str, prefix_re: re.Pattern) -> tuple[list | None, str]:
    """Try to pull one complete `INSERT INTO {table} (...) VALUES (...);`
    statement out of `buf`. Returns (parsed_row, remainder) if a complete
    statement was found, else (None, buf unchanged) — meaning the caller
    needs to append more lines before trying again (statements can span
    multiple physical lines when a quoted value contains a real newline)."""
    m = prefix_re.search(buf)
    if m is None:
        return None, buf
    values_idx = buf.find(_VALUES_MARKER, m.end())
    if values_idx == -1:
        return None, buf
    start = values_idx + len(_VALUES_MARKER)
    end = _find_tuple_end(buf, start)
    if end is None or end + 1 >= len(buf) or buf[end + 1] != ";":
        return None, buf
    row = parse_values_tuple(buf[start:end])
    return row, buf[end + 2:]


def insert_rows(dump_path: str, table: str) -> Iterator[list]:
    """Stream one table's rows out of a v2 INSERT-statement dump file.

    Matches `INSERT INTO {table} (` for the exact table name only — the
    `\\s*\\(` right after the name means a longer table sharing the prefix
    (e.g. `sites_locations` when asked for `sites`) never matches, since
    the character right after `sites` there is `_`, not whitespace/`(`.
    """
    prefix_re = re.compile(rf"INSERT INTO {re.escape(table)}\s*\(")
    with open(dump_path, encoding="utf-8", errors="replace") as fh:
        buf = ""
        for line in fh:
            buf += line
            while True:
                row, buf = _pop_statement(buf, prefix_re)
                if row is None:
                    break
                yield row


def slugify(label: str) -> str:
    """'Data Center' -> 'data_center'; 'Client Office' -> 'client_office'."""
    slug = re.sub(r"[^a-z0-9]+", "_", label.lower())
    return slug.strip("_")


def split_address(address: str | None) -> tuple[str | None, str | None, str | None]:
    """v2 stored the whole postal address as one freeform multi-line field;
    V3 wants line1/line2. `note` always carries every line of the original
    (joined with ' / ') so nothing is lost when it's reduced to two lines."""
    if address is None or not address.strip():
        return None, None, None
    lines = [line.strip() for line in address.split("\n")]
    line1 = lines[0]
    line2 = lines[1] if len(lines) > 1 else None
    note = f"V2 address (full): {' / '.join(lines)}"
    return line1, line2, note


_GPS_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$")


def parse_gps(raw: str | None) -> tuple[Decimal | None, Decimal | None, str | None]:
    """v2 stored '<lat>, <long>' as free text. Build the Decimal from the
    matched text (not a float round-trip) to avoid precision drift."""
    if raw is None or not raw.strip():
        return None, None, None
    m = _GPS_RE.match(raw)
    if m is None:
        return None, None, f"V2 GPS: {raw}"
    lat_str, lon_str = m.group(1), m.group(2)
    if abs(float(lat_str)) <= 90 and abs(float(lon_str)) <= 180:
        return Decimal(lat_str), Decimal(lon_str), None
    return None, None, f"V2 GPS: {raw}"


def _present(value: object) -> bool:
    """v2's JSON blobs use the *string* "null" as a placeholder for empty
    fields (not JSON null) — treat both, plus "", as absent."""
    if value is None or value == "":
        return False
    if isinstance(value, str) and value.lower() == "null":
        return False
    return True


def _load_json_dict(raw: str | None) -> dict:
    if raw is None:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def summarize_metadata(
    metadata_raw: str | None, survey_data_raw: str | None,
) -> tuple[str | None, str | None]:
    """v2's `metadata`/`survey_data` JSON blobs -> (dc_provider, survey_note).
    `dc_provider` gets its own V3 column; everything else present is kept
    visible in notes rather than dropped."""
    metadata = _load_json_dict(metadata_raw)
    survey = _load_json_dict(survey_data_raw)

    dc_provider = metadata.get("dc_provider")
    dc_provider = dc_provider if _present(dc_provider) else None

    parts = [f"{k}={v}" for k, v in metadata.items()
             if k != "dc_provider" and _present(v)]
    parts += [f"{k}={v}" for k, v in survey.items() if _present(v)]

    survey_note = f"V2 survey: {'; '.join(parts)}" if parts else None
    return dc_provider, survey_note


def format_locations_note(locations: list[tuple[str, str]]) -> str | None:
    """v2's `sites_locations` child rows have no V3 equivalent table (yet) —
    fold them into a notes line instead of dropping them."""
    if not locations:
        return None
    parts = [f"{name} ({description})" if description and description.strip()
             else name for name, description in locations]
    return f"V2 locations: {', '.join(parts)}"


def assemble_notes(parts: list[str | None]) -> str | None:
    cleaned = [p for p in parts if p and p.strip()]
    return "\n".join(cleaned) if cleaned else None
