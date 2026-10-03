import asyncio
import uuid

import pytest
from sqlalchemy import delete, select

from sirdar_api.api.routes import deploy as deploy_routes
from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, PermissionOverride, SshKnownHost, User
from sirdar_api.deploy import environments, pipeline, steps
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers

from .deploy_factories import (  # noqa: F401
    ENV_SECRETS, fake_runner, leak_guard, make_environment, secrets_key, stop_pipeline,
    trust_fake,
)
from .ssh_server import SSH_PASSWORD, ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401

START = "/api/deploy/environments/uat/deployments"
LS = "git ls-remote https://github.com/encondata/BaseCampV3.git"
SHA = "e73b99ca" + "2" * 32
OLD = "a" * 40
UPDATE_KEYS = ["preflight", "bootstrap", "fetch", "render", "build", "dump", "up"]
RESET_KEYS = ["preflight", "bootstrap", "fetch", "render", "build", "reset", "up"]


@pytest.fixture
async def ready(db, deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    await trust_fake(db, ssh_server)
    ssh_server.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    return await make_environment(db, current_sha=OLD)


async def _headers_without_change(client, db) -> dict:
    """A developer with deploy:change denied by an override (add still allowed)."""
    h = await auth_headers(client, db, email="adder@test.example.com", roles=("developer",))
    user = await db.scalar(select(User).where(User.email == "adder@test.example.com"))
    db.add(PermissionOverride(person_id=user.person_id, resource="deploy", action="change",
                              allow=False))
    await db.commit()
    return h


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def _finish(body: dict) -> None:
    await pipeline.wait(uuid.UUID(body["id"]))


async def test_update_deploy_end_to_end(client, db, ready, fake_runner, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["environment"], body["mode"], body["git_ref"], body["sha"], body["status"],
            body["previous_sha"], body["start_step"]) == (
        "uat", "update", "main", SHA, "running", OLD, 1)
    assert [s["key"] for s in body["steps"]] == UPDATE_KEYS
    await _finish(body)

    got = (await client.get(f"/api/deploy/deployments/{body['id']}", headers=h)).json()
    assert (got["status"], got["actor_name"], got["error"]) == ("succeeded", "Boss User", None)
    assert got["finished_at"] is not None
    first = got["steps"][0]
    assert (first["status"], first["log_tail"], first["log_size"]) == (
        "succeeded", "ok: [target] preflight\n", len("ok: [target] preflight\n"))
    short = (await client.get(f"/api/deploy/deployments/{body['id']}?tail=5",
                              headers=h)).json()
    assert short["steps"][0]["log_tail"] == "ight\n"
    none = (await client.get(f"/api/deploy/deployments/{body['id']}?tail=0", headers=h)).json()
    assert none["steps"][0]["log_tail"] == ""

    listed = (await client.get(START, headers=h)).json()["deployments"]
    assert [d["id"] for d in listed] == [body["id"]]
    assert "steps" not in listed[0]
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert (env["status"], env["current_sha"], env["image_tag"]) == ("ready", SHA, "e73b99ca")
    assert env["last_deployment"]["id"] == body["id"]
    assert await _audits(db, "deploy.deployment_start") == [
        {"environment": "uat", "mode": "update", "git_ref": "main", "sha": SHA}]


async def test_permissions(client, db, ready, fake_runner, leak_guard):
    assert (await client.get(START)).status_code == 401
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(START, headers=admin)).json() == {"deployments": []}
    some = uuid.uuid4()
    for url in (START, f"/api/deploy/deployments/{some}/cancel",
                f"/api/deploy/deployments/{some}/retry"):
        resp = await client.post(url, headers=admin, json={})
        assert resp.status_code == 403, url
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_reset_needs_change_and_the_typed_name(client, db, ready, fake_runner,
                                                     leak_guard):
    adder = await _headers_without_change(client, db)
    resp = await client.post(START, headers=adder, json={"mode": "reset", "confirm_name": "uat"})
    assert (resp.status_code, resp.json()) == (403, {"detail": {"code": "forbidden"}})
    resp = await client.post(START, headers=adder, json={})
    assert resp.status_code == 201, resp.text            # Update needs only add
    await _finish(resp.json())

    h = await auth_headers(client, db)
    for confirm in (None, "UAT", "uat "):
        resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": confirm})
        assert (resp.status_code, resp.json()) == (422, {"detail": {
            "code": "confirm_name_mismatch"}})
    resp = await client.post(START, headers=h, json={"mode": "reset", "confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["mode"] == "reset"
    assert [s["key"] for s in body["steps"]] == RESET_KEYS
    await _finish(body)
    resp = await client.post(f"/api/deploy/deployments/{body['id']}/cancel", headers=adder)
    assert resp.status_code == 403


async def test_lock_and_cancel(client, db, ready, fake_runner, leak_guard):
    fake_runner.gates["preflight"] = asyncio.Event()
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await asyncio.wait_for(fake_runner.started["preflight"].wait(), 5)

    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "deploy_in_progress"}})
    resp = await client.patch("/api/deploy/environments/uat", headers=h, json={"keep_dumps": 3})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "deploy_in_progress"}})

    resp = await client.post(f"/api/deploy/deployments/{first['id']}/cancel", headers=h)
    assert (resp.status_code, resp.json()) == (202, {"id": first["id"], "status": "cancelling"})
    await _finish(first)
    got = (await client.get(f"/api/deploy/deployments/{first['id']}", headers=h)).json()
    assert (got["status"], got["error"]) == ("cancelled", "Cancelled.")
    assert [s["status"] for s in got["steps"]] == ["cancelled"] + ["not_run"] * 6
    resp = await client.post(f"/api/deploy/deployments/{first['id']}/cancel", headers=h)
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_running"}})
    assert await _audits(db, "deploy.deployment_cancel") == [
        {"environment": "uat", "mode": "update", "sha": SHA}]


async def test_cancel_without_a_task_closes_the_record(client, db, ready, leak_guard):
    dep = await pipeline.create_deployment(db, ready, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None)
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(f"/api/deploy/deployments/{dep.id}/cancel", headers=h)
    assert (resp.status_code, resp.json()) == (202, {"id": str(dep.id), "status": "cancelled"})
    got = (await client.get(f"/api/deploy/deployments/{dep.id}", headers=h)).json()
    assert got["status"] == "cancelled"


async def test_retry_from_the_failed_step(client, db, ready, fake_runner, leak_guard):
    fake_runner.results["build"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await _finish(first)
    got = (await client.get(f"/api/deploy/deployments/{first['id']}", headers=h)).json()
    assert (got["status"], got["failed_step"], got["error"]) == (
        "failed", 5, "Step 5 (Build images) failed. See its log.")

    retry = f"/api/deploy/deployments/{first['id']}/retry"
    for payload in ({"from_step": 6}, {"from_step": 7}, {"from_step": 0}):
        resp = await client.post(retry, headers=h, json=payload)
        assert resp.status_code == 422, payload

    del fake_runner.results["build"]
    fake_runner.requests.clear()
    resp = await client.post(retry, headers=h, json={})
    assert resp.status_code == 201, resp.text
    second = resp.json()
    assert (second["start_step"], second["retry_of"], second["sha"], second["mode"]) == (
        5, first["id"], SHA, "update")
    await _finish(second)
    assert fake_runner.steps() == ["build", "dump", "up"]
    got = (await client.get(f"/api/deploy/deployments/{second['id']}", headers=h)).json()
    assert got["status"] == "succeeded"
    assert [s["status"] for s in got["steps"]] == ["skipped"] * 4 + ["succeeded"] * 3

    resp = await client.post(retry, headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "retry_not_latest"}})
    resp = await client.post(f"/api/deploy/deployments/{second['id']}/retry", headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "not_retryable"}})
    assert await _audits(db, "deploy.deployment_retry") == [{
        "environment": "uat", "mode": "update", "git_ref": "main", "sha": SHA,
        "retry_of": first["id"], "from_step": 5}]


async def test_ref_errors_and_a_full_sha(client, db, ready, ssh_server, fake_runner, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"git_ref": "a..b"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "ref_invalid"}})
    ssh_server.overrides[f"{LS} nope"] = ""
    resp = await client.post(START, headers=h, json={"git_ref": "nope"})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "ref_not_found"}})
    ssh_server.overrides[f"{LS} gone"] = ""
    ssh_server.exits[f"{LS} gone"] = 127
    resp = await client.post(START, headers=h, json={"git_ref": "gone"})
    assert resp.status_code == 502
    assert resp.json()["detail"]["code"] == "git_missing"
    assert "git" in resp.json()["detail"]["reason"]

    full = "b" * 40
    resp = await client.post(START, headers=h, json={"git_ref": full})
    assert resp.status_code == 201, resp.text
    assert resp.json()["sha"] == full
    assert not any(c.startswith(LS) and full in c for c in ssh_server.commands)
    await _finish(resp.json())


async def test_untrusted_host_is_409_with_the_connect_shape(client, db, ready, ssh_server,
                                                            leak_guard):
    await db.execute(delete(SshKnownHost))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={})
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "host_key_unknown", "host": "127.0.0.1",
                                     "port": ssh_server.port, "key_type": "ssh-ed25519",
                                     "fingerprint": ssh_server.fingerprint}


async def test_preconditions(client, db, ready, monkeypatch, secrets_key, leak_guard):
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/nope/deployments", headers=h, json={})
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "environment_not_found"}})
    resp = await client.get(f"/api/deploy/deployments/{uuid.uuid4()}", headers=h)
    assert (resp.status_code, resp.json()) == (404, {"detail": {"code": "deployment_not_found"}})
    assert (await client.get("/api/deploy/deployments/not-a-uuid", headers=h)).status_code == 422
    resp = await client.get(f"/api/deploy/deployments/{uuid.uuid4()}?tail=-1", headers=h)
    assert resp.status_code == 422
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", "")
    get_settings.cache_clear()
    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()) == (400, {"detail": {"code": "secrets_key_missing"}})
    monkeypatch.setenv("SIRDAR_SECRETS_KEY", secrets_key)    # the leak guard reads with it
    get_settings.cache_clear()


# ---- cross-task requirements (Task 8 review) and the leak guard ------------------

async def test_logs_that_mention_secrets_come_back_redacted(client, db, ready, fake_runner,
                                                            leak_guard):
    fake_runner.output["preflight"] = [
        f"password={ENV_SECRETS['POSTGRES_PASSWORD']}\n", f"ssh {SSH_PASSWORD}\n"]
    h = await auth_headers(client, db)
    body = (await client.post(START, headers=h, json={})).json()
    await _finish(body)
    got = (await client.get(f"/api/deploy/deployments/{body['id']}", headers=h)).json()
    assert got["steps"][0]["log_tail"] == "password=[redacted]\nssh [redacted]\n"
    assert (await client.get(START, headers=h)).status_code == 200
    env = (await client.get("/api/deploy/environments/uat", headers=h)).json()
    assert env["last_deployment"]["id"] == body["id"]


async def test_lock_race_answers_409_not_500(client, db, ready, fake_runner, monkeypatch,
                                             leak_guard):
    """The pre-check passes but the partial unique index fires: DeployInProgress → 409."""
    fake_runner.gates["preflight"] = asyncio.Event()
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await asyncio.wait_for(fake_runner.started["preflight"].wait(), 5)

    async def never(db, env_id):
        return False

    monkeypatch.setattr(environments, "is_deploying", never)
    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "deploy_in_progress"}})
    assert await _audits(db, "deploy.deployment_start") == [
        {"environment": "uat", "mode": "update", "git_ref": "main", "sha": SHA}]
    fake_runner.gates["preflight"].set()
    await _finish(first)


async def test_start_step_the_pipeline_rejects_is_422_not_500(client, db, ready, fake_runner,
                                                              monkeypatch, leak_guard):
    """If the route's plan check and create_deployment ever disagree, the ValueError
    becomes 422 invalid_start_step and nothing is audited."""
    fake_runner.results["up"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await _finish(first)
    retry = f"/api/deploy/deployments/{first['id']}/retry"
    resp = await client.post(retry, headers=h, json={"from_step": 7})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "from_step_invalid"}})

    monkeypatch.setattr(deploy_routes, "plan_for", lambda mode: steps.plan_for("reset"))
    resp = await client.post(retry, headers=h, json={"from_step": 7})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "invalid_start_step"}})
    assert await _audits(db, "deploy.deployment_retry") == []
    listed = (await client.get(START, headers=h)).json()["deployments"]
    assert [d["id"] for d in listed] == [first["id"]]


async def test_retry_a_cancelled_deployment(client, db, ready, fake_runner, leak_guard):
    """No failed_step: the stopping point is the cancelled step."""
    fake_runner.gates["fetch"] = asyncio.Event()
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={})).json()
    await asyncio.wait_for(fake_runner.started["fetch"].wait(), 5)
    await client.post(f"/api/deploy/deployments/{first['id']}/cancel", headers=h)
    await _finish(first)
    got = (await client.get(f"/api/deploy/deployments/{first['id']}", headers=h)).json()
    assert (got["status"], got["failed_step"]) == ("cancelled", None)

    retry = f"/api/deploy/deployments/{first['id']}/retry"
    resp = await client.post(retry, headers=h, json={"from_step": 4})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "from_step_invalid"}})
    del fake_runner.gates["fetch"]
    fake_runner.requests.clear()
    resp = await client.post(retry, headers=h, json={"from_step": 2})
    assert resp.status_code == 201, resp.text
    second = resp.json()
    assert (second["start_step"], second["retry_of"]) == (2, first["id"])
    await _finish(second)
    assert fake_runner.steps() == ["bootstrap", "fetch", "render", "build", "dump", "up"]


async def test_retry_an_interrupted_deployment_with_no_stopped_step(client, db, ready,
                                                                    fake_runner, leak_guard):
    """Interrupted before any step ran (no running step, no failed_step): the stopping
    point is the first not_run step."""
    dep = await pipeline.create_deployment(db, ready, mode="update", git_ref="main", sha=SHA,
                                           actor_id=None, start_step=3)
    await db.commit()
    assert await pipeline.recover_orphans() == 1
    h = await auth_headers(client, db)
    got = (await client.get(f"/api/deploy/deployments/{dep.id}", headers=h)).json()
    assert (got["status"], got["failed_step"]) == ("interrupted", None)
    assert [s["status"] for s in got["steps"]] == ["skipped"] * 2 + ["not_run"] * 5

    retry = f"/api/deploy/deployments/{dep.id}/retry"
    resp = await client.post(retry, headers=h, json={"from_step": 4})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "from_step_invalid"}})
    fake_runner.requests.clear()
    resp = await client.post(retry, headers=h, json={})
    assert resp.status_code == 201, resp.text
    assert resp.json()["start_step"] == 3
    await _finish(resp.json())
    assert fake_runner.steps() == ["fetch", "render", "build", "dump", "up"]


async def test_retry_a_reset_needs_change_and_the_typed_name(client, db, ready, fake_runner,
                                                             leak_guard):
    fake_runner.results["reset"] = RunResult(status="failed", rc=1)
    h = await auth_headers(client, db)
    first = (await client.post(START, headers=h, json={"mode": "reset",
                                                       "confirm_name": "uat"})).json()
    await _finish(first)
    retry = f"/api/deploy/deployments/{first['id']}/retry"
    adder = await _headers_without_change(client, db)
    resp = await client.post(retry, headers=adder, json={"confirm_name": "uat"})
    assert (resp.status_code, resp.json()) == (403, {"detail": {"code": "forbidden"}})
    resp = await client.post(retry, headers=h, json={})
    assert (resp.status_code, resp.json()) == (422, {"detail": {"code": "confirm_name_mismatch"}})
    del fake_runner.results["reset"]
    resp = await client.post(retry, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    assert (resp.json()["mode"], resp.json()["start_step"]) == ("reset", 7)
    await _finish(resp.json())
    assert await _audits(db, "deploy.deployment_retry") == [{
        "environment": "uat", "mode": "reset", "git_ref": "main", "sha": SHA,
        "retry_of": first["id"], "from_step": 7}]
