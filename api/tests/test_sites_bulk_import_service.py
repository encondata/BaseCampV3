"""Parsing + validation pipeline for sites bulk import (no HTTP)."""
import pytest

from serversherpa.sites import bulk_import as bi


def test_columns_match_canonical_shape():
    assert bi.COLUMNS == [
        "name", "code", "type", "status", "address_line1", "address_line2",
        "city", "region", "postal_code", "country", "latitude", "longitude",
        "timezone", "dc_provider", "partner", "clients", "notes"]


def test_csv_and_json_normalize_identically():
    csv_text = bi.build_template_csv()
    from_csv = bi.parse_upload("t.csv", csv_text.encode())
    from_json = bi.number_json_rows(bi.SAMPLE_ROWS)
    assert [r for _, r in from_csv] == [r for _, r in from_json]
    assert [n for n, _ in from_csv] == [2, 3]      # header is row 1
    assert [n for n, _ in from_json] == [1, 2]


def test_xlsx_template_round_trips():
    blob = bi.build_template_xlsx(["datacenter"], ["active"])
    rows = bi.parse_upload("t.xlsx", blob)
    assert [r for _, r in rows] == [r for _, r in bi.number_json_rows(bi.SAMPLE_ROWS)]


def test_csv_bom_and_numeric_cells():
    csv_text = "﻿name,postal_code\nBom DC,89501\n"
    rows = bi.parse_upload("t.csv", csv_text.encode())
    assert rows[0][1]["name"] == "Bom DC"
    assert rows[0][1]["postal_code"] == "89501"
    # xlsx numeric cell coerces without a trailing .0
    import io

    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sites"
    ws.append(["name", "postal_code"])
    ws.append(["Num DC", 89501])
    buf = io.BytesIO()
    wb.save(buf)
    rows = bi.parse_upload("n.xlsx", buf.getvalue())
    assert rows[0][1]["postal_code"] == "89501"


def test_unknown_column_rejected():
    with pytest.raises(bi.BulkImportError) as exc:
        bi.number_json_rows([{"name": "A", "citty": "Reno"}])
    assert exc.value.code == "unknown_columns"
    assert exc.value.extra["columns"] == ["citty"]


def test_too_many_rows_rejected():
    with pytest.raises(bi.BulkImportError) as exc:
        bi.number_json_rows([{"name": str(i)} for i in range(1001)])
    assert exc.value.code == "too_many_rows"


def test_bad_file_extension_and_broken_payloads():
    with pytest.raises(bi.BulkImportError) as exc:
        bi.parse_upload("notes.txt", b"hello")
    assert exc.value.code == "unsupported_file"
    with pytest.raises(bi.BulkImportError) as exc:
        bi.parse_upload("x.json", b"{not json")
    assert exc.value.code == "invalid_json"
    with pytest.raises(bi.BulkImportError) as exc:
        bi.number_json_rows({"rows": []})  # type: ignore[arg-type]
    assert exc.value.code == "invalid_json"
    with pytest.raises(bi.BulkImportError) as exc:
        bi.parse_upload("big.csv", b"x" * (bi.MAX_BYTES + 1))
    assert exc.value.code == "file_too_large"


async def test_preview_missing_name_and_payload_dupes(db, seeded_user):
    # a fully blank row is dropped by the parser, so give row 1 some content
    rows = bi.number_json_rows([
        {"name": "", "city": "Reno"}, {"name": "Twin"}, {"name": "twin"}])
    out = await bi.preview_rows(db, rows, allow_updates=False)
    by_row = {r["row"]: r for r in out["rows"]}
    assert by_row[1]["action"] == "error" and "name" in by_row[1]["errors"][0]
    assert by_row[2]["action"] == "error"     # in-payload duplicate (both rows)
    assert by_row[3]["action"] == "error"
    assert out["can_commit"] is False


async def test_preview_validates_lookups_coords_orgs(db, seeded_user):
    rows = bi.number_json_rows([
        {"name": "A", "type": "spaceport"},
        {"name": "B", "status": "haunted"},
        {"name": "C", "latitude": "95", "longitude": "0"},
        {"name": "D", "latitude": "40"},
        {"name": "E", "partner": "Nobody"},
        {"name": "F", "clients": "Ghost Co"},
    ])
    out = await bi.preview_rows(db, rows, allow_updates=False)
    assert all(r["action"] == "error" for r in out["rows"])
    assert out["can_commit"] is False


async def test_preview_good_rows_normalize_defaults(db, seeded_user):
    rows = bi.number_json_rows([{"name": "  Fresh DC  ", "city": "Reno"}])
    out = await bi.preview_rows(db, rows, allow_updates=False)
    row = out["rows"][0]
    assert row["action"] == "create" and out["can_commit"] is True
    assert row["data"]["name"] == "Fresh DC"          # trimmed
    assert row["data"]["status"] == "active"          # default applied
    assert row["data"]["country"] == "US"
    assert "_blank" not in row["data"]


async def test_duplicate_admin_error_vs_developer_diff(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Exists", city="Old Town", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "exists", "city": "New Town"}])
    admin = await bi.preview_rows(db, rows, allow_updates=False)
    assert admin["rows"][0]["action"] == "error"
    assert "already exists" in admin["rows"][0]["errors"][0]
    dev = await bi.preview_rows(db, rows, allow_updates=True)
    row = dev["rows"][0]
    assert row["action"] == "update" and row["site_id"]
    assert row["diff"]["city"] == {"old": "Old Town", "new": "New Town"}
    assert "country" not in row["diff"]               # blank = no change
    assert "status" not in row["diff"]


async def test_duplicate_with_no_changes_is_unchanged(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Same", city="Reno", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Same", "city": "Reno"}])
    out = await bi.preview_rows(db, rows, allow_updates=True)
    assert out["rows"][0]["action"] == "unchanged"
    assert out["rows"][0]["diff"] is None
    assert out["can_commit"] is True


async def test_ambiguous_existing_name_is_error(db, seeded_user):
    from serversherpa.db.models import Site
    db.add(Site(name="Dup A", country="US", status="active"))
    db.add(Site(name="dup a", country="US", status="active"))
    await db.commit()
    rows = bi.number_json_rows([{"name": "Dup A", "city": "X"}])
    out = await bi.preview_rows(db, rows, allow_updates=True)
    assert out["rows"][0]["action"] == "error"
    assert "multiple existing sites" in out["rows"][0]["errors"][0]


async def test_clients_diff_add_remove_and_partner(db, seeded_user):
    from serversherpa.db.models import Client, Partner, Site, SiteClient
    old_co = Client(name="Old Co")
    new_co = Client(name="New Co")
    pt = Partner(name="Haul It")
    db.add_all([old_co, new_co, pt])
    await db.flush()
    site = Site(name="Linked", country="US", status="active")
    db.add(site)
    await db.flush()
    db.add(SiteClient(site_id=site.id, client_id=old_co.id))
    await db.commit()

    rows = bi.number_json_rows([
        {"name": "Linked", "clients": "New Co", "partner": "haul it"}])
    out = await bi.preview_rows(db, rows, allow_updates=True)
    row = out["rows"][0]
    assert row["action"] == "update"
    assert row["diff"]["clients"] == {"add": ["New Co"], "remove": ["Old Co"]}
    assert row["diff"]["partner"] == {"old": None, "new": "Haul It"}
