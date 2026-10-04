"""Backups, Restore backup, Roll back and the retry rules of the new modes (phase 3)."""

import uuid

from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import Snapshot
from sirdar_api.deploy import environments, snapshots
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import OLD, _headers_without_change
from .test_deploy_snapshots_api import (  # noqa: F401
    PEPPER,
    SNAPSHOTS,
    START,
    TOTP,
    _audits,
    _finish,
    _ready_snapshot,
    ready,
)

BACKUP = "20261004T010203Z.dump"


async def test_rollback_needs_change(client, db, ready, leak_guard):
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.post(f"/api/deploy/deployments/{uuid.uuid4()}/rollback", headers=admin,
                             json={})
    assert resp.status_code == 403


async def test_backups_listing(client, db, ready, ssh_server, leak_guard):
    ssh_server.overrides[environments.backups_command("uat")] = (
        "20261003T120000Z.dump\t1048576\t1759492800.5\n"
        f"{BACKUP}\t2097152\t1759539723.0\n"
        "notes.txt\t10\t1759539723.0\n"
        "20261004T999999Z.dump.partial\t5\t1\n")
    h = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.get("/api/deploy/environments/uat/backups", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"backups": [
        {"name": BACKUP, "size_bytes": 2097152, "modified_at": "2025-10-04T01:02:03+00:00"},
        {"name": "20261003T120000Z.dump", "size_bytes": 1048576,
         "modified_at": "2025-10-03T12:00:00.500000+00:00"}]}


async def test_backups_on_an_untrusted_host(client, db, deploy_env, ssh_server, snapshots_dir,
                                            leak_guard):
    _ssh_env(deploy_env, ssh_server)
    await make_environment(db)
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/environments/uat/backups", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "host_key_unknown"


async def test_restore_a_backup(client, db, ready, fake_runner, leak_guard):
    adder = await _headers_without_change(client, db)
    body = {"mode": "restore_dump", "backup": BACKUP, "confirm_name": "uat"}
    resp = await client.post(START, headers=adder, json=body)
    assert resp.status_code == 403
    h = await auth_headers(client, db)
    for bad, code in (({**body, "confirm_name": "UAT"}, "confirm_name_mismatch"),
                      ({**body, "backup": "../.env"}, "backup_invalid"),
                      ({"mode": "restore_dump", "confirm_name": "uat"}, "backup_invalid"),
                      ({"mode": "update", "backup": BACKUP}, "backup_invalid")):
        resp = await client.post(START, headers=h, json=bad)
        assert (resp.status_code, resp.json()) == (422, {"detail": {"code": code}}), bad
    resp = await client.post(START, headers=h, json=body)
    assert resp.status_code == 201, resp.text
    dep = resp.json()
    assert (dep["mode"], dep["sha"], dep["restore_dump"]) == ("restore_dump", OLD, BACKUP)
    assert [s["key"] for s in dep["steps"]] == ["preflight", "data", "restore_dump", "up"]
    await _finish(dep)
    request = next(r for r in fake_runner.requests if r.step == "restore_dump")
    assert request.extravars["dump_name"] == BACKUP
    assert await _audits(db, "deploy.deployment_start") == [
        {"environment": "uat", "mode": "restore_dump", "git_ref": OLD, "sha": OLD,
         "backup": BACKUP}]


async def test_restore_needs_a_deployed_environment(client, db, ready, leak_guard):
    await make_environment(db, name="fresh")
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/fresh/deployments", headers=h,
                             json={"mode": "restore_dump", "backup": BACKUP,
                                   "confirm_name": "fresh"})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_deployed"}})


async def test_roll_back_a_failed_update(client, db, ready, fake_runner, leak_guard):
    fake_runner.results["dump"] = RunResult(
        status="successful", rc=0, data={"dump_path": f"/opt/serversherpa/uat/backups/{BACKUP}"})
    fake_runner.results["up"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    failed = (await client.post(START, headers=h, json={})).json()
    await _finish(failed)
    got = (await client.get(f"/api/deploy/deployments/{failed['id']}", headers=h)).json()
    assert (got["status"], got["failed_step"], got["rollback_available"]) == ("failed", 10, True)

    url = f"/api/deploy/deployments/{failed['id']}/rollback"
    resp = await client.post(url, headers=h, json={"confirm_name": "nope"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "confirm_name_mismatch"}})
    fake_runner.results.pop("up")
    resp = await client.post(url, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    back = resp.json()
    assert (back["mode"], back["sha"], back["git_ref"], back["restore_dump"]) == (
        "rollback", OLD, OLD, BACKUP)
    assert [s["key"] for s in back["steps"]] == ["preflight", "fetch", "render", "build",
                                                 "data", "restore_dump", "up"]
    await _finish(back)
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert (env["status"], env["current_sha"]) == ("ready", OLD)
    again = await client.post(url, headers=h, json={"confirm_name": "uat"})
    assert (again.status_code, again.json()) == (409, {"detail": {"code": "rollback_not_latest"}})
    assert await _audits(db, "deploy.deployment_rollback") == [
        {"environment": "uat", "mode": "rollback", "git_ref": OLD, "sha": OLD,
         "backup": BACKUP}]


async def test_no_rollback_without_a_dump(client, db, ready, fake_runner, leak_guard):
    fake_runner.results["build"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    failed = (await client.post(START, headers=h, json={})).json()
    await _finish(failed)
    got = (await client.get(f"/api/deploy/deployments/{failed['id']}", headers=h)).json()
    assert got["rollback_available"] is False
    resp = await client.post(f"/api/deploy/deployments/{failed['id']}/rollback", headers=h,
                             json={"confirm_name": "uat"})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "rollback_unavailable"}})


async def test_retry_rules_for_the_new_modes(client, db, ready, fake_runner, tmp_path,
                                             leak_guard):
    fake_runner.results["restore_dump"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    dep = (await client.post(START, headers=h, json={
        "mode": "restore_dump", "backup": BACKUP, "confirm_name": "uat"})).json()
    await _finish(dep)
    retry = f"/api/deploy/deployments/{dep['id']}/retry"
    resp = await client.post(retry, headers=h, json={})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "confirm_name_mismatch"}})
    fake_runner.results.pop("restore_dump")
    resp = await client.post(retry, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    again = resp.json()
    assert (again["start_step"], again["restore_dump"]) == (9, BACKUP)
    await _finish(again)

    resp = await client.post("/api/deploy/environments/uat/snapshots", headers=h,
                             json={"name": "never-arrives"})
    job = resp.json()["deployment"]
    await _finish(job)                         # no bundle arrives: the job fails
    resp = await client.post(f"/api/deploy/deployments/{job['id']}/retry", headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_retryable"}})


async def _failed_reset_with_a_snapshot(client, db, h, fake_runner, tmp_path, failing: str):
    """A Reset with a snapshot that fails at `failing`; then the snapshot is deleted
    (its deployment's snapshot_id becomes NULL)."""
    snap = await _ready_snapshot(client, h, tmp_path)
    fake_runner.results[failing] = RunResult(status="failed", rc=1)
    dep = (await client.post(START, headers=h, json={
        "mode": "reset", "confirm_name": "uat", "snapshot_id": snap["id"]})).json()
    await _finish(dep)
    fake_runner.results.pop(failing)
    resp = await client.delete(f"{SNAPSHOTS}/{snap['id']}", headers=h)
    assert resp.status_code == 204, resp.text
    return dep


async def test_retry_of_a_restore_whose_snapshot_is_gone(client, db, ready, fake_runner,
                                                         tmp_path, leak_guard):
    """Not a plain Reset in disguise, and not from_step_invalid: snapshot_not_found."""
    leak_guard += [PEPPER, TOTP]
    h = await auth_headers(client, db)
    dep = await _failed_reset_with_a_snapshot(client, db, h, fake_runner, tmp_path, "restore")
    retry = f"/api/deploy/deployments/{dep['id']}/retry"
    for body in ({"confirm_name": "uat"}, {"confirm_name": "uat", "from_step": 9},
                 {"confirm_name": "uat", "from_step": 8}, {"confirm_name": "uat", "from_step": 1}):
        resp = await client.post(retry, headers=h, json=body)
        assert (resp.status_code, resp.json()) == (
            404, {"detail": {"code": "snapshot_not_found"}}), body
    assert await _audits(db, "deploy.deployment_retry") == []


async def test_retry_after_the_restore_succeeded_needs_no_snapshot(
        client, db, ready, fake_runner, tmp_path, leak_guard):
    """Failed at Start services (10): the restore is done, so a retry from 10
    runs without the deleted snapshot; from 9 or earlier it can't."""
    leak_guard += [PEPPER, TOTP]
    h = await auth_headers(client, db)
    dep = await _failed_reset_with_a_snapshot(client, db, h, fake_runner, tmp_path, "up")
    retry = f"/api/deploy/deployments/{dep['id']}/retry"
    resp = await client.post(retry, headers=h, json={"confirm_name": "uat", "from_step": 9})
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "snapshot_not_found"}})
    before = len(fake_runner.requests)
    resp = await client.post(retry, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    again = resp.json()
    assert (again["start_step"], again["snapshot"]) == (10, None)
    await _finish(again)
    got = (await client.get(f"/api/deploy/deployments/{again['id']}", headers=h)).json()
    assert got["status"] == "succeeded"
    assert [r.step for r in fake_runner.requests[before:]] == ["up"]


async def test_upload_aborted_by_the_client(client, db, ready, leak_guard):
    """A client that goes away mid-upload gets a quiet 400, and nothing is kept."""
    from sirdar_api.api.app import create_app

    h = await auth_headers(client, db)
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": SNAPSHOTS, "raw_path": SNAPSHOTS.encode(), "root_path": "",
        "query_string": b"name=half-way", "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/gzip"),
                    (b"authorization", h["Authorization"].encode())],
    }
    incoming = iter([{"type": "http.request", "body": b"\x1f\x8b" + b"x" * 1000,
                      "more_body": True},
                     {"type": "http.disconnect"}])

    async def receive():
        return next(incoming, {"type": "http.disconnect"})

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    await create_app()(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    assert (start["status"], body) == (400, b'{"detail":{"code":"upload_aborted"}}')
    assert list(snapshots.incoming_dir(get_settings()).iterdir()) == []
    assert await db.scalar(select(Snapshot.id)) is None
    assert await _audits(db, "deploy.snapshot_upload") == []
