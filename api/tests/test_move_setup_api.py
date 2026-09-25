"""Bulk Actions › Create a move in steps — the draft routes: gating,
ownership, validation, previews and clashes, skip, the asset check that has
no move, create validation, delete."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AuditLog,
    Container,
    ImportJob,
    Initiative,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
    Truck,
)
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import get_object
from tests.test_assets_api import login, make_login

BASE = "/bulk/move-setup"
FT_CSV = b"Serial Number,Asset Name\nSN-M1,web-01\nSN-M2,web-02\n"
CRATES = {"convention": "CRT-SJC-DAL-xxx", "count": 3, "start": 1,
          "container_type": "pallet", "tags": {"priority": 1}}
TRUCKS = {"convention": "TRK-SJC-DAL-xxx", "count": 2, "start": 1}


async def admin_login(db, client, email: str, first: str = "Ada") -> dict:
    person = Person(first_name=first, last_name="Admin", email=email)
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, email)


async def make_sites(db) -> tuple[Site, Site]:
    origin = Site(name="San Jose DC", code="SJC")
    destination = Site(name="Dallas DC", code="DAL")
    db.add_all([origin, destination])
    await db.commit()
    return origin, destination


def move_body(origin, destination, **over) -> dict:
    return {"name": "SJC to DAL", "initiative_type": "move",
            "origin_site_id": str(origin.id), "destination_site_id": str(destination.id),
            **over}


async def new_draft(client, hdrs, origin, destination, **over) -> dict:
    resp = await client.post(BASE, headers=hdrs, json=move_body(origin, destination, **over))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def upload_assets(client, hdrs, draft_id, content=FT_CSV, filename="ft.csv"):
    return await client.post(
        f"{BASE}/{draft_id}/assets", headers=hdrs,
        data={"make_model_mode": "fuzzy", "generate_serials": "false"},
        files={"file": (filename, content, "text/csv")})


async def reload(job_id):
    """The row as committed right now (a fresh session, never a stale map)."""
    async with get_sessionmaker()() as fresh:
        return await fresh.get(ImportJob, uuid.UUID(str(job_id)))


@pytest.fixture
async def admin_hdrs(db, client):
    return await admin_login(db, client, "ada@test.example.com")


@pytest.fixture
async def other_admin_hdrs(db, client):
    return await admin_login(db, client, "owen@test.example.com", first="Owen")


async def test_staff_are_forbidden_everywhere(client, db, seeded_user):
    hdrs = await login(client)
    origin, destination = await make_sites(db)
    some = uuid.uuid4()
    assert (await client.post(BASE, headers=hdrs,
                              json=move_body(origin, destination))).status_code == 403
    assert (await client.get(f"{BASE}/{some}", headers=hdrs)).status_code == 403
    assert (await client.patch(f"{BASE}/{some}", headers=hdrs, json={})).status_code == 403
    assert (await upload_assets(client, hdrs, some)).status_code == 403
    assert (await client.post(f"{BASE}/{some}/assets/recheck", headers=hdrs)).status_code == 403
    assert (await client.post(f"{BASE}/{some}/create", headers=hdrs)).status_code == 403
    assert (await client.delete(f"{BASE}/{some}", headers=hdrs)).status_code == 403


async def test_an_admin_without_trucks_add_is_forbidden(client, db):
    person = Person(first_name="Tia", last_name="NoTrucks", email="tia@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    db.add(PermissionOverride(person_id=person.id, resource="trucks", action="add",
                              allow=False))
    await db.commit()
    hdrs = await make_login(db, client, person, "tia@test.example.com")
    origin, destination = await make_sites(db)
    resp = await client.post(BASE, headers=hdrs, json=move_body(origin, destination))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_create_draft_stores_the_move_and_writes_nothing_real(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    body = await new_draft(client, admin_hdrs, origin, destination,
                           initiative_type="project", scheduled_start="2026-10-01")
    assert body["status"] == "preview"
    assert body["initiative_id"] is None
    assert body["previews"] is None
    payload = body["payload"]
    assert (payload["assets"], payload["crates"], payload["trucks"]) == (None, None, None)
    assert payload["move"]["initiative_type"] == "move"        # always a move
    assert payload["move"]["name"] == "SJC to DAL"
    assert payload["move"]["origin_site_id"] == str(origin.id)
    job = await reload(body["id"])
    assert (job.kind, job.phase, job.initiative_id) == ("move_setup", "preview", None)
    assert job.progress_at is not None
    assert await db.scalar(select(func.count()).select_from(Initiative)) == 0
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "move_setup_draft_create")) == 1


@pytest.mark.parametrize(("over", "code"), [
    ({"name": "   "}, "name_required"),
    ({"origin_site_id": None}, "origin_required"),
    ({"destination_site_id": None}, "destination_required"),
])
async def test_create_draft_requires_a_name_and_both_sites(client, db, admin_hdrs, over, code):
    origin, destination = await make_sites(db)
    resp = await client.post(BASE, headers=admin_hdrs,
                             json=move_body(origin, destination, **over))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == code


async def test_create_draft_checks_refs_like_a_new_initiative(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    resp = await client.post(BASE, headers=admin_hdrs, json=move_body(
        origin, destination, destination_site_id=str(uuid.uuid4())))
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "site_not_found", "field": "destination_site_id"}


async def test_another_admin_gets_draft_not_found(client, db, admin_hdrs, other_admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}"
    for resp in (await client.get(url, headers=other_admin_hdrs),
                 await client.patch(url, headers=other_admin_hdrs, json={}),
                 await upload_assets(client, other_admin_hdrs, draft["id"]),
                 await client.post(f"{url}/create", headers=other_admin_hdrs),
                 await client.delete(url, headers=other_admin_hdrs)):
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "draft_not_found"


async def test_patch_previews_names_and_flags_clashes(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    db.add_all([Container(name="crt-sjc-dal-002"),
                Container(name="CRT-SJC-DAL-003", archived_at=datetime.now(UTC)),
                Truck(name="TRK-SJC-DAL-001"),
                Truck(name="TRK-SJC-DAL-002", archived_at=datetime.now(UTC))])
    await db.commit()
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"crates": CRATES, "trucks": TRUCKS})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["previews"]["crates"] == {
        "names": ["CRT-SJC-DAL-001", "CRT-SJC-DAL-002", "CRT-SJC-DAL-003"],
        "clashes": ["CRT-SJC-DAL-002"], "error": None}
    assert body["previews"]["trucks"]["clashes"] == ["TRK-SJC-DAL-001"]
    assert body["payload"]["crates"] == CRATES
    assert body["payload"]["trucks"] == TRUCKS


@pytest.mark.parametrize(("section", "value", "message"), [
    ("crates", {**CRATES, "convention": "CRT-001"},
     "Mark the number with a run of x's, like CRT-xxx."),
    ("crates", {**CRATES, "convention": "BOX-xxx"}, "Use only one run of x's for the number."),
    ("crates", {**CRATES, "count": 501}, "The count must be between 0 and 500."),
    ("crates", {**CRATES, "start": -1}, "The start number can't be below 0."),
    ("trucks", {**TRUCKS, "count": 101}, "The count must be between 0 and 100."),
])
async def test_patch_rejects_a_bad_convention_with_a_sentence(
        client, db, admin_hdrs, section, value, message):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={section: value})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "invalid_naming", "message": message}


@pytest.mark.parametrize(("crates", "code"), [
    ({**CRATES, "container_type": "spaceship"}, "bad_container_type"),
    ({**CRATES, "tags": {"priority": 4}}, "tags_exceed_count"),
    ({**CRATES, "tags": {"gold": 1}}, "bad_tag_key"),
])
async def test_patch_checks_crate_type_and_tags(client, db, admin_hdrs, crates, code):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"crates": crates})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == code


async def test_skip_clears_a_section(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}"
    await client.patch(url, headers=admin_hdrs, json={"crates": CRATES})
    resp = await client.patch(url, headers=admin_hdrs, json={"skip": ["crates"]})
    assert resp.status_code == 200
    assert resp.json()["payload"]["crates"] is None
    assert resp.json()["previews"]["crates"] is None


async def test_asset_check_runs_without_a_move(client, db, admin_hdrs, other_admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await upload_assets(client, admin_hdrs, draft["id"])
    assert resp.status_code == 201, resp.text
    check = resp.json()
    assert (check["kind"], check["initiative_id"]) == ("move_assets", None)
    assert (check["phase"], check["status"]) == ("validate", "queued")
    assert check["options"] == {"make_model_mode": "fuzzy", "generate_serials": False,
                                "move_setup_id": draft["id"]}
    got = (await client.get(f"{BASE}/{draft['id']}", headers=admin_hdrs)).json()
    assert got["payload"]["assets"] == {"check_job_id": check["id"], "filename": "ft.csv"}
    row = await reload(check["id"])
    assert row.file_key.startswith(f"import-jobs/move-setup/{draft['id']}/")
    assert await get_object(row.file_key) == FT_CSV

    poll = f"/initiatives/assets/import-jobs/{check['id']}"
    assert (await client.get(poll, headers=other_admin_hdrs)).status_code == 404
    assert await run_once(get_sessionmaker()) is True
    done = await client.get(poll, headers=admin_hdrs)
    assert done.status_code == 200
    assert done.json()["status"] == "completed"
    assert done.json()["results"]["summary"]["created"] == 2
    for action in ("commit", "reprocess"):
        refused = await client.post(f"{poll}/{action}", headers=admin_hdrs)
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "check_only"
    assert await db.scalar(select(func.count()).select_from(Asset)) == 0


async def test_a_new_upload_replaces_the_previous_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    first = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    second = (await upload_assets(client, admin_hdrs, draft["id"], filename="ft2.csv")).json()
    assert await reload(first["id"]) is None
    got = (await client.get(f"{BASE}/{draft['id']}", headers=admin_hdrs)).json()
    assert got["payload"]["assets"] == {"check_job_id": second["id"], "filename": "ft2.csv"}


async def test_a_running_check_is_flagged_not_deleted_when_replaced(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    first = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    claimed = (await upload_assets(client, admin_hdrs, draft["id"], filename="ft2.csv")).json()
    async with get_sessionmaker()() as side:          # the worker claims the second one
        await side.execute(update(ImportJob).where(ImportJob.id == uuid.UUID(claimed["id"]))
                           .values(status="running"))
        await side.commit()
    third = (await upload_assets(client, admin_hdrs, draft["id"], filename="ft3.csv")).json()
    assert await reload(first["id"]) is None          # queued when replaced: deleted
    still = await reload(claimed["id"])
    assert (still.status, still.cancel_requested) == ("running", True)
    kept = await reload(third["id"])
    assert (kept.status, kept.cancel_requested) == ("queued", False)
    resp = await client.delete(f"{BASE}/{draft['id']}", headers=admin_hdrs)
    assert resp.status_code == 204
    assert await reload(third["id"]) is None
    assert (await reload(claimed["id"])).cancel_requested is True


async def test_recheck_queues_a_new_check_over_the_same_file(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}/assets/recheck"
    none_yet = await client.post(url, headers=admin_hdrs)
    assert none_yet.status_code == 409
    assert none_yet.json()["detail"]["code"] == "no_asset_file"
    first = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    assert await run_once(get_sessionmaker()) is True
    again = await client.post(url, headers=admin_hdrs)
    assert again.status_code == 201, again.text
    new = again.json()
    assert new["id"] != first["id"] and new["status"] == "queued"
    assert new["options"]["move_setup_id"] == draft["id"]
    assert await reload(first["id"]) is None
    assert await get_object((await reload(new["id"])).file_key) == FT_CSV


async def test_skipping_assets_removes_the_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    check = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"skip": ["assets"]})
    assert resp.json()["payload"]["assets"] is None
    assert await reload(check["id"]) is None


async def test_create_rejects_an_unfinished_asset_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await upload_assets(client, admin_hdrs, draft["id"])               # queued, never run
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "setup_invalid", "reasons": [
        "The From-To file is still being checked. Wait for it to finish, then create the move."]}


async def test_create_rejects_clashes_and_a_missing_crate_type(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    db.add(Truck(name="TRK-SJC-DAL-002"))
    await db.commit()
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs, json={
        "crates": {**CRATES, "container_type": None, "tags": {}}, "trucks": TRUCKS})
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["reasons"] == [
        "Pick a crate type.", "These truck names already exist: TRK-SJC-DAL-002."]


async def test_create_queues_the_draft_and_locks_it(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}"
    await client.patch(url, headers=admin_hdrs, json={"crates": CRATES, "trucks": TRUCKS})
    resp = await client.post(f"{url}/create", headers=admin_hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "queued"
    job = await reload(draft["id"])
    assert (job.phase, job.processed_rows, job.error) == ("commit", 0, None)
    for locked in (await client.patch(url, headers=admin_hdrs, json={}),
                   await client.delete(url, headers=admin_hdrs),
                   await client.post(f"{url}/create", headers=admin_hdrs)):
        assert locked.status_code == 409
        assert locked.json()["detail"]["code"] == "draft_not_editable"
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "move_setup_queued")) == 1


async def test_delete_removes_the_draft_and_its_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    check = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    resp = await client.delete(f"{BASE}/{draft['id']}", headers=admin_hdrs)
    assert resp.status_code == 204
    assert await reload(draft["id"]) is None
    assert await reload(check["id"]) is None
    assert (await client.get(f"{BASE}/{draft['id']}", headers=admin_hdrs)).status_code == 404


async def test_get_draft_assets_returns_the_check_once_the_worker_validates_it(
        client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    check = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    url = f"{BASE}/{draft['id']}/assets"
    queued = await client.get(url, headers=admin_hdrs)
    assert queued.status_code == 200, queued.text
    assert queued.json()["id"] == check["id"]
    assert queued.json()["status"] == "queued"
    assert await run_once(get_sessionmaker()) is True
    done = await client.get(url, headers=admin_hdrs)
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "completed"
    assert done.json()["results"]["summary"]["created"] == 2


async def test_get_draft_assets_for_another_admin_gets_draft_not_found(
        client, db, admin_hdrs, other_admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await upload_assets(client, admin_hdrs, draft["id"])
    resp = await client.get(f"{BASE}/{draft['id']}/assets", headers=other_admin_hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "draft_not_found"


async def test_get_draft_assets_with_no_check_gets_no_asset_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await client.get(f"{BASE}/{draft['id']}/assets", headers=admin_hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "no_asset_check"


async def test_an_admin_without_initiatives_change_can_still_poll_the_check(client, db):
    person = Person(first_name="Cam", last_name="NoChange", email="cam@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    db.add(PermissionOverride(person_id=person.id, resource="initiatives", action="change",
                              allow=False))
    await db.commit()
    hdrs = await make_login(db, client, person, "cam@test.example.com")
    origin, destination = await make_sites(db)
    draft = await new_draft(client, hdrs, origin, destination)
    await upload_assets(client, hdrs, draft["id"])
    resp = await client.get(f"{BASE}/{draft['id']}/assets", headers=hdrs)
    assert resp.status_code == 200, resp.text
