"""Matching rules test set API: the assets and rows a check runs against."""

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog
from serversherpa.matching_rules.models import MatchingTestAsset, MatchingTestRow
from tests.test_matching_versions_api import URL, _audits, dev


async def _assets(client, h):
    r = await client.get(f"{URL}/test-assets", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _by_tag(client, h, tag):
    [a] = [a for a in await _assets(client, h) if a["asset_tag"] == tag]
    return a


def _post_asset(client, h, tag, **extra):
    return client.post(f"{URL}/test-assets", headers=h,
                       json={"asset_tag": tag, "name": f"Test asset {tag}", **extra})


def _code(r):
    return r.json()["detail"]["code"]


async def test_list_in_asset_tag_order_with_rows(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    assets = await _assets(client, h)
    assert [a["asset_tag"] for a in assets] == [7, 101, 102, 103, 104, 106, 107, 108]
    assert sum(len(a["rows"]) for a in assets) == 18
    a7 = assets[0]
    assert {r["test_asset_id"] for r in a7["rows"]} == {a7["id"]}


async def test_create_until_full(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    for tag in (201, 202):
        r = await _post_asset(client, h, tag)
        assert r.status_code == 201, r.text
    r = await _post_asset(client, h, 203)
    assert (r.status_code, _code(r)) == (409, "test_set_full")


async def test_asset_tag_unique(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    a108 = await _by_tag(client, h, 108)
    assert (await client.delete(f"{URL}/test-assets/{a108['id']}", headers=h)).status_code == 204
    r = await _post_asset(client, h, 101)
    assert (r.status_code, _code(r)) == (409, "duplicate_asset_tag")
    a = await _post_asset(client, h, 102)
    assert _code(a) == "duplicate_asset_tag"
    # the failed insert rolled back cleanly: a fresh tag still works
    assert (await _post_asset(client, h, 300)).status_code == 201
    # and a PATCH onto a taken tag is refused the same way
    new = await _by_tag(client, h, 300)
    r = await client.patch(f"{URL}/test-assets/{new['id']}", headers=h,
                           json={"asset_tag": 101, "name": "x"})
    assert (r.status_code, _code(r)) == (409, "duplicate_asset_tag")


async def test_asset_tag_stays_a_safe_browser_number(client, db, seeded_user):
    # the portal reads asset tags as JavaScript numbers: past 2**53 - 1 they
    # stop being exact, so the API refuses them (and 0 or less, as before)
    h = await dev(client, db, seeded_user)
    for tag in (0, 2**53, 2**63):
        r = await _post_asset(client, h, tag)
        assert r.status_code == 422, (tag, r.text)
    r = await _post_asset(client, h, 2**53 - 1)
    assert r.status_code == 201, r.text
    assert r.json()["asset_tag"] == 2**53 - 1


async def test_blank_rfid_and_serial_store_null(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    r = await _post_asset(client, h, 300, rfid="  ", serial="")
    assert r.status_code == 201, r.text
    assert (r.json()["rfid"], r.json()["serial"], r.json()["sits"]) == (None, None, "move")
    row = await db.scalar(select(MatchingTestAsset).where(MatchingTestAsset.asset_tag == 300))
    assert (row.rfid, row.serial) == (None, None)


async def test_delete_cascades_rows(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    a7 = await _by_tag(client, h, 7)
    assert len(a7["rows"]) == 4
    assert (await client.delete(f"{URL}/test-assets/{a7['id']}", headers=h)).status_code == 204
    assert await db.scalar(select(func.count()).select_from(MatchingTestRow)) == 14
    r = await client.delete(f"{URL}/test-assets/{a7['id']}", headers=h)
    assert (r.status_code, _code(r)) == (404, "test_asset_not_found")


async def test_row_value_unique_per_place(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    a7 = (await _by_tag(client, h, 7))["id"]
    r = await client.post(f"{URL}/test-assets/{a7}/rows", headers=h,
                          json={"place": "printing", "value": "102", "expected": "not_found"})
    assert (r.status_code, _code(r)) == (409, "duplicate_value")
    ok = await client.post(f"{URL}/test-assets/{a7}/rows", headers=h,
                           json={"place": "scanning", "value": "101", "expected": "not_found"})
    assert ok.status_code == 201, ok.text
    # editing a row onto another row's value is refused too
    row = ok.json()
    r = await client.patch(f"{URL}/test-rows/{row['id']}", headers=h,
                           json={"place": "scanning", "value": "102", "expected": "rfid"})
    assert (r.status_code, _code(r)) == (409, "duplicate_value")
    r = await client.post(f"{URL}/test-assets/{a7}/rows", headers=h,
                          json={"place": "scanning", "value": "  ", "expected": "rfid"})
    assert r.status_code == 422


async def test_unknown_ids_404(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    nope = "00000000-0000-4000-8000-000000000001"
    r = await client.patch(f"{URL}/test-assets/{nope}", headers=h,
                           json={"asset_tag": 5, "name": "x"})
    assert (r.status_code, _code(r)) == (404, "test_asset_not_found")
    r = await client.post(f"{URL}/test-assets/{nope}/rows", headers=h,
                          json={"place": "printing", "value": "z", "expected": "rfid"})
    assert (r.status_code, _code(r)) == (404, "test_asset_not_found")
    r = await client.patch(f"{URL}/test-rows/{nope}", headers=h,
                           json={"place": "printing", "value": "z", "expected": "rfid"})
    assert (r.status_code, _code(r)) == (404, "test_row_not_found")
    r = await client.delete(f"{URL}/test-rows/{nope}", headers=h)
    assert (r.status_code, _code(r)) == (404, "test_row_not_found")


async def test_edits_are_audited(client, db, seeded_user):
    h = await dev(client, db, seeded_user)
    a = (await _post_asset(client, h, 300)).json()
    r = await client.patch(f"{URL}/test-assets/{a['id']}", headers=h,
                           json={"asset_tag": 301, "name": "Renamed"})
    assert r.status_code == 200, r.text
    row = (await client.post(f"{URL}/test-assets/{a['id']}/rows", headers=h, json={
        "place": "printing", "value": "301", "expected": "asset_tag"})).json()
    r = await client.patch(f"{URL}/test-rows/{row['id']}", headers=h, json={
        "place": "printing", "value": "301x", "expected": "not_found"})
    assert r.status_code == 200, r.text
    assert (await client.delete(f"{URL}/test-rows/{row['id']}", headers=h)).status_code == 204
    assert (await client.delete(f"{URL}/test-assets/{a['id']}", headers=h)).status_code == 204

    for action, changes in (
        ("matching_rules.test_asset.create", {"asset_tag": 300}),
        ("matching_rules.test_asset.update", {"asset_tag": 301}),
        ("matching_rules.test_asset.delete", {"asset_tag": 301}),
        ("matching_rules.test_row.create",
         {"place": "printing", "value": "301", "expected": "asset_tag"}),
        ("matching_rules.test_row.update",
         {"place": "printing", "value": "301x", "expected": "not_found"}),
        ("matching_rules.test_row.delete",
         {"place": "printing", "value": "301x", "expected": "not_found"}),
    ):
        [e] = await _audits(db, action)
        assert e.changes == changes, action
        assert e.entity_type == ("matching_test_asset" if "test_asset" in action
                                 else "matching_test_row")
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action.like("matching_rules.test_%"))) == 6


async def test_test_set_needs_devtools(client, db, seeded_user):
    h = await dev(client, db, seeded_user, role="super_admin")
    assert (await client.get(f"{URL}/test-assets", headers=h)).status_code == 403
    assert (await _post_asset(client, h, 300)).status_code == 403
