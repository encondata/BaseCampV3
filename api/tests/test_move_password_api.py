"""Move passwords end to end: admin set/clear/reveal on PATCH /initiatives,
kiosk sign-in with the password, the session locked to the move, and the
hidden kiosk identity staying out of the people lists."""

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative, Person, Site, StatusValue
from serversherpa.services import auth as auth_service
from serversherpa.services.auth import AuthError
from tests.test_sites_api import login
from tests.test_status_values_write import _make

PW = "Crew-2026!"


async def _admin(db, client):
    return await _make(db, client, "admin", "mp-admin@test.example.com")


async def _move(db, name="Las Vegas 3", status="planned"):
    init = Initiative(name=name, initiative_type="move", status=status)
    db.add(init)
    await db.commit()
    return init


async def _set(client, hdrs, init, password=PW):
    return await client.patch(f"/initiatives/{init.id}", headers=hdrs, json={"kiosk_password": password})


async def _move_login(client, password=PW):
    return await client.post("/kiosk/move-login", json={"password": password})


async def test_admin_sets_reveals_and_clears(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    resp = await _set(client, admin, init)
    assert resp.status_code == 200, resp.text
    assert resp.json()["kiosk_password_set"] is True
    shown = await client.get(f"/initiatives/{init.id}/kiosk-password", headers=admin)
    assert shown.status_code == 200 and shown.json()["password"] == PW
    reveal_rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(init.id), AuditLog.action == "kiosk_password.reveal")))
    assert len(reveal_rows) == 1
    # the set is audited as "set", never the value
    set_rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(init.id), AuditLog.action == "update")))
    assert [r.changes for r in set_rows] == [{"kiosk_password": {"from": None, "to": "set"}}]
    cleared = await client.patch(f"/initiatives/{init.id}", headers=admin, json={"kiosk_password": None})
    assert cleared.json()["kiosk_password_set"] is False
    assert (await client.get(f"/initiatives/{init.id}/kiosk-password", headers=admin)).json()["password"] is None


async def test_empty_string_clears_and_absent_leaves_it(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    # a PATCH without the field leaves the password alone
    r = await client.patch(f"/initiatives/{init.id}", headers=admin, json={"description": "x"})
    assert r.status_code == 200 and r.json()["kiosk_password_set"] is True
    r = await client.patch(f"/initiatives/{init.id}", headers=admin, json={"kiosk_password": ""})
    assert r.status_code == 200 and r.json()["kiosk_password_set"] is False


async def test_rules_and_rank(client, db, seeded_user):
    admin = await _admin(db, client)
    staff = await login(client)                      # alice, staff (rank 40)
    a = await _move(db, "A")
    b = await _move(db, "B")
    r = await _set(client, admin, a, "short7!")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "kiosk_password_too_short"
    assert (await _set(client, admin, a)).status_code == 200
    r = await _set(client, admin, b)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "kiosk_password_in_use"
    r = await _set(client, staff, b, "Another-pw1")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "kiosk_password_forbidden"
    assert (await client.get(f"/initiatives/{a.id}/kiosk-password", headers=staff)).status_code == 403
    # a staff PATCH without the field still works
    assert (await client.patch(f"/initiatives/{a.id}", headers=staff, json={"description": "x"})).status_code == 200


async def test_hidden_identity(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    await db.refresh(init)
    person = await db.get(Person, init.kiosk_person_id)
    users = (await client.get("/users", headers=admin)).json()
    assert all(u["person_id"] != str(person.id) for u in users)
    workers = (await client.get("/workers", headers=admin)).json()
    rows = workers["items"] if isinstance(workers, dict) else workers
    assert all(w["person_id"] != str(person.id) for w in rows)   # WorkerItem's id is person_id
    # kiosk people sync and search leave it out too
    kiosk = {"Authorization": f"Bearer {(await _move_login(client)).json()['access_token']}"}
    synced = (await client.get("/kiosk/sync/people", headers=kiosk)).json()["people"]
    assert synced and all(p["id"] != str(person.id) for p in synced)
    found = (await client.get("/search?q=Kiosk", headers=admin)).json()["results"]
    assert all(r["id"] != str(person.id) for r in found)
    # the identity has no password, so email sign-in is refused. The route
    # never gets that far: a .local address is not a valid EmailStr (422).
    email = f"kiosk+{init.id}@kiosk.serversherpa.local"
    r = await client.post("/auth/login", json={"email": email, "password": PW, "client": "kiosk"})
    assert r.status_code in (401, 422)
    # and the service itself refuses the password-less account
    with pytest.raises(AuthError) as exc:
        await auth_service.login(db, email=email, password=PW, client="kiosk")
    assert exc.value.code == "invalid_credentials"


async def test_move_login_and_locked_setup(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    other = await _move(db, "Other move")
    await _set(client, admin, init)
    bad = await _move_login(client, "wrong-wrong")
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "invalid_move_password"
    ok = await _move_login(client)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["kiosk_move"] == {"initiative_id": str(init.id), "name": "Las Vegas 3"}
    assert body["person"]["display_name"].startswith("Kiosk")
    audited = list(await db.scalars(select(AuditLog).where(AuditLog.action == "login_move")))
    assert len(audited) == 1
    hdrs = {"Authorization": f"Bearer {body['access_token']}"}
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["kiosk_move"]["initiative_id"] == str(init.id)
    options = (await client.get("/kiosk/setup-options", headers=hdrs)).json()
    assert [i["id"] for i in options["initiatives"]] == [str(init.id)]
    # setting up for another move is refused, even with an otherwise valid body
    origin, dest = Site(name="MP Origin"), Site(name="MP Dest")
    db.add_all([origin, dest])
    await db.flush()
    other.origin_site_id, other.destination_site_id = origin.id, dest.id
    init.origin_site_id, init.destination_site_id = origin.id, dest.id
    db.add(Device(device_type="kiosk", name="Move kiosk", serial="mp-kiosk-1"))
    db.add(StatusValue(record_type="asset", key="mp_scan", label="MP Scan", color="#123456",
                       sort_order=1, is_active=True))
    await db.commit()
    setup = {"serial": "mp-kiosk-1", "site_id": str(dest.id), "scan_status": "mp_scan"}
    r = await client.post("/kiosk/setup", headers=hdrs, json={**setup, "initiative_id": str(other.id)})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"
    # ...while its own move sets up fine
    r = await client.post("/kiosk/setup", headers=hdrs, json={**setup, "initiative_id": str(init.id)})
    assert r.status_code == 200, r.text
    # refresh keeps the move on the rotated session
    refreshed = await client.post("/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["kiosk_move"]["initiative_id"] == str(init.id)
    # an ordinary portal session carries no move
    assert (await client.get("/auth/me", headers=admin)).json()["kiosk_move"] is None
    # a portal route is still refused for a kiosk session
    assert (await client.get("/initiatives", headers=hdrs)).status_code == 403


async def test_move_login_is_rate_limited_per_ip(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    from serversherpa.api.routes.kiosk import MOVE_LOGIN_IP_LIMIT
    for _ in range(MOVE_LOGIN_IP_LIMIT):
        assert (await _move_login(client, "wrong-wrong")).status_code == 401
    r = await _move_login(client)       # even the right password waits out the window
    assert r.status_code == 429 and r.json()["detail"]["code"] == "move_login_rate_limited"


async def test_inactive_moves_refuse_login_and_lose_sessions(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    ok = await _move_login(client)
    hdrs = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    assert (await client.get("/auth/me", headers=hdrs)).status_code == 200
    # completing the move revokes its kiosk sessions and blocks new sign-ins
    r = await client.patch(f"/initiatives/{init.id}", headers=admin, json={"status": "completed"})
    assert r.status_code == 200, r.text
    assert (await client.get("/auth/me", headers=hdrs)).status_code == 401
    r = await _move_login(client)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "move_not_active"
    # archived blocks too
    init2 = await _move(db, "Second")
    await _set(client, admin, init2, "Second-pw-1")
    ok2 = await _move_login(client, "Second-pw-1")
    hdrs2 = {"Authorization": f"Bearer {ok2.json()['access_token']}"}
    assert (await client.post(f"/initiatives/{init2.id}/archive", headers=admin)).status_code == 204
    assert (await client.get("/auth/me", headers=hdrs2)).status_code == 401
    r = await _move_login(client, "Second-pw-1")
    assert r.json()["detail"]["code"] == "move_not_active"
    # clearing the password revokes sessions as well
    init3 = await _move(db, "Third")
    await _set(client, admin, init3, "Third-pw-11")
    ok = await _move_login(client, "Third-pw-11")
    hdrs3 = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    await client.patch(f"/initiatives/{init3.id}", headers=admin, json={"kiosk_password": None})
    assert (await client.get("/auth/me", headers=hdrs3)).status_code == 401


async def test_rename_follows(client, db, seeded_user):
    admin = await _admin(db, client)
    init = await _move(db)
    await _set(client, admin, init)
    await client.patch(f"/initiatives/{init.id}", headers=admin, json={"name": "Renamed move"})
    await db.refresh(init)
    person = await db.get(Person, init.kiosk_person_id)
    assert person.last_name == "Renamed move"
