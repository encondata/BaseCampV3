"""Wiki permissions: who can see or change a space or node.

Levels are `view < edit < manage`. A user's effective level on a node
(spec §3):

1. A wiki administrator (`wiki:delete`) manages everything; a user
   without `wiki:view` gets nothing.
2. Start from the space-level grants, then walk the node's ancestors
   (root first) and finally the node itself. A node that breaks
   inheritance *replaces* the set with its own grants; any other node
   *adds* its grants to the set. Space-level `manage` grants are always
   added back after a replace, so a space manager can't be locked out.
3. The level is the highest level among the final set's grants that
   match the user.
4. An archived space is read-only (anything above view becomes view)
   for everyone but wiki administrators.

`AccessIndex` is the per-request cache every wiki endpoint goes through:
it loads each space's grants and inheritance breaks once, then computes
levels in Python with memoization, so filtering a listing of many nodes
costs a fixed number of queries per space rather than per node.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import resolve_access, resolve_access_many
from serversherpa.db.models import (
    AccessGroup,
    AccessGroupMember,
    Client,
    Partner,
    Person,
    Role,
    WikiGrant,
    WikiNode,
    WikiPage,
    WikiSpace,
)

if TYPE_CHECKING:
    from serversherpa.access.resolver import AccessInfo
    from serversherpa.api.deps import AuthContext

LEVELS = ("view", "edit", "manage")
_RANK = {level: i + 1 for i, level in enumerate(LEVELS)}

# principal types whose principal_id is a uuid, and the set on Principal
# it has to be in
_UUID_PRINCIPALS = ("access_group", "person", "client", "partner")


def level_rank(level: str | None) -> int:
    """None → 0, view → 1, edit → 2, manage → 3 (unknown strings → 0)."""
    return _RANK.get(level, 0) if level else 0


def max_level(a: str | None, b: str | None) -> str | None:
    return a if level_rank(a) >= level_rank(b) else b


@dataclass(frozen=True)
class Principal:
    """Who the user IS, for matching grants."""
    person_id: uuid.UUID
    roles: frozenset[str]
    group_ids: frozenset[uuid.UUID]
    client_ids: frozenset[uuid.UUID]
    partner_ids: frozenset[uuid.UUID]
    is_internal: bool       # AccessInfo.is_global
    is_admin: bool          # wiki:delete — the wiki administrator
    can_view_wiki: bool     # wiki:view


async def principal_for(db: AsyncSession, user: AuthContext) -> Principal:
    """Build the caller's Principal: the auth context plus one query for
    their access-group memberships."""
    return await principal_from_access(db, user.person.id, user.access)


async def principal_from_access(db: AsyncSession, person_id: uuid.UUID,
                                access: AccessInfo) -> Principal:
    """A person's Principal from their resolved access (`resolve_access`)
    — for callers acting for someone without their token (the collab
    server's re-authorization)."""
    group_ids = (await db.scalars(
        select(AccessGroupMember.group_id)
        .where(AccessGroupMember.person_id == person_id)
    )).all()
    return _principal(person_id, access, group_ids)


async def principal_for_person(db: AsyncSession, person_id: uuid.UUID) -> Principal:
    """A person's Principal by id alone — `resolve_access` then
    `principal_from_access` — for acting on someone's behalf without
    their token (the collab server's re-check, notification fan-out).
    Checks nothing about their account: callers decide whether a
    disabled or archived person counts."""
    return await principal_from_access(db, person_id, await resolve_access(db, person_id))


def _principal(person_id: uuid.UUID, access: AccessInfo,
               group_ids: Iterable[uuid.UUID]) -> Principal:
    return Principal(
        person_id=person_id,
        roles=frozenset(access.role_names),
        group_ids=frozenset(group_ids),
        client_ids=frozenset(access.client_ids),
        partner_ids=frozenset(access.partner_ids),
        is_internal=access.is_global,
        is_admin=access.can("wiki", "delete"),
        can_view_wiki=access.can("wiki", "view"),
    )


async def principals_for_people(db: AsyncSession,
                                person_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Principal]:
    """`principal_for_person` for many people in a fixed number of queries
    (`resolve_access_many` plus one for group memberships) — for fan-outs
    that check many people against one node. Like `principal_for_person`,
    checks nothing about their accounts."""
    ids = list(dict.fromkeys(person_ids))
    if not ids:
        return {}
    access = await resolve_access_many(db, ids)
    groups: dict[uuid.UUID, set[uuid.UUID]] = {pid: set() for pid in ids}
    for pid, gid in (await db.execute(
        select(AccessGroupMember.person_id, AccessGroupMember.group_id)
        .where(AccessGroupMember.person_id.in_(ids)))).all():
        groups[pid].add(gid)
    return {pid: _principal(pid, access[pid], groups[pid]) for pid in ids}


def _as_uuid(value: str | uuid.UUID | None) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def grant_matches(p: Principal, principal_type: str, principal_id: str | None) -> bool:
    """Does a grant to (principal_type, principal_id) cover this user? A
    malformed or missing id never matches (and never raises)."""
    if principal_type == "everyone":
        return True
    if principal_type == "internal":
        return p.is_internal
    if principal_type == "role":
        return principal_id is not None and principal_id in p.roles
    if principal_type not in _UUID_PRINCIPALS:
        return False
    pid = _as_uuid(principal_id)
    if pid is None:
        return False
    if principal_type == "person":
        return pid == p.person_id
    if principal_type == "access_group":
        return pid in p.group_ids
    if principal_type == "client":
        return pid in p.client_ids
    return pid in p.partner_ids   # partner


@dataclass(frozen=True)
class _Grant:
    """A wiki_grants row, detached from the session."""
    node_id: uuid.UUID | None
    principal_type: str
    principal_id: str | None
    level: str


@dataclass(frozen=True)
class EffectiveGrantRow:
    """One grant in a node's (or space's) final effective set, with where
    it came from: the space, or the node that contributed it."""
    principal_type: str
    principal_id: str | None
    level: str
    principal_label: str
    source_kind: str                    # 'space' | 'node'
    source_node_id: uuid.UUID | None
    source_title: str | None            # the space name, or the node title


@dataclass
class _SpaceData:
    name: str | None
    archived: bool
    space_grants: list[_Grant]                      # node_id NULL
    node_grants: dict[uuid.UUID, list[_Grant]]
    breaks: frozenset[uuid.UUID]                    # inherit_permissions = false


class AccessIndex:
    """Per-request cache. Loads grants + the inheritance-relevant node rows
    for the spaces it is asked about, computes levels in Python with
    memoization.

    `spaces` lets several indexes (one per person, in a notification
    fan-out) share what they load: pass the same dict to each and a
    space's grants are read once between them. Only share it within one
    request/transaction — it is a snapshot."""

    def __init__(self, db: AsyncSession, principal: Principal, *,
                 spaces: dict[uuid.UUID, _SpaceData] | None = None):
        self.db = db
        self.p = principal
        self._spaces: dict[uuid.UUID, _SpaceData] = spaces if spaces is not None else {}
        self._memo: dict[tuple[uuid.UUID, tuple[uuid.UUID, ...]], str | None] = {}

    # ── loading ─────────────────────────────────────────────────────

    async def _load_spaces(self, space_ids: Iterable[uuid.UUID]) -> None:
        """Three queries for any number of not-yet-loaded spaces: the space
        rows, their grants, and their inheritance-breaking node ids."""
        missing = {sid for sid in space_ids if sid not in self._spaces}
        if not missing:
            return
        rows = (await self.db.execute(
            select(WikiSpace.id, WikiSpace.name, WikiSpace.archived_at)
            .where(WikiSpace.id.in_(missing))
        )).all()
        spaces = {sid: _SpaceData(None, False, [], {}, frozenset()) for sid in missing}
        for sid, name, archived_at in rows:
            spaces[sid].name = name
            spaces[sid].archived = archived_at is not None

        for sid, node_id, ptype, pid, level in (await self.db.execute(
            select(WikiGrant.space_id, WikiGrant.node_id, WikiGrant.principal_type,
                   WikiGrant.principal_id, WikiGrant.level)
            .where(WikiGrant.space_id.in_(missing))
        )).all():
            g = _Grant(node_id, ptype, pid, level)
            if node_id is None:
                spaces[sid].space_grants.append(g)
            else:
                spaces[sid].node_grants.setdefault(node_id, []).append(g)

        breaks: dict[uuid.UUID, set[uuid.UUID]] = {}
        for sid, node_id in (await self.db.execute(
            select(WikiNode.space_id, WikiNode.id)
            .where(WikiNode.space_id.in_(missing),
                   WikiNode.inherit_permissions.is_(False))
        )).all():
            breaks.setdefault(sid, set()).add(node_id)
        for sid, ids in breaks.items():
            spaces[sid].breaks = frozenset(ids)

        self._spaces.update(spaces)

    # ── resolution ──────────────────────────────────────────────────

    def _final_set(self, data: _SpaceData, chain: Sequence[uuid.UUID]) -> list[_Grant]:
        """The grant set after walking `chain` (root first) from the space."""
        current = list(data.space_grants)
        managers = [g for g in current if g.level == "manage"]
        for nid in chain:
            own = data.node_grants.get(nid, [])
            if nid in data.breaks:
                # space managers never lose access
                current = list(own) + managers
            else:
                current = current + list(own)
        return current

    async def _level(self, space_id: uuid.UUID, chain: Sequence[uuid.UUID]) -> str | None:
        p = self.p
        if not p.can_view_wiki:
            return None
        if p.is_admin:
            return "manage"
        key = (space_id, tuple(chain))
        if key in self._memo:
            return self._memo[key]
        await self._load_spaces([space_id])
        data = self._spaces[space_id]
        best: str | None = None
        for g in self._final_set(data, chain):
            if grant_matches(p, g.principal_type, g.principal_id):
                best = max_level(best, g.level)
        if best and data.archived:
            best = "view"
        self._memo[key] = best
        return best

    @staticmethod
    def _chain(node: WikiNode) -> list[uuid.UUID]:
        return [*(node.path or []), node.id]

    async def level_for_space(self, space_id: uuid.UUID) -> str | None:
        return await self._level(space_id, [])

    async def levels_for_spaces(
            self, space_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, str | None]:
        """The caller's level on each space, loading every not-yet-cached
        space in one batch (the same 3 queries as a single space)."""
        ids = list(dict.fromkeys(space_ids))
        if self.p.can_view_wiki and not self.p.is_admin:
            await self._load_spaces(ids)
        return {sid: await self.level_for_space(sid) for sid in ids}

    async def level_for_node(self, node: WikiNode) -> str | None:
        return await self._level(node.space_id, self._chain(node))

    async def levels_for_nodes(self, nodes: Sequence[WikiNode]) -> dict[uuid.UUID, str | None]:
        """Does NOT filter deleted nodes — a caller listing a mix of live
        and soft-deleted nodes must filter `deleted_at` itself first."""
        if self.p.can_view_wiki and not self.p.is_admin:
            await self._load_spaces({n.space_id for n in nodes})
        return {n.id: await self.level_for_node(n) for n in nodes}

    async def effective_grants(self, node: WikiNode | None,
                               space_id: uuid.UUID) -> list[EffectiveGrantRow]:
        """Every grant in the final set for `node` (or the space itself when
        `node` is None), labeled and attributed to its source. This lists
        the grants, not the caller's access — no admin/archived rules.

        When `node` is given, its own `space_id` is what's walked — the
        `space_id` argument must then agree (a mismatch is a caller bug,
        not a recoverable condition)."""
        if node is not None and node.space_id != space_id:
            raise ValueError(
                f"node.space_id ({node.space_id}) != space_id ({space_id})")
        await self._load_spaces([space_id])
        data = self._spaces[space_id]
        grants = self._final_set(data, self._chain(node) if node else [])

        node_ids = {g.node_id for g in grants if g.node_id is not None}
        titles: dict[uuid.UUID, str] = {}
        if node_ids:
            titles = dict((await self.db.execute(
                select(WikiNode.id, WikiNode.title).where(WikiNode.id.in_(node_ids))
            )).all())
        labels = await principal_labels(self.db, grants)
        return [
            EffectiveGrantRow(
                principal_type=g.principal_type,
                principal_id=g.principal_id,
                level=g.level,
                principal_label=labels[(g.principal_type, g.principal_id)],
                source_kind="space" if g.node_id is None else "node",
                source_node_id=g.node_id,
                source_title=data.name if g.node_id is None else titles.get(g.node_id),
            )
            for g in grants
        ]


# ── what a person can see ───────────────────────────────────────────


async def viewable_nodes(db: AsyncSession, ix: AccessIndex, nodes: Sequence[WikiNode],
                         ) -> tuple[list[WikiNode], dict[uuid.UUID, str | None]]:
    """The live nodes among `nodes` that `ix`'s person can see, in order,
    with their levels — the one visibility rule every listing, the
    notification fan-out's checks and exports share: a level of at least
    view, and — for view-only — never a page that was never published
    (a reader doesn't know it exists). One extra query at most (the
    published check)."""
    live = [n for n in nodes if n.deleted_at is None]
    levels = await ix.levels_for_nodes(live)
    view_only_pages = [n.id for n in live if n.kind == "page" and levels[n.id] == "view"]
    unpublished: set[uuid.UUID] = set()
    if view_only_pages:
        unpublished = set((await db.scalars(
            select(WikiPage.node_id).where(
                WikiPage.node_id.in_(view_only_pages),
                WikiPage.published_version_id.is_(None))
        )).all())
    return [n for n in live if levels[n.id] and n.id not in unpublished], levels


# ── guards ──────────────────────────────────────────────────────────


def _not_found(message: str) -> HTTPException:
    return HTTPException(status_code=404,
                         detail={"code": "not_found", "message": message})


def _forbidden(needed: str) -> HTTPException:
    return HTTPException(status_code=403, detail={
        "code": "forbidden",
        "message": f"You need {needed} access to do that."})


async def require_node_level(ix: AccessIndex, node: WikiNode | None,
                             needed: str) -> WikiNode:
    """The node, if the caller has at least `needed` on it. A missing,
    deleted, or unviewable node is a 404 so its existence doesn't leak;
    a viewable node below `needed` is a 403."""
    if node is None or node.deleted_at is not None:
        raise _not_found("Not found.")
    level = await ix.level_for_node(node)
    if level is None:
        raise _not_found("Not found.")
    if level_rank(level) < level_rank(needed):
        raise _forbidden(needed)
    return node


async def require_space_level(ix: AccessIndex, space: WikiSpace | None,
                              needed: str) -> WikiSpace:
    """The space, if the caller has at least `needed` on it (404 when they
    can't see it at all, 403 when they can but not enough)."""
    if space is None:
        raise _not_found("Space not found.")
    level = await ix.level_for_space(space.id)
    if level is None:
        raise _not_found("Space not found.")
    if level_rank(level) < level_rank(needed):
        raise _forbidden(needed)
    return space


# ── principal labels ────────────────────────────────────────────────

_FIXED_LABELS = {
    "everyone": "Everyone who can sign in",
    "internal": "All internal staff",
}
_NAMED_MODELS = {"access_group": AccessGroup, "client": Client, "partner": Partner}
_UNKNOWN_LABELS = {
    "person": "Unknown person",
    "access_group": "Unknown access group",
    "client": "Unknown client",
    "partner": "Unknown partner",
}


async def principal_labels(db: AsyncSession,
                           grants: Iterable[Any]) -> dict[tuple[str, str | None], str]:
    """A display label for each grant's (principal_type, principal_id):
    role label, group name, person display name, client/partner name, or
    the fixed everyone/internal wording. One query per principal type
    present. `grants` is anything with principal_type/principal_id."""
    keys = {(g.principal_type, g.principal_id) for g in grants}
    labels: dict[tuple[str, str | None], str] = {}
    wanted: dict[str, set[str]] = {}
    for ptype, pid in keys:
        if ptype in _FIXED_LABELS:
            labels[(ptype, pid)] = _FIXED_LABELS[ptype]
        elif pid is not None:
            wanted.setdefault(ptype, set()).add(pid)
        else:
            labels[(ptype, pid)] = _UNKNOWN_LABELS.get(ptype, ptype)

    if roles := wanted.pop("role", None):
        found = dict((await db.execute(
            select(Role.name, Role.label).where(Role.name.in_(roles))
        )).all())
        for name in roles:
            labels[("role", name)] = found.get(name) or name

    for ptype, ids in wanted.items():
        by_uuid = {pid: _as_uuid(pid) for pid in ids}
        valid = {u for u in by_uuid.values() if u is not None}
        found_names: dict[uuid.UUID, str] = {}
        if valid and ptype == "person":
            found_names = {
                person_id: f"{preferred or first} {last}"
                for person_id, preferred, first, last in (await db.execute(
                    select(Person.id, Person.preferred_name, Person.first_name,
                           Person.last_name).where(Person.id.in_(valid))
                )).all()}
        elif valid and ptype in _NAMED_MODELS:
            model = _NAMED_MODELS[ptype]
            found_names = dict((await db.execute(
                select(model.id, model.name).where(model.id.in_(valid))
            )).all())
        for pid, u in by_uuid.items():
            labels[(ptype, pid)] = (found_names.get(u) if u else None) \
                or _UNKNOWN_LABELS.get(ptype, pid)
    return labels
