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


@pytest.mark.parametrize("seconds, runs", [("60", True), ("0", False)])
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
    assert events == (["loop 60", "cancelled"] if runs else [])
