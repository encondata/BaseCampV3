"""Copy portal users (an active global role with rank >= 60) into Sirdar.

The portal owns identity: every run overwrites the identity fields of the
people it copies, disables the ones who stopped qualifying (sessions
revoked, never deleted), and never touches local users or Sirdar-only
data (overrides, sessions, audit, lockout counters). The source is read
in a READ ONLY transaction; Sirdar's writes are one transaction, so a
failure leaves everything as it was. This is where scheduled sync will
plug in later."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import delete, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from sirdar_api.config import get_settings
from sirdar_api.db.models import ImportRun, Role, TotpBackupCode, User, UserRole
from sirdar_api.services.audit import audit
from sirdar_api.services.auth import revoke_sessions
from sirdar_api.services.portal_policy import (
    SECURITY_DEFAULTS, password_expires_at, totp_policy,
)

ELIGIBLE_RANK = 60
IMPORT_DISABLE_REASONS = {"not_eligible"}


class ImportNotConfigured(Exception):
    """SIRDAR_SOURCE_DATABASE_URL is not set."""


class ImportSourceError(Exception):
    def __init__(self, message: str, run_id: uuid.UUID):
        super().__init__(message)
        self.run_id = run_id


@dataclass
class _Account:
    person_id: uuid.UUID
    email: str
    first_name: str
    last_name: str
    preferred_name: str | None
    job_title: str | None
    password_hash: str | None
    must_change_password: bool
    password_updated_at: datetime | None
    totp_secret_enc: bytes | None
    totp_confirmed_at: datetime | None
    totp_last_counter: int | None
    totp_required: bool
    disabled_at: datetime | None
    archived_at: datetime | None


@dataclass
class _Role:
    name: str
    label: str
    rank: int
    color: str | None
    scope_anchor: str
    totp_required: bool


@dataclass
class _Snapshot:
    accounts: list[_Account]
    roles: dict[str, _Role]
    grants: dict[uuid.UUID, set[str]] = field(default_factory=dict)
    totp_group_members: set[uuid.UUID] = field(default_factory=set)
    backup_codes: dict[uuid.UUID, list[tuple[str, datetime | None]]] = field(
        default_factory=dict)
    security: dict = field(default_factory=dict)


async def _read_source(url: str) -> _Snapshot:
    engine = create_async_engine(url, poolclass=NullPool, connect_args={"timeout": 10})
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET TRANSACTION READ ONLY"))
            accounts = [_Account(**dict(r)) for r in (await conn.execute(text("""
                SELECT ua.person_id, ua.email::text AS email, p.first_name, p.last_name,
                       p.preferred_name, p.job_title, ua.password_hash,
                       ua.must_change_password, ua.password_updated_at, ua.totp_secret_enc,
                       ua.totp_confirmed_at, ua.totp_last_counter, ua.totp_required,
                       ua.disabled_at, p.archived_at
                FROM user_accounts ua JOIN people p ON p.id = ua.person_id
            """))).mappings()]
            roles = {r["name"]: _Role(name=r["name"], label=r["label"] or r["name"],
                                      rank=r["rank"], color=r["color"],
                                      scope_anchor=r["scope_anchor"],
                                      totp_required=r["totp_required"])
                     for r in (await conn.execute(text(
                         "SELECT name, label, rank, color, scope_anchor, totp_required "
                         "FROM roles"))).mappings()}
            snap = _Snapshot(accounts=accounts, roles=roles)
            for pid, role in (await conn.execute(text(
                    "SELECT person_id, role FROM person_roles WHERE revoked_at IS NULL"))).all():
                snap.grants.setdefault(pid, set()).add(role)
            snap.totp_group_members = set((await conn.execute(text(
                "SELECT agm.person_id FROM access_group_members agm "
                "JOIN access_groups ag ON ag.id = agm.group_id "
                "WHERE ag.totp_required"))).scalars())
            for pid, code_hash, used_at in (await conn.execute(text(
                    "SELECT person_id, code_hash, used_at FROM totp_backup_codes"))).all():
                snap.backup_codes.setdefault(pid, []).append((code_hash, used_at))
            row = (await conn.execute(text(
                "SELECT data FROM system_config WHERE section = 'security'"))).first()
            snap.security = {**SECURITY_DEFAULTS, **(row[0] if row else {})}
            return snap
    finally:
        await engine.dispose()


def _eligible_roles(snap: _Snapshot, person_id: uuid.UUID) -> list[str]:
    return sorted(r for r in snap.grants.get(person_id, set())
                  if r in snap.roles and snap.roles[r].scope_anchor == "global"
                  and snap.roles[r].rank >= ELIGIBLE_RANK)


def _identity_fields(acct: _Account, snap: _Snapshot) -> dict:
    policy = totp_policy(
        snap.security, account_required=acct.totp_required,
        in_totp_group=acct.person_id in snap.totp_group_members,
        has_totp_role=any(snap.roles[r].totp_required
                          for r in snap.grants.get(acct.person_id, set()) if r in snap.roles))
    return {
        "email": acct.email, "first_name": acct.first_name, "last_name": acct.last_name,
        "preferred_name": acct.preferred_name, "job_title": acct.job_title,
        "password_hash": acct.password_hash,
        "must_change_password": acct.must_change_password,
        "password_updated_at": acct.password_updated_at,
        "password_expires_at": password_expires_at(
            snap.security, acct.password_hash, acct.password_updated_at),
        "totp_secret_enc": acct.totp_secret_enc,
        "totp_confirmed_at": acct.totp_confirmed_at,
        "totp_enabled": policy.enabled, "totp_required": policy.required,
    }


def _row(acct_or_user, action: str, *, reason: str | None = None,
         roles: list[str] | None = None, changes: list[str] | None = None) -> dict:
    pid = acct_or_user.person_id
    name = f"{acct_or_user.preferred_name or acct_or_user.first_name} {acct_or_user.last_name}"
    return {"person_id": str(pid) if pid else None, "email": acct_or_user.email,
            "name": name, "action": action, "reason": reason, "roles": roles or [],
            "changes": changes or []}


async def _sync_roles(db: AsyncSession, snap: _Snapshot) -> None:
    for r in snap.roles.values():
        if r.scope_anchor != "global" or r.rank < ELIGIBLE_RANK:
            continue
        role = await db.get(Role, r.name)
        if role is None:
            db.add(Role(name=r.name, label=r.label, rank=r.rank, color=r.color))
        else:
            role.label, role.rank, role.color = r.label, r.rank, r.color
    await db.flush()


async def _replace_roles(db: AsyncSession, person_id: uuid.UUID, roles: list[str]) -> bool:
    current = set(await db.scalars(select(UserRole.role).where(UserRole.person_id == person_id)))
    if current == set(roles):
        return False
    await db.execute(delete(UserRole).where(UserRole.person_id == person_id))
    for role in roles:
        db.add(UserRole(person_id=person_id, role=role))
    return True


async def _replace_backup_codes(db: AsyncSession, person_id: uuid.UUID,
                                source_codes: list[tuple[str, datetime | None]]) -> bool:
    current = {h: used for h, used in (await db.execute(
        select(TotpBackupCode.code_hash, TotpBackupCode.used_at)
        .where(TotpBackupCode.person_id == person_id))).all()}
    # a code used in Sirdar stays used even if the portal has not seen it used
    desired = {h: used or current.get(h) for h, used in source_codes}
    if desired == current:
        return False
    await db.execute(delete(TotpBackupCode).where(TotpBackupCode.person_id == person_id))
    for h, used in desired.items():
        db.add(TotpBackupCode(person_id=person_id, code_hash=h, used_at=used))
    return True


def _is_eligible(acct: _Account, roles: list[str]) -> bool:
    return bool(roles) and acct.password_hash is not None and acct.disabled_at is None \
        and acct.archived_at is None


async def _move_emails(db: AsyncSession, existing: dict[uuid.UUID, User],
                       importing: dict[uuid.UUID, _Account]) -> set[uuid.UUID]:
    """Clear the way for the emails this run assigns. The portal is the source
    of truth, so a portal user's email never blocks another portal person:
    every importing user whose email changes is parked on a unique
    placeholder, and every other portal user holding a wanted email gets it
    released to a tombstone. One flush, then the final emails can be written
    in any order without tripping UNIQUE(email). Returns the released ids."""
    wanted = {a.email.lower() for a in importing.values()}
    released: set[uuid.UUID] = set()
    for user in existing.values():
        if user.source != "portal":
            continue
        acct = importing.get(user.person_id)
        if acct is not None:
            if acct.email.lower() != user.email.lower():
                user.email = f"pending+{user.person_id}@sirdar.invalid"
        elif user.email.lower() in wanted:
            user.email = f"released+{user.person_id}@sirdar.invalid"
            released.add(user.person_id)
    await db.flush()
    return released


async def _apply(db: AsyncSession, snap: _Snapshot, now: datetime) -> list[dict]:
    await _sync_roles(db, snap)
    existing = {u.person_id: u for u in await db.scalars(select(User))}
    local_emails = {u.email.lower() for u in existing.values() if u.source == "local"}
    old_email = {pid: u.email for pid, u in existing.items()}
    rows: list[dict] = []
    skipped: dict[uuid.UUID, dict] = {}
    importing: dict[uuid.UUID, tuple[_Account, list[str]]] = {}

    # decide first: who imports and who is skipped (only a LOCAL user blocks)
    for acct in sorted(snap.accounts, key=lambda a: a.email.lower()):
        roles = _eligible_roles(snap, acct.person_id)
        if not _is_eligible(acct, roles):
            continue
        user = existing.get(acct.person_id)
        if user is not None and user.source == "local":
            reason = "person_is_local"
        elif acct.email.lower() in local_emails:
            reason = "email_collision_local"
        else:
            importing[acct.person_id] = (acct, roles)
            continue
        skipped[acct.person_id] = _row(acct, "skipped", reason=reason, roles=roles)
        rows.append(skipped[acct.person_id])

    released = await _move_emails(db, existing, {p: a for p, (a, _) in importing.items()})

    for acct, roles in importing.values():
        fields = _identity_fields(acct, snap)
        user = existing.get(acct.person_id)
        if user is None:
            user = User(person_id=acct.person_id, source="portal",
                        totp_last_counter=acct.totp_last_counter, last_imported_at=now, **fields)
            db.add(user)
            await db.flush()
            await _replace_roles(db, user.person_id, roles)
            await _replace_backup_codes(db, user.person_id,
                                        snap.backup_codes.get(acct.person_id, []))
            rows.append(_row(acct, "added", roles=roles))
            continue

        before = {**{k: getattr(user, k) for k in fields}, "email": old_email[user.person_id]}
        changes = [k for k, v in fields.items() if before[k] != v]
        for k in changes:
            setattr(user, k, fields[k])
        counters = [c for c in (user.totp_last_counter, acct.totp_last_counter) if c is not None]
        best = max(counters) if counters else None
        if best != user.totp_last_counter:
            user.totp_last_counter = best
            changes.append("totp_last_counter")
        if user.disabled_at is not None and user.disabled_reason in IMPORT_DISABLE_REASONS:
            user.disabled_at = None
            user.disabled_reason = None
            changes.append("enabled")
        if await _replace_roles(db, user.person_id, roles):
            changes.append("roles")
        if await _replace_backup_codes(db, user.person_id,
                                       snap.backup_codes.get(acct.person_id, [])):
            changes.append("backup_codes")
        user.last_imported_at = now
        if changes:
            user.updated_at = now
            rows.append(_row(acct, "updated", roles=roles, changes=changes))
        else:
            rows.append(_row(acct, "unchanged", roles=roles))

    # one row per person: a skipped person is never also disabled, and a holder
    # that was already disabled only has its email released (no new row)
    for user in existing.values():
        if user.source != "portal" or user.person_id in importing:
            continue
        was_released = ["email_released"] if user.person_id in released else []
        if user.person_id in skipped:
            skipped[user.person_id]["changes"] += was_released
            continue
        if user.disabled_at is not None:
            if was_released:
                user.updated_at = now
            continue
        user.disabled_at = now
        user.disabled_reason = "not_eligible"
        user.updated_at = now
        await revoke_sessions(db, user.person_id, reason="import_disabled")
        rows.append(_row(user, "disabled", reason="not_eligible", changes=was_released))
    return rows


def _describe(exc: Exception) -> str:
    if isinstance(exc, DBAPIError) and exc.orig is not None:
        # never the statement or its parameters (emails, password hashes)
        first_line = (str(exc.orig).splitlines() or [""])[0]
        return f"{type(exc.orig).__name__}: {first_line[:300]}"
    return f"{type(exc).__name__}: {str(exc)[:300]}"


async def import_users(db: AsyncSession, *, actor_id: uuid.UUID | None,
                       trigger: Literal["cli", "web"],
                       source_url: str | None = None) -> ImportRun:
    settings = get_settings()
    url = source_url or (settings.source_database_url.get_secret_value()
                         if settings.source_database_url else None)
    if not url:
        raise ImportNotConfigured()

    run = ImportRun(actor_id=actor_id, trigger=trigger, status="running")
    db.add(run)
    await db.commit()
    run_id = run.id

    try:
        snap = await _read_source(url)
    except Exception as exc:  # noqa: BLE001 — any source failure is reported, not raised raw
        run.status, run.error, run.finished_at = "failed", _describe(exc), datetime.now(UTC)
        audit(db, actor_id=actor_id, action="users.import_failed", entity_type="import_run",
              entity_id=str(run_id), changes={"error": run.error})
        await db.commit()
        raise ImportSourceError(run.error, run_id) from exc

    now = datetime.now(UTC)
    try:
        rows = await _apply(db, snap, now)
        counts = {k: sum(1 for r in rows if r["action"] == k)
                  for k in ("added", "updated", "unchanged", "disabled", "skipped")}
        run.rows = rows
        run.status = "ok"
        run.finished_at = datetime.now(UTC)
        for k, v in counts.items():
            setattr(run, k, v)
        audit(db, actor_id=actor_id, action="users.import", entity_type="import_run",
              entity_id=str(run_id), changes=counts)
        await db.commit()
    except Exception as exc:
        await db.rollback()
        failed = await db.get(ImportRun, run_id)
        failed.status, failed.error = "failed", _describe(exc)
        failed.finished_at = datetime.now(UTC)
        audit(db, actor_id=actor_id, action="users.import_failed", entity_type="import_run",
              entity_id=str(run_id), changes={"error": failed.error})
        await db.commit()
        raise
    return run
