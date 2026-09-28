"""Natural ordering for text columns: `order_by(natural(Site.name))` sorts
"Rack 2" before "Rack 10" and ignores case, through the `natural` ICU
collation from migration 0082.

ORDER BY only. The collation is non-deterministic, so it must never be
used in WHERE, LIKE, DISTINCT, GROUP BY, joins or indexes — equality and
search keep the column's own collation.
"""

from sqlalchemy.sql import ColumnElement


def natural(column: ColumnElement) -> ColumnElement:
    return column.collate("natural")
