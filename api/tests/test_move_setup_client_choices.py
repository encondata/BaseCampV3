"""Create a move in steps — the From-To check flags serials that belong to
another client (SS-526, SS-527); staff choose Continue/Skip per serial, the
create is refused until each has a choice, and a changed client makes the
check stale."""


import pytest
from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import Asset, AuditLog, Client, Initiative
from serversherpa.imports.worker import run_once
from tests.test_move_setup_api import (
    BASE,
    admin_login,
    make_sites,
    new_draft,
    reload,
    upload_assets,
)
from tests.test_move_setup_worker import queue

CSV = (b"Serial Number,Asset Name\n"
       b"SN-B1,one\nSN-B2,two\nsn-b1,again\nSN-NEW,fresh\n")


@pytest.fixture
async def admin_hdrs(db, client):
    return await admin_login(db, client, "ada@test.example.com")


async def setup(client, db, hdrs, *, check=True):
    """Acme's draft; SN-B1 and SN-B2 belong to Bravo."""
    acme, bravo = Client(name="Acme"), Client(name="Bravo")
    db.add_all([acme, bravo])
    await db.flush()
    b1 = Asset(name="b1", serial_number="sn-b1", client_id=bravo.id)
    b2 = Asset(name="b2", serial_number="sn-b2", client_id=bravo.id)
    db.add_all([b1, b2])
    await db.commit()
    origin, destination = await make_sites(db)
    draft = await new_draft(client, hdrs, origin, destination, client_id=str(acme.id))
    assert (await upload_assets(client, hdrs, draft["id"], content=CSV)).status_code == 201
    if check:
        assert await run_once(get_sessionmaker()) is True
    return draft, acme, bravo, b1, b2


def put_choices(client, hdrs, draft_id, choices):
    return client.put(f"{BASE}/{draft_id}/assets/choices", headers=hdrs,
                      json={"client_choices": choices})


async def test_wizard_check_flags_conflict_using_draft_client(client, db, admin_hdrs):
    draft, acme, bravo, *_ = await setup(client, db, admin_hdrs)
    check = (await client.get(f"{BASE}/{draft['id']}/assets", headers=admin_hdrs)).json()
    assert check["status"] == "completed"
    conflicts = [d for d in check["results"]["details"] if d["status"] == "conflict"]
    assert {d["serial_number"] for d in conflicts} == {"sn-b1", "sn-b2"}
    assert all(d["current_client"] == {"id": str(bravo.id), "name": "Bravo"}
               for d in conflicts)
    assert check["results"]["summary"]["client_id"] == str(acme.id)
    assert (await reload(check["id"])).options["client_id"] == str(acme.id)


async def test_wizard_create_blocked_until_choices(client, db, admin_hdrs):
    draft, *_ = await setup(client, db, admin_hdrs)
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"code": "client_choices_required",
                                     "serials": ["sn-b1", "sn-b2"]}
    assert (await put_choices(client, admin_hdrs, draft["id"],
                              {"SN-B1": "continue"})).status_code == 422
    assert (await put_choices(client, admin_hdrs, draft["id"],
                              {"SN-B1": "continue", "sn-b2": "skip"})).status_code == 200
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 200, resp.text


async def test_wizard_recheck_clears_choices(client, db, admin_hdrs):
    draft, *_ = await setup(client, db, admin_hdrs)
    assert (await put_choices(client, admin_hdrs, draft["id"],
                              {"sn-b1": "continue", "sn-b2": "skip"})).status_code == 200
    resp = await client.post(f"{BASE}/{draft['id']}/assets/recheck", headers=admin_hdrs)
    assert resp.status_code == 201
    new = await reload(resp.json()["id"])
    assert "client_choices" not in new.options
    assert new.options["client_id"] == (await reload(draft["id"])).payload["move"]["client_id"]


async def test_wizard_create_applies_continue_and_skip(client, db, admin_hdrs):
    draft, acme, bravo, b1, b2 = await setup(client, db, admin_hdrs)
    assert (await put_choices(client, admin_hdrs, draft["id"],
                              {"sn-b1": "continue", "SN-B2": "skip"})).status_code == 200
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert (done.status, done.error) == ("completed", None)
    for a in (b1, b2):
        await db.refresh(a)
    assert b1.client_id == acme.id                  # Continue moved it
    assert b2.client_id == bravo.id                 # Skip kept it
    new = await db.scalar(select(Asset).where(Asset.serial_number == "sn-new"))
    assert new.client_id == acme.id
    statuses = {d["serial_number"]: d["status"]
                for d in done.results["assets"]["details"] if d.get("serial_number")}
    assert statuses["sn-b2"] == "skipped"
    ini = await db.get(Initiative, done.initiative_id)
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.entity_id == str(b1.id)))).all()
    moved = [a for a in audits if "client_id" in (a.changes or {})]
    assert moved and all(a.actor_person_id == done.created_by for a in moved)
    assert str(done.id) in str(moved[0].changes)
    bulk = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.entity_id == str(ini.id),
        AuditLog.action == "bulk_import"))
    # the repeated sn-b1 row is a second conflict row, left out with sn-b2
    assert bulk.changes["assets_left_out"] >= 1
    skipped = done.results["assets"]["summary"]["skipped"]
    assert bulk.changes["assets_left_out"] == (
        done.results["assets"]["summary"]["review"]
        + done.results["assets"]["summary"]["errors"] + skipped)


async def test_wizard_client_change_needs_recheck(client, db, admin_hdrs):
    draft, _acme, bravo, *_ = await setup(client, db, admin_hdrs)
    assert (await put_choices(client, admin_hdrs, draft["id"],
                              {"sn-b1": "continue", "sn-b2": "continue"})).status_code == 200
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"move": {"name": "SJC to DAL", "client_id": str(bravo.id),
                                             "origin_site_id": (await reload(draft["id"])).payload["move"]["origin_site_id"],
                                             "destination_site_id": (await reload(draft["id"])).payload["move"]["destination_site_id"]}})
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": "check_stale_client"}
    # re-checking against the new client clears it (Bravo owns both: no conflicts)
    assert (await client.post(f"{BASE}/{draft['id']}/assets/recheck",
                              headers=admin_hdrs)).status_code == 201
    assert await run_once(get_sessionmaker()) is True
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 200, resp.text


async def test_wizard_choices_validation(client, db, admin_hdrs):
    # no check at all
    origin, destination = await make_sites(db)
    bare = await new_draft(client, admin_hdrs, origin, destination)
    resp = await put_choices(client, admin_hdrs, bare["id"], {})
    assert resp.status_code == 409
    # an unfinished check counts as no completed check
    draft, *_ = await setup(client, db, admin_hdrs, check=False)
    assert (await put_choices(client, admin_hdrs, draft["id"], {})).status_code == 409
    assert await run_once(get_sessionmaker()) is True
    resp = await put_choices(client, admin_hdrs, draft["id"], {"sn-b1": "maybe"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "invalid_client_choice")
    resp = await put_choices(client, admin_hdrs, draft["id"], {"sn-b1": "skip"})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "client_choices_required", "serials": ["sn-b2"]}
    # extra serials are dropped; only flagged ones are stored
    resp = await put_choices(client, admin_hdrs, draft["id"],
                             {"sn-b1": "skip", "SN-B2": "continue", "sn-zzz": "continue"})
    assert resp.status_code == 200, resp.text
    check = await client.get(f"{BASE}/{draft['id']}/assets", headers=admin_hdrs)
    stored = (await reload(check.json()["id"])).options["client_choices"]
    assert {s: c["choice"] for s, c in stored.items()} == {
        "sn-b1": "skip", "sn-b2": "continue"}


async def test_wizard_choices_carry_the_checked_owner(client, db, admin_hdrs):
    draft, _acme, bravo, *_ = await setup(client, db, admin_hdrs)
    resp = await put_choices(client, admin_hdrs, draft["id"],
                             {"sn-b1": "continue", "sn-b2": "skip"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["options"]["client_choices"] == {
        "sn-b1": {"choice": "continue", "from_client_id": str(bravo.id)},
        "sn-b2": {"choice": "skip", "from_client_id": str(bravo.id)}}


async def test_wizard_owner_change_after_check_skips(client, db, admin_hdrs):
    draft, acme, _bravo, b1, b2 = await setup(client, db, admin_hdrs)
    assert (await put_choices(client, admin_hdrs, draft["id"],
                              {"sn-b1": "continue", "sn-b2": "continue"})).status_code == 200
    charlie = Client(name="Charlie")
    db.add(charlie)
    await db.flush()
    b1.client_id = charlie.id
    await db.commit()
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert (done.status, done.error) == ("completed", None)
    await db.refresh(b1)
    await db.refresh(b2)
    assert b1.client_id == charlie.id and b2.client_id == acme.id
    rows = [d for d in done.results["assets"]["details"] if d.get("serial_number") == "sn-b1"]
    assert {d["status"] for d in rows} == {"skipped"}
    assert rows[0]["message"] == "Skipped — belongs to Charlie"
