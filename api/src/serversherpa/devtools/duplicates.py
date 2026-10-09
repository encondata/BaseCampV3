"""Duplicate finder for the Cleanup tab: report only, nothing is merged or
deleted. Assets that share a serial number, and people with the same first
and last name, each in groups of two or more.

Two grouped queries per list (one for the groups, one for their members), so
the cost does not grow with the number of rows listed.
"""

from sqlalchemy import String, and_, cast, exists, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, Person, Site, UserAccount, WorkerProfile
from serversherpa.db.ordering import natural
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.status.labels import status_labels

# groups listed per kind; the biggest groups come first, so a cap keeps the
# ones worth fixing
MAX_GROUPS = 200


def _serial_key():
    return func.lower(func.trim(cast(Asset.serial_number, String)))


def _name_keys():
    return (func.lower(func.trim(cast(Person.first_name, String))),
            func.lower(func.trim(cast(Person.last_name, String))))


async def duplicate_assets(db: AsyncSession) -> list[dict]:
    expr = _serial_key()
    key = expr.label("k")
    live = and_(Asset.archived_at.is_(None), Asset.serial_number.is_not(None),
                func.trim(cast(Asset.serial_number, String)) != "")
    keys = (await db.execute(
        select(key).where(live).group_by(expr).having(func.count() > 1)
        .order_by(func.count().desc(), natural(expr)).limit(MAX_GROUPS))).scalars().all()
    if not keys:
        return []

    rows = (await db.execute(
        select(key, Asset.id, Asset.name, Asset.serial_number, Asset.status,
               Site.name.label("site_name"))
        .join(Site, Site.id == Asset.site_id, isouter=True)
        .where(live, expr.in_(keys))
        .order_by(natural(cast(Asset.name, String)), Asset.legacy_id))).all()
    labels = await status_labels(db, "asset")

    members: dict[str, list[dict]] = {k: [] for k in keys}
    for r in rows:
        members[r.k].append({
            "id": r.id, "name": r.name, "serial_number": r.serial_number,
            "site_name": r.site_name,
            "status_label": labels.get(r.status, (r.status, ""))[0],
            "href": f"/assets/{r.id}"})
    # a record can change between the two queries; a group that no longer has
    # two members is no longer a duplicate, and is labeled from what was fetched
    return [{"serial": (members[k][0]["serial_number"] or "").strip(),
             "items": members[k]} for k in keys if len(members[k]) > 1]


async def duplicate_people(db: AsyncSession) -> list[dict]:
    first, last = _name_keys()
    # a move's hidden kiosk identity is not a real person
    live = and_(Person.archived_at.is_(None), Person.source != KIOSK_MOVE_SOURCE)
    keys = (await db.execute(
        select(first.label("f"), last.label("l")).where(live)
        .group_by(first, last).having(func.count() > 1)
        .order_by(func.count().desc(), natural(first), natural(last))
        .limit(MAX_GROUPS))).all()
    if not keys:
        return []

    has_login = exists().where(UserAccount.person_id == Person.id)
    is_worker = exists().where(WorkerProfile.person_id == Person.id)
    rows = (await db.execute(
        select(Person, first.label("f"), last.label("l"),
               has_login.label("has_login"), is_worker.label("is_worker"))
        .where(live, tuple_(first, last).in_([tuple(k) for k in keys]))
        .order_by(natural(Person.first_name), natural(Person.last_name),
                  natural(cast(Person.email, String)), Person.id))).all()

    members: dict[tuple[str, str], list[dict]] = {tuple(k): [] for k in keys}
    names: dict[tuple[str, str], str] = {}
    for p, f, l, login, worker in rows:
        href = (f"/people/users/{p.id}" if login
                else f"/people/workers/{p.id}" if worker else None)
        names.setdefault((f, l), f"{p.first_name.strip()} {p.last_name.strip()}")
        members[(f, l)].append({
            "id": p.id, "display_name": p.display_name, "email": p.email,
            "has_login": login, "is_worker": worker, "href": href})
    # a record can change between the two queries; a group that no longer has
    # two members is no longer a duplicate, and is labeled from what was fetched
    return [{"name": names[tuple(k)], "items": members[tuple(k)]}
            for k in keys if len(members[tuple(k)]) > 1]
