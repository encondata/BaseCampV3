"""Apps, mail and optional secrets on create: stored, shown without
secrets, rendered into the .env, and only the running apps are public."""

import base64
import uuid

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Environment, EnvironmentService
from sirdar_api.deploy import do_provision, envfile, pipeline, publish

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    leak_guard,
    secrets_key,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import do_build, do_cloud  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import _ssh_env, deploy_env  # noqa: F401
from .test_deploy_deployments_api import LS, SHA
from .test_deploy_pipeline_do import _start as _do_start
from .test_deploy_pipeline_do import do_env  # noqa: F401
from .test_deploy_pipeline_lan import _run as _lan_run
from .test_deploy_pipeline_lan import lan  # noqa: F401

URL = "/api/deploy/environments"
SMTP_PASSWORD = "Mail-Secret-1"
AI_KEY = "sk-ant-test-0123456789"
NEW = {"mode": "new", "name": "qa1", "type": "custom", "target": "ssh",
       "proxy_ip": "10.10.48.6", "publish": False}


@pytest.fixture
def target(deploy_env, ssh_server, secrets_key):
    _ssh_env(deploy_env, ssh_server)
    return ssh_server


async def test_apps_and_smtp_are_stored_and_shown_without_secrets(client, db, target,
                                                                  leak_guard):
    leak_guard += [SMTP_PASSWORD, AI_KEY]
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        **NEW, "apps": ["kiosk"], "secrets": {"SS_ANTHROPIC_API_KEY": AI_KEY},
        "mail": {"mode": "smtp", "host": "smtp.example.com", "port": 587, "username": "mailer",
                 "password": SMTP_PASSWORD, "from_address": "ops@example.com", "starttls": True}})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["apps"] == ["kiosk"]
    assert body["mail"] == {"mode": "smtp", "host": "smtp.example.com", "port": 587,
                            "username": "mailer", "from_address": "ops@example.com",
                            "starttls": True, "password_set": True}
    assert body["secrets_set"]["SS_ANTHROPIC_API_KEY"] is True
    hostnames = dict((await db.execute(select(EnvironmentService.service,
                                              EnvironmentService.hostname))).all())
    assert hostnames["kiosk"] == "kiosk.qa1.serversherpa.com"
    assert hostnames["wiki"] is None and hostnames["status"] is None     # off: not public
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert audit["apps"] == ["kiosk"] and audit["mail"] == {"mode": "smtp",
                                                            "host": "smtp.example.com"}
    assert audit["secrets"] == ["SS_ANTHROPIC_API_KEY"]


async def test_the_env_file_carries_the_apps_and_smtp(client, db, target, fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={
        **NEW, "apps": ["wiki", "status"],
        "mail": {"mode": "smtp", "host": "smtp.example.com", "port": 2525,
                 "from_address": "ops@example.com", "password": SMTP_PASSWORD}})
    resp = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    await pipeline.wait(uuid.UUID(resp.json()["id"]))
    render = next(r for r in fake_runner.requests if r.step == "render")
    values = envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())
    assert values["STACK_APPS"] == "wiki,status"
    assert (values["SS_SMTP_HOST"], values["SS_SMTP_PORT"], values["SS_SMTP_FROM"]) == (
        "smtp.example.com", "2525", "ops@example.com")
    assert values["SS_SMTP_PASSWORD"] == SMTP_PASSWORD


@pytest.mark.parametrize("body, code", [
    ({"apps": ["api"]}, "apps_invalid"),
    ({"apps": ["wiki"]}, "mailpit_required"),
    ({"mail": {"mode": "smtp", "host": "", "from_address": "a@b.co"}}, "smtp_host_invalid"),
    ({"secrets": {"SS_PASSWORD_PEPPER": "x"}}, "secret_not_editable"),
])
async def test_create_refusals(client, db, target, body, code):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={**NEW, **body})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)


async def test_adopt_takes_no_secrets(client, db, target):
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        "mode": "adopt", "name": "x", "type": "custom", "target": "ssh",
        "secrets": {"SS_ANTHROPIC_API_KEY": AI_KEY}})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "secrets_not_allowed")


async def test_defaults_list_the_apps_and_the_smtp_port(client, db):
    h = await auth_headers(client, db)
    body = (await client.get("/api/deploy/environment-defaults", headers=h)).json()
    assert body["apps"] == {"optional": ["wiki", "kiosk", "status", "mailpit"],
                            "always": ["api", "portal"]}
    assert body["mail"] == {"smtp_port": 587}


ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": "Correct-Horse-Battery-9"}


async def _render_values(fake_runner) -> dict[str, str]:
    render = next(r for r in fake_runner.requests if r.step == "render")
    return envfile.parse_env(base64.b64decode(render.extravars["env_file_b64"]).decode())


async def test_an_environment_with_nothing_chosen_keeps_every_app_and_mailpit(
        client, db, target, fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    body = (await client.post(URL, headers=h, json=NEW)).json()
    assert body["apps"] == ["wiki", "kiosk", "status", "mailpit"]
    assert body["mail"]["mode"] == "mailpit" and body["mail"]["password_set"] is False
    assert all(s["hostname"] for s in body["services"] if s["service"] != "mailpit")
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_create"))).one()
    assert (audit["apps"], audit["mail"], audit["secrets"]) == (
        ["wiki", "kiosk", "status", "mailpit"], {"mode": "mailpit"}, [])
    resp = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    await pipeline.wait(uuid.UUID(resp.json()["id"]))
    values = await _render_values(fake_runner)
    assert values["STACK_APPS"] == "wiki,kiosk,status,mailpit"
    assert not any(k.startswith("SS_SMTP_") and k != "SS_SMTP_PASSWORD" for k in values)
    assert values["SS_SMTP_PASSWORD"] == ""


async def test_the_smtp_password_never_reaches_a_step_log(client, db, target, fake_runner):
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    fake_runner.output["render"] = [f"echo {SMTP_PASSWORD}\n"]
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={
        **NEW, "mail": {"mode": "smtp", "host": "smtp.example.com",
                        "from_address": "ops@example.com", "password": SMTP_PASSWORD}})
    resp = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    dep_id = resp.json()["id"]
    await pipeline.wait(uuid.UUID(dep_id))
    out = (await client.get(f"/api/deploy/deployments/{dep_id}", headers=h)).text
    assert SMTP_PASSWORD not in out and "[redacted]" in out


async def test_publish_plans_only_the_running_apps(client, db, target):
    """DNS records, proxy hosts and NPM certificates all come from
    service_plans: an app that is off has none, even if its row still has
    a name."""
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "publish": True})
    env = await db.scalar(select(Environment).where(Environment.name == "qa1"))
    env.apps = ["mailpit"]
    await db.flush()
    assert [p.service for p in await publish.service_plans(db, env)] == [
        "api", "portal", "spaces"]


async def test_a_new_base_domain_names_only_the_running_apps(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "apps": ["kiosk", "mailpit"]})
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"base_domain": "qa2.serversherpa.com"})
    assert resp.status_code == 200, resp.text
    names = {s["service"]: s["hostname"] for s in resp.json()["services"]}
    assert names == {"api": "api.qa2.serversherpa.com", "portal": "portal.qa2.serversherpa.com",
                     "kiosk": "kiosk.qa2.serversherpa.com", "wiki": None,
                     "spaces": "spaces.qa2.serversherpa.com", "status": None, "mailpit": None}


async def test_production_with_a_first_admin_needs_smtp(client, db, target):
    h = await auth_headers(client, db)
    prod = {"mode": "new", "name": "prod1", "type": "production", "target": "digitalocean",
            "first_admin": ADMIN}
    resp = await client.post(URL, headers=h, json=prod)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (
        422, "smtp_required_for_first_admin")
    resp = await client.post(URL, headers=h, json={**prod, "mail": {
        "mode": "smtp", "host": "smtp.example.com", "from_address": "ops@example.com"}})
    assert resp.json()["detail"]["code"] != "smtp_required_for_first_admin"


async def test_digitalocean_smokes_and_certifies_only_the_running_apps(
        db, do_env, fake_runner, fake_publisher, fake_provisioner):
    do_env.apps = ["status", "mailpit"]
    await db.commit()
    await _do_start(db, do_env, slot="orange", go_live=True)
    values = await _render_values(fake_runner)
    assert values["STACK_APPS"] == "status,mailpit"
    assert values["SS_CERT_NAMES"] == ("api.uat9.serversherpa.com,portal.uat9.serversherpa.com,"
                                       "status.uat9.serversherpa.com")
    for request in fake_runner.requests:
        assert [h["service"] for h in request.extravars["public_hosts"]] == [
            "api", "portal", "status"], request.step


async def test_digitalocean_create_names_only_the_running_apps(db, do_build):
    await do_build.run()
    env = await db.get(Environment, do_build.env.id, populate_existing=True)
    env.apps = ["wiki", "mailpit"]
    await db.flush()
    ctx = await do_provision.prepare(db, env, await do_build.deployment(), get_settings())
    assert ctx.names == ("api.uat9.serversherpa.com", "portal.uat9.serversherpa.com",
                         "wiki.uat9.serversherpa.com")


async def test_lan_bluegreen_smokes_only_the_running_apps(db, lan, fake_runner, fake_publisher,
                                                          fake_provisioner):
    lan.apps = ["kiosk", "mailpit"]
    await db.commit()
    await _lan_run(db, lan, go_live=True)
    smoke = next(r for r in fake_runner.requests if r.step == "slot_smoke")
    assert {h["service"] for h in smoke.extravars["public_hosts"]} == {"api", "portal", "kiosk"}
    assert (await _render_values(fake_runner))["STACK_APPS"] == "kiosk,mailpit"
