"""Initiatives — unified V2 projects/events/moves (one entity, an
initiative_type vocabulary field, nullable move-only block). Internal-only
resource for this slice; all actors are globally anchored. People
assignments and initiative↔initiative links live here too (the
initiative is the aggregate root)."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    InitiativeAssetOut, InitiativeAssetsAddIn, InitiativeAssetSummary,
    InitiativeAssetUpdateIn, InitiativeCreateIn, InitiativeDetailOut,
    InitiativeItem, InitiativeLinkAddIn, InitiativeLinkRow,
    InitiativeLinksOut, InitiativeLinkUpdateIn, InitiativePersonAddIn,
    InitiativePersonRow, InitiativePersonUpdateIn, InitiativeUpdateIn,
)
from serversherpa.db.models import (
    Asset, AssetModel, Client, Initiative, InitiativeAsset, InitiativeLink,
    InitiativePerson, Partner, Person, Site, StatusValue,
)
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/initiatives", tags=["initiatives"])

PARTNER_FIELDS = (
    "shipping_partner_id",
    "origin_tech_partner_id", "origin_cable_partner_id",
    "origin_logistics_partner_id",
    "destination_tech_partner_id", "destination_cable_partner_id",
    "destination_logistics_partner_id",
)
SITE_FIELDS = ("site_id", "origin_site_id", "destination_site_id")
INITIATIVE_FIELDS = [
    "name", "description", "initiative_type", "sub_type", "status",
    "client_id", "site_id", "location", "scheduled_start", "scheduled_end",
    "sky_command_project_id", "origin_site_id", "destination_site_id",
    "real_start_at", "real_end_at", "priority_devices", "shipping_types",
    "origin_vendor_involved", "destination_vendor_involved",
    *PARTNER_FIELDS,
]
NON_NULLABLE_FIELDS = ("name", "initiative_type", "status")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _get_initiative(db: DbSession,
                          initiative_id: uuid.UUID) -> Initiative:
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None:
        raise _err(404, "initiative_not_found")
    return initiative


async def _vocab(db: DbSession) -> dict[str, dict]:
    """{record_type: {key: (label, color)}} for the three chip vocabularies."""
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(
            ("initiative", "initiative_type", "initiative_sub_type"))))).all()
    out: dict[str, dict] = {"initiative": {}, "initiative_type": {},
                            "initiative_sub_type": {}}
    for s in rows:
        out[s.record_type][s.key] = (s.label, s.color)
    return out


async def _context(db: DbSession, initiatives: list[Initiative]) -> tuple:
    vocab = await _vocab(db)
    site_ids = {getattr(i, f) for i in initiatives for f in SITE_FIELDS
                if getattr(i, f)}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    client_ids = {i.client_id for i in initiatives if i.client_id}
    clients = dict((await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(client_ids))
    )).all()) if client_ids else {}
    partner_ids = {i.shipping_partner_id for i in initiatives
                   if i.shipping_partner_id}
    partners = dict((await db.execute(
        select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids))
    )).all()) if partner_ids else {}
    ids = [i.id for i in initiatives]
    people_counts = dict((await db.execute(
        select(InitiativePerson.initiative_id, func.count())
        .where(InitiativePerson.initiative_id.in_(ids))
        .group_by(InitiativePerson.initiative_id)
    )).all()) if ids else {}
    child_counts = dict((await db.execute(
        select(InitiativeLink.parent_id, func.count())
        .where(InitiativeLink.parent_id.in_(ids))
        .group_by(InitiativeLink.parent_id)
    )).all()) if ids else {}
    parent_counts = dict((await db.execute(
        select(InitiativeLink.child_id, func.count())
        .where(InitiativeLink.child_id.in_(ids))
        .group_by(InitiativeLink.child_id)
    )).all()) if ids else {}
    link_counts = {i: child_counts.get(i, 0) + parent_counts.get(i, 0)
                   for i in ids}
    return vocab, sites, clients, partners, people_counts, link_counts


def _item(i: Initiative, vocab: dict, sites: dict, clients: dict,
          partners: dict, people_counts: dict, link_counts: dict) -> dict:
    s_label, s_color = vocab["initiative"].get(
        i.status, (i.status, "#51606f"))
    t_label, t_color = vocab["initiative_type"].get(
        i.initiative_type, (i.initiative_type, "#51606f"))
    st_label, st_color = (vocab["initiative_sub_type"].get(
        i.sub_type, (i.sub_type, "#51606f"))
        if i.sub_type is not None else (None, None))
    return {
        "id": i.id, "name": i.name, "description": i.description,
        "initiative_type": i.initiative_type,
        "type_label": t_label, "type_color": t_color,
        "sub_type": i.sub_type,
        "sub_type_label": st_label, "sub_type_color": st_color,
        "status": i.status, "status_label": s_label, "status_color": s_color,
        "client_id": i.client_id, "client_name": clients.get(i.client_id),
        "site_id": i.site_id, "site_name": sites.get(i.site_id),
        "location": i.location,
        "scheduled_start": i.scheduled_start,
        "scheduled_end": i.scheduled_end,
        "sky_command_project_id": i.sky_command_project_id,
        "origin_site_id": i.origin_site_id,
        "origin_site_name": sites.get(i.origin_site_id),
        "destination_site_id": i.destination_site_id,
        "destination_site_name": sites.get(i.destination_site_id),
        "real_start_at": i.real_start_at, "real_end_at": i.real_end_at,
        "priority_devices": i.priority_devices,
        "shipping_types": i.shipping_types or [],
        "shipping_partner_id": i.shipping_partner_id,
        "shipping_partner_name": partners.get(i.shipping_partner_id),
        "origin_tech_partner_id": i.origin_tech_partner_id,
        "origin_cable_partner_id": i.origin_cable_partner_id,
        "origin_logistics_partner_id": i.origin_logistics_partner_id,
        "destination_tech_partner_id": i.destination_tech_partner_id,
        "destination_cable_partner_id": i.destination_cable_partner_id,
        "destination_logistics_partner_id": i.destination_logistics_partner_id,
        "origin_vendor_involved": i.origin_vendor_involved,
        "destination_vendor_involved": i.destination_vendor_involved,
        "people_count": people_counts.get(i.id, 0),
        "links_count": link_counts.get(i.id, 0),
        "archived_at": i.archived_at, "created_at": i.created_at,
    }


async def _people_rows(db: DbSession,
                       initiative_id: uuid.UUID) -> list[InitiativePersonRow]:
    rows = (await db.execute(
        select(InitiativePerson, Person)
        .join(Person, Person.id == InitiativePerson.person_id)
        .where(InitiativePerson.initiative_id == initiative_id)
        .order_by(InitiativePerson.created_at))).all()
    work_types = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(
            StatusValue.record_type == "initiative_work_type"))}
    site_ids = {m.site_worked_id for m, _ in rows if m.site_worked_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    out = []
    for m, person in rows:
        wt_label, wt_color = (work_types.get(m.work_type,
                                             (m.work_type, "#51606f"))
                              if m.work_type is not None else (None, None))
        out.append(InitiativePersonRow(
            id=m.id, person_id=person.id,
            person_name=f"{person.first_name} {person.last_name}",
            work_type=m.work_type,
            work_type_label=wt_label, work_type_color=wt_color,
            site_worked_id=m.site_worked_id,
            site_worked_name=sites.get(m.site_worked_id),
            rating=m.rating, created_at=m.created_at))
    return out


async def _link_rows(
    db: DbSession, initiative_id: uuid.UUID,
) -> tuple[list[InitiativeLinkRow], list[InitiativeLinkRow]]:
    vocab = await _vocab(db)

    def row(link: InitiativeLink, other: Initiative) -> InitiativeLinkRow:
        t_label, t_color = vocab["initiative_type"].get(
            other.initiative_type, (other.initiative_type, "#51606f"))
        s_label, s_color = vocab["initiative"].get(
            other.status, (other.status, "#51606f"))
        return InitiativeLinkRow(
            id=link.id, other_id=other.id, other_name=other.name,
            other_type=other.initiative_type,
            other_type_label=t_label, other_type_color=t_color,
            other_status_label=s_label, other_status_color=s_color,
            role=link.role, sort_order=link.sort_order, notes=link.notes,
            created_at=link.created_at)

    children = (await db.execute(
        select(InitiativeLink, Initiative)
        .join(Initiative, Initiative.id == InitiativeLink.child_id)
        .where(InitiativeLink.parent_id == initiative_id)
        .order_by(InitiativeLink.sort_order, InitiativeLink.created_at))).all()
    parents = (await db.execute(
        select(InitiativeLink, Initiative)
        .join(Initiative, Initiative.id == InitiativeLink.parent_id)
        .where(InitiativeLink.child_id == initiative_id)
        .order_by(InitiativeLink.sort_order, InitiativeLink.created_at))).all()
    return ([row(l, o) for l, o in children],
            [row(l, o) for l, o in parents])


async def _detail(db: DbSession, initiative: Initiative) -> InitiativeDetailOut:
    ctx = await _context(db, [initiative])
    children, parents = await _link_rows(db, initiative.id)
    return InitiativeDetailOut(
        **_item(initiative, *ctx),
        people=await _people_rows(db, initiative.id),
        links_children=children, links_parents=parents)


@router.get("", response_model=list[InitiativeItem])
async def list_initiatives(
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> list[InitiativeItem]:
    initiatives = list(await db.scalars(
        select(Initiative).order_by(Initiative.created_at.desc())))
    ctx = await _context(db, initiatives)
    return [InitiativeItem(**_item(i, *ctx)) for i in initiatives]


@router.get("/{initiative_id}", response_model=InitiativeDetailOut)
async def get_initiative(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> InitiativeDetailOut:
    return await _detail(db, await _get_initiative(db, initiative_id))


async def _check_refs(db: DbSession, data: dict) -> None:
    if data.get("client_id") is not None and \
            await db.get(Client, data["client_id"]) is None:
        raise _err(422, "client_not_found")
    for field in SITE_FIELDS:
        if data.get(field) is not None and \
                await db.get(Site, data[field]) is None:
            raise _err(422, "site_not_found", field=field)
    for field in PARTNER_FIELDS:
        if data.get(field) is not None and \
                await db.get(Partner, data[field]) is None:
            raise _err(422, "partner_not_found", field=field)
    for field, record_type, code in (
        ("status", "initiative", "unknown_status"),
        ("initiative_type", "initiative_type", "unknown_initiative_type"),
        ("sub_type", "initiative_sub_type", "unknown_sub_type"),
    ):
        if data.get(field) is not None and await db.scalar(
            select(StatusValue).where(
                StatusValue.record_type == record_type,
                StatusValue.key == data[field])) is None:
            raise _err(422, code)
    if data.get("shipping_types"):
        keys = set(await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "shipping_type")))
        if unknown := [s for s in data["shipping_types"] if s not in keys]:
            raise _err(422, "unknown_shipping_type", values=unknown)


@router.post("", response_model=InitiativeDetailOut, status_code=201)
async def create_initiative(
    body: InitiativeCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> InitiativeDetailOut:
    data = body.model_dump(exclude_none=True)
    if not data.get("name"):
        raise _err(422, "name_required")
    await _check_refs(db, data)
    initiative = Initiative(**data, created_by=actor.person.id)
    db.add(initiative)
    await db.flush()
    initial = snapshot(initiative, INITIATIVE_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items()
               if value not in (None, "", [])}
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, initiative)


@router.patch("/{initiative_id}", response_model=InitiativeDetailOut)
async def update_initiative(
    initiative_id: uuid.UUID,
    body: InitiativeUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeDetailOut:
    initiative = await _get_initiative(db, initiative_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and not data[field]:
            raise _err(422, f"{field}_required")
    # Changing initiative_type after creation is admin-and-up only.
    if data.get("initiative_type") not in (None, initiative.initiative_type) \
            and actor.access.max_rank < GATE_BYPASS_RANK:
        raise _err(403, "type_change_forbidden")
    await _check_refs(db, data)

    fields = list(data.keys())
    before = snapshot(initiative, fields)
    for field, value in data.items():
        setattr(initiative, field, value)
    changes = diff(before, snapshot(initiative, fields))
    if changes:
        initiative.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="initiative",
              entity_id=str(initiative_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, initiative)


@router.post("/{initiative_id}/archive", status_code=204)
async def archive_initiative(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    initiative = await _get_initiative(db, initiative_id)
    initiative.archived_at = datetime.now(UTC)
    initiative.updated_at = initiative.archived_at
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="archive")
    await db.commit()


@router.post("/{initiative_id}/unarchive", status_code=204)
async def unarchive_initiative(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    initiative = await _get_initiative(db, initiative_id)
    initiative.archived_at = None
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="restore")
    await db.commit()


async def _person_assigned(db: DbSession, initiative_id: uuid.UUID,
                           person_id: uuid.UUID) -> bool:
    return await db.scalar(select(InitiativePerson.id).where(
        InitiativePerson.initiative_id == initiative_id,
        InitiativePerson.person_id == person_id)) is not None


async def _check_person_refs(db: DbSession, data: dict) -> None:
    if data.get("work_type") is not None and await db.scalar(
        select(StatusValue).where(
            StatusValue.record_type == "initiative_work_type",
            StatusValue.key == data["work_type"])) is None:
        raise _err(422, "unknown_work_type")
    if data.get("site_worked_id") is not None and \
            await db.get(Site, data["site_worked_id"]) is None:
        raise _err(422, "site_not_found", field="site_worked_id")
    if data.get("rating") is not None and not 1 <= data["rating"] <= 5:
        raise _err(422, "rating_out_of_range")


@router.get("/{initiative_id}/people",
            response_model=list[InitiativePersonRow])
async def list_initiative_people(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> list[InitiativePersonRow]:
    await _get_initiative(db, initiative_id)
    return await _people_rows(db, initiative_id)


@router.post("/{initiative_id}/people",
             response_model=list[InitiativePersonRow], status_code=201)
async def add_initiative_person(
    initiative_id: uuid.UUID,
    body: InitiativePersonAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> list[InitiativePersonRow]:
    initiative = await _get_initiative(db, initiative_id)
    data = body.model_dump(exclude_none=True)
    if await db.get(Person, data["person_id"]) is None:
        raise _err(422, "person_not_found")
    await _check_person_refs(db, data)
    if await _person_assigned(db, initiative_id, data["person_id"]):
        raise _err(409, "duplicate_person")
    db.add(InitiativePerson(initiative_id=initiative_id, **data))
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="person_add",
          changes={"person_id": {"from": None,
                                 "to": str(data["person_id"])}})
    try:
        await db.commit()
    except IntegrityError:
        # lost the check-then-insert race against a concurrent add of the
        # same (initiative, person) pair — initiative_people_uniq fired
        await db.rollback()
        raise _err(409, "duplicate_person") from None
    return await _people_rows(db, initiative_id)


async def _get_assignment(db: DbSession,
                          assoc_id: uuid.UUID) -> InitiativePerson:
    assoc = await db.get(InitiativePerson, assoc_id)
    if assoc is None:
        raise _err(404, "assignment_not_found")
    return assoc


@router.patch("/people/{assoc_id}", response_model=InitiativePersonRow)
async def update_initiative_person(
    assoc_id: uuid.UUID,
    body: InitiativePersonUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativePersonRow:
    assoc = await _get_assignment(db, assoc_id)
    data = body.model_dump(exclude_unset=True)
    await _check_person_refs(db, data)

    fields = list(data.keys())
    before = snapshot(assoc, fields)
    for field, value in data.items():
        setattr(assoc, field, value)
    changes = diff(before, snapshot(assoc, fields))
    if changes:
        assoc.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="initiative",
              entity_id=str(assoc.initiative_id), action="person_update",
              changes=changes)
    await db.commit()
    rows = await _people_rows(db, assoc.initiative_id)
    return next(r for r in rows if r.id == assoc_id)


@router.delete("/people/{assoc_id}", status_code=204)
async def remove_initiative_person(
    assoc_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    assoc = await _get_assignment(db, assoc_id)
    initiative_id = assoc.initiative_id
    person_id = assoc.person_id
    await db.delete(assoc)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="person_remove",
          changes={"person_id": {"from": str(person_id), "to": None}})
    await db.commit()


# Advisory-lock key serializing all link-graph mutations (one key for the
# whole graph, not per edge pair: two concurrent inserts of *different*
# edges can still close a cycle through existing links).
LINK_GRAPH_LOCK_KEY = 0x696E6C6B  # "inlk"


async def _link_exists(db: DbSession, parent_id: uuid.UUID,
                       child_id: uuid.UUID) -> bool:
    return await db.scalar(select(InitiativeLink.id).where(
        InitiativeLink.parent_id == parent_id,
        InitiativeLink.child_id == child_id)) is not None


async def _ancestor_ids(db: DbSession, start: uuid.UUID) -> set[uuid.UUID]:
    """Every initiative above `start` in the link graph (transitive)."""
    seen: set[uuid.UUID] = set()
    frontier = [start]
    while frontier:
        parents = list(await db.scalars(
            select(InitiativeLink.parent_id)
            .where(InitiativeLink.child_id.in_(frontier))))
        frontier = [p for p in parents if p not in seen]
        seen.update(frontier)
    return seen


@router.get("/{initiative_id}/links", response_model=InitiativeLinksOut)
async def list_initiative_links(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> InitiativeLinksOut:
    await _get_initiative(db, initiative_id)
    children, parents = await _link_rows(db, initiative_id)
    return InitiativeLinksOut(children=children, parents=parents)


@router.post("/{initiative_id}/links", response_model=InitiativeDetailOut,
             status_code=201)
async def add_initiative_link(
    initiative_id: uuid.UUID,
    body: InitiativeLinkAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeDetailOut:
    initiative = await _get_initiative(db, initiative_id)
    if body.child_id == initiative_id:
        raise _err(422, "self_link")
    if await db.get(Initiative, body.child_id) is None:
        raise _err(422, "initiative_not_found")
    # serialize check+insert against concurrent link adds — two in-flight
    # inserts can each pass the cycle check below and jointly close a cycle;
    # the xact lock releases on commit/rollback (get_db rolls back on error)
    await db.execute(select(func.pg_advisory_xact_lock(LINK_GRAPH_LOCK_KEY)))
    if await _link_exists(db, initiative_id, body.child_id):
        raise _err(409, "duplicate_link")
    # cycle: the proposed child must not already be an ancestor of parent
    if body.child_id in await _ancestor_ids(db, initiative_id):
        raise _err(422, "circular_link")
    db.add(InitiativeLink(parent_id=initiative_id,
                          **body.model_dump(exclude_none=True)))
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="link_add",
          changes={"child_id": {"from": None, "to": str(body.child_id)}})
    try:
        await db.commit()
    except IntegrityError:
        # defense-in-depth: initiative_links_uniq fired despite the lock
        # (e.g. an edge written outside this route)
        await db.rollback()
        raise _err(409, "duplicate_link") from None
    return await _detail(db, initiative)


async def _get_link(db: DbSession, link_id: uuid.UUID) -> InitiativeLink:
    link = await db.get(InitiativeLink, link_id)
    if link is None:
        raise _err(404, "link_not_found")
    return link


@router.patch("/links/{link_id}", response_model=InitiativeLinkRow)
async def update_initiative_link(
    link_id: uuid.UUID,
    body: InitiativeLinkUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeLinkRow:
    link = await _get_link(db, link_id)
    data = body.model_dump(exclude_unset=True)
    fields = list(data.keys())
    before = snapshot(link, fields)
    for field, value in data.items():
        setattr(link, field, value)
    changes = diff(before, snapshot(link, fields))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="initiative",
              entity_id=str(link.parent_id), action="link_update",
              changes=changes)
    await db.commit()
    children, _ = await _link_rows(db, link.parent_id)
    return next(r for r in children if r.id == link_id)


@router.delete("/links/{link_id}", status_code=204)
async def remove_initiative_link(
    link_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    link = await _get_link(db, link_id)
    parent_id, child_id = link.parent_id, link.child_id
    await db.delete(link)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(parent_id), action="link_remove",
          changes={"child_id": {"from": str(child_id), "to": None}})
    await db.commit()


# ── move assets ────────────────────────────────────────────────────
# Per-move asset roster (V2 moves_assets_list parity). Assets reach a move
# only via the future bulk-import script or dev seeding — no interactive
# picker, ever (design decision). This route exposes the attach endpoint
# for that script plus the roster CRUD the Full Details page needs.

NULLABLE_TEXT_ASSET_FIELDS = (
    "priority_wave", "disposition", "owner", "source_rack",
    "source_position", "destination_rack", "destination_position",
    "cable_info",
)


async def _initiative_asset_rows(
    db: DbSession, initiative_id: uuid.UUID,
) -> list[InitiativeAssetOut]:
    rows = (await db.execute(
        select(InitiativeAsset, Asset)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .where(InitiativeAsset.initiative_id == initiative_id)
        .order_by(InitiativeAsset.priority_wave.nullslast(),
                  Asset.serial_number))).all()
    # one merged vocabulary (0022) labels both the roster row's own
    # status and the embedded asset's status
    statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}
    model_ids = {a.model_id for _, a in rows if a.model_id}
    models = {m.id: m for m in await db.scalars(
        select(AssetModel).where(AssetModel.id.in_(model_ids)))} \
        if model_ids else {}
    client_ids = {a.client_id for _, a in rows if a.client_id}
    clients = dict((await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(client_ids))
    )).all()) if client_ids else {}

    out = []
    for ia, asset in rows:
        s_label, s_color = statuses.get(ia.status, (ia.status, "#51606f"))
        a_label, a_color = statuses.get(asset.status,
                                              (asset.status, "#51606f"))
        model = models.get(asset.model_id)
        out.append(InitiativeAssetOut(
            id=ia.id, asset_id=ia.asset_id,
            priority_wave=ia.priority_wave, disposition=ia.disposition,
            owner=ia.owner, source_rack=ia.source_rack,
            source_ru=ia.source_ru, source_verified=ia.source_verified,
            source_position=ia.source_position,
            destination_rack=ia.destination_rack,
            destination_ru=ia.destination_ru,
            destination_verified=ia.destination_verified,
            destination_position=ia.destination_position,
            cable_info=ia.cable_info, vendor_involved=ia.vendor_involved,
            status=ia.status, status_label=s_label, status_color=s_color,
            created_at=ia.created_at, updated_at=ia.updated_at,
            asset=InitiativeAssetSummary(
                id=asset.id, legacy_id=asset.legacy_id,
                serial_number=asset.serial_number, name=asset.name,
                rfid_tag=asset.rfid_tag,
                model_make=model.make if model else None,
                model_name=model.model if model else None,
                ru_size=model.ru_size if model else None,
                location_detail=asset.location_detail,
                client_name=clients.get(asset.client_id),
                status=asset.status, status_label=a_label,
                status_color=a_color)))
    return out


@router.get("/{initiative_id}/assets", response_model=list[InitiativeAssetOut])
async def list_initiative_assets(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "view"),
) -> list[InitiativeAssetOut]:
    await _get_initiative(db, initiative_id)
    return await _initiative_asset_rows(db, initiative_id)


async def _already_attached(
    db: DbSession, initiative_id: uuid.UUID, asset_ids: list[uuid.UUID],
) -> set[uuid.UUID]:
    return set(await db.scalars(select(InitiativeAsset.asset_id).where(
        InitiativeAsset.initiative_id == initiative_id,
        InitiativeAsset.asset_id.in_(asset_ids))))


@router.post("/{initiative_id}/assets", response_model=list[InitiativeAssetOut],
             status_code=201)
async def add_initiative_assets(
    initiative_id: uuid.UUID,
    body: InitiativeAssetsAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> list[InitiativeAssetOut]:
    initiative = await _get_initiative(db, initiative_id)
    if initiative.initiative_type != "move":
        raise _err(422, "not_a_move")
    ids = list(dict.fromkeys(body.asset_ids))  # dedupe, keep order
    if not ids:
        raise _err(422, "asset_ids_required")
    found = set(await db.scalars(select(Asset.id).where(Asset.id.in_(ids))))
    if missing := [i for i in ids if i not in found]:
        raise _err(422, "assets_not_found",
                   asset_ids=[str(i) for i in missing])

    already = await _already_attached(db, initiative_id, ids)
    if already:
        raise _err(409, "assets_already_on_initiative",
                   asset_ids=[str(i) for i in ids if i in already])

    for asset_id in ids:
        db.add(InitiativeAsset(initiative_id=initiative_id, asset_id=asset_id,
                               added_by=actor.person.id))
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="asset_add",
          changes={"asset_ids": {"from": None,
                                 "to": [str(i) for i in ids]}})
    try:
        await db.commit()
    except IntegrityError:
        # lost the check-then-insert race against a concurrent attach of
        # the same (initiative, asset) pair — initiative_assets_uniq fired
        await db.rollback()
        raise _err(409, "assets_already_on_initiative") from None
    return await _initiative_asset_rows(db, initiative_id)


async def _get_initiative_asset(db: DbSession,
                                assoc_id: uuid.UUID) -> InitiativeAsset:
    assoc = await db.get(InitiativeAsset, assoc_id)
    if assoc is None:
        raise _err(404, "asset_assignment_not_found")
    return assoc


def _parse_ru(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise _err(422, "invalid_ru") from None
    if not parsed.is_finite():
        raise _err(422, "invalid_ru") from None
    return parsed


async def _check_asset_status(db: DbSession, data: dict) -> None:
    if "status" in data and (data["status"] is None or await db.scalar(
        select(StatusValue).where(
            StatusValue.record_type == "asset",
            StatusValue.key == data["status"])) is None):
        raise _err(422, "unknown_status")


@router.patch("/assets/{assoc_id}", response_model=InitiativeAssetOut)
async def update_initiative_asset(
    assoc_id: uuid.UUID,
    body: InitiativeAssetUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> InitiativeAssetOut:
    assoc = await _get_initiative_asset(db, assoc_id)
    data = body.model_dump(exclude_unset=True)
    for field in ("source_ru", "destination_ru"):
        if field in data:
            data[field] = _parse_ru(data[field])
    for field in NULLABLE_TEXT_ASSET_FIELDS:
        if data.get(field) == "":
            data[field] = None
    await _check_asset_status(db, data)

    fields = list(data.keys())
    before = snapshot(assoc, fields)
    for field, value in data.items():
        setattr(assoc, field, value)
    changes = diff(before, snapshot(assoc, fields))
    if changes:
        assoc.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="initiative",
              entity_id=str(assoc.initiative_id), action="asset_update",
              changes=changes)
    await db.commit()
    rows = await _initiative_asset_rows(db, assoc.initiative_id)
    return next(r for r in rows if r.id == assoc_id)


@router.delete("/assets/{assoc_id}", status_code=204)
async def remove_initiative_asset(
    assoc_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> None:
    assoc = await _get_initiative_asset(db, assoc_id)
    initiative_id = assoc.initiative_id
    asset_id = assoc.asset_id
    await db.delete(assoc)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="asset_remove",
          changes={"asset_id": {"from": str(asset_id), "to": None}})
    await db.commit()
