"""MacroPoint manual update — preview and apply endpoints."""

import json
from pathlib import Path

from sqlalchemy import func, select

from serversherpa.db.models import Truck, TruckEvent, TruckUpdate
from tests.test_sites_api import login
from tests.test_trucks_api import _staff_without

FIX = Path(__file__).parent / "fixtures" / "macropoint"
PREVIEW = "/trucks/manual-update/macropoint/preview"
APPLY = "/trucks/manual-update/macropoint/apply"
JAMIE_TOKEN = "VM0s7D8QTl5j92QfqQgTmQ__"
JAMIE = ["trip_arrived_pickup.eml", "trip_departed_pickup.eml", "loc_jamie.eml",
         "trip_arrived_dropoff.eml", "trip_departed_dropoff.eml"]


def form(files=(), text=None, assignments=None):
    parts = [("files", (name, (FIX / name).read_bytes(), "message/rfc822")) for name in files]
    if text is not None:
        parts.append(("text", (None, text)))
    if assignments is not None:
        parts.append(("assignments", (None, json.dumps(assignments))))
    return parts


async def _truck(db, name, status="active", **tracking):
    t = Truck(name=name, status=status, tracking_type=tracking)
    db.add(t)
    await db.commit()
    return t


async def test_preview_groups_matches_and_writes_nothing(client, db, seeded_user):
    hdrs = await login(client)
    jp = await _truck(db, "JP Truck", tracker_id="jamie & patrick -nv to palo alto")
    resp = await client.post(PREVIEW, headers=hdrs,
                             files=form([*JAMIE, "loc_landstar_pt.eml", "locus_traxx.eml"]))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    [g1, g2] = body["groups"]
    assert g1["group_key"] == f"order:{JAMIE_TOKEN}"
    assert g1["id_number"] == "JAMIE & PATRICK -NV TO PALO ALTO"
    assert g1["carrier"] == "Landstar - ATL"
    assert g1["match"] == {"truck_id": str(jp.id), "by": "tracker_id", "ambiguous_ids": []}
    assert [r["kind"] for r in g1["rows"]] == [
        "trip_event", "trip_event", "location", "trip_event", "trip_event"]
    assert [r["status_to"] for r in g1["rows"]] == [
        None, "in_transit", None, "at_destination", None]
    assert g1["rows"][1]["status_to_label"] == "In Transit"
    assert g1["rows"][2]["location"] == "35.481693, -119.140353"
    assert (g1["new"], g1["duplicates"]) == (5, 0)
    assert g2["id_number"] == "QR01294949 - CA-NV"
    assert g2["match"]["truck_id"] is None
    assert body["errors"] == [{"source": "locus_traxx.eml", "reason": "not_macropoint"}]
    assert [t["name"] for t in body["trucks"]] == ["JP Truck"]
    assert body["trucks"][0]["status_label"] == "Active"
    assert await db.scalar(select(func.count()).select_from(TruckUpdate)) == 0
    assert await db.scalar(select(func.count()).select_from(TruckEvent)) == 0


async def test_preview_excludes_inactive_historical_archived(client, db, seeded_user):
    from datetime import UTC, datetime
    hdrs = await login(client)
    await _truck(db, "Parked", status="inactive", tracker_id="QR01294949 - CA-NV")
    await _truck(db, "Old", status="historical", tracker_id="QR01294949 - CA-NV")
    gone = await _truck(db, "Gone", tracker_id="QR01294949 - CA-NV")
    gone.archived_at = datetime.now(UTC)
    await db.commit()
    live = await _truck(db, "Live", status="created")
    body = (await client.post(PREVIEW, headers=hdrs, files=form(["loc_landstar_pt.eml"]))).json()
    assert body["groups"][0]["match"]["truck_id"] is None
    assert [t["id"] for t in body["trucks"]] == [str(live.id)]


async def test_cross_format_and_in_batch_duplicates(client, db, seeded_user):
    hdrs = await login(client)
    await _truck(db, "JP", tracker_id="JAMIE & PATRICK -NV TO PALO ALTO")
    pasted = (FIX / "pasted_outlook_two.txt").read_text()
    body = (await client.post(PREVIEW, headers=hdrs, files=form(
        ["loc_jamie.eml", "trip_arrived_pickup.eml"], text=pasted))).json()
    [g] = body["groups"]                                   # pasted rows joined the token group
    assert g["group_key"] == f"order:{JAMIE_TOKEN}"
    assert (g["new"], g["duplicates"]) == (2, 2)
    # Same-minute rows sort by (time, kind, source); "Pasted text #n" sorts
    # before the lowercase file names, so the .eml copies are the repeats.
    assert sorted(r["source"] for r in g["rows"] if r["duplicate"]) == [
        "loc_jamie.eml", "trip_arrived_pickup.eml"]


async def test_preview_requires_trucks_change(client, db, seeded_user):
    await login(client)
    hdrs = await _staff_without(db, client, "trucks", "change", "mp-noperm@test.example.com")
    resp = await client.post(PREVIEW, headers=hdrs, files=form(["loc_jamie.eml"]))
    assert resp.status_code == 403


async def test_input_limits(client, db, seeded_user, monkeypatch):
    from serversherpa.trucks.macropoint import apply as mp
    hdrs = await login(client)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(text="   "))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "nothing_to_parse"

    monkeypatch.setattr(mp, "MAX_FILES", 2)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE[:3]))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "too_many_files"

    monkeypatch.setattr(mp, "MAX_FILE_BYTES", 100)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE[:1]))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "file_too_large"

    monkeypatch.setattr(mp, "MAX_FILE_BYTES", 2 * 1024 * 1024)
    monkeypatch.setattr(mp, "MAX_TOTAL_BYTES", 3000)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "upload_too_large"

    monkeypatch.setattr(mp, "MAX_TEXT_BYTES", 10)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(text="x" * 11))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "text_too_large"
