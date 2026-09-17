"""Per-asset placeholder catalog — the V3 port of V2's `field_values`
dict (portal_routes.py `process_label_generation_job`), plus the
`generation_rules` position-split/length-limit port of V2's
`label_generation_code`.

V2 parity: missing/unset source data resolves to `""`, never an error.
Position-split tokens and RU formatting are the two places V2 and V3
diverge in observable output (documented inline)."""

from dataclasses import dataclass
from decimal import Decimal
from typing import NamedTuple

from serversherpa.db.models import Initiative, Site
from serversherpa.labels.tags import LABEL_TAG_LABELS
# report_timezone is no longer read by this module's own logic (move_date/
# move_date_long now read the UTC date parts directly — see stored_day) but
# kept importable so test_label_generate_values.py can monkeypatch it to
# prove that: the test patches this name to a non-UTC zone and asserts the
# result is unaffected.
from serversherpa.services.timezone import report_timezone, stored_day  # noqa: F401

CONTAINER_KEYS = ("container_name", "container_id")


class AssetRow(NamedTuple):
    """One roster row's worth of fields `placeholder_values` needs —
    built by the runner from the Asset/InitiativeAsset/AssetModel join."""

    asset_id: object                    # uuid.UUID — GeneratedLabel.entity_id
    legacy_id: int | None
    name: str | None
    serial_number: str | None
    make: str | None
    model: str | None
    source_rack: str | None
    source_ru: Decimal | None
    source_position: str | None
    destination_rack: str | None
    destination_ru: Decimal | None
    destination_position: str | None

    @property
    def entity_id(self) -> object:
        """The `generated_labels.entity_id` for this row. Named the same on
        ContainerRow so the runner never branches on row type."""
        return self.asset_id


# The word an untagged container prints in its tag bar. A design template
# cannot omit an element, so the bar would otherwise print solid black with
# nothing in it — see the 2026-09-16 design's "Empty tag" decision.
UNTAGGED_LABEL = "CONTAINER"


class ContainerRow(NamedTuple):
    """One container's worth of fields `container_placeholder_values` needs —
    built by the runner from the Container table."""

    container_uuid: object              # uuid.UUID — GeneratedLabel.entity_id
    legacy_id: int | None
    name: str | None
    label_tag: str | None

    @property
    def entity_id(self) -> object:
        return self.container_uuid


@dataclass(frozen=True)
class Sites:
    """The initiative's origin/destination Site rows (either may be
    None — an initiative need not have both, or either, set)."""

    origin: Site | None
    destination: Site | None


_MONTHS_UPPER = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                 "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _format_ru(value: Decimal | None) -> str:
    """V2 stored `source_ru`/`destination_ru` as opaque strings already
    shaped like "U14"; V3's columns are numeric, so this reproduces that
    shape: a whole number renders as `U14`, a fractional one keeps just
    enough digits (`U14.5`, not `U14.50`). None (unset) -> ""."""
    if value is None:
        return ""
    if value == value.to_integral_value():
        return f"U{int(value)}"
    text = format(value, "f").rstrip("0").rstrip(".")
    return f"U{text}"


def make_model_text(make: str, model: str) -> str:
    """"Make + model" display text, blank-safe (`""`/`""` -> `""`). Public
    so callers that need this one field without the whole catalog (e.g.
    the kiosk sync endpoint) don't have to depend on the placeholder
    catalog just to get it — see `placeholder_values`'s `make_model` key,
    computed the same way."""
    if make and model:
        return f"{make} {model}"
    return make or model


def _apply_position_rules(out: dict[str, str], rules: dict, *,
                          source_raw: str, destination_raw: str) -> None:
    """V2's `label_generation_code` position maps: split the raw
    location on "." (1-based positions) into extra named tokens. A
    position with no corresponding part is left UNSET (not "") so the
    engine's unknown-token scan can report it — V3 deliberately reports
    unresolved tokens instead of silently blanking them (see the
    generate/engine.py module docstring)."""
    for side, raw in (("source", source_raw), ("destination", destination_raw)):
        mapping = rules.get(side)
        if not isinstance(mapping, dict) or not raw:
            continue
        parts = raw.split(".")
        for pos_key, name in mapping.items():
            try:
                idx = int(pos_key) - 1
            except (TypeError, ValueError):
                continue
            if not isinstance(name, str) or not name:
                continue
            if 0 <= idx < len(parts):
                out[name] = parts[idx]


def _apply_length_limits(out: dict[str, str], rules: dict) -> None:
    limits = rules.get("length_limits")
    if not isinstance(limits, dict):
        return
    for field, max_len in limits.items():
        if field not in out or not isinstance(out[field], str):
            continue
        try:
            limit = int(max_len)
        except (TypeError, ValueError):
            continue
        if limit > 0 and len(out[field]) > limit:
            out[field] = out[field][:limit]


def _move_dates(initiative: Initiative) -> tuple[str, str]:
    """`move_date` and `move_date_long`, shared by both row kinds."""
    if initiative.scheduled_start is None:
        return "", ""
    day = stored_day(initiative.scheduled_start)
    return (day.strftime("%m/%d/%Y"),
            f"{day.day:02d}-{_MONTHS_UPPER[day.month - 1]}-{day.year}")


def placeholder_values(
    asset_row: AssetRow, initiative: Initiative, sites: Sites,
    catalog_keys: list[str], *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """Every requested catalog key, computed from the roster row +
    initiative + sites; unrecognized keys and missing data both resolve
    to `""` (V2 parity). `generation_rules` (a template's position-split
    + length-limit rules) is applied AFTER the catalog is built, adding
    its own named tokens on top — those are not filtered by
    `catalog_keys` since they are template-specific, not part of the
    fixed placeholder catalog."""
    make = asset_row.make or ""
    model = asset_row.model or ""
    source_raw = asset_row.source_position or asset_row.source_rack or ""
    destination_raw = asset_row.destination_position or asset_row.destination_rack or ""

    move_date, move_date_long = _move_dates(initiative)

    computed = {
        "asset_id": str(asset_row.legacy_id) if asset_row.legacy_id is not None else "",
        "asset_name": asset_row.name or "",
        "serial_number": asset_row.serial_number or "",
        "make": make,
        "model": model,
        "make_model": make_model_text(make, model),
        "source_raw": source_raw,
        "source_ru": _format_ru(asset_row.source_ru),
        "source_site": sites.origin.name if sites.origin else "",
        "destination_raw": destination_raw,
        "destination_ru": _format_ru(asset_row.destination_ru),
        "destination_site": sites.destination.name if sites.destination else "",
        "move_name": initiative.name or "",
        "move_date": move_date,
        "move_date_long": move_date_long,
        # an asset row never carries container fields; container_placeholder_
        # values (below) fills these for a container row instead.
        "container_name": "",
        "container_id": "",
    }
    out = {key: computed.get(key, "") for key in catalog_keys}
    if generation_rules:
        _apply_position_rules(out, generation_rules, source_raw=source_raw,
                              destination_raw=destination_raw)
        _apply_length_limits(out, generation_rules)
    return out


def container_placeholder_values(
    row: ContainerRow, initiative: Initiative, sites: Sites,
    catalog_keys: list[str], *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """The container counterpart of `placeholder_values`. Same contract:
    every requested catalog key is present, and anything this row kind has
    no value for resolves to "" rather than raising — so an asset-only key
    on a container template is blank, not an error."""
    move_date, move_date_long = _move_dates(initiative)
    tag = row.label_tag or ""
    computed = {
        "container_name": row.name or "",
        "container_id": str(row.legacy_id) if row.legacy_id is not None else "",
        "label_tag": (LABEL_TAG_LABELS.get(tag, tag) or UNTAGGED_LABEL).upper(),
        "source_site": sites.origin.name if sites.origin else "",
        "destination_site": sites.destination.name if sites.destination else "",
        "move_name": initiative.name or "",
        "move_date": move_date,
        "move_date_long": move_date_long,
    }
    out = {key: computed.get(key, "") for key in catalog_keys}
    if generation_rules:
        # Length limits only: position rules split an ASSET's source/
        # destination location string into its parts, which a container row
        # has no equivalent of, so applying them here would be meaningless.
        _apply_length_limits(out, generation_rules)
    return out


def values_for_row(
    row, initiative: Initiative, sites: Sites, catalog_keys: list[str],
    *, generation_rules: dict | None = None,
) -> dict[str, str]:
    """Dispatch a roster row to its own value builder, so the runner stays
    free of row-kind branching."""
    if isinstance(row, ContainerRow):
        return container_placeholder_values(
            row, initiative, sites, catalog_keys, generation_rules=generation_rules)
    return placeholder_values(
        row, initiative, sites, catalog_keys, generation_rules=generation_rules)
