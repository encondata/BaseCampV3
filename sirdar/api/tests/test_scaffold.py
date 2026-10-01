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


def _settings(**over):
    from cryptography.fernet import Fernet
    from sirdar_api.config import Settings
    kw = dict(database_url="postgresql+asyncpg://u:p@h/d", jwt_secret="j" * 40,
              SIRDAR_PASSWORD_PEPPER="pepper", SIRDAR_TOTP_ENCRYPTION_KEY=Fernet.generate_key().decode())
    kw.update(over)
    return Settings(_env_file=None, **kw)


def test_settings_reject_weak_secrets():
    import pytest
    from pydantic import ValidationError
    assert _settings()
    for bad in ({"jwt_secret": "short"}, {"SIRDAR_PASSWORD_PEPPER": ""}, {"SIRDAR_TOTP_ENCRYPTION_KEY": ""}):
        with pytest.raises(ValidationError):
            _settings(**bad)


def test_deploy_settings_defaults_and_key_file():
    s = _settings()
    assert s.deploy_do_token is None and s.deploy_ssh_port == 22
    assert s.deploy_keys_dir == "/app/deploy-keys" and s.deploy_ssh_key_file is None
    assert _settings(deploy_ssh_key_path="id_ed25519").deploy_ssh_key_file == \
        "/app/deploy-keys/id_ed25519"
    assert _settings(deploy_ssh_key_path="/k/id", deploy_keys_dir="/x").deploy_ssh_key_file == "/k/id"
    assert _settings(deploy_keys_dir="/x", deploy_ssh_key_path="a").deploy_ssh_key_file == "/x/a"


def test_deploy_empty_secrets_are_none(monkeypatch):
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    monkeypatch.setenv("SIRDAR_DEPLOY_SSH_PASSWORD", "")
    s = _settings()
    assert s.deploy_do_token is None and s.deploy_ssh_password is None
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "tok")
    assert _settings().deploy_do_token.get_secret_value() == "tok"
