"""POST /devices/kiosks/clear-offline — the match rule, the re-check before
deleting, and the two authorization gates.

The rule is staleness alone: unseen for 24 hours, or never seen and created
more than 24 hours ago. Registration is reported but decides nothing."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Device, RolePermission
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff

CLEAR = "/devices/kiosks/clear-offline"


async def _kiosk(db, name, *, expires_in_hours=None, seen_hours_ago=None,
                 created_hours_ago=None):
    """A kiosk row. expires_in_hours None -> Unregistered; negative -> Expired.
    seen_hours_ago None -> never seen. created_hours_ago None -> created now,
    which is what a kiosk provisioned in the portal looks like."""
    now = datetime.now(UTC)
    device = Device(
        device_type="kiosk", name=name, sub_type="laptop",
        token_expires_at=None if expires_in_hours is None else now + timedelta(hours=expires_in_hours),
        last_seen_at=None if seen_hours_ago is None else now - timedelta(hours=seen_hours_ago))
    if created_hours_ago is not None:
        device.created_at = now - timedelta(hours=created_hours_ago)
    db.add(device)
    await db.commit()
    return device


async def _grant(db, role, resource, action):
    db.add(RolePermission(role=role, resource=resource, action=action))
    await db.commit()


async def test_dry_run_matches_every_silent_kiosk_and_spares_the_live_ones(
        client, db, seeded_user):
    """The whole rule in one table: silence decides, the token never does."""
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "dead-expired", expires_in_hours=-48, seen_hours_ago=72)
    await _kiosk(db, "dead-never", expires_in_hours=None, seen_hours_ago=None,
                 created_hours_ago=72)
    # The production case: a real token runs ~30 days, so a kiosk that dies
    # stays "registered" for a month while going silent within hours. Under
    # the old AND rule this row was untouchable; it is exactly what the
    # button exists to clear.
    await _kiosk(db, "silent-but-registered", expires_in_hours=720, seen_hours_ago=72)
    await _kiosk(db, "alive-but-expired", expires_in_hours=-1, seen_hours_ago=0)
    await _kiosk(db, "just-provisioned", expires_in_hours=None, seen_hours_ago=None)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert body["dry_run"] is True
    assert {k["name"] for k in body["kiosks"]} == {
        "dead-expired", "dead-never", "silent-but-registered"}
    assert body["skipped"] == []
    # a dry run deletes nothing
    assert await db.scalar(select(func.count()).select_from(Device)) == 5


async def test_a_registered_kiosk_silent_for_days_is_cleared(client, db, seeded_user):
    """The regression this rule change exists for. A kiosk holding a valid
    token is cleared once it goes quiet, and the response still reports the
    token honestly as `registered` — that field is information for the
    modal, not a veto.

    This replaces test_expires_soon_is_still_registered, which asserted the
    opposite for the same row shape (a token valid for one more hour, silent
    for five days). That test protected a clause of the rule that no longer
    exists; the row it described is now the clearest example of what the
    button must catch, so the case is kept and its expectation inverted."""
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "soon-and-silent", expires_in_hours=1, seen_hours_ago=120)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert [k["name"] for k in body["kiosks"]] == ["soon-and-silent"]
    assert body["kiosks"][0]["registration"] == "registered"


async def test_a_kiosk_seen_minutes_ago_is_spared_whatever_its_token_says(
        client, db, seeded_user):
    """Silence is the only thing that clears a kiosk, so a heartbeat is the
    only thing that saves one. A lapsed or missing token on a machine that
    is demonstrably running means re-register it, not delete it."""
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "live-expired", expires_in_hours=-48, seen_hours_ago=0)
    await _kiosk(db, "live-unregistered", expires_in_hours=None, seen_hours_ago=0)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert body["kiosks"] == []


async def test_a_never_seen_kiosk_is_cleared_once_the_grace_period_passes(
        client, db, seeded_user):
    """A pairing attempt that never came back: no heartbeat has ever landed
    and the row has been sitting there for days."""
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "never-arrived", expires_in_hours=None, seen_hours_ago=None,
                 created_hours_ago=72)

    body = (await client.post(CLEAR, json={"dry_run": True}, headers=hdrs)).json()
    assert [k["name"] for k in body["kiosks"]] == ["never-arrived"]


async def test_a_freshly_provisioned_kiosk_is_spared_by_the_grace_period(
        client, db, seeded_user):
    """The reason the rule is not simply "stale or never seen". A kiosk
    created in the portal minutes ago has never been seen, and must survive
    long enough for someone to go and plug it in."""
    hdrs = await login_admin(client, db, seeded_user)
    await _kiosk(db, "brand-new", expires_in_hours=None, seen_hours_ago=None,
                 created_hours_ago=5 / 60)

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


async def test_a_spared_kiosk_that_reregistered_is_not_labeled_expired(client, db, seeded_user):
    """A kiosk that comes back between preview and confirm — heartbeat first,
    then a fresh token — is spared by the heartbeat, and the skip reason must
    describe its token as it now stands rather than as the preview saw it.

    Re-registration alone no longer spares anything (a machine can hold a
    valid token and still be dead), so the heartbeat is what does the
    sparing here; what this protects is the reporting."""
    hdrs = await login_admin(client, db, seeded_user)
    kiosk = await _kiosk(db, "came-back-registered", expires_in_hours=-48, seen_hours_ago=72)
    kiosk.last_seen_at = datetime.now(UTC)                             # checks in
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
    about a device it has no business describing. The router below is stale
    by every measure the rule uses — only `device_type` keeps it safe."""
    hdrs = await login_admin(client, db, seeded_user)
    router_row = Device(device_type="router", name="edge-router", token_expires_at=None,
                        last_seen_at=datetime.now(UTC) - timedelta(hours=72))
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
    # Seen 2 hours ago: must NOT match. A buggy implementation computing
    # "now" from the skewed clock below would see an elapsed time of
    # centuries since last_seen_at and wrongly match it.
    await _kiosk(db, "seen-this-morning", expires_in_hours=-1, seen_hours_ago=2)

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
