"""Site scoping: assignment CRUD, replace semantics, filter incl. globals."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import Site

from tests.test_status_values_write import _make

DESIGN = {"size": {"w": 4, "h": 2}, "elements": []}


def _body(name, **over):
    base = {"name": name, "label_type": "top", "size_key": "4x2",
            "dpi_key": "203", "language_key": "zpl",
            "kind": "design", "design": DESIGN}
    base.update(over)
    return base


async def _two_sites(db):
    a, b = Site(name="Site A"), Site(name="Site B")
    db.add(a)
    db.add(b)
    await db.commit()
    return str(a.id), str(b.id)


async def _admin(db, client):
    return await _make(db, client, "admin", "adm@test.example.com")


async def test_create_with_sites_and_get(client, db, seeded_user):
    sa, sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body("scoped", site_ids=[sa, sb]))
    assert resp.status_code == 201, resp.text
    assert sorted(resp.json()["site_ids"]) == sorted([sa, sb])
    got = (await client.get(f"/labels/templates/{resp.json()['id']}",
                            headers=hdrs)).json()
    assert sorted(got["site_ids"]) == sorted([sa, sb])


async def test_create_default_is_global(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body("global"))
    assert resp.status_code == 201
    assert resp.json()["site_ids"] == []


async def test_unknown_site_422(client, db, seeded_user):
    hdrs = await _admin(db, client)
    ghost = str(uuid.uuid4())
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body("bad", site_ids=[ghost]))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_site"
    assert resp.json()["detail"]["site_id"] == ghost


async def test_patch_replace_clear_and_absent(client, db, seeded_user):
    sa, sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    tid = (await client.post("/labels/templates", headers=hdrs,
                             json=_body("t", site_ids=[sa]))).json()["id"]
    # replace: version bumps (2)
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"site_ids": [sb]})
    assert resp.json()["site_ids"] == [sb]
    assert resp.json()["version"] == 2
    # absent: untouched, no bump
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "x"})
    assert resp.json()["site_ids"] == [sb]
    assert resp.json()["version"] == 3  # description changed
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "x"})
    assert resp.json()["version"] == 3  # true no-op
    # same list: no bump
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"site_ids": [sb]})
    assert resp.json()["version"] == 3
    # clear to global: bumps
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"site_ids": []})
    assert resp.json()["site_ids"] == [] and resp.json()["version"] == 4


async def test_site_filter_returns_assigned_plus_globals(client, db,
                                                         seeded_user):
    sa, sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("a-only", site_ids=[sa]))
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("b-only", site_ids=[sb]))
    await client.post("/labels/templates", headers=hdrs, json=_body("global"))
    rows = (await client.get(f"/labels/templates?site_id={sa}",
                             headers=hdrs)).json()
    assert sorted(r["name"] for r in rows) == ["a-only", "global"]
    # composes with existing filters
    rows = (await client.get(
        f"/labels/templates?site_id={sa}&label_type=container",
        headers=hdrs)).json()
    assert rows == []


async def test_listing_carries_site_ids(client, db, seeded_user):
    sa, _sb = await _two_sites(db)
    hdrs = await _admin(db, client)
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("t1", site_ids=[sa]))
    rows = (await client.get("/labels/templates", headers=hdrs)).json()
    assert rows[0]["site_ids"] == [sa]
