"""God-mode pending deletes: mark an entity, list markers, unmark, and
reconcile (hard-delete every marked target). Reconcile never fails wholesale
— each target is deleted inside its own savepoint so one FK violation
doesn't poison the rest of the batch."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Initiative, InitiativePerson, PendingDelete, Person, Site,
)
from tests.test_devtools import login, set_role


async def _developer(db, client_api, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await login(client_api)


async def test_mark_list_unmark_round_trip(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    initiative = Initiative(name="Doomed", initiative_type="project")
    db.add(initiative)
    await db.commit()

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(initiative.id),
        "entity_label": "Doomed"})
    assert resp.status_code == 201, resp.text
    marker = resp.json()
    assert marker["entity_type"] == "initiative"
    assert marker["entity_id"] == str(initiative.id)
    assert marker["entity_label"] == "Doomed"
    assert marker["marked_by_name"] == "Alice Anderson"

    listing = (await client.get("/devtools/pending-deletes", headers=hdrs)).json()
    assert [m["id"] for m in listing] == [marker["id"]]

    resp = await client.delete(f"/devtools/pending-deletes/{marker['id']}",
                               headers=hdrs)
    assert resp.status_code == 204

    listing = (await client.get("/devtools/pending-deletes", headers=hdrs)).json()
    assert listing == []


async def test_list_is_newest_first(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    a = Initiative(name="A", initiative_type="project")
    b = Initiative(name="B", initiative_type="project")
    db.add_all([a, b])
    await db.commit()

    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(a.id), "entity_label": "A"})
    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(b.id), "entity_label": "B"})

    listing = (await client.get("/devtools/pending-deletes", headers=hdrs)).json()
    assert [m["entity_label"] for m in listing] == ["B", "A"]


async def test_duplicate_mark_is_409(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    initiative = Initiative(name="Doomed", initiative_type="project")
    db.add(initiative)
    await db.commit()

    body = {"entity_type": "initiative", "entity_id": str(initiative.id),
            "entity_label": "Doomed"}
    assert (await client.post("/devtools/pending-deletes", headers=hdrs,
                              json=body)).status_code == 201
    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json=body)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "already_pending"


async def test_unknown_entity_type_is_422(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "spaceship", "entity_id": "00000000-0000-0000-0000-000000000000",
        "entity_label": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_entity_type"


async def test_missing_target_is_422(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative",
        "entity_id": "00000000-0000-0000-0000-000000000000", "entity_label": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "entity_not_found"


async def test_unmark_unknown_marker_is_404(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.delete(
        "/devtools/pending-deletes/00000000-0000-0000-0000-000000000000",
        headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "marker_not_found"


async def test_reconcile_deletes_a_marked_initiative(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    initiative = Initiative(name="Doomed", initiative_type="project")
    db.add(initiative)
    await db.commit()
    initiative_id = initiative.id

    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(initiative_id),
        "entity_label": "Doomed"})

    resp = await client.post("/devtools/pending-deletes/reconcile", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 1
    assert body["failed"] == []

    db.expire_all()
    assert await db.get(Initiative, initiative_id) is None
    assert (await db.execute(select(PendingDelete))).first() is None
    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.action == "hard_delete"))
    assert audit_row is not None
    assert audit_row.entity_id == str(initiative_id)


async def test_reconcile_reports_fk_violation_and_retains_marker(
        client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    site = Site(name="Referenced Site")
    db.add(site)
    await db.flush()
    initiative = Initiative(name="Uses Site", initiative_type="project",
                            site_id=site.id)
    db.add(initiative)
    await db.commit()
    site_id = site.id

    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "site", "entity_id": str(site_id), "entity_label": "Referenced Site"})

    resp = await client.post("/devtools/pending-deletes/reconcile", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 0
    assert len(body["failed"]) == 1
    failure = body["failed"][0]
    assert failure["entity_type"] == "site"
    assert failure["entity_id"] == str(site_id)
    assert failure["label"] == "Referenced Site"
    assert failure["reason"] == "fk_violation"
    assert failure["references"] == [{
        "table": "initiatives", "column": "site_id", "nullable": True,
        "purgeable": False, "check_guarded": False, "db_handled": False,
        "count": 1, "labels": ["Uses Site"],
    }]

    db.expire_all()
    assert await db.get(Site, site_id) is not None
    marker = await db.scalar(select(PendingDelete).where(
        PendingDelete.entity_id == site_id))
    assert marker is not None


async def test_reconcile_treats_already_gone_target_as_success(
        client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    initiative = Initiative(name="Doomed", initiative_type="project")
    db.add(initiative)
    await db.commit()
    initiative_id = initiative.id

    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(initiative_id),
        "entity_label": "Doomed"})

    # target deleted out-of-band, marker never cleared
    row = await db.get(Initiative, initiative_id)
    await db.delete(row)
    await db.commit()

    resp = await client.post("/devtools/pending-deletes/reconcile", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 1
    assert body["failed"] == []
    db.expire_all()
    assert (await db.execute(select(PendingDelete))).first() is None


async def test_reconcile_one_poisoned_row_does_not_block_others(
        client, db, seeded_user):
    """A savepoint per row: the fk_violation on the site marker must not
    prevent the initiative marker (queued right after it) from reconciling."""
    hdrs = await _developer(db, client, seeded_user)
    site = Site(name="Referenced Site")
    db.add(site)
    await db.flush()
    blocker = Initiative(name="Uses Site", initiative_type="project", site_id=site.id)
    victim = Initiative(name="Free To Go", initiative_type="project")
    db.add_all([blocker, victim])
    await db.commit()
    site_id, victim_id = site.id, victim.id

    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "site", "entity_id": str(site_id), "entity_label": "Referenced Site"})
    await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(victim_id), "entity_label": "Free To Go"})

    resp = await client.post("/devtools/pending-deletes/reconcile", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 1
    assert len(body["failed"]) == 1
    assert body["failed"][0]["entity_type"] == "site"

    db.expire_all()
    assert await db.get(Initiative, victim_id) is None
    assert await db.get(Site, site_id) is not None


async def test_staff_is_forbidden_on_all_four_endpoints(client, db, seeded_user):
    hdrs = await login(client)  # seeded_user defaults to "staff"
    initiative = Initiative(name="Doomed", initiative_type="project")
    db.add(initiative)
    await db.commit()

    assert (await client.get("/devtools/pending-deletes", headers=hdrs)
           ).status_code == 403
    assert (await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "initiative", "entity_id": str(initiative.id),
        "entity_label": "Doomed"})).status_code == 403
    assert (await client.delete(
        "/devtools/pending-deletes/00000000-0000-0000-0000-000000000000",
        headers=hdrs)).status_code == 403
    assert (await client.post("/devtools/pending-deletes/reconcile", headers=hdrs)
           ).status_code == 403


async def test_single_reconcile_deletes_only_its_marker(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    doomed = Initiative(name="Doomed", initiative_type="project")
    spared = Initiative(name="Spared", initiative_type="event")
    db.add_all([doomed, spared])
    await db.commit()
    doomed_id, spared_id = doomed.id, spared.id

    marker_ids = {}
    for i in (doomed, spared):
        resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
            "entity_type": "initiative", "entity_id": str(i.id),
            "entity_label": i.name})
        marker_ids[i.name] = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_ids['Doomed']}/reconcile",
        headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": 1, "failed": []}

    db.expire_all()
    assert await db.get(Initiative, doomed_id) is None
    # the other marker and its target are untouched
    assert await db.get(Initiative, spared_id) is not None
    remaining = list(await db.scalars(select(PendingDelete)))
    assert [str(m.entity_id) for m in remaining] == [str(spared_id)]


async def test_single_reconcile_reports_fk_violation(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    site = Site(name="Anchored")
    db.add(site)
    await db.commit()
    db.add(Initiative(name="Holder", initiative_type="move", site_id=site.id))
    await db.commit()
    site_id = site.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "site", "entity_id": str(site_id),
        "entity_label": "Anchored"})
    marker_id = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile", headers=hdrs)
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] == 0
    assert body["failed"][0]["reason"] == "fk_violation"

    db.expire_all()
    assert await db.get(Site, site_id) is not None
    assert await db.get(PendingDelete, uuid.UUID(marker_id)) is not None


async def test_single_reconcile_unknown_marker_is_404(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post(
        f"/devtools/pending-deletes/{uuid.uuid4()}/reconcile", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "marker_not_found"


async def test_single_reconcile_failure_lists_referencing_records(
        client, db, seeded_user):
    """The failure payload names WHAT still references the target, not just
    that something does — a site held by an initiative's (nullable) site_id
    reports that initiative's table/column/count/label."""
    hdrs = await _developer(db, client, seeded_user)
    site = Site(name="Referenced Site")
    db.add(site)
    await db.flush()
    initiative = Initiative(name="Vegas to Zurich migration",
                            initiative_type="move", site_id=site.id)
    db.add(initiative)
    await db.commit()
    site_id = site.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "site", "entity_id": str(site_id),
        "entity_label": "Referenced Site"})
    marker_id = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 0
    failure = body["failed"][0]
    assert failure["reason"] == "fk_violation"
    assert failure["references"] == [{
        "table": "initiatives", "column": "site_id", "nullable": True,
        "purgeable": False, "check_guarded": False, "db_handled": False,
        "count": 1, "labels": ["Vegas to Zurich migration"],
    }]


async def test_single_reconcile_force_nulls_nullable_reference_and_deletes(
        client, db, seeded_user):
    """?force=true nulls every nullable reference before deleting, and the
    audit row records exactly what it nulled."""
    hdrs = await _developer(db, client, seeded_user)
    site = Site(name="Referenced Site")
    db.add(site)
    await db.flush()
    initiative = Initiative(name="Uses Site", initiative_type="move", site_id=site.id)
    db.add(initiative)
    await db.commit()
    site_id, initiative_id = site.id, initiative.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "site", "entity_id": str(site_id),
        "entity_label": "Referenced Site"})
    marker_id = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile?force=true", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"deleted": 1, "failed": []}

    db.expire_all()
    assert await db.get(Site, site_id) is None
    assert await db.get(PendingDelete, uuid.UUID(marker_id)) is None
    refreshed = await db.get(Initiative, initiative_id)
    assert refreshed.site_id is None

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "site", AuditLog.entity_id == str(site_id),
        AuditLog.action == "hard_delete"))
    assert audit_row is not None
    assert audit_row.changes == {
        "nulled_references": {"initiatives.site_id": 1}}


async def test_single_reconcile_force_still_fails_on_nonnullable_reference(
        client, db, seeded_user):
    """A non-nullable, non-purgeable reference (user_accounts.person_id —
    real data, not an association row) can't be forced away, so this still
    fails and the person survives. initiative_people no longer qualifies
    here: it's a purgeable association table, so force removes those rows
    (covered by the purge test)."""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import UserAccount
    from serversherpa.security.passwords import hash_password

    hdrs = await _developer(db, client, seeded_user)
    worker = Person(first_name="Bob", last_name="Botched")
    db.add(worker)
    await db.flush()
    db.add(UserAccount(
        person_id=worker.id, email="bob.botched@test.example.com",
        password_hash=hash_password(
            "CorrectHorse9!",
            pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    await db.commit()
    worker_id = worker.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "person", "entity_id": str(worker_id),
        "entity_label": "Bob Botched"})
    marker_id = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile?force=true", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 0
    failure = body["failed"][0]
    assert failure["reason"] == "fk_violation"
    refs = {(r["table"], r["column"]): r for r in failure["references"]}
    account_ref = refs[("user_accounts", "person_id")]
    assert account_ref["nullable"] is False
    assert account_ref["purgeable"] is False
    assert account_ref["count"] == 1

    db.expire_all()
    assert await db.get(Person, worker_id) is not None
    assert await db.get(PendingDelete, uuid.UUID(marker_id)) is not None


async def test_single_reconcile_force_fails_on_check_guarded_match_column(
        client, db, seeded_user):
    """A processed scan's match FK (asset_id/container_id/person_id) is
    nullable but guarded by processed_scans_match_target_chk — the column
    matching match_type must stay non-null. Force mode nulls every nullable
    reference, so nulling the match column trips the CHECK, the savepoint
    rolls back, and the whole force delete fails with fk_violation. The
    processed_scans reference must be flagged check_guarded so a developer
    can see why force didn't clear a "nullable" column (workaround:
    god-delete the matched processed scans first)."""
    from datetime import UTC, datetime

    from serversherpa.db.models import Asset, ProcessedScan

    hdrs = await _developer(db, client, seeded_user)
    asset = Asset(name="srv-1", serial_number="SN-1")
    db.add(asset)
    await db.flush()
    now = datetime.now(UTC)
    scan = ProcessedScan(
        scanned_value="EPC-1", scan_type="rfid", scanned_at=now,
        processed_at=now, match_type="asset", asset_id=asset.id)
    db.add(scan)
    await db.commit()
    asset_id, scan_id = asset.id, scan.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "asset", "entity_id": str(asset_id),
        "entity_label": "srv-1"})
    marker_id = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile?force=true", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == 0
    failure = body["failed"][0]
    assert failure["reason"] == "fk_violation"
    refs = {(r["table"], r["column"]): r for r in failure["references"]}
    scan_ref = refs[("processed_scans", "asset_id")]
    assert scan_ref["nullable"] is True  # nullable, yet force can't null it
    assert scan_ref["purgeable"] is False
    assert scan_ref["check_guarded"] is True
    assert scan_ref["count"] == 1

    # savepoint rollback left everything intact: target, marker, and scan
    db.expire_all()
    assert await db.get(Asset, asset_id) is not None
    assert await db.get(PendingDelete, uuid.UUID(marker_id)) is not None
    refreshed = await db.get(ProcessedScan, scan_id)
    assert refreshed.asset_id == asset_id


async def test_check_guard_does_not_block_forcing_unguarded_columns(
        client, db, seeded_user):
    """operator_id on a processed scan is nullable and NOT part of the match
    CHECK, so force-deleting a person who merely operated the scanner still
    succeeds — the guard only bites on the matched target's column."""
    from datetime import UTC, datetime

    from serversherpa.db.models import Asset, ProcessedScan

    hdrs = await _developer(db, client, seeded_user)
    operator = Person(first_name="Olive", last_name="Operator")
    asset = Asset(name="srv-2", serial_number="SN-2")
    db.add_all([operator, asset])
    await db.flush()
    now = datetime.now(UTC)
    scan = ProcessedScan(
        scanned_value="EPC-2", scan_type="rfid", scanned_at=now,
        processed_at=now, match_type="asset", asset_id=asset.id,
        operator_id=operator.id)
    db.add(scan)
    await db.commit()
    operator_id, scan_id = operator.id, scan.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "person", "entity_id": str(operator_id),
        "entity_label": "Olive Operator"})
    marker_id = resp.json()["id"]

    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile?force=true", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": 1, "failed": []}

    db.expire_all()
    assert await db.get(Person, operator_id) is None
    refreshed = await db.get(ProcessedScan, scan_id)
    assert refreshed.operator_id is None


async def test_force_purges_association_rows_and_labels_by_other_side(
        client, db, seeded_user):
    from serversherpa.db.models import Client, SiteClient

    hdrs = await _developer(db, client, seeded_user)
    org = Client(name="Linked Org")
    east = Site(name="East Hall")
    west = Site(name="West Hall")
    db.add_all([org, east, west])
    await db.flush()
    db.add_all([SiteClient(site_id=east.id, client_id=org.id),
                SiteClient(site_id=west.id, client_id=org.id)])
    await db.commit()
    org_id, east_id, west_id = org.id, east.id, west.id

    resp = await client.post("/devtools/pending-deletes", headers=hdrs, json={
        "entity_type": "client", "entity_id": str(org_id),
        "entity_label": "Linked Org"})
    marker_id = resp.json()["id"]

    # plain reconcile fails, and the reference is purgeable + labeled by
    # the sites on the other side of the join, not by row UUIDs
    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile", headers=hdrs)
    failure = resp.json()["failed"][0]
    ref = next(r for r in failure["references"] if r["table"] == "site_clients")
    assert ref["purgeable"] is True
    assert ref["count"] == 2
    assert set(ref["labels"]) == {"East Hall", "West Hall"}

    # force removes the association rows, then deletes the client
    resp = await client.post(
        f"/devtools/pending-deletes/{marker_id}/reconcile?force=true",
        headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["deleted"] == 1

    db.expire_all()
    assert await db.get(Client, org_id) is None
    assert await db.get(Site, east_id) is not None
    assert await db.get(Site, west_id) is not None
    assert (await db.execute(select(SiteClient).where(
        SiteClient.client_id == org_id))).first() is None
    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "client", AuditLog.action == "hard_delete"))
    assert audit_row is not None
    assert audit_row.changes["removed_association_rows"] == {"site_clients": 2}
