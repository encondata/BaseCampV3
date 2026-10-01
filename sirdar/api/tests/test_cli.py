import psycopg
from typer.testing import CliRunner

from sirdar_api.cli import app

from .conftest import _psycopg_url, TEST_DB
from .source_helpers import add_portal_person, add_role

runner = CliRunner()


def _scalar(sql: str, *args):
    with psycopg.connect(_psycopg_url(TEST_DB)) as conn:
        return conn.execute(sql, args).fetchone()[0]


def test_create_admin_and_login_ready():
    result = runner.invoke(app, ["create-admin", "--email", "root@test.example.com",
                                 "--first-name", "Root", "--last-name", "Admin"],
                           input="LongEnoughPass1\nLongEnoughPass1\n")
    assert result.exit_code == 0, result.output
    assert "Created local developer root@test.example.com" in result.output
    assert _scalar("SELECT source FROM users WHERE email = %s", "root@test.example.com") == "local"
    assert _scalar("SELECT role FROM user_roles") == "developer"


def test_create_admin_rejects_short_password_and_unknown_role():
    short = runner.invoke(app, ["create-admin", "--email", "a@test.example.com",
                                "--first-name", "A", "--last-name", "B"],
                          input="short\nshort\n")
    assert short.exit_code == 1 and "at least 12" in short.output
    bad = runner.invoke(app, ["create-admin", "--email", "a@test.example.com",
                              "--first-name", "A", "--last-name", "B", "--role", "staff"],
                        input="LongEnoughPass1\nLongEnoughPass1\n")
    assert bad.exit_code == 1 and "Unknown role" in bad.output


def test_reset_password_local_only():
    runner.invoke(app, ["create-admin", "--email", "root@test.example.com",
                        "--first-name", "Root", "--last-name", "Admin"],
                  input="LongEnoughPass1\nLongEnoughPass1\n")
    ok = runner.invoke(app, ["reset-password", "--email", "root@test.example.com"],
                       input="AnotherLongPass2\nAnotherLongPass2\n")
    assert ok.exit_code == 0, ok.output
    missing = runner.invoke(app, ["reset-password", "--email", "nobody@test.example.com"],
                            input="AnotherLongPass2\nAnotherLongPass2\n")
    assert missing.exit_code == 1 and "No user" in missing.output


def test_import_users_prints_summary(source):
    add_role(source, "admin", 60)
    add_portal_person(source, email="admin@test.example.com")
    result = runner.invoke(app, ["import-users"])
    assert result.exit_code == 0, result.output
    assert "added 1" in result.output
    assert "admin@test.example.com" in result.output


def test_create_admin_rejects_special_use_email():
    result = runner.invoke(app, ["create-admin", "--email", "admin@sirdar.local",
                                 "--first-name", "A", "--last-name", "B"],
                           input="LongEnoughPass1\nLongEnoughPass1\n")
    assert result.exit_code == 1
    assert "can't be used to sign in" in result.output


async def test_created_admin_can_log_in(client):
    import asyncio
    result = await asyncio.to_thread(
        runner.invoke, app, ["create-admin", "--email", "Root@Test.Example.com",
                             "--first-name", "Root", "--last-name", "Admin"],
        input="LongEnoughPass1\nLongEnoughPass1\n")
    assert result.exit_code == 0, result.output
    resp = await client.post("/api/auth/login", json={"email": "root@test.example.com",
                                                      "password": "LongEnoughPass1"})
    assert resp.status_code == 200, resp.text
