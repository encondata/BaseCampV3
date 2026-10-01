"""Trust-on-first-use SSH host keys, stored in ssh_known_hosts and keyed by
(host, port). Fetching a host key happens here too, because trusting one
re-reads the live key before storing it."""

import asyncio
import base64
import hashlib
import uuid

import asyncssh
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.models import SshKnownHost, User
from sirdar_api.deploy import ConnectFailed
from sirdar_api.services.audit import audit

FETCH_TIMEOUT = 15


class HostKeyChanged(Exception):
    """The live key no longer matches the fingerprint the user approved."""

    def __init__(self, host: str, port: int, expected: str, actual: str, key_type: str):
        super().__init__(f"host key for {host}:{port} changed")
        self.host, self.port = host, port
        self.expected, self.actual, self.key_type = expected, actual, key_type


def fingerprint(key: asyncssh.SSHKey) -> str:
    """OpenSSH-style SHA256 fingerprint: SHA256:<base64, no padding>."""
    digest = hashlib.sha256(key.public_data).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def unreachable(host: str, port: int) -> ConnectFailed:
    return ConnectFailed(f"Couldn't reach {host}:{port}.")


async def fetch_host_key(host: str, port: int) -> asyncssh.SSHKey:
    """The server's host key, read without authenticating. Never consults
    ~/.ssh/config, so the container's environment can't redirect it."""
    try:
        key = await asyncio.wait_for(
            asyncssh.get_server_host_key(host, port, config=None), FETCH_TIMEOUT)
    except (OSError, TimeoutError, asyncssh.Error):
        raise unreachable(host, port) from None
    if key is None:
        raise unreachable(host, port)
    return key


def public_key_text(key: asyncssh.SSHKey) -> str:
    return key.export_public_key("openssh").decode().strip()


async def lookup(db: AsyncSession, host: str, port: int) -> SshKnownHost | None:
    return await db.scalar(
        select(SshKnownHost).where(SshKnownHost.host == host, SshKnownHost.port == port))


async def trust(db: AsyncSession, host: str, port: int, expected_fingerprint: str,
                actor_id: uuid.UUID | None, *, ip: str | None = None) -> SshKnownHost:
    """Store the live key for host:port if it still has the fingerprint the
    user saw. Queues an audit row; the caller commits."""
    live = await fetch_host_key(host, port)
    actual, key_type = fingerprint(live), live.get_algorithm()
    if actual != expected_fingerprint:
        raise HostKeyChanged(host, port, expected_fingerprint, actual, key_type)
    previous = await lookup(db, host, port)
    previous_fingerprint = previous.fingerprint_sha256 if previous else None
    values = dict(key_type=key_type, fingerprint_sha256=actual,
                  public_key=public_key_text(live), trusted_by=actor_id)
    await db.execute(
        insert(SshKnownHost).values(host=host, port=port, **values)
        .on_conflict_do_update(index_elements=["host", "port"],
                               set_={**values, "trusted_at": func.now()}))
    audit(db, actor_id=actor_id, action="deploy.host_trust", entity_type="ssh_known_host",
          entity_id=f"{host}:{port}", ip=ip,
          changes={"host": host, "port": port, "key_type": key_type, "fingerprint": actual,
                   **({"previous_fingerprint": previous_fingerprint} if previous else {})})
    await db.flush()
    return await db.scalar(
        select(SshKnownHost).where(SshKnownHost.host == host, SshKnownHost.port == port)
        .execution_options(populate_existing=True))


async def forget(db: AsyncSession, host: str, port: int, actor_id: uuid.UUID | None, *,
                 ip: str | None = None) -> bool:
    """Drop the stored key; False when there was none. The caller commits."""
    row = await lookup(db, host, port)
    if row is None:
        return False
    await db.execute(delete(SshKnownHost).where(SshKnownHost.id == row.id))
    audit(db, actor_id=actor_id, action="deploy.host_forget", entity_type="ssh_known_host",
          entity_id=f"{host}:{port}", ip=ip,
          changes={"host": host, "port": port, "key_type": row.key_type,
                   "fingerprint": row.fingerprint_sha256})
    await db.flush()
    return True


async def list_hosts(db: AsyncSession) -> list[tuple[SshKnownHost, str | None]]:
    """Every trusted host with the truster's display name (None if unknown)."""
    rows = (await db.execute(
        select(SshKnownHost, User)
        .outerjoin(User, User.person_id == SshKnownHost.trusted_by)
        .order_by(SshKnownHost.host, SshKnownHost.port))).all()
    return [(host, user.display_name if user else None) for host, user in rows]

