"""Migration 0009 sanity: system roles seeded, grants remapped, matrix populated."""
import pytest
from sqlalchemy import text


async def test_system_roles_seeded(db):
    rows = (await db.execute(text(
        "SELECT name, rank, scope_anchor, is_system FROM roles ORDER BY rank DESC, name"
    ))).all()
    by_name = {r.name: r for r in rows}
    assert by_name["developer"].rank == 100
    assert by_name["founder"].rank == 100
    assert by_name["super_admin"].rank == 80
    assert by_name["admin"].rank == 60
    assert by_name["staff"].rank == 40
    assert by_name["client_owner"].rank == 30
    assert by_name["client_owner"].scope_anchor == "client"
    assert by_name["vendor_viewer"].scope_anchor == "partner"
    assert by_name["worker"].scope_anchor == "self"
    assert "client" not in by_name and "vendor" not in by_name
    assert all(by_name[n].is_system for n in by_name)


async def test_default_matrix_seeded(db):
    n = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='staff' AND resource='workers'"
    ))).scalar_one()
    assert n == 4  # staff: view/add/change/delete on workers
    dev_devtools = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='developer' AND resource='devtools'"
    ))).scalar_one()
    assert dev_devtools == 4
    founder_devtools = (await db.execute(text(
        "SELECT count(*) FROM role_permissions WHERE role='founder' AND resource='devtools'"
    ))).scalar_one()
    assert founder_devtools == 0


async def test_new_tables_exist(db):
    for table in ("access_groups", "access_group_members", "resource_group_gates",
                  "permission_overrides", "audit_log"):
        ok = (await db.execute(text(
            "SELECT 1 FROM information_schema.tables WHERE table_name = :t"),
            {"t": table})).scalar()
        assert ok == 1, table
