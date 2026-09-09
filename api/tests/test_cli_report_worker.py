"""report-worker CLI flags: --reload wiring and flag conflicts.

Pure CLI-surface tests — no DB, no processes: the reload path is
exercised by monkeypatching watchfiles.run_process, so nothing here
touches Postgres or actually spawns a worker."""

from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.cli import app

runner = CliRunner()


def test_help_shows_reload_flag():
    result = runner.invoke(app, ["report-worker", "--help"])
    assert result.exit_code == 0
    assert "--reload" in result.output


def test_reload_and_once_conflict():
    result = runner.invoke(app, ["report-worker", "--reload", "--once"])
    assert result.exit_code == 1
    assert "cannot be combined" in result.output


def test_reload_invokes_watchfiles_run_process(monkeypatch):
    import watchfiles

    calls: dict = {}

    def fake_run_process(*paths, target, args=(), **kwargs):
        calls["paths"] = paths
        calls["target"] = target
        calls["args"] = args

    monkeypatch.setattr(watchfiles, "run_process", fake_run_process)
    result = runner.invoke(
        app, ["report-worker", "--reload", "--poll-seconds", "1.5"])
    assert result.exit_code == 0, result.output
    assert calls["target"] is cli._run_report_worker_process
    assert calls["args"] == (1.5,)
    # watches the api source tree the package lives in
    assert str(calls["paths"][0]).endswith("/src")
