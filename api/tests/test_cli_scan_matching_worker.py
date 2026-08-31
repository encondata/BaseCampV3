"""CLI surface of `serversherpa scan-matching-worker` — mirrors
test_cli_import_worker.py."""

from pathlib import Path

from typer.testing import CliRunner

from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_reload_flag():
    result = runner.invoke(app, ["scan-matching-worker", "--help"])
    assert result.exit_code == 0
    assert "--reload" in result.output


def test_reload_and_once_conflict():
    result = runner.invoke(
        app, ["scan-matching-worker", "--reload", "--once"])
    assert result.exit_code == 1
    assert "cannot be combined" in result.output


def test_reload_invokes_watchfiles(monkeypatch):
    calls = {}

    def fake_run_process(path, target, args):
        calls["path"], calls["target"], calls["args"] = path, target, args

    import watchfiles
    monkeypatch.setattr(watchfiles, "run_process", fake_run_process)
    result = runner.invoke(app, ["scan-matching-worker", "--reload",
                                 "--poll-seconds", "3.5"])
    assert result.exit_code == 0
    assert str(calls["path"]).endswith("/src")
    assert calls["args"] == (3.5,)
    from serversherpa.cli import _run_scan_matching_worker_process
    assert calls["target"] is _run_scan_matching_worker_process
