"""Row-scope filters: which ROWS a non-global actor may touch, per resource.
Composes with (does not replace) the action matrix.

Client groups: at a client where the actor is restricted (an individual, or
a viewer with group chips; see `AccessInfo.restricted_clients`), assets and
roster rows are also filtered by their Owner group. `scope_conditions`
applies it to assets (through the asset_owner_current view: the newest
roster row per asset per client) and `roster_row_condition` to a move's
`initiative_assets` rows. Every surface uses these two helpers; none
rebuilds the rule inline.
"""

import uuid

import sqlalchemy as sa
from sqlalchemy.sql.elements import ColumnElement

from serversherpa.access.resolver import AccessInfo
from serversherpa.clientgroups.keys import is_blank_sql
from serversherpa.db.models import (
    Asset, Client, Initiative, InitiativeAsset, Partner, Person, WorkerProfile,
    asset_owner_current,
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
        restricted = access.restricted_clients() if resource == "assets" else {}
        if not restricted:
            conds.append(cols["client"].in_(access.client_ids))
        else:
            plain = sorted(access.client_ids - set(restricted))
            if plain:
                conds.append(cols["client"].in_(plain))
            for client_id, (tier, groups) in sorted(restricted.items()):
                rule = _asset_rule(client_id, tier, groups)
                if rule is not None:
                    conds.append(sa.and_(Asset.client_id == client_id, rule))
    if "partner" in cols and access.partner_ids:
        conds.append(cols["partner"].in_(access.partner_ids))
    if "self" in cols and "self" in access.anchors:
        conds.append(cols["self"] == person_id)
    if not conds:
        return sa.false()
    return sa.or_(*conds)


def _asset_rule(client_id: uuid.UUID, tier: str,
                groups: frozenset[uuid.UUID]) -> ColumnElement | None:
    """Which of client C's assets a restricted actor sees, by the asset's
    newest roster row on C's moves (an asset on none of them counts as
    blank). None means none of them (an individual without chips)."""
    v = asset_owner_current.alias("aoc")
    gids = sorted(groups)
    on_asset = sa.and_(v.c.asset_id == Asset.id, v.c.client_id == client_id)
    if tier == "viewer":
        # hidden only when the Owner is set and not one of the chip groups
        # (an unmatched Owner counts as not in G)
        return ~sa.exists().where(
            on_asset, ~is_blank_sql(v.c.owner),
            sa.or_(v.c.owner_group_id.is_(None), v.c.owner_group_id.not_in(gids)))
    if not gids:
        return None
    return sa.exists().where(on_asset, v.c.owner_group_id.in_(gids))


def roster_row_condition(access: AccessInfo) -> ColumnElement | None:
    """The `initiative_assets` rows an actor may see by Owner group. None
    when no client is restricted. Rows on moves of unrestricted clients
    always pass; on a restricted client's moves a viewer sees blank Owners
    and its chip groups, an individual only its chip groups."""
    restricted = access.restricted_clients()
    if not restricted:
        return None
    conds: list[ColumnElement] = []
    for client_id, (tier, groups) in sorted(restricted.items()):
        gids = sorted(groups)
        in_groups = InitiativeAsset.owner_group_id.in_(gids) if gids else sa.false()
        allowed = (sa.or_(is_blank_sql(InitiativeAsset.owner), in_groups)
                   if tier == "viewer" else in_groups)
        client_moves = sa.select(Initiative.id).where(Initiative.client_id == client_id)
        conds.append(sa.or_(InitiativeAsset.initiative_id.not_in(client_moves), allowed))
    return sa.and_(*conds)


def is_restricted_at(access: AccessInfo, client_id: uuid.UUID | None) -> bool:
    """True when the actor sees only some groups' rows at this client."""
    return client_id is not None and client_id in access.restricted_clients()
