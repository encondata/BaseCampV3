"""Reading a status vocabulary for display.

Denormalising (label, color) onto every row is how sites.py has always fed the
portal's chips (sites.py:70-76) — the alternative, a second client fetch joined
in the browser, paints raw keys until it lands. This module exists because
*two* routes build WorkerItem (workers.py:list_workers and
stakeholders.py:list_partner_workers) and must not drift; stakeholders.py has no
other reason to import from workers.py.
"""

from sqlalchemy import select

from serversherpa.db.models import StatusValue

# Reached only if a status has no status_values row. Both sites.status and
# worker_profiles.status carry a composite FK into status_values
# (0012_status_values.py:64-69), so that is currently unreachable — this keeps
# the lookup a total function rather than a KeyError waiting on a schema change.
UNKNOWN_COLOR = "c-slate"


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
