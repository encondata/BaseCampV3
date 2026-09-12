"""POST /containers/bulk — numbered batch create with label-tag assignment."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Client, Container, Initiative, PermissionOverride, Person,
    PersonRole, Site,
)

from .test_assets_api import login, make_login


async def test_names_prefix_pad_suffix_start(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 3, "container_type": "pallet",
        "naming": {"prefix": "PLT-", "start": 5, "pad": 3, "suffix": "-A"},
    })
    assert resp.status_code == 201, resp.text
    names = [c["name"] for c in resp.json()["created"]]
    assert names == ["PLT-005-A", "PLT-006-A", "PLT-007-A"]


async def test_names_no_pad_no_prefix_suffix(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 3, "container_type": "pallet",
    })
    assert resp.status_code == 201, resp.text
    names = [c["name"] for c in resp.json()["created"]]
    assert names == ["1", "2", "3"]


async def test_naming_bounds(client, db, seeded_user):
    hdrs = await login(client)

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "naming": {"prefix": "P" * 41},
    })
    assert resp.status_code == 422

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "naming": {"suffix": "S" * 41},
    })
    assert resp.status_code == 422

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "naming": {"pad": 7},
    })
    assert resp.status_code == 422

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "naming": {"start": -1},
    })
    assert resp.status_code == 422


async def test_negative_tag_count_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "tags": {"priority": -1},
    })
    assert resp.status_code == 422


async def test_archived_collision_does_not_block_creation(client, db, seeded_user):
    hdrs = await login(client)
    db.add(Container(name="C-2", archived_at=datetime.now(UTC)))
    await db.commit()

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 3, "container_type": "pallet",
        "naming": {"prefix": "C-", "pad": 1},
    })
    assert resp.status_code == 201, resp.text
    names = [c["name"] for c in resp.json()["created"]]
    assert names == ["C-1", "C-2", "C-3"]

    rows = list(await db.scalars(select(Container).where(
        Container.name.in_(["C-1", "C-2", "C-3"]),
        Container.archived_at.is_(None))))
    assert len(rows) == 3


async def test_tag_assignment_order(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 5, "container_type": "pallet",
        "naming": {"prefix": "C-", "pad": 1},
        "tags": {"priority": 1, "vendor": 2},
    })
    assert resp.status_code == 201, resp.text
    created = resp.json()["created"]
    assert [c["name"] for c in created] == ["C-1", "C-2", "C-3", "C-4", "C-5"]
    assert [c["label_tag"] for c in created] == [
        "priority", "vendor", "vendor", None, None]


async def test_tag_assignment_full_order_all_five(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 5, "container_type": "pallet",
        "naming": {"prefix": "D-", "pad": 1},
        "tags": {"priority": 1, "vendor": 1, "accessories": 1,
                 "warehouse": 1, "ewaste": 1},
    })
    assert resp.status_code == 201, resp.text
    created = resp.json()["created"]
    assert [c["label_tag"] for c in created] == [
        "priority", "vendor", "accessories", "warehouse", "ewaste"]


async def test_tags_exceed_count_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "tags": {"priority": 2, "vendor": 1},
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "tags_exceed_count"


async def test_bad_tag_key_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "tags": {"nope": 1},
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_tag_key"
    assert set(resp.json()["detail"]["allowed"]) == {
        "priority", "vendor", "accessories", "ewaste", "warehouse"}


async def test_bad_container_type_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "nope",
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_container_type"


async def test_bad_status_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet", "status": "nope",
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_status"


async def test_initiative_not_found_404(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "initiative_id": "00000000-0000-0000-0000-000000000000",
    })
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    archived = Initiative(name="Done Move", initiative_type="move",
                          status="completed", archived_at=datetime.now(UTC))
    db.add(archived)
    await db.commit()
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "initiative_id": str(archived.id),
    })
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"


async def test_site_not_found(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
        "site_id": "00000000-0000-0000-0000-000000000000",
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "site_not_found"


async def test_collision_422_and_no_rows_created(client, db, seeded_user):
    hdrs = await login(client)
    db.add(Container(name="C-2"))
    await db.commit()

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 3, "container_type": "pallet",
        "naming": {"prefix": "C-", "pad": 1},
    })
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "name_collision"
    assert resp.json()["detail"]["names"] == ["C-2"]

    remaining = list(await db.scalars(select(Container.name).where(
        Container.name.in_(["C-1", "C-2", "C-3"]))))
    assert remaining == ["C-2"]   # only the pre-existing row — nothing created


async def test_collision_case_insensitive(client, db, seeded_user):
    hdrs = await login(client)
    db.add(Container(name="c-2"))
    await db.commit()

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 3, "container_type": "pallet",
        "naming": {"prefix": "C-", "pad": 1},
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "name_collision"
    assert resp.json()["detail"]["names"] == ["C-2"]


async def test_count_bounds(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 0, "container_type": "pallet",
    })
    assert resp.status_code == 422

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 501, "container_type": "pallet",
    })
    assert resp.status_code == 422


async def test_no_permission_403(client, db, seeded_user):
    org = Client(name="Org")
    db.add(org)
    await db.flush()
    nobody = Person(first_name="No", last_name="Body")
    db.add(nobody)
    await db.flush()
    db.add(PersonRole(person_id=nobody.id, role="client_viewer", client_id=org.id))
    await db.commit()
    hdrs = await make_login(db, client, nobody, "nobody-bulk@test.example.com")
    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
    })
    assert resp.status_code == 403


async def test_view_only_cannot_bulk_create(client, db, seeded_user):
    """A person with containers:view but not containers:add can list
    containers but must not be able to bulk-create them — distinguishes
    the route's "add" gate from a weaker "view" gate.

    Containers is an internal-only resource (visible_to = {"global"}), so a
    client/partner-anchored role like client_viewer is hard-blocked from it
    regardless of any override (see access/resolver.py — the visible_to
    check runs before overrides are consulted). To build a genuine
    view-but-not-add actor we instead take a global-anchored role that is
    normally FULL on containers ("staff") and override just the "add"
    action to False — the override mechanism can revoke a granted action,
    not just grant one (PermissionOverride idiom per
    test_access_resolver.py's test_override_beats_group_gate)."""
    viewer = Person(first_name="View", last_name="Only")
    db.add(viewer)
    await db.flush()
    db.add(PersonRole(person_id=viewer.id, role="staff"))
    db.add(PermissionOverride(person_id=viewer.id, resource="containers",
                              action="add", allow=False))
    await db.commit()
    hdrs = await make_login(db, client, viewer, "view-only-bulk@test.example.com")

    assert (await client.get("/containers", headers=hdrs)).status_code == 200

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 2, "container_type": "pallet",
    })
    assert resp.status_code == 403


async def test_201_shape_and_audit_rows(client, db, seeded_user):
    hdrs = await login(client)
    site = Site(name="DC-1")
    ini = Initiative(name="NAP-Bulk", initiative_type="move", status="planned")
    db.add_all([site, ini])
    await db.commit()

    resp = await client.post("/containers/bulk", headers=hdrs, json={
        "count": 3, "container_type": "pallet",
        "naming": {"prefix": "B-", "pad": 1},
        "site_id": str(site.id), "initiative_id": str(ini.id),
        "tags": {"priority": 1},
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    created = body["created"]
    assert len(created) == 3
    assert [c["name"] for c in created] == ["B-1", "B-2", "B-3"]
    first = created[0]
    assert first["status"] == "available"
    assert first["status_label"] == "Available"
    assert first["container_type"] == "pallet"
    assert first["type_label"] == "Pallet"
    assert first["site_id"] == str(site.id)
    assert first["site_name"] == "DC-1"
    assert first["initiative_id"] == str(ini.id)
    assert first["initiative_name"] == "NAP-Bulk"
    assert first["label_tag"] == "priority"
    assert first["asset_count"] == 0

    ids = [c["id"] for c in created]
    rows = list(await db.scalars(
        select(AuditLog).where(AuditLog.entity_type == "container",
                               AuditLog.entity_id.in_(ids))))
    assert len(rows) == 3
    assert {r.action for r in rows} == {"create"}
    assert {r.entity_id for r in rows} == set(ids)
