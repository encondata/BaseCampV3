"""Creating a wiki space — shared by `POST /wiki/spaces` and the
`learning-seed` CLI so both build the same thing: the space, its empty
published home page, the creator's manage grant and the default-access
grant. Nothing here commits."""
import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import WikiGrant, WikiSpace
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.wiki.tree import create_node, publish_empty_home

SPACE_FIELDS = ["name", "description", "icon", "color", "settings"]


async def create_space(
    db: AsyncSession, *, key: str, name: str, description: str | None = None,
    icon: str | None = None, color: str | None = None,
    default_access: Literal["internal", "everyone", "private"],
    actor_id: uuid.UUID | None,
) -> WikiSpace:
    """The space with its home page and grants (`key` already validated).
    With no `actor_id` (the CLI without --actor-email) there is no creator
    manage grant."""
    space = WikiSpace(key=key, name=name, description=description,
                      icon=icon, color=color, created_by=actor_id)
    db.add(space)
    await db.flush()

    home_node = await create_node(
        db, space=space, parent=None, kind="page", title=space.name, actor_id=actor_id)
    await publish_empty_home(db, home_node, actor_id)
    space.home_node_id = home_node.id

    if actor_id is not None:
        db.add(WikiGrant(
            space_id=space.id, principal_type="person",
            principal_id=str(actor_id), level="manage", created_by=actor_id))
    if default_access == "internal":
        db.add(WikiGrant(
            space_id=space.id, principal_type="internal", level="view", created_by=actor_id))
    elif default_access == "everyone":
        db.add(WikiGrant(
            space_id=space.id, principal_type="everyone", level="view", created_by=actor_id))

    audit(db, actor_id=actor_id, entity_type="wiki_space",
          entity_id=str(space.id), action="create",
          changes=diff({}, {**snapshot(space, SPACE_FIELDS), "default_access": default_access}))
    return space
