"""Status provenance — scan-vs-edit resolution, entity gating."""

from datetime import UTC, datetime, timedelta

from serversherpa.db.models import (
    Asset, AuditLog, Initiative, InitiativeAsset, Person, PersonRole,
    ProcessedScan, Site, TimeEntry, Truck,
)

from .test_assets_api import _client_contact, login, make_login

T0 = datetime(2026, 8, 27, 9, 0, tzinfo=UTC)


def _scan(asset_id, status, minutes, scan_type="rfid", **kw):
    return ProcessedScan(
        scanned_value=f"EPC-{minutes}", scan_type=scan_type,
        scanned_at=T0 + timedelta(minutes=minutes),
        processed_at=T0 + timedelta(minutes=minutes + 1),
        match_type="asset", asset_id=asset_id, status=status, **kw)


async def _get(client, hdrs, **params):
    return await client.get("/status/provenance", headers=hdrs, params=params)


async def test_edit_provenance_from_audit(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="srv-p1", status="in_transit")
    editor = Person(first_name="Eddie", last_name="Editor")
    db.add_all([asset, editor])
    await db.flush()
    db.add(AuditLog(actor_person_id=editor.id, entity_type="asset",
                    entity_id=str(asset.id), action="update",
                    changes={"status": {"from": "active", "to": "in_transit"}},
                    at=T0))
    await db.commit()

    resp = await _get(client, hdrs, entity_type="asset",
                      entity_id=str(asset.id), status="in_transit")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "edit"
    assert body["actor_name"] == "Eddie Editor"
    assert body["changed_at"] is not None
    assert body["scan_type"] is None


async def test_newer_scan_wins_over_edit(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="srv-p2", status="racked")
    site = Site(name="DC-Prov")
    db.add_all([asset, site])
    await db.flush()
    db.add(AuditLog(actor_person_id=None, entity_type="asset",
                    entity_id=str(asset.id), action="update",
                    changes={"status": {"from": "active", "to": "racked"}},
                    at=T0))
    # newer scan reporting the same status — and an older, different-status
    # scan that must not be picked up
    db.add_all([
        _scan(asset.id, "racked", minutes=30, site_id=site.id,
              device_id="dock-1"),
        _scan(asset.id, "pre_stage", minutes=10, scan_type="barcode"),
    ])
    await db.commit()

    resp = await _get(client, hdrs, entity_type="asset",
                      entity_id=str(asset.id), status="racked")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "scan"
    assert body["scan_type"] == "rfid"
    assert body["scan_type_label"] == "RFID"
    assert body["site_name"] == "DC-Prov"
    assert body["device_id"] == "dock-1"


async def test_initiative_asset_resolves_to_asset_scans(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="srv-p3")
    init = Initiative(name="Prov Move", initiative_type="move",
                      status="in_progress")
    db.add_all([asset, init])
    await db.flush()
    assoc = InitiativeAsset(initiative_id=init.id, asset_id=asset.id,
                            status="on_truck")
    db.add(assoc)
    await db.flush()
    db.add(_scan(asset.id, "on_truck", minutes=5, scan_type="manual"))
    await db.commit()

    resp = await _get(client, hdrs, entity_type="initiative_asset",
                      entity_id=str(assoc.id), status="on_truck")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "scan"
    assert body["scan_type"] == "manual"


async def test_no_history_returns_nulls(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="srv-p4", status="unknown")
    db.add(asset)
    await db.commit()

    resp = await _get(client, hdrs, entity_type="asset",
                      entity_id=str(asset.id), status="unknown")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["changed_at"] is None
    assert body["source"] is None


async def test_gates_and_validation(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="srv-p5")
    db.add(asset)
    await db.flush()
    aid = str(asset.id)

    # unknown entity type → 422
    resp = await _get(client, hdrs, entity_type="nonsense",
                      entity_id=aid, status="active")
    assert resp.status_code == 422

    # worker role holds no assets grant → 403
    w = Person(first_name="Wk", last_name="NoAssets")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    whdrs = await make_login(db, client, w, "wk-noassets@test.example.com")
    resp = await _get(client, whdrs, entity_type="asset",
                      entity_id=aid, status="active")
    assert resp.status_code == 403


async def test_time_entry_provenance_own_vs_others(client, db, seeded_user):
    """A worker (no time:view grant) can still get provenance on their OWN
    time entry; someone else's entry still requires the `time` gate."""
    worker = Person(first_name="Wk", last_name="Prov")
    other = Person(first_name="Other", last_name="Entry")
    db.add_all([worker, other])
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    own_entry = TimeEntry(person_id=worker.id, clock_in_at=T0,
                          clock_out_at=T0 + timedelta(hours=8), status="pending")
    other_entry = TimeEntry(person_id=other.id, clock_in_at=T0,
                            clock_out_at=T0 + timedelta(hours=8), status="pending")
    db.add_all([own_entry, other_entry])
    await db.commit()
    whdrs = await make_login(db, client, worker, "wk-prov@test.example.com")

    resp = await _get(client, whdrs, entity_type="time_entry",
                      entity_id=str(own_entry.id), status="pending")
    assert resp.status_code == 200, resp.text

    resp = await _get(client, whdrs, entity_type="time_entry",
                      entity_id=str(other_entry.id), status="pending")
    assert resp.status_code == 403


async def test_time_entry_provenance_unknown_id_404s(client, db, seeded_user):
    hdrs = await login(client)
    resp = await _get(client, hdrs, entity_type="time_entry",
                      entity_id="00000000-0000-0000-0000-000000000000",
                      status="pending")
    assert resp.status_code == 404


async def test_truck_edit_provenance_from_audit(client, db, seeded_user):
    """Trucks' status chips hover like every other list: entity_type 'truck'
    is gated on trucks:view and resolves the audited status edit."""
    hdrs = await login(client)
    truck = Truck(name="prov-truck-1", status="in_transit")
    editor = Person(first_name="Tina", last_name="Trucker")
    db.add_all([truck, editor])
    await db.flush()
    db.add(AuditLog(actor_person_id=editor.id, entity_type="truck",
                    entity_id=str(truck.id), action="update",
                    changes={"status": {"from": "active", "to": "in_transit"}},
                    at=T0))
    await db.commit()

    resp = await _get(client, hdrs, entity_type="truck",
                      entity_id=str(truck.id), status="in_transit")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "edit"
    assert body["actor_name"] == "Tina Trucker"


async def test_scan_provenance_redacted_for_non_global_actor(client, db, seeded_user):
    """A client-scoped viewer must never learn the internal `site_name`,
    `device_id`, or `actor_name` behind a status change — those identify
    a warehouse location and a staff/operator's name — even when they can
    otherwise see the row via row-scope. Global staff still get them."""
    org, hdrs = await _client_contact(db, client, "Acme Prov", "prov@acme.example.com")
    staff_hdrs = await login(client)
    asset = Asset(name="srv-prov-redact", client_id=org.id, status="racked")
    site = Site(name="DC-Redact")
    operator = Person(first_name="Opie", last_name="Operator")
    db.add_all([asset, site, operator])
    await db.flush()
    db.add(_scan(asset.id, "racked", minutes=30, site_id=site.id,
                device_id="dock-9", operator_id=operator.id))
    await db.commit()

    resp = await _get(client, hdrs, entity_type="asset",
                      entity_id=str(asset.id), status="racked")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "scan"
    assert body["site_name"] is None
    assert body["device_id"] is None
    assert body["actor_name"] is None

    # global staff still sees the internal detail on the same row
    resp = await _get(client, staff_hdrs, entity_type="asset",
                      entity_id=str(asset.id), status="racked")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["site_name"] == "DC-Redact"
    assert body["device_id"] == "dock-9"
    assert body["actor_name"] == "Opie Operator"
