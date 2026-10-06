"""Step 14 Switch traffic and step 18 Remove DigitalOcean resources against
the fakes: the load balancer moves to the slot and back on a failed public
smoke test; Delete checks everything first, removes only what Sirdar
recorded (and droplets/databases carrying the environment's tags), forgets
each row as it goes and resumes after a failure."""

import json
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import DoResource, Environment
from sirdar_api.deploy import do_envs, do_provision, known_hosts, smoke, spaces, targets, vms
from sirdar_api.deploy.do_api import DoError
from sirdar_api.deploy.publish import StepFailed

from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import (  # noqa: F401
    deploy_env,
    do_build,
    do_cloud,
    make_do_environment,
    ssh_server,
)
from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN


def _answer(status: int):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(status)

    return httpx.MockTransport(handler), seen


def _lb(fake) -> dict:
    (lb,) = fake.load_balancers.values()
    return lb


def _droplet_id(fake, slot: str) -> int:
    return next(d["id"] for d in fake.droplets.values() if d["name"] == f"ss-uat9-{slot}")


def _lb_puts(fake, since: int = 0) -> list[list[int]]:
    return [json.loads(r.content)["droplet_ids"] for r in fake.requests[since:]
            if r.method == "PUT" and "/load_balancers/" in r.url.path]


class Sleeps:
    def __init__(self):
        self.seconds: list[float] = []

    async def __call__(self, seconds):
        self.seconds.append(seconds)


def _destroy(build, **prov):
    return build.run("do_destroy", mode="teardown", slot=None, go_live=False,
                     prov=prov or None)


# ---- step 14: Switch traffic ---------------------------------------------------------------

async def test_switch_traffic_to_the_slot(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, seen = _answer(200)
    await do_build.run("go_live", slot="orange")
    fake = do_build.cloud.do
    assert _lb(fake)["droplet_ids"] == [_droplet_id(fake, "orange")]
    assert {r.headers["host"] for r in seen} >= {"api.uat9.serversherpa.com",
                                                 "status.uat9.serversherpa.com"}
    assert all(r.url.host == fake.load_balancers[_lb(fake)["id"]]["ip"] for r in seen)
    assert all(r.extensions["sni_hostname"] == r.headers["host"] for r in seen)
    assert "traffic now goes to orange" in do_build.log()


async def test_switch_adds_the_new_droplet_before_dropping_the_old(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, _ = _answer(200)
    await do_build.run("go_live", slot="orange")
    fake = do_build.cloud.do
    fake.lb_apply_polls = 2                          # every PUT takes a while to apply
    since, sleeps = len(fake.requests), Sleeps()
    await do_build.run("go_live", slot="purple", prov={"sleep": sleeps})
    orange, purple = _droplet_id(fake, "orange"), _droplet_id(fake, "purple")
    assert _lb_puts(fake, since) == [[orange, purple], [purple]]
    assert _lb(fake)["droplet_ids"] == [purple] and _lb(fake)["status"] == "active"
    assert 40 in sleeps.seconds                      # 3 healthy checks x 10 s, plus 10 s
    healthz = [c for c in do_build.remote.calls if "healthz" in c[1]]
    assert healthz and healthz[-1][2] is None
    assert "traffic now goes to purple (was orange)" in do_build.log()


async def test_the_public_check_outlasts_the_health_checks(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, seen = _answer(502)
    with pytest.raises(StepFailed):
        await do_build.run("go_live", slot="orange", prov={"smoke_delay": 10})
    rounds = len(seen) // len({r.headers["host"] for r in seen})
    assert (rounds - 1) * 10 > 40                    # waits between rounds > health checks


async def test_an_unhealthy_slot_never_carries_traffic_alone(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, _ = _answer(200)
    await do_build.run("go_live", slot="orange")
    fake = do_build.cloud.do
    fake.lb_apply_polls = 2
    do_build.remote.codes["healthz"] = 7
    since = len(fake.requests)
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="purple")
    orange, purple = _droplet_id(fake, "orange"), _droplet_id(fake, "purple")
    assert _lb_puts(fake, since) == [[orange, purple], [orange]]
    assert "/healthz" in err.value.reason
    assert _lb(fake)["droplet_ids"] == [orange]


async def test_switch_keeps_the_rest_of_the_load_balancer(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    before = {k: v for k, v in _lb(fake).items() if k != "droplet_ids" and not k.startswith("_")}
    do_build.cloud.smoke, _ = _answer(200)
    await do_build.run("go_live", slot="purple")
    after = {k: v for k, v in _lb(fake).items() if k != "droplet_ids" and not k.startswith("_")}
    assert after == before
    assert _lb(fake)["droplet_ids"] == [_droplet_id(fake, "purple")]


async def test_switching_to_the_live_slot_again_changes_nothing(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, _ = _answer(200)
    await do_build.run("go_live", slot="orange")
    fake = do_build.cloud.do
    puts = len([w for w in fake.writes() if w[0] == "PUT"])
    await do_build.run("go_live", slot="orange")
    assert len([w for w in fake.writes() if w[0] == "PUT"]) == puts
    assert "already sends traffic to orange" in do_build.log()


async def test_a_failed_public_check_puts_traffic_back(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, _ = _answer(200)
    await do_build.run("go_live", slot="orange")
    do_build.cloud.smoke, _ = _answer(502)
    fake = do_build.cloud.do
    fake.lb_apply_polls = 2                          # the rollback waits for the apply
    since = len(fake.requests)
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="purple")
    orange, purple = _droplet_id(fake, "orange"), _droplet_id(fake, "purple")
    assert _lb_puts(fake, since) == [[orange, purple], [orange]]
    assert _lb(fake)["droplet_ids"] == [orange]
    assert "didn't answer through the load balancer" in err.value.reason
    assert "Put traffic back on orange" in do_build.log()


async def test_staging_certificates_are_not_verified(db, do_build, monkeypatch):
    await do_build.run()
    await do_envs.set_do(do_build.env.id, acme_staging=True)
    seen = {}

    async def fake_run(targets, proxy_ip, **kw):
        seen.update(kw)
        return [smoke.SmokeResult(s, f"https://{h}/", True, "HTTP 200") for s, h in targets]

    monkeypatch.setattr(smoke, "run", fake_run)
    await do_build.run("go_live", slot="orange")
    assert seen["insecure"] is True


async def test_production_certificates_are_verified(db, do_build, monkeypatch):
    await do_build.run()
    seen = {}

    async def fake_run(targets, proxy_ip, **kw):
        seen.update(kw)
        return [smoke.SmokeResult(s, f"https://{h}/", True, "HTTP 200") for s, h in targets]

    monkeypatch.setattr(smoke, "run", fake_run)
    await do_build.run("go_live", slot="orange")
    assert seen["insecure"] is False


async def test_smoke_insecure_skips_certificate_checks(monkeypatch):
    made = []
    real = httpx.AsyncClient

    def client(**kw):
        made.append(kw.get("verify", True))
        return real(**{**kw, "transport": httpx.MockTransport(lambda r: httpx.Response(200))})

    monkeypatch.setattr(httpx, "AsyncClient", client)
    await smoke.run([("api", "api.x.test")], "203.0.113.9", insecure=True)
    await smoke.run([("api", "api.x.test")], "203.0.113.9")
    assert made == [False, True]


async def test_deactivate_points_at_no_droplet(db, do_build):
    await do_build.run()
    do_build.cloud.smoke, seen = _answer(200)
    await do_build.run("go_live", slot="orange")
    seen.clear()
    await do_build.run("go_live", slot=None)
    assert _lb(do_build.cloud.do)["droplet_ids"] == []
    assert seen == []


async def test_switch_refuses_a_droplet_that_lost_its_tag(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.droplets[str(_droplet_id(fake, "orange"))]["tags"] = ["web"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="orange")
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_switch_without_a_load_balancer_fails(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.load_balancers.clear()
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="orange")
    assert "load balancer Sirdar recorded is gone" in err.value.reason


# ---- step 18: Remove DigitalOcean resources ------------------------------------------------

async def test_remove_everything(db, do_build):
    await do_build.run()
    fake, spaces_fake = do_build.cloud.do, do_build.cloud.spaces
    for i in range(3):
        spaces_fake.put(do_build.env.spaces_bucket, f"files/{i}.pdf", b"x")
    stranger = fake.add_droplet("someone-elses", ["web"])
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert list(fake.droplets) == [str(stranger["id"])]
    assert (fake.vpcs, fake.databases, fake.keys, fake.certificates, fake.load_balancers,
            fake.firewalls) == ({}, {}, {}, {}, {}, {})
    assert do_build.env.spaces_bucket not in spaces_fake.buckets
    assert (await db.scalars(select(DoResource))).all() == []
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is None
    log = do_build.log()
    assert "emptied (3 objects)" in log and "Forgot 127.0.0.1's SSH host key" in log
    for secret in ("spaces-SECRET", DEV_TOKEN, DEV_RENEW_TOKEN):
        assert secret not in log


async def test_remove_finds_tagged_droplets_it_lost(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "droplet",
                                                         DoResource.slot == "purple"))
    await db.commit()
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert fake.droplets == {}
    assert "tagged for this environment but not recorded" in do_build.log()


async def test_remove_leaves_a_droplet_without_sirdars_own_tag(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    half = fake.add_droplet("ss-uat9-extra", [do_envs.env_tag(do_build.env.id)])
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert list(fake.droplets) == [str(half["id"])]
    assert (await db.scalars(select(DoResource))).all() == []


async def test_remove_checks_everything_before_deleting(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    next(iter(fake.databases.values()))["tags"] = []
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_refuses_a_droplet_missing_the_sirdar_tag(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    droplet = fake.droplets[str(_droplet_id(fake, "purple"))]
    droplet["tags"] = [t for t in droplet["tags"] if t != "sirdar"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_refuses_a_renamed_spaces_key(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    next(iter(fake.keys.values()))["name"] = "someone-elses-key"
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "Spaces key" in err.value.reason and "Sirdar changed nothing" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_refuses_a_bucket_record_for_another_bucket(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    await db.execute(update(DoResource).where(DoResource.kind == "bucket")
                     .values(do_id="someone-elses-bucket", name="someone-elses-bucket"))
    await db.commit()
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "someone-elses-bucket" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_forgets_rows_of_resources_already_gone(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.firewalls.clear()
    fake.load_balancers.clear()
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert (await db.scalars(select(DoResource))).all() == []
    assert "ss-uat9-fw: already gone" in do_build.log()


async def test_remove_resumes_after_a_failure(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.vpc_lingering = 10_000                      # the VPC never empties this time
    with pytest.raises(StepFailed) as err:
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert "still has members" in err.value.reason
    kinds = {r.kind for r in (await db.scalars(select(DoResource))).all()}
    assert kinds == {"vpc"}
    fake.vpc_lingering = 0
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert fake.vpcs == {} and (await db.scalars(select(DoResource))).all() == []


async def test_remove_resumes_after_a_failed_droplet_delete(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.fail[("DELETE", "/droplets/" + str(_droplet_id(fake, "purple")))] = 500
    with pytest.raises(StepFailed):
        await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    kinds = {r.kind for r in (await db.scalars(select(DoResource))).all()}
    assert "load_balancer" not in kinds and "droplet" in kinds
    fake.fail.clear()
    await do_build.run("do_destroy", mode="teardown", slot=None, go_live=False)
    assert fake.droplets == {} and (await db.scalars(select(DoResource))).all() == []


async def test_switch_keeps_load_balancer_settings_sirdar_doesnt_manage(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    extra = {"sticky_sessions": {"type": "cookies", "cookie_name": "x", "cookie_ttl_seconds": 60},
             "enable_proxy_protocol": True, "http_idle_timeout_seconds": 90,
             "firewall": {"deny": ["cidr:198.51.100.0/24"], "allow": []},
             "disable_lets_encrypt_dns_records": True, "enable_backend_keepalive": True,
             "project_id": "proj-1", "size": "lb-small", "created_at": "2026-10-01T00:00:00Z"}
    _lb(fake).update(extra)
    do_build.cloud.smoke, _ = _answer(200)
    since = len(fake.requests)
    await do_build.run("go_live", slot="orange")
    for k, v in extra.items():
        if k not in ("size", "created_at"):
            assert _lb(fake)[k] == v, k
    for r in fake.requests[since:]:
        if r.method == "PUT":
            body = json.loads(r.content)
            assert not {"id", "ip", "status", "created_at", "size"} & set(body)


def test_lb_update_body_starts_from_the_live_body():
    live = {"id": "x", "ip": "1.2.3.4", "status": "active", "created_at": "t", "name": "lb",
            "region": {"slug": "nyc3"}, "size": "lb-small", "size_unit": 1, "tag": "",
            "droplet_ids": [1], "sticky_sessions": {"type": "none"}, "project_id": None,
            "forwarding_rules": [], "health_check": {}}
    body = do_provision.lb_update_body(live, droplet_ids=[2])
    assert body == {"name": "lb", "region": "nyc3", "size_unit": 1, "droplet_ids": [2],
                    "sticky_sessions": {"type": "none"}, "forwarding_rules": [],
                    "health_check": {}}


async def test_switch_refuses_a_token_from_another_team(db, do_build):
    await do_build.run()
    await do_envs.set_do(do_build.env.id, team_uuid="team-somewhere-else")
    fake = do_build.cloud.do
    do_build.cloud.smoke, _ = _answer(200)
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="orange")
    assert "another team" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_refuses_a_token_from_another_team(db, do_build):
    await do_build.run()
    await do_envs.set_do(do_build.env.id, team_uuid="team-somewhere-else")
    fake = do_build.cloud.do
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build)
    assert "another team" in err.value.reason
    assert fake.writes()[before:] == []
    assert (await db.scalars(select(DoResource))).all() != []


async def _make_production(db, build, *, retiring: bool, active: str | None) -> None:
    """uat9 as a production environment (blue + green, as production requires)."""
    from sirdar_api.db.models import DoSlot
    for old, new in (("orange", "blue"), ("purple", "green")):
        for model in (DoSlot, DoResource):
            await db.execute(update(model).where(model.environment_id == build.env.id,
                                                 model.slot == old).values(slot=new))
    await db.execute(update(Environment).where(Environment.id == build.env.id).values(
        type="production", slots=["blue", "green"], auto_activate=False, retiring=retiring,
        active_slot=active))
    await db.commit()


@pytest.mark.parametrize("retiring,active", [(False, None), (True, "blue")])
async def test_remove_refuses_a_live_production(db, do_build, retiring, active):
    await do_build.run()
    await _make_production(db, do_build, retiring=retiring, active=active)
    fake = do_build.cloud.do
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build)
    assert "production" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_takes_a_retired_production(db, do_build):
    await do_build.run()
    await _make_production(db, do_build, retiring=True, active=None)
    await _destroy(do_build)
    assert (await db.scalars(select(DoResource))).all() == []


async def test_remove_takes_the_certificate_the_cert_worker_renewed(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = fake.certificates.values()
    fake.certificates["renewed-1"] = {**old, "id": "renewed-1", "name": "ss-uat9-20261101"}
    for rule in _lb(fake)["forwarding_rules"]:
        if rule.get("certificate_id"):
            rule["certificate_id"] = "renewed-1"
    await _destroy(do_build)
    assert fake.certificates == {}
    assert "ss-uat9-20261101" in do_build.log()


async def test_remove_refuses_a_certificate_that_is_no_longer_ours(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["name"] = "someone-elses-cert"
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build)
    assert "Certificate" in err.value.reason and "Sirdar changed nothing" in err.value.reason
    assert fake.writes()[before:] == []


async def test_remove_waits_for_a_certificate_still_in_use(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.cert_in_use_polls = 3
    await _destroy(do_build)
    assert fake.certificates == {} and fake.cert_in_use_polls == 0


async def test_remove_stops_at_once_on_a_vpc_refusal_that_isnt_members(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (vid,) = fake.vpcs
    fake.fail[("DELETE", f"/vpcs/{vid}")] = 403
    sleeps = Sleeps()
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build, sleep=sleeps)
    assert "refused to delete the VPC" in err.value.reason
    assert len([r for r in fake.requests if r.method == "DELETE"
                and r.url.path.endswith(vid)]) == 1


async def test_a_vpc_that_keeps_members_names_them(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (vid,) = fake.vpcs
    intruder = fake.add_droplet("intruder", ["web"], vpc_uuid=vid)
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build, waits={"vpc": 5})
    assert "still has members" in err.value.reason
    assert f"droplet {intruder['id']} (intruder)" in err.value.reason
    assert str(intruder["id"]) in fake.droplets


async def test_a_failed_bucket_empty_still_deletes_the_setup_key(db, do_build, monkeypatch):
    await do_build.run()

    async def refuse(*a, **kw):
        raise spaces.SpacesError("Spaces refused the request (AccessDenied).")

    monkeypatch.setattr(spaces, "empty_bucket", refuse)
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build)
    assert "AccessDenied" in err.value.reason
    assert not [k for k in do_build.cloud.do.keys.values() if k["name"] == "ss-uat9-setup"]
    rows = (await db.scalars(select(DoResource).where(DoResource.kind == "spaces_key"))).all()
    assert rows == []
    assert {r.kind for r in (await db.scalars(select(DoResource))).all()} == {"bucket", "vpc"}


async def test_a_failed_setup_key_delete_doesnt_hide_the_bucket_error(db, do_build, monkeypatch):
    await do_build.run()

    async def refuse(*a, **kw):
        raise spaces.SpacesError("Spaces refused the request (AccessDenied).")

    async def stuck(self, api, ctx, access_key):
        raise DoError("DigitalOcean answered with HTTP 500.", status=500)

    monkeypatch.setattr(spaces, "empty_bucket", refuse)
    monkeypatch.setattr(do_provision.DoProvisioner, "_drop_setup_key", stuck)
    with pytest.raises(StepFailed) as err:
        await _destroy(do_build)
    assert "AccessDenied" in err.value.reason and "HTTP 500" in err.value.reason


async def test_remove_keeps_a_pin_another_environment_uses(db, do_build):
    await do_build.run()
    other = await make_do_environment(db, name="uat8")
    await do_envs.set_slot(other.id, "orange", public_ip="127.0.0.1")
    await _destroy(do_build)
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is not None
    assert "Forgot" not in do_build.log()


async def test_remove_keeps_a_saved_ssh_targets_pin(db, do_build, monkeypatch):
    await do_build.run()
    monkeypatch.setattr(targets, "ssh_configs",
                        lambda s: [("ssh", SimpleNamespace(host="127.0.0.1"))])
    await _destroy(do_build)
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is not None


async def test_remove_deletes_a_tagged_database_it_lost(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "database"))
    await db.commit()
    await _destroy(do_build)
    assert fake.databases == {}
    assert "ss-uat9-db: tagged for this environment but not recorded" in do_build.log()
