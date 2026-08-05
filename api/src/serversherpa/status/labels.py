"""Reading a display vocabulary for a row — statuses, and the worker level scale.

Denormalising (label, color) onto every row is how sites.py has always fed the
portal's chips (sites.py:70-76) — the alternative, a second client fetch joined
in the browser, paints raw keys until it lands. This module exists because
*two* routes build WorkerItem (workers.py:list_workers and
stakeholders.py:list_partner_workers) and must not drift; stakeholders.py has no
other reason to import from workers.py.

The level half lives here for that same reason, though worker_levels is NOT a
status_values vocabulary (registry.py next door enumerates only the status
record types). It is here because the drift hazard this module exists to close
is *WorkerItem's*, and level_color is a WorkerItem display field: both routes
must denormalise it identically. A second client fetch is not an option — the
supplied-workers panel is reachable with partners:view alone, and /worker-levels
requires workers:view, which vendor_viewer does not hold (access/defaults.py:35).
"""

from sqlalchemy import select

from serversherpa.db.models import StatusValue, WorkerLevel

# Reached only if a status has no status_values row. Both sites.status and
# worker_profiles.status carry a composite FK into status_values
# (0012_status_values.py:64-69), so that is currently unreachable — this keeps
# the lookup a total function rather than a KeyError waiting on a schema change.
UNKNOWN_COLOR = "#51606f"


async def status_labels(db, record_type: str) -> dict[str, tuple[str, str]]:
    """key -> (label, color) for one record type's vocabulary.

    Deliberately does NOT filter is_active, matching sites.py:_labels. Retirement
    is is_active (there is no DELETE endpoint), so a record can legitimately sit
    on a deactivated status and must still render as itself. Filtering here would
    also make such a record uneditable — the portal resends `status` on every edit.
    """
    return {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == record_type))}


def status_fields(status: str, labels: dict[str, tuple[str, str]]) -> dict:
    """The three fields the portal's chip needs, ready to splat into a schema."""
    label, color = labels.get(status, (status, UNKNOWN_COLOR))
    return {"status": status, "status_label": label, "status_color": color}


# Matches the portal's own `?? '#8a93a6'` badge guard, and the value the
# deleted LEVEL_COLORS map used for an unmapped level. worker_profiles.level
# carries an FK into worker_levels, so an orphaned level is unreachable today —
# this keeps the lookup total rather than a KeyError awaiting a schema change.
UNKNOWN_LEVEL_COLOR = "#8a93a6"


async def level_colors(db) -> dict[str, str]:
    """level -> color for the worker level scale."""
    return {lv.level: lv.color for lv in await db.scalars(select(WorkerLevel))}


def level_fields(level: str | None, colors: dict[str, str]) -> dict:
    """The two fields the portal's level badge needs, ready to splat.

    A null level is 'unleveled', not an unknown one — it renders as a neutral
    chip with no colour at all, so level_color stays None rather than taking
    the fallback (mirroring sites.py's type_color handling of a null site_type).
    """
    return {
        "level": level,
        "level_color": (colors.get(level, UNKNOWN_LEVEL_COLOR)
                        if level is not None else None),
    }
