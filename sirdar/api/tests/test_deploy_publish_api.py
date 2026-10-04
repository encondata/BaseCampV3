import asyncio
from datetime import datetime

import pytest

from sirdar_api.dashboard.service import _env_state
from sirdar_api.db.models import Environment, ManagedRecord
from sirdar_api.deploy import envfile, environments, publish
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_publisher,
    fake_runner,
    leak_guard,
    make_environment,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, configure
from .publish_helpers import PUBLIC_IP, managed, publish_fakes  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_deployments_api import (  # noqa: F401
    OLD,
    SHA,
    UPDATE_KEYS,
    _audits,
    _finish,
    _headers_without_change,
    ready,
)

ENV_URL = "/api/deploy/environments/uat"
START = f"{ENV_URL}/deployments"
PUBLISHED = ["dns", "proxy", "smoke"]


@pytest.fixture
def no_leaks(leak_guard):
    leak_guard.extend([CF_TOKEN, NPM_PASSWORD])
    return leak_guard


async def _publish_on(db, env) -> None:
    env.publish = True
    await db.commit()


async def test_permissions(client, db, ready, publish_fakes):
    viewer = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    assert (await client.get(f"{ENV_URL}/publish", headers=viewer)).status_code == 200
    for url, body in ((f"{ENV_URL}/publish/claim", None), (START, {"mode": "publish"}),
                      (START, {"mode": "teardown", "confirm_name": "uat"})):
        assert (await client.post(url, headers=viewer, json=body)).status_code == 403, url
    adder = await _headers_without_change(client, db)
    for url, body in ((f"{ENV_URL}/publish/claim", None),
                      (START, {"mode": "teardown", "confirm_name": "uat"})):
        assert (await client.post(url, headers=adder, json=body)).status_code == 403, url


async def test_publish_tab_and_claim(client, db, ready, publish_fakes, no_leaks):
    await configure(db)
    publish_fakes.cf.add("A", "api.uat.serversherpa.com", PUBLIC_IP)
    h = await auth_headers(client, db)
    state = (await client.get(f"{ENV_URL}/publish", headers=h)).json()
    assert state["services"][0]["dns"]["state"] == "claimable"
    assert state["cloudflare"]["configured"] and state["npm"]["configured"]
    resp = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert resp.status_code == 200
    assert resp.json()["claimed"] == ["dns:api.uat.serversherpa.com"]
    assert resp.json()["services"][0]["dns"]["origin"] == "claimed"
    assert await _audits(db, "deploy.publish_claim") == [
        {"environment": "uat", "claimed": ["dns:api.uat.serversherpa.com"]}]
    again = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert (again.status_code, again.json()["detail"]["code"]) == (409, "nothing_to_claim")
    env = (await client.get(ENV_URL, headers=h)).json()
    assert env["managed_records"] == [{"service": "api", "kind": "dns_record",
                                       "name": "api.uat.serversherpa.com", "origin": "claimed"}]


async def test_claim_waits_for_a_running_deployment(client, db, ready, publish_fakes,
                                                    monkeypatch):
    async def busy(db, env_id):
        return True
    monkeypatch.setattr(environments, "is_deploying", busy)
    h = await auth_headers(client, db)
    resp = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "deploy_in_progress")


async def test_publish_job(client, db, ready, fake_runner, fake_publisher, no_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"mode": "publish"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "publish_off")
    resp = await client.patch(ENV_URL, headers=h, json={"publish": True})
    assert resp.json()["publish"] is True
    resp = await client.post(START, headers=h, json={"mode": "publish"})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["cloudflare", "npm"]})
    await configure(db)
    resp = await client.post(START, headers=h, json={"mode": "publish", "git_ref": "main"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "git_ref_not_allowed")
    resp = await client.post(START, headers=h, json={"mode": "publish"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["sha"], body["start_step"], body["publish"]) == (
        "publish", OLD, 12, False)
    assert [s["key"] for s in body["steps"]] == PUBLISHED
    await _finish(body)
    assert fake_runner.requests == [] and fake_publisher.calls == PUBLISHED
    assert (await _audits(db, "deploy.deployment_start"))[-1] == {
        "environment": "uat", "mode": "publish", "git_ref": "main", "sha": OLD}


async def test_publish_needs_a_deployed_environment(client, db, ready, no_leaks):
    await configure(db)
    fresh = await make_environment(db, name="qa")
    await _publish_on(db, fresh)
    h = await auth_headers(client, db)
    resp = await client.post("/api/deploy/environments/qa/deployments", headers=h,
                             json={"mode": "publish"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "not_deployed")


async def test_a_publishing_update_and_its_retry(client, db, ready, fake_runner,
                                                 fake_publisher, no_leaks):
    await _publish_on(db, ready)
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        409, "integration_not_configured")
    await configure(db)
    fake_publisher.fail["proxy"] = "busy"
    resp = await client.post(START, headers=h, json={})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["publish"] is True
    assert [s["key"] for s in body["steps"]] == [*UPDATE_KEYS, *PUBLISHED]
    await _finish(body)
    assert (await _audits(db, "deploy.deployment_start"))[-1]["publish"] is True
    fake_publisher.fail.clear()
    resp = await client.post(f"/api/deploy/deployments/{body['id']}/retry", headers=h, json={})
    assert resp.status_code == 201, resp.text
    retry = resp.json()
    assert (retry["start_step"], retry["publish"]) == (13, True)
    await _finish(retry)
    got = (await client.get(f"/api/deploy/deployments/{retry['id']}", headers=h)).json()
    assert got["status"] == "succeeded"


async def test_delete_environment(client, db, ready, fake_runner, fake_publisher, no_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"mode": "teardown"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat",
                                                     "git_ref": "main"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "git_ref_not_allowed")
    await managed(db, ready, "api", "dns_record", "rec-1")
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat"})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["cloudflare"]})
    await configure(db)
    fake_runner.gates["teardown"] = asyncio.Event()
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["mode"], body["start_step"], body["sha"]) == ("teardown", 15, OLD)
    assert [s["key"] for s in body["steps"]] == ["teardown", "unproxy", "undns"]
    await asyncio.wait_for(fake_runner.started["teardown"].wait(), 5)
    assert (await client.get(ENV_URL, headers=h)).json()["status"] == "deleting"
    fake_runner.gates["teardown"].set()
    await _finish(body)
    assert (await client.get(ENV_URL, headers=h)).status_code == 404
    resp = await client.get(f"/api/deploy/deployments/{body['id']}", headers=h)
    assert resp.status_code == 404
    assert (await _audits(db, "deploy.environment_delete")) == [
        {"environment": "uat", "deployment": body["id"]}]


async def test_a_failed_delete_is_retried_with_the_typed_name(client, db, ready, fake_runner,
                                                             fake_publisher, no_leaks):
    fake_runner.results["teardown"] = RunResult(status="failed", rc=2)
    h = await auth_headers(client, db)
    body = (await client.post(START, headers=h,
                              json={"mode": "teardown", "confirm_name": "uat"})).json()
    await _finish(body)
    assert (await client.get(ENV_URL, headers=h)).json()["status"] == "failed"
    url = f"/api/deploy/deployments/{body['id']}/retry"
    adder = await _headers_without_change(client, db)
    assert (await client.post(url, headers=adder, json={"confirm_name": "uat"})).status_code == 403
    resp = await client.post(url, headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "confirm_name_mismatch")
    del fake_runner.results["teardown"]
    resp = await client.post(url, headers=h, json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    await _finish(resp.json())
    assert (await client.get(ENV_URL, headers=h)).status_code == 404


def test_the_dashboard_shows_a_deleting_environment_as_deploying():
    env = Environment(name="uat", status="deleting", current_sha=OLD)
    assert _env_state(env) == "deploying"


async def test_delete_refused_while_a_deployment_runs(client, db, ready, fake_runner,
                                                      fake_publisher, monkeypatch, no_leaks):
    async def busy(db, env_id):
        return True
    monkeypatch.setattr(environments, "is_deploying", busy)
    h = await auth_headers(client, db)
    resp = await client.post(START, headers=h, json={"mode": "teardown", "confirm_name": "uat"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "deploy_in_progress")
    assert fake_runner.requests == []


async def test_publish_tab_dates_are_iso_8601(client, db, ready, publish_fakes, no_leaks):
    await configure(db)
    port = envfile.DEFAULT_PORTS["api"]
    cert = publish_fakes.npm.add_cert(["api.uat.serversherpa.com"], days=80)
    host = publish_fakes.npm.add_host("api.uat.serversherpa.com", "127.0.0.1", port,
                                      certificate_id=cert, ssl_forced=True, http2_support=True,
                                      allow_websocket_upgrade=True, block_exploits=True)
    await managed(db, ready, "api", "proxy_host", host)
    h = await auth_headers(client, db)
    resp = await client.get(f"{ENV_URL}/publish", headers=h)
    assert resp.status_code == 200, resp.text
    api = resp.json()["services"][0]
    assert api["service"] == "api" and api["proxy"]["origin"] == "created"
    expires = api["certificate"]["expires_on"]
    assert isinstance(expires, str)
    assert datetime.fromisoformat(expires).tzinfo is not None


async def test_a_claim_race_is_a_409(client, db, ready, publish_fakes, monkeypatch, no_leaks):
    await configure(db)
    publish_fakes.cf.add("A", "api.uat.serversherpa.com", PUBLIC_IP)

    async def racing_claim(db, env, state):
        # another request recorded the same record first: the unique key settles it
        for _ in range(2):
            db.add(ManagedRecord(environment_id=env.id, service="api", kind="dns_record",
                                 external_id="rec-race", name="api.uat.serversherpa.com",
                                 origin="claimed"))
        await db.flush()
        return ["dns:api.uat.serversherpa.com"]
    monkeypatch.setattr(publish, "claim", racing_claim)
    h = await auth_headers(client, db)
    resp = await client.post(f"{ENV_URL}/publish/claim", headers=h)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "claim_conflict")
    assert await _audits(db, "deploy.publish_claim") == []
    assert (await client.get(ENV_URL, headers=h)).json()["managed_records"] == []


# ---- retries follow the Publish switch -----------------------------------------------

async def test_a_publish_job_retry_needs_the_switch_on(client, db, ready, fake_runner,
                                                        fake_publisher, no_leaks):
    await _publish_on(db, ready)
    await configure(db)
    fake_publisher.fail["proxy"] = "busy"
    h = await auth_headers(client, db)
    body = (await client.post(START, headers=h, json={"mode": "publish"})).json()
    await _finish(body)
    assert (await client.patch(ENV_URL, headers=h, json={"publish": False})).status_code == 200
    fake_publisher.fail.clear()
    resp = await client.post(f"/api/deploy/deployments/{body['id']}/retry", headers=h, json={})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "publish_off")


async def test_a_data_retry_drops_publishing_when_the_switch_is_off(
        client, db, ready, fake_runner, fake_publisher, no_leaks):
    await _publish_on(db, ready)
    await configure(db)
    fake_publisher.fail["proxy"] = "busy"
    h = await auth_headers(client, db)
    body = (await client.post(START, headers=h, json={})).json()
    await _finish(body)
    assert (await client.patch(ENV_URL, headers=h, json={"publish": False})).status_code == 200
    fake_publisher.fail.clear()
    url = f"/api/deploy/deployments/{body['id']}/retry"
    # From the failed publishing step (the default) or any later one: refused.
    for payload in ({}, {"from_step": 12}, {"from_step": 13}):
        resp = await client.post(url, headers=h, json=payload)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "publish_off"), payload
    # From a host step: runs without steps 12–14.
    first = body["steps"][0]["number"]
    resp = await client.post(url, headers=h, json={"from_step": first})
    assert resp.status_code == 201, resp.text
    retry = resp.json()
    assert retry["publish"] is False
    assert [s["key"] for s in retry["steps"]] == UPDATE_KEYS
    calls = len(fake_publisher.calls)
    await _finish(retry)
    assert len(fake_publisher.calls) == calls
    got = (await client.get(f"/api/deploy/deployments/{retry['id']}", headers=h)).json()
    assert got["status"] == "succeeded"



async def test_a_delete_retry_past_the_host_step_needs_no_ssh(client, db, ready, fake_runner,
                                                             fake_publisher, no_leaks):
    await configure(db)
    fake_publisher.fail["unproxy"] = "npm down"
    h = await auth_headers(client, db)
    body = (await client.post(START, headers=h,
                              json={"mode": "teardown", "confirm_name": "uat"})).json()
    await _finish(body)
    # The host is gone from Sirdar's settings (and its key with it).
    ready.target_id = "ssh:gone"
    await db.commit()
    fake_publisher.fail.clear()
    requests = len(fake_runner.requests)
    resp = await client.post(f"/api/deploy/deployments/{body['id']}/retry", headers=h,
                             json={"confirm_name": "uat"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["start_step"] == 16
    await _finish(resp.json())
    assert len(fake_runner.requests) == requests
    assert (await client.get(ENV_URL, headers=h)).status_code == 404
