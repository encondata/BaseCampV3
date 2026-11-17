"""Client groups: the group rule on every asset surface a client login can
reach (rosters, assets, totals, activity, search, provenance, notes and
files). The fixture's four Acme roster rows are owned "Platform",
"storage ", blank and "Platfrom" (unmatched), so:

- a viewer chipped Platform sees sn-0 and sn-2 (blank);
- an individual chipped Storage sees sn-1 only;
- an unchipped viewer and an owner see all four, exactly as before.
"""
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update

from serversherpa.clientgroups import service as cg
from serversherpa.db.models import (
    Attachment,
    ClientContactGroup,
    ClientGroup,
    ClientGroupAlias,
    Initiative,
    InitiativeAsset,
    Note,
    ProcessedScan,
)
from tests.client_groups_fixtures import client_user, seed_grouped_client

ALL = {"sn-0", "sn-1", "sn-2", "sn-3"}
VISIBLE = {"plat": {"sn-0", "sn-2"}, "ind": {"sn-1"}, "viewer": ALL, "owner": ALL}
ROW_STATUS = ["labeled", "racked", "labeled", "in_transit"]
ASSET_STATUS = ["in_transit", "in_transit", "labeled", "active"]


async def _setup(db, api):
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    now = datetime.now(UTC)
    for i, asset in enumerate(s.assets):
        asset.status = ASSET_STATUS[i]
        db.add(ProcessedScan(
            scanned_value=asset.serial_number, scan_type="rfid",
            status=ASSET_STATUS[i], scanned_at=now - timedelta(minutes=10 + i),
            device_id="dock-1", match_type="asset", asset_id=asset.id,
            initiative_id=s.move.id, processed_at=now))
    await db.flush()
    s.rows = {}
    for row in (await db.scalars(select(InitiativeAsset).where(
            InitiativeAsset.initiative_id == s.move.id))).all():
        idx = next(i for i, a in enumerate(s.assets) if a.id == row.asset_id)
        row.status = ROW_STATUS[idx]
        s.rows[idx] = row
    # sn-0 also sat on an older Acme move under "Storage": its newest row is
    # still the Platform one, so the asset stays Platform, but that older
    # row is Storage's and must not show on /assets/{id}/moves for Platform
    old = Initiative(name="Acme old move", initiative_type="move",
                     sub_type="migration", client_id=s.client.id)
    db.add(old)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=old.id, asset_id=s.assets[0].id,
                           owner="Storage",
                           created_at=now - timedelta(days=30)))
    s.old_move = old
    # notes and files on a visible asset, a hidden asset, the move, the client
    hosts = [("asset", s.assets[0].id), ("asset", s.assets[1].id),
             ("asset", s.assets[2].id), ("asset", s.assets[3].id),
             ("initiative", s.move.id), ("client", s.client.id)]
    s.notes, s.files = {}, {}
    for kind, hid in hosts:
        note = Note(entity_type=kind, entity_id=hid, body=f"note on {hid}",
                    visibility="everyone")
        att = Attachment(entity_type=kind, entity_id=hid, kind="document",
                         storage_key=f"test/{hid}.pdf", filename="rack.pdf",
                         content_type="application/pdf", size_bytes=10,
                         visibility="everyone")
        db.add_all([note, att])
        await db.flush()
        s.notes[hid], s.files[hid] = note, att
    await db.commit()
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    plat, stor = s.groups["Platform"].id, s.groups["Storage"].id
    s.h = {
        "plat": await client_user(db, api, s.client.id, "client_viewer", [plat],
                                  email="cg-plat@test.example.com"),
        "ind": await client_user(db, api, s.client.id, "client_individual", [stor],
                                 email="cg-ind@test.example.com"),
        "viewer": await client_user(db, api, s.client.id, "client_viewer",
                                    email="cg-viewer@test.example.com"),
        "owner": await client_user(db, api, s.client.id, "client_owner",
                                   email="cg-owner@test.example.com"),
    }
    return s


def _serial(s, asset_id):
    return next(a.serial_number for a in s.assets if str(a.id) == str(asset_id))


async def test_roster_filtered_per_tier(client, seeded_user, db):
    s = await _setup(db, client)
    for who, h in s.h.items():
        r = await client.get(f"/initiatives/{s.move.id}/assets", headers=h)
        assert r.status_code == 200, (who, r.text)
        assert {row["asset"]["serial_number"] for row in r.json()} == VISIBLE[who], who
        r = await client.get("/assets", headers=h)
        assert r.status_code == 200, (who, r.text)
        assert {a["serial_number"] for a in r.json()} == VISIBLE[who], who
        for a in s.assets:
            r = await client.get(f"/assets/{a.id}", headers=h)
            want = 200 if a.serial_number in VISIBLE[who] else 404
            assert r.status_code == want, (who, a.serial_number, r.text)
    # sn-0's older Storage row stays off Platform's moves list, on everyone else's
    def moves(h):
        return client.get(f"/assets/{s.assets[0].id}/moves", headers=h)

    r = await moves(s.h["plat"])
    assert r.status_code == 200, r.text
    assert [m["initiative_name"] for m in r.json()] == ["Acme move"]
    for who in ("viewer", "owner"):
        r = await moves(s.h[who])
        assert {m["initiative_name"] for m in r.json()} == {"Acme move", "Acme old move"}, who


async def test_totals_are_true_for_restricted(client, seeded_user, db):
    s = await _setup(db, client)
    for who, h in s.h.items():
        r = await client.get(f"/initiatives/{s.move.id}/asset-totals", headers=h)
        assert r.status_code == 200, (who, r.text)
        body = r.json()
        assert body == {"total": 4, "by_status": {"labeled": 2, "racked": 1,
                                                  "in_transit": 1}}, who
        r = await client.get(f"/clients/{s.client.id}/asset-totals", headers=h)
        assert r.status_code == 200, (who, r.text)
        body = r.json()
        assert body["total"] == 4 and sum(body["by_status"].values()) == 4, who
        assert body["by_status"] == {"in_transit": 2, "labeled": 1, "active": 1}, who
    # scoped like the parent records: another client's totals are 404
    r = await client.get(f"/clients/{s.other_client.id}/asset-totals", headers=s.h["ind"])
    assert r.status_code == 404
    r = await client.get(f"/initiatives/{s.other_move.id}/asset-totals", headers=s.h["ind"])
    assert r.status_code == 404


def _strip(value):
    """Drop presigned urls (they carry a signing timestamp)."""
    if isinstance(value, list):
        return [_strip(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in value.items() if k != "url"}
    return value


async def _capture(client, s, h) -> dict:
    out = {}

    async def get(path):
        r = await client.get(path, headers=h)
        out[path] = (r.status_code, _strip(r.json()))

    await get(f"/initiatives/{s.move.id}/assets")
    await get(f"/initiatives/{s.move.id}/asset-totals")
    await get(f"/clients/{s.client.id}/asset-totals")
    await get("/assets")
    await get(f"/clients/{s.client.id}/activity")
    await get("/search?q=sn-")
    for i, a in enumerate(s.assets):
        await get(f"/assets/{a.id}")
        await get(f"/assets/{a.id}/moves")
        await get(f"/status/provenance?entity_type=asset&entity_id={a.id}"
                  f"&status={ASSET_STATUS[i]}")
        await get(f"/status/provenance?entity_type=initiative_asset"
                  f"&entity_id={s.rows[i].id}&status={ROW_STATUS[i]}")
    for kind, hid in [("asset", a.id) for a in s.assets] + [
            ("initiative", s.move.id), ("client", s.client.id)]:
        await get(f"/notes?entity_type={kind}&entity_id={hid}")
        await get(f"/attachments?entity_type={kind}&entity_id={hid}")
    return out


async def test_unrestricted_responses_unchanged(client, seeded_user, db):
    s = await _setup(db, client)
    before = {who: await _capture(client, s, s.h[who]) for who in ("viewer", "owner")}
    # full sets while groups and chips exist
    for who, snap in before.items():
        code, rows = snap[f"/initiatives/{s.move.id}/assets"]
        assert code == 200 and len(rows) == 4, who
        code, body = snap[f"/clients/{s.client.id}/activity"]
        assert code == 200 and len(body["events"]) == 4, who
        for kind, hid in [("initiative", s.move.id), ("client", s.client.id)]:
            assert len(snap[f"/notes?entity_type={kind}&entity_id={hid}"][1]) == 1, who
            assert len(snap[f"/attachments?entity_type={kind}&entity_id={hid}"][1]) == 1, who
    # empty the feature tables and compare again
    await db.execute(delete(ClientContactGroup))
    await db.execute(update(InitiativeAsset).values(owner_group_id=None))
    await db.execute(delete(ClientGroupAlias))
    await db.execute(delete(ClientGroup))
    await db.commit()
    for who in ("viewer", "owner"):
        after = await _capture(client, s, s.h[who])
        assert after == before[who], who


async def test_hidden_ids_404_everywhere(client, seeded_user, db):
    s = await _setup(db, client)
    h = s.h["ind"]
    hidden = s.assets[0]        # Platform's, not Storage's
    for path in (f"/assets/{hidden.id}", f"/assets/{hidden.id}/moves",
                 f"/notes?entity_type=asset&entity_id={hidden.id}",
                 f"/attachments?entity_type=asset&entity_id={hidden.id}",
                 (f"/status/provenance?entity_type=asset&entity_id={hidden.id}"
                  f"&status={ASSET_STATUS[0]}"),
                 (f"/status/provenance?entity_type=initiative_asset"
                  f"&entity_id={s.rows[0].id}&status={ROW_STATUS[0]}")):
        r = await client.get(path, headers=h)
        assert r.status_code == 404, (path, r.text)
    # the visible one answers
    r = await client.get(f"/status/provenance?entity_type=initiative_asset"
                         f"&entity_id={s.rows[1].id}&status={ROW_STATUS[1]}",
                         headers=h)
    assert r.status_code == 200, r.text
    r = await client.get(f"/status/provenance?entity_type=asset"
                         f"&entity_id={s.assets[1].id}&status={ASSET_STATUS[1]}",
                         headers=h)
    assert r.status_code == 200 and r.json()["source"] == "scan", r.text


async def test_provenance_scan_limited_to_row_move(client, seeded_user, db):
    s = await _setup(db, client)
    # sn-1 (visible to the individual) has a newer "racked" scan on Bravo's
    # move: the row's provenance on Acme's move must not report it
    db.add(ProcessedScan(
        scanned_value="sn-1", scan_type="rfid", status="racked",
        scanned_at=datetime.now(UTC), device_id="dock-9", match_type="asset",
        asset_id=s.assets[1].id, initiative_id=s.other_move.id,
        processed_at=datetime.now(UTC)))
    await db.commit()
    r = await client.get(f"/status/provenance?entity_type=initiative_asset"
                         f"&entity_id={s.rows[1].id}&status=racked", headers=s.h["ind"])
    assert r.status_code == 200, r.text
    assert r.json()["source"] is None


async def test_search_cannot_confirm_hidden_serial(client, seeded_user, db):
    s = await _setup(db, client)
    for who, h in s.h.items():
        r = await client.get("/search?q=sn-", headers=h)
        assert r.status_code == 200, r.text
        hits = {x["label"] for x in r.json()["results"] if x["kind"] == "asset"}
        assert hits == VISIBLE[who], who
        for a in s.assets:
            r = await client.get(f"/search?q={a.serial_number}", headers=h)
            hits = [x for x in r.json()["results"] if x["kind"] == "asset"]
            assert bool(hits) == (a.serial_number in VISIBLE[who]), (who, a.serial_number)


async def test_activity_lists_only_visible_scans(client, seeded_user, db):
    s = await _setup(db, client)
    for who, h in s.h.items():
        r = await client.get(f"/clients/{s.client.id}/activity", headers=h)
        assert r.status_code == 200, (who, r.text)
        body = r.json()
        assert {e["serial_number"] for e in body["events"]} == VISIBLE[who], who
        assert {_serial(s, e["asset_id"]) for e in body["events"]} == VISIBLE[who], who
        assert body["activity_7d"] == len(VISIBLE[who]), who


async def test_restricted_sees_no_move_or_client_notes_files(client, seeded_user, db):
    """Spec answer 3, as ruled: on a host at a client where the login is
    restricted, lists come back empty (200) and one item by id reads as
    missing (404). Owners and unchipped viewers are unchanged."""
    s = await _setup(db, client)
    hosts = [("initiative", s.move.id), ("client", s.client.id),
             ("asset", s.assets[2].id)]           # sn-2 is visible to Platform
    for who in ("plat", "ind", "viewer", "owner"):
        h = s.h[who]
        for kind, hid in hosts:
            if kind == "asset" and who == "ind":
                continue                         # hidden asset: 404, above
            for path in (f"/notes?entity_type={kind}&entity_id={hid}",
                         f"/attachments?entity_type={kind}&entity_id={hid}"):
                r = await client.get(path, headers=h)
                assert r.status_code == 200, (who, path, r.text)
                want = 0 if who in ("plat", "ind") else 1
                assert len(r.json()) == want, (who, path, r.json())
    # one item by id: 404 for restricted logins, never a 403 that confirms it
    for who in ("plat", "ind"):
        h = s.h[who]
        for _kind, hid in hosts[:2]:
            r = await client.patch(f"/notes/{s.notes[hid].id}", headers=h,
                                   json={"body": "x"})
            assert r.status_code == 404, (who, r.text)
            assert r.json()["detail"]["code"] == "note_not_found"
            r = await client.delete(f"/notes/{s.notes[hid].id}", headers=h)
            assert r.status_code == 404, (who, r.text)
            r = await client.patch(f"/attachments/{s.files[hid].id}", headers=h,
                                   json={"visibility": "everyone"})
            assert r.status_code == 404, (who, r.text)
            assert r.json()["detail"]["code"] == "attachment_not_found"
            r = await client.delete(f"/attachments/{s.files[hid].id}", headers=h)
            assert r.status_code == 404, (who, r.text)
    # the restriction is per client: Bravo's records are untouched by it
    # (Bravo is out of scope for these logins, so 404 as before)
    r = await client.get(f"/notes?entity_type=client&entity_id={s.other_client.id}",
                         headers=s.h["plat"])
    assert r.status_code == 404
