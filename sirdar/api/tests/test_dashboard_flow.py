"""The spotlight's data: every dashboard card carries its flow (live
traffic → load balancer or Nginx Proxy Manager → its servers). Production is
always the first card (or a placeholder); DigitalOcean values come from
Sirdar's records and the accounts' inventories, LAN values from the target
and the NPM integration."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import update

from sirdar_api.config import get_settings
from sirdar_api.dashboard import service
from sirdar_api.dashboard.demo import demo_dashboard
from sirdar_api.db.models import (
    Deployment, DoEnvironment, DoSlot, Environment, EnvironmentService)
from sirdar_api.deploy import do_envs, targets, vms

from .api_helpers import auth_headers
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .do_helpers import configure_account, deployed, do_cloud, make_do_environment  # noqa: F401
from .fake_digitalocean import DEV_TOKEN, DO_TOKEN, RENEW_TOKEN
from .integration_helpers import configure, configure_proxmox
from .test_deploy_pipeline import SHA
from .vm_helpers import make_vm_environment

pytestmark = pytest.mark.usefixtures("secrets_key")
NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    service.clear_cache()
    monkeypatch.setenv("SIRDAR_DEPLOY_DO_TOKEN", "")
    get_settings.cache_clear()
    yield
    service.clear_cache()
    get_settings.cache_clear()


async def _dashboard(client, db, h: dict | None = None) -> dict:
    h = h or await auth_headers(client, db)
    resp = await client.get("/api/dashboard", headers=h)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _do_live(db, env, *, active, days=40, checks=None, lb="lb-1"):
    """Records as a deploy leaves them, without step 0: slots deployed, the
    load balancer recorded (and in the fake's inventory), a certificate."""
    await deployed(db, env, active, sha=SHA)
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id).values(
        lb_ip="203.0.113.50", cert_not_after=datetime.now(UTC) + timedelta(days=days, hours=1)))
    for slot, ok in (checks or {}).items():
        await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                              DoSlot.slot == slot).values(last_check_ok=ok))
    await db.commit()
    if lb:
        await do_envs.record(env.id, "load_balancer", lb, f"ss-{env.name}-lb")


def _lb(do_cloud, lb_id: str, status: str = "active") -> None:
    do_cloud.do.load_balancers[lb_id] = {
        "id": lb_id, "name": "lb", "ip": "203.0.113.50", "status": status,
        "region": {"slug": "nyc3"}, "droplet_ids": [], "forwarding_rules": [], "tags": []}


async def test_a_two_slot_production_is_the_first_card(client, db, do_cloud):
    prod = await make_do_environment(db, name="prod", type_="production", account="production")
    await _do_live(db, prod, active="blue", days=10, checks={"blue": True})
    _lb(do_cloud, "lb-1")
    card = (await _dashboard(client, db))["environments"][0]
    assert (card["id"], card["production"], card["environment"], card["state"]) == (
        "prod", True, "prod", "active")
    flow = card["flow"]
    assert flow["kind"] == "load_balancer"
    assert flow["middle"] == {"label": "Load balancer", "sub": "203.0.113.50", "status": "ok"}
    assert [(s["id"], s["label"], s["sub"], s["state"], s["health"], s["deployed"])
            for s in flow["servers"]] == [
        ("blue", "Blue", "127.0.0.1", "live", "healthy", True),
        ("green", "Green", "127.0.0.1", "idle", "unknown", True)]
    assert flow["servers"][0]["version"] == SHA[:8]
    assert (flow["active_slot"], flow["deploying_slot"], flow["failed_slot"]) == (
        "blue", None, None)
    assert (flow["certificate"]["days_left"], flow["certificate"]["tone"]) == (10, "warn")


async def test_without_production_the_first_card_is_a_placeholder(client, db):
    first = (await _dashboard(client, db))["environments"][0]
    assert {k: first[k] for k in ("id", "label", "state", "action_label", "environment",
                                  "production")} == {
        "id": "production", "label": "Production", "state": "empty",
        "action_label": "Set up Production", "environment": None, "production": True}
    assert first["primary"] is True
    assert first["flow"] == {
        "kind": "none", "middle": {"label": "Not built yet", "sub": "", "status": "unknown"},
        "servers": [{"id": "none", "label": "Server", "sub": "Not built yet", "state": "empty",
                     "health": "unknown", "version": None, "deployed": False}],
        "active_slot": None, "certificate": None, "deploying_slot": None, "failed_slot": None}


async def test_a_one_slot_environment_without_a_load_balancer_yet(client, db, do_cloud):
    await make_do_environment(db, name="solo", slots=1)
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "solo")
    assert (card["production"], card["sub"]) == (False, "Development")
    flow = card["flow"]
    assert flow["middle"] == {"label": "Load balancer", "sub": "Built by the first deploy",
                              "status": "unknown"}
    assert [(s["id"], s["sub"], s["state"]) for s in flow["servers"]] == [
        ("orange", "Not built yet", "empty")]
    assert flow["certificate"] is None


async def test_a_load_balancer_missing_from_the_inventory_is_down(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange", lb="lb-gone")
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat9")
    assert card["flow"]["middle"]["status"] == "down"


async def test_deploying_and_failed_slots(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running", cloud=True, slot="purple"))
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        status="deploying"))
    await db.commit()
    h = await auth_headers(client, db)
    flow = next(c for c in (await _dashboard(client, db, h))["environments"]
                if c["id"] == "uat9")["flow"]
    assert (flow["deploying_slot"], flow["failed_slot"]) == ("purple", None)
    await db.execute(update(Deployment).where(Deployment.environment_id == env.id).values(
        status="failed"))
    await db.execute(update(Environment).where(Environment.id == env.id).values(status="failed"))
    await db.commit()
    card = next(c for c in (await _dashboard(client, db, h))["environments"]
                if c["id"] == "uat9")
    assert card["state"] == "failed"
    assert (card["flow"]["deploying_slot"], card["flow"]["failed_slot"],
            card["flow"]["active_slot"]) == (None, "purple", "orange")   # orange still live


async def test_a_lan_ssh_environment_is_proxy_then_one_host(client, db, monkeypatch):
    await configure(db)                        # Cloudflare and NPM (http://10.10.48.6:81)
    await make_environment(db, name="uat", current_sha=SHA, secrets={})
    monkeypatch.setattr(targets, "ssh_config_for",
                        lambda tid, s: SimpleNamespace(host="10.10.48.63"))
    monkeypatch.setattr(targets, "public_targets",
                        lambda s, **kw: [{"id": "ssh", "label": "Lab box"}])
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat")
    assert card["flow"] == {
        "kind": "proxy",
        "middle": {"label": "Nginx Proxy Manager", "sub": "10.10.48.6", "status": "ok"},
        "servers": [{"id": "host", "label": "Lab box", "sub": "10.10.48.63", "state": "live",
                     "health": "healthy", "version": SHA[:8], "deployed": True}],
        "active_slot": "host", "certificate": None, "deploying_slot": None,
        "failed_slot": None}


async def test_a_vm_environment_shows_its_vm(client, db):
    await configure_proxmox(db)
    env = await make_vm_environment(db, name="uat3")
    vm = await vms.get_for(db, env)
    card = next(c for c in (await _dashboard(client, db))["environments"] if c["id"] == "uat3")
    (server,) = card["flow"]["servers"]
    assert (server["label"], server["sub"], server["state"]) == (
        vm.name, vm.ip or "No address yet", "empty")
    assert card["flow"]["middle"] == {"label": "Nginx Proxy Manager", "sub": "Not set up",
                                      "status": "unknown"}


@pytest.mark.parametrize("delta, days, tone", [
    (timedelta(days=30, hours=1), 30, "ok"),
    (timedelta(days=14, hours=1), 14, "warn"),
    (timedelta(hours=-1), 0, "bad"),
])
def test_certificate_tones(delta, days, tone):
    info = service.cert_info(NOW + delta, NOW)
    assert (info["days_left"], info["tone"]) == (days, tone)
    assert info["expires_at"] == (NOW + delta).isoformat()
    assert service.cert_info(None, NOW) is None


async def test_both_accounts_in_the_infrastructure(client, db, do_cloud):
    await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
    await configure_account(db)
    do_cloud.do.add_droplet("ss-prod-blue", ["sirdar", "sirdar-env:prod"])
    infra = (await _dashboard(client, db))["infrastructure"]
    assert [(a["key"], a["error"]) for a in infra["accounts"]] == [
        ("production", None), ("development", None)]
    assert [n["name"] for n in infra["tree"]] == ["Production account", "Development account"]
    assert {r.headers["authorization"] for r in do_cloud.do.requests} == {
        f"Bearer {DO_TOKEN}", f"Bearer {DEV_TOKEN}"}


def test_the_demo_has_the_same_shape():
    d = demo_dashboard()
    assert "production" not in d
    assert [(c["id"], c["production"], c["flow"]["kind"], len(c["flow"]["servers"]))
            for c in d["environments"]] == [
        ("production", True, "load_balancer", 2), ("dev", False, "load_balancer", 2),
        ("uat", False, "proxy", 1)]
    for card in d["environments"]:
        assert set(card) == {"id", "label", "sub", "state", "version", "last_release",
                             "last_release_at", "action_label", "environment", "production",
                             "primary", "retiring", "running", "portal_url", "flow"}
        assert set(card["flow"]) == {"kind", "middle", "servers", "active_slot", "certificate",
                                     "deploying_slot", "failed_slot"}
    assert [c["primary"] for c in d["environments"]] == [True, False, False]


async def _card(client, db, name: str, h: dict | None = None) -> dict:
    return next(c for c in (await _dashboard(client, db, h))["environments"] if c["id"] == name)


async def test_a_slot_with_a_droplet_but_no_commit_is_idle_not_deployed(client, db, do_cloud):
    env = await make_do_environment(db)
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id, DoSlot.slot == "orange")
                     .values(droplet_id="4001", public_ip="127.0.0.1"))
    await db.commit()
    orange, purple = (await _card(client, db, "uat9"))["flow"]["servers"]
    assert (orange["state"], orange["deployed"], orange["sub"]) == ("idle", False, "127.0.0.1")
    assert (purple["state"], purple["deployed"]) == ("empty", False)


async def test_a_droplet_the_inventory_shows_stopped_is_degraded(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange", checks={"orange": True, "purple": True})
    _lb(do_cloud, "lb-1")
    do_cloud.do.droplets["4001"] = {**do_cloud.do.add_droplet("ss-uat9-orange", ["sirdar"]),
                                    "id": 4001, "status": "off"}
    orange, purple = (await _card(client, db, "uat9"))["flow"]["servers"]
    assert (orange["health"], purple["health"]) == ("degraded", "healthy")


async def test_a_load_balancer_that_is_not_active_is_warn(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    _lb(do_cloud, "lb-1", status="new")
    assert (await _card(client, db, "uat9"))["flow"]["middle"]["status"] == "warn"


@pytest.mark.parametrize("status", ["cancelled", "interrupted"])
async def test_a_stopped_deployment_marks_its_slot_failed(client, db, do_cloud, status):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status=status, cloud=True, slot="purple"))
    await db.execute(update(Environment).where(Environment.id == env.id).values(status="failed"))
    await db.commit()
    flow = (await _card(client, db, "uat9"))["flow"]
    assert (flow["failed_slot"], flow["deploying_slot"]) == ("purple", None)


async def test_a_later_snapshot_keeps_the_failed_mark(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="failed", cloud=True, slot="purple",
                      created_at=NOW - timedelta(hours=1)))
    db.add(Deployment(environment_id=env.id, mode="snapshot", git_ref="main", sha=SHA,
                      status="succeeded", cloud=True, created_at=NOW))
    await db.execute(update(Environment).where(Environment.id == env.id).values(status="failed"))
    await db.commit()
    assert (await _card(client, db, "uat9"))["flow"]["failed_slot"] == "purple"


async def test_two_accounts_one_failing_keeps_the_grouped_tree(client, db, do_cloud):
    await make_do_environment(db, name="prod", type_="production", account="production")
    await configure_account(db)
    do_cloud.do.add_droplet("ss-prod-blue", ["sirdar", "sirdar-env:prod"])
    del do_cloud.do.tokens[DEV_TOKEN]                    # the Development token now 401s
    d = await _dashboard(client, db)
    infra = d["infrastructure"]
    reason = "DigitalOcean rejected the API token."
    assert infra["error"] == f"Development account: {reason}"
    assert [(a["key"], a["error"]) for a in infra["accounts"]] == [
        ("production", None), ("development", reason)]
    prod_node, dev_node = infra["tree"]
    assert (prod_node["name"], dev_node["name"]) == ("Production account", "Development account")
    assert prod_node["children"]
    assert (dev_node["children"], dev_node["status_label"], dev_node["endpoint"]) == (
        [], "Unavailable", reason)
    assert d["environments"][0]["id"] == "prod"
    assert d["environments"][0]["flow"]["kind"] == "load_balancer"


async def test_a_lan_server_version_falls_back_to_the_commit(client, db, monkeypatch):
    env = await make_environment(db, name="uat", current_sha=SHA, secrets={})
    await db.execute(update(Environment).where(Environment.id == env.id).values(image_tag=None))
    await db.commit()
    monkeypatch.setattr(targets, "ssh_config_for",
                        lambda tid, s: SimpleNamespace(host="10.10.48.63"))
    card = await _card(client, db, "uat")
    assert card["flow"]["servers"][0]["version"] == card["version"] == SHA[:8]


async def test_only_the_first_card_is_primary(client, db, do_cloud):
    old = await make_do_environment(db, name="prod-old", type_="production",
                                    account="production")
    await db.execute(update(Environment).where(Environment.id == old.id).values(retiring=True))
    await db.commit()
    await make_do_environment(db, name="prod", type_="production", account="production")
    cards = (await _dashboard(client, db))["environments"]
    assert [(c["id"], c["production"], c["primary"]) for c in cards
            if c["production"]] == [("prod", True, True), ("prod-old", True, False)]
    assert sum(c["primary"] for c in cards) == 1


async def test_a_later_renew_keeps_the_failed_mark(client, db, do_cloud):
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="failed", cloud=True, slot="purple",
                      created_at=NOW - timedelta(hours=1)))
    db.add(Deployment(environment_id=env.id, mode="renew", git_ref="main", sha=SHA,
                      status="succeeded", cloud=True, created_at=NOW))
    await db.execute(update(Environment).where(Environment.id == env.id).values(status="failed"))
    await db.commit()
    assert (await _card(client, db, "uat9"))["flow"]["failed_slot"] == "purple"


async def test_retiring_and_running_on_every_card(client, db, do_cloud):
    old = await make_do_environment(db, name="prod-old", type_="production",
                                    account="production")
    await db.execute(update(Environment).where(Environment.id == old.id).values(retiring=True))
    env = await make_do_environment(db)
    await _do_live(db, env, active="orange")
    db.add(Deployment(environment_id=env.id, mode="renew", git_ref="main", sha=SHA,
                      status="running", cloud=True))
    await db.commit()
    cards = {c["id"]: c for c in (await _dashboard(client, db))["environments"]}
    assert (cards["prod-old"]["retiring"], cards["prod-old"]["running"]) == (True, False)
    assert (cards["uat9"]["retiring"], cards["uat9"]["running"]) == (False, True)
    assert (cards["beta"]["retiring"], cards["beta"]["running"]) == (False, False)


async def test_every_card_links_its_portal(client, db, do_cloud):
    """The traffic box opens the environment's portal: https://<portal hostname>, or null
    when the environment has no portal hostname or is a placeholder."""
    await make_environment(db, name="uat", current_sha=SHA, secrets={})
    bare = await make_environment(db, name="lab", current_sha=SHA, secrets={})
    await db.execute(update(EnvironmentService).where(
        EnvironmentService.environment_id == bare.id,
        EnvironmentService.service == "portal").values(hostname=None))
    await db.commit()
    cards = {c["id"]: c for c in (await _dashboard(client, db))["environments"]}
    assert cards["uat"]["portal_url"] == "https://portal.uat.serversherpa.com"
    assert cards["lab"]["portal_url"] is None
    assert cards["production"]["portal_url"] is None          # the placeholder


def test_demo_cards_have_no_portal_link():
    assert {c["portal_url"] for c in demo_dashboard()["environments"]} == {None}
