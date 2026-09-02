"""Row-scope filters: which ROWS a non-global actor may touch, per resource.
Composes with (does not replace) the action matrix."""

import uuid

import sqlalchemy as sa
from sqlalchemy.sql.elements import ColumnElement

from serversherpa.access.resolver import AccessInfo
from serversherpa.db.models import (
    Asset, Client, Initiative, Partner, Person, WorkerProfile,
)

# resource -> anchor -> column carrying that anchor's id
SCOPE_COLUMNS = {
    "workers": {"partner": WorkerProfile.partner_id,
                "self": WorkerProfile.person_id},
    "clients": {"client": Client.id},
    "partners": {"partner": Partner.id},
    "users": {"self": Person.id},
    "assets": {"client": Asset.client_id},
    "initiatives": {"client": Initiative.client_id},
}


def scope_conditions(
    resource: str, access: AccessInfo, person_id: uuid.UUID,
) -> ColumnElement | None:
    """None = unrestricted. sa.false() = actor has no scope into this
    resource (require_permission should already have blocked; defensive)."""
    if access.is_global:
        return None
    cols = SCOPE_COLUMNS.get(resource, {})
    conds: list[ColumnElement] = []
    if "client" in cols and access.client_ids:
        conds.append(cols["client"].in_(access.client_ids))
    if "partner" in cols and access.partner_ids:
        conds.append(cols["partner"].in_(access.partner_ids))
    if "self" in cols and "self" in access.anchors:
        conds.append(cols["self"] == person_id)
    if not conds:
        return sa.false()
    return sa.or_(*conds)
