"""Copy one person's access to others — plan (dry run) and apply.

Parts: global roles, access groups, per-cell overrides. Replace makes the
target's part equal the source's; Add unions them (the source wins an
override conflict). Org-anchored roles are never copied or revoked."""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.apply import (
    ORG_ANCHORS, apply_global_roles, apply_groups, apply_overrides,
    current_global_roles, current_groups, current_overrides, current_roles,
)
from serversherpa.access.resolver import can_touch_rank
from serversherpa.db.models import AccessGroup, Person, Role, UserAccount
from serversherpa.services.storage import presign_get

PARTS = ("roles", "groups", "overrides")
MODES = ("replace", "add")


@dataclass
class Snapshot:
    # roles not anchored to a client or partner (global- and self-anchored)
    roles: set[str] = field(default_factory=set)
    groups: set[uuid.UUID] = field(default_factory=set)
    overrides: dict[tuple[str, str], bool] = field(default_factory=dict)


@dataclass
class PlanRow:
    person: Person | None
    max_rank: int
    status: str = "ok"
    reason: str | None = None
    roles: dict | None = None        # {"from": [...], "to": [...]} (all held roles)
    groups: dict | None = None       # {"from": [names], "to": [names]}
    overrides: dict | None = None    # {"added", "removed", "changed"}
    desired: Snapshot = field(default_factory=Snapshot)
    # set instead of `person` for a target id with no people row
    missing_id: uuid.UUID | None = None

    @classmethod
    def not_found(cls, target_id: uuid.UUID) -> "PlanRow":
        """A target id with no people row: reported, never silently dropped."""
        return cls(person=None, max_rank=0, status="skipped",
                   reason="person_not_found", missing_id=target_id)

    def out(self) -> dict:
        if self.person is None:
            return {"person_id": str(self.missing_id),
                    "display_name": "Unknown person", "avatar_url": None,
                    "status": self.status, "reason": self.reason,
                    "roles": None, "groups": None, "overrides": None}
        return {"person_id": str(self.person.id),
                "display_name": self.person.display_name,
                "avatar_url": presign_get(self.person.avatar_key),
                "status": self.status, "reason": self.reason,
                "roles": self.roles, "groups": self.groups,
                "overrides": self.overrides}


async def snapshot(db: AsyncSession, person_id: uuid.UUID) -> Snapshot:
    return Snapshot(roles=await current_global_roles(db, person_id),
                    groups=await current_groups(db, person_id),
                    overrides=await current_overrides(db, person_id))


def _merge(mode: str, src: Snapshot, tgt: Snapshot, parts: set[str]) -> Snapshot:
    out = Snapshot(roles=set(tgt.roles), groups=set(tgt.groups),
                   overrides=dict(tgt.overrides))
    if "roles" in parts:
        out.roles = set(src.roles) if mode == "replace" else tgt.roles | src.roles
    if "groups" in parts:
        out.groups = set(src.groups) if mode == "replace" else tgt.groups | src.groups
    if "overrides" in parts:
        out.overrides = (dict(src.overrides) if mode == "replace"
                         else {**tgt.overrides, **src.overrides})
    return out


def _override_counts(cur: dict, new: dict) -> dict:
    added = sum(1 for k in new if k not in cur)
    removed = sum(1 for k in cur if k not in new)
    changed = sum(1 for k in new if k in cur and cur[k] != new[k])
    return {"added": added, "removed": removed, "changed": changed}


async def plan_copy(
    db: AsyncSession, *, actor_id: uuid.UUID, actor_rank: int,
    source_id: uuid.UUID, target_ids: list[uuid.UUID], parts: set[str], mode: str,
) -> tuple[Snapshot, list[PlanRow], dict[str, Role]]:
    src = await snapshot(db, source_id)
    role_rows = {r.name: r for r in await db.scalars(select(Role))}
    group_names = {g.id: g.name for g in await db.scalars(select(AccessGroup))}
    accounts = set(await db.scalars(select(UserAccount.person_id).where(
        UserAccount.person_id.in_(target_ids))))
    rows: list[PlanRow] = []
    for tid in target_ids:
        person = await db.get(Person, tid)
        if person is None:
            rows.append(PlanRow.not_found(tid))
            continue
        held = await current_roles(db, tid)
        max_rank = max((role_rows[r].rank for r in held if r in role_rows), default=0)
        row = PlanRow(person=person, max_rank=max_rank)
        rows.append(row)
        if tid == actor_id:
            row.status, row.reason = "skipped", "cannot_target_self"
            continue
        if tid not in accounts:
            row.status, row.reason = "skipped", "no_account"
            continue
        if not can_touch_rank(actor_rank, max_rank):
            row.status, row.reason = "skipped", "rank_too_low"
            continue
        tgt = await snapshot(db, tid)
        row.desired = _merge(mode, src, tgt, parts)
        if "roles" in parts:
            new_roles = row.desired.roles - tgt.roles
            if any(not can_touch_rank(actor_rank, role_rows[r].rank) for r in new_roles):
                row.status, row.reason = "skipped", "role_rank_too_low"
                continue
            org_roles = {r for r in held if role_rows.get(r) and role_rows[r].scope_anchor in ORG_ANCHORS}
            if row.desired.roles != tgt.roles:
                row.roles = {"from": sorted(held),
                             "to": sorted(row.desired.roles | org_roles)}
        if "groups" in parts and row.desired.groups != tgt.groups:
            row.groups = {"from": sorted(group_names[g] for g in tgt.groups),
                          "to": sorted(group_names[g] for g in row.desired.groups)}
        if "overrides" in parts and row.desired.overrides != tgt.overrides:
            row.overrides = _override_counts(tgt.overrides, row.desired.overrides)
    return src, rows, role_rows


async def apply_copy(
    db: AsyncSession, *, actor_id: uuid.UUID, rows: list[PlanRow], parts: set[str],
    role_rows: dict[str, Role],
) -> dict[uuid.UUID, dict]:
    """Apply every `ok` row. Returns per-target change dicts (only parts that
    changed) for the caller to audit. No commit."""
    changes: dict[uuid.UUID, dict] = {}
    for row in rows:
        if row.status != "ok" or row.person is None:
            continue
        out: dict = {}
        if "roles" in parts and row.roles is not None:
            diff = await apply_global_roles(db, actor_id=actor_id, person_id=row.person.id,
                                            desired=row.desired.roles, role_rows=role_rows)
            if diff is not None:
                # the helper's diff drops the target's client/partner-anchored
                # roles from "to" (it only manages the revocable ones), which
                # would read as a revocation. `row.roles` is the truthful diff.
                out["roles"] = row.roles
        if "groups" in parts and row.groups is not None:
            diff = await apply_groups(db, actor_id=actor_id, person_id=row.person.id,
                                      desired=row.desired.groups)
            if diff is not None:
                out["groups"] = diff
        if "overrides" in parts and row.overrides is not None:
            diff = await apply_overrides(db, actor_id=actor_id, person_id=row.person.id,
                                         desired=row.desired.overrides)
            if diff:
                out["overrides"] = diff
        if out:
            changes[row.person.id] = out
    return changes
