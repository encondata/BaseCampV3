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
from collections import defaultdict
from decimal import Decimal
from typing import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Client, Partner, Site, SiteClient, SiteType

_VALUES_MARKER = "VALUES ("

# v2 status_options id -> V3 site status key (status_values record_type
# 'site'); NULL and anything unrecognized default to "active".
_STATUS_MAP = {40: "active", 41: "decommissioned"}

# Identifies this dump for source_ref traceability; see Global Constraints.
_SOURCE = "backup_20260825_193157"


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

    `buf` holds either nothing, or exactly one in-progress target-table
    statement — never content from other tables' INSERT statements. Real
    dumps interleave many unrelated tables, and a target table's rows can
    sit far from the start of the file; lines belonging to other tables
    are skipped without ever touching `buf`, so the buffer (and therefore
    the re-scan `_pop_statement` does internally) stays bounded to the
    size of one statement instead of growing to the size of the whole
    file. That keeps this function O(n) over the file instead of O(n^2).
    """
    prefix_re = re.compile(rf"INSERT INTO {re.escape(table)}\s*\(")
    with open(dump_path, encoding="utf-8", errors="replace") as fh:
        buf = ""
        for line in fh:
            if buf:
                buf += line
            elif prefix_re.match(line):
                buf = line
            else:
                continue  # not our table's statement — never buffered, O(1) skip
            while True:
                row, buf = _pop_statement(buf, prefix_re)
                if row is None:
                    break
                yield row
            if buf and not buf.strip():
                buf = ""


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
    line2 = (lines[1] or None) if len(lines) > 1 else None
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


async def import_sites(db: AsyncSession, dump_path: str, limit: int) -> dict:
    """Import up to `limit` new sites (+ resolved SiteType/client/partner
    links) from a legacy BaseCamp V2 dump. Additive: re-runs skip rows whose
    source_ref or name already exist in V3, and reuse any SiteType created
    by an earlier run."""

    all_rows = list(insert_rows(dump_path, "sites"))
    candidate_rows = [row for row in all_rows if row[5] != "Template"]
    skipped_template = len(all_rows) - len(candidate_rows)

    existing_refs = set(await db.scalars(
        select(Site.source_ref).where(Site.source_ref.is_not(None))))
    existing_names = {n.casefold() for n in await db.scalars(select(Site.name))}

    pending: list[tuple[str, list]] = []
    pre_existing = 0
    skipped_invalid: list[str] = []
    for row in candidate_rows:
        v2_id, name = row[0], row[1]
        if name is None:
            skipped_invalid.append(f"v2 id {v2_id}: missing name")
            continue
        source_ref = f"{_SOURCE}:sites/{v2_id}"
        if source_ref in existing_refs or name.casefold() in existing_names:
            pre_existing += 1
            continue
        pending.append((source_ref, row))

    pending.sort(key=lambda item: item[1][0])
    picked = pending[:limit]

    site_type_rows = list(await db.scalars(select(SiteType)))
    site_types = {st.label.casefold(): st for st in site_type_rows}
    running_sort_order = max((st.sort_order for st in site_type_rows), default=0)

    clients_v2 = {row[0]: row[1] for row in insert_rows(dump_path, "clients")}
    clients_v3 = {c.name.casefold(): c for c in await db.scalars(select(Client))}
    partners_v2 = {row[0]: row[1] for row in insert_rows(dump_path, "partners")}
    partners_v3 = {p.name.casefold(): p for p in await db.scalars(select(Partner))}

    raw_locations: dict[int, list[tuple[int, str, str]]] = defaultdict(list)
    for loc_id, site_id, loc_name, description in insert_rows(
            dump_path, "sites_locations"):
        raw_locations[site_id].append((loc_id, loc_name, description))
    locations_by_site = {
        site_id: [(n, d) for _, n, d in sorted(entries, key=lambda e: e[0])]
        for site_id, entries in raw_locations.items()
    }

    types_created: list[str] = []
    unmatched_clients: list[str] = []
    unmatched_partners: list[str] = []
    gps_parsed = 0
    gps_unparsed = 0
    created = 0

    for source_ref, row in picked:
        (v2_id, name, address, gps_coordinates, metadata, site_type,
         site_status, client, survey_data, partner_id) = row

        if name.casefold() in existing_names:
            pre_existing += 1
            continue

        address_line1, address_line2, address_note = split_address(address)

        latitude, longitude, gps_note = parse_gps(gps_coordinates)
        if gps_coordinates is not None and gps_coordinates.strip():
            if latitude is not None:
                gps_parsed += 1
            else:
                gps_unparsed += 1

        if site_type is None:
            resolved_type = None
        else:
            resolved_type = site_types.get(site_type.casefold())
            if resolved_type is None:
                running_sort_order += 10
                resolved_type = SiteType(
                    key=slugify(site_type), label=site_type, color="#808080",
                    sort_order=running_sort_order, description="")
                db.add(resolved_type)
                await db.flush()  # Site.site_type FK needs the row to exist
                site_types[site_type.casefold()] = resolved_type
                types_created.append(site_type)

        status = _STATUS_MAP.get(site_status, "active")

        matched_client = None
        client_note = None
        if client is not None:
            client_name = clients_v2.get(client)
            if client_name is not None:
                matched_client = clients_v3.get(client_name.casefold())
                if matched_client is None:
                    client_note = f"V2 client: {client_name}"
                    if client_name not in unmatched_clients:
                        unmatched_clients.append(client_name)
            else:
                client_note = f"V2 client: id {client} (not in dump)"
                if client_note not in unmatched_clients:
                    unmatched_clients.append(client_note)

        resolved_partner_id = None
        partner_note = None
        if partner_id is not None:
            partner_name = partners_v2.get(partner_id)
            if partner_name is not None:
                matched_partner = partners_v3.get(partner_name.casefold())
                if matched_partner is not None:
                    resolved_partner_id = matched_partner.id
                else:
                    partner_note = f"V2 partner: {partner_name}"
                    if partner_name not in unmatched_partners:
                        unmatched_partners.append(partner_name)
            else:
                partner_note = f"V2 partner: id {partner_id} (not in dump)"
                if partner_note not in unmatched_partners:
                    unmatched_partners.append(partner_note)

        dc_provider, survey_note = summarize_metadata(metadata, survey_data)
        locations_note = format_locations_note(locations_by_site.get(v2_id, []))
        notes = assemble_notes([
            address_note, gps_note, survey_note, locations_note,
            client_note, partner_note,
        ])

        site = Site(
            name=name,
            site_type=resolved_type.key if resolved_type is not None else None,
            status=status,
            address_line1=address_line1, address_line2=address_line2,
            latitude=latitude, longitude=longitude,
            dc_provider=dc_provider, partner_id=resolved_partner_id,
            notes=notes, source="v2_import", source_ref=source_ref,
        )
        db.add(site)
        await db.flush()
        existing_names.add(name.casefold())

        if matched_client is not None:
            db.add(SiteClient(site_id=site.id, client_id=matched_client.id))

        created += 1

    return {
        "created": created,
        "skipped_template": skipped_template,
        "pre_existing": pre_existing,
        "types_created": types_created,
        "unmatched_clients": unmatched_clients,
        "unmatched_partners": unmatched_partners,
        "gps_parsed": gps_parsed,
        "gps_unparsed": gps_unparsed,
        "skipped_invalid": skipped_invalid,
    }
