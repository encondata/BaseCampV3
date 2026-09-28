"""Natural ordering for text columns: `order_by(natural(Site.name))` sorts
"Rack 2" before "Rack 10" and ignores case, through the `natural` ICU
collation from migration 0082.

ORDER BY only. The collation is non-deterministic, so it must never be
used in WHERE, LIKE, DISTINCT, GROUP BY, joins or indexes — equality and
search keep the column's own collation.

Python-side sorts of display text use `natural_key`, the same rule.
"""

import re

from sqlalchemy.sql import ColumnElement

_CHUNKS = re.compile(r"(\d+)")


def natural(column: ColumnElement) -> ColumnElement:
    return column.collate("natural")


def natural_key(text: str | None) -> list[int | str]:
    """Sort key for Python-side ordering of display text, matching the
    `natural` collation: digit runs compare by value, letters case-insensitively.
    `sorted(names, key=natural_key)` puts "Rack 2" before "Rack 10".

    `re.split` with a capturing group alternates text, digits, text, ... so
    odd positions are always the digit runs and two keys never compare an
    int against a str. `None` sorts with the empty string, first."""
    return [int(t) if i % 2 else t.casefold()
            for i, t in enumerate(_CHUNKS.split(text or ""))]
