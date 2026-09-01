"""Template CRUD: filters, version bump, deactivate-on-delete, vocab checks."""

from sqlalchemy import text

from tests.test_sites_api import login
from tests.test_status_values_write import _make

DESIGN = {"size": {"w": 4, "h": 2}, "elements": []}


def _body(name="tpl-1", **over):
    base = {"name": name, "label_type": "top", "size_key": "4x2",
            "dpi_key": "203", "language_key": "zpl",
            "kind": "design", "design": DESIGN}
    base.update(over)
    return base


async def _admin(db, client):
    return await _make(db, client, "admin", "adm@test.example.com")


async def test_create_and_get(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs, json=_body())
    assert resp.status_code == 201, resp.text
    tid = resp.json()["id"]
    assert resp.json()["version"] == 1
    got = await client.get(f"/labels/templates/{tid}", headers=hdrs)
    assert got.status_code == 200 and got.json()["name"] == "tpl-1"


async def test_create_unknown_vocab_422(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body(size_key="9x9"))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_vocab"


async def test_create_payload_mismatch_422(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body(kind="code", code=None))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_payload"
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body(kind="code", code="^XA^XZ",
                                        design=None))
    assert resp.status_code == 201


async def test_duplicate_name_409(client, db, seeded_user):
    hdrs = await _admin(db, client)
    assert (await client.post("/labels/templates", headers=hdrs,
                              json=_body())).status_code == 201
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_body(name="TPL-1"))  # CITEXT: same name
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "label_template_exists"


async def test_list_filters(client, db, seeded_user):
    hdrs = await _admin(db, client)
    await client.post("/labels/templates", headers=hdrs, json=_body("a"))
    await client.post("/labels/templates", headers=hdrs,
                      json=_body("b", label_type="container",
                                 language_key="escp"))
    rows = (await client.get("/labels/templates?label_type=container",
                             headers=hdrs)).json()
    assert [r["name"] for r in rows] == ["b"]
    rows = (await client.get("/labels/templates?language_key=zpl",
                             headers=hdrs)).json()
    assert [r["name"] for r in rows] == ["a"]


async def test_patch_bumps_version_once_per_change(client, db, seeded_user):
    hdrs = await _admin(db, client)
    tid = (await client.post("/labels/templates", headers=hdrs,
                             json=_body())).json()["id"]
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "front rack tag"})
    assert resp.status_code == 200 and resp.json()["version"] == 2
    # no-op patch: no bump
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "front rack tag"})
    assert resp.json()["version"] == 2


async def test_patch_unchanged_field_survives_deactivated_vocab(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.post("/labels/templates", headers=hdrs, json=_body())
    tid = resp.json()["id"]
    version = resp.json()["version"]

    await db.execute(text(
        "UPDATE label_vocab SET is_active=false WHERE kind='size' AND key='4x2'"))
    await db.commit()

    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"description": "still fine"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["version"] == version + 1

    await db.execute(text(
        "UPDATE label_vocab SET is_active=false WHERE kind='size' AND key='2x1'"))
    await db.commit()

    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"size_key": "2x1"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_vocab"


async def test_kind_is_immutable(client, db, seeded_user):
    hdrs = await _admin(db, client)
    tid = (await client.post("/labels/templates", headers=hdrs,
                             json=_body())).json()["id"]
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"kind": "code"})
    assert resp.status_code == 422  # extra="forbid"


async def test_delete_deactivates(client, db, seeded_user):
    hdrs = await _admin(db, client)
    tid = (await client.post("/labels/templates", headers=hdrs,
                             json=_body())).json()["id"]
    resp = await client.delete(f"/labels/templates/{tid}", headers=hdrs)
    assert resp.status_code == 204
    got = (await client.get(f"/labels/templates/{tid}", headers=hdrs)).json()
    assert got["is_active"] is False
    rows = (await client.get("/labels/templates?active=true",
                             headers=hdrs)).json()
    assert rows == []


async def test_staff_reads_but_cannot_write(client, db, seeded_user):
    adm = await _admin(db, client)
    await client.post("/labels/templates", headers=adm, json=_body())
    staff = await login(client)
    assert (await client.get("/labels/templates",
                             headers=staff)).status_code == 200
    resp = await client.post("/labels/templates", headers=staff,
                             json=_body("s1"))
    assert resp.status_code == 403
