"""POST /devices/kiosks/clear-offline — the match rule, the re-check before
deleting, and the two authorization gates."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Device, RolePermission
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff

CLEAR = "/devices/kiosks/clear-offline"


async def _kiosk(db, name, *, expires_in_hours=None, seen_hours_ago=None):
    """A kiosk row. expires_in_hours None -> Unregistered; negative -> Expired.
    seen_hours_ago None -> never seen."""
    now = datetime.now(UTC)
    device = Device(
        device_type="kiosk", name=name, sub_type="laptop",
        token_expires_at=None if expires_in_hours is None else now + timedelta(hours=expires_in_hours),
        last_seen_at=None if seen_hours_ago is None else now - timedelta(hours=seen_hours_ago))
    db.add(device)
    await db.commit()
    return device


async def _grant(db, role, resource, action):
    db.add(RolePermission(role=role, resource=resource, action=action))
    await db.commit()


async def test_dry_run_matches_only_stale_and_unregistered(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "dead-expired", expires_in_hours=-48, seen_hours_ago=72)
    await _kiosk(db, "dead-never", expires_in_hours=None, seen_hours_ago=None)
    await _kiosk(db, "idle-but-registered", expires_in_hours=240, seen_hours_ago=48)
    await _kiosk(db, "alive-but-expired", expires_in_hours=-1, seen_hours_ago=0)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert body["dry_run"] is True
    assert {k["name"] for k in body["kiosks"]} == {"dead-expired", "dead-never"}
    assert body["skipped"] == []
    # a dry run deletes nothing
    assert await db.scalar(select(func.count()).select_from(Device)) == 4


async def test_expires_soon_is_still_registered(client, db, seeded_user):
    """tokenExpiryState calls a token inside the warning window 'soon', not
    expired — a kiosk with one must survive however long it has been quiet."""
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "soon-and-stale", expires_in_hours=1, seen_hours_ago=120)
    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert body["kiosks"] == []


async def test_confirm_deletes_and_audits(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    dead = await _kiosk(db, "dead-expired", expires_in_hours=-48, seen_hours_ago=72)
    keep = await _kiosk(db, "keeper", expires_in_hours=240, seen_hours_ago=0)

    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(dead.id)]},
                              headers=hdrs)).json()
    assert [k["name"] for k in body["kiosks"]] == ["dead-expired"]
    assert body["skipped"] == []
    dead_id, keep_id = dead.id, keep.id  # capture before any expiry
    assert await db.scalar(select(Device).where(Device.id == dead_id)) is None
    assert await db.scalar(select(Device).where(Device.id == keep_id)) is not None
    rows = (await db.execute(select(AuditLog).where(AuditLog.entity_id == str(dead_id)))).scalars().all()
    assert any(r.action == "delete" for r in rows)


async def test_an_id_that_no_longer_matches_is_skipped_not_deleted(client, db, seeded_user):
    """The re-check: a kiosk that heartbeats between the dry run and the
    confirm is alive, and must survive being named in `ids`."""
    hdrs = await login_admin(client, db, seeded_user)
    alive = await _kiosk(db, "came-back", expires_in_hours=-48, seen_hours_ago=72)
    alive.last_seen_at = datetime.now(UTC)          # heartbeat lands
    await db.commit()
    alive_id = alive.id  # capture before any expiry

    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(alive_id)]},
                              headers=hdrs)).json()
    assert body["kiosks"] == []
    assert [k["name"] for k in body["skipped"]] == ["came-back"]
    assert await db.scalar(select(Device).where(Device.id == alive_id)) is not None


async def test_reregistered_kiosk_is_skipped_and_not_labeled_expired(client, db, seeded_user):
    """A kiosk that re-registers between preview and confirm has a valid
    future token; the skip reason must not call it expired."""
    hdrs = await login_admin(client, db, seeded_user)
    kiosk = await _kiosk(db, "came-back-registered", expires_in_hours=-48, seen_hours_ago=72)
    kiosk.token_expires_at = datetime.now(UTC) + timedelta(hours=240)  # re-registers
    await db.commit()
    kiosk_id = kiosk.id  # capture before any expiry

    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(kiosk_id)]},
                              headers=hdrs)).json()
    assert body["kiosks"] == []
    assert len(body["skipped"]) == 1
    assert body["skipped"][0]["name"] == "came-back-registered"
    assert body["skipped"][0]["registration"] == "registered"
    assert await db.scalar(select(Device).where(Device.id == kiosk_id)) is not None


async def test_a_non_kiosk_id_is_never_deleted(client, db, seeded_user):
    """The endpoint is not a general-purpose delete, and does not talk
    about a device it has no business describing."""
    hdrs = await login_admin(client, db, seeded_user)
    router_row = Device(device_type="router", name="edge-router", token_expires_at=None,
                        last_seen_at=None)
    db.add(router_row)
    await db.commit()
    router_id = router_row.id  # capture before any expiry
    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(router_id)]},
                              headers=hdrs)).json()
    assert body["kiosks"] == []
    assert body["skipped"] == []
    assert body["not_found"] == 1
    assert await db.scalar(select(Device).where(Device.id == router_id)) is not None


async def test_unknown_ids_are_counted_as_not_found(client, db, seeded_user):
    """An id that matches no device at all must not vanish silently — the
    operator's confirmed count has to be reconcilable against the response."""
    hdrs = await login_admin(client, db, seeded_user)
    ghost_id = uuid.uuid4()
    body = (await client.post(CLEAR, json={"dry_run": False, "ids": [str(ghost_id)]},
                              headers=hdrs)).json()
    assert body["kiosks"] == []
    assert body["skipped"] == []
    assert body["not_found"] == 1


async def test_ids_over_the_cap_is_422(client, db, seeded_user):
    """`ids` has no business being unbounded — an arbitrarily large IN(...)
    is not a shape this endpoint should accept."""
    hdrs = await login_admin(client, db, seeded_user)
    too_many = [str(uuid.uuid4()) for _ in range(501)]
    resp = await client.post(CLEAR, json={"dry_run": False, "ids": too_many}, headers=hdrs)
    assert resp.status_code == 422


async def test_uses_database_clock_not_app_clock(client, db, seeded_user, monkeypatch):
    """The design pins `now` to `select(func.now())`, not the application
    host's clock. Skew the module's datetime.now() wildly and confirm the
    match still lines up with the real (database-clock) elapsed time —
    a python-clock implementation would get this wrong."""
    hdrs = await login_admin(client, db, seeded_user)
    # Expired but seen 2 hours ago: must NOT match. A buggy implementation
    # computing "now" from the skewed clock below would see an elapsed time
    # of centuries since last_seen_at and wrongly match it.
    await _kiosk(db, "recently-expired", expires_in_hours=-1, seen_hours_ago=2)

    class _SkewedClock:
        @staticmethod
        def now(tz=None):
            return datetime(2999, 1, 1, tzinfo=tz)

    monkeypatch.setattr("serversherpa.api.routes.devices.datetime", _SkewedClock)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert body["kiosks"] == []


async def test_staff_with_delete_granted_is_still_refused_by_rank(client, db, seeded_user):
    """The gate that looks redundant today and is not: the permission matrix
    is runtime-editable, so scanning_hardware:delete can be granted to staff.
    Rank 60 is what actually keeps this button admin-only."""
    hdrs = await login_staff(client, seeded_user)
    await _grant(db, "staff", "scanning_hardware", "delete")
    resp = await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden_rank"
