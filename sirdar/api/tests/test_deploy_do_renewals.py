"""Sirdar, the backup renewer: every few hours it starts a `renew`
deployment (step 19) for each DigitalOcean environment whose certificate has
14 days or fewer left and that isn't deploying; the step records what the
cert-worker uploaded, renews by DNS-01 only when still due, moves the load
balancer's HTTPS rule (waiting while it applies another change) and deletes
the old certificate. A renew job keeps the environment's status."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from sirdar_api.db.models import AuditLog, Deployment, DoEnvironment, Environment
from sirdar_api.deploy import pipeline, publish, renewals

from .deploy_factories import (  # noqa: F401
    fake_provisioner,
    make_environment,
    fake_publisher,
    fake_runner,
    secrets_key,
    stop_pipeline,
)
from .do_helpers import do_build, do_cloud, make_do_environment  # noqa: F401
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401
from .test_deploy_pipeline import SHA

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
pytestmark = pytest.mark.usefixtures("secrets_key", "deploy_env")


async def _env(db, name: str, *, days: int | None, deployed: bool = True) -> Environment:
    env = await make_do_environment(db, name=name, slots=1)
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        current_sha=SHA if deployed else None, status="ready",
        active_slot="orange" if deployed else None))
    await db.execute(update(DoEnvironment).where(DoEnvironment.environment_id == env.id).values(
        cert_not_after=None if days is None else NOW + timedelta(days=days)))
    await db.commit()
    return env


async def test_start_due_picks_only_what_needs_it(db, do_cloud, fake_provisioner):
    await _env(db, "soon", days=10)
    await _env(db, "later", days=20)
    await _env(db, "fresh", days=None, deployed=False)
    assert await renewals.start_due(NOW) == ["soon"]
    dep = (await db.scalars(select(Deployment).where(Deployment.mode == "renew"))).one()
    await pipeline.wait(dep.id)
    dep = await db.get(Deployment, dep.id, populate_existing=True)
    assert (dep.status, dep.cloud, dep.slot, dep.actor_id) == ("succeeded", True, None, None)
    assert fake_provisioner.calls == ["do_renew"]
    audit = (await db.scalars(select(AuditLog.changes).where(
        AuditLog.action == "deploy.certificate_renew"))).one()
    assert audit == {"environment": "soon"}
    env = (await db.scalars(select(Environment).where(Environment.name == "soon")
                            .execution_options(populate_existing=True))).one()
    assert env.status == "ready"                         # a renew job keeps the status
    assert await renewals.start_due(NOW) == ["soon"]     # due again until it renews
    later = (await db.scalars(select(Deployment).where(Deployment.mode == "renew",
                                                       Deployment.id != dep.id))).one()
    await pipeline.wait(later.id)


async def _renew_row(db, env, status: str, finished: datetime) -> None:
    db.add(Deployment(environment_id=env.id, mode="renew", git_ref="main", sha=SHA,
                      status=status, cloud=True, started_at=finished, finished_at=finished))
    await db.commit()


async def test_a_failed_renew_backs_off_for_a_day(db, do_cloud):
    env = await _env(db, "soon", days=3)
    await _renew_row(db, env, "failed", NOW - timedelta(hours=23))
    assert await renewals.start_due(NOW) == []
    await db.execute(update(Deployment).where(Deployment.mode == "renew").values(
        started_at=NOW - timedelta(hours=25), finished_at=NOW - timedelta(hours=25)))
    await db.commit()
    assert [e.name for e in await renewals.due(db, NOW)] == ["soon"]
    # a renew that succeeded since doesn't hold it back
    await _renew_row(db, env, "succeeded", NOW - timedelta(hours=1))
    assert [e.name for e in await renewals.due(db, NOW)] == ["soon"]


async def _names(db) -> list[str]:
    return [e.name for e in await renewals.due(db, NOW)]


async def test_due_wants_a_deployed_environment(db, do_cloud):
    await _env(db, "never", days=3, deployed=False)
    assert await _names(db) == []


@pytest.mark.parametrize("status, picked", [("ready", True), ("failed", True),
                                            ("deploying", False), ("deleting", False)])
async def test_due_by_status(db, do_cloud, status, picked):
    env = await _env(db, "soon", days=3)
    await db.execute(update(Environment).where(Environment.id == env.id).values(status=status))
    await db.commit()
    assert await _names(db) == (["soon"] if picked else [])


@pytest.mark.parametrize("status", ["failed", "cancelled", "interrupted"])
async def test_due_leaves_a_half_deleted_environment_alone(db, do_cloud, status):
    env = await _env(db, "gone", days=3)
    db.add(Deployment(environment_id=env.id, mode="teardown", git_ref="main", sha=SHA,
                      status=status, cloud=True))
    await db.commit()
    await _renew_row(db, env, "succeeded", NOW)       # a later renew doesn't count
    await db.execute(update(Environment).where(Environment.id == env.id).values(
        status="failed"))
    await db.commit()
    assert await _names(db) == []


async def test_due_skips_environments_off_digitalocean(db, do_cloud):
    await make_environment(db, name="lan", current_sha=SHA)
    await db.commit()
    await _env(db, "soon", days=3)
    assert await _names(db) == ["soon"]


async def test_a_failed_renew_keeps_the_status(db, do_cloud, fake_provisioner):
    await _env(db, "soon", days=3)
    fake_provisioner.fail["do_renew"] = "The load balancer is gone."
    assert await renewals.start_due(NOW) == ["soon"]
    dep = (await db.scalars(select(Deployment).where(Deployment.mode == "renew"))).one()
    await pipeline.wait(dep.id)
    dep = await db.get(Deployment, dep.id, populate_existing=True)
    assert (dep.status, dep.failed_step) == ("failed", 19)
    env = (await db.scalars(select(Environment).where(Environment.name == "soon")
                            .execution_options(populate_existing=True))).one()
    assert env.status == "ready"


async def test_a_deploying_environment_waits(db, do_cloud):
    env = await _env(db, "busy", days=5)
    db.add(Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status="running", cloud=True, slot="orange"))
    await db.commit()
    assert await renewals.start_due(NOW) == []


def test_a_renew_can_be_retried():
    from sirdar_api.api.routes import deploy
    assert "renew" in deploy.RETRY_MODES


async def test_the_loop_stops_when_cancelled_mid_sleep(monkeypatch):
    checked = asyncio.Event()

    async def check(now=None):
        checked.set()
        return []

    monkeypatch.setattr(renewals, "start_due", check)
    monkeypatch.setattr(renewals, "FIRST_DELAY_SECONDS", 0)
    task = asyncio.create_task(renewals.loop(3600))
    await asyncio.wait_for(checked.wait(), 5)
    await asyncio.sleep(0)                   # now in the 3600 s sleep
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()


def test_the_check_interval_is_off_or_at_least_five_minutes(monkeypatch):
    from pydantic import ValidationError

    from sirdar_api.config import Settings
    assert Settings(cert_check_seconds=0).cert_check_seconds == 0
    assert Settings(cert_check_seconds=300).cert_check_seconds == 300
    for bad in (-1, 1, 299):
        with pytest.raises(ValidationError):
            Settings(cert_check_seconds=bad)


async def test_the_loop_outlives_a_failed_check(monkeypatch):
    calls: list[int] = []

    async def check(now=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("database down")
        raise asyncio.CancelledError

    monkeypatch.setattr(renewals, "start_due", check)
    monkeypatch.setattr(renewals, "FIRST_DELAY_SECONDS", 0)
    with pytest.raises(asyncio.CancelledError):
        await renewals.loop(0)
    assert len(calls) == 2


@pytest.mark.parametrize("days, renewed", [(10, True), (20, False)])
async def test_the_renew_step(db, do_build, days, renewed):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert (cert["id"] in fake.certificates) is not renewed
    assert len(fake.certificates) == 1
    (lb,) = fake.load_balancers.values()
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == next(iter(fake.certificates))


async def test_the_renew_step_waits_while_the_load_balancer_applies(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    fake.lb_apply_polls = 2              # after the PUT it stays "new" for two GETs
    await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    (lb,) = fake.load_balancers.values()
    assert lb["status"] == "active"
    assert "now uses the certificate" in do_build.log()


async def test_the_renew_step_refuses_a_foreign_certificate_on_the_load_balancer(
        db, do_build, monkeypatch):
    """Read back after the PUT: something else put a certificate that isn't
    ours on the load balancer. The step fails and deletes nothing."""
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    fake.certificates["foreign-1"] = {**cert, "id": "foreign-1", "name": "someone-else"}
    real = fake._load_balancers

    def swapped(method, rest, body, request, token):
        answer = real(method, rest, body, request, token)
        if method == "PUT":
            for lb in fake.load_balancers.values():
                for rule in lb["forwarding_rules"]:
                    if rule.get("entry_protocol") == "https":
                        rule["certificate_id"] = "foreign-1"
        return answer

    monkeypatch.setattr(fake, "_load_balancers", swapped)
    with pytest.raises(publish.StepFailed) as e:
        await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert "isn't one of Sirdar's" in e.value.reason
    assert cert["id"] in fake.certificates           # the old one isn't retired


@pytest.mark.parametrize("seconds, runs", [("600", True), ("0", False)])
async def test_the_app_runs_the_loop_and_cancels_it_on_shutdown(monkeypatch, seconds, runs):
    from sirdar_api.api.app import create_app
    from sirdar_api.config import get_settings

    events: list[str] = []

    async def nothing(*a, **kw):
        return 0

    async def fake_loop(every):
        events.append(f"loop {every}")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            events.append("cancelled")
            raise

    for name in ("recover_orphans", "sweep_runs", "sweep_snapshots", "shutdown"):
        monkeypatch.setattr(pipeline, name, nothing)
    monkeypatch.setattr(renewals, "loop", fake_loop)
    monkeypatch.setenv("SIRDAR_CERT_CHECK_SECONDS", seconds)
    get_settings.cache_clear()
    app = create_app()
    async with app.router.lifespan_context(app):
        await asyncio.sleep(0)
    get_settings.cache_clear()
    assert events == (["loop 600", "cancelled"] if runs else [])


def _expires(days: float) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _live(db, do_build, days: float):
    """do_build's environment deployed, its load balancer serving a
    certificate with `days` left, and Sirdar's record saying the same."""
    from sirdar_api.deploy import certs
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = _expires(days)
    await _settle(db)
    await db.execute(update(Environment).where(Environment.id == do_build.env.id).values(
        current_sha=SHA, status="ready", active_slot="orange"))
    await db.execute(update(DoEnvironment).where(
        DoEnvironment.environment_id == do_build.env.id).values(
        cert_not_after=certs.not_after(cert)))
    await db.commit()
    return fake, cert


async def _settle(db) -> None:
    """do_build's runs leave their deployment rows running: end them (a
    running deployment keeps the environment out of due())."""
    await db.execute(update(Deployment).where(Deployment.status == "running")
                     .values(status="succeeded", finished_at=datetime.now(UTC)))
    await db.commit()


async def _stored(db, env_id):
    return await db.scalar(select(DoEnvironment.cert_not_after).where(
        DoEnvironment.environment_id == env_id).execution_options(populate_existing=True))


async def test_a_failed_renew_stays_due(db, do_build):
    """The step issued a new certificate but couldn't put it on the load
    balancer: Sirdar's record keeps the served one's date, so the next check
    tries again."""
    from sirdar_api.deploy import certs
    fake, cert = await _live(db, do_build, 10)
    (lb_id,) = fake.load_balancers
    fake.fail[("PUT", f"/load_balancers/{lb_id}")] = 422
    with pytest.raises(publish.StepFailed):
        await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert len(fake.certificates) == 2                  # issued, not served
    await _settle(db)
    assert await _stored(db, do_build.env.id) == certs.not_after(cert)
    now = datetime.now(UTC)
    assert [e.name for e in await renewals.due(db, now)] == ["uat9"]


async def test_due_reads_the_served_certificate(db, do_build):
    """The cert-worker renewed (the load balancer serves a certificate with
    80 days left) while Sirdar's record still says 10: no renew job, and the
    record catches up."""
    from sirdar_api.deploy import certs
    fake, cert = await _live(db, do_build, 10)
    cert["not_after"] = _expires(80)
    now = datetime.now(UTC)
    assert await renewals.due(db, now) == []
    await db.commit()
    assert await _stored(db, do_build.env.id) == certs.not_after(cert)
    # ...and the other way: the record says 80, the load balancer serves 10
    cert["not_after"] = _expires(10)
    assert [e.name for e in await renewals.due(db, now)] == ["uat9"]


def _swap_after_put(fake, monkeypatch, cert_id: str, upload: dict | None = None) -> None:
    """Right after Sirdar's PUT, another writer (`upload`: the cert-worker,
    with a certificate it just uploaded) moves the HTTPS rule to cert_id."""
    real = fake._load_balancers

    def swapped(method, rest, body, request, token):
        answer = real(method, rest, body, request, token)
        if method == "PUT":
            if upload is not None:
                fake.certificates[upload["id"]] = upload
            for lb in fake.load_balancers.values():
                for rule in lb["forwarding_rules"]:
                    if rule.get("entry_protocol") == "https":
                        rule["certificate_id"] = cert_id
        return answer

    monkeypatch.setattr(fake, "_load_balancers", swapped)


async def test_the_renew_step_keeps_a_newer_certificate_the_cert_worker_raced_in(
        db, do_build, monkeypatch):
    from sirdar_api.deploy import certs
    fake, old = await _live(db, do_build, 3)
    worker = {**old, "id": "worker-1", "name": "ss-uat9-209901010000",
              "not_after": "2099-01-01T00:00:00Z"}
    _swap_after_put(fake, monkeypatch, "worker-1", worker)
    await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert list(fake.certificates) == ["worker-1"]      # Sirdar's new one and the old one go
    assert "keeping that one" in do_build.log()
    assert await _stored(db, do_build.env.id) == certs.not_after(worker)


async def test_the_renew_step_refuses_an_older_certificate_put_back(db, do_build, monkeypatch):
    fake, old = await _live(db, do_build, 3)
    _swap_after_put(fake, monkeypatch, old["id"])      # something put the old one back
    with pytest.raises(publish.StepFailed) as e:
        await do_build.run("do_renew", mode="renew", slot=None, go_live=False)
    assert "older certificate" in e.value.reason
    assert len(fake.certificates) == 2                  # nothing deleted
