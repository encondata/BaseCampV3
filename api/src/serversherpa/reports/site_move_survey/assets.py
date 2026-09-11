"""Equipment Listing rows for the Site & Move Survey xlsx.

Builds the `asset.*` context dicts the fill engine expands one-per-row —
either one row per individual asset, or condensed to one row per (make,
model) pair with a `qty` count — exactly as V2's `_fetch_assets` did. Pure
Python: `asset_rows` never touches the DB, so Task 3/4's gather step reads
the initiative's roster (the same join the Move Report uses) and hands
this module plain rows.
"""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AssetRowInput:
    """The subset of one initiative asset roster row the fill engine
    needs. Shaped so Task 3/4 can construct one per `InitiativeAsset` +
    `Asset` + `AssetModel` join without `asset_rows` touching the ORM.

    `rack` is the source rack name (`InitiativeAsset.source_rack`);
    `ru_position` is where in that rack it sits (`InitiativeAsset.
    source_ru`) — combined into `asset.rack` in per-asset mode. `weight`
    and `ru_size` come from the asset's model (`AssetModel.weight_lbs`/
    `ru_size`); `legacy_id` is `Asset.legacy_id` (the human "Asset ID").
    """
    make: str | None
    model: str | None
    ru_size: int | None
    weight: Any = None
    rack: str | None = None
    ru_position: Any = None
    legacy_id: int | None = None
    serial: str | None = None
    name: str | None = None
    rfid: str | None = None
    location: str | None = None


def _field(row, name: str):
    """Duck-typed accessor: works for `AssetRowInput`, any object with
    matching attributes (e.g. a `MoveAsset`-shaped row), or a plain dict —
    the plan's `list[MoveAsset-like]` allows all three."""
    if isinstance(row, dict):
        return row.get(name)
    return getattr(row, name, None)


def _rack_label(row) -> str:
    """Per-asset `asset.rack`: the source rack name plus its RU position
    (e.g. `RACK-12 U20`), falling back to whichever half is present."""
    rack = _field(row, "rack")
    ru_position = _field(row, "ru_position")
    parts = []
    if rack:
        parts.append(str(rack))
    if ru_position not in (None, ""):
        parts.append(f"U{ru_position}")
    return " ".join(parts)


def _blank_value(value):
    return "" if value is None else value


def _per_asset_row(index: int, row) -> dict:
    return {
        "index": index + 1,
        "manufacturer": _field(row, "make") or "",
        "make": _field(row, "make") or "",
        "model": _field(row, "model") or "",
        "u_size": _blank_value(_field(row, "ru_size")),
        "ru_size": _blank_value(_field(row, "ru_size")),
        "weight": _blank_value(_field(row, "weight")),
        "qty": 1,
        "rack": _rack_label(row),
        "comments": "",
        "asset_id": _blank_value(_field(row, "legacy_id")),
        "serial_number": _field(row, "serial") or "",
        "name": _field(row, "name") or "",
        "rfid_tag": _field(row, "rfid") or "",
        "location": _field(row, "location") or "",
    }


def _condensed_rows(rows: list) -> list[dict]:
    groups: dict[tuple[str, str], dict] = {}
    order: list[tuple[str, str]] = []
    for row in rows:
        key = (_field(row, "make") or "", _field(row, "model") or "")
        if key not in groups:
            groups[key] = {"first": row, "qty": 0}
            order.append(key)
        groups[key]["qty"] += 1

    result = []
    for i, key in enumerate(order):
        group = groups[key]
        first = group["first"]
        result.append({
            "index": i + 1,
            "manufacturer": key[0],
            "make": key[0],
            "model": key[1],
            "u_size": _blank_value(_field(first, "ru_size")),
            "ru_size": _blank_value(_field(first, "ru_size")),
            "weight": _blank_value(_field(first, "weight")),
            "qty": group["qty"],
            "rack": "",
            "comments": "",
            "asset_id": "",
            "serial_number": "",
            "name": "",
            "rfid_tag": "",
            "location": "",
        })
    return result


def asset_rows(rows: list, *, condensed: bool) -> list[dict]:
    """`asset.*` context rows, V2's field set: index, manufacturer/make,
    model, u_size/ru_size, weight, qty, rack, comments, asset_id,
    serial_number, name, rfid_tag, location.

    Condensed (default): one row per (make, model) pair, `qty` = count of
    matching rows, `u_size`/`weight` from the first occurrence, and every
    per-asset-only field (rack, serial_number, name, rfid_tag, location,
    asset_id) left blank since a group can span racks/serials.

    Per-asset (condensed=False): one row per input row, `qty` always 1.
    """
    if not condensed:
        return [_per_asset_row(i, r) for i, r in enumerate(rows)]
    return _condensed_rows(rows)
