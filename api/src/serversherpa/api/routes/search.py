"""Global search — one endpoint the topbar queries as you type.

Grows a section per entity as they land (users today; clients, projects,
sites, assets later). Results are scoped by the caller's roles.
"""

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import CurrentUser, DbSession
from serversherpa.api.schemas import SearchOut, SearchResult
from serversherpa.db.models import (
    Asset,
    AssetModel,
    AssetModelAlias,
    Client,
    Partner,
    Person,
    Site,
    UserAccount,
)

router = APIRouter(prefix="/search", tags=["search"])

LIMIT_PER_KIND = 8


@router.get("", response_model=SearchOut)
async def global_search(
    user: CurrentUser,
    db: DbSession,
    q: str = Query(min_length=1, max_length=120),
) -> SearchOut:
    needle = f"%{q.strip()}%"
    results: list[SearchResult] = []

    # people with accounts — gated on users:view
    if user.access.can("users", "view"):
        query = (
            select(Person, UserAccount)
            .join(UserAccount, UserAccount.person_id == Person.id)
            .where(or_(
                func.concat(Person.first_name, " ", Person.last_name).ilike(needle),
                Person.preferred_name.ilike(needle),
                Person.email.ilike(needle),
                UserAccount.email.ilike(needle),
                Person.job_title.ilike(needle),
                Person.phone.ilike(needle),
            ))
        )
        cond = scope_conditions("users", user.access, user.person.id)
        if cond is not None:
            query = query.where(cond)
        rows = (await db.execute(
            query.order_by(Person.last_name, Person.first_name).limit(LIMIT_PER_KIND)
        )).all()
        results.extend(
            SearchResult(
                kind="user",
                id=person.id,
                label=person.display_name,
                sub=account.email or person.job_title,
            )
            for person, account in rows
        )

    # sites share the org shape searched here: name/code/city columns,
    # sub = code-or-city; the hard gate keeps org-anchored actors out
    for model, kind, resource in ((Client, "client", "clients"),
                                   (Partner, "partner", "partners"),
                                   (Site, "site", "sites")):
        if not user.access.can(resource, "view"):
            continue
        query = select(model).where(
            or_(model.name.ilike(needle), model.code.ilike(needle),
                model.city.ilike(needle)))
        cond = scope_conditions(resource, user.access, user.person.id)
        if cond is not None:
            query = query.where(cond)
        orgs = (await db.scalars(
            query.order_by(model.name).limit(LIMIT_PER_KIND)
        )).all()
        results.extend(
            SearchResult(kind=kind, id=o.id, label=o.name,
                         sub=o.code or o.city)
            for o in orgs
        )

    # assets — serial / name / rfid; row-scoped for client actors
    if user.access.can("assets", "view"):
        query = select(Asset).where(or_(
            Asset.serial_number.ilike(needle),
            Asset.name.ilike(needle),
            Asset.rfid_tag.ilike(needle),
        ))
        cond = scope_conditions("assets", user.access, user.person.id)
        if cond is not None:
            query = query.where(cond)
        assets = (await db.scalars(
            query.order_by(Asset.serial_number, Asset.name)
            .limit(LIMIT_PER_KIND))).all()
        results.extend(
            SearchResult(kind="asset", id=a.id,
                         label=a.serial_number or a.name or str(a.id),
                         sub=a.name if a.serial_number else a.location_detail or None)
            for a in assets
        )

    # asset models — make / model / alias; internal-only resource
    if user.access.can("asset_models", "view"):
        alias_owner = select(AssetModelAlias.model_id).where(
            AssetModelAlias.alias.ilike(needle))
        query = select(AssetModel).where(or_(
            AssetModel.make.ilike(needle),
            AssetModel.model.ilike(needle),
            AssetModel.id.in_(alias_owner),
        ))
        models = (await db.scalars(
            query.order_by(AssetModel.make, AssetModel.model)
            .limit(LIMIT_PER_KIND))).all()
        results.extend(
            SearchResult(kind="asset_model", id=m.id,
                         label=f"{m.make} {m.model}", sub=m.category)
            for m in models
        )

    return SearchOut(results=results)
