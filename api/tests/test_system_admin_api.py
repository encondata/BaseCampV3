"""Admin controls: public status, gated admin config get/put, audit."""

import asyncio
from uuid import uuid4

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import AuditLog, SystemConfig
from serversherpa.scans import worker as scan_worker
from serversherpa.system.admin_config import workers_paused

from tests.test_status_values_write import _make


async def _admin(db, client):
    return await _make(db, client, "super_admin", "sa@test.example.com")


async def test_status_is_public_and_defaults_off(client):
    resp = await client.get("/system/status")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "read_only": False, "read_only_message": "",
        "workers_paused": False, "banner": None,
    }


async def test_admin_get_requires_settings_change(client, db, seeded_user):
    staff = await _make(db, client, "staff", "st@test.example.com")
    assert (await client.get("/system/admin", headers=staff)).status_code == 403
    hdrs = await _admin(db, client)
    resp = await client.get("/system/admin", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == {
        "read_only": False, "read_only_message": "", "pause_workers": False,
        "banner_enabled": False, "banner_message": "",
    }


async def test_put_merges_trims_and_audits(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs, json={
        "read_only": True, "read_only_message": "  Cutover until 14:00  ",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["read_only"] is True
    assert body["read_only_message"] == "Cutover until 14:00"
    assert body["banner_enabled"] is False          # untouched fields keep defaults

    # second patch only touches the banner; read-only survives the merge
    resp = await client.put("/system/admin", headers=hdrs, json={
        "banner_enabled": True, "banner_message": "Hello all",
    })
    assert resp.status_code == 200
    assert resp.json()["read_only"] is True
    assert resp.json()["banner_message"] == "Hello all"

    row = await db.get(SystemConfig, "admin")
    assert row is not None and row.data["banner_message"] == "Hello all"
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "admin",
        AuditLog.action == "admin_config_update"))).all()
    assert len(audits) == 2
    assert audits[0].changes["read_only"] == {"from": False, "to": True}
    assert "banner_enabled" not in audits[0].changes   # unchanged fields omitted

    status = (await client.get("/system/status")).json()
    assert status == {"read_only": True, "read_only_message": "Cutover until 14:00",
                      "workers_paused": False, "banner": "Hello all"}


async def test_status_hides_read_only_message_until_mode_is_on(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs, json={
        "read_only_message": "Cutover soon", "read_only": False,
    })
    assert resp.status_code == 200, resp.text
    # staged but not live: the public status blanks it, the admin view
    # still shows the draft so the editor doesn't lose it
    status = (await client.get("/system/status")).json()
    assert status["read_only_message"] == ""
    admin = (await client.get("/system/admin", headers=hdrs)).json()
    assert admin["read_only_message"] == "Cutover soon"

    resp = await client.put("/system/admin", headers=hdrs, json={"read_only": True})
    assert resp.status_code == 200, resp.text
    status = (await client.get("/system/status")).json()
    assert status["read_only_message"] == "Cutover soon"


async def test_put_rejects_blank_banner_and_unknown_fields(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"banner_enabled": True, "banner_message": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "banner_message_required"
    resp = await client.put("/system/admin", headers=hdrs, json={"bogus": 1})
    assert resp.status_code == 422
    # disabling a banner with a blank message is fine
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"banner_enabled": False})
    assert resp.status_code == 200


async def test_status_hides_banner_when_disabled_and_reports_pause(client, db, seeded_user):
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs, json={
        "banner_enabled": True, "banner_message": "Up soon", "pause_workers": True,
    })
    status = (await client.get("/system/status")).json()
    assert status["banner"] == "Up soon"
    assert status["workers_paused"] is False       # pause needs read_only too
    await client.put("/system/admin", headers=hdrs,
                     json={"banner_enabled": False, "read_only": True})
    status = (await client.get("/system/status")).json()
    assert status["banner"] is None
    assert status["workers_paused"] is True


def _site_payload(name):
    # POST /sites requires only "name"; a fresh name per call avoids any
    # cross-test collisions even though the column isn't unique-constrained.
    return {"name": name}


async def _freeze(db, client, hdrs=None, message="Cutover in progress"):
    """Turn read-only on. Reuses `hdrs` when given instead of minting a new
    super_admin — calling `_admin` twice in one test would try to create
    sa@test.example.com again and trip the people_email_uniq constraint."""
    hdrs = hdrs or await _admin(db, client)
    resp = await client.put("/system/admin", headers=hdrs,
                            json={"read_only": True, "read_only_message": message})
    assert resp.status_code == 200, resp.text
    return hdrs


# /sites is chosen for these tests over /status-values because POST
# /status-values is gated to the devtools resource (developer_only=True),
# which super_admin never holds by design (access/defaults.py: super_admin
# gets FULL for every resource except devtools). A 423 from a devtools-gated
# route wouldn't prove anything about the read-only OFF branch, since the
# permission check and the read-only check would be indistinguishable.
# super_admin holds FULL on "sites" (a genuine, non-allowlisted, mutating
# resource), so a 423 there is unambiguously caused by read-only mode.


async def test_read_only_off_is_transparent(client, db, seeded_user):
    # baseline: with read_only untouched (default off), a super_admin's
    # ordinary write is unaffected by the enforce_read_only dependency
    sa = await _admin(db, client)
    resp = await client.post("/sites", headers=sa, json=_site_payload("Site Off"))
    assert resp.status_code == 201, resp.text


async def test_read_only_blocks_non_developer_writes(client, db, seeded_user):
    sa = await _freeze(db, client)
    resp = await client.post("/sites", headers=sa, json=_site_payload("Site Blocked"))
    assert resp.status_code == 423, resp.text
    assert resp.json()["detail"] == {"code": "read_only_mode",
                                     "message": "Cutover in progress"}
    # reads are untouched
    assert (await client.get("/sites", headers=sa)).status_code == 200


async def test_read_only_exempts_developers(client, db, seeded_user):
    await _freeze(db, client)
    dev = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/sites", headers=dev, json=_site_payload("Site Dev"))
    assert resp.status_code == 201, resp.text


async def test_read_only_allowlists_auth_and_the_toggle(client, db, seeded_user):
    sa = await _freeze(db, client)
    # the admin who froze the portal can always lift it
    resp = await client.put("/system/admin", headers=sa, json={"read_only": False})
    assert resp.status_code == 200
    # ...and writes flow again, for the same super_admin actor
    resp = await client.post("/sites", headers=sa, json=_site_payload("Site Lifted"))
    assert resp.status_code == 201
    # freeze again, reusing the same admin (calling _freeze without hdrs
    # would re-create sa@test.example.com and trip the email-uniqueness
    # constraint)
    await _freeze(db, client, hdrs=sa)
    # allowlisted auth routes are never frozen: preferences and revoking
    # your own session are sign-in/out housekeeping
    resp = await client.put("/auth/me/preferences", headers=sa, json={})
    assert resp.status_code == 200
    # revoking a session is allowlisted too; a 404 for an unknown id
    # proves the request cleared the read-only gate (a frozen route
    # would return 423, not 404)
    resp = await client.delete(f"/auth/me/sessions/{uuid4()}", headers=sa)
    assert resp.status_code == 404
    # but a profile edit is an ordinary content write and freezes like
    # anything else under /auth/me
    resp = await client.patch("/auth/me/profile", headers=sa, json={})
    assert resp.status_code == 423
    assert resp.json()["detail"]["code"] == "read_only_mode"
    # logout itself is allowlisted too (checked last: it ends the session)
    resp = await client.post("/auth/logout", headers=sa)
    assert resp.status_code == 204


async def test_workers_paused_helper(client, db, seeded_user):
    assert await workers_paused(get_sessionmaker()) is False
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs,
                     json={"read_only": True, "pause_workers": True})
    assert await workers_paused(get_sessionmaker()) is True


async def test_scan_worker_idles_while_paused(client, db, seeded_user, monkeypatch):
    calls: list[int] = []

    async def fake_run_once(maker):
        calls.append(1)
        return False

    monkeypatch.setattr(scan_worker, "run_once", fake_run_once)
    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    hdrs = await _admin(db, client)
    await client.put("/system/admin", headers=hdrs,
                     json={"read_only": True, "pause_workers": True})

    task = asyncio.create_task(scan_worker.run_forever(poll_seconds=0.05))
    await asyncio.sleep(0.3)
    assert calls == []                                   # paused: no work
    await client.put("/system/admin", headers=hdrs, json={"pause_workers": False})
    await asyncio.sleep(0.3)
    assert len(calls) >= 1                               # resumed within a poll
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_poll_workers_paused_swallows_db_blip_and_logs_once(monkeypatch, caplog):
    import logging

    from serversherpa.system import admin_config

    state: dict = {}

    async def boom(sessionmaker):
        raise RuntimeError("db down")

    monkeypatch.setattr(admin_config, "workers_paused", boom)
    with caplog.at_level(logging.WARNING, logger="serversherpa.system.admin_config"):
        assert await admin_config.poll_workers_paused(None, state) is False
        assert await admin_config.poll_workers_paused(None, state) is False
    warnings = [r for r in caplog.records
                if r.levelno == logging.WARNING
                and r.name == "serversherpa.system.admin_config"]
    assert len(warnings) == 1                    # logged once per outage
    assert state["pause_check_failed"] is True

    async def ok(sessionmaker):
        return True

    monkeypatch.setattr(admin_config, "workers_paused", ok)
    assert await admin_config.poll_workers_paused(None, state) is True
    assert state["pause_check_failed"] is False   # a good read re-arms the warning

    caplog.clear()
    monkeypatch.setattr(admin_config, "workers_paused", boom)
    with caplog.at_level(logging.WARNING, logger="serversherpa.system.admin_config"):
        assert await admin_config.poll_workers_paused(None, state) is False
    warnings = [r for r in caplog.records
                if r.levelno == logging.WARNING
                and r.name == "serversherpa.system.admin_config"]
    assert len(warnings) == 1                     # re-armed: logs again


async def test_scan_worker_survives_pause_check_blip(client, db, seeded_user, monkeypatch):
    calls: list[int] = []

    async def fake_run_once(maker):
        calls.append(1)
        return False

    async def boom(sessionmaker):
        raise RuntimeError("db down")

    monkeypatch.setattr(scan_worker, "run_once", fake_run_once)
    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    monkeypatch.setattr("serversherpa.system.admin_config.workers_paused", boom)

    task = asyncio.create_task(scan_worker.run_forever(poll_seconds=0.05))
    await asyncio.sleep(0.3)
    assert not task.done()               # a DB blip on the pause check must not kill it
    assert len(calls) >= 1               # treated as "not paused" — work keeps flowing
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
