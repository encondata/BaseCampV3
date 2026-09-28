"""Password expiry policy (System settings › Security, To-Do #32).

Expiry is computed, never stored: an account's password expires
`days` after the later of its last change and the moment the switch was
turned on, so flipping the switch off makes everyone current at once.
apply_password() is the ONE way a password gets set — it also records
the hash in password_history for the reuse rule.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import PasswordHistory, UserAccount
from serversherpa.security.passwords import hash_password, verify_password
from serversherpa.system.config_store import read_section

HISTORY_KEEP = 24   # the largest history_count the policy allows

ChangeReason = Literal["temporary", "expired"]


@dataclass(frozen=True)
class PasswordPolicy:
    enabled: bool
    days: int
    history_count: int
    since: datetime | None


class PasswordReused(Exception):
    """The new password matches one of the last `count` passwords."""

    def __init__(self, count: int) -> None:
        super().__init__(f"password used within the last {count}")
        self.count = count


async def load_policy(db: AsyncSession) -> PasswordPolicy:
    cfg = await read_section(db, "security")
    raw = cfg.get("password_expiry_since")
    since = datetime.fromisoformat(raw) if raw else None
    if since is not None and since.tzinfo is None:
        since = since.replace(tzinfo=UTC)
    return PasswordPolicy(
        enabled=bool(cfg.get("password_expiry_enabled", False)),
        days=int(cfg.get("password_expiry_days", 90)),
        history_count=int(cfg.get("password_history_count", 3)),
        since=since,
    )


def expires_at(policy: PasswordPolicy, account: UserAccount) -> datetime | None:
    """When this account's password stops working, or None when the
    policy is off (or the switch has no stamp yet) or there is no password."""
    if not policy.enabled or policy.since is None or account.password_hash is None:
        return None
    changed = account.password_updated_at
    if changed is not None and changed.tzinfo is None:
        changed = changed.replace(tzinfo=UTC)
    start = policy.since if changed is None else max(changed, policy.since)
    return start + timedelta(days=policy.days)


def change_reason(policy: PasswordPolicy, account: UserAccount,
                  now: datetime) -> ChangeReason | None:
    """Why the account must set a new password before doing anything
    else — a temporary password from an admin wins over expiry."""
    if account.must_change_password:
        return "temporary"
    due = expires_at(policy, account)
    if due is not None and due <= now:
        return "expired"
    return None


async def assert_not_reused(db: AsyncSession, policy: PasswordPolicy,
                            account: UserAccount, new_password: str) -> None:
    """Raise PasswordReused when new_password matches one of the newest
    `history_count` history rows. No-op while the policy is off or the
    count is 0."""
    if not policy.enabled or policy.history_count <= 0:
        return
    pepper = get_settings().password_pepper.get_secret_value()
    rows = await db.scalars(
        select(PasswordHistory.password_hash)
        .where(PasswordHistory.person_id == account.person_id)
        .order_by(PasswordHistory.created_at.desc())
        .limit(policy.history_count))
    # The current password is the newest of the "last N" even when history
    # predates it (accounts created before the table, or by a fixture).
    candidates: list[str] = []
    if account.password_hash is not None:
        candidates.append(account.password_hash)
    for old_hash in rows:
        if old_hash not in candidates:
            candidates.append(old_hash)
    for old_hash in candidates[:policy.history_count]:
        if verify_password(old_hash, new_password, pepper=pepper):
            raise PasswordReused(policy.history_count)


async def apply_password(db: AsyncSession, account: UserAccount, new_password: str, *,
                         must_change: bool, now: datetime) -> None:
    """Set the password, stamp the account, record history and trim it.
    Adds to the caller's session; never commits. A brand-new account
    (no password_hash yet) records only the new password."""
    pepper = get_settings().password_pepper.get_secret_value()
    if account.password_hash is not None and account.person_id is not None:
        # first change on an account with no history yet: keep the password
        # being replaced, so "the last N" reaches back past this change
        has_history = await db.scalar(
            select(PasswordHistory.id)
            .where(PasswordHistory.person_id == account.person_id).limit(1))
        if has_history is None:
            db.add(PasswordHistory(
                person_id=account.person_id, password_hash=account.password_hash,
                created_at=account.password_updated_at or (now - timedelta(seconds=1))))
    account.password_hash = hash_password(new_password, pepper=pepper)
    account.password_updated_at = now
    account.must_change_password = must_change
    account.updated_at = now
    db.add(PasswordHistory(person_id=account.person_id,
                           password_hash=account.password_hash, created_at=now))
    await db.flush()
    keep = select(PasswordHistory.id).where(
        PasswordHistory.person_id == account.person_id
    ).order_by(PasswordHistory.created_at.desc()).limit(HISTORY_KEEP)
    await db.execute(
        delete(PasswordHistory)
        .where(PasswordHistory.person_id == account.person_id,
               PasswordHistory.id.not_in(keep)))
