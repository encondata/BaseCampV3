"""The placeholder catalog for one label, from plain inputs — the pure core
of labels/generate/values.py, shared by the portal generator and the laptop
edge (which imports it straight from api/src).

Stdlib and serversherpa.labels.tags only: no serversherpa.db, no
sqlalchemy, no serversherpa.services. The caller turns the move's
scheduled_start into a `date` (the portal uses services.timezone's
`stored_day`), so this module never reads a timezone.

V2 parity: missing/unset source data resolves to `""`, never an error.
Position-split tokens and RU formatting are the two places V2 and V3
diverge in observable output (documented inline)."""

from datetime import date
from decimal import Decimal
from typing import NamedTuple

from serversherpa.labels.tags import LABEL_TAG_LABELS

# The word an untagged container prints in its tag bar. A design template
# cannot omit an element, so the bar would otherwise print solid black with
# nothing in it — see the 2026-09-16 design's "Empty tag" decision.
UNTAGGED_LABEL = "CONTAINER"

_MONTHS_UPPER = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                 "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


class LabelAsset(NamedTuple):
    """The asset fields a label can print."""

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


class LabelMove(NamedTuple):
    """The move fields a label can print. `day` is the move's scheduled
    day, already resolved from its stored timestamp (None when unscheduled)."""

    name: str | None
    day: date | None
    source_site: str | None
    destination_site: str | None


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
    catalog just to get it — see `asset_label_values`'s `make_model` key,
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
    labels/render.py module docstring)."""
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


def move_dates(day: date | None) -> tuple[str, str]:
    """`move_date` and `move_date_long`, shared by both row kinds."""
    if day is None:
        return "", ""
    return (day.strftime("%m/%d/%Y"),
            f"{day.day:02d}-{_MONTHS_UPPER[day.month - 1]}-{day.year}")


def asset_label_values(
    asset: LabelAsset, move: LabelMove, catalog_keys: list[str], *,
    generation_rules: dict | None = None,
) -> dict[str, str]:
    """Every requested catalog key, computed from the asset + move;
    unrecognized keys and missing data both resolve to `""` (V2 parity).
    `generation_rules` (a template's position-split + length-limit rules)
    is applied AFTER the catalog is built, adding its own named tokens on
    top — those are not filtered by `catalog_keys` since they are
    template-specific, not part of the fixed placeholder catalog."""
    make = asset.make or ""
    model = asset.model or ""
    source_raw = asset.source_position or asset.source_rack or ""
    destination_raw = asset.destination_position or asset.destination_rack or ""

    move_date, move_date_long = move_dates(move.day)

    computed = {
        "asset_id": str(asset.legacy_id) if asset.legacy_id is not None else "",
        "asset_name": asset.name or "",
        "serial_number": asset.serial_number or "",
        "make": make,
        "model": model,
        "make_model": make_model_text(make, model),
        "source_raw": source_raw,
        "source_ru": _format_ru(asset.source_ru),
        "source_site": move.source_site or "",
        "destination_raw": destination_raw,
        "destination_ru": _format_ru(asset.destination_ru),
        "destination_site": move.destination_site or "",
        "move_name": move.name or "",
        "move_date": move_date,
        "move_date_long": move_date_long,
        # an asset row never carries container fields; container_label_values
        # (below) fills these for a container instead.
        "container_name": "",
        "container_id": "",
    }
    out = {key: computed.get(key, "") for key in catalog_keys}
    if generation_rules:
        _apply_position_rules(out, generation_rules, source_raw=source_raw,
                              destination_raw=destination_raw)
        _apply_length_limits(out, generation_rules)
    return out


def container_label_values(
    *, legacy_id: int | None, name: str | None, label_tag: str | None,
    move: LabelMove, catalog_keys: list[str], generation_rules: dict | None = None,
) -> dict[str, str]:
    """The container counterpart of `asset_label_values`. Same contract:
    every requested catalog key is present, and anything a container has
    no value for resolves to "" rather than raising — so an asset-only key
    on a container template is blank, not an error."""
    move_date, move_date_long = move_dates(move.day)
    tag = label_tag or ""
    computed = {
        "container_name": name or "",
        "container_id": str(legacy_id) if legacy_id is not None else "",
        "label_tag": (LABEL_TAG_LABELS.get(tag, tag) or UNTAGGED_LABEL).upper(),
        "source_site": move.source_site or "",
        "destination_site": move.destination_site or "",
        "move_name": move.name or "",
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
