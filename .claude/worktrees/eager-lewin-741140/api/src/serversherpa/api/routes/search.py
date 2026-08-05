"""Global search — one endpoint the topbar queries as you type.

Grows a section per entity as they land (users today; clients, projects,
sites, assets later). Results are scoped by the caller's roles.
"""

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import CurrentUser, DbSession
from serversherpa.api.schemas import SearchOut, SearchResult
from serversherpa.db.models import Client, Partner, Person, UserAccount

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

    for model, kind, resource in ((Client, "client", "clients"),
                                   (Partner, "partner", "partners")):
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

    return SearchOut(results=results)
