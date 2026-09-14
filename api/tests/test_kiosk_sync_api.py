"""Kiosk local-data sync: GET /kiosk/sync/assets?initiative_id=… (the
move's roster, each asset with its label placeholder map) and GET
/kiosk/sync/people (everyone with a worker profile or a user account,
with their RFID tag). Both kiosk:view — the personas that matter are a
worker (allowed) and a client_viewer (403)."""

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import text

from serversherpa.db.models import (
    Asset, AssetModel, Initiative, InitiativeAsset, Person, Site, UserAccount,
    WorkerProfile,
)
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make

UNKNOWN_ID = "00000000-0000-0000-0000-000000000000"


async def _seed_move(db):
    origin = Site(name="Sync Origin Hall")
    dest = Site(name="Sync Destination Hall")
    db.add_all([origin, dest])
    await db.flush()
    move = Initiative(name="Sync Test Move", initiative_type="move", status="planned",
                      origin_site_id=origin.id, destination_site_id=dest.id)
    project = Initiative(name="Sync Test Project", initiative_type="project",
                         status="planned")
    db.add_all([move, project])
    await db.flush()

    model = AssetModel(make="Cisco", model="Nexus 9336C")
    db.add(model)
    await db.flush()
    on_roster = Asset(name="core-sw-01", serial_number="C7X-00412-A",
                      rfid_tag="E2801160A0", model_id=model.id)
    off_roster = Asset(name="not-on-the-move", serial_number="ZZZ-1")
    db.add_all([on_roster, off_roster])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=move.id, asset_id=on_roster.id,
                           source_rack="NAP7 A12", source_ru=Decimal("14"),
                           destination_rack="NAP11 C03", destination_ru=Decimal("22")))
    await db.commit()
    return move, project, on_roster, off_roster


async def _seed_people(db):
    worker = Person(first_name="Wanda", last_name="Worker", rfid_tag="W-RFID-1")
    account_holder = Person(first_name="Anne", last_name="Account",
                            email="sync-account@test.example.com", rfid_tag="A-RFID-2")
    archived = Person(first_name="Gone", last_name="Worker", rfid_tag="G-RFID-3",
                      archived_at=datetime.now(UTC))
    contact = Person(first_name="Plain", last_name="Contact", rfid_tag="P-RFID-4")
    db.add_all([worker, account_holder, archived, contact])
    await db.flush()
    db.add_all([
        WorkerProfile(person_id=worker.id),
        WorkerProfile(person_id=archived.id),
        UserAccount(person_id=account_holder.id, email="sync-account@test.example.com"),
    ])
    await db.commit()
    return worker, account_holder, archived, contact


# ── assets ──────────────────────────────────────────────────────────

async def test_assets_sync_returns_the_roster_with_label_values(client, db, seeded_user):
    hdrs = await login(client)
    move, _project, on_roster, off_roster = await _seed_move(db)

    resp = await client.get(f"/kiosk/sync/assets?initiative_id={move.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(move.id)
    assert body["initiative_name"] == "Sync Test Move"
    assert body["generated_at"]
    assert len(body["assets"]) == 1

    row = body["assets"][0]
    assert row["id"] == str(on_roster.id)
    assert row["asset_id"] == str(on_roster.legacy_id)
    assert row["name"] == "core-sw-01"
    assert row["rfid"] == "E2801160A0"
    assert row["serial_number"] == "C7X-00412-A"
    assert row["make"] == "Cisco"
    assert row["model"] == "Nexus 9336C"
    assert row["make_model"] == "Cisco Nexus 9336C"

    label = row["label"]
    assert label["asset_id"] == str(on_roster.legacy_id)
    assert label["asset_name"] == "core-sw-01"
    assert label["serial_number"] == "C7X-00412-A"
    assert label["make_model"] == "Cisco Nexus 9336C"
    assert label["source_site"] == "Sync Origin Hall"
    assert label["destination_site"] == "Sync Destination Hall"
    assert label["move_name"] == "Sync Test Move"
    assert label["source_raw"] == "NAP7 A12"
    assert label["source_ru"] == "U14"
    assert label["destination_ru"] == "U22"

    assert str(off_roster.id) not in [a["id"] for a in body["assets"]]


async def test_assets_sync_survives_a_deactivated_catalog_key(client, db, seeded_user):
    """asset_id/make_model are computed from the asset/model columns, not
    read out of the catalog-filtered `label` map — an admin deactivating
    those placeholders must not 500 the sync endpoint."""
    hdrs = await login(client)
    move, _project, on_roster, _off = await _seed_move(db)
    await db.execute(text(
        "UPDATE label_placeholders SET is_active = false "
        "WHERE key IN ('asset_id', 'make_model')"))
    await db.commit()

    resp = await client.get(f"/kiosk/sync/assets?initiative_id={move.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    row = resp.json()["assets"][0]
    assert row["asset_id"] == str(on_roster.legacy_id)
    assert row["make_model"] == "Cisco Nexus 9336C"
    assert "asset_id" not in row["label"]
    assert "make_model" not in row["label"]


async def test_assets_sync_with_an_empty_catalog(client, db, seeded_user):
    hdrs = await login(client)
    move, _project, on_roster, _off = await _seed_move(db)
    await db.execute(text("DELETE FROM label_placeholders"))
    await db.commit()

    resp = await client.get(f"/kiosk/sync/assets?initiative_id={move.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    row = resp.json()["assets"][0]
    assert row["asset_id"] == str(on_roster.legacy_id)
    assert row["make_model"] == "Cisco Nexus 9336C"
    assert row["label"] == {}


async def test_assets_sync_rejects_a_non_move_initiative(client, db, seeded_user):
    hdrs = await login(client)
    _move, project, _on, _off = await _seed_move(db)
    resp = await client.get(f"/kiosk/sync/assets?initiative_id={project.id}", headers=hdrs)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_initiative"


async def test_assets_sync_unknown_initiative_is_404(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get(f"/kiosk/sync/assets?initiative_id={UNKNOWN_ID}", headers=hdrs)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "initiative_not_found"


async def test_assets_sync_personas(client, db, seeded_user):
    move, _project, _on, _off = await _seed_move(db)
    w = await _make(db, client, "worker", "w-sync@test.example.com")
    assert (await client.get(f"/kiosk/sync/assets?initiative_id={move.id}",
                             headers=w)).status_code == 200
    cv = await _client_viewer(db, client, "cv-sync@test.example.com")
    assert (await client.get(f"/kiosk/sync/assets?initiative_id={move.id}",
                             headers=cv)).status_code == 403


# ── people ──────────────────────────────────────────────────────────

async def test_people_sync_lists_workers_and_account_holders(client, db, seeded_user):
    hdrs = await login(client)
    worker, account_holder, archived, contact = await _seed_people(db)

    resp = await client.get("/kiosk/sync/people", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["generated_at"]
    by_id = {p["id"]: p for p in body["people"]}

    assert by_id[str(worker.id)]["display_name"] == "Wanda Worker"
    assert by_id[str(worker.id)]["rfid_tag"] == "W-RFID-1"
    assert by_id[str(worker.id)]["is_worker"] is True
    assert by_id[str(worker.id)]["has_account"] is False

    assert by_id[str(account_holder.id)]["rfid_tag"] == "A-RFID-2"
    assert by_id[str(account_holder.id)]["is_worker"] is False
    assert by_id[str(account_holder.id)]["has_account"] is True

    assert str(archived.id) not in by_id     # archived
    assert str(contact.id) not in by_id      # no worker profile, no account


async def test_people_sync_personas(client, db, seeded_user):
    w = await _make(db, client, "worker", "w-sync-people@test.example.com")
    assert (await client.get("/kiosk/sync/people", headers=w)).status_code == 200
    cv = await _client_viewer(db, client, "cv-sync-people@test.example.com")
    assert (await client.get("/kiosk/sync/people", headers=cv)).status_code == 403
