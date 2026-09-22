"""Merge one catalog model (the duplicate) into another (the target).

`build_plan` is pure: it reads what would move, which target specs the
duplicate would fill, what happens to every alias, and which aliases a
third model already owns. The dry run returns the plan; the real run
applies exactly the same plan. Rules are in the design spec."""

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, AssetModel, AssetModelAlias, StockLine

SINGLE_FIELDS = ("category", "ru_size", "mount_type", "rail_type", "form_factor")
UNIT_GROUPS = (("weight_lbs", "weight_kg"),
               ("length_in", "width_in", "height_in", "length_cm", "width_cm", "height_cm"))


@dataclass
class MergePlan:
    moves: dict = field(default_factory=lambda: {"assets": 0, "stock_lines": 0, "aliases": 0})
    fills: dict = field(default_factory=dict)
    alias_added: str | None = None
    aliases_moved: list[str] = field(default_factory=list)
    aliases_after: list[str] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    notes_after: str = ""

    @property
    def can_merge(self) -> bool:
        return not self.conflicts


def _name(m: AssetModel) -> str:
    return f"{m.make} {m.model}"


def _blank(v) -> bool:
    return v is None or v == ""


def merged_notes(target_notes: str, source: AssetModel, now: datetime) -> str:
    line = f"Merged from {_name(source)} on {now:%Y-%m-%d}."
    head = (target_notes or "").rstrip()
    out = f"{head}\n\n{line}" if head else line
    tail = (source.knowledge or "").strip()
    return f"{out}\n{tail}" if tail else out


async def build_plan(db: AsyncSession, target: AssetModel, source: AssetModel,
                     now: datetime) -> MergePlan:
    plan = MergePlan()
    plan.moves["assets"] = await db.scalar(
        select(func.count()).select_from(Asset).where(Asset.model_id == source.id)) or 0
    plan.moves["stock_lines"] = await db.scalar(
        select(func.count()).select_from(StockLine).where(StockLine.model_id == source.id)) or 0

    target_aliases = list(await db.scalars(select(AssetModelAlias.alias).where(
        AssetModelAlias.model_id == target.id).order_by(AssetModelAlias.alias)))
    source_aliases = list(await db.scalars(select(AssetModelAlias.alias).where(
        AssetModelAlias.model_id == source.id).order_by(AssetModelAlias.alias)))
    # Aliases the target already "owns", so a source alias equal to one of
    # them is dropped rather than moved. The target-alias half is defensive
    # only: asset_model_aliases.alias carries a global CITEXT unique index,
    # so no two models can ever hold the same alias — only the target-NAME
    # case (a source alias spelled like "Dell PowerEdge R740") is reachable.
    taken = {a.lower() for a in target_aliases} | {_name(target).lower()}

    candidates = list(source_aliases) + [_name(source)]
    owners = (await db.execute(
        select(AssetModelAlias.alias, AssetModel.id, AssetModel.make, AssetModel.model)
        .join(AssetModel, AssetModel.id == AssetModelAlias.model_id)
        # CITEXT compares case-insensitively in SQL, so the plain IN is both
        # correct and index-usable — lower(alias) would not hit the unique.
        .where(AssetModelAlias.alias.in_(candidates),
               AssetModelAlias.model_id.not_in([target.id, source.id])))).all()
    plan.conflicts = [{"alias": alias, "model_id": str(mid), "make": mk, "model": md}
                      for alias, mid, mk, md in owners]

    for alias in source_aliases:
        if alias.lower() not in taken:
            plan.aliases_moved.append(alias)
            taken.add(alias.lower())
    plan.moves["aliases"] = len(plan.aliases_moved)
    if _name(source).lower() not in taken:
        plan.alias_added = _name(source)
        taken.add(_name(source).lower())
    plan.aliases_after = sorted(target_aliases + plan.aliases_moved
                                + ([plan.alias_added] if plan.alias_added else []),
                                key=str.lower)

    for f in SINGLE_FIELDS:
        if _blank(getattr(target, f)) and not _blank(getattr(source, f)):
            plan.fills[f] = getattr(source, f)
    for group in UNIT_GROUPS:
        if all(_blank(getattr(target, f)) for f in group) and \
                any(not _blank(getattr(source, f)) for f in group):
            for f in group:
                v = getattr(source, f)
                plan.fills[f] = float(v) if v is not None else None
    plan.notes_after = merged_notes(target.knowledge, source, now)
    return plan


async def apply_plan(db: AsyncSession, target: AssetModel, source: AssetModel,
                     plan: MergePlan, now: datetime) -> None:
    await db.execute(update(Asset).where(Asset.model_id == source.id)
                     .values(model_id=target.id, updated_at=now))
    await db.execute(update(StockLine).where(StockLine.model_id == source.id)
                     .values(model_id=target.id, updated_at=now))
    moved = {a.lower() for a in plan.aliases_moved}
    for row in list(await db.scalars(select(AssetModelAlias).where(
            AssetModelAlias.model_id == source.id))):
        if row.alias.lower() in moved:
            row.model_id = target.id
        else:
            await db.delete(row)
    if plan.alias_added:
        db.add(AssetModelAlias(model_id=target.id, alias=plan.alias_added))
    for f, v in plan.fills.items():
        setattr(target, f, v)
    target.knowledge = plan.notes_after
    target.updated_at = now
    await db.flush()
    await db.delete(source)
    await db.flush()
