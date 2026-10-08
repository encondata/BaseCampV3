"""Per-note visibility: Everyone / Internal / Admin on the notes API, and the
shared host read rule that lets non-global actors read Everyone notes on
initiative / client records they can see."""

from sqlalchemy import select

from serversherpa.db.models import (
    Asset,
    AuditLog,
    Initiative,
    Note,
    Person,
    PersonRole,
)
from tests.test_assets_api import _client_contact, login, make_login
from tests.test_initiatives_client_scope import (
    _two_clients_with_initiatives,
    client_login,
)


async def _admin(db, client, email="vis-admin@test.example.com"):
    p = Person(first_name="Vis", last_name="Admin")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    return await make_login(db, client, p, email)


async def _initiative(db, name="vis-host"):
    i = Initiative(name=name, initiative_type="project")
    db.add(i)
    await db.commit()
    return i


async def _post(client, hdrs, entity_type, entity_id, body="n", **extra):
    return await client.post("/notes", headers=hdrs, json={
        "entity_type": entity_type, "entity_id": str(entity_id),
        "body": body, **extra})


async def _list(client, hdrs, entity_type, entity_id):
    return await client.get(
        f"/notes?entity_type={entity_type}&entity_id={entity_id}",
        headers=hdrs)


async def test_default_visibility_is_everyone_and_audited(client, db, seeded_user):
    hdrs = await login(client)
    init = await _initiative(db)
    resp = await _post(client, hdrs, "initiative", init.id)
    assert resp.status_code == 201, resp.text
    assert resp.json()["visibility"] == "everyone"
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "note.add"))
    assert row.changes["visibility"] == "everyone"
    assert row.changes["note_id"] == resp.json()["id"]


async def test_staff_cannot_set_admin_level(client, db, seeded_user):
    hdrs = await login(client)
    init = await _initiative(db)
    resp = await _post(client, hdrs, "initiative", init.id, visibility="admin")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "visibility_not_allowed"
    resp = await _post(client, hdrs, "initiative", init.id, visibility="internal")
    assert resp.status_code == 201
    assert resp.json()["visibility"] == "internal"
    resp = await _post(client, hdrs, "initiative", init.id, visibility="bogus")
    assert resp.status_code == 422


async def test_admin_note_hidden_from_staff(client, db, seeded_user):
    staff = await login(client)
    admin = await _admin(db, client)
    init = await _initiative(db)
    resp = await _post(client, admin, "initiative", init.id, "secret",
                       visibility="admin")
    assert resp.status_code == 201, resp.text
    nid = resp.json()["id"]

    assert (await _list(client, staff, "initiative", init.id)).json() == []
    assert len((await _list(client, admin, "initiative", init.id)).json()) == 1

    for method, kw in (("patch", {"json": {"body": "x"}}), ("delete", {})):
        r = await getattr(client, method)(f"/notes/{nid}", headers=staff, **kw)
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "note_not_found"


async def test_patch_visibility_only(client, db, seeded_user):
    hdrs = await login(client)
    init = await _initiative(db)
    note = (await _post(client, hdrs, "initiative", init.id, "keep me")).json()

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs,
                              json={"visibility": "internal"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["body"] == "keep me"
    assert resp.json()["visibility"] == "internal"
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "note.update"))
    assert row.changes["note_id"] == note["id"]
    assert row.changes["visibility"] == {"from": "everyone", "to": "internal"}

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs, json={})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "nothing_to_update"

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs,
                              json={"visibility": "admin"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "visibility_not_allowed"


async def test_client_reads_only_everyone_notes_on_own_initiative(
        client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    staff = await login(client)
    await _post(client, staff, "initiative", ia.id, "public")
    await _post(client, staff, "initiative", ia.id, "private",
                visibility="internal")
    await _post(client, staff, "initiative", ib.id, "other")
    hdrs = await client_login(db, client, a.id)

    resp = await _list(client, hdrs, "initiative", ia.id)
    assert resp.status_code == 200, resp.text
    assert [n["body"] for n in resp.json()] == ["public"]

    resp = await _list(client, hdrs, "initiative", ib.id)
    assert resp.status_code == 404

    resp = await _post(client, hdrs, "initiative", ia.id, "hi")
    assert resp.status_code == 403


async def test_client_reads_everyone_notes_on_own_client_record(
        client, db, seeded_user):
    a, b, *_ = await _two_clients_with_initiatives(db)
    staff = await login(client)
    await _post(client, staff, "client", a.id, "public")
    await _post(client, staff, "client", a.id, "private", visibility="internal")
    hdrs = await client_login(db, client, a.id, role="client_owner")

    resp = await _list(client, hdrs, "client", a.id)
    assert resp.status_code == 200, resp.text
    assert [n["body"] for n in resp.json()] == ["public"]
    assert (await _list(client, hdrs, "client", b.id)).status_code == 404


async def test_client_asset_notes_hide_internal(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Vis Org", "v@vis.example.com")
    staff = await login(client)
    asset = Asset(name="vis-asset", client_id=org.id)
    db.add(asset)
    await db.commit()
    await _post(client, staff, "asset", asset.id, "shown")
    await _post(client, staff, "asset", asset.id, "hidden", visibility="internal")

    resp = await _list(client, hdrs, "asset", asset.id)
    assert resp.status_code == 200
    assert [n["body"] for n in resp.json()] == ["shown"]
    assert len((await _list(client, staff, "asset", asset.id)).json()) == 2
    assert await db.scalar(select(Note.id).where(Note.body == "hidden"))
