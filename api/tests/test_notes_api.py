"""Global notes: CRUD on asset-hosted notes; permission derives from the
host entity's resource. Clients read their own assets' notes; staff write."""

from sqlalchemy import select

from serversherpa.db.models import Asset, AuditLog, Note
from tests.test_assets_api import _client_contact, login


async def _asset(db, **kw):
    a = Asset(name="host-1", **kw)
    db.add(a)
    await db.commit()
    return a


async def test_note_crud_with_audit(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "asset", "entity_id": str(asset.id),
        "body": "PSU replaced during staging."})
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["author_name"] == "Alice Anderson"

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "note.add"))
    assert row is not None and row.entity_type == "asset"

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs,
                              json={"body": "PSU replaced. Rails bent."})
    assert resp.status_code == 200
    assert resp.json()["body"] == "PSU replaced. Rails bent."

    listing = (await client.get(
        f"/notes?entity_type=asset&entity_id={asset.id}", headers=hdrs)).json()
    assert len(listing) == 1

    resp = await client.delete(f"/notes/{note['id']}", headers=hdrs)
    assert resp.status_code == 204
    listing = (await client.get(
        f"/notes?entity_type=asset&entity_id={asset.id}", headers=hdrs)).json()
    assert listing == []                      # soft-deleted rows hidden
    assert (await db.get(Note, note["id"])).deleted_at is not None


async def test_unknown_entity_type_422(client, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "spaceship",
        "entity_id": "00000000-0000-0000-0000-000000000000", "body": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_entity_type"


async def test_client_reads_own_asset_notes_cannot_write(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme N", "n@acme.example.com")
    staff_hdrs = await login(client)
    mine = await _asset(db, client_id=org.id)
    from serversherpa.db.models import Client
    other_org = Client(name="Other N")
    db.add(other_org)
    await db.flush()
    theirs = await _asset(db, client_id=other_org.id)

    for a in (mine, theirs):
        await client.post("/notes", headers=staff_hdrs, json={
            "entity_type": "asset", "entity_id": str(a.id), "body": "note"})

    resp = await client.get(
        f"/notes?entity_type=asset&entity_id={mine.id}", headers=hdrs)
    assert resp.status_code == 200 and len(resp.json()) == 1

    resp = await client.get(
        f"/notes?entity_type=asset&entity_id={theirs.id}", headers=hdrs)
    assert resp.status_code == 404            # out-of-scope host = 404

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "asset", "entity_id": str(mine.id), "body": "hi"})
    assert resp.status_code == 403            # read-only tier


async def test_asset_attachment_upload_and_scoped_view(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)
    files = {"file": ("manual.pdf", b"%PDF-1.4 fake", "application/pdf")}
    resp = await client.post("/attachments", headers=hdrs, files=files, data={
        "entity_type": "asset", "entity_id": str(asset.id), "kind": "document"})
    assert resp.status_code in (200, 201), resp.text

    listing = await client.get(
        f"/attachments?entity_type=asset&entity_id={asset.id}", headers=hdrs)
    assert listing.status_code == 200
    assert listing.json()[0]["filename"] == "manual.pdf"

    resp = await client.post("/attachments", headers=hdrs, files={
        "file": ("x.png", b"png", "image/png")}, data={
        "entity_type": "asset", "entity_id": str(asset.id), "kind": "avatar"})
    assert resp.status_code == 422            # assets have no avatar slot
