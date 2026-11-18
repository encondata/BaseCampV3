"""Shared setup for the push tests: a fixed clock instant, a company default
that turns push on, an admin person and a personal phone with a registration.
The `fcm_on` and `clock` fixtures live in conftest.py."""

import itertools
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import (
    Device,
    Person,
    PersonRole,
    PushRegistration,
    SystemConfig,
    UserAccount,
)

# A fixed Wednesday, 15:00 UTC (10:00 in Chicago): inside working hours.
NOW = datetime(2026, 10, 7, 15, 0, tzinfo=UTC)
QUIET = datetime(2026, 10, 7, 8, 0, tzinfo=UTC)         # 03:00 in Chicago
KIND = "asset_watch"                                      # category assets, emailed
_serials = itertools.count(1)

PUSH_ON = {"assets": {"inbox": True, "email": True, "push": True}}


async def _company(db, *, defaults=PUSH_ON, critical_kinds=None):
    data = {"defaults": defaults}
    if critical_kinds is not None:
        data["critical_kinds"] = critical_kinds
    db.add(SystemConfig(section="notifications", data=data))
    await db.flush()


async def _admin(db, *, role="admin", prefs=None, archived=False):
    n = next(_serials)
    p = Person(first_name="Pat", last_name="Tester", email=f"pat{n}@test.example.com",
               archived_at=datetime.now(UTC) if archived else None)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=f"acct{n}@x.test", password_hash="x",
                       ui_prefs=prefs or {}))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.flush()
    return p


async def _phone(db, person, *, sub_type="android", station_type=None, owner=None,
                 expires=None):
    """A personal phone for `person` with a push registration."""
    n = next(_serials)
    device = Device(device_type="kiosk", name=f"Pixel {n}", sub_type=sub_type,
                    serial=f"push-{n}", personal_person_id=person.id,
                    station_type=station_type,
                    token_expires_at=expires or datetime.now(UTC) + timedelta(days=30))
    db.add(device)
    await db.flush()
    db.add(PushRegistration(device_id=device.id,
                            person_id=owner.id if owner else person.id,
                            platform="android", provider="fcm", token=f"tok-{n}",
                            secret_hash="h"))
    await db.flush()
    return device
