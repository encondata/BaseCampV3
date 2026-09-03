"""Tool registry for the AI assistant: JSON schemas the model sees and
the executors that run them UNDER THE CALLER'S PERMISSIONS.

Every executor takes (db, user, args) where user only needs
user.access.can(resource, action) - the same gate the REST routes use.
Executors are read-only by construction and clip results to LIMIT rows
of compact display fields before the model sees them. navigate is
special: the /ai/chat route intercepts it (validate_navigate) and it
never reaches run_tool."""

import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, Client, Initiative, Partner, Person, PersonRole,
    ProcessedScan, Site,
)

LIMIT = 10

PAGES: tuple[str, ...] = (
    "assets", "asset_detail", "initiatives", "initiative_detail",
    "move_load_assets", "workers", "worker_detail", "sites",
    "clients", "client_detail", "partners", "scans",
)
_DETAIL_PAGES = {"asset_detail", "initiative_detail", "move_load_assets",
                 "worker_detail", "client_detail"}

TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "navigate",
        "description": "Open a portal page for the user. The ONLY way to "
                       "take the user somewhere; changes no data. Ids must "
                       "come from a previous tool result - never invented.",
        "parameters": {"type": "object", "properties": {
            "page": {"type": "string", "enum": list(PAGES)},
            "id": {"type": "string", "description":
                   "Record UUID, required for *_detail and "
                   "move_load_assets pages."}},
            "required": ["page"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_moves",
        "description": "Search moves (relocation projects). Returns id, "
                       "name, status. Use before navigating to a move.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string",
                      "description": "Name fragment; omit to list all"},
            "status": {"type": "string",
                       "enum": ["planned", "in_progress", "completed",
                                "any"]}},
            "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_assets",
        "description": "Search assets by serial, name, or RFID with "
                       "optional filters. Returns compact rows.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"},
            "client": {"type": "string"},
            "site": {"type": "string"},
            "status": {"type": "string",
                       "enum": ["active", "in_transit", "in_storage",
                                "decommissioned", "unknown"]}},
            "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_people",
        "description": "Search workers and staff by name.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}},
            "required": ["query"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_sites",
        "description": "Search sites by name or city.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}},
            "required": ["query"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "find_stakeholders",
        "description": "Search clients and partners by name.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}},
            "required": ["query"], "additionalProperties": False}}},
    {"type": "function", "function": {
        "name": "count_records",
        "description": "Count records matching filters. Use for 'how "
                       "many' questions instead of fetching lists.",
        "parameters": {"type": "object", "properties": {
            "entity": {"type": "string",
                       "enum": ["assets", "moves", "workers", "sites",
                                "scans"]},
            "filters": {"type": "object", "properties": {
                "client": {"type": "string"},
                "site": {"type": "string"},
                "status": {"type": "string"},
                "days": {"type": "integer"}},
                "additionalProperties": False}},
            "required": ["entity"], "additionalProperties": False}}},
]


def validate_navigate(args: dict) -> dict:
    page = args.get("page")
    if page not in PAGES:
        raise ValueError(f"unknown page: {page!r}")
    rec_id = args.get("id")
    if page in _DETAIL_PAGES:
        try:
            uuid.UUID(str(rec_id))
        except ValueError:
            raise ValueError(f"page {page} needs a record UUID") from None
        return {"page": page, "id": str(rec_id)}
    return {"page": page, "id": None}


async def _find_moves(db: AsyncSession, args: dict) -> dict:
    q = select(Initiative).where(Initiative.initiative_type == "move")
    status = args.get("status") or "any"
    if status != "any":
        q = q.where(Initiative.status == status)
    if args.get("query"):
        q = q.where(Initiative.name.ilike(f"%{args['query']}%"))
    rows = (await db.scalars(q.order_by(Initiative.name).limit(LIMIT))).all()
    return {"moves": [{"id": str(m.id), "name": m.name, "status": m.status}
                      for m in rows]}


async def _find_assets(db: AsyncSession, args: dict) -> dict:
    q = (select(Asset, AssetModel, Site, Client)
         .outerjoin(AssetModel, Asset.model_id == AssetModel.id)
         .outerjoin(Site, Asset.site_id == Site.id)
         .outerjoin(Client, Asset.client_id == Client.id))
    if args.get("query"):
        needle = f"%{args['query']}%"
        q = q.where(or_(Asset.serial_number.ilike(needle),
                        Asset.name.ilike(needle),
                        Asset.rfid_tag.ilike(needle)))
    if args.get("client"):
        q = q.where(Client.name.ilike(f"%{args['client']}%"))
    if args.get("site"):
        q = q.where(Site.name.ilike(f"%{args['site']}%"))
    if args.get("status"):
        q = q.where(Asset.status == args["status"])
    rows = (await db.execute(q.limit(LIMIT))).all()
    return {"assets": [{
        "id": str(a.id), "serial": a.serial_number, "name": a.name,
        "model": f"{m.make} {m.model}" if m else None,
        "status": a.status, "site": s.name if s else None,
        "client": c.name if c else None,
        "location": a.location_detail or None}
        for a, m, s, c in rows]}


async def _find_people(db: AsyncSession, args: dict) -> dict:
    needle = f"%{args.get('query', '')}%"
    q = (select(Person)
         .where(Person.archived_at.is_(None))
         .where(or_(
             func.concat(Person.first_name, " ", Person.last_name)
             .ilike(needle),
             Person.preferred_name.ilike(needle)))
         .order_by(Person.last_name, Person.first_name).limit(LIMIT))
    rows = (await db.scalars(q)).all()
    return {"people": [{
        "id": str(p.id),
        "name": f"{p.first_name} {p.last_name}",
        "job_title": p.job_title} for p in rows]}


async def _find_sites(db: AsyncSession, args: dict) -> dict:
    needle = f"%{args.get('query', '')}%"
    q = (select(Site)
         .where(or_(Site.name.ilike(needle), Site.city.ilike(needle)))
         .order_by(Site.name).limit(LIMIT))
    rows = (await db.scalars(q)).all()
    return {"sites": [{"id": str(s.id), "name": s.name, "city": s.city}
                      for s in rows]}


async def _find_stakeholders(db: AsyncSession, args: dict) -> dict:
    needle = f"%{args.get('query', '')}%"
    out: list[dict] = []
    clients = (await db.scalars(
        select(Client).where(Client.name.ilike(needle))
        .order_by(Client.name).limit(LIMIT))).all()
    out += [{"id": str(c.id), "name": c.name, "kind": "client"}
            for c in clients]
    partners = (await db.scalars(
        select(Partner).where(Partner.name.ilike(needle))
        .order_by(Partner.name).limit(LIMIT))).all()
    out += [{"id": str(p.id), "name": p.name, "kind": "partner"}
            for p in partners]
    return {"stakeholders": out[:LIMIT]}


async def _count_records(db: AsyncSession, args: dict) -> dict:
    entity = args.get("entity")
    filters = args.get("filters") or {}
    if entity == "assets":
        q = select(func.count(Asset.id))
        if filters.get("client"):
            q = (q.join(Client, Asset.client_id == Client.id)
                 .where(Client.name.ilike(f"%{filters['client']}%")))
        if filters.get("site"):
            q = (q.join(Site, Asset.site_id == Site.id)
                 .where(Site.name.ilike(f"%{filters['site']}%")))
        if filters.get("status"):
            q = q.where(Asset.status == filters["status"])
    elif entity == "moves":
        q = (select(func.count(Initiative.id))
             .where(Initiative.initiative_type == "move"))
        if filters.get("status"):
            q = q.where(Initiative.status == filters["status"])
    elif entity == "workers":
        q = (select(func.count(func.distinct(PersonRole.person_id)))
             .where(PersonRole.role == "worker"))
    elif entity == "sites":
        q = select(func.count(Site.id))
    elif entity == "scans":
        q = select(func.count(ProcessedScan.id))
        if filters.get("days"):
            q = q.where(ProcessedScan.scanned_at
                        >= func.now() - func.make_interval(0, 0, 0,
                                                           filters["days"]))
    else:
        return {"error": f"unknown entity: {entity!r}"}
    return {"count": (await db.scalar(q)) or 0}


# tool name -> (permission resource, executor). navigate is intercepted
# by the route and never dispatched here.
_EXECUTORS = {
    "find_moves": ("initiatives", _find_moves),
    "find_assets": ("assets", _find_assets),
    "find_people": ("workers", _find_people),
    "find_sites": ("sites", _find_sites),
    "find_stakeholders": ("clients", _find_stakeholders),
    "count_records": (None, _count_records),
}

_COUNT_RESOURCES = {"assets": "assets", "moves": "initiatives",
                    "workers": "workers", "sites": "sites",
                    "scans": "scans"}


async def run_tool(name: str, args: dict, db: AsyncSession, user) -> dict:
    entry = _EXECUTORS.get(name)
    if entry is None:
        return {"error": f"unknown tool: {name!r}"}
    resource, fn = entry
    if resource is None:  # count_records gates per entity
        resource = _COUNT_RESOURCES.get(str(args.get("entity")))
    if resource is None or not user.access.can(resource, "view"):
        return {"error": "permission_denied"}
    try:
        return await fn(db, args)
    except Exception as exc:  # tool failures go back to the model, not 500
        return {"error": f"{type(exc).__name__}: {exc}"}
