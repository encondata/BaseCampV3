"""MacroPoint manual update — preview and apply endpoints."""

import json
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Truck, TruckEvent, TruckUpdate
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

    monkeypatch.setattr(mp, "MAX_FILES", 10)          # five files: under the count cap
    monkeypatch.setattr(mp, "MAX_FILE_BYTES", 2 * 1024 * 1024)
    monkeypatch.setattr(mp, "MAX_TOTAL_BYTES", 3000)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "upload_too_large"

    monkeypatch.setattr(mp, "MAX_TEXT_BYTES", 10)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(text="x" * 11))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "text_too_large"


async def test_far_too_many_files_is_too_many_files(client, db, seeded_user, monkeypatch):
    """More than MAX_FILES + 1 files trips Starlette's own max_files during
    parsing; that must still read as too_many_files, not upload_too_large."""
    from serversherpa.trucks.macropoint import apply as mp
    hdrs = await login(client)
    monkeypatch.setattr(mp, "MAX_FILES", 2)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE[:4]))
    assert resp.status_code == 413
    assert resp.json()["detail"] == {"code": "too_many_files", "limit": 2}


async def test_non_ascii_digit_content_length_is_length_required(client, db, seeded_user):
    hdrs = await login(client)
    body = (b'--b\r\nContent-Disposition: form-data; name="text"\r\n\r\nhello\r\n--b--\r\n')
    resp = await client.post(
        PREVIEW, content=body,
        headers={**hdrs, "content-type": "multipart/form-data; boundary=b",
                 "content-length": b"\xb2"})                   # latin-1 "²": isdigit() but not int()
    assert resp.status_code == 411
    assert resp.json()["detail"]["code"] == "length_required"


async def test_declared_length_over_cap_is_refused_before_parsing(
        client, db, seeded_user, monkeypatch):
    from serversherpa.trucks.macropoint import apply as mp
    hdrs = await login(client)
    monkeypatch.setattr(mp, "MAX_TOTAL_BYTES", 1000)
    monkeypatch.setattr(mp, "MAX_TEXT_BYTES", 10)

    async def no_parse(self, *a, **k):                      # body must never be parsed
        raise AssertionError("request.form() was called")

    monkeypatch.setattr("starlette.requests.Request.form", no_parse)
    body = b"x" * (1000 + 10 + 64 * 1024 + 1)
    resp = await client.post(
        PREVIEW, headers=hdrs,
        files=[("files", ("big.eml", body, "message/rfc822"))])
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "upload_too_large"


async def test_missing_content_length_is_refused(client, db, seeded_user):
    hdrs = await login(client)

    async def chunks():
        yield b"--b\r\n"
        yield b'Content-Disposition: form-data; name="text"\r\n\r\nhello\r\n--b--\r\n'

    resp = await client.post(
        PREVIEW, content=chunks(),
        headers={**hdrs, "content-type": "multipart/form-data; boundary=b"})
    assert resp.status_code == 411
    assert resp.json()["detail"]["code"] == "length_required"


async def _apply(client, hdrs, files=(), text=None, assignments=None):
    resp = await client.post(APPLY, headers=hdrs,
                             files=form(files, text=text, assignments=assignments or {}))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_apply_writes_learns_link_and_moves_status(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Unlinked", status="created")
    out = await _apply(client, hdrs, JAMIE, assignments={f"order:{JAMIE_TOKEN}": str(t.id)})
    assert (out["added"], out["duplicates"], out["skipped"], out["errors"],
            out["status_changes"]) == (5, 0, 0, 0, 2)
    assert [r["result"] for r in out["rows"]] == ["added"] * 5
    assert out["rows"][1]["status_change"] == "Created → In Transit"
    assert out["rows"][3]["status_change"] == "In Transit → At Destination"
    assert out["rows"][0]["truck_name"] == "Unlinked"

    await db.refresh(t)
    assert t.status == "at_destination"
    assert t.trip_started_at == datetime(2024, 10, 15, 15, 11, tzinfo=UTC)  # the departed time
    assert t.tracking_type == {"macropoint_order": JAMIE_TOKEN,
                               "tracker_id": "JAMIE & PATRICK -NV TO PALO ALTO",
                               "type": "MacroPoint"}
    [loc] = (await db.scalars(select(TruckUpdate).where(TruckUpdate.truck_id == t.id))).all()
    assert loc.source == "macropoint" and loc.source_ref
    assert loc.approximate_address == "CA-99 Bakersfield CA 93308 United States"
    events = (await db.scalars(select(TruckEvent).where(TruckEvent.truck_id == t.id)
                               .order_by(TruckEvent.recorded_at))).all()
    assert [e.event for e in events] == ["Arrived at Pickup", "Departed at Pickup",
                                         "Arrived at Drop-Off", "Departed at Drop-Off"]
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(t.id)).order_by(AuditLog.at))).all()
    # one transaction = one `at`, so compare as a sorted list, not by order
    statuses = [a.changes["status"]["to"] for a in audits if "status" in (a.changes or {})]
    assert sorted(statuses) == ["at_destination", "in_transit"]
    assert all(a.changes["source"] == {"from": None, "to": "MacroPoint"}
               for a in audits if "status" in (a.changes or {}))
    assert any(a.action == "macropoint_update" for a in audits)

    # The learned token now matches the next upload by itself.
    body = (await client.post(PREVIEW, headers=hdrs, files=form(["loc_jamie.eml"]))).json()
    assert body["groups"][0]["match"]["by"] == "order"


async def test_reapply_is_all_duplicate_and_survives_many_conflicts(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Busy")
    files = [*JAMIE, "loc_heavy_whitespace.eml", "loc_landstar_pt.eml", "loc_landstar_et_slash.eml"]
    groups = (await client.post(PREVIEW, headers=hdrs, files=form(files))).json()["groups"]
    assign = {g["group_key"]: str(t.id) for g in groups}
    first = await _apply(client, hdrs, files, assignments=assign)
    assert first["added"] == 8
    for _ in range(2):                                     # > 5 ON CONFLICT runs per session
        again = await _apply(client, hdrs, files, assignments=assign)
        assert (again["added"], again["duplicates"], again["status_changes"]) == (0, 8, 0)
    assert await db.scalar(select(func.count()).select_from(TruckUpdate)) == 4


async def test_status_is_forward_only(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Done", status="at_destination")
    out = await _apply(client, hdrs, ["trip_departed_pickup.eml"],
                       assignments={f"order:{JAMIE_TOKEN}": str(t.id)})
    assert out["rows"][0]["result"] == "added"
    assert out["rows"][0]["status_change"] is None
    await db.refresh(t)
    assert t.status == "at_destination"


async def test_learn_link_fills_blanks_only(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Linked", tracker_id="My name", macropoint_order="other-token",
                     type="Landstar", update_type="email")
    out = await _apply(client, hdrs, ["loc_jamie.eml"],
                       assignments={f"order:{JAMIE_TOKEN}": str(t.id)})
    assert out["rows"][0]["result"] == "added"
    assert out["rows"][0]["note"] == "linked_to_other_order"
    await db.refresh(t)
    assert t.tracking_type == {"tracker_id": "My name", "macropoint_order": "other-token",
                               "type": "Landstar", "update_type": "email"}


async def test_skip_and_inactive_truck(client, db, seeded_user):
    hdrs = await login(client)
    parked = await _truck(db, "Parked", status="inactive")
    out = await _apply(client, hdrs, ["loc_jamie.eml", "loc_landstar_pt.eml", "locus_traxx.eml"],
                       assignments={f"order:{JAMIE_TOKEN}": str(parked.id),
                                    "order:Dk4ScKJ-t64u-XiTR8UdjQ__": None})
    by_source = {r["source"]: r for r in out["rows"]}
    assert by_source["loc_jamie.eml"]["result"] == "error"
    assert by_source["loc_jamie.eml"]["reason"] == "truck_not_active"
    assert by_source["loc_landstar_pt.eml"]["result"] == "skipped"
    assert by_source["locus_traxx.eml"] == {**by_source["locus_traxx.eml"],
                                            "result": "error", "reason": "not_macropoint"}
    assert (out["added"], out["skipped"], out["errors"]) == (0, 1, 2)
    assert await db.scalar(select(func.count()).select_from(TruckUpdate)) == 0


async def test_cross_format_apply_dedups(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "JP2")
    key = {f"order:{JAMIE_TOKEN}": str(t.id)}
    await _apply(client, hdrs, ["loc_jamie.eml", "trip_arrived_pickup.eml"], assignments=key)
    out = await _apply(client, hdrs, text=(FIX / "pasted_outlook_two.txt").read_text(),
                       assignments={"id:jamie & patrick -nv to palo alto": str(t.id)})
    assert [r["result"] for r in out["rows"]] == ["duplicate", "duplicate"]


async def test_apply_bad_assignments_and_permission(client, db, seeded_user):
    hdrs = await login(client)
    parts = form(["loc_jamie.eml"])
    parts.append(("assignments", (None, "{not json")))
    resp = await client.post(APPLY, headers=hdrs, files=parts)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_assignments"
    parts = form(["loc_jamie.eml"], assignments={"k": "not-a-uuid"})
    assert (await client.post(APPLY, headers=hdrs, files=parts)).status_code == 422
    nope = await _staff_without(db, client, "trucks", "change", "mp-noapply@test.example.com")
    assert (await client.post(APPLY, headers=nope, files=form(["loc_jamie.eml"]))).status_code == 403
