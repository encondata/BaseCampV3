"""Numbered container batches — the one create path behind POST
/containers/bulk and Create a move in steps' crates. Validates, inserts,
assigns label tags in LABEL_TAG_ASSIGNMENT_ORDER, and writes one create
audit per container (same shape as a single create). Never commits."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Container, StatusValue
from serversherpa.labels.tags import LABEL_TAG_ASSIGNMENT_ORDER, LABEL_TAG_KEYS
from serversherpa.services.audit import audit, snapshot

CONTAINER_FIELDS = [
    "name", "rfid_tag", "container_type", "status", "site_id",
    "initiative_id", "label_tag", "location_detail",
]


class ContainerBulkError(Exception):
    def __init__(self, code: str, status: int = 422, **extra) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.extra = extra


def check_tags(tags: dict[str, int], count: int) -> None:
    for key in tags:
        if key not in LABEL_TAG_KEYS:
            raise ContainerBulkError("bad_tag_key", allowed=list(LABEL_TAG_KEYS))
    if sum(tags.values()) > count:
        raise ContainerBulkError("tags_exceed_count")


async def check_vocab(db: AsyncSession, container_type: str, status: str | None) -> None:
    rows = (await db.execute(
        select(StatusValue.record_type, StatusValue.key).where(
            StatusValue.record_type.in_(("container", "container_type"))))).all()
    if container_type not in {k for rt, k in rows if rt == "container_type"}:
        raise ContainerBulkError("bad_container_type")
    if status is not None and status not in {k for rt, k in rows if rt == "container"}:
        raise ContainerBulkError("bad_status")


async def find_clashes(db: AsyncSession, names: list[str]) -> list[str]:
    """The names (as given) that a non-archived container already holds,
    compared case-insensitively."""
    if not names:
        return []
    existing = {n.lower() for n in await db.scalars(
        select(Container.name).where(Container.name.in_(names),
                                     Container.archived_at.is_(None)))}
    return [name for name in names if name.lower() in existing]


def tag_assignments(count: int, tags: dict[str, int]) -> list[str | None]:
    """Assign tags in LABEL_TAG_ASSIGNMENT_ORDER to the first N created
    rows (by name order); the rest are left untagged."""
    assignments: list[str | None] = [None] * count
    idx = 0
    for key in LABEL_TAG_ASSIGNMENT_ORDER:
        for _ in range(tags.get(key, 0)):
            if idx < count:
                assignments[idx] = key
            idx += 1
    return assignments


async def create_containers(
    db: AsyncSession, *, names: list[str], container_type: str, status: str | None,
    site_id: uuid.UUID | None, initiative_id: uuid.UUID | None, tags: dict[str, int],
    actor_id: uuid.UUID | None,
) -> list[Container]:
    check_tags(tags, len(names))
    await check_vocab(db, container_type, status)
    if clashes := await find_clashes(db, names):
        raise ContainerBulkError("name_collision", names=clashes)
    containers = [
        Container(name=name, container_type=container_type, status=status or "available",
                  site_id=site_id, initiative_id=initiative_id, label_tag=tag,
                  created_by=actor_id)
        for name, tag in zip(names, tag_assignments(len(names), tags), strict=True)]
    db.add_all(containers)
    await db.flush()
    for container in containers:
        initial = snapshot(container, CONTAINER_FIELDS)
        changes = {field: {"from": None, "to": value}
                   for field, value in initial.items() if value not in (None, "")}
        audit(db, actor_id=actor_id, entity_type="container",
              entity_id=str(container.id), action="create", changes=changes)
    return containers
