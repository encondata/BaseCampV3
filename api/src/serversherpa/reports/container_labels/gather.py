"""Container Labels — gather step: reads the initiative and the chosen
containers into plain dataclasses. Mirrors move_report/gather.py's
split (read the DB once, up front); nothing downstream touches the ORM.

See docs/superpowers/specs/2026-09-12-container-labels-design.md
§ Report module."""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Container, Initiative, Site
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.registry import OptionsError


@dataclass(frozen=True)
class LabelContainer:
    id: str
    name: str


@dataclass(frozen=True)
class ContainerLabelsData:
    initiative_id: str
    initiative_name: str
    scheduled_start: datetime | None
    origin_site_name: str | None
    destination_site_name: str | None
    containers: list[LabelContainer]


async def gather(db: AsyncSession, initiative_id: uuid.UUID,
                 container_ids: list[uuid.UUID]) -> ContainerLabelsData:
    """`container_ids` must all belong to `initiative_id` — a container
    that's missing entirely or linked to a different (or no) initiative
    raises `OptionsError` with one `container_not_on_initiative:<id>`
    problem per offending id, so the run fails with a clear reason
    instead of silently dropping a label."""
    ini = await db.get(Initiative, initiative_id)
    if ini is None or ini.archived_at is not None:
        raise InitiativeUnavailable(str(initiative_id))

    origin = await db.get(Site, ini.origin_site_id) if ini.origin_site_id else None
    dest = await db.get(Site, ini.destination_site_id) if ini.destination_site_id else None

    rows = {c.id: c for c in await db.scalars(
        select(Container).where(Container.id.in_(container_ids)))}
    problems = [f"container_not_on_initiative:{cid}" for cid in container_ids
                if rows.get(cid) is None or rows[cid].initiative_id != initiative_id]
    if problems:
        raise OptionsError(problems)

    containers = [LabelContainer(id=str(cid), name=rows[cid].name)
                  for cid in container_ids]
    return ContainerLabelsData(
        initiative_id=str(ini.id), initiative_name=ini.name,
        scheduled_start=ini.scheduled_start,
        origin_site_name=origin.name if origin else None,
        destination_site_name=dest.name if dest else None,
        containers=containers)
