"""Matching keys for client group names and From-To Owner values.

A key is the value trimmed, with runs of whitespace collapsed to one space,
and lower-cased. The Python and SQL forms must agree, so a group's stored
`name_key` always equals `owner_key_sql(initiative_assets.owner)` for the
same text.

"Whitespace" is one explicit character class used by both forms: exactly
the characters Python's `str.isspace()` accepts. Postgres' `[[:space:]]`
misses some of them under the database's locale (no-break space U+00A0,
U+2007, U+202F, the \\x1c-\\x1f separators), so neither side relies on a
built-in class and the two agree by construction.
"""
import re

from sqlalchemy import ColumnElement, func, literal

# Every character str.isspace() accepts (tests/test_client_groups_schema.py
# checks the list against Python itself and against Postgres).
WHITESPACE_CHARS = (
    "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0 "
    " -     　"
)
# A run of whitespace. Postgres gets this same string as a bound parameter,
# so the characters arrive as they are, never through SQL string escapes.
WHITESPACE_RUN = f"[{WHITESPACE_CHARS}]+"
_WHITESPACE_RE = re.compile(WHITESPACE_RUN)


def group_key(value: str | None) -> str:
    """Matching key for a group name or owner value; empty for None or blank."""
    if value is None:
        return ""
    return _WHITESPACE_RE.sub(" ", value).strip(" ").lower()


def owner_key_sql(col) -> ColumnElement[str]:
    """SQL twin of `group_key`: collapse every whitespace run to one space, then
    trim. NULL stays NULL; blank gives an empty string."""
    return func.lower(func.btrim(func.regexp_replace(
        col, literal(WHITESPACE_RUN), literal(" "), literal("g"))))


def is_blank_sql(col) -> ColumnElement[bool]:
    """True when the column is NULL or only whitespace."""
    return func.coalesce(owner_key_sql(col) == "", True)
