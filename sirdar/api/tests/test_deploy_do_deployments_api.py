"""Starting DigitalOcean deployments through the API: Update targets the
idle slot and goes live only when the rules say so; Reset, Restore backup
and Roll back aren't offered; Delete takes a snapshot first and keeps
production's rules. The pipeline runs with fakes."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, select, update

from sirdar_api.api.routes import deploy as deploy_routes
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import AuditLog, Deployment, DoAccount, DoSlot, Environment, Snapshot
from sirdar_api.deploy import do_accounts, do_envs, envfile, environments, pipeline, publish, vms
from sirdar_api.deploy.integrations import IntegrationError
from sirdar_api.deploy.provision import VmOutcome
from sirdar_api.deploy.runner import RunResult

from .api_helpers import auth_headers
from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    fake_publisher,
    fake_runner,
    make_environment,
    secrets_key,
    snapshots_dir,
    stop_pipeline,
    trust_fake,
)
from .do_helpers import built, built_env, deployed, fetched, make_do_environment, ready_snapshot
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

URL = "/api/deploy/environments"
PHRASE = "delete production prod"


async def _destroyed(ctx) -> None:
    """What a real step 18 leaves behind: no do_resources rows."""
    async with get_sessionmaker()() as s:
        rows = await do_envs.resources_of(s, ctx.env_id)
    for row in rows:
        await do_envs.forget(ctx.env_id, row.kind, row.do_id)


@pytest.fixture
async def ready(db, deploy_env, secrets_key, snapshots_dir, ssh_server, monkeypatch, tmp_path,
                fake_runner, fake_publisher, fake_provisioner):
    """make(**kw): a DigitalOcean environment, built (step 0's records) unless
    built=False. Export leaves a bundle; step 18 forgets every record."""
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    await trust_fake(db, ssh_server)
    fake_provisioner.effects["do_prepare"] = built
    fake_provisioner.effects["do_destroy"] = _destroyed
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=SHA)
    fake_runner.effects["export"] = fetched(tmp_path)

    async def make(*, built: bool = True, **kw) -> Environment:
        env = await make_do_environment(db, **kw)
        if built:
            await built_env(env)
        return env
    return make


async def _deployed(db, env: Environment, active: str | None = "orange") -> None:
    await deployed(db, env, active, sha=SHA)


async def _start(client, h, name, **body):
    resp = await client.post(f"{URL}/{name}/deployments", headers=h, json=body)
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


async def _retry(client, h, dep_id, **body):
    resp = await client.post(f"/api/deploy/deployments/{dep_id}/retry", headers=h, json=body)
    if resp.status_code == 201:
        await pipeline.wait(uuid.UUID(resp.json()["id"]))
    return resp


async def _dep(db, dep_id) -> Deployment | None:
    return await db.get(Deployment, uuid.UUID(str(dep_id)), populate_existing=True)


async def _gone(db, env: Environment) -> bool:
    return await db.get(Environment, env.id, populate_existing=True) is None


def _code(resp) -> tuple[int, str]:
    return resp.status_code, resp.json()["detail"]["code"]


# ---- Update ------------------------------------------------------------------------

async def test_update_targets_the_idle_slot(client, db, ready):
    env = await ready()
    h = await auth_headers(client, db)
    first = await _start(client, h, "uat9", mode="update")
    assert first.status_code == 201, first.text
    assert (first.json()["cloud"], first.json()["slot"], first.json()["go_live"]) == (
        True, "orange", True)
    await _deployed(db, env)
    second = (await _start(client, h, "uat9", mode="update")).json()
    assert (second["slot"], second["go_live"]) == ("purple", False)
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.deployment_start").order_by(AuditLog.id))).all()
    assert (audit[-1]["slot"], audit[-1]["go_live"]) == ("purple", False)


async def test_a_one_slot_environment_always_goes_live(client, db, ready):
    env = await ready(slots=1)
    await _deployed(db, env)
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="update")).json()
    assert (body["slot"], body["go_live"]) == ("orange", True)


async def test_an_update_never_publishes(client, db, ready):
    """DigitalOcean plans refuse publish=True: DNS is part of the Update plan."""
    env = await ready()
    await db.execute(update(Environment).where(Environment.id == env.id).values(publish=True))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    assert resp.json()["publish"] is False


async def test_an_update_after_a_slot_ran_drops_the_seed(client, db, ready, tmp_path):
    """The managed database is shared: once a slot ran, the seed is spent.
    (pipeline's seed_not_allowed stays as the backstop; its 409 mapping is
    test_a_digitalocean_refusal_carries_its_extra.)"""
    snap = await ready_snapshot(db, tmp_path)
    env = await ready(snapshot_id=snap.id)
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "orange").values(sha=SHA))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert resp.status_code == 201, resp.text
    assert resp.json()["snapshot"] is None


async def test_a_digitalocean_refusal_carries_its_extra(client, db, ready, monkeypatch):
    """Activate has no route in 7a; whatever create_deployment raises as
    DoEnvError (slot_not_deployed for an Activate) answers 409 with its
    extra fields."""
    await ready()
    h = await auth_headers(client, db)

    async def refuse(*a, **kw):
        raise do_envs.DoEnvError("slot_not_deployed", slot="purple")
    monkeypatch.setattr(pipeline, "create_deployment", refuse)
    resp = await _start(client, h, "uat9", mode="update")
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "slot_not_deployed", "slot": "purple"})


# ---- refusals ----------------------------------------------------------------------

async def test_modes_that_would_touch_the_live_slot_are_refused(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    for body in ({"mode": "reset", "confirm_name": "uat9"},
                 {"mode": "restore_dump", "confirm_name": "uat9",
                  "backup": "20261001T010203Z.dump"},
                 {"mode": "vm_restore", "confirm_name": "uat9",
                  "vm_snapshot": "sirdar-20261001T010203Z"}):
        resp = await _start(client, h, "uat9", **body)
        assert _code(resp) == (409, "not_supported_on_digitalocean"), body
    dep = Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                     status="failed", previous_sha=SHA, dump_path="/x/backups/a.dump",
                     cloud=True, slot="purple")
    db.add(dep)
    await db.commit()
    resp = await client.post(f"/api/deploy/deployments/{dep.id}/rollback", headers=h,
                             json={"confirm_name": "uat9"})
    assert _code(resp) == (409, "not_supported_on_digitalocean")


async def test_a_retry_of_a_refused_mode_is_refused(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    dep = Deployment(environment_id=env.id, mode="reset", git_ref="main", sha=SHA,
                     status="failed", cloud=True, slot="purple")
    db.add(dep)
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _retry(client, h, dep.id, confirm_name="uat9")
    assert _code(resp) == (409, "not_supported_on_digitalocean")


async def test_the_pipeline_refusing_a_mode_answers_409(client, db, ready, monkeypatch):
    """pipeline.NotSupportedOnDigitalOcean, from wherever it comes, is a 409
    carrying its code (never a 500)."""
    await ready()
    h = await auth_headers(client, db)

    async def refuse(*a, **kw):
        raise pipeline.NotSupportedOnDigitalOcean(kw["mode"])
    monkeypatch.setattr(pipeline, "create_deployment", refuse)
    resp = await _start(client, h, "uat9", mode="update")
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "not_supported_on_digitalocean"})


async def test_snapshot_fields_belong_to_a_digitalocean_delete(client, db, ready):
    await ready()
    h = await auth_headers(client, db)
    for body in ({"mode": "update", "snapshot": False},
                 {"mode": "update", "confirm_production": PHRASE}):
        assert _code(await _start(client, h, "uat9", **body)) == (422, "snapshot_not_allowed")


async def test_snapshot_fields_on_another_target(client, db, secrets_key, deploy_env):
    await make_environment(db)
    h = await auth_headers(client, db)
    for body in ({"mode": "teardown", "confirm_name": "uat", "snapshot": False},
                 {"mode": "teardown", "confirm_name": "uat", "confirm_production": PHRASE},
                 {"mode": "update", "snapshot": True}):
        assert _code(await _start(client, h, "uat", **body)) == (422, "snapshot_not_allowed")


async def test_an_account_without_a_token(client, db, ready):
    await ready()
    await db.execute(update(DoAccount).where(DoAccount.key == "development")
                     .values(token_enc=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="update")
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "do_account_not_configured", "account": "development"})


async def test_no_digitalocean_record_is_not_ready(client, db, ready, monkeypatch):
    await ready()

    async def missing(db_, env_id):
        return None
    monkeypatch.setattr(do_envs, "get", missing)
    h = await auth_headers(client, db)
    assert _code(await _start(client, h, "uat9", mode="update")) == (409, "do_not_ready")


# ---- Delete ------------------------------------------------------------------------

async def test_delete_takes_a_snapshot_first(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [s["key"] for s in body["steps"]] == ["export", "undns", "do_destroy"]
    assert body["snapshot"]["name"].startswith("uat9-before-delete-")
    assert body["slot"] == "orange"
    # It ran to the end: the deployment went with the environment.
    assert await _dep(db, body["id"]) is None and await _gone(db, env)
    snap = await db.scalar(select(Snapshot).where(Snapshot.name == body["snapshot"]["name"])
                           .execution_options(populate_existing=True))
    assert snap.status == "ready"


async def test_delete_without_a_snapshot(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9",
                         snapshot=False)).json()
    assert [s["key"] for s in body["steps"]] == ["undns", "do_destroy"]
    assert (await db.scalars(select(Snapshot))).all() == []
    assert await _dep(db, body["id"]) is None and await _gone(db, env)


async def test_delete_a_never_deployed_environment(client, db, ready):
    env = await ready()
    h = await auth_headers(client, db)
    body = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    assert [s["key"] for s in body["steps"]] == ["undns", "do_destroy"]
    assert await _dep(db, body["id"]) is None and await _gone(db, env)


async def test_production_delete_rules(client, db, ready, monkeypatch):
    env = await ready(name="prod", type_="production", account="production")
    locks: list[str] = []
    real_lock = environments.lock_production

    async def lock(db_):
        locks.append("lock")
        await real_lock(db_)
    monkeypatch.setattr(environments, "lock_production", lock)
    await _deployed(db, env, active="blue")
    h = await auth_headers(client, db)
    base = {"mode": "teardown", "confirm_name": "prod", "confirm_production": PHRASE}
    resp = await _start(client, h, "prod", **base)
    assert _code(resp) == (409, "production_not_retiring")
    assert locks == ["lock"]            # read under the production lock
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(retiring=True))
    await db.commit()
    assert _code(await _start(client, h, "prod", **base)) == (409, "production_slot_active")
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(active_slot=None))
    await db.commit()
    resp = await _start(client, h, "prod", **{**base, "confirm_production": "yes"})
    assert _code(resp) == (422, "confirm_production_mismatch")
    resp = await _start(client, h, "prod", **{k: v for k, v in base.items()
                                               if k != "confirm_production"})
    assert _code(resp) == (422, "confirm_production_mismatch")
    resp = await _start(client, h, "prod", **{**base, "snapshot": False})
    assert _code(resp) == (422, "snapshot_required")
    resp = await _start(client, h, "prod", **base)
    assert resp.status_code == 201, resp.text
    assert resp.json()["steps"][0]["key"] == "export"
    # No slot is active: the snapshot comes from the first slot that runs a commit.
    assert resp.json()["slot"] == "blue"
    assert await _dep(db, resp.json()["id"]) is None and await _gone(db, env)


async def _failed_production_delete(client, db, h, ready, fake_provisioner) -> tuple:
    """prod, retiring with nothing live; its Delete took the snapshot then
    failed at step 18."""
    env = await ready(name="prod", type_="production", account="production")
    await _deployed(db, env, active=None)
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.commit()
    fake_provisioner.fail["do_destroy"] = "DigitalOcean said no."
    body = (await _start(client, h, "prod", mode="teardown", confirm_name="prod",
                         confirm_production=PHRASE)).json()
    dep = await _dep(db, body["id"])
    assert (dep.status, dep.failed_step) == ("failed", 18)
    del fake_provisioner.fail["do_destroy"]
    return env, dep


async def test_a_production_delete_retry_keeps_production_s_rules(client, db, ready,
                                                                 fake_provisioner,
                                                                 monkeypatch):
    h = await auth_headers(client, db)
    env, dep = await _failed_production_delete(client, db, h, ready, fake_provisioner)
    locks: list[str] = []
    real_lock = environments.lock_production

    async def lock(db_):
        locks.append("lock")
        await real_lock(db_)
    monkeypatch.setattr(environments, "lock_production", lock)
    good = {"confirm_name": "prod", "confirm_production": PHRASE}
    resp = await _retry(client, h, dep.id, confirm_name="prod")
    assert _code(resp) == (422, "confirm_production_mismatch")
    resp = await _retry(client, h, dep.id, **{**good, "confirm_production": "nope"})
    assert _code(resp) == (422, "confirm_production_mismatch")
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=False))
    await db.commit()
    assert _code(await _retry(client, h, dep.id, **good)) == (409, "production_not_retiring")
    assert "lock" in locks
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(retiring=True, active_slot="blue"))
    await db.commit()
    assert _code(await _retry(client, h, dep.id, **good)) == (409, "production_slot_active")
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(active_slot=None))
    await db.commit()
    resp = await _retry(client, h, dep.id, **good)
    assert resp.status_code == 201, resp.text
    assert resp.json()["snapshot"]["id"] == str(dep.snapshot_id)
    assert await _dep(db, resp.json()["id"]) is None and await _gone(db, env)


async def test_a_production_delete_retry_needs_its_snapshot(client, db, ready,
                                                            fake_provisioner):
    """Past step 11 with the snapshot gone, production would go without
    one: refused (Delete it again from the start instead)."""
    h = await auth_headers(client, db)
    env, dep = await _failed_production_delete(client, db, h, ready, fake_provisioner)
    await db.execute(delete(Snapshot).where(Snapshot.id == dep.snapshot_id))
    await db.commit()
    resp = await _retry(client, h, dep.id, confirm_name="prod", confirm_production=PHRASE)
    assert _code(resp) == (409, "snapshot_required")
    assert not await _gone(db, env)


async def test_step_17_keeps_a_live_production_s_records(db, ready):
    """Un-retired after the Delete started: step 17 refuses before it touches
    DNS, as step 18 does before it touches DigitalOcean."""
    env = await ready(name="prod", type_="production", account="production")
    ctx = publish.PublishContext(env_id=env.id, env_name="prod", proxy_ip="", services=(),
                                 cloud=True)
    lines: list[str] = []
    with pytest.raises(publish.StepFailed) as e:
        await publish.HttpPublisher().run("undns", ctx, lines.append)
    assert "production" in str(e.value) and lines == []
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(retiring=True, active_slot="blue"))
    await db.commit()
    with pytest.raises(publish.StepFailed):
        await publish.HttpPublisher().run("undns", ctx, lines.append)
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(active_slot=None))
    await db.commit()
    await publish.HttpPublisher().run("undns", ctx, lines.append)
    assert lines == ["No DNS records to remove.\n"]


# ---- the snapshot's name -------------------------------------------------------------

class _Frozen(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 5, 1, 2, 3, tzinfo=UTC)


STAMP = "20261005T010203Z"


async def _taken_names(db, *names) -> None:
    for name in names:
        db.add(Snapshot(name=name, origin="upload", source="x", status="failed"))
    await db.commit()


async def test_a_taken_snapshot_name_gets_a_suffix(client, db, ready, monkeypatch):
    monkeypatch.setattr(deploy_routes, "datetime", _Frozen)
    env = await ready()
    await _deployed(db, env)
    base = f"uat9-before-delete-{STAMP}"
    await _taken_names(db, base, f"{base}-2")
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")
    assert resp.status_code == 201, resp.text
    assert resp.json()["snapshot"]["name"] == f"{base}-3"


async def test_a_long_name_s_suffix_stays_within_64(client, db, ready, monkeypatch):
    monkeypatch.setattr(deploy_routes, "datetime", _Frozen)
    name = "abcdefghijklmnopqrstuvwxyzabcdef"
    assert len(name) == 32
    env = await ready(name=name)
    await _deployed(db, env)
    base = f"{name}-before-delete-{STAMP}"
    assert len(base) == 63
    await _taken_names(db, base)
    h = await auth_headers(client, db)
    resp = await _start(client, h, name, mode="teardown", confirm_name=name)
    assert resp.status_code == 201, resp.text
    taken = resp.json()["snapshot"]["name"]
    assert (taken, len(taken)) == (f"{base[:62]}-2", 64)


async def test_nine_taken_names_answer_snapshot_exists(client, db, ready, monkeypatch):
    monkeypatch.setattr(deploy_routes, "datetime", _Frozen)
    env = await ready()
    await _deployed(db, env)
    base = f"uat9-before-delete-{STAMP}"
    await _taken_names(db, base, *[f"{base}-{n}" for n in range(2, 10)])
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")
    assert _code(resp) == (409, "snapshot_exists")
    assert (await db.get(Environment, env.id, populate_existing=True)).status == "ready"


# ---- Retry, Take snapshot, backups -----------------------------------------------------

async def test_a_retry_keeps_the_slot_and_whether_it_goes_live(client, db, ready, fake_runner,
                                                              monkeypatch):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    fake_runner.results["up"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat9", mode="update")).json()
    assert (failed["slot"], failed["go_live"]) == ("purple", False)
    assert (await _dep(db, failed["id"])).status == "failed"
    del fake_runner.results["up"]
    seen: list = []
    real = vms.host_config

    async def spy(db_, settings, env_, *, slot=None):
        seen.append(slot)
        return await real(db_, settings, env_, slot=slot)
    monkeypatch.setattr(vms, "host_config", spy)
    resp = await _retry(client, h, failed["id"])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["cloud"], body["slot"], body["go_live"], body["publish"]) == (
        True, "purple", False, False)
    assert seen and set(seen) == {"purple"}     # the idle slot, never the live one
    assert (await _dep(db, body["id"])).status == "succeeded"


async def test_a_delete_retried_before_the_snapshot_takes_a_new_one(client, db, ready,
                                                                    fake_runner):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    export_effect = fake_runner.effects.pop("export")
    fake_runner.results["export"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    assert failed["slot"] == "orange"
    first_snap = failed["snapshot"]["id"]
    del fake_runner.results["export"]
    fake_runner.effects["export"] = export_effect
    resp = await _retry(client, h, failed["id"], confirm_name="uat9")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["cloud"], body["slot"]) == (True, "orange")
    assert [s["key"] for s in body["steps"]] == ["export", "undns", "do_destroy"]
    assert body["snapshot"]["id"] != first_snap
    assert body["snapshot"]["name"].startswith("uat9-before-delete-")
    old = await db.scalar(select(Snapshot.status).where(Snapshot.id == first_snap)
                          .execution_options(populate_existing=True))
    assert old == "failed"
    assert await _dep(db, body["id"]) is None and await _gone(db, env)


async def test_a_delete_retried_before_the_snapshot_needs_the_droplet(client, db, ready,
                                                                      fake_runner):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    fake_runner.results["export"] = RunResult(status="failed", rc=2)
    failed = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "orange").values(public_ip=None))
    await db.commit()
    before = len((await db.scalars(select(Snapshot))).all())
    resp = await _retry(client, h, failed["id"], confirm_name="uat9")
    assert _code(resp) == (409, "snapshot_slot_unreachable")
    assert len((await db.scalars(select(Snapshot))).all()) == before


async def test_a_delete_retried_after_the_snapshot_keeps_it(client, db, ready,
                                                           fake_provisioner):
    env = await ready()
    await _deployed(db, env)
    h = await auth_headers(client, db)
    fake_provisioner.fail["do_destroy"] = "DigitalOcean said no."
    failed = (await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")).json()
    dep = await _dep(db, failed["id"])
    assert (dep.status, dep.failed_step) == ("failed", 18), failed
    snap = await db.get(Snapshot, dep.snapshot_id, populate_existing=True)
    assert snap.status == "ready"
    del fake_provisioner.fail["do_destroy"]
    resp = await _retry(client, h, dep.id, confirm_name="uat9")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [(s["key"], s["status"]) for s in body["steps"]][0] == ("export", "skipped")
    assert body["snapshot"]["id"] == str(snap.id)
    assert (await db.scalars(select(Snapshot))).all() == [snap]
    assert await _dep(db, body["id"]) is None and await _gone(db, env)


async def test_take_snapshot_reads_the_live_slot(client, db, ready):
    env = await ready()
    await _deployed(db, env, active="purple")
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/uat9/snapshots", headers=h, json={"name": "uat9-manual"})
    assert resp.status_code == 201, resp.text
    dep = resp.json()["deployment"]
    await pipeline.wait(uuid.UUID(dep["id"]))
    assert (dep["cloud"], dep["slot"], dep["go_live"]) == (True, "purple", False)
    assert [s["key"] for s in dep["steps"]] == ["preflight", "export"]


async def test_take_snapshot_with_no_droplet(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id,
                                          DoSlot.slot == "orange").values(public_ip=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/uat9/snapshots", headers=h, json={"name": "uat9-manual"})
    assert _code(resp) == (409, "do_not_ready")


async def test_backups_before_any_droplet(client, db, ready):
    """A built target with no droplet yet has nothing to list (not 400)."""
    await ready(built=False)
    h = await auth_headers(client, db)
    resp = await client.get(f"{URL}/uat9/backups", headers=h)
    assert (resp.status_code, resp.json()) == (200, {"backups": []})


# ---- the phase review ----------------------------------------------------------------

NEW = "f00d" * 10


async def test_a_seeded_first_deploy_that_failed_after_up_moves_on(client, db, ready,
                                                                   fake_runner,
                                                                   fake_provisioner, tmp_path):
    """The database is seeded and migrated once up ran: the next Update
    drops the seed rather than being refused (seed_not_allowed)."""
    snap = await ready_snapshot(db, tmp_path)
    env = await ready(snapshot_id=snap.id)
    h = await auth_headers(client, db)
    fake_runner.results["slot_smoke"] = RunResult(status="failed", rc=2)
    first = (await _start(client, h, "uat9", mode="update")).json()
    assert first["snapshot"]["id"] == str(snap.id)
    assert (await _dep(db, first["id"])).failed_step == 13
    del fake_runner.results["slot_smoke"]
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=NEW)
    resp = await _start(client, h, "uat9", mode="update", git_ref="v2")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["snapshot"] is None
    assert "restore" not in [s["key"] for s in body["steps"]]
    assert (await _dep(db, body["id"])).status == "succeeded"
    env = await db.get(Environment, env.id, populate_existing=True)
    assert (env.active_slot, env.current_sha) == ("orange", NEW)


async def test_a_one_slot_switch_that_fails_still_names_the_running_commit(
        client, db, ready, fake_provisioner):
    env = await ready(slots=1)
    await _deployed(db, env)
    h = await auth_headers(client, db)
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=NEW)
    fake_provisioner.fail["go_live"] = "The public smoke test failed."
    body = (await _start(client, h, "uat9", mode="update")).json()
    dep = await _dep(db, body["id"])
    assert (dep.status, dep.failed_step) == ("failed", 14)
    assert dep.error.endswith("The droplet already runs the new commit; retry Switch traffic.")
    env = await db.get(Environment, env.id, populate_existing=True)
    assert (env.current_sha, env.image_tag, env.active_slot) == (
        NEW, envfile.image_tag(NEW), "orange")


async def test_a_two_slot_switch_that_fails_keeps_the_live_commit(client, db, ready,
                                                                  fake_provisioner):
    env = await ready()
    await _deployed(db, env)
    await db.execute(update(Environment).where(Environment.id == env.id)
                     .values(auto_activate=True))
    await db.commit()
    h = await auth_headers(client, db)
    fake_provisioner.outcomes["do_prepare"] = VmOutcome(sha=NEW)
    fake_provisioner.fail["go_live"] = "The public smoke test failed. Traffic stays where it was."
    body = (await _start(client, h, "uat9", mode="update")).json()
    dep = await _dep(db, body["id"])
    assert (dep.slot, dep.go_live, dep.failed_step) == ("purple", True, 14)
    assert "already runs" not in dep.error
    env = await db.get(Environment, env.id, populate_existing=True)
    assert (env.current_sha, env.active_slot) == (SHA, "orange")


async def test_delete_when_the_snapshot_droplet_is_unreachable(client, db, ready):
    env = await ready()
    await _deployed(db, env)
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id)
                     .values(public_ip=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9")
    assert _code(resp) == (409, "snapshot_slot_unreachable")
    # Without the snapshot it goes ahead.
    resp = await _start(client, h, "uat9", mode="teardown", confirm_name="uat9",
                        snapshot=False)
    assert resp.status_code == 201, resp.text


async def test_production_delete_when_the_snapshot_droplet_is_unreachable(client, db, ready):
    env = await ready(name="prod", type_="production", account="production")
    await _deployed(db, env, active=None)
    await db.execute(update(Environment).where(Environment.id == env.id).values(retiring=True))
    await db.execute(update(DoSlot).where(DoSlot.environment_id == env.id)
                     .values(public_ip=None))
    await db.commit()
    h = await auth_headers(client, db)
    resp = await _start(client, h, "prod", mode="teardown", confirm_name="prod",
                        confirm_production=PHRASE)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "snapshot_slot_unreachable", "production": True})


async def test_create_with_an_unreadable_account_answers_409(client, db, ready, monkeypatch):
    await ready(name="uat8")                     # Cloudflare and the account saved

    async def unreadable(db_, settings, key):
        raise IntegrationError("integration_unreadable", kind="digitalocean")
    monkeypatch.setattr(do_accounts, "require", unreadable)
    h = await auth_headers(client, db)
    resp = await client.post(URL, headers=h, json={
        "mode": "new", "name": "uat9", "type": "dev", "target": "digitalocean",
        "do": {"account": "development", "slots": 2}})
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_unreadable", "kind": "digitalocean"})
