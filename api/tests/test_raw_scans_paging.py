"""Raw scans, server side: keyset paging over every sort, filters, search,
facets, the CSV export, validation and the scans:view gate."""

import csv
import io
import json
import os
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from serversherpa.db.models import Person, PersonRole, RawScan, Site
from serversherpa.db.ordering import natural_key
from serversherpa.scans.raw_query import encode_cursor

from .test_assets_api import login, make_login

T0 = datetime(2026, 8, 27, 9, 0, tzinfo=UTC)

SORTS = ["primary", "scan_type", "scanned", "device", "operator", "site",
         "location", "source", "ingested", "status"]
TEXT_SORTS = [s for s in SORTS if s not in ("scanned", "ingested")]

SCAN_TYPES = ["rfid", "barcode", "manual"]
STATUSES = ["active", "in_transit", "in_storage", None]
DEVICES = ["dev-1", "dev-2", "dev-10", ""]
LOCATIONS = ["Dock 1", "Dock 12", "Dock 2", ""]
SOURCES = ["kiosk", "reader", "", "import"]
N = 300


def _scanned_value(i: int) -> str:
    """Mostly VAL-nnn; a few "=SUM(n)" cells for CSV injection, and rows that
    differ only in case (VAL-a / VAL-A are equal under the `natural` collation,
    so the cursor's collated-equality branch and the id tie-break get used)."""
    if i % 50 == 0:
        return f"=SUM({i})"
    if i % 50 == 7:
        return "VAL-a" if i % 100 == 7 else "VAL-A"
    return f"VAL-{i % 97:03d}"


@pytest.fixture
async def world(db, seeded_user):
    """300 scans with plenty of equal sort values (and, for ingested, one
    shared created_at), plus the display text each one should show."""
    people = [Person(first_name="Ann", last_name="Alpha"),
              Person(first_name="Bob", last_name="Beta"),
              Person(first_name="Cy", last_name="Gamma")]
    sites = [Site(name="Site 2"), Site(name="Site 10"), Site(name="Site 1")]
    db.add_all(people + sites)
    await db.flush()
    labels = dict((await db.execute(text(
        "SELECT key, label FROM status_values "
        "WHERE record_type IN ('scan','asset')"))).all())
    created = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
    rows = []
    for i in range(N):
        op_ = people[i % 4] if i % 4 < 3 else None
        site = sites[i % 5] if i % 5 < 3 else None
        rows.append(RawScan(
            scanned_value=_scanned_value(i),
            scan_type=SCAN_TYPES[i % 3], status=STATUSES[(i // 5) % 4],
            scanned_at=T0 + timedelta(minutes=i % 60),
            device_id=DEVICES[(i // 2) % 4], operator_id=op_.id if op_ else None,
            site_id=site.id if site else None,
            location_detail=LOCATIONS[i % 4 if i % 3 else (i + 1) % 4],
            source=SOURCES[(i // 3) % 4], created_at=created))
    db.add_all(rows)
    await db.commit()

    out = []
    for r, i in zip(rows, range(N), strict=True):
        op_ = next((p for p in people if p.id == r.operator_id), None)
        site = next((s for s in sites if s.id == r.site_id), None)
        out.append({
            "id": r.id, "primary": r.scanned_value,
            "scan_type": labels[r.scan_type],
            "status": labels[r.status] if r.status else "",
            "scanned": r.scanned_at, "ingested": created,
            "device": r.device_id,
            "operator": f"{op_.first_name} {op_.last_name}" if op_ else "",
            "site": site.name if site else "",
            "location": r.location_detail, "source": r.source})
    return out


def shown(row: dict, key: str) -> str:
    """What the cell shows: the text, or "—" when it is empty."""
    value = row[key]
    return value if value or key == "primary" else "—"


def expected_order(rows: list[dict], sort: str, direction: str) -> list[int]:
    def key(r):
        v = r[sort]
        return (v if isinstance(v, datetime) else natural_key(v), r["id"])
    return [r["id"] for r in sorted(rows, key=key, reverse=direction == "desc")]


async def get_page(client, hdrs, **params):
    resp = await client.get("/scans/raw/page", headers=hdrs, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def walk(client, hdrs, limit=37, **params):
    """Every page, in order; returns (ids, totals seen)."""
    ids, totals, cursor = [], set(), None
    while True:
        extra = {"cursor": cursor} if cursor else {}
        body = await get_page(client, hdrs, limit=limit, **params, **extra)
        ids += [r["id"] for r in body["rows"]]
        totals.add(body["total"])
        cursor = body["next_cursor"]
        if cursor is None:
            return ids, totals


# ── paging ──────────────────────────────────────────────────────────────

async def test_default_page_is_the_newest_100(client, world):
    hdrs = await login(client)
    body = await get_page(client, hdrs)
    assert len(body["rows"]) == 100
    assert body["total"] == N
    assert body["next_cursor"]
    assert [r["id"] for r in body["rows"]] == expected_order(
        world, "scanned", "desc")[:100]
    first = body["rows"][0]
    assert first["scan_type_label"] and first["scan_type_color"]
    assert set(first) >= {"id", "scanned_value", "status_label", "operator_name",
                          "site_name", "created_at", "location_detail"}


@pytest.mark.parametrize("direction", ["asc", "desc"])
@pytest.mark.parametrize("sort", SORTS)
async def test_every_sort_pages_without_gaps_or_duplicates(
        client, world, sort, direction):
    hdrs = await login(client)
    ids, totals = await walk(client, hdrs, sort=sort, dir=direction)
    assert totals == {N}
    assert len(ids) == len(set(ids)) == N
    assert ids == expected_order(world, sort, direction)


@pytest.mark.parametrize("direction", ["asc", "desc"])
async def test_case_variants_tie_and_split_across_pages_by_id(client, world, direction):
    """VAL-a and VAL-A are equal under the `natural` collation: pages of 1 and
    2 cut right through the tie, and the id must decide, with nothing lost."""
    hdrs = await login(client)
    flt = f(primary={"text": "val-a"})
    ties = [r for r in world if r["primary"] in ("VAL-a", "VAL-A")]
    assert {r["primary"] for r in ties} == {"VAL-a", "VAL-A"} and len(ties) > 4
    want = [r["id"] for r in sorted(ties, key=lambda r: r["id"],
                                    reverse=direction == "desc")]
    for limit in (1, 2):
        ids, totals = await walk(client, hdrs, limit=limit, sort="primary",
                                 dir=direction, filters=flt)
        assert ids == want and totals == {len(want)}


async def test_last_page_has_no_cursor_and_exact_fit_does_too(client, world):
    hdrs = await login(client)
    body = await get_page(client, hdrs, limit=N)
    assert len(body["rows"]) == N and body["next_cursor"] is None
    body = await get_page(client, hdrs, limit=N - 1)
    assert body["next_cursor"]
    body = await get_page(client, hdrs, limit=1, cursor=body["next_cursor"],
                          q="no-such-scan-anywhere")
    assert body["rows"] == [] and body["total"] == 0


@pytest.mark.parametrize("sort", ["scanned", "operator", "primary"])
async def test_rows_arriving_between_pages_do_not_disturb_paging(
        client, db, world, sort):
    hdrs = await login(client)
    first = await get_page(client, hdrs, limit=50, sort=sort)
    seen = [r["id"] for r in first["rows"]]
    # scans arrive while the user scrolls: newest of all, oldest of all, and
    # ones that sort in the middle of the part already read
    db.add_all([
        RawScan(scanned_value="VAL-000", scan_type="rfid",
                scanned_at=T0 + timedelta(days=1), device_id="new"),
        RawScan(scanned_value="AAA", scan_type="rfid",
                scanned_at=T0 - timedelta(days=1), device_id="old"),
        RawScan(scanned_value="VAL-050", scan_type="rfid",
                scanned_at=T0 + timedelta(minutes=30)),
    ])
    await db.commit()
    cursor = first["next_cursor"]
    while cursor:
        body = await get_page(client, hdrs, limit=50, sort=sort, cursor=cursor)
        seen += [r["id"] for r in body["rows"]]
        cursor = body["next_cursor"]
    assert len(seen) == len(set(seen))              # nothing twice
    assert {r["id"] for r in world} <= set(seen)    # nothing skipped


async def test_scanned_walk_keeps_every_original_row_when_older_scans_arrive(
        client, db, world):
    hdrs = await login(client)
    first = await get_page(client, hdrs, limit=100)
    db.add(RawScan(scanned_value="LATE", scan_type="rfid",
                   scanned_at=T0 + timedelta(minutes=10)))   # lands mid-list
    await db.commit()
    seen = [r["id"] for r in first["rows"]]
    cursor = first["next_cursor"]
    while cursor:
        body = await get_page(client, hdrs, limit=100, cursor=cursor)
        seen += [r["id"] for r in body["rows"]]
        cursor = body["next_cursor"]
    assert len(seen) == len(set(seen))
    original = {r["id"] for r in world}
    assert original <= set(seen)             # no original row skipped


# ── filters and search ──────────────────────────────────────────────────

def f(**cols):
    return json.dumps(cols)


async def matching(client, hdrs, world, **params):
    body = await get_page(client, hdrs, limit=500, **params)
    assert body["total"] == len(body["rows"])
    return {r["id"] for r in body["rows"]}


async def test_values_filter_matches_displayed_text(client, world):
    hdrs = await login(client)
    got = await matching(client, hdrs, world,
                         filters=f(operator={"values": ["Ann Alpha", "Bob Beta"]}))
    assert got == {r["id"] for r in world
                   if r["operator"] in ("Ann Alpha", "Bob Beta")}
    got = await matching(client, hdrs, world,
                         filters=f(status={"values": ["Active"]}))
    assert got == {r["id"] for r in world if r["status"] == "Active"}
    got = await matching(client, hdrs, world,
                         filters=f(scan_type={"values": ["Barcode"]}))
    assert got == {r["id"] for r in world if r["scan_type"] == "Barcode"}


@pytest.mark.parametrize("col", ["status", "device", "operator", "site",
                                 "location", "source"])
async def test_dash_value_matches_empty_cells(client, world, col):
    hdrs = await login(client)
    got = await matching(client, hdrs, world, filters=f(**{col: {"values": ["—"]}}))
    want = {r["id"] for r in world if not r[col]}
    assert want and got == want
    both = await matching(client, hdrs, world,
                          filters=f(**{col: {"values": ["—", "zzz-none"]}}))
    assert both == want


@pytest.mark.parametrize("col", ["scan_type", "status", "device", "operator",
                                 "site", "location", "source", "primary"])
async def test_exclude_drops_the_listed_displayed_values(client, world, col):
    hdrs = await login(client)
    values = sorted({shown(r, col) for r in world})
    drop = values[:2]
    got = await matching(client, hdrs, world,
                         filters=f(**{col: {"exclude": drop}}))
    want = {r["id"] for r in world if shown(r, col) not in drop}
    assert want and got == want and len(want) < len(world)


@pytest.mark.parametrize("col", ["status", "device", "operator", "site",
                                 "location", "source"])
async def test_exclude_dash_means_non_empty(client, world, col):
    hdrs = await login(client)
    got = await matching(client, hdrs, world, filters=f(**{col: {"exclude": ["—"]}}))
    want = {r["id"] for r in world if r[col]}
    assert want and got == want
    both = await matching(client, hdrs, world, filters=f(
        **{col: {"exclude": ["—", "zzz-none"]}}))
    assert both == want


async def test_exclude_combines_with_other_columns_text_values_and_search(client, world):
    hdrs = await login(client)
    got = await matching(client, hdrs, world, filters=f(
        operator={"exclude": ["Ann Alpha", "—"]},
        source={"values": ["kiosk", "reader"]},
        device={"text": "dev-1", "exclude": ["dev-10"]}),
        q="dock")
    assert got == {r["id"] for r in world
                   if r["operator"] not in ("Ann Alpha", "")
                   and r["source"] in ("kiosk", "reader")
                   and "dev-1" in r["device"] and r["device"] != "dev-10"
                   and "dock" in " ".join(
                       r[k] for k in ["primary", "scan_type", "status", "device",
                                      "operator", "site", "location",
                                      "source"]).lower()}
    # values and exclude on one column both hold (the portal never sends both)
    got = await matching(client, hdrs, world, filters=f(
        site={"values": ["Site 1", "Site 2"], "exclude": ["Site 2"]}))
    assert got == {r["id"] for r in world if r["site"] == "Site 1"}


async def test_exclude_applies_to_paging_total_and_export(client, world):
    hdrs = await login(client)
    flt = f(operator={"exclude": ["Ann Alpha"]})
    want = [i for i in expected_order(world, "primary", "asc")
            if next(r for r in world if r["id"] == i)["operator"] != "Ann Alpha"]
    ids, totals = await walk(client, hdrs, limit=11, sort="primary", dir="asc",
                             filters=flt)
    assert ids == want and totals == {len(want)}
    _, rows = await get_export(client, hdrs, filters=flt)
    assert len(rows) - 1 == len(want)
    assert "Ann Alpha" not in {r[5] for r in rows[1:]}


async def test_text_filter_is_a_case_insensitive_substring(client, world):
    hdrs = await login(client)
    got = await matching(client, hdrs, world, filters=f(site={"text": "site 1"}))
    assert got == {r["id"] for r in world if "site 1" in r["site"].lower()}
    assert {"Site 1", "Site 10"} == {
        r["site"] for r in world if r["id"] in got}
    got = await matching(client, hdrs, world, filters=f(primary={"text": "val-01"}))
    assert got == {r["id"] for r in world if "val-01" in r["primary"].lower()}
    # the dash matches empty cells as text too, like the displayed "—"
    got = await matching(client, hdrs, world, filters=f(device={"text": "—"}))
    assert got == {r["id"] for r in world if not r["device"]}


async def test_wildcards_in_text_are_literal(client, world):
    hdrs = await login(client)
    assert await matching(client, hdrs, world, filters=f(primary={"text": "%"})) == set()
    assert await matching(client, hdrs, world, q="_") == set()
    got = await matching(client, hdrs, world, filters=f(primary={"text": "=SUM("}))
    assert got == {r["id"] for r in world if r["primary"].startswith("=SUM(")}


async def test_filters_combine_with_and_across_columns_and_within_one(client, world):
    hdrs = await login(client)
    got = await matching(client, hdrs, world, filters=f(
        operator={"values": ["Ann Alpha"]}, source={"values": ["kiosk", "—"]},
        device={"text": "dev-1"}))
    assert got == {r["id"] for r in world
                   if r["operator"] == "Ann Alpha"
                   and (r["source"] in ("kiosk", ""))
                   and "dev-1" in r["device"]}
    # a text AND a value selection must both hold
    got = await matching(client, hdrs, world, filters=f(
        location={"text": "dock 1", "values": ["Dock 1", "Dock 2"]}))
    assert got == {r["id"] for r in world if r["location"] == "Dock 1"}


async def test_since_and_until_bound_scanned(client, world):
    hdrs = await login(client)
    since = (T0 + timedelta(minutes=20)).isoformat()
    until = (T0 + timedelta(minutes=30)).isoformat()
    got = await matching(client, hdrs, world, since=since, until=until)
    assert got == {r["id"] for r in world
                   if T0 + timedelta(minutes=20) <= r["scanned"]
                   <= T0 + timedelta(minutes=30)}
    assert got
    got = await matching(client, hdrs, world, since=since)
    assert got == {r["id"] for r in world
                   if r["scanned"] >= T0 + timedelta(minutes=20)}


async def test_search_covers_the_search_box_fields(client, world):
    hdrs = await login(client)
    for term, field_keys in [
        ("val-05", ["primary"]), ("barcode", ["scan_type"]),
        ("in transit", ["status"]), ("dev-10", ["device"]),
        ("beta", ["operator"]), ("site 10", ["site"]),
        ("dock 12", ["location"]), ("reader", ["source"]),
    ]:
        got = await matching(client, hdrs, world, q=term)
        want = {r["id"] for r in world
                if any(term in r[k].lower() for k in
                       ["primary", "scan_type", "status", "device",
                        "operator", "site", "location", "source"])}
        assert got == want, term
        assert want, term
        assert field_keys
    # search and column filters narrow together; search is case-insensitive
    got = await matching(client, hdrs, world, q="BETA",
                         filters=f(source={"values": ["kiosk"]}))
    assert got == {r["id"] for r in world
                   if r["operator"] == "Bob Beta" and r["source"] == "kiosk"}


async def test_filters_apply_to_paging_and_total(client, world):
    hdrs = await login(client)
    want = [i for i in expected_order(world, "primary", "asc")
            if next(r for r in world if r["id"] == i)["operator"] == "Cy Gamma"]
    ids, totals = await walk(
        client, hdrs, limit=11, sort="primary", dir="asc",
        filters=f(operator={"values": ["Cy Gamma"]}))
    assert ids == want and totals == {len(want)}


async def test_stale_date_column_filters_are_ignored(client, world):
    hdrs = await login(client)
    body = await get_page(client, hdrs, limit=500, filters=f(
        scanned={"values": ["8/27/2026, 9:00:00 AM"]},
        ingested={"text": "2026"}))
    assert body["total"] == N


# ── facets ──────────────────────────────────────────────────────────────

async def get_facets(client, hdrs, **params):
    resp = await client.get("/scans/raw/facets", headers=hdrs, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.parametrize("col", ["primary", "scan_type", "status", "device",
                                 "operator", "site", "location", "source"])
async def test_facets_list_distinct_displayed_values_with_counts(client, world, col):
    hdrs = await login(client)
    got = await get_facets(client, hdrs, column=col)
    counts: dict[str, int] = {}
    for r in world:
        counts[shown(r, col)] = counts.get(shown(r, col), 0) + 1
    assert {g["value"]: g["count"] for g in got} == counts
    assert [g["count"] for g in got] == sorted(counts.values(), reverse=True)
    assert sum(g["count"] for g in got) == N


async def test_facets_leave_out_the_columns_own_filter(client, world):
    hdrs = await login(client)
    filters = f(operator={"values": ["Ann Alpha"]}, source={"values": ["kiosk"]})
    got = await get_facets(client, hdrs, column="operator", filters=filters)
    want: dict[str, int] = {}
    for r in world:
        if r["source"] == "kiosk":
            want[shown(r, "operator")] = want.get(shown(r, "operator"), 0) + 1
    assert {g["value"]: g["count"] for g in got} == want
    assert len(want) > 1                       # own filter really is not applied
    # every other filter, the search box and the date range do apply
    got = await get_facets(client, hdrs, column="site", filters=filters,
                           q="dock", since=(T0 + timedelta(minutes=10)).isoformat())
    want = {}
    for r in world:
        if (r["operator"] == "Ann Alpha" and r["source"] == "kiosk"
                and "dock" in " ".join(
                    r[k] for k in ["primary", "scan_type", "status", "device",
                                   "operator", "site", "location", "source"]).lower()
                and r["scanned"] >= T0 + timedelta(minutes=10)):
            want[shown(r, "site")] = want.get(shown(r, "site"), 0) + 1
    assert {g["value"]: g["count"] for g in got} == want and want


async def test_facets_ignore_the_columns_own_exclude_but_apply_the_others(client, world):
    hdrs = await login(client)
    filters = f(operator={"exclude": ["Ann Alpha"]}, source={"exclude": ["kiosk"]})
    got = await get_facets(client, hdrs, column="operator", filters=filters)
    want: dict[str, int] = {}
    for r in world:
        if r["source"] != "kiosk":
            want[shown(r, "operator")] = want.get(shown(r, "operator"), 0) + 1
    assert {g["value"]: g["count"] for g in got} == want
    assert "Ann Alpha" in want                  # own exclude not applied


async def test_facet_search_narrows_the_list(client, world):
    hdrs = await login(client)
    got = await get_facets(client, hdrs, column="primary", search="val-09")
    want = {r["primary"] for r in world if "val-09" in r["primary"].lower()}
    assert {g["value"] for g in got} == want and want
    got = await get_facets(client, hdrs, column="site", search="SITE 1")
    assert {g["value"] for g in got} == {"Site 1", "Site 10"}


async def test_facets_are_capped_at_500_most_frequent_first(client, db, world):
    await db.execute(text("""
        INSERT INTO raw_scans (scanned_value, scan_type, scanned_at, device_id)
        SELECT 'X-' || g, 'rfid', now(), 'cap-' || lpad(g::text, 4, '0')
        FROM generate_series(1, 650) g"""))
    await db.execute(text("""
        INSERT INTO raw_scans (scanned_value, scan_type, scanned_at, device_id)
        SELECT 'Y-' || g, 'rfid', now(), 'cap-0007' FROM generate_series(1, 5) g"""))
    await db.commit()
    hdrs = await login(client)
    got = await get_facets(client, hdrs, column="device")
    assert len(got) == 500
    assert got[4] == {"value": "cap-0007", "count": 6}   # after the 4 seeded values
    counts = [g["count"] for g in got]
    assert counts == sorted(counts, reverse=True)


# ── export ──────────────────────────────────────────────────────────────

async def get_export(client, hdrs, **params):
    resp = await client.get("/scans/raw/export", headers=hdrs, params=params)
    assert resp.status_code == 200, resp.text
    return resp, list(csv.reader(io.StringIO(resp.text)))


async def test_export_is_every_matching_row_in_the_current_sort(client, world):
    hdrs = await login(client)
    resp, rows = await get_export(client, hdrs, sort="operator", dir="asc")
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]
    assert rows[0] == ["Scanned at", "Value", "Scan status", "Method", "Device",
                       "Operator", "Site", "Location", "Source", "Ingested"]
    assert len(rows) - 1 == N                       # beyond any one page
    expected = expected_order(world, "operator", "asc")
    by_id = {r["id"]: r for r in world}
    assert [r[5] for r in rows[1:]] == [by_id[i]["operator"] for i in expected]
    first = rows[1]
    assert first[0].endswith("Z") and first[9] == "2026-08-28T12:00:00Z"


async def test_export_applies_filters_and_search(client, world):
    hdrs = await login(client)
    _, rows = await get_export(
        client, hdrs, q="dock", filters=f(operator={"values": ["Bob Beta"]}),
        since=(T0 + timedelta(minutes=15)).isoformat())
    want = [r for r in world if r["operator"] == "Bob Beta"
            and r["scanned"] >= T0 + timedelta(minutes=15)
            and "dock" in " ".join(
                r[k] for k in ["primary", "scan_type", "status", "device",
                               "operator", "site", "location", "source"]).lower()]
    assert want and len(rows) - 1 == len(want)
    assert {r[5] for r in rows[1:]} == {"Bob Beta"}


async def test_export_cells_are_csv_injection_safe(client, db, world):
    boss = Person(first_name="=HYPERLINK(\"x\")", last_name="Boss")
    db.add(boss)
    await db.flush()
    db.add(RawScan(scanned_value="@cmd", scan_type="rfid", status=None,
                   scanned_at=T0 + timedelta(days=2), device_id="+1+1",
                   operator_id=boss.id, location_detail="-5", source="a,b\n\"c\""))
    await db.commit()
    hdrs = await login(client)
    _, rows = await get_export(client, hdrs)          # newest first
    top = rows[1]
    assert top[1] == "'@cmd"
    assert top[4] == "'+1+1"
    assert top[5].startswith("'=HYPERLINK")
    assert top[7] == "-5"                             # a plain number stays data
    assert top[8] == "a,b\n\"c\""                     # quoted, not mangled
    # a formula-looking value from the seed
    assert any(r[1].startswith("'=SUM(") for r in rows[1:])


async def test_export_with_nothing_matching_is_just_the_header(client, world):
    hdrs = await login(client)
    _, rows = await get_export(client, hdrs, q="no-such-scan-anywhere")
    assert len(rows) == 1


# ── validation and access ───────────────────────────────────────────────

@pytest.mark.parametrize("params", [
    {"cursor": "not-a-cursor"},
    {"cursor": "e30"},                                         # {}
    {"cursor": "eyJzIjoic2Nhbm5lZCIsImQiOiJkZXNjIiwidiI6MSwiaSI6MX0"},
    {"cursor": "eyJzIjoic2Nhbm5lZCIsImQiOiJkZXNjIiwidiI6Im5vdCBhIGRhdGUiLCJpIjoxfQ"},
    {"sort": "bogus"}, {"dir": "sideways"}, {"limit": 0}, {"limit": 501},
    {"filters": "{not json"}, {"filters": "[]"}, {"filters": '"x"'},
    {"filters": '{"nope": {"text": "a"}}'},
    {"filters": '{"site": "a"}'},
    {"filters": '{"site": {"text": 5}}'},
    {"filters": '{"site": {"values": "a"}}'},
    {"filters": '{"site": {"values": [1]}}'},
    {"filters": '{"site": {"other": "a"}}'},
    {"filters": '{"site": {"exclude": "a"}}'},
    {"filters": '{"site": {"exclude": [1]}}'},
    {"filters": '{"site": {"exclude": ["a", null]}}'},
    {"filters": json.dumps({"site": {"exclude": ["x"] * 1001}})},
    {"filters": json.dumps({"site": {"values": ["x"] * 1001}})},
    {"filters": json.dumps({"site": {"text": "x" * 501}})},
    {"since": "yesterday"},
])
async def test_bad_requests_are_422(client, world, params):
    hdrs = await login(client)
    resp = await client.get("/scans/raw/page", headers=hdrs, params=params)
    assert resp.status_code == 422, (params, resp.text)


async def test_a_cursor_from_another_sort_or_direction_is_422(client, world):
    hdrs = await login(client)
    body = await get_page(client, hdrs, limit=10, sort="site")
    for other in ({"sort": "operator"}, {"sort": "site", "dir": "asc"}):
        resp = await client.get("/scans/raw/page", headers=hdrs, params={
            "cursor": body["next_cursor"], **other})
        assert resp.status_code == 422, other
        assert resp.json()["detail"]["code"] == "invalid_cursor"


async def test_bad_filters_and_columns_are_422_on_facets_and_export(client, world):
    hdrs = await login(client)
    for col in ("scanned", "ingested", "bogus"):
        resp = await client.get("/scans/raw/facets", headers=hdrs,
                                params={"column": col})
        assert resp.status_code == 422, col
    resp = await client.get("/scans/raw/facets", headers=hdrs)
    assert resp.status_code == 422
    resp = await client.get("/scans/raw/facets", headers=hdrs,
                            params={"column": "site", "filters": "{"})
    assert resp.status_code == 422
    for path, extra in (("/scans/raw/export", {"filters": "{"}),
                        ("/scans/raw/export", {"sort": "bogus"})):
        resp = await client.get(path, headers=hdrs, params=extra)
        assert resp.status_code == 422, extra


async def test_raw_paging_endpoints_need_scans_view(client, db, seeded_user):
    w = Person(first_name="Wk", last_name="NoScan")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, w, "wk-noscan@test.example.com")
    for path, params in (("/scans/raw/page", {}),
                         ("/scans/raw/facets", {"column": "site"}),
                         ("/scans/raw/export", {})):
        resp = await client.get(path, headers=hdrs, params=params)
        assert resp.status_code == 403, path
        resp = await client.get(path, params=params)
        assert resp.status_code == 401, path


async def test_the_unpaged_list_is_unchanged(client, world):
    hdrs = await login(client)
    resp = await client.get("/scans/raw", headers=hdrs)
    assert resp.status_code == 200 and len(resp.json()) == N


# ── 100k rows ───────────────────────────────────────────────────────────

SLOW = pytest.mark.skipif(not os.environ.get("SS_SLOW_TESTS"),
                          reason="set SS_SLOW_TESTS=1 to run the 100k-row timing check")


@SLOW
async def test_first_page_of_100k_rows_is_fast(client, db, seeded_user):
    await db.execute(text("""
        INSERT INTO people (first_name, last_name)
        SELECT 'Op' || g, 'Person' FROM generate_series(1, 40) g"""))
    await db.execute(text("""
        INSERT INTO sites (name) SELECT 'Site ' || g FROM generate_series(1, 60) g"""))
    await db.execute(text("""
        INSERT INTO raw_scans (scanned_value, scan_type, status, scanned_at,
                               device_id, operator_id, site_id, location_detail, source)
        SELECT 'EPC-' || lpad((g * 7919 % 100003)::text, 8, '0'),
               (ARRAY['rfid','barcode','manual'])[1 + g % 3],
               (ARRAY['active','in_transit','in_storage'])[1 + g % 3],
               now() - (g || ' seconds')::interval,
               'dock-reader-' || (g % 25),
               (SELECT id FROM people WHERE first_name = 'Op' || (1 + g % 40)),
               (SELECT id FROM sites WHERE name = 'Site ' || (1 + g % 60)),
               'Dock ' || (g % 30), (ARRAY['kiosk','reader','import'])[1 + g % 3]
        FROM generate_series(1, 100000) g"""))
    await db.execute(text("ANALYZE raw_scans"))
    await db.commit()
    hdrs = await login(client)

    async def timed(**params):
        await get_page(client, hdrs, **params)            # warm the plan
        best = None
        for _ in range(3):
            t0 = time.perf_counter()
            body = await get_page(client, hdrs, **params)
            best = min(best or 9e9, time.perf_counter() - t0)
        return body, best

    body, took = await timed()
    print(f"\nfirst page, default sort: {took * 1000:.0f} ms")
    assert body["total"] == 100000 and len(body["rows"]) == 100
    assert took < 0.3
    report = {}
    for sort in SORTS:
        for direction in ("asc", "desc"):
            body, took = await timed(sort=sort, dir=direction)
            report[f"{sort} {direction}"] = round(took * 1000)
            second = await get_page(client, hdrs, sort=sort, dir=direction,
                                    cursor=body["next_cursor"])
            assert len(second["rows"]) == 100
    print("first page by sort (ms):", report)

    # a page from the middle of the list, per sort: what scrolling costs
    mid_id = await db.scalar(text("SELECT min(id) + 50000 FROM raw_scans"))
    mid_value = {
        "primary": "EPC-00050000", "scan_type": "Manual", "device": "dock-reader-12",
        "operator": "Op20 Person", "site": "Site 30", "location": "Dock 15",
        "source": "kiosk", "status": "In storage",
        "scanned": (datetime.now(UTC) - timedelta(seconds=50000)).isoformat(),
        "ingested": datetime.now(UTC).isoformat()}
    deep = {}
    for sort in SORTS:
        for direction in ("asc", "desc"):
            cursor = encode_cursor(sort, direction, mid_value[sort], mid_id)
            _, took = await timed(sort=sort, dir=direction, cursor=cursor)
            deep[f"{sort} {direction}"] = round(took * 1000)
    print("middle page by sort (ms):", deep)
    _, took = await timed(q="dock-reader-7", filters=f(
        operator={"values": ["Op3 Person"]}))
    print(f"search + filter: {took * 1000:.0f} ms")
    t0 = time.perf_counter()
    facet = await get_facets(client, hdrs, column="site")
    print(f"site facets: {(time.perf_counter() - t0) * 1000:.0f} ms")
    assert len(facet) == 60
    t0 = time.perf_counter()
    _, rows = await get_export(client, hdrs, q="dock-reader-7")
    print(f"export {len(rows) - 1} rows: {(time.perf_counter() - t0) * 1000:.0f} ms")
