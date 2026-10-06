"""Sirdar's backup certificate renewal for DigitalOcean environments (deploy
phase 7): every few hours, a `renew` deployment (step 19) for each
environment whose load balancer certificate has certs.SIRDAR_RENEW_DAYS (14)
or fewer days left and that isn't deploying. A deployment, so it shares the
one-running-deployment lock with Activate, keeps a log and an audit row, and
can be retried. The cert-worker on the live droplet renews first (at 30
days); this catches what it missed."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import Deployment, DoEnvironment, DoResource, Environment
from sirdar_api.deploy import certs, do_accounts, do_api, environments, pipeline
from sirdar_api.deploy.do_provision import https_certificate
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)
FIRST_DELAY_SECONDS = 5 * 60
# A renew that failed is tried again only after this long (its log says why).
BACKOFF = timedelta(hours=24)


async def served_not_after(db: AsyncSession, row: DoEnvironment) -> datetime | None:
    """When the certificate the environment's load balancer serves now
    expires, read from DigitalOcean; None when Sirdar can't tell (no load
    balancer recorded, no token, DigitalOcean unreachable)."""
    lb_id = await db.scalar(select(DoResource.do_id).where(
        DoResource.environment_id == row.environment_id,
        DoResource.kind == "load_balancer").limit(1))
    if lb_id is None:
        return None
    try:
        account = await do_accounts.load(db, get_settings(), row.account_key)
        if account is None:
            return None
        async with do_api.connect(account.token) as api:
            lb = await api.load_balancer(lb_id)
            cert_id = https_certificate(lb) if lb else None
            cert = await api.certificate(cert_id) if cert_id else None
    # Any failure means "can't tell": the stored date decides. Never its text.
    except Exception as e:  # noqa: BLE001
        log.warning("couldn't read a load balancer's certificate: %s", type(e).__name__)
        return None
    return certs.not_after(cert) if cert else None


async def _latest(db: AsyncSession, env_id, *, renew: bool) -> Deployment | None:
    mode = Deployment.mode == "renew" if renew else Deployment.mode != "renew"
    return await db.scalar(select(Deployment).where(Deployment.environment_id == env_id, mode)
                           .order_by(Deployment.created_at.desc()).limit(1))


async def _held_back(db: AsyncSession, env_id, now: datetime) -> bool:
    """Deploying; half deleted (its latest deployment other than a renew is
    a Delete that didn't finish); or its latest renew failed within a day."""
    if await environments.is_deploying(db, env_id):
        return True
    last = await _latest(db, env_id, renew=False)
    if last is not None and last.mode == "teardown" \
            and last.status in pipeline.RETRYABLE_STATUSES:
        return True
    renew = await _latest(db, env_id, renew=True)
    if renew is not None and renew.status == "failed":
        when = renew.finished_at or renew.started_at
        if when is not None and when > now - BACKOFF:
            return True
    return False


async def due(db: AsyncSession, now: datetime) -> list[Environment]:
    """Deployed DigitalOcean environments, ready or failed and not held back,
    whose served certificate has certs.SIRDAR_RENEW_DAYS or fewer days left.
    The served certificate's date (when DigitalOcean answers) also becomes
    cert_not_after, so a cert-worker renewal starts no job; the caller
    commits."""
    rows = await db.execute(
        select(Environment, DoEnvironment)
        .join(DoEnvironment, DoEnvironment.environment_id == Environment.id)
        .where(Environment.current_sha.is_not(None),
               Environment.status.in_(("ready", "failed")))
        .order_by(Environment.name))
    found: list[Environment] = []
    limit = now + timedelta(days=certs.SIRDAR_RENEW_DAYS)
    for env, row in rows.all():
        if await _held_back(db, env.id, now):
            continue
        served = await served_not_after(db, row)
        if served is not None and served != row.cert_not_after:
            row.cert_not_after = served
        when = served or row.cert_not_after
        if when is not None and when <= limit:
            found.append(env)
    return found


async def start_due(now: datetime | None = None) -> list[str]:
    """Start a renew deployment for each environment that needs one; the
    names started."""
    now = now or datetime.now(UTC)
    started: list[str] = []
    async with get_sessionmaker()() as db:
        for env in await due(db, now):
            name = env.name
            try:
                dep = await pipeline.create_deployment(
                    db, env, mode="renew", git_ref=env.git_ref, sha=env.current_sha,
                    actor_id=None, cloud=True)
            except pipeline.DeployInProgress:      # one started meanwhile: next round
                continue
            audit(db, actor_id=None, action="deploy.certificate_renew", entity_type="deployment",
                  entity_id=str(dep.id), changes={"environment": name})
            await db.commit()
            pipeline.launch(dep.id)
            started.append(name)
        await db.commit()                          # dates due() brought up to date
    return started


async def loop(seconds: int) -> None:
    """The app's background check (api/app.py): cancelled on shutdown."""
    await asyncio.sleep(FIRST_DELAY_SECONDS)
    while True:
        try:
            names = await start_due()
            if names:
                log.info("certificate renewals started: %s", ", ".join(names))
        # A database hiccup must not end the loop; never log its text.
        except Exception as e:  # noqa: BLE001
            log.warning("certificate renewal check failed: %s", type(e).__name__)
        await asyncio.sleep(seconds)
