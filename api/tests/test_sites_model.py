"""Migration 0011: lookups seeded, sites/site_clients exist, matrix rows added.
Status seeding moved to 0012 — see test_status_values_model.py."""
from sqlalchemy import text


async def test_lookups_seeded(db):
    types = [r.key for r in (await db.execute(text(
        "SELECT key FROM site_types ORDER BY sort_order"))).all()]
    assert types == ["datacenter", "office", "warehouse", "colo",
                     "partner_office", "other"]


async def test_sites_tables_exist(db):
    for table in ("sites", "site_clients", "site_types"):
        ok = (await db.execute(text(
            "SELECT 1 FROM information_schema.tables WHERE table_name = :t"),
            {"t": table})).scalar()
        assert ok == 1, table


async def test_coords_check_constraint(db):
    """Half a coordinate is not a coordinate."""
    import pytest
    from sqlalchemy.exc import IntegrityError
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO sites (name, latitude) VALUES ('Half', 40.7)"))
        await db.flush()
    await db.rollback()


async def test_sites_matrix_seeded(db):
    staff_full = (await db.execute(text(
        "SELECT count(*) FROM role_permissions "
        "WHERE role='staff' AND resource='sites'"))).scalar_one()
    assert staff_full == 4
    client_viewer = [r.action for r in (await db.execute(text(
        "SELECT action FROM role_permissions "
        "WHERE role='client_viewer' AND resource='sites'"))).all()]
    assert client_viewer == []
    worker = (await db.execute(text(
        "SELECT count(*) FROM role_permissions "
        "WHERE role='worker' AND resource='sites'"))).scalar_one()
    assert worker == 0
