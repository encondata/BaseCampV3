"""Push Task 8: the app's notification routes.

With the signed-in kiosk session (rank 60+ only, 403 not_admin otherwise), on
the signed-in person's own notifications, the same code as the portal's
inbox routes (notifications/inbox_ops.py):
- GET /kiosk/notifications (items add `push_snoozed_until`)
- POST /kiosk/notifications/{id}/read, /unread, /snooze; DELETE .../{id}

With the push key instead of a session, on the registration's person only
(anything else is 404 notification_not_found):
- POST /kiosk/push/notifications/{id}/read and /snooze

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md
("API: endpoints")."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import Notification, Person, PersonRole, PushOutbox, UserAccount
from serversherpa.notifications.push import SNOOZE
from serversherpa.security.passwords import hash_password
from tests.push_helpers import NOW
from tests.test_sites_api import login

PW = "CorrectHorse9!"
SERIAL = "android-notif-0001"
ADMIN = "notif-admin@test.example.com"
OTHER = "notif-other@test.example.com"
BASE = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


# ── helpers ─────────────────────────────────────────────────────────

def _code(resp) -> str:
    return resp.json()["detail"]["code"]


async def _account(db, role, email) -> Person:
    p = Person(first_name="N", last_name="Tester", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return p


async def _app_session(db, client, role="admin", email=ADMIN, serial=SERIAL):
    """`email` signed in on the app on `serial` (the first heartbeat binds the
    session to the phone). Returns the session headers and the person's id."""
    person = await _account(db, role, email)
    resp = await client.post("/auth/login", json={"email": email, "password": PW,
                                                  "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    beat = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": serial, "name": "Phone", "mode": "android", "sign_in": True,
        "login_method": "password"})
    assert beat.status_code == 200, beat.text
    return hdrs, person.id


async def _app_with_key(db, client, email=ADMIN, serial=SERIAL):
    """An admin's claimed phone with a push registration: (session headers,
    person id, push key headers)."""
    hdrs, person_id = await _app_session(db, client, email=email, serial=serial)
    r = await client.put("/kiosk/personal", headers=hdrs, json={"on": True})
    assert r.status_code == 200, r.text
    r = await client.post("/kiosk/push/registration", headers=hdrs,
                          json={"token": f"fcm-{serial}"})
    assert r.status_code == 200, r.text
    body = r.json()
    key = {"Authorization": f"PushKey {body['registration_id']}.{body['push_key']}"}
    return hdrs, person_id, key


def _row(person_id, title, *, at=BASE, kind="report_ready", read=False, hidden=False):
    return Notification(person_id=person_id, kind=kind, title=title, created_at=at,
                        read_at=at if read else None,
                        dismissed_at=at if hidden else None)


async def _add(db, *rows) -> list:
    db.add_all(rows)
    await db.commit()
    return [r.id for r in rows]


async def _get(db, notification_id) -> Notification:
    db.expire_all()
    return await db.get(Notification, notification_id)


def _strip(item: dict) -> dict:
    return {k: v for k, v in item.items() if k != "push_snoozed_until"}


# ── session routes ──────────────────────────────────────────────────

async def test_list_matches_portal_inbox(client, db, seeded_user):
    hdrs, person_id = await _app_session(db, client)
    ids = await _add(db, *(_row(person_id, f"n{i}", at=BASE + timedelta(minutes=i),
                                read=i == 1) for i in range(5)),
                     _row(person_id, "hidden", hidden=True))
    portal = await login(client, email=ADMIN, pw=PW)
    for params in ({}, {"unread_only": True}, {"limit": 2}, {"category": "reports"},
                   {"limit": 2, "cursor": (await client.get(
                       "/notifications/inbox", params={"limit": 2}, headers=portal
                   )).json()["next_cursor"]}):
        a = await client.get("/notifications/inbox", params=params, headers=portal)
        b = await client.get("/kiosk/notifications", params=params, headers=hdrs)
        assert a.status_code == b.status_code == 200, (a.text, b.text)
        a, b = a.json(), b.json()
        assert {k: v for k, v in b.items() if k != "items"} == \
            {k: v for k, v in a.items() if k != "items"}
        assert [_strip(i) for i in b["items"]] == a["items"]
        assert all(i["push_snoozed_until"] is None for i in b["items"])
    bad = await client.get("/kiosk/notifications", params={"category": "nope"}, headers=hdrs)
    assert bad.status_code == 422 and _code(bad) == "invalid_category"
    bad = await client.get("/kiosk/notifications", params={"cursor": "zzz"}, headers=hdrs)
    assert bad.status_code == 422 and _code(bad) == "invalid_cursor"
    assert len(ids) == 6


async def test_read_unread_hide_via_kiosk(client, db, seeded_user):
    hdrs, person_id = await _app_session(db, client)
    [nid] = await _add(db, _row(person_id, "one"))
    r = await client.post(f"/kiosk/notifications/{nid}/read", headers=hdrs)
    assert r.status_code == 204
    assert (await _get(db, nid)).read_at is not None
    r = await client.post(f"/kiosk/notifications/{nid}/unread", headers=hdrs)
    assert r.status_code == 204
    assert (await _get(db, nid)).read_at is None
    r = await client.delete(f"/kiosk/notifications/{nid}", headers=hdrs)
    assert r.status_code == 204
    assert (await _get(db, nid)).dismissed_at is not None
    listed = await client.get("/kiosk/notifications", headers=hdrs)
    assert listed.json()["items"] == []
    # hidden rows are gone for read/unread; hiding again is quiet
    for path in ("read", "unread"):
        r = await client.post(f"/kiosk/notifications/{nid}/{path}", headers=hdrs)
        assert r.status_code == 404 and _code(r) == "notification_not_found"
    assert (await client.delete(f"/kiosk/notifications/{nid}", headers=hdrs)).status_code == 204


async def test_session_cannot_touch_other_person(client, db, seeded_user):
    hdrs, _ = await _app_session(db, client)
    other = await db.scalar(select(Person).where(Person.id == seeded_user.id))
    [nid] = await _add(db, _row(other.id, "theirs"))
    for r in (await client.post(f"/kiosk/notifications/{nid}/read", headers=hdrs),
              await client.post(f"/kiosk/notifications/{nid}/unread", headers=hdrs),
              await client.post(f"/kiosk/notifications/{nid}/snooze", headers=hdrs),
              await client.delete(f"/kiosk/notifications/{nid}", headers=hdrs)):
        assert r.status_code == 404 and _code(r) == "notification_not_found"
    row = await _get(db, nid)
    assert row.read_at is None and row.dismissed_at is None and row.push_snoozed_until is None


async def test_snooze_via_session(client, db, seeded_user, clock):
    clock(NOW)
    hdrs, person_id = await _app_session(db, client)
    [nid, read_id, hidden_id] = await _add(
        db, _row(person_id, "live"), _row(person_id, "read", read=True),
        _row(person_id, "hidden", hidden=True))
    r = await client.post(f"/kiosk/notifications/{nid}/snooze", headers=hdrs)
    assert r.status_code == 200, r.text
    until = datetime.fromisoformat(r.json()["snoozed_until"])
    assert abs(until - (datetime.now(UTC) + SNOOZE)) < timedelta(minutes=1)
    assert (await _get(db, nid)).push_snoozed_until == until
    queued = (await db.scalars(select(PushOutbox).where(
        PushOutbox.notification_id == nid, PushOutbox.state == "queued"))).all()
    assert len(queued) == 1
    listed = await client.get("/kiosk/notifications", headers=hdrs)
    [item] = [i for i in listed.json()["items"] if i["id"] == str(nid)]
    assert datetime.fromisoformat(item["push_snoozed_until"]) == until
    # a read or hidden one can't be snoozed
    for bad in (read_id, hidden_id):
        r = await client.post(f"/kiosk/notifications/{bad}/snooze", headers=hdrs)
        assert r.status_code == 409 and _code(r) == "not_live"
    # reading ends the snooze
    assert (await client.post(f"/kiosk/notifications/{nid}/read", headers=hdrs)).status_code == 204
    assert (await _get(db, nid)).push_snoozed_until is None


async def test_non_admin_session_refused(client, db, seeded_user):
    hdrs, person_id = await _app_session(db, client, role="staff", email="notif-staff@test.example.com",
                                         serial="android-notif-staff")
    [nid] = await _add(db, _row(person_id, "mine"))
    calls = (client.get("/kiosk/notifications", headers=hdrs),
             client.post(f"/kiosk/notifications/{nid}/read", headers=hdrs),
             client.post(f"/kiosk/notifications/{nid}/unread", headers=hdrs),
             client.post(f"/kiosk/notifications/{nid}/snooze", headers=hdrs),
             client.delete(f"/kiosk/notifications/{nid}", headers=hdrs))
    for call in calls:
        r = await call
        assert r.status_code == 403 and _code(r) == "not_admin", r.text
    row = await _get(db, nid)
    assert row.read_at is None and row.dismissed_at is None


# ── push-key routes ─────────────────────────────────────────────────

async def test_snooze_and_read_via_push_key(client, db, seeded_user, clock):
    clock(NOW)
    _, person_id, key = await _app_with_key(db, client)
    [a, b, hidden] = await _add(db, _row(person_id, "a"), _row(person_id, "b"),
                                _row(person_id, "gone", hidden=True))
    r = await client.post(f"/kiosk/push/notifications/{a}/snooze", headers=key)
    assert r.status_code == 200, r.text
    until = datetime.fromisoformat(r.json()["snoozed_until"])
    assert (await _get(db, a)).push_snoozed_until == until
    r = await client.post(f"/kiosk/push/notifications/{a}/read", headers=key)
    assert r.status_code == 204
    row = await _get(db, a)
    assert row.read_at is not None and row.push_snoozed_until is None
    # reading again is quiet; snoozing the read one is 409
    assert (await client.post(f"/kiosk/push/notifications/{a}/read", headers=key)).status_code == 204
    r = await client.post(f"/kiosk/push/notifications/{a}/snooze", headers=key)
    assert r.status_code == 409 and _code(r) == "not_live"
    # a hidden one is not found
    r = await client.post(f"/kiosk/push/notifications/{hidden}/read", headers=key)
    assert r.status_code == 404 and _code(r) == "notification_not_found"
    assert (await _get(db, b)).read_at is None


async def test_push_key_cannot_touch_other_person(client, db, seeded_user):
    _, _, key = await _app_with_key(db, client)
    other = await _account(db, "admin", OTHER)
    [nid] = await _add(db, _row(other.id, "theirs"))
    for verb in ("read", "snooze"):
        r = await client.post(f"/kiosk/push/notifications/{nid}/{verb}", headers=key)
        assert r.status_code == 404 and _code(r) == "notification_not_found"
    row = await _get(db, nid)
    assert row.read_at is None and row.push_snoozed_until is None


async def test_push_key_cannot_hide_or_list(client, db, seeded_user):
    hdrs, person_id, key = await _app_with_key(db, client)
    [nid] = await _add(db, _row(person_id, "mine"))
    for r in (await client.delete(f"/kiosk/push/notifications/{nid}", headers=key),
              await client.get("/kiosk/push/notifications", headers=key),
              await client.post(f"/kiosk/push/notifications/{nid}/unread", headers=key)):
        assert r.status_code in (404, 405), r.text
    # the session routes want a session, not a push key
    for r in (await client.get("/kiosk/notifications", headers=key),
              await client.delete(f"/kiosk/notifications/{nid}", headers=key)):
        assert r.status_code == 401, r.text
    # and the push-key routes want a push key, not a session
    for verb in ("read", "snooze"):
        r = await client.post(f"/kiosk/push/notifications/{nid}/{verb}", headers=hdrs)
        assert r.status_code == 401 and _code(r) == "push_key_invalid"
    r = await client.post(f"/kiosk/push/notifications/{nid}/read",
                          headers={"Authorization": "PushKey nope.nope"})
    assert r.status_code == 401 and _code(r) == "push_key_invalid"
    row = await _get(db, nid)
    assert row.read_at is None and row.dismissed_at is None


async def test_read_only_mode_refuses_writes(client, db, seeded_user):
    from tests.test_system_admin_api import _admin as _super_admin

    hdrs, person_id, key = await _app_with_key(db, client)
    [nid] = await _add(db, _row(person_id, "mine"))
    sa = await _super_admin(db, client)
    r = await client.put("/system/admin", headers=sa, json={"read_only": True})
    assert r.status_code == 200, r.text
    for r in (await client.post(f"/kiosk/push/notifications/{nid}/read", headers=key),
              await client.post(f"/kiosk/push/notifications/{nid}/snooze", headers=key),
              await client.post(f"/kiosk/notifications/{nid}/read", headers=hdrs),
              await client.post(f"/kiosk/notifications/{nid}/snooze", headers=hdrs),
              await client.delete(f"/kiosk/notifications/{nid}", headers=hdrs)):
        assert r.status_code == 423 and _code(r) == "read_only_mode", r.text
    assert (await client.get("/kiosk/notifications", headers=hdrs)).status_code == 200
    row = await _get(db, nid)
    assert row.read_at is None and row.dismissed_at is None and row.push_snoozed_until is None
    r = await client.put("/system/admin", headers=sa, json={"read_only": False})
    assert r.status_code == 200, r.text
    assert (await client.post(f"/kiosk/push/notifications/{nid}/read",
                              headers=key)).status_code == 204
