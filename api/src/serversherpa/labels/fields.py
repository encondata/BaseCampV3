"""The label builder's field catalog and the text each field prints.

`FIELD_GROUPS` is what the builder offers (GET /labels/fields), grouped as
the field panel shows them; each group lists the label types it applies to.
From-To columns are not in the catalog: any header of the uploaded From-To
row is a dynamic key `ft:<header>`.

`field_values(payload, context)` turns one kiosk sync item (an asset row
from /kiosk/sync/assets, or a container from /kiosk/sync/containers) plus
the move's `label_context` into {key: text} for every catalog key of that
row's type. The laptop edge calls it on the sync JSON; the portal calls it
on labels/generate/payloads.py's dicts, which have exactly that shape, so
both print the same text.

The ID Badge type (`id_badge`, PERSON_LABEL_TYPES) describes a person: its
only group is Person, it has no From-To row, and `person_values(payload)`
gives its text from a person payload the API builds (spec
docs/superpowers/specs/2026-10-20-badge-templates-design.md §4.2). A badge
never reaches a kiosk or a generation run.

Pure: stdlib and serversherpa.labels' own pure modules only (no
sqlalchemy, no serversherpa.db or .api), because the edge imports it
straight from api/src."""

import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Literal, TypedDict

from serversherpa.labels.label_values import UNTAGGED_LABEL, move_dates
from serversherpa.labels.tags import LABEL_TAG_LABELS


class FieldDef(TypedDict):
    key: str
    label: str
    kind: Literal["text", "number", "date"]
    mock: str


class FieldGroup(TypedDict):
    key: str
    label: str
    label_types: list[str]
    fields: list[FieldDef]


ASSET_LABEL_TYPES = ["top", "front", "rail"]
CONTAINER_LABEL_TYPES = ["container", "container_info"]
ALL_LABEL_TYPES = [*ASSET_LABEL_TYPES, *CONTAINER_LABEL_TYPES]
# Label types that describe a person (an ID badge). Built in (migration
# 0104); the portal's copy is `isPersonLabelType` in portal/src/lib/labels.ts.
PERSON_LABEL_TYPES = ["id_badge"]

FT_PREFIX = "ft:"

# Fixed sample values for the mock-data test label of a code template (or a
# v1 design): one per `label_placeholders` catalog key (asset and container
# keys alike). Raw positions are dot-separated so a template's
# position-split rules have parts to split. Moved here from
# api/routes/kiosk.py, which still serves them as its MOCK_VALUES.
PLACEHOLDER_MOCK_VALUES: dict[str, str] = {
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "make": "Dell",
    "model": "PowerEdge R740",
    "make_model": "Dell PowerEdge R740",
    "source_raw": "A1.R01.U12",
    "source_ru": "U12",
    "source_site": "Sample Site A",
    "destination_raw": "B2.R04.U12",
    "destination_ru": "U12",
    "destination_site": "Sample Site B",
    "move_name": "Sample Move",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY",
}

# One fixed sample per builder field: what the Label Station's test label
# prints. Keys shared with PLACEHOLDER_MOCK_VALUES keep its values, except
# the RUs: a builder RU is a bare number (`12`), and the `U` is a caption
# the author places.
MOCK_VALUES: dict[str, str] = {
    # Asset
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "rfid_tag": "000000000000000000100000",
    "pod_number": "P4",
    "asset_status": "Racked",
    "has_rails": "Yes",
    "location_detail": "F01 U18",
    # Make & model
    "make_model": "Dell PowerEdge R740",
    # On this move
    "source_rack": "09.01.05D.02.10",
    "source_ru": "12",
    "source_position": "Front",
    "source_pod": "P4",
    "destination_rack": "14.01.07C.02.03",
    "destination_ru": "12",
    "destination_position": "Front",
    "destination_pod": "D4",
    "priority_wave": "Wave 1",
    "disposition": "Relocate",
    "owner": "Data Services",
    "cable_data_1": "SW01/01",
    "cable_data_2": "SW01/02",
    "cable_data_3": "SW01/03",
    "cable_data_4": "SW01/04",
    "cable_data_5": "SW01/05",
    "cable_data_6": "SW01/06",
    "cable_mgmt_1": "MGMT01/01",
    "cable_mgmt_2": "MGMT01/02",
    "vendor_involved": "No",
    "roster_status": "Labeled",
    # Move
    "move_name": "Sample Move",
    "move_code": "SMPL",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    # Sites
    "origin_site_name": "Sample Site A",
    "origin_site_code": "SITE-A",
    "destination_site_name": "Sample Site B",
    "destination_site_code": "SITE-B",
    # Container
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY",
    "container_rfid_tag": "000000000000000000200000",
    "container_type": "D-container",
    "container_status": "Available",
    # Person (an ID badge): a plausible worker
    "person_name": "Jordan Rivera",
    "first_name": "Jordan",
    "last_name": "Rivera",
    "preferred_name": "Jordan",
    "person_type": "Worker",
    "company": "Rivera Electric",
    "parent_company": "Rivera Holdings",
    "job_title": "Lead Electrician",
    "roles": "Admin, Staff",
    "trade": "Electrician",
    "level": "L3 Technician",
    "worker_status": "Active",
    "employee_id": "E-10482",
    "email": "jordan.rivera@example.com",
    "phone": "(555) 010-4821",
    "person_rfid_tag": "100418",
    "badge_id": "3f2a9c1e-7b4d-4e21-9a0c-5d6e7f809a1b",
    "badge_short": "3f2a9c1e",
}

_CATALOG: tuple = (
    ("asset", "Asset", ASSET_LABEL_TYPES, (
        ("asset_id", "Asset ID", "number"),
        ("asset_name", "Asset name", "text"),
        ("serial_number", "Serial number", "text"),
        ("rfid_tag", "RFID tag", "text"),
        ("pod_number", "Pod number", "text"),
        ("asset_status", "Asset status", "text"),
        ("has_rails", "Has rails", "text"),
        ("location_detail", "Location detail", "text"),
    )),
    ("model", "Make & model", ASSET_LABEL_TYPES, (
        ("make_model", "Make + model", "text"),
    )),
    ("move_row", "On this move", ASSET_LABEL_TYPES, (
        ("source_rack", "Source rack", "text"),
        ("source_ru", "Source RU", "number"),
        ("source_position", "Source position", "text"),
        ("source_pod", "Source pod", "text"),
        ("destination_rack", "Destination rack", "text"),
        ("destination_ru", "Destination RU", "number"),
        ("destination_position", "Destination position", "text"),
        ("destination_pod", "Destination pod", "text"),
        ("priority_wave", "Priority / Wave", "text"),
        ("disposition", "Disposition", "text"),
        ("owner", "Owner", "text"),
        *((f"cable_data_{i}", f"Data {i}", "text") for i in range(1, 7)),
        ("cable_mgmt_1", "Mgmt 1", "text"),
        ("cable_mgmt_2", "Mgmt 2", "text"),
        ("vendor_involved", "Vendor involved", "text"),
        ("roster_status", "Roster status", "text"),
    )),
    ("move", "Move", ALL_LABEL_TYPES, (
        ("move_name", "Move name", "text"),
        ("move_code", "Move code", "text"),
        ("move_date", "Move date", "date"),
        ("move_date_long", "Move date (long)", "date"),
    )),
    ("sites", "Sites", ALL_LABEL_TYPES, (
        ("origin_site_name", "Origin site name", "text"),
        ("origin_site_code", "Origin site code", "text"),
        ("destination_site_name", "Destination site name", "text"),
        ("destination_site_code", "Destination site code", "text"),
    )),
    ("container", "Container", CONTAINER_LABEL_TYPES, (
        ("container_name", "Container name", "text"),
        ("container_id", "Container ID", "number"),
        ("label_tag", "Label tag", "text"),
        ("container_rfid_tag", "Container RFID tag", "text"),
        ("container_type", "Container type", "text"),
        ("container_status", "Container status", "text"),
    )),
    ("person", "Person", PERSON_LABEL_TYPES, (
        ("person_name", "Name", "text"),
        ("first_name", "First name", "text"),
        ("last_name", "Last name", "text"),
        ("preferred_name", "Preferred name", "text"),
        ("person_type", "Person type", "text"),
        ("company", "Company", "text"),
        ("parent_company", "Parent company", "text"),
        ("job_title", "Job title", "text"),
        ("roles", "Roles", "text"),
        ("trade", "Trade", "text"),
        ("level", "Level", "text"),
        ("worker_status", "Worker status", "text"),
        ("employee_id", "Employee ID", "text"),
        ("email", "Email", "text"),
        ("phone", "Phone", "text"),
        # keyed apart from the asset's `rfid_tag`
        ("person_rfid_tag", "RFID tag", "text"),
        ("badge_id", "Badge ID", "text"),
        ("badge_short", "Badge ID (short)", "text"),
    )),
)

FIELD_GROUPS: list[FieldGroup] = [
    {"key": key, "label": label, "label_types": list(types),
     "fields": [{"key": k, "label": name, "kind": kind, "mock": MOCK_VALUES[k]}
                for k, name, kind in defs]}
    for key, label, types, defs in _CATALOG
]


_PERSON_GROUPS = {g["key"] for g in FIELD_GROUPS
                  if set(g["label_types"]) <= set(PERSON_LABEL_TYPES)}


def groups_for(label_type: str | None) -> list[FieldGroup]:
    """The groups a template of `label_type` offers, in catalog order. Every
    group when None. An ID badge (PERSON_LABEL_TYPES) gets the Person group
    only. A type outside the known ones (a custom type from New template ›
    Custom…) gets every group but Person, so it can place any asset, move,
    site or container field; it still prints as an asset label
    (labels.generate's `entity_for_type`): a container field prints blank
    there. People fields only make sense on an ID badge."""
    if label_type is None:
        return list(FIELD_GROUPS)
    if label_type not in ALL_LABEL_TYPES and label_type not in PERSON_LABEL_TYPES:
        return [g for g in FIELD_GROUPS if g["key"] not in _PERSON_GROUPS]
    return [g for g in FIELD_GROUPS if label_type in g["label_types"]]


def allows_from_to(label_type: str | None) -> bool:
    """Whether a template of `label_type` can place From-To columns
    (`ft:<header>`): not a container label, which has no From-To row, and
    not an ID badge, which describes a person. The portal's twin is
    `allowsFromTo` (components/labels/builder/fieldCatalog.ts)."""
    return label_type not in CONTAINER_LABEL_TYPES and label_type not in PERSON_LABEL_TYPES


def catalog_keys(label_type: str | None) -> list[str]:
    """Every catalog key a template of `label_type` can place."""
    return [f["key"] for g in groups_for(label_type) for f in g["fields"]]


_ASSET_KEYS = catalog_keys("top")
_CONTAINER_KEYS = catalog_keys("container")
PERSON_KEYS = catalog_keys(PERSON_LABEL_TYPES[0])


def design_field_keys(design: dict | None) -> set[str]:
    """Every field key a schema 2 or 3 design's elements place (catalog keys
    and `ft:<header>` keys alike), read straight off the JSON. An image
    element places none (its picture is its `source`, never a field), and
    anything else (a schema 1 design, no design) places none either."""
    if not isinstance(design, dict):
        return set()
    schema = design.get("schema", 1)
    if not isinstance(schema, int) or isinstance(schema, bool) or schema < 2:
        return set()
    elements = design.get("elements")
    return {el["field"] for el in (elements if isinstance(elements, list) else [])
            if isinstance(el, dict) and el.get("type") != "image"
            and isinstance(el.get("field"), str) and el["field"]}


def mock_field_values(label_type: str | None, field_keys: set[str] | None = None) -> dict[str, str]:
    """The portal's mock values for a schema 2 test label, shaped like
    `field_values`: MOCK_VALUES for every catalog key of the type (as
    `groups_for`: every key but a person's for a custom type, the person
    keys alone for an ID badge), and each `ft:<header>` key in `field_keys`
    printing its header (a From-To column has no catalog sample; a container
    label or an ID badge has no From-To row, so none)."""
    out = {key: MOCK_VALUES[key] for key in catalog_keys(label_type)}
    if not allows_from_to(label_type):
        return out
    for key in sorted(field_keys or ()):
        if key.startswith(FT_PREFIX):
            out[key] = key[len(FT_PREFIX):]
    return out


def ru_text(raw) -> str:
    """An RU as the bare number it prints: `"14.0"` -> `14`, `"3.50"` ->
    `3.5`. Blank -> ''. Text that is not a number prints as it is."""
    if raw is None:
        return ""
    text = str(raw).strip()
    if not text:
        return ""
    try:
        value = Decimal(text)
    except InvalidOperation:
        return text
    if not value.is_finite():
        return text
    return format(value.normalize(), "f")


def _text(value) -> str:
    """Any sync value as label text: None -> '', a boolean -> Yes/No."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return value if isinstance(value, str) else str(value)


def _status(payload: dict, key: str) -> str:
    """A status prints its label, or its key when the label is missing."""
    return _text(payload.get(f"{key}_label") or payload.get(key))


def _day(value) -> date | None:
    """`label_context.move_day`: ISO text from the sync JSON, or a date."""
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _move_values(context: dict) -> dict[str, str]:
    move_date, move_date_long = move_dates(_day(context.get("move_day")))
    return {
        "move_name": _text(context.get("move_name")),
        "move_code": _text(context.get("move_code")),
        "move_date": move_date,
        "move_date_long": move_date_long,
        "origin_site_name": _text(context.get("source_site")),
        "origin_site_code": _text(context.get("source_site_code")),
        "destination_site_name": _text(context.get("destination_site")),
        "destination_site_code": _text(context.get("destination_site_code")),
    }


def _asset_values(p: dict) -> dict[str, str]:
    cable = p.get("cable_info")
    if not isinstance(cable, dict):
        cable = {}
    out = {
        "asset_id": _text(p.get("asset_id")),
        "asset_name": _text(p.get("name")),
        "serial_number": _text(p.get("serial_number")),
        "rfid_tag": _text(p.get("rfid")),
        "pod_number": _text(p.get("pod_number")),
        "asset_status": _status(p, "asset_status"),
        "has_rails": _text(p.get("has_rails")),
        "location_detail": _text(p.get("location_detail")),
        "make_model": _text(p.get("make_model")),
        "source_rack": _text(p.get("source_rack")),
        "source_ru": ru_text(p.get("source_ru_raw") or p.get("source_ru")),
        "source_position": _text(p.get("source_position")),
        "source_pod": _text(p.get("source_pod")),
        "destination_rack": _text(p.get("destination_rack")),
        "destination_ru": ru_text(p.get("destination_ru_raw") or p.get("destination_ru")),
        "destination_position": _text(p.get("destination_position")),
        "destination_pod": _text(p.get("destination_pod")),
        "priority_wave": _text(p.get("priority_wave")),
        "disposition": _text(p.get("disposition")),
        "owner": _text(p.get("owner")),
        "vendor_involved": _text(p.get("vendor_involved")),
        "roster_status": _status(p, "roster_status"),
    }
    # free-text cable info ({"text": ...}) has no Data/Mgmt parts to print
    for i in range(1, 7):
        out[f"cable_data_{i}"] = _text(cable.get(f"data_{i}"))
    for i in range(1, 3):
        out[f"cable_mgmt_{i}"] = _text(cable.get(f"mgmt_{i}"))
    return out


def _container_values(p: dict) -> dict[str, str]:
    tag = p.get("label_tag") or ""
    return {
        "container_name": _text(p.get("name")),
        "container_id": _text(p.get("legacy_id")),
        # the tag bar's word, as the container label prints it today
        # (labels/label_values.py container_label_values)
        "label_tag": (LABEL_TAG_LABELS.get(tag, tag) or UNTAGGED_LABEL).upper(),
        "container_rfid_tag": _text(p.get("rfid_tag")),
        "container_type": _text(p.get("container_type_label") or p.get("container_type")),
        "container_status": _status(p, "status"),
    }


def field_values(payload: dict, context: dict) -> dict[str, str]:
    """{key: text} for every catalog key of the payload's type, plus
    `ft:<header>` for each column of an asset's From-To row. `payload` is a
    kiosk sync asset item or container item (a container has no
    `asset_id`); `context` is the sync's `label_context`. Missing data is
    ''; Split, Strip and the other per-element rules are not applied here
    (the compiler applies them per placement)."""
    context = context or {}
    computed = _move_values(context)
    if "asset_id" in payload:
        computed.update(_asset_values(payload))
        out = {key: computed[key] for key in _ASSET_KEYS}
        raw_ft = payload.get("raw_ft")
        if isinstance(raw_ft, dict):
            for header, value in raw_ft.items():
                out[f"{FT_PREFIX}{header}"] = _text(value)
        return out
    computed.update(_container_values(payload))
    return {key: computed[key] for key in _CONTAINER_KEYS}


# ── people (ID badges) ───────────────────────────────────────────────

_DIGITS = re.compile(r"(\d+)")


def _natural(text: str) -> list[int | str]:
    """The natural sort key (serversherpa.db.ordering.natural_key, which
    this module can't import: it pulls in sqlalchemy)."""
    return [int(t) if i % 2 else t.casefold() for i, t in enumerate(_DIGITS.split(text))]


def _rfid_text(tag) -> str:
    """A person's RFID tag as it reads: the stored zero-padded EPC without
    its leading zeros, upper-cased (the portal's displayRfid, upper-cased);
    one digit survives an all-zero tag. Blank -> ''."""
    text = _text(tag).strip().upper()
    return (text.lstrip("0") or "0") if text else ""


def _level_text(level) -> str:
    """A worker level as it reads: its key and title, "L3 Technician"."""
    if not isinstance(level, dict):
        return ""
    return " ".join(t for t in (_text(level.get("key")).strip(),
                                _text(level.get("title")).strip()) if t)


def person_values(payload: dict) -> dict[str, str]:
    """{key: text} for every person key (PERSON_KEYS), from a person payload
    the API builds (spec 2026-10-20-badge-templates-design.md §4.2, §4.4).
    Missing data is ''; Split, Strip and the other per-element rules are
    not applied here. The payload:

    - `person`: the `people` row's fields as a dict — `id` (a UUID or its
      text), `first_name`, `last_name`, `preferred_name`, `job_title`,
      `external_id` (the employee ID), `email` (the person's, not the login
      email), `phone`, `rfid_tag` (the stored zero-padded EPC).
    - `person_type`: "Staff" (any active global-anchored role), "Worker"
      (an active worker role or a worker profile) or "" (anyone else).
    - `company`: staff, the company name from System settings › Branding;
      a worker, their partner's name; else None.
    - `parent_company`: a worker, the name of the top-most non-archived
      ancestor of their partner; else None.
    - `roles`: the labels of a staff member's active global roles, in any
      order (printed once each, naturally sorted, comma-separated); [] for
      anyone else.
    - `trade`: the worker profile's trade, or None.
    - `level`: the worker profile's level as `{"key": "L3", "title":
      "Technician"}`, or None.
    - `worker_status_label`: the worker status's label (`worker_status`, its
      key, is the fallback when the label is missing), or None.

    `badge_id` is `str(person.id)`, the full id the time clocks and the
    server scan matcher accept (a QR code); `badge_short` its first 8
    characters, the short form the time clocks accept (Code 128 or a
    printed line)."""
    person = payload.get("person")
    if not isinstance(person, dict):
        person = {}
    first = _text(person.get("first_name"))
    last = _text(person.get("last_name"))
    # a whitespace-only preferred name is none at all
    preferred = _text(person.get("preferred_name")).strip()
    # people.display_name: preferred or first, then last
    name = " ".join(t for t in (preferred or first.strip(), last.strip()) if t)
    roles = payload.get("roles")
    labels = [r.strip() for r in (roles if isinstance(roles, list) else []) if isinstance(r, str)]
    badge_id = _text(person.get("id"))
    return {
        "person_name": name,
        "first_name": first,
        "last_name": last,
        "preferred_name": preferred,
        "person_type": _text(payload.get("person_type")),
        "company": _text(payload.get("company")),
        "parent_company": _text(payload.get("parent_company")),
        "job_title": _text(person.get("job_title")),
        "roles": ", ".join(sorted(dict.fromkeys(r for r in labels if r), key=_natural)),
        "trade": _text(payload.get("trade")),
        "level": _level_text(payload.get("level")),
        "worker_status": _status(payload, "worker_status"),
        "employee_id": _text(person.get("external_id")),
        "email": _text(person.get("email")),
        "phone": _text(person.get("phone")),
        "person_rfid_tag": _rfid_text(person.get("rfid_tag")),
        "badge_id": badge_id,
        "badge_short": badge_id[:8],
    }
