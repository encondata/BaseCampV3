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
from serversherpa.services.timezone import report_timezone

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


@dataclass(frozen=True)
class Sites:
    """The initiative's origin/destination Site rows (either may be
    None — an initiative need not have both, or either, set)."""

    origin: Site | None
    destination: Site | None


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


def _make_model(make: str, model: str) -> str:
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

    move_date = ""
    if initiative.scheduled_start is not None:
        move_date = initiative.scheduled_start.astimezone(
            report_timezone()).strftime("%m/%d/%Y")

    computed = {
        "asset_id": str(asset_row.legacy_id) if asset_row.legacy_id is not None else "",
        "asset_name": asset_row.name or "",
        "serial_number": asset_row.serial_number or "",
        "make": make,
        "model": model,
        "make_model": _make_model(make, model),
        "source_raw": source_raw,
        "source_ru": _format_ru(asset_row.source_ru),
        "source_site": sites.origin.name if sites.origin else "",
        "destination_raw": destination_raw,
        "destination_ru": _format_ru(asset_row.destination_ru),
        "destination_site": sites.destination.name if sites.destination else "",
        "move_name": initiative.name or "",
        "move_date": move_date,
        # the runner handles assets only for now (spec: "Out of scope");
        # these always resolve empty for an asset row.
        "container_name": "",
        "container_id": "",
    }
    out = {key: computed.get(key, "") for key in catalog_keys}
    if generation_rules:
        _apply_position_rules(out, generation_rules, source_raw=source_raw,
                              destination_raw=destination_raw)
        _apply_length_limits(out, generation_rules)
    return out
