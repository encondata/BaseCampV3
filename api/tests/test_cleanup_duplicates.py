"""Data cleanup: the duplicate finder (GET /devtools/cleanup/duplicates).
Report only: assets sharing a serial, people sharing a name."""

from datetime import UTC, datetime

from serversherpa.db.models import (
    Asset,
    PermissionOverride,
    Person,
    PersonRole,
    Site,
    UserAccount,
    WorkerProfile,
)
from serversherpa.devtools import duplicates
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from tests.test_assets_api import make_login
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

URL = "/devtools/cleanup/duplicates"


async def _get(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    hdrs = await devtools_login(client)
    resp = await client.get(URL, headers=hdrs)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _asset(serial, name="A", **kw):
    return Asset(serial_number=serial, name=name, **kw)


async def test_serials_match_ignoring_case_and_surrounding_spaces(client, db, seeded_user):
    site = Site(name="DC-Dup")
    db.add(site)
    await db.flush()
    db.add_all([
        _asset("SN-100", "Rack 10", site_id=site.id, status="active"),
        _asset("  sn-100 ", "Rack 2"),
        _asset("Sn-100", "Rack 1"),
        _asset("SN-200", "Other"),
    ])
    await db.commit()
    body = await _get(db, client, seeded_user)
    assert len(body["assets"]) == 1
    group = body["assets"][0]
    assert group["serial"].strip().lower() == "sn-100"
    # natural order inside a group
    assert [i["name"] for i in group["items"]] == ["Rack 1", "Rack 2", "Rack 10"]
    ten = group["items"][2]
    assert ten["site_name"] == "DC-Dup"
    assert ten["status_label"] == "Active"
    assert ten["href"] == f"/assets?open={ten['id']}"
    assert set(ten) == {"id", "name", "serial_number", "site_name", "status_label", "href"}


async def test_empty_null_archived_and_singletons_are_ignored(client, db, seeded_user):
    db.add_all([
        _asset(None), _asset(None), _asset(""), _asset(""), _asset("   "), _asset("   "),
        _asset("ARCH-1"), _asset("arch-1", archived_at=datetime.now(UTC)),
        _asset("ONLY-1"),
    ])
    await db.commit()
    body = await _get(db, client, seeded_user)
    assert body["assets"] == []


async def test_groups_largest_first_then_by_key(client, db, seeded_user):
    db.add_all([_asset("b-2"), _asset("B-2"), _asset("a-3"), _asset("A-3"),
                _asset("a-3 "), _asset("a-1"), _asset("A-1")])
    await db.commit()
    body = await _get(db, client, seeded_user)
    assert [g["serial"].strip().lower() for g in body["assets"]] == ["a-3", "a-1", "b-2"]
    assert [len(g["items"]) for g in body["assets"]] == [3, 2, 2]


async def test_people_group_by_trimmed_lowercase_name(client, db, seeded_user):
    a = Person(first_name="Dana", last_name="Reyes", email="d1@test.example.com")
    b = Person(first_name=" dana ", last_name="REYES ", email="d2@test.example.com")
    c = Person(first_name="Dana", last_name="Reyes-Smith")
    d = Person(first_name="Archived", last_name="Dup")
    e = Person(first_name="Archived", last_name="Dup", archived_at=datetime.now(UTC))
    f = Person(first_name="Hidden", last_name="Kiosk", source=KIOSK_MOVE_SOURCE)
    g = Person(first_name="Hidden", last_name="Kiosk", source=KIOSK_MOVE_SOURCE)
    h = Person(first_name="Hidden", last_name="Kiosk")
    db.add_all([a, b, c, d, e, f, g, h])
    await db.commit()
    body = await _get(db, client, seeded_user)
    names = {grp["name"].lower() for grp in body["people"]}
    assert "dana reyes" in names
    assert "archived dup" not in names
    assert "hidden kiosk" not in names
    grp = next(x for x in body["people"] if x["name"].lower() == "dana reyes")
    assert {i["id"] for i in grp["items"]} == {str(a.id), str(b.id)}
    assert set(grp["items"][0]) == {
        "id", "display_name", "email", "has_login", "is_worker", "href"}


async def test_people_href_login_then_worker_then_none(client, db, seeded_user):
    login_p = Person(first_name="Pat", last_name="Twin", email="pt-login@test.example.com")
    both = Person(first_name="Pat", last_name="Twin")
    worker = Person(first_name="Pat", last_name="Twin")
    plain = Person(first_name="Pat", last_name="Twin")
    db.add_all([login_p, both, worker, plain])
    await db.flush()
    db.add_all([
        UserAccount(person_id=login_p.id, email="pt-login@test.example.com",
                    password_hash="x", password_updated_at=datetime.now(UTC)),
        UserAccount(person_id=both.id, email="pt-both@test.example.com",
                    password_hash="x", password_updated_at=datetime.now(UTC)),
        WorkerProfile(person_id=both.id), WorkerProfile(person_id=worker.id),
    ])
    await db.commit()
    body = await _get(db, client, seeded_user)
    grp = next(x for x in body["people"] if x["name"] == "Pat Twin")
    by_id = {i["id"]: i for i in grp["items"]}
    assert by_id[str(login_p.id)]["href"] == f"/people/users/{login_p.id}"
    assert by_id[str(login_p.id)]["has_login"] and not by_id[str(login_p.id)]["is_worker"]
    assert by_id[str(both.id)]["href"] == f"/people/users/{both.id}"
    assert by_id[str(both.id)]["has_login"] and by_id[str(both.id)]["is_worker"]
    assert by_id[str(worker.id)]["href"] == f"/people/workers/{worker.id}"
    assert by_id[str(worker.id)]["is_worker"] and not by_id[str(worker.id)]["has_login"]
    assert by_id[str(plain.id)]["href"] is None


async def test_group_cap(client, db, seeded_user, monkeypatch):
    monkeypatch.setattr(duplicates, "MAX_GROUPS", 1)
    db.add_all([_asset("x-1"), _asset("X-1"), _asset("x-1 "), _asset("y-1"), _asset("Y-1")])
    db.add_all([Person(first_name="Cap", last_name="One"),
                Person(first_name="Cap", last_name="One"),
                Person(first_name="Cap", last_name="Two"),
                Person(first_name="Cap", last_name="Two"),
                Person(first_name="Cap", last_name="Two")])
    await db.commit()
    body = await _get(db, client, seeded_user)
    assert len(body["assets"]) == 1 and len(body["assets"][0]["items"]) == 3
    assert len(body["people"]) == 1 and body["people"][0]["name"] == "Cap Two"


async def test_non_developer_403_and_unauthenticated_401(client, db, seeded_user):
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-dups@test.example.com")
    assert (await client.get(URL, headers=hdrs)).status_code == 403
    assert (await client.get(URL)).status_code == 401


async def test_view_only_developer_can_read(client, db, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    db.add(PermissionOverride(person_id=seeded_user.id, resource="devtools",
                              action="change", allow=False))
    await db.commit()
    hdrs = await devtools_login(client)
    assert (await client.get(URL, headers=hdrs)).status_code == 200
