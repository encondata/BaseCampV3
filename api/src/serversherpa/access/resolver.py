"""Effective-permission resolution. Precedence per resource x action:
hard gates (developer_only, anchor visibility) -> override -> group gate
-> role union; always_viewable floors view=true AFTER overrides/gates but
NEVER past a hard gate."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK, TOP_RANK
from serversherpa.access.resources import ACTIONS, REGISTRY
from serversherpa.db.models import (
    AccessGroupMember, ClientContactGroup, PermissionOverride, PersonRole,
    ResourceGroupGate, Role, RolePermission,
)


def can_touch_rank(actor_rank: int, target_rank: int) -> bool:
    """Strictly-below management; top rank may also manage peers."""
    return actor_rank >= TOP_RANK or target_rank < actor_rank


RoleGrants = dict[str, set[tuple[str, str]]]


async def role_grants(db: AsyncSession, role_names: set[str],
                      override: RoleGrants | None = None) -> dict[str, set[str]]:
    """resource -> granted actions for the union of `role_names`. A role
    named in `override` contributes exactly those (resource, action) pairs
    instead of its role_permissions rows — the matrix-preview hook."""
    granted: dict[str, set[str]] = {}
    override = override or {}
    from_table = {r for r in role_names if r not in override}
    if from_table:
        for res, action in (await db.execute(
            select(RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(from_table)))).all():
            granted.setdefault(res, set()).add(action)
    for name in role_names & set(override):
        for res, action in override[name]:
            granted.setdefault(res, set()).add(action)
    return granted


@dataclass
class AccessInfo:
    perms: dict[str, dict[str, bool]] = field(default_factory=dict)
    max_rank: int = 0
    role_names: list[str] = field(default_factory=list)
    anchors: set[str] = field(default_factory=set)
    client_ids: set[uuid.UUID] = field(default_factory=set)
    partner_ids: set[uuid.UUID] = field(default_factory=set)
    is_global: bool = False
    # client_id -> tier key at that client ("owner", "admin", "viewer" or
    # "individual"), the highest-ranked client_* role when there are two
    client_tiers: dict[uuid.UUID, str] = field(default_factory=dict)
    # client_id -> the client groups this person is limited to there (chips)
    client_group_ids: dict[uuid.UUID, frozenset[uuid.UUID]] = field(default_factory=dict)

    def can(self, resource: str, action: str) -> bool:
        return self.perms.get(resource, {}).get(action, False)

    def restricted_clients(self) -> dict[
            uuid.UUID, tuple[Literal["viewer", "individual"], frozenset[uuid.UUID]]]:
        """The clients where this person sees only some groups' assets: every
        client where they are an individual, and every client where they are
        a viewer with at least one chip. Empty for global actors; owners,
        admins and unchipped viewers are never restricted."""
        if self.is_global:
            return {}
        out: dict[uuid.UUID, tuple[Literal["viewer", "individual"],
                                   frozenset[uuid.UUID]]] = {}
        for client_id, tier in self.client_tiers.items():
            groups = self.client_group_ids.get(client_id, frozenset())
            if tier == "individual":
                out[client_id] = ("individual", groups)
            elif tier == "viewer" and groups:
                out[client_id] = ("viewer", groups)
        return out


def _assemble(grants, granted: dict[str, set[str]],
              overrides: dict[str, dict[str, bool]],
              gated_resources: set[str], member_ok: set[str],
              chips: dict[uuid.UUID, frozenset[uuid.UUID]] | None = None) -> AccessInfo:
    """One person's AccessInfo from their loaded rows: `grants` are their
    (role, client_id, partner_id, rank, scope_anchor) rows, `granted` the
    union of their roles' grants, `overrides` their permission overrides,
    `gated_resources` every group-gated resource and `member_ok` the gated
    resources one of their groups opens and `chips` their client group
    chips per client. Shared by `resolve_access` and `resolve_access_many`,
    so the two can't disagree."""
    info = AccessInfo(client_group_ids=dict(chips or {}))
    tier_rank: dict[uuid.UUID, int] = {}
    for role, client_id, partner_id, rank, anchor in grants:
        info.role_names.append(role)
        info.max_rank = max(info.max_rank, rank)
        info.anchors.add(anchor)
        if anchor == "client" and client_id:
            info.client_ids.add(client_id)
            if role.startswith("client_") and rank > tier_rank.get(client_id, -1):
                tier_rank[client_id] = rank
                info.client_tiers[client_id] = role.removeprefix("client_")
        elif anchor == "partner" and partner_id:
            info.partner_ids.add(partner_id)
    info.role_names = sorted(set(info.role_names))
    info.is_global = "global" in info.anchors
    role_set = set(info.role_names)

    for res_id, res in REGISTRY.items():
        cell = {a: False for a in ACTIONS}
        hard_blocked = (
            (res.developer_only and "developer" not in role_set)
            or not (res.visible_to & info.anchors)
        )
        if not hard_blocked:
            gate_blocks = (res_id in gated_resources
                           and res_id not in member_ok
                           and info.max_rank < GATE_BYPASS_RANK)
            for action in ACTIONS:
                ov = overrides.get(res_id, {}).get(action)
                if ov is not None:
                    cell[action] = ov
                elif gate_blocks:
                    cell[action] = False
                else:
                    cell[action] = action in granted.get(res_id, set())
            if res.always_viewable:
                cell["view"] = True
        info.perms[res_id] = cell
    return info


def _grants_query():
    return (select(PersonRole.person_id, PersonRole.role, PersonRole.client_id,
                   PersonRole.partner_id, Role.rank, Role.scope_anchor)
            .join(Role, Role.name == PersonRole.role)
            .where(PersonRole.revoked_at.is_(None)))


def _chips_query():
    return select(ClientContactGroup.person_id, ClientContactGroup.client_id,
                  ClientContactGroup.group_id)


def _collect_chips(rows) -> dict[uuid.UUID, dict[uuid.UUID, frozenset[uuid.UUID]]]:
    """person_id -> client_id -> chip group ids, from `_chips_query` rows."""
    acc: dict[uuid.UUID, dict[uuid.UUID, set[uuid.UUID]]] = {}
    for pid, client_id, group_id in rows:
        acc.setdefault(pid, {}).setdefault(client_id, set()).add(group_id)
    return {pid: {cid: frozenset(g) for cid, g in by_client.items()}
            for pid, by_client in acc.items()}


async def resolve_access(db: AsyncSession, person_id: uuid.UUID, *,
                         role_grants_override: RoleGrants | None = None) -> AccessInfo:
    grants = [tuple(row[1:]) for row in (await db.execute(
        _grants_query().where(PersonRole.person_id == person_id))).all()]
    role_set = {row[0] for row in grants}
    granted = await role_grants(db, role_set, role_grants_override)

    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
        select(PermissionOverride.resource, PermissionOverride.action,
               PermissionOverride.allow)
        .where(PermissionOverride.person_id == person_id)
    )).all():
        overrides.setdefault(res, {})[action] = allow

    gated_resources: set[str] = set()
    member_ok: set[str] = set()
    gates = (await db.execute(select(ResourceGroupGate.resource,
                                     ResourceGroupGate.group_id))).all()
    if gates:
        gated_resources = {res for res, _ in gates}
        my_groups = set(await db.scalars(
            select(AccessGroupMember.group_id)
            .where(AccessGroupMember.person_id == person_id)))
        member_ok = {res for res, gid in gates if gid in my_groups}

    chips: dict[uuid.UUID, frozenset[uuid.UUID]] = {}
    if any(row[4] == "client" for row in grants):
        chips = _collect_chips((await db.execute(
            _chips_query().where(ClientContactGroup.person_id == person_id))).all()
        ).get(person_id, {})

    return _assemble(grants, granted, overrides, gated_resources, member_ok, chips)


async def resolve_access_many(db: AsyncSession,
                              person_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, AccessInfo]:
    """`resolve_access` for many people at once — the same result for each,
    in a fixed number of queries (at most six) however many there are.
    For fan-outs that check many people's access in one request."""
    ids = list(dict.fromkeys(person_ids))
    if not ids:
        return {}
    grants: dict[uuid.UUID, list[tuple]] = {pid: [] for pid in ids}
    for pid, *row in (await db.execute(
            _grants_query().where(PersonRole.person_id.in_(ids)))).all():
        grants[pid].append(tuple(row))

    all_roles = {row[0] for rows in grants.values() for row in rows}
    by_role: dict[str, set[tuple[str, str]]] = {}
    if all_roles:
        for role, res, action in (await db.execute(
            select(RolePermission.role, RolePermission.resource, RolePermission.action)
            .where(RolePermission.role.in_(all_roles)))).all():
            by_role.setdefault(role, set()).add((res, action))

    overrides: dict[uuid.UUID, dict[str, dict[str, bool]]] = {pid: {} for pid in ids}
    for pid, res, action, allow in (await db.execute(
        select(PermissionOverride.person_id, PermissionOverride.resource,
               PermissionOverride.action, PermissionOverride.allow)
        .where(PermissionOverride.person_id.in_(ids))
    )).all():
        overrides[pid].setdefault(res, {})[action] = allow

    gated_resources: set[str] = set()
    groups: dict[uuid.UUID, set[uuid.UUID]] = {pid: set() for pid in ids}
    gates = (await db.execute(select(ResourceGroupGate.resource,
                                     ResourceGroupGate.group_id))).all()
    if gates:
        gated_resources = {res for res, _ in gates}
        for pid, gid in (await db.execute(
            select(AccessGroupMember.person_id, AccessGroupMember.group_id)
            .where(AccessGroupMember.person_id.in_(ids)))).all():
            groups[pid].add(gid)

    chips: dict[uuid.UUID, dict[uuid.UUID, frozenset[uuid.UUID]]] = {}
    client_pids = [pid for pid in ids if any(row[4] == "client" for row in grants[pid])]
    if client_pids:
        chips = _collect_chips((await db.execute(
            _chips_query().where(ClientContactGroup.person_id.in_(client_pids)))).all())

    out: dict[uuid.UUID, AccessInfo] = {}
    for pid in ids:
        granted: dict[str, set[str]] = {}
        for role in {row[0] for row in grants[pid]}:
            for res, action in by_role.get(role, ()):
                granted.setdefault(res, set()).add(action)
        member_ok = {res for res, gid in gates if gid in groups[pid]}
        out[pid] = _assemble(grants[pid], granted, overrides[pid],
                             gated_resources, member_ok, chips.get(pid, {}))
    return out
