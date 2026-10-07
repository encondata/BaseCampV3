"""bootstrap-admin's surface: flags, stdin, exit codes. The service is
replaced (test_first_admin_service.py covers it), so nothing here touches
Postgres or a real event loop's engine."""

import logging

import pytest
from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.cli import app
from serversherpa.services.first_admin import FirstAdminError, FirstAdminResult

runner = CliRunner()
BASE = ["bootstrap-admin", "--email", "ada@test.example.com", "--first-name", "Ada",
        "--last-name", "Lovelace"]
SECRET = "Stdin-Only-Password-42"


class Calls(list):
    """The service calls, plus `outcome`: what the fake answers next."""
    outcome: dict


@pytest.fixture
def calls(monkeypatch):
    seen = Calls()
    outcome: dict = {}

    async def fake(**kwargs):
        seen.append(kwargs)
        if "error" in outcome:
            raise outcome["error"]
        return FirstAdminResult(person_id="00000000-0000-0000-0000-000000000001",
                                emailed=outcome.get("emailed", True))

    monkeypatch.setattr(cli, "_create_first_admin", fake)
    seen.outcome = outcome
    return seen


def test_help_lists_the_new_flags():
    result = runner.invoke(app, ["bootstrap-admin", "--help"])
    assert result.exit_code == 0
    for flag in ("--role", "--password-stdin", "--invite", "--link-minutes"):
        assert flag in result.output
    assert "--password " not in result.output        # never a password in argv


def test_password_stdin_reads_one_line(calls):
    result = runner.invoke(app, [*BASE, "--role", "super_admin", "--password-stdin",
                                 "--link-minutes", "240"], input=SECRET + "\n")
    assert result.exit_code == 0, result.output
    assert calls == [{"email": "ada@test.example.com", "first_name": "Ada",
                      "last_name": "Lovelace", "role": "super_admin", "password": SECRET,
                      "link_minutes": 240}]
    assert SECRET not in result.output


def test_invite_sends_no_password(calls):
    result = runner.invoke(app, [*BASE, "--invite", "--link-minutes", "240"])
    assert result.exit_code == 0, result.output
    assert calls[0]["password"] is None and calls[0]["role"] == "admin"


def test_the_prompt_is_kept_without_either_flag(calls):
    result = runner.invoke(app, BASE, input=f"{SECRET}\n{SECRET}\n")
    assert result.exit_code == 0, result.output
    assert calls[0]["password"] == SECRET and calls[0]["link_minutes"] is None


@pytest.mark.parametrize("args", [
    ["--password-stdin", "--invite", "--link-minutes", "240"],
    ["--invite"],
    ["--invite", "--link-minutes", "0"],
])
def test_usage_errors_exit_2(calls, args):
    result = runner.invoke(app, [*BASE, *args], input=SECRET + "\n")
    assert result.exit_code == 2
    assert calls == []


@pytest.mark.parametrize("code, extra, exit_code", [
    ("account_exists", {}, 1),
    ("password_too_short", {"min_length": 8}, 3),
    ("role_unknown", {}, 4),
    ("mail_not_configured", {}, 5),
])
def test_refusals_map_to_exit_codes(calls, code, extra, exit_code):
    calls.outcome["error"] = FirstAdminError(code, **extra)
    result = runner.invoke(app, [*BASE, "--password-stdin", "--link-minutes", "240"],
                           input=SECRET + "\n")
    assert result.exit_code == exit_code
    assert SECRET not in result.output
    if code == "password_too_short":
        assert "at least 8 characters" in result.output


def test_a_typed_password_without_mail_warns(calls):
    calls.outcome["emailed"] = False
    result = runner.invoke(app, [*BASE, "--password-stdin", "--link-minutes", "240"],
                           input=SECRET + "\n")
    assert result.exit_code == 0
    assert "No email was sent" in result.output


def test_the_password_never_reaches_argv_output_or_logs(calls, caplog):
    caplog.set_level(logging.DEBUG)
    result = runner.invoke(app, [*BASE, "--password-stdin", "--link-minutes", "240"],
                           input=SECRET + "\n")
    assert result.exit_code == 0, result.output
    assert SECRET not in result.output and SECRET not in caplog.text
    assert all(SECRET not in str(v) for k, v in calls[0].items() if k != "password")
