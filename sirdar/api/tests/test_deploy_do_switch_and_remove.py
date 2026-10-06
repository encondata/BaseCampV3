"""Step 14 Switch traffic and step 18 Remove DigitalOcean resources against
the fakes: the load balancer moves to the slot and back on a failed public
smoke test; Delete checks everything first, removes only what Sirdar
recorded (and droplets/databases carrying the environment's tags), forgets
each row as it goes and resumes after a failure."""

import httpx
import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import DoResource
from sirdar_api.deploy import do_envs, known_hosts, smoke, vms
from sirdar_api.deploy.publish import StepFailed

from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import deploy_env, do_build, do_cloud, ssh_server  # noqa: F401
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
    assert "traffic now goes to orange" in do_build.log()


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
    with pytest.raises(StepFailed) as err:
        await do_build.run("go_live", slot="purple")
    fake = do_build.cloud.do
    assert _lb(fake)["droplet_ids"] == [_droplet_id(fake, "orange")]
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
