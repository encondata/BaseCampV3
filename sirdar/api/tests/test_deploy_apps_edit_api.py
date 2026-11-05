"""PATCH apps, mail and the kiosk signing digests: checked as create checks
them, refused while a deploy runs, the public names rebuilt (envfile's list
on the LAN, the certificate's on DigitalOcean), and the next deploy renders
them."""

import uuid

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, Deployment, Environment, EnvironmentSecret
from sirdar_api.deploy import environments, first_admins, pipeline, vault

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
from .do_helpers import make_do_environment
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_apps_api import NEW, SMTP_PASSWORD, URL, _render_values, target  # noqa: F401
from .test_deploy_deployments_api import LS, SHA

SMTP = {"mode": "smtp", "host": "smtp.example.com", "port": 587,
        "from_address": "ops@example.com"}
DIGEST = "ab" * 32
ADMIN = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
         "password_mode": "typed", "password": "Correct-Horse-Battery-9"}


def _names(body) -> dict[str, str | None]:
    return {s["service"]: s["hostname"] for s in body["services"]}


async def _changes(db) -> list:
    return list(await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.environment_update").order_by(AuditLog.id)))


async def test_apps_turned_off_lose_their_names_and_turned_on_get_them(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"apps": ["kiosk", "status", "mailpit"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["apps"] == ["kiosk", "status", "mailpit"]
    assert _names(body) == {
        "api": "api.qa1.serversherpa.com", "portal": "portal.qa1.serversherpa.com",
        "home": "qa1.serversherpa.com", "kiosk": "kiosk.qa1.serversherpa.com", "wiki": None,
        "learn": None, "spaces": "spaces.qa1.serversherpa.com",
        "status": "status.qa1.serversherpa.com", "mailpit": None}
    resp = await client.patch(f"{URL}/qa1", headers=h, json={
        "apps": ["wiki", "kiosk", "learn", "status", "mailpit"]})
    names = _names(resp.json())
    assert (names["wiki"], names["learn"]) == ("wiki.qa1.serversherpa.com",
                                               "learn.qa1.serversherpa.com")
    assert await _changes(db) == [{"changed": ["apps"]}, {"changed": ["apps"]}]


@pytest.mark.parametrize("patch, code", [
    ({"apps": ["learn", "mailpit"]}, "learn_needs_wiki"),
    ({"apps": ["blog"]}, "apps_invalid"),
    ({"apps": ["wiki", "kiosk"]}, "mailpit_required"),
    ({"mail": {**SMTP, "host": "smtp example.com"}}, "smtp_host_invalid"),
    ({"kiosk_signing_digests": ["nope"]}, "signing_digest_invalid"),
])
async def test_create_rules_apply(client, db, target, patch, code):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h, json=patch)
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)
    env = await db.scalar(select(Environment).where(Environment.name == "qa1")
                          .execution_options(populate_existing=True))
    assert env.apps == ["wiki", "kiosk", "learn", "status", "mailpit"] and env.smtp_host is None


async def test_mailpit_off_with_smtp_in_the_same_patch(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"apps": ["wiki", "kiosk"], "mail": SMTP})
    assert resp.status_code == 200, resp.text
    assert (resp.json()["apps"], resp.json()["mail"]["mode"]) == (["wiki", "kiosk"], "smtp")
    assert await _changes(db) == [{"changed": ["apps", "mail"]}]


async def test_back_to_mailpit_clears_smtp_and_its_password(client, db, target, leak_guard):
    leak_guard += [SMTP_PASSWORD]
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json={**NEW, "mail": {**SMTP, "password": SMTP_PASSWORD}})
    resp = await client.patch(f"{URL}/qa1", headers=h, json={"mail": {"mode": "mailpit"}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"] == {"mode": "mailpit", "host": None, "port": None,
                                   "username": None, "from_address": None, "starttls": True,
                                   "password_set": False}
    env = await db.scalar(select(Environment).where(Environment.name == "qa1")
                          .execution_options(populate_existing=True))
    assert (env.smtp_host, env.smtp_port, env.smtp_from) == (None, None, None)
    assert await db.get(EnvironmentSecret, (env.id, "SS_SMTP_PASSWORD")) is None
    assert await _changes(db) == [{"changed": ["mail", "secrets.SS_SMTP_PASSWORD"]}]


NEW_PASSWORD = "Mail-Secret-2"


async def _smtp_env(client, db, h):
    resp = await client.post(URL, headers=h, json={
        **NEW, "mail": {**SMTP, "username": "ops", "password": SMTP_PASSWORD}})
    assert resp.status_code in (200, 201), resp.text
    return await db.scalar(select(Environment).where(Environment.name == "qa1"))


async def _stored_password(db, env) -> str | None:
    row = await db.get(EnvironmentSecret, (env.id, "SS_SMTP_PASSWORD"),
                       populate_existing=True)
    return None if row is None else vault.decrypt(get_settings(), bytes(row.value_enc))


@pytest.mark.parametrize("mail", [
    {**SMTP, "host": "smtp.evil.example.net", "username": "ops"},
    {**SMTP, "username": "someone-else"},
    {**SMTP},                                         # the user name dropped
])
async def test_a_new_server_or_user_without_a_password_drops_the_stored_one(
        client, db, target, leak_guard, mail):
    leak_guard += [SMTP_PASSWORD]
    h = await auth_headers(client, db)
    env = await _smtp_env(client, db, h)
    resp = await client.patch(f"{URL}/qa1", headers=h, json={"mail": mail})
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"]["password_set"] is False
    assert await _stored_password(db, env) is None
    assert await _changes(db) == [{"changed": ["mail", "secrets.SS_SMTP_PASSWORD"]}]


@pytest.mark.parametrize("patch", [
    {"mail": {**SMTP, "host": "smtp.other.example.net", "username": "ops",
              "password": NEW_PASSWORD}},
    {"mail": {**SMTP, "host": "smtp.other.example.net", "username": "ops"},
     "secrets": {"SS_SMTP_PASSWORD": NEW_PASSWORD}},
])
async def test_a_new_server_with_a_new_password_stores_it(client, db, target, leak_guard, patch):
    leak_guard += [SMTP_PASSWORD, NEW_PASSWORD]
    h = await auth_headers(client, db)
    env = await _smtp_env(client, db, h)
    resp = await client.patch(f"{URL}/qa1", headers=h, json=patch)
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"]["password_set"] is True
    assert await _stored_password(db, env) == NEW_PASSWORD
    assert await _changes(db) == [{"changed": ["mail", "secrets.SS_SMTP_PASSWORD"]}]


@pytest.mark.parametrize("mail", [
    {**SMTP, "username": "ops", "port": 2525},
    {**SMTP, "username": "ops", "starttls": False},
    {**SMTP, "username": "ops", "host": "SMTP.Example.COM"},     # the same server
])
async def test_port_or_starttls_alone_keeps_the_password(client, db, target, leak_guard, mail):
    leak_guard += [SMTP_PASSWORD]
    h = await auth_headers(client, db)
    env = await _smtp_env(client, db, h)
    resp = await client.patch(f"{URL}/qa1", headers=h, json={"mail": mail})
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"]["password_set"] is True
    assert await _stored_password(db, env) == SMTP_PASSWORD
    assert await _changes(db) == [{"changed": ["mail"]}]


@pytest.mark.parametrize("patch", [
    {"mail": {"mode": "mailpit"}, "secrets": {"SS_SMTP_PASSWORD": NEW_PASSWORD}},
    {"mail": {"mode": "mailpit", "password": NEW_PASSWORD}},
    {"secrets": {"SS_SMTP_PASSWORD": NEW_PASSWORD}},             # already on Mailpit
])
async def test_an_smtp_password_with_mailpit_is_refused(client, db, target, leak_guard, patch):
    leak_guard += [SMTP_PASSWORD, NEW_PASSWORD]
    h = await auth_headers(client, db)
    if "mail" in patch:
        env = await _smtp_env(client, db, h)
    else:
        await client.post(URL, headers=h, json=NEW)
        env = await db.scalar(select(Environment).where(Environment.name == "qa1"))
    resp = await client.patch(f"{URL}/qa1", headers=h, json=patch)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == {"code": "smtp_password_without_smtp",
                                     "field": "secrets.SS_SMTP_PASSWORD"}
    assert await _stored_password(db, env) == (SMTP_PASSWORD if "mail" in patch else None)
    assert await _changes(db) == []


async def test_clearing_the_password_on_the_way_to_mailpit_names_it_once(client, db, target,
                                                                        leak_guard):
    leak_guard += [SMTP_PASSWORD]
    h = await auth_headers(client, db)
    env = await _smtp_env(client, db, h)
    resp = await client.patch(f"{URL}/qa1", headers=h, json={
        "mail": {"mode": "mailpit"}, "secrets": {"SS_SMTP_PASSWORD": ""}})
    assert resp.status_code == 200, resp.text
    assert await _stored_password(db, env) is None
    assert await _changes(db) == [{"changed": ["mail", "secrets.SS_SMTP_PASSWORD"]}]


async def test_digests_are_normalized_and_kept(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h,
                              json={"kiosk_signing_digests": ["AB:" * 31 + "AB", DIGEST]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["kiosk_signing_digests"] == [DIGEST]
    assert await _changes(db) == [{"changed": ["kiosk_signing_digests"]}]
    resp = await client.patch(f"{URL}/qa1", headers=h, json={"kiosk_signing_digests": []})
    assert resp.json()["kiosk_signing_digests"] == []


async def test_nothing_changes_while_a_deploy_runs(client, db, target):
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    env = await db.scalar(select(Environment).where(Environment.name == "qa1"))
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running"))
    await db.commit()
    for patch in ({"apps": ["wiki", "mailpit"]}, {"mail": SMTP},
                  {"kiosk_signing_digests": [DIGEST]}):
        resp = await client.patch(f"{URL}/qa1", headers=h, json=patch)
        assert (resp.status_code, resp.json()["detail"]["code"]) == (409, "deploy_in_progress")


async def test_the_next_deploy_renders_the_new_apps_mail_and_digests(client, db, target,
                                                                     fake_runner, leak_guard):
    leak_guard += [SMTP_PASSWORD]
    await trust_fake(db, target)
    target.overrides[f"{LS} main"] = f"{SHA}\trefs/heads/main\n"
    h = await auth_headers(client, db)
    await client.post(URL, headers=h, json=NEW)
    resp = await client.patch(f"{URL}/qa1", headers=h, json={
        "apps": ["wiki", "learn", "status"], "mail": {**SMTP, "password": SMTP_PASSWORD},
        "kiosk_signing_digests": [DIGEST]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail"]["password_set"] is True
    dep = await client.post(f"{URL}/qa1/deployments", headers=h, json={"mode": "update"})
    await pipeline.wait(uuid.UUID(dep.json()["id"]))
    values = await _render_values(fake_runner)
    assert (values["STACK_APPS"], values["SS_SMTP_HOST"], values["SS_SMTP_PASSWORD"],
            values["SS_KIOSK_SIGNING_DIGESTS"]) == (
        "wiki,learn,status", "smtp.example.com", SMTP_PASSWORD, DIGEST)


async def test_on_digitalocean_the_names_follow_the_certificate_list(db, secrets_key):
    env = await make_do_environment(db)
    changed = await environments.update(db, get_settings(), env,
                                        {"apps": ["kiosk", "status", "mailpit"]})
    assert changed == ["apps"]
    names = {r.service: r.hostname for r in await environments.services_of(db, env.id)}
    assert names == {
        "api": "api.uat9.serversherpa.com", "portal": "portal.uat9.serversherpa.com",
        "home": "uat9.serversherpa.com", "kiosk": "kiosk.uat9.serversherpa.com", "wiki": None,
        "learn": None, "spaces": None, "status": "status.uat9.serversherpa.com",
        "mailpit": None}
    await db.rollback()


async def test_production_keeps_smtp_while_its_first_admin_is_pending(db, secrets_key):
    env = await make_do_environment(db, name="prod", type_="production", account="production")
    settings = get_settings()
    assert await environments.update(db, settings, env, {"mail": SMTP}) == ["mail"]
    await first_admins.put(db, settings, env.id, first_admins.check(ADMIN))
    with pytest.raises(environments.EnvError) as e:
        await environments.update(db, settings, env, {"mail": {"mode": "mailpit"}})
    assert e.value.code == "smtp_required_for_first_admin"
    await db.rollback()
