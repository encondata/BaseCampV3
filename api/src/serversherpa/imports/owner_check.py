"""The From-To check's Owner line: how many Owner values in the file match no
group of the move's client (SS-526).

A value counts once by its matching key (clientgroups/keys.py). Blank values,
values that match a group name or an alias, and values an admin dismissed on
the client's Groups › Review are not counted."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.clientgroups.keys import group_key
from serversherpa.clientgroups.service import _taken_keys
from serversherpa.db.models import ClientGroupDismissal


async def unmatched_owner_count(db: AsyncSession, client_id: uuid.UUID,
                                owners: list[str | None]) -> int:
    keys = {group_key(o) for o in owners} - {""}
    if not keys:
        return 0
    keys -= set(await _taken_keys(db, client_id))
    if keys:
        keys -= set(await db.scalars(select(ClientGroupDismissal.value_key).where(
            ClientGroupDismissal.client_id == client_id,
            ClientGroupDismissal.value_key.in_(keys))))
    return len(keys)
