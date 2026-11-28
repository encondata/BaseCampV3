"""Previous results: the finished runs in the runs folder, as a list and one at a time."""

import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from loadtest import history as history_module
from loadtest.history import History
from loadtest.runner import Runner
from loadtest.web.app import create_app


def result(move: str = "Move A", verdict: str = "Pass", servers: int = 60, **run) -> dict:
    return {
        "run": {"server_url": "https://api.example.test", "move_id": "m-1", "move_name": move,
                "servers": servers, "containers": 3, "trucks": 1, "profile": "fast",
                "started_at": "2026-11-27T10:00:00+00:00",
                "ended_at": "2026-11-27T10:20:30+00:00", "reason": "completed",
                "interruptions": [], **run},
        "verdict": verdict, "findings": [], "calls": {}, "scans": {},
        "series": {"waiting": [[1.0, 3]]},
    }


def save(runs: Path, name: str, data: object | None = None, text: str | None = None) -> Path:
    folder = runs / name
    folder.mkdir(parents=True)
    path = folder / "results.json"
    path.write_text(text if text is not None else json.dumps(data), encoding="utf-8")
    return path


# ── the list ───────────────────────────────────────────────────────────


def test_finished_runs_are_listed_newest_first(tmp_path):
    save(tmp_path, "2026-11-27_10-00-00Z", result("First"))
    save(tmp_path, "2026-11-28_01-34-25Z", result("Third", "Fail", servers=10000))
    save(tmp_path, "2026-11-27_10-00-00Z-2", result("Second", "Pass with warnings"))
    lines = History(tmp_path).list()
    assert [(line["id"], line["move_name"], line["verdict"]) for line in lines] == [
        ("2026-11-28_01-34-25Z", "Third", "Fail"),
        ("2026-11-27_10-00-00Z-2", "Second", "Pass with warnings"),
        ("2026-11-27_10-00-00Z", "First", "Pass")]
    assert lines[0] == {
        "id": "2026-11-28_01-34-25Z", "verdict": "Fail",
        "server_url": "https://api.example.test", "move_name": "Third", "profile": "fast",
        "started_at": "2026-11-27T10:00:00+00:00", "ended_at": "2026-11-27T10:20:30+00:00",
        "servers": 10000, "containers": 3, "trucks": 1}


def test_a_run_with_no_result_file_is_not_listed(tmp_path):
    (tmp_path / "2026-11-27_10-00-00Z").mkdir()            # still going, or never ended
    (tmp_path / "2026-11-27_10-00-00Z" / "journal.jsonl").write_text("{}\n")
    save(tmp_path, "2026-11-27_11-00-00Z", result())
    assert [line["id"] for line in History(tmp_path).list()] == ["2026-11-27_11-00-00Z"]


def test_no_runs_folder_is_an_empty_list(tmp_path):
    assert History(tmp_path / "missing").list() == []
    assert History(tmp_path / "missing").read("2026-11-27_10-00-00Z") is None


@pytest.mark.parametrize("text", ["", "not json", "[1, 2]", '{"verdict": "Pass"}',
                                  '{"run": {}, "verdict": 3}', '{"run": [], "verdict": "Pass"}'])
def test_a_file_that_is_not_a_result_is_left_out(tmp_path, text):
    save(tmp_path, "2026-11-27_10-00-00Z", text=text)
    save(tmp_path, "2026-11-27_11-00-00Z", result())
    assert [line["id"] for line in History(tmp_path).list()] == ["2026-11-27_11-00-00Z"]
    assert History(tmp_path).read("2026-11-27_10-00-00Z") is None


def test_other_folders_and_files_are_ignored(tmp_path):
    save(tmp_path, "notes", result())
    save(tmp_path, "2026-11-27_10-00-00Z.bak", result())
    (tmp_path / ".lock").write_text("")
    assert History(tmp_path).list() == []


def test_missing_facts_are_none_and_never_refuse_the_line(tmp_path):
    save(tmp_path, "2026-11-27_10-00-00Z",
         {"run": {"move_name": 7, "servers": "many", "trucks": True}, "verdict": "Fail"})
    assert History(tmp_path).list() == [{
        "id": "2026-11-27_10-00-00Z", "verdict": "Fail", "server_url": None,
        "move_name": None, "profile": None, "started_at": None, "ended_at": None,
        "servers": None, "containers": None, "trucks": None}]


def test_a_result_is_read_again_only_after_it_changed(tmp_path, monkeypatch):
    path = save(tmp_path, "2026-11-27_10-00-00Z", result("Before"))
    reads: list[Path] = []
    real = history_module._load
    monkeypatch.setattr(history_module, "_load", lambda p: reads.append(p) or real(p))
    history = History(tmp_path)
    assert history.list()[0]["move_name"] == "Before"
    assert history.list()[0]["move_name"] == "Before"
    assert len(reads) == 1
    path.write_text(json.dumps(result("After, a longer name")), encoding="utf-8")
    assert history.list()[0]["move_name"] == "After, a longer name"
    assert len(reads) == 2
    # a caller changing a line never changes what is kept
    history.list()[0]["move_name"] = "changed"
    assert history.list()[0]["move_name"] == "After, a longer name"


def test_a_removed_run_leaves_the_list(tmp_path):
    path = save(tmp_path, "2026-11-27_10-00-00Z", result())
    history = History(tmp_path)
    assert len(history.list()) == 1
    path.unlink()
    assert history.list() == []


# ── one result ─────────────────────────────────────────────────────────


def test_one_result_is_read_whole_with_its_folder(tmp_path):
    save(tmp_path, "2026-11-27_10-00-00Z", result("Move A"))
    got = History(tmp_path).read("2026-11-27_10-00-00Z")
    assert got["id"] == "2026-11-27_10-00-00Z"
    assert got["run_dir"] == str(tmp_path / "2026-11-27_10-00-00Z")
    assert got["result"] == result("Move A")


@pytest.mark.parametrize("run_id", [
    "", ".", "..", "../2026-11-27_10-00-00Z", "2026-11-27_10-00-00Z/..",
    "2026-11-27_10-00-00Z/results.json", "/etc", "2026-11-27_10-00-00Z\n", "notes",
    "2026-11-27_10-00-00Z-1234", None, 5])
def test_only_a_run_folders_own_name_is_accepted(tmp_path, run_id):
    save(tmp_path / "runs", "2026-11-27_10-00-00Z", result())
    save(tmp_path / "runs", "notes", result())
    (tmp_path / "results.json").write_text(json.dumps(result("outside")))
    assert History(tmp_path / "runs").read(run_id) is None


def test_a_link_out_of_the_runs_folder_is_followed_only_by_its_run_name(tmp_path):
    # a folder the operator linked in is theirs; what matters is that no request can name
    # a path of its own
    outside = tmp_path / "elsewhere"
    save(outside, "x", result("Linked"))
    runs = tmp_path / "runs"
    runs.mkdir()
    os.symlink(outside / "x", runs / "2026-11-27_10-00-00Z")
    assert History(runs).read("2026-11-27_10-00-00Z")["result"]["run"]["move_name"] == "Linked"


def test_the_runner_reads_its_own_runs_folder(tmp_path):
    save(tmp_path, "2026-11-27_10-00-00Z", result())
    runner = Runner(runs_dir=tmp_path)
    assert [line["id"] for line in runner.history.list()] == ["2026-11-27_10-00-00Z"]


# ── the routes ─────────────────────────────────────────────────────────


@pytest.fixture
async def client(tmp_path):
    runner = SimpleNamespace(history=History(tmp_path))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(create_app(runner)),
                                 base_url="http://localhost") as c:
        yield c


async def test_the_list_route(client, tmp_path):
    got = await client.get("/api/runs")
    assert (got.status_code, got.json()) == (200, {"runs": [], "runs_dir": str(tmp_path)})
    assert got.headers["cache-control"] == "no-store"
    save(tmp_path, "2026-11-27_10-00-00Z", result("Move A"))
    got = await client.get("/api/runs")
    assert [line["move_name"] for line in got.json()["runs"]] == ["Move A"]
    assert "series" not in got.text


async def test_the_one_result_route_leaves_the_samples_in_the_file(client, tmp_path):
    save(tmp_path, "2026-11-27_10-00-00Z", result("Move A"))
    got = await client.get("/api/runs/2026-11-27_10-00-00Z")
    assert got.status_code == 200
    assert got.headers["cache-control"] == "no-store"
    body = got.json()
    assert body["id"] == "2026-11-27_10-00-00Z"
    assert body["run_dir"] == str(tmp_path / "2026-11-27_10-00-00Z")
    expected = result("Move A")
    del expected["series"]
    assert body["result"] == expected


@pytest.mark.parametrize("run_id", ["2026-11-27_11-11-11Z", "notes", "..%2F..%2Fetc", "a/b",
                                    "%2E%2E", "2026-11-27_10-00-00Z%2Fresults.json",
                                    "2026-11-27_10-00-00Z/"])
async def test_an_unknown_result_is_a_404_in_plain_words(client, tmp_path, run_id):
    save(tmp_path, "2026-11-27_10-00-00Z", result())
    save(tmp_path, "notes", result())
    got = await client.get(f"/api/runs/{run_id}")
    assert got.status_code == 404
    assert got.json() == {"code": "no_such_result",
                          "message": "That result is not in the runs folder any more."}
    assert got.headers["cache-control"] == "no-store"


async def test_previous_results_are_behind_the_sign_in(tmp_path):
    from loadtest.web.signin import SignIn
    save(tmp_path, "2026-11-27_10-00-00Z", result())
    runner = SimpleNamespace(history=History(tmp_path))
    app = create_app(runner, allowed_hosts=["10.0.0.5"], sign_in=SignIn("admin", "a-pass-77"))
    transport = httpx.ASGITransport(app, client=("10.0.0.9", 5555))
    async with httpx.AsyncClient(transport=transport, base_url="http://10.0.0.5:8795") as c:
        for path in ("/api/runs", "/api/runs/2026-11-27_10-00-00Z"):
            got = await c.get(path)
            assert got.status_code == 401, path
            assert "Move A" not in got.text
