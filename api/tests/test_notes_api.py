"""Global notes: CRUD on asset-hosted notes; permission derives from the
host entity's resource. Clients read their own assets' notes; staff write."""

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AuditLog, Client, Initiative, Note, Partner, Person, PersonRole,
    Truck,
)
from tests.test_assets_api import _client_contact, login, make_login


async def _asset(db, **kw):
    a = Asset(name="host-1", **kw)
    db.add(a)
    await db.commit()
    return a


async def _initiative(db, **kw):
    i = Initiative(name="host-initiative-1", initiative_type="project", **kw)
    db.add(i)
    await db.commit()
    return i


async def _truck(db, **kw):
    t = Truck(name="host-truck-1", **kw)
    db.add(t)
    await db.commit()
    return t


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


async def test_note_crud_on_initiative(client, db, seeded_user):
    """initiative hosts notes exactly like asset/container — entity_type
    'initiative' is registered in NOTE_HOSTS per the design spec."""
    hdrs = await login(client)
    initiative = await _initiative(db)

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(initiative.id),
        "body": "Kickoff scheduled for next week."})
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["entity_type"] == "initiative"
    assert note["body"] == "Kickoff scheduled for next week."

    listing = (await client.get(
        f"/notes?entity_type=initiative&entity_id={initiative.id}",
        headers=hdrs)).json()
    assert len(listing) == 1
    assert listing[0]["id"] == note["id"]


async def test_note_crud_on_truck(client, db, seeded_user):
    """'truck' hosts notes exactly like asset/container/initiative — entity_type
    'truck' is registered in NOTE_HOSTS."""
    hdrs = await login(client)
    truck = await _truck(db)

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "truck", "entity_id": str(truck.id),
        "body": "Departed yard at 6am."})
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["entity_type"] == "truck"
    assert note["body"] == "Departed yard at 6am."

    listing = (await client.get(
        f"/notes?entity_type=truck&entity_id={truck.id}", headers=hdrs)).json()
    assert len(listing) == 1
    assert listing[0]["id"] == note["id"]


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

    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d4944415478da63fcff9fa10e0002fe01fda9e70eb80000000049454e44ae426082")
    resp = await client.post("/attachments", headers=hdrs, files={
        "file": ("x.png", png, "image/png")}, data={
        "entity_type": "asset", "entity_id": str(asset.id), "kind": "avatar"})
    assert resp.status_code == 422            # assets have no avatar slot
    assert resp.json()["detail"]["code"] == "avatar_not_supported"


async def test_client_cannot_write_asset_attachments_but_can_view(client, db, seeded_user):
    org, hdrs = await _client_contact(db, client, "Acme AT", "at@acme.example.com")
    staff_hdrs = await login(client)
    mine = await _asset(db, client_id=org.id)

    files = {"file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")}
    resp = await client.post("/attachments", headers=staff_hdrs, files=files, data={
        "entity_type": "asset", "entity_id": str(mine.id), "kind": "document"})
    assert resp.status_code in (200, 201)
    att_id = resp.json()["id"]

    # client actor: can view own asset's attachments WITHOUT attachments:view...
    listing = await client.get(
        f"/attachments?entity_type=asset&entity_id={mine.id}", headers=hdrs)
    assert listing.status_code == 200
    assert len(listing.json()) == 1

    # ...but cannot write
    resp = await client.post("/attachments", headers=hdrs, files=files, data={
        "entity_type": "asset", "entity_id": str(mine.id), "kind": "document"})
    assert resp.status_code == 403
    resp = await client.delete(f"/attachments/{att_id}", headers=hdrs)
    assert resp.status_code == 403


async def test_note_crud_on_client(client, db, seeded_user):
    """'client' hosts notes exactly like asset/container/initiative — the
    org itself is the anchor row."""
    hdrs = await login(client)
    org = Client(name="Host Org")
    db.add(org)
    await db.commit()

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "client", "entity_id": str(org.id),
        "body": "Kickoff call scheduled."})
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["entity_type"] == "client"

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs,
                               json={"body": "Kickoff call held."})
    assert resp.status_code == 200
    assert resp.json()["body"] == "Kickoff call held."

    listing = (await client.get(
        f"/notes?entity_type=client&entity_id={org.id}", headers=hdrs)).json()
    assert len(listing) == 1
    assert listing[0]["id"] == note["id"]

    resp = await client.delete(f"/notes/{note['id']}", headers=hdrs)
    assert resp.status_code == 204
    listing = (await client.get(
        f"/notes?entity_type=client&entity_id={org.id}", headers=hdrs)).json()
    assert listing == []


async def test_note_crud_on_partner(client, db, seeded_user):
    """'partner' hosts notes the same way; the partner org is the anchor."""
    hdrs = await login(client)
    partner = Partner(name="Host Partner")
    db.add(partner)
    await db.commit()

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "partner", "entity_id": str(partner.id),
        "body": "Insurance cert on file."})
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["entity_type"] == "partner"

    resp = await client.patch(f"/notes/{note['id']}", headers=hdrs,
                               json={"body": "Insurance cert renewed."})
    assert resp.status_code == 200
    assert resp.json()["body"] == "Insurance cert renewed."

    listing = (await client.get(
        f"/notes?entity_type=partner&entity_id={partner.id}", headers=hdrs)).json()
    assert len(listing) == 1
    assert listing[0]["id"] == note["id"]

    resp = await client.delete(f"/notes/{note['id']}", headers=hdrs)
    assert resp.status_code == 204
    listing = (await client.get(
        f"/notes?entity_type=partner&entity_id={partner.id}", headers=hdrs)).json()
    assert listing == []


async def test_note_unknown_org_row_404(client, seeded_user):
    """entity_type is registered but the org row doesn't exist -> 404,
    not the unknown_entity_type 422 (that's for bogus entity_types)."""
    hdrs = await login(client)
    missing = "00000000-0000-0000-0000-000000000000"

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "client", "entity_id": missing, "body": "x"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "entity_not_found"

    resp = await client.post("/notes", headers=hdrs, json={
        "entity_type": "partner", "entity_id": missing, "body": "x"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "entity_not_found"


async def test_role_with_no_clients_grant_gets_403(client, db, seeded_user):
    org = Client(name="No Grant Org")
    db.add(org)
    await db.commit()
    worker = Person(first_name="W", last_name="Orker")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, worker, "worker-notes@test.example.com")

    resp = await client.get(
        f"/notes?entity_type=client&entity_id={org.id}", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_client_owner_cannot_read_own_org_notes(client, db, seeded_user):
    """Notes are internal-only for reads by non-global actors across every
    non-physical host (initiative/person/client/partner) — a client_owner
    anchored to org A gets 403 on org A's OWN notes, not a scoped 200, and
    still 403 on org B. (Security-fixes task 2 finding (b): this role
    previously read notes on its own org; the generic "view = host view +
    scope" rule is overridden for these hosts exactly like initiative
    notes always were.)"""
    staff_hdrs = await login(client)
    org_a = Client(name="Org A")
    org_b = Client(name="Org B")
    db.add_all([org_a, org_b])
    await db.commit()
    owner = Person(first_name="O", last_name="Wner")
    db.add(owner)
    await db.flush()
    db.add(PersonRole(person_id=owner.id, role="client_owner", client_id=org_a.id))
    await db.commit()
    owner_hdrs = await make_login(db, client, owner, "owner-notes@test.example.com")

    for org in (org_a, org_b):
        resp = await client.post("/notes", headers=staff_hdrs, json={
            "entity_type": "client", "entity_id": str(org.id), "body": "note"})
        assert resp.status_code == 201, resp.text

    resp = await client.get(
        f"/notes?entity_type=client&entity_id={org_a.id}", headers=owner_hdrs)
    assert resp.status_code == 403

    resp = await client.get(
        f"/notes?entity_type=client&entity_id={org_b.id}", headers=owner_hdrs)
    assert resp.status_code == 403

    resp = await client.post("/notes", headers=owner_hdrs, json={
        "entity_type": "client", "entity_id": str(org_a.id), "body": "hi"})
    assert resp.status_code == 403

    # global staff still reads org A's notes fine
    resp = await client.get(
        f"/notes?entity_type=client&entity_id={org_a.id}", headers=staff_hdrs)
    assert resp.status_code == 200 and len(resp.json()) == 1


async def test_worker_cannot_read_notes_on_own_person(client, db, seeded_user):
    """Notes are internal-only for non-global reads — a worker reading
    notes on their OWN person record (entity_type='person') is denied,
    same as the initiative/client/partner hosts, even though `worker`
    holds workers:view and the row is in their own scope."""
    staff_hdrs = await login(client)
    worker = Person(first_name="W", last_name="Orker2")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    worker_hdrs = await make_login(db, client, worker, "worker-selfnotes@test.example.com")

    resp = await client.post("/notes", headers=staff_hdrs, json={
        "entity_type": "person", "entity_id": str(worker.id), "body": "punctual"})
    assert resp.status_code == 201, resp.text

    resp = await client.get(
        f"/notes?entity_type=person&entity_id={worker.id}", headers=worker_hdrs)
    assert resp.status_code == 403

    # global staff still reads it fine
    resp = await client.get(
        f"/notes?entity_type=person&entity_id={worker.id}", headers=staff_hdrs)
    assert resp.status_code == 200 and len(resp.json()) == 1


async def test_vendor_admin_cannot_read_own_partner_notes(client, db, seeded_user):
    """Same internal-only rule for the partner host — a vendor_admin
    anchored to their own partner org gets 403 reading its notes."""
    staff_hdrs = await login(client)
    partner = Partner(name="Champagne Logistics")
    db.add(partner)
    await db.commit()
    vendor = Person(first_name="V", last_name="Endor")
    db.add(vendor)
    await db.flush()
    db.add(PersonRole(person_id=vendor.id, role="vendor_admin", partner_id=partner.id))
    await db.commit()
    vendor_hdrs = await make_login(db, client, vendor, "vendor-notes@test.example.com")

    resp = await client.post("/notes", headers=staff_hdrs, json={
        "entity_type": "partner", "entity_id": str(partner.id), "body": "insured"})
    assert resp.status_code == 201, resp.text

    resp = await client.get(
        f"/notes?entity_type=partner&entity_id={partner.id}", headers=vendor_hdrs)
    assert resp.status_code == 403
