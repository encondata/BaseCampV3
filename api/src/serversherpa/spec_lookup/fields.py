"""Spec lookup fields ↔ asset_models columns. A "field" is what Claude is
asked for (weight, length, ...); unit-paired fields map to both columns and
count as blank only when both are empty."""

from decimal import Decimal

from serversherpa.db.models import AssetModel

GROUPS: dict[str, tuple[str, ...]] = {
    "fields_specs": ("ru_size", "weight", "length", "width", "height"),
    "fields_mounting": ("mount_type", "rail_type"),
    "fields_knowledge": ("knowledge",),
}
ALL_FIELDS: tuple[str, ...] = tuple(f for g in GROUPS.values() for f in g)

# field -> {unit: column}; unitless fields use the None key
COLUMNS: dict[str, dict[str | None, str]] = {
    "ru_size": {None: "ru_size"},
    "weight": {"lbs": "weight_lbs", "kg": "weight_kg"},
    "length": {"in": "length_in", "cm": "length_cm"},
    "width": {"in": "width_in", "cm": "width_cm"},
    "height": {"in": "height_in", "cm": "height_cm"},
    "mount_type": {None: "mount_type"},
    "rail_type": {None: "rail_type"},
    "knowledge": {None: "knowledge"},
}
NUMERIC = ("ru_size", "weight", "length", "width", "height")


def enabled_fields(cfg: dict) -> list[str]:
    return [f for key, group in GROUPS.items() if cfg.get(key) for f in group]


def _empty(v) -> bool:
    return v is None or v == ""


def is_blank(m: AssetModel, field: str) -> bool:
    return all(_empty(getattr(m, col)) for col in COLUMNS[field].values())


def wanted_fields(m: AssetModel, cfg: dict) -> list[str]:
    return [f for f in enabled_fields(cfg) if is_blank(m, f)]


def normalize_number(x: float, field: str) -> str:
    if field == "ru_size":
        return str(int(round(x)))
    return f"{round(float(x), 2):g}"


def current_value(m: AssetModel, field: str, unit: str | None) -> str | None:
    col = COLUMNS[field].get(unit) or next(iter(COLUMNS[field].values()))
    v = getattr(m, col)
    if _empty(v):
        return None
    if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
        return normalize_number(float(v), field)
    return str(v)


def column_payload(field: str, value: str | None, unit: str | None) -> dict:
    col = COLUMNS[field].get(unit) or next(iter(COLUMNS[field].values()))
    if value is None:
        return {col: "" if field == "knowledge" else None}
    if field == "ru_size":
        return {col: int(round(float(value)))}
    if field in NUMERIC:
        return {col: float(value)}
    return {col: value}


def blank_conditions(fields: list[str]) -> list:
    """One SQL clause per field: true when that field is blank."""
    from sqlalchemy import and_

    out = []
    for f in fields:
        cols = [getattr(AssetModel, c) for c in COLUMNS[f].values()]
        if f == "knowledge":
            out.append(AssetModel.knowledge == "")
        else:
            out.append(and_(*[c.is_(None) for c in cols]))
    return out
