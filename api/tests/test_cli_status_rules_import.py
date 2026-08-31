"""CLI surface of `serversherpa import-v2-status-rules` — help text and
dry-run report shape; the importer's behavior is covered in
test_status_rules_v2_import.py."""

from typer.testing import CliRunner

from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_dump_and_dry_run():
    result = runner.invoke(app, ["import-v2-status-rules", "--help"])
    assert result.exit_code == 0
    assert "--dump" in result.output
    assert "--dry-run" in result.output


def test_missing_dump_errors():
    result = runner.invoke(app, ["import-v2-status-rules"])
    assert result.exit_code != 0
