"""Initiatives — unified V2 projects/events/moves (one entity, an
initiative_type vocabulary field, nullable move-only block). Internal-only
resource for this slice; all actors are globally anchored. People
assignments and initiative↔initiative links live here too (the
initiative is the aggregate root)."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    InitiativeCreateIn, InitiativeDetailOut, InitiativeItem,
    InitiativeLinkAddIn, InitiativeLinkRow, InitiativeLinksOut,
    InitiativeLinkUpdateIn, InitiativePersonAddIn, InitiativePersonRow,
    InitiativePersonUpdateIn, InitiativeUpdateIn,
)
from serversherpa.db.models import (
    Client, Initiative, InitiativeLink, InitiativePerson, Partner, Person,
    Site, StatusValue,
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
    if await db.scalar(select(InitiativePerson.id).where(
            InitiativePerson.initiative_id == initiative_id,
            InitiativePerson.person_id == data["person_id"])) is not None:
        raise _err(409, "duplicate_person")
    db.add(InitiativePerson(initiative_id=initiative_id, **data))
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="person_add",
          changes={"person_id": {"from": None,
                                 "to": str(data["person_id"])}})
    await db.commit()
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
    if await db.scalar(select(InitiativeLink.id).where(
            InitiativeLink.parent_id == initiative_id,
            InitiativeLink.child_id == body.child_id)) is not None:
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
    await db.commit()
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
