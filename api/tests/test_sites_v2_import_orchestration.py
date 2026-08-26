"""Orchestration-level coverage for `import_sites`: the async DB-touching
paths (orphaned client/partner FK ids, NULL name/site_type guards, and
intra-run duplicate-name dedup) that the pure-function tests in
test_sites_v2_import.py can't exercise. Each test writes its own tiny
synthetic dump to tmp_path rather than touching the real backup file."""

from sqlalchemy import select

from serversherpa.db.models import Site
from serversherpa.sites.v2_import import import_sites

_SITES_COLS = (
    "v2_id, name, address, gps_coordinates, metadata, site_type, "
    "site_status, client, survey_data, partner_id"
)


def _sites_insert(*rows: str) -> str:
    return "".join(
        f"INSERT INTO sites ({_SITES_COLS}) VALUES ({row});\n" for row in rows
    )


async def test_orphaned_client_fk_id_produces_note_and_unmatched_entry(tmp_path, db):
    """Finding 1 (client branch): a site's `client` FK id has no matching
    row in the dump's own `clients` table at all -- must not be silently
    dropped, must produce the 'not in dump' note/unmatched entry."""
    dump = tmp_path / "dump.sql"
    dump.write_text(
        _sites_insert(
            "1, 'Orphan Client Site', NULL, NULL, NULL, "
            "'Data Center', 40, 99, NULL, NULL"
        )
        + "INSERT INTO clients (id, name) VALUES (5, 'Some Client');\n"
    )

    summary = await import_sites(db, str(dump), limit=10)

    site = await db.scalar(select(Site).where(Site.name == "Orphan Client Site"))
    assert site is not None
    assert site.notes == "V2 client: id 99 (not in dump)"
    assert "V2 client: id 99 (not in dump)" in summary["unmatched_clients"]


async def test_orphaned_partner_fk_id_produces_note_and_unmatched_entry(tmp_path, db):
    """Finding 1 (partner branch): same as above but for `partner_id`."""
    dump = tmp_path / "dump.sql"
    dump.write_text(
        _sites_insert(
            "1, 'Orphan Partner Site', NULL, NULL, NULL, "
            "'Data Center', 40, NULL, NULL, 77"
        )
        + "INSERT INTO partners (id, name) VALUES (3, 'Some Partner');\n"
    )

    summary = await import_sites(db, str(dump), limit=10)

    site = await db.scalar(select(Site).where(Site.name == "Orphan Partner Site"))
    assert site is not None
    assert site.notes == "V2 partner: id 77 (not in dump)"
    assert "V2 partner: id 77 (not in dump)" in summary["unmatched_partners"]


async def test_null_name_row_is_skipped_not_crashed(tmp_path, db):
    """Finding 2a: a row with no name must not crash `name.casefold()`; it
    must be skipped and surfaced in `skipped_invalid`, while a normal row
    in the same dump still imports fine."""
    dump = tmp_path / "dump.sql"
    dump.write_text(
        _sites_insert(
            "1, NULL, NULL, NULL, NULL, 'Data Center', 40, NULL, NULL, NULL",
            "2, 'Valid Site', NULL, NULL, NULL, 'Data Center', 40, NULL, NULL, NULL",
        )
    )

    summary = await import_sites(db, str(dump), limit=10)

    assert summary["created"] == 1
    assert any("v2 id 1" in entry for entry in summary["skipped_invalid"])
    missing_site = await db.scalar(
        select(Site).where(Site.source_ref == "backup_20260825_193157:sites/1"))
    assert missing_site is None
    valid_site = await db.scalar(select(Site).where(Site.name == "Valid Site"))
    assert valid_site is not None


async def test_null_site_type_leaves_site_unclassified(tmp_path, db):
    """Finding 2b: a row with no site_type must not crash and must not
    spuriously create a SiteType -- the resulting Site.site_type is NULL."""
    dump = tmp_path / "dump.sql"
    dump.write_text(
        _sites_insert(
            "1, 'No Type Site', NULL, NULL, NULL, NULL, 40, NULL, NULL, NULL"
        )
    )

    summary = await import_sites(db, str(dump), limit=10)

    site = await db.scalar(select(Site).where(Site.name == "No Type Site"))
    assert site is not None
    assert site.site_type is None
    assert summary["types_created"] == []


async def test_intra_run_duplicate_names_are_deduped(tmp_path, db):
    """Finding 3: two rows in the SAME dump that both resolve to
    picked/new status but share a name (case-insensitively) must not both
    get created -- only the first should be, and the second should count
    toward `pre_existing` same as a real pre-existing-name match would."""
    baseline_dump = tmp_path / "baseline.sql"
    baseline_dump.write_text(
        _sites_insert(
            "1, 'Site One', NULL, NULL, NULL, 'Office', 40, NULL, NULL, NULL",
            "2, 'Site Two', NULL, NULL, NULL, 'Office', 40, NULL, NULL, NULL",
        )
    )
    baseline_summary = await import_sites(db, str(baseline_dump), limit=10)
    assert baseline_summary["created"] == 2
    assert baseline_summary["pre_existing"] == 0

    dup_dump = tmp_path / "dup.sql"
    dup_dump.write_text(
        _sites_insert(
            "10, 'Dup Site', NULL, NULL, NULL, 'Office', 40, NULL, NULL, NULL",
            "11, 'DUP SITE', NULL, NULL, NULL, 'Office', 40, NULL, NULL, NULL",
        )
    )
    dup_summary = await import_sites(db, str(dup_dump), limit=10)

    assert dup_summary["created"] == 1
    assert dup_summary["pre_existing"] == baseline_summary["pre_existing"] + 1

    matches = (await db.scalars(
        select(Site).where(Site.name == "Dup Site"))).all()
    assert len(matches) == 1
