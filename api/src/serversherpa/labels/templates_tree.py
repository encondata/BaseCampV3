"""The label builder's template tree (spec §3.4, §4.1): a parent design with
one DPI child per entry of its `dpis`, versions, clone, Replace… and the
typed-name delete. Every write to a builder template goes through here;
api/routes/labels.py validates input, maps the errors and audits.

- A parent (`schema_version` 2, no `parent_id`) is the design the builder
  shows, at 300 DPI. It never prints: kiosks and the generator use its
  children.
- A child is a full copy of the parent's design pinned to one DPI, named
  "<parent> · <dpi>". A parent save regenerates every child that has no
  hand edits; a `customized` child is kept and reported out of date
  instead. "Update from parent" renames it "<parent> · <dpi> Old" (then
  " Old 2", …), keeps it nested and inactive, and generates a fresh one.
- Versions: every save writes a `label_template_versions` row. A parent's
  (and an older row's) are (version, 0); a child's count under its
  parent's, (generated_from_version, child_edits), shown `v7.2`. A
  child's own `version` is its revision counter, bumped on every change,
  so a kiosk sees an edit as a new version. A parent save that changes
  only the sample values is a parent version and nothing else: its
  children print the same design, so they are left exactly as they are
  (out of date means the parent's *design* has moved past a child, see
  `design_versions`).
- Saves lock what they decide from (the parent, then its children; a
  child save its child), so two designers saving one family never write
  over each other's work.
- A child is on or off with its parent, never alone (an Old child is
  always off).
- One active template per family, label type and DPI (parents aside: they
  never print). Every activation runs `guard_active` under one advisory
  lock, so two concurrent activations can't both pass the check.

Older rows (schema 1, no parent) keep working as single rows; they share
the active rule, the versions and the typed-name delete."""

import copy
import uuid
from datetime import UTC, datetime
from typing import TypedDict

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from serversherpa.db.models import (
    GeneratedLabel, LabelTemplate, LabelTemplateSite, LabelTemplateVersion,
)
from serversherpa.db.ordering import natural_key
from serversherpa.labels.kiosk_templates import FALLBACK_NAME, row_family

TREE_DPIS = ("203", "300", "600")
PARENT_DPI = "300"   # the design DPI the builder shows
SEPARATOR = " · "
# what an audit row records of a template (the routes and the seed)
TEMPLATE_FIELDS = ["name", "description", "label_type", "size_key", "dpi_key", "language_key",
                   "design", "code", "is_active", "generation_rules", "samples"]

_ACTIVE_LOCK = text(
    "SELECT pg_advisory_xact_lock(hashtextextended('label_templates:active', 0))")


class TreeError(Exception):
    """A refused operation; the route answers `status` with
    {"code": code, **extra}."""
    status = 409
    code = "conflict"

    def __init__(self, **extra):
        super().__init__(self.code)
        self.extra = extra


class ActiveConflict(TreeError):
    """Another active template already prints this family, type and DPI."""
    status, code = 422, "active_conflict"

    def __init__(self, names: list[str]):
        super().__init__(names=names)
        self.names = names


class NameTaken(TreeError):
    status, code = 409, "label_template_exists"


class NameMismatch(TreeError):
    status, code = 422, "name_mismatch"


class NotAParent(TreeError):
    status, code = 409, "not_a_parent"


class NotAChild(TreeError):
    status, code = 409, "not_a_child"


class ChildFollowsParent(TreeError):
    """A DPI child is on or off with its parent, never on its own."""
    status, code = 409, "child_follows_parent"


class TemplateActive(TreeError):
    """Rename… on the templates list: a template renames only while it is
    off (the PATCH route's rule; the seed's rename of an old row is not
    bound by it)."""
    status, code = 409, "template_active"

    def __init__(self):
        super().__init__(message="Deactivate the template to rename it.")


class NotCustomized(TreeError):
    status, code = 409, "not_customized"


class DpiExists(TreeError):
    status, code = 409, "dpi_exists"


class BadDpi(TreeError):
    status, code = 422, "bad_dpi"


class UnknownVersion(TreeError):
    status, code = 404, "unknown_version"


class UnknownTemplates(TreeError):
    status, code = 422, "unknown_templates"


class ParentSaveResult(TypedDict):
    out_of_date: list[uuid.UUID]


class DeleteSummary(TypedDict):
    children: list[str]
    generated_labels: int


class DeleteSummaryOut(DeleteSummary):
    """What GET …/delete-summary answers: DeleteSummary and the DPIs the
    delete would leave without an active fallback (`fallback_dpis_lost`)."""
    fallback_dpis_lost: list[str]


class DeactivateSummary(TypedDict):
    rows: list[str]
    fallback_dpis_lost: list[str]


def _now() -> datetime:
    return datetime.now(UTC)


def child_name(parent_name: str, dpi: str) -> str:
    return f"{parent_name}{SEPARATOR}{dpi}"


def version_label(version: int, child_edits: int) -> str:
    return f"v{version}.{child_edits}" if child_edits else f"v{version}"


def _dpi_order(dpis) -> list[str]:
    return sorted(set(dpis), key=int)


def is_out_of_date(child: LabelTemplate, design_version: int) -> bool:
    """A customized child whose parent's design has moved past the version
    it was generated from (`design_version`, from `design_versions`; an Old
    child is kept on purpose, never out of date)."""
    return (child.customized and not child.is_old
            and (child.generated_from_version or 0) < design_version)


# what a save decides from, re-read under the row lock (`_lock`)
_SAVE_COLUMNS = ("name", "design", "samples", "version", "dpis", "is_active", "label_type",
                 "size_key", "language_key", "generated_from_version", "child_edits",
                 "customized", "is_old")


async def _lock(db: AsyncSession, row: LabelTemplate) -> None:
    """Lock `row` to the end of the transaction and re-read what a save
    decides from, so the decision never rests on a read another transaction
    has committed past. Pending changes are flushed first (a refresh would
    drop them)."""
    await db.flush()
    await db.refresh(row, attribute_names=list(_SAVE_COLUMNS), with_for_update=True)


# ── reads ───────────────────────────────────────────────────────────

async def children_of(db: AsyncSession, parent: LabelTemplate, *, include_old: bool = True,
                      for_update: bool = False) -> list[LabelTemplate]:
    """The parent's children, natural by name. `for_update` locks them and
    re-reads them (a save deciding which to regenerate)."""
    q = select(LabelTemplate).where(LabelTemplate.parent_id == parent.id)
    if not include_old:
        q = q.where(LabelTemplate.is_old.is_(False))
    if for_update:
        q = q.with_for_update().execution_options(populate_existing=True)
    rows = (await db.execute(q)).scalars().all()
    return sorted(rows, key=lambda r: natural_key(r.name))


async def design_versions(db: AsyncSession, parent_ids) -> dict[uuid.UUID, int]:
    """{parent id: the version its current design was saved at} — one past
    the newest of its versions with a different design (1 when none
    differs). A samples-only save bumps a parent's version but not this,
    so it never puts a child out of date."""
    ids = list(dict.fromkeys(parent_ids))
    if not ids:
        return {}
    newest_other = dict((await db.execute(
        select(LabelTemplateVersion.template_id, func.max(LabelTemplateVersion.version))
        .join(LabelTemplate, LabelTemplate.id == LabelTemplateVersion.template_id)
        .where(LabelTemplateVersion.template_id.in_(ids),
               LabelTemplateVersion.child_edits == 0,
               LabelTemplateVersion.design.is_distinct_from(LabelTemplate.design))
        .group_by(LabelTemplateVersion.template_id))).all())
    return {pid: newest_other.get(pid, 0) + 1 for pid in ids}


async def design_version(db: AsyncSession, parent: LabelTemplate) -> int:
    return (await design_versions(db, [parent.id]))[parent.id]


async def current_dpis(db: AsyncSession, parent: LabelTemplate) -> set[str]:
    """The DPIs the parent has a current (not Old) child at."""
    return {c.dpi_key for c in await children_of(db, parent, include_old=False)}


async def parent_of(db: AsyncSession, child: LabelTemplate) -> LabelTemplate:
    if child.parent_id is None:
        raise NotAChild()
    parent = await db.get(LabelTemplate, child.parent_id)
    assert parent is not None  # the FK guarantees it
    return parent


async def family_of(db: AsyncSession, row: LabelTemplate) -> str:
    """A child's family is its parent's name; any other row's comes from
    its own name (kiosk_templates.row_family)."""
    if row.parent_id is None:
        return row_family(row.name, None)
    return row_family(row.name, (await parent_of(db, row)).name)


async def name_taken(db: AsyncSession, name: str) -> bool:
    return await db.scalar(select(LabelTemplate.id).where(LabelTemplate.name == name)) is not None


async def _require_free(db: AsyncSession, names: list[str]) -> None:
    for name in names:
        if await name_taken(db, name):
            raise NameTaken(name=name)


async def versions(db: AsyncSession, template: LabelTemplate) -> list[LabelTemplateVersion]:
    """Every saved state of the template, newest first."""
    return list((await db.execute(
        select(LabelTemplateVersion)
        .where(LabelTemplateVersion.template_id == template.id)
        .order_by(LabelTemplateVersion.version.desc(),
                  LabelTemplateVersion.child_edits.desc()))).scalars().all())


async def get_version(db: AsyncSession, template: LabelTemplate, version: int,
                      child_edits: int) -> LabelTemplateVersion:
    row = await db.scalar(select(LabelTemplateVersion).where(
        LabelTemplateVersion.template_id == template.id,
        LabelTemplateVersion.version == version,
        LabelTemplateVersion.child_edits == child_edits))
    if row is None:
        raise UnknownVersion()
    return row


async def delete_summary(db: AsyncSession, template: LabelTemplate) -> DeleteSummaryOut:
    """What deleting `template` takes with it: its children (by name), how
    many generated labels the template and its children have, and the DPIs
    it leaves without an active fallback (`fallback_dpis_lost`)."""
    children = await children_of(db, template) if template.parent_id is None else []
    ids = [template.id, *(c.id for c in children)]
    count = await db.scalar(select(func.count()).select_from(GeneratedLabel)
                            .where(GeneratedLabel.template_id.in_(ids)))
    return {"children": [c.name for c in children], "generated_labels": count or 0,
            "fallback_dpis_lost": await fallback_dpis_lost(db, [template, *children])}


async def fallback_dpis_lost(db: AsyncSession, going_off: list[LabelTemplate]) -> list[str]:
    """The DPIs (natural order) at which an active Top template of the
    fallback family (Generic Rack and RU, kiosk_templates.FALLBACK_NAME)
    prints now but none would once every row in `going_off` is gone or off.
    Moves without their own Top template print from it, so a DPI here is
    one those moves would have nothing to print at.

    A tree parent never prints: its active children count, at their own
    DPIs, and a parent in `going_off` takes its children with it. An older
    row counts at its own `dpi_key`. Inactive rows count for nothing."""
    gone = {r.id for r in going_off}
    parent = aliased(LabelTemplate)
    rows = (await db.execute(
        select(LabelTemplate.id, LabelTemplate.parent_id, LabelTemplate.name,
               LabelTemplate.dpi_key, parent.name)
        .outerjoin(parent, parent.id == LabelTemplate.parent_id)
        .where(LabelTemplate.is_active.is_(True),
               LabelTemplate.label_type == "top",
               (LabelTemplate.parent_id.is_not(None)) | (LabelTemplate.schema_version < 2)))
    ).all()
    now: set[str] = set()
    after: set[str] = set()
    for row_id, parent_id, name, dpi_key, parent_name in rows:
        if row_family(name, parent_name).casefold() != FALLBACK_NAME:
            continue
        now.add(dpi_key)
        if row_id not in gone and parent_id not in gone:
            after.add(dpi_key)
    return sorted(now - after, key=natural_key)


# ── versions ────────────────────────────────────────────────────────

def add_version(db: AsyncSession, template: LabelTemplate, *, version: int,
                child_edits: int = 0, summary: str, actor_id: uuid.UUID | None) -> None:
    db.add(LabelTemplateVersion(
        template_id=template.id, version=version, child_edits=child_edits,
        design=copy.deepcopy(template.design), code=template.code,
        samples=copy.deepcopy(template.samples or {}), summary=summary, note="",
        created_by=actor_id))


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


_GEOMETRY = ("x", "y", "w", "h", "rotation")


def change_summary(before: dict | None, after: dict | None, *,
                   samples_changed: bool = False) -> str:
    """One line on what a save changed, from the design diff: elements
    added, removed, moved (geometry) and changed (any other setting), the
    Split, the size, the sample values."""
    def elements(design):
        els = (design or {}).get("elements")
        return {el.get("id"): el for el in (els if isinstance(els, list) else [])
                if isinstance(el, dict)}

    b, a = elements(before), elements(after)
    parts: list[str] = []
    added = [k for k in a if k not in b]
    removed = [k for k in b if k not in a]
    moved = changed = 0
    for key in a.keys() & b.keys():
        old, new = b[key], a[key]
        if old == new:
            continue
        if any(old.get(g) != new.get(g) for g in _GEOMETRY):
            moved += 1
        if ({k: v for k, v in old.items() if k not in _GEOMETRY}
                != {k: v for k, v in new.items() if k not in _GEOMETRY}):
            changed += 1
    if added:
        parts.append(f"added {_count(len(added), 'element')}")
    if removed:
        parts.append(f"removed {_count(len(removed), 'element')}")
    if moved:
        parts.append(f"moved {_count(moved, 'element')}")
    if changed:
        parts.append(f"changed settings on {_count(changed, 'element')}")
    if (before or {}).get("splits") != (after or {}).get("splits"):
        parts.append("changed the Split")
    if (before or {}).get("size") != (after or {}).get("size"):
        parts.append("changed the size")
    if samples_changed:
        parts.append("changed sample values")
    if not parts:
        return "No changes"
    line = ", ".join(parts)
    return line[0].upper() + line[1:]


# ── one active template per family, type and DPI ───────────────────

async def _conflicts(db: AsyncSession, *, family: str, label_type: str, dpi_key: str,
                     exclude_id: uuid.UUID | None) -> list[str]:
    parent = aliased(LabelTemplate)
    q = (select(LabelTemplate.name, parent.name)
         .outerjoin(parent, parent.id == LabelTemplate.parent_id)
         .where(LabelTemplate.is_active.is_(True),
                LabelTemplate.label_type == label_type,
                LabelTemplate.dpi_key == dpi_key,
                (LabelTemplate.parent_id.is_not(None)) | (LabelTemplate.schema_version < 2)))
    if exclude_id is not None:
        q = q.where(LabelTemplate.id != exclude_id)
    wanted = family.casefold()
    return [name for name, parent_name in (await db.execute(q)).all()
            if row_family(name, parent_name).casefold() == wanted]


async def guard_active(db: AsyncSession, rows: list[LabelTemplate]) -> None:
    """The one-active rule, the only way in: raise ActiveConflict naming
    every other active template (parents aside) of the family, type and DPI
    of each active, printing row in `rows`, all conflicts at once. Flushes
    first, then takes the activation lock (held to the end of the
    transaction) before it looks."""
    await db.flush()
    await db.execute(_ACTIVE_LOCK)
    names: set[str] = set()
    for row in rows:
        if row.is_tree_parent or not row.is_active:
            continue
        names.update(await _conflicts(
            db, family=await family_of(db, row), label_type=row.label_type,
            dpi_key=row.dpi_key, exclude_id=row.id))
    if names:
        raise ActiveConflict(sorted(names, key=natural_key))


async def printing_rows(db: AsyncSession, template: LabelTemplate) -> list[LabelTemplate]:
    """The rows activating `template` turns on: a parent and its current
    children, else the row itself."""
    if template.is_tree_parent:
        return [template, *await children_of(db, template, include_old=False)]
    return [template]


async def out_of_date_ids(db: AsyncSession, parent: LabelTemplate) -> list[uuid.UUID]:
    current = await design_version(db, parent)
    return [c.id for c in await children_of(db, parent, include_old=False)
            if is_out_of_date(c, current)]


async def activate(db: AsyncSession, template: LabelTemplate) -> list[LabelTemplate]:
    """Turn on a template (a parent with its current children) under the
    one-active guard. Returns the rows whose state changed. A child is
    never turned on alone (ChildFollowsParent)."""
    if template.parent_id is not None:
        raise ChildFollowsParent()
    rows = await printing_rows(db, template)
    changed = [r for r in rows if not r.is_active]
    for row in changed:
        row.is_active, row.updated_at = True, _now()
    await guard_active(db, rows)
    return changed


async def deactivation_rows(db: AsyncSession, template: LabelTemplate) -> list[LabelTemplate]:
    """The rows deactivating `template` turns off: its active printing rows
    (a parent and its current children; an Old child is always off). A
    child is never turned off alone (ChildFollowsParent)."""
    if template.parent_id is not None:
        raise ChildFollowsParent()
    return [r for r in await printing_rows(db, template) if r.is_active]


async def deactivate_summary(db: AsyncSession, template: LabelTemplate) -> DeactivateSummary:
    """What deactivating `template` would turn off (names, natural order)
    and the DPIs it would leave without an active fallback. Changes
    nothing."""
    rows = await deactivation_rows(db, template)
    return {"rows": sorted((r.name for r in rows), key=natural_key),
            "fallback_dpis_lost": await fallback_dpis_lost(db, rows)}


async def deactivate(db: AsyncSession, template: LabelTemplate) -> list[LabelTemplate]:
    """Turn off a template; a parent takes its current children with it
    (an Old child is always off). A child is never turned off alone."""
    changed = await deactivation_rows(db, template)
    for row in changed:
        row.is_active, row.updated_at = False, _now()
    return changed


# ── create, save, regenerate ────────────────────────────────────────

async def create_parent(db: AsyncSession, *, name: str, description: str, label_type: str,
                        size_key: str, language_key: str, design: dict, samples: dict,
                        site_ids: list[uuid.UUID], actor_id: uuid.UUID | None,
                        is_active: bool = True) -> LabelTemplate:
    """A parent at 300 DPI and its three children; active ones only when
    no other active template prints the family at a DPI."""
    await _require_free(db, [name, *(child_name(name, d) for d in TREE_DPIS)])
    parent = LabelTemplate(
        name=name, description=description, label_type=label_type, size_key=size_key,
        dpi_key=PARENT_DPI, language_key=language_key, kind="design",
        design=copy.deepcopy(design), code=None, version=1, is_active=is_active,
        generation_rules={}, schema_version=2, samples=dict(samples or {}),
        dpis=list(TREE_DPIS), generated_from_version=None, child_edits=0,
        customized=False, is_old=False)
    db.add(parent)
    await db.flush()
    for sid in dict.fromkeys(site_ids):
        db.add(LabelTemplateSite(template_id=parent.id, site_id=sid))
    add_version(db, parent, version=1, summary="Created", actor_id=actor_id)
    children = await generate_children(db, parent, actor_id=actor_id)
    if is_active:
        await guard_active(db, children)
    return parent


async def generate_children(db: AsyncSession, parent: LabelTemplate, *,
                            actor_id: uuid.UUID | None = None) -> list[LabelTemplate]:
    """A child for every DPI in the parent's set that has no current one:
    the parent's design, no samples, generated from the parent's version,
    as active as the parent."""
    have = await current_dpis(db, parent)
    made: list[LabelTemplate] = []
    for dpi in _dpi_order(parent.dpis):
        if dpi in have:
            continue
        name = child_name(parent.name, dpi)
        await _require_free(db, [name])
        child = LabelTemplate(
            name=name, description="", label_type=parent.label_type,
            size_key=parent.size_key, dpi_key=dpi, language_key=parent.language_key,
            kind="design", design=copy.deepcopy(parent.design), code=None,
            version=parent.version, is_active=parent.is_active, generation_rules={},
            parent_id=parent.id, schema_version=2, samples={}, dpis=[dpi],
            generated_from_version=parent.version, child_edits=0, customized=False,
            is_old=False)
        db.add(child)
        made.append(child)
    if made:
        await db.flush()
        for child in made:
            add_version(db, child, version=parent.version,
                        summary=f"Generated from v{parent.version}", actor_id=actor_id)
    return made


async def save_parent(db: AsyncSession, parent: LabelTemplate, *, design: dict,
                      samples: dict, summary: str | None, actor_id: uuid.UUID | None,
                      child_summary: str | None = None) -> ParentSaveResult:
    """The next parent version: every child without hand edits is
    regenerated from it (a version on each: `child_summary`, else
    "Generated from v<n>"); customized children are left exactly as they
    are and come back as out of date. When only the samples change, the
    children are left alone (module docstring). The parent and then its
    children are locked first, so the children regenerated are the ones
    without hand edits as of this save, not as of an earlier read."""
    await _lock(db, parent)
    design_changed = design != parent.design
    auto = ("Changed sample values" if not design_changed else change_summary(
        parent.design, design, samples_changed=(parent.samples or {}) != (samples or {})))
    parent.design = copy.deepcopy(design)
    parent.samples = dict(samples or {})
    parent.version += 1
    parent.updated_at = _now()
    add_version(db, parent, version=parent.version, summary=summary or auto,
                actor_id=actor_id)
    if not design_changed:
        return {"out_of_date": []}
    out_of_date: list[uuid.UUID] = []
    for child in await children_of(db, parent, include_old=False, for_update=True):
        if child.customized:
            if is_out_of_date(child, parent.version):
                out_of_date.append(child.id)
            continue
        child.design = copy.deepcopy(design)
        child.generated_from_version = parent.version
        child.version += 1
        child.updated_at = _now()
        add_version(db, child, version=parent.version,
                    summary=child_summary or f"Generated from v{parent.version}",
                    actor_id=actor_id)
    return {"out_of_date": out_of_date}


async def save_child(db: AsyncSession, child: LabelTemplate, *, design: dict,
                     summary: str | None, actor_id: uuid.UUID | None) -> None:
    """A hand edit of one DPI: the child is customized from now on. The
    child is locked and re-read first, so an edit lands on top of a parent
    save that regenerated it meanwhile (its version and its key count on
    from that save)."""
    if child.parent_id is None:
        raise NotAChild()
    await _lock(db, child)
    auto = change_summary(child.design, design)
    child.design = copy.deepcopy(design)
    child.customized = True
    child.child_edits += 1
    child.version += 1
    child.updated_at = _now()
    add_version(db, child, version=child.generated_from_version or 0,
                child_edits=child.child_edits, summary=summary or auto, actor_id=actor_id)


async def free_old_name(db: AsyncSession, name: str) -> str:
    """"<name> Old", or the first free "<name> Old 2", " Old 3", …"""
    base = f"{name} Old"
    candidate, n = base, 1
    while await name_taken(db, candidate):
        n += 1
        candidate = f"{base} {n}"
    return candidate


async def _old_name(db: AsyncSession, parent: LabelTemplate, dpi: str) -> str:
    return await free_old_name(db, child_name(parent.name, dpi))


async def current_child(db: AsyncSession, parent: LabelTemplate,
                        dpi: str) -> LabelTemplate | None:
    return await db.scalar(select(LabelTemplate).where(
        LabelTemplate.parent_id == parent.id, LabelTemplate.dpi_key == dpi,
        LabelTemplate.is_old.is_(False)))


async def update_from_parent(db: AsyncSession, child: LabelTemplate,
                             actor_id: uuid.UUID | None) -> tuple[LabelTemplate, bool]:
    """Keep the customized child as "… Old" (nested, inactive) and generate
    a fresh child at its DPI from the parent's current design. Returns
    (the fresh child, whether this call made it): the parent and then the
    child row are locked and re-read first (the order every save takes
    them in), so the fresh child copies the parent's design as of now, even
    when a parent save was in flight, and a second call — a double click,
    or one that waited on the first — finds the child already Old and gets
    the same fresh child back."""
    parent = await parent_of(db, child)
    await _lock(db, parent)
    await db.execute(select(LabelTemplate).where(LabelTemplate.id == child.id)
                     .with_for_update().execution_options(populate_existing=True))
    if child.is_old:
        fresh = await current_child(db, parent, child.dpi_key)
        if fresh is not None:
            return fresh, False
        raise NotCustomized()
    if not child.customized:
        raise NotCustomized()
    child.name = await _old_name(db, parent, child.dpi_key)
    child.is_old, child.is_active, child.updated_at = True, False, _now()
    if child.dpi_key not in parent.dpis:
        parent.dpis = _dpi_order([*parent.dpis, child.dpi_key])
    await db.flush()
    (fresh,) = [c for c in await generate_children(db, parent, actor_id=actor_id)
                if c.dpi_key == child.dpi_key]
    if fresh.is_active:
        await guard_active(db, [fresh])
    return fresh, True


async def rename_parent(db: AsyncSession, parent: LabelTemplate, name: str) -> None:
    """A parent's new name, carried to its children ("· <dpi>", "Old n")."""
    children = await children_of(db, parent)
    renames: dict[uuid.UUID, str] = {}
    for c in children:
        suffix = c.name[len(parent.name):] if c.name.startswith(parent.name) else (
            f"{SEPARATOR}{c.dpi_key}" + (" Old" if c.is_old else ""))
        renames[c.id] = f"{name}{suffix}"
    ours = {parent.id, *renames}
    for new in [name, *renames.values()]:
        other = await db.scalar(select(LabelTemplate.id).where(LabelTemplate.name == new))
        if other is not None and other not in ours:
            raise NameTaken(name=new)
    # two steps (unique names, whatever order the UPDATEs run in): every row
    # of the tree to a placeholder first, then to its new name
    for row in (parent, *children):
        row.name = str(row.id)
    await db.flush()
    parent.name, parent.updated_at = name, _now()
    for c in children:
        c.name, c.updated_at = renames[c.id], _now()


async def lock_for_rename(db: AsyncSession, row: LabelTemplate) -> None:
    """Rename… is for an inactive template (the PATCH route's rule): lock
    the row and re-read it, so an activation committed since the request
    read it counts, and refuse with TemplateActive while it is on."""
    await _lock(db, row)
    if row.is_active:
        raise TemplateActive()


async def record_rename(db: AsyncSession, parent: LabelTemplate, before: str,
                        actor_id: uuid.UUID | None) -> None:
    """A parent's rename as its next version ("Renamed from <before>"),
    the design unchanged, so no child goes out of date. The parent is
    locked first, like a save, so the version number is its own."""
    await _lock(db, parent)
    parent.version += 1
    parent.updated_at = _now()
    add_version(db, parent, version=parent.version, summary=f"Renamed from {before}",
                actor_id=actor_id)


async def set_parent_fields(db: AsyncSession, parent: LabelTemplate, values: dict) -> None:
    """label_type / size_key / language_key on a parent and every child."""
    rows = [parent, *await children_of(db, parent)]
    for row in rows:
        for field, value in values.items():
            setattr(row, field, value)
        row.updated_at = _now()


# ── DPIs ────────────────────────────────────────────────────────────

async def add_dpi(db: AsyncSession, parent: LabelTemplate, dpi: str, *,
                  actor_id: uuid.UUID | None = None) -> LabelTemplate:
    if not parent.is_tree_parent:
        raise NotAParent()
    if dpi not in TREE_DPIS:
        raise BadDpi(dpi=dpi, allowed=list(TREE_DPIS))
    if dpi in await current_dpis(db, parent):
        raise DpiExists(dpi=dpi)
    parent.dpis = _dpi_order([*parent.dpis, dpi])
    parent.updated_at = _now()
    made = await generate_children(db, parent, actor_id=actor_id)
    await guard_active(db, made)
    return next(c for c in made if c.dpi_key == dpi)


async def _delete_rows(db: AsyncSession, ids: list[uuid.UUID]) -> int:
    """Delete templates and the labels generated from them (regenerable);
    versions, site links and children go by cascade. Returns the label
    count."""
    gone = await db.execute(delete(GeneratedLabel).where(GeneratedLabel.template_id.in_(ids)))
    await db.execute(delete(LabelTemplate).where(LabelTemplate.id.in_(ids)))
    return gone.rowcount or 0


async def delete_child(db: AsyncSession, child: LabelTemplate) -> DeleteSummary:
    """Delete one DPI: a current child also leaves the parent's DPI set
    (Add DPI brings it back); an Old child just goes."""
    parent = await parent_of(db, child)
    if not child.is_old:
        parent.dpis = [d for d in parent.dpis if d != child.dpi_key]
        parent.updated_at = _now()
    count = await _delete_rows(db, [child.id])
    return {"children": [], "generated_labels": count}


async def delete_parent(db: AsyncSession, parent: LabelTemplate,
                        typed_name: str | None) -> DeleteSummary:
    """Delete a top-level template, its children and every label generated
    from them — only when `typed_name` is exactly its name."""
    if parent.parent_id is not None:
        raise NotAParent()
    summary = await delete_summary(db, parent)
    if typed_name != parent.name:
        raise NameMismatch(**summary)
    ids = [parent.id, *(c.id for c in await children_of(db, parent))]
    await _delete_rows(db, ids)
    return summary


# ── clone, restore, replace ─────────────────────────────────────────

async def clone(db: AsyncSession, source: LabelTemplate, new_name: str,
                actor_id: uuid.UUID | None) -> LabelTemplate:
    """A new, inactive template copied from a top-level one: design,
    samples, DPI set, site links and (for a parent) its current children,
    customizations and all. Versions start again at v1."""
    if source.parent_id is not None:
        raise NotAParent()
    children = await children_of(db, source, include_old=False) if source.is_tree_parent else []
    await _require_free(db, [new_name, *(child_name(new_name, c.dpi_key) for c in children)])
    copy_row = LabelTemplate(
        name=new_name, description=source.description, label_type=source.label_type,
        size_key=source.size_key, dpi_key=source.dpi_key, language_key=source.language_key,
        kind=source.kind, design=copy.deepcopy(source.design), code=source.code, version=1,
        is_active=False, generation_rules=copy.deepcopy(source.generation_rules or {}),
        schema_version=source.schema_version, samples=copy.deepcopy(source.samples or {}),
        dpis=list(source.dpis or []), generated_from_version=None, child_edits=0,
        customized=False, is_old=False)
    db.add(copy_row)
    await db.flush()
    for (sid,) in (await db.execute(select(LabelTemplateSite.site_id).where(
            LabelTemplateSite.template_id == source.id))).all():
        db.add(LabelTemplateSite(template_id=copy_row.id, site_id=sid))
    summary = f"Cloned from {source.name}"
    add_version(db, copy_row, version=1, summary=summary, actor_id=actor_id)
    made = []
    for c in children:
        made.append(LabelTemplate(
            name=child_name(new_name, c.dpi_key), description="", label_type=c.label_type,
            size_key=c.size_key, dpi_key=c.dpi_key, language_key=c.language_key,
            kind="design", design=copy.deepcopy(c.design), code=None, version=1,
            is_active=False, generation_rules={}, parent_id=copy_row.id, schema_version=2,
            samples={}, dpis=[c.dpi_key], generated_from_version=1, child_edits=0,
            customized=c.customized, is_old=False))
    db.add_all(made)
    await db.flush()
    for child in made:
        add_version(db, child, version=1, summary=summary, actor_id=actor_id)
    if copy_row.is_tree_parent:
        await generate_children(db, copy_row, actor_id=actor_id)  # any DPI the source lacked
    return copy_row


async def restore(db: AsyncSession, template: LabelTemplate, version: int, child_edits: int,
                  actor_id: uuid.UUID | None) -> ParentSaveResult:
    """Save an older version again as the next one."""
    row = await get_version(db, template, version, child_edits)
    summary = f"Restored {version_label(version, child_edits)}"
    result: ParentSaveResult = {"out_of_date": []}
    if template.is_tree_parent:
        result = await save_parent(db, template, design=row.design, samples=row.samples,
                                   summary=summary, actor_id=actor_id)
    elif template.parent_id is not None:
        await save_child(db, template, design=row.design, summary=summary, actor_id=actor_id)
    else:
        template.kind = "design" if row.design is not None else "code"
        template.design = copy.deepcopy(row.design)
        template.code = row.code
        template.version += 1
        template.updated_at = _now()
        add_version(db, template, version=template.version, summary=summary,
                    actor_id=actor_id)
    if template.is_active:
        await guard_active(db, await printing_rows(db, template))
    return result


async def replace(db: AsyncSession, new: LabelTemplate, old_template_ids: list[uuid.UUID],
                  actor_id: uuid.UUID | None) -> tuple[list[LabelTemplate], list[LabelTemplate]]:
    """Replace…: deactivate the old rows (a parent with its children) and
    activate `new` (with its current children) in one transaction, under
    the one-active guard — on a conflict nothing is kept. Old ids name
    top-level templates (a child among them is ChildFollowsParent).
    Returns (rows turned off, rows turned on)."""
    if new.parent_id is not None:
        raise NotAParent()
    own = {new.id, *(c.id for c in await children_of(db, new))}
    olds: list[LabelTemplate] = []
    missing: list[str] = []
    for tid in dict.fromkeys(old_template_ids):
        row = await db.get(LabelTemplate, tid)
        if row is None or tid in own:
            missing.append(str(tid))
        else:
            olds.append(row)
    if missing:
        raise UnknownTemplates(ids=missing)
    off: list[LabelTemplate] = []
    for old in olds:
        off.extend(await deactivate(db, old))
    on = await activate(db, new)
    return off, on
