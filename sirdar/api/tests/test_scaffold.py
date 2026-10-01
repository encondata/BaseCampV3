from sqlalchemy import text


async def test_healthz_reports_ok(client):
    for path in ("/healthz", "/api/healthz"):
        resp = await client.get(path)
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


async def test_migration_creates_every_table(db):
    names = set(await db.scalars(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")))
    assert {"roles", "users", "user_roles", "role_permissions", "permission_overrides",
            "totp_backup_codes", "auth_sessions", "audit_log", "import_runs"} <= names


async def test_default_roles_seeded(db):
    rows = (await db.execute(text("SELECT name, rank FROM roles ORDER BY rank DESC, name"))).all()
    assert [tuple(r) for r in rows] == [
        ("developer", 100), ("founder", 100), ("super_admin", 80), ("admin", 60)]


async def test_unknown_api_path_is_404_not_spa(client):
    resp = await client.get("/api/nope")
    assert resp.status_code == 404
