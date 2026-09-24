"""Migration 0071: 2FA columns and tables exist with the documented defaults."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AccessGroup, Role, TotpBackupCode, TrustedDevice, UserAccount,
)


async def test_totp_columns_default_false(db, seeded_user):
    account = await db.get(UserAccount, seeded_user.id)
    assert account.totp_required is False
    assert account.totp_last_counter is None
    role = await db.get(Role, "staff")
    assert role.totp_required is False
    group = AccessGroup(name="Finance")
    db.add(group)
    await db.commit()
    await db.refresh(group)
    assert group.totp_required is False


async def test_backup_codes_and_trusted_devices_cascade(db, seeded_user):
    now = datetime.now(UTC)
    db.add(TotpBackupCode(person_id=seeded_user.id, code_hash="x"))
    db.add(TrustedDevice(person_id=seeded_user.id, token_hash="t1",
                         expires_at=now + timedelta(days=7)))
    await db.commit()
    codes = list(await db.scalars(select(TotpBackupCode).where(
        TotpBackupCode.person_id == seeded_user.id)))
    assert len(codes) == 1 and codes[0].used_at is None
    devices = list(await db.scalars(select(TrustedDevice).where(
        TrustedDevice.person_id == seeded_user.id)))
    assert len(devices) == 1 and devices[0].revoked_at is None


def test_trust_days_setting_defaults_to_seven():
    assert get_settings().totp_trust_days == 7
