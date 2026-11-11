"""Matching keys for client group names and From-To Owner values.

A key is the value trimmed, with runs of whitespace collapsed to one space,
and lower-cased. The Python and SQL forms must agree, so a group's stored
`name_key` always equals `owner_key_sql(initiative_assets.owner)` for the
same text.
"""
from sqlalchemy import ColumnElement, func, literal


def group_key(value: str | None) -> str:
    """Matching key for a group name or owner value; empty for None or blank."""
    if value is None:
        return ""
    return " ".join(value.split()).lower()


def owner_key_sql(col) -> ColumnElement[str]:
    """SQL twin of `group_key`; NULL stays NULL, blank gives an empty string."""
    return func.lower(func.regexp_replace(
        func.btrim(col), literal(r"[[:space:]]+"), literal(" "), literal("g")))


def is_blank_sql(col) -> ColumnElement[bool]:
    """True when the column is NULL or only whitespace."""
    return func.coalesce(func.btrim(col) == "", True)
