"""log-service CLI mirrors import-worker's flags."""

from typer.testing import CliRunner

from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_flags():
    result = runner.invoke(app, ["log-service", "--help"])
    assert result.exit_code == 0
    assert "--reload" in result.output
    assert "--once" in result.output


def test_reload_and_once_conflict():
    result = runner.invoke(app, ["log-service", "--reload", "--once"])
    assert result.exit_code == 1
    assert "cannot be combined" in result.output
