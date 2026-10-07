"""The first admin through the API: create, the defaults' policy hint,
PUT …/first-admin before it's used, and the first deploy's step 11. The
password never reaches a response or an audit row."""

import uuid

import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import pipeline

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_runner,
    leak_guard,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import LS, SHA

URL = "/api/deploy/environments"
TYPED = "Correct-Horse-Battery-9"
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": TYPED}
NEW = {"mode": "new", "name": "fresh", "type": "custom", "target": "ssh",
       "proxy_ip": "10.10.48.6", "publish": False}


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_create_stores_it_and_never_echoes_the_password(client, db, target, leak_guard):
    leak_guard.append(TYPED)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "first_admin": ADMIN})
    assert resp.status_code == 201, resp.text
    assert resp.json()["first_admin"] == {"first_name": "Ada", "last_name": "Lovelace",
                                          "email": "ada@test.example.com",
                                          "password_mode": "typed", "done": False}
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert audit["first_admin"] == {"email": "ada@test.example.com", "password_mode": "typed"}
    got = await client.get(f"{URL}/fresh", headers=h)
    assert got.json()["first_admin"]["email"] == "ada@test.example.com"
    assert TYPED not in got.text


async def test_create_without_one_has_none(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json=NEW)
    assert resp.json()["first_admin"] is None
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert "first_admin" not in audit


@pytest.mark.parametrize("change, expected", [
    ({"password": "short"}, (422, "first_admin_password_too_short")),
    ({"email": "nope"}, (422, "first_admin_email_invalid")),
    ({"password_mode": "invite"}, (422, "first_admin_password_not_allowed")),
])
async def test_create_refusals(client, db, target, change, expected):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "first_admin": {**ADMIN, **change}})
    assert _code(resp) == expected
    if expected[1] == "first_admin_password_too_short":
        assert resp.json()["detail"]["min_length"] == 8
    assert TYPED not in resp.text
    assert (await client.get(f"{URL}/fresh", headers=h)).status_code == 404


async def test_not_with_a_seed_nor_on_adopt(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, "snapshot_id": str(uuid.uuid4()),
                                                   "first_admin": ADMIN})
    assert _code(resp) == (422, "first_admin_with_seed")
    resp = await client.post(URL, headers=h, json={"mode": "adopt", "name": "x",
                                                   "type": "custom", "target": "ssh",
                                                   "first_admin": ADMIN})
    assert _code(resp) == (422, "first_admin_not_allowed")


async def test_defaults_carry_the_policy_hint(client, db):
    h = await auth_headers(client, db)
    resp = await client.get("/api/deploy/environment-defaults", headers=h)
    assert resp.json()["first_admin"] == {"password_min_length": 8, "role": "super_admin",
                                          "link_minutes": 240}


async def test_put_needs_deploy_change(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "first_admin": ADMIN})
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    resp = await client.put(f"{URL}/fresh/first-admin", headers=admin, json=ADMIN)
    assert _code(resp) == (403, "forbidden")


async def test_put_replaces_it_until_done(client, db, target, leak_guard):
    leak_guard.append(TYPED)
    h = await auth_headers(client, db)
    assert _code(await client.put(f"{URL}/fresh/first-admin", headers=h, json=ADMIN)) == (
        404, "environment_not_found")
    await client.post(URL, headers=h, json=NEW)
    assert _code(await client.put(f"{URL}/fresh/first-admin", headers=h, json=ADMIN)) == (
        404, "first_admin_not_set")
    await client.post(URL, headers=h, json={**NEW, "name": "fresh2", "first_admin": ADMIN})
    bad = await client.put(f"{URL}/fresh2/first-admin", headers=h,
                           json={**ADMIN, "password": "short"})
    assert _code(bad) == (422, "first_admin_password_too_short")
    assert bad.json()["detail"]["min_length"] == 8
    resp = await client.put(f"{URL}/fresh2/first-admin", headers=h,
                            json={**ADMIN, "password_mode": "invite", "password": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["first_admin"]["password_mode"] == "invite"
    assert await _audits(db, "deploy.first_admin_set") == [{
        "environment": "fresh2", "email": "ada@test.example.com", "password_mode": "invite"}]
    from sirdar_api.deploy import first_admins
    from sirdar_api.deploy.environments import get_by_name
    env = await get_by_name(db, "fresh2")
    await first_admins.mark_done(db, env.id)
    await db.commit()
    assert _code(await client.put(f"{URL}/fresh2/first-admin", headers=h, json=ADMIN)) == (
        409, "first_admin_done")
    assert len(await _audits(db, "deploy.first_admin_set")) == 1


async def test_put_waits_for_a_running_deployment(client, db, target):
    """A PUT during step 11 would be lost: the account made with the old
    email or password, the record marked done for the new one."""
    from sirdar_api.db.models import Deployment
    from sirdar_api.deploy.environments import get_by_name
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "first_admin": ADMIN})
    env = await get_by_name(db, "fresh")
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running", start_step=1, first_admin=True))
    await db.commit()
    resp = await client.put(f"{URL}/fresh/first-admin", headers=h,
                            json={**ADMIN, "password_mode": "invite", "password": None})
    assert _code(resp) == (409, "deploy_in_progress")
    got = (await client.get(f"{URL}/fresh", headers=h)).json()
    assert got["first_admin"]["password_mode"] == "typed"
    assert await _audits(db, "deploy.first_admin_set") == []


async def _first_deploy(client, db, target, fake_runner, h, admin_rc: str) -> dict:
    from sirdar_api.deploy.runner import RunResult
    fake_runner.results["first_admin"] = RunResult(status="successful", rc=0,
                                                   data={"first_admin_rc": admin_rc})
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    await client.post(URL, headers=h, json={**NEW, "first_admin": ADMIN})
    resp = await client.post(f"{URL}/fresh/deployments", headers=h, json={"mode": "update"})
    assert resp.status_code == 201, resp.text
    await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp.json()


async def test_the_first_deploy_runs_step_11_and_a_later_one_does_not(
        client, db, target, fake_runner):
    h = await auth_headers(client, db)
    first = await _first_deploy(client, db, target, fake_runner, h, "0")
    assert first["first_admin"] is True
    assert "first_admin" in [s["key"] for s in first["steps"]]
    starts = await _audits(db, "deploy.deployment_start")
    assert starts[0]["first_admin"] is True
    again = await client.post(f"{URL}/fresh/deployments", headers=h, json={"mode": "update"})
    assert again.json()["first_admin"] is False
    assert "first_admin" not in [s["key"] for s in again.json()["steps"]]
    assert "first_admin" not in (await _audits(db, "deploy.deployment_start"))[1]


async def test_a_retry_after_a_refusal_runs_step_11_again(client, db, target, fake_runner,
                                                          leak_guard):
    leak_guard.append(TYPED)
    h = await auth_headers(client, db)
    first = await _first_deploy(client, db, target, fake_runner, h, "3")
    got = (await client.get(f"/api/deploy/deployments/{first['id']}", headers=h)).json()
    assert (got["status"], got["failed_step"]) == ("failed", 11)
    new_password = "Another-Horse-Battery-7"
    leak_guard.append(new_password)
    resp = await client.put(f"{URL}/fresh/first-admin", headers=h,
                            json={**ADMIN, "password": new_password})
    assert resp.status_code == 200, resp.text
    fake_runner.results.pop("first_admin")
    from sirdar_api.deploy.runner import RunResult
    fake_runner.results["first_admin"] = RunResult(status="successful", rc=0,
                                                   data={"first_admin_rc": "0"})
    resp = await client.post(f"/api/deploy/deployments/{first['id']}/retry", headers=h,
                             json={})
    assert resp.status_code == 201, resp.text
    second = resp.json()
    assert (second["start_step"], second["first_admin"]) == (11, True)
    assert "first_admin" in [s["key"] for s in second["steps"]]
    await pipeline.wait(uuid.UUID(second["id"]))
    env = (await client.get(f"{URL}/fresh", headers=h)).json()
    assert env["first_admin"]["done"] is True


async def test_a_retry_once_the_admin_is_done_has_no_step_11(client, db, target, fake_runner):
    h = await auth_headers(client, db)
    first = await _first_deploy(client, db, target, fake_runner, h, "3")
    from sirdar_api.deploy import first_admins
    from sirdar_api.deploy.environments import get_by_name
    env = await get_by_name(db, "fresh")
    await first_admins.mark_done(db, env.id)       # made in the environment by hand
    await db.commit()
    retry = f"/api/deploy/deployments/{first['id']}/retry"
    # From step 11: nothing is left after it, so there is nothing to retry (not a 500).
    resp = await client.post(retry, headers=h, json={})
    assert _code(resp) == (409, "not_retryable")
    resp = await client.post(retry, headers=h, json={"from_step": 11})
    assert _code(resp) == (409, "not_retryable")
    resp = await client.post(retry, headers=h, json={"from_step": 10})
    assert resp.status_code == 201, resp.text
    assert (resp.json()["start_step"], resp.json()["first_admin"]) == (10, False)
    assert "first_admin" not in [s["key"] for s in resp.json()["steps"]]
