"""Client groups: named sets of a client's assets, built from the From-To
Owner column.

A roster row (`initiative_assets`) resolves to a group when its Owner's
matching key equals the key of a group name or alias of the same client, and
the row's move belongs to that client. Every function takes the session first,
never commits, and leaves the commit to the caller.
"""
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, union_all, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.clientgroups.keys import group_key, is_blank_sql, owner_key_sql
from serversherpa.db.models import (
    ClientContactGroup, ClientGroup, ClientGroupAlias, ClientGroupDismissal,
    Initiative, InitiativeAsset,
)

_CHUNK = 5000


class GroupError(Exception):
    """A rule violation the route layer turns into an HTTP error."""

    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass
class MergePlan:
    aliases_added: list[str] = field(default_factory=list)
    rows_moved: int = 0
    people_moved: int = 0
    conflicts: list[str] = field(default_factory=list)


@dataclass
class ReviewValue:
    value: str
    value_key: str
    asset_count: int
    move_ids: list[uuid.UUID]
    move_names: list[str]
    dismissed: bool


def _key_map():
    """Every (client_id, key, group_id) a group name or alias answers to."""
    return union_all(
        select(ClientGroup.client_id.label("cid"), ClientGroup.name_key.label("k"),
               ClientGroup.id.label("gid")),
        select(ClientGroupAlias.client_id, ClientGroupAlias.alias_key,
               ClientGroupAlias.group_id),
    ).subquery()


async def _taken_keys(db: AsyncSession, client_id: uuid.UUID,
                      *, skip_group: uuid.UUID | None = None) -> dict[str, tuple[str, uuid.UUID]]:
    """key -> ("name" | "alias", group_id) for the client's groups."""
    taken: dict[str, tuple[str, uuid.UUID]] = {}
    for gid, key in await db.execute(select(ClientGroup.id, ClientGroup.name_key)
                                     .where(ClientGroup.client_id == client_id)):
        if gid != skip_group:
            taken[key] = ("name", gid)
    for gid, key in await db.execute(select(ClientGroupAlias.group_id, ClientGroupAlias.alias_key)
                                     .where(ClientGroupAlias.client_id == client_id)):
        if gid != skip_group:
            taken.setdefault(key, ("alias", gid))
    return taken


def _check_free(taken: dict, key: str) -> None:
    hit = taken.get(key)
    if hit is None:
        return
    raise GroupError("group_name_taken" if hit[0] == "name" else "alias_in_use", 409)


def _clean_name(name: str) -> tuple[str, str]:
    shown = " ".join((name or "").split())
    key = group_key(shown)
    if not key:
        raise GroupError("name_required", 422)
    return shown, key


async def _clear_dismissal(db: AsyncSession, client_id: uuid.UUID, key: str) -> None:
    await db.execute(delete(ClientGroupDismissal).where(
        ClientGroupDismissal.client_id == client_id,
        ClientGroupDismissal.value_key == key))


# ---------------------------------------------------------------- matching

async def rematch_client(db: AsyncSession, client_id: uuid.UUID,
                         keys: set[str] | None = None) -> int:
    """Re-resolve the Owner group of every roster row on the client's moves
    (only rows whose Owner key is in `keys`, when given). Rows whose Owner no
    longer resolves go back to unmatched. Returns the rows changed."""
    m = _key_map()
    new_group = (select(m.c.gid)
                 .where(m.c.cid == client_id, m.c.k == owner_key_sql(InitiativeAsset.owner))
                 .scalar_subquery())
    stmt = update(InitiativeAsset).where(
        InitiativeAsset.initiative_id.in_(
            select(Initiative.id).where(Initiative.client_id == client_id)),
        InitiativeAsset.owner_group_id.is_distinct_from(new_group),
    ).values(owner_group_id=new_group).execution_options(synchronize_session=False)
    if keys is not None:
        if not keys:
            return 0
        stmt = stmt.where(owner_key_sql(InitiativeAsset.owner).in_(sorted(keys)))
    return (await db.execute(stmt)).rowcount or 0


async def rematch_rows(db: AsyncSession, row_ids: list[uuid.UUID]) -> int:
    """Re-resolve the given roster rows against their own move's client."""
    changed = 0
    ids = list(dict.fromkeys(row_ids))
    m = _key_map()
    for i in range(0, len(ids), _CHUNK):
        part = ids[i:i + _CHUNK]
        new_group = (select(m.c.gid)
                     .where(m.c.cid == Initiative.client_id,
                            m.c.k == owner_key_sql(InitiativeAsset.owner))
                     .scalar_subquery())
        stmt = update(InitiativeAsset).where(
            InitiativeAsset.id.in_(part),
            InitiativeAsset.initiative_id == Initiative.id,
            InitiativeAsset.owner_group_id.is_distinct_from(new_group),
        ).values(owner_group_id=new_group).execution_options(synchronize_session=False)
        changed += (await db.execute(stmt)).rowcount or 0
    return changed


async def rematch_initiative(db: AsyncSession, initiative_id: uuid.UUID) -> int:
    """Re-resolve every roster row of one move (its client just changed)."""
    ids = list(await db.scalars(select(InitiativeAsset.id).where(
        InitiativeAsset.initiative_id == initiative_id)))
    return await rematch_rows(db, ids)


# ------------------------------------------------------------------ groups

async def create_group(db: AsyncSession, client_id: uuid.UUID, name: str,
                       actor_id: uuid.UUID | None) -> ClientGroup:
    shown, key = _clean_name(name)
    _check_free(await _taken_keys(db, client_id), key)
    group = ClientGroup(client_id=client_id, name=shown, name_key=key, created_by=actor_id)
    db.add(group)
    await db.flush()
    await _clear_dismissal(db, client_id, key)
    await rematch_client(db, client_id, {key})
    return group


async def rename_group(db: AsyncSession, group: ClientGroup, new_name: str,
                       actor_id: uuid.UUID | None) -> ClientGroup:
    """Rename; the old name stays behind as an alias so its rows stay matched."""
    shown, key = _clean_name(new_name)
    old_name, old_key = group.name, group.name_key
    if key != old_key:
        _check_free(await _taken_keys(db, group.client_id, skip_group=group.id), key)
        # the new name may be one of this group's own aliases
        await db.execute(delete(ClientGroupAlias).where(
            ClientGroupAlias.client_id == group.client_id,
            ClientGroupAlias.alias_key == key))
        db.add(ClientGroupAlias(group_id=group.id, client_id=group.client_id,
                                alias=old_name, alias_key=old_key))
    group.name, group.name_key = shown, key
    await db.flush()
    await _clear_dismissal(db, group.client_id, key)
    return group


async def set_aliases(db: AsyncSession, group: ClientGroup, aliases: list[str]) -> list[str]:
    """Replace the group's aliases. Blank entries, repeats and spellings that
    equal the group's own name are dropped."""
    wanted: dict[str, str] = {}
    for raw in aliases:
        shown = " ".join((raw or "").split())
        key = group_key(shown)
        if key and key != group.name_key:
            wanted.setdefault(key, shown)
    taken = await _taken_keys(db, group.client_id, skip_group=group.id)
    for key in wanted:
        if key in taken:
            raise GroupError("alias_in_use", 409)
    await db.execute(delete(ClientGroupAlias).where(ClientGroupAlias.group_id == group.id))
    for key, shown in wanted.items():
        db.add(ClientGroupAlias(group_id=group.id, client_id=group.client_id,
                                alias=shown, alias_key=key))
        await _clear_dismissal(db, group.client_id, key)
    await db.flush()
    await rematch_client(db, group.client_id)
    return list(wanted.values())


async def merge_groups(db: AsyncSession, target: ClientGroup, source: ClientGroup,
                       *, dry_run: bool) -> MergePlan:
    """Fold `source` into `target`: its name and aliases become target aliases,
    its rows and people chips move over, and the source is deleted."""
    if target.client_id != source.client_id:
        raise GroupError("different_client", 422)
    if target.id == source.id:
        raise GroupError("same_group", 422)
    own = {target.name_key}
    own.update(await db.scalars(select(ClientGroupAlias.alias_key)
                                .where(ClientGroupAlias.group_id == target.id)))
    spellings = [(source.name, source.name_key)]
    spellings += [(a, k) for a, k in await db.execute(
        select(ClientGroupAlias.alias, ClientGroupAlias.alias_key)
        .where(ClientGroupAlias.group_id == source.id)
        .order_by(ClientGroupAlias.alias_key))]
    to_add = [(a, k) for a, k in spellings if k not in own]
    plan = MergePlan(aliases_added=[a for a, _ in to_add])
    plan.rows_moved = await db.scalar(select(func.count()).select_from(InitiativeAsset).where(
        InitiativeAsset.owner_group_id == source.id)) or 0
    has_target = select(ClientContactGroup.person_id).where(
        ClientContactGroup.group_id == target.id)
    plan.people_moved = await db.scalar(select(func.count()).select_from(ClientContactGroup).where(
        ClientContactGroup.group_id == source.id,
        ClientContactGroup.person_id.not_in(has_target))) or 0
    if dry_run:
        return plan

    await db.execute(update(InitiativeAsset).where(
        InitiativeAsset.owner_group_id == source.id,
    ).values(owner_group_id=target.id).execution_options(synchronize_session=False))
    await db.execute(update(ClientContactGroup).where(
        ClientContactGroup.group_id == source.id,
        ClientContactGroup.person_id.not_in(has_target),
    ).values(group_id=target.id).execution_options(synchronize_session=False))
    # free the source's keys before the target takes them
    await db.execute(delete(ClientGroupAlias).where(ClientGroupAlias.group_id == source.id))
    await db.execute(delete(ClientGroup).where(ClientGroup.id == source.id))
    for alias, key in to_add:
        db.add(ClientGroupAlias(group_id=target.id, client_id=target.client_id,
                                alias=alias, alias_key=key))
    await db.flush()
    db.expunge(source)
    return plan


async def delete_group(db: AsyncSession, group: ClientGroup) -> None:
    """Rows go back to unmatched (FK SET NULL); aliases cascade. Refused while
    any contact holds the group as a chip: a Viewer whose last chip vanished
    would silently become unrestricted."""
    held = await db.scalar(select(func.count()).select_from(ClientContactGroup).where(
        ClientContactGroup.group_id == group.id))
    if held:
        raise GroupError("group_in_use", 409)
    await db.execute(delete(ClientGroup).where(ClientGroup.id == group.id))
    await db.flush()
    db.expunge(group)


# ------------------------------------------------------------------ review

async def review_values(db: AsyncSession, client_id: uuid.UUID,
                        *, include_dismissed: bool) -> list[ReviewValue]:
    """Non-blank Owner values on the client's moves that match no group."""
    key = owner_key_sql(InitiativeAsset.owner)
    rows = (await db.execute(
        select(key, InitiativeAsset.owner, InitiativeAsset.asset_id,
               Initiative.id, Initiative.name)
        .join(Initiative, Initiative.id == InitiativeAsset.initiative_id)
        .where(Initiative.client_id == client_id,
               InitiativeAsset.owner_group_id.is_(None),
               ~is_blank_sql(InitiativeAsset.owner))
    )).all()
    dismissed = set(await db.scalars(select(ClientGroupDismissal.value_key)
                                     .where(ClientGroupDismissal.client_id == client_id)))
    spellings: dict[str, Counter] = {}
    assets: dict[str, set] = {}
    moves: dict[str, dict[uuid.UUID, str]] = {}
    for k, owner, asset_id, move_id, move_name in rows:
        spellings.setdefault(k, Counter())[owner] += 1
        assets.setdefault(k, set()).add(asset_id)
        moves.setdefault(k, {})[move_id] = move_name
    out = []
    for k, counts in spellings.items():
        is_dismissed = k in dismissed
        if is_dismissed and not include_dismissed:
            continue
        top = max(counts.values())
        value = min(s for s, n in counts.items() if n == top)
        ordered = sorted(moves[k].items(), key=lambda kv: (kv[1].lower(), str(kv[0])))
        out.append(ReviewValue(value=value, value_key=k, asset_count=len(assets[k]),
                               move_ids=[i for i, _ in ordered],
                               move_names=[n for _, n in ordered], dismissed=is_dismissed))
    out.sort(key=lambda v: (-v.asset_count, v.value_key))
    return out


async def match_value(db: AsyncSession, client_id: uuid.UUID, value: str,
                      group_id: uuid.UUID) -> ClientGroup:
    """Point an Owner spelling at an existing group (adds it as an alias)."""
    group = await db.get(ClientGroup, group_id)
    if group is None or group.client_id != client_id:
        raise GroupError("group_not_found", 404)
    shown = " ".join((value or "").split())
    key = group_key(shown)
    if not key:
        raise GroupError("value_required", 422)
    if key != group.name_key:
        taken = await _taken_keys(db, client_id, skip_group=group.id)
        _check_free(taken, key)
        already = await db.scalar(select(ClientGroupAlias.id).where(
            ClientGroupAlias.group_id == group.id, ClientGroupAlias.alias_key == key))
        if already is None:
            db.add(ClientGroupAlias(group_id=group.id, client_id=client_id,
                                    alias=shown, alias_key=key))
            await db.flush()
    await _clear_dismissal(db, client_id, key)
    await rematch_client(db, client_id, {key})
    return group


async def set_dismissed(db: AsyncSession, client_id: uuid.UUID, value: str,
                        dismissed: bool, actor_id: uuid.UUID | None) -> None:
    key = group_key(value)
    if not key:
        raise GroupError("value_required", 422)
    await _clear_dismissal(db, client_id, key)
    if dismissed:
        db.add(ClientGroupDismissal(client_id=client_id, value_key=key,
                                    dismissed_at=datetime.now(UTC), dismissed_by=actor_id))
        await db.flush()
