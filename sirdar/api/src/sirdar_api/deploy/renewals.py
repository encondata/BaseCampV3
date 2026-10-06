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

from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import DoEnvironment, Environment
from sirdar_api.deploy import certs, environments, pipeline
from sirdar_api.services.audit import audit

log = logging.getLogger(__name__)
FIRST_DELAY_SECONDS = 5 * 60


async def due(db: AsyncSession, now: datetime) -> list[Environment]:
    """Deployed DigitalOcean environments, ready or failed, whose certificate
    is due and that aren't deploying."""
    rows = await db.scalars(
        select(Environment).join(DoEnvironment, DoEnvironment.environment_id == Environment.id)
        .where(DoEnvironment.cert_not_after.is_not(None),
               DoEnvironment.cert_not_after <= now + timedelta(days=certs.SIRDAR_RENEW_DAYS),
               Environment.current_sha.is_not(None),
               Environment.status.in_(("ready", "failed")))
        .order_by(Environment.name))
    return [env for env in rows if not await environments.is_deploying(db, env.id)]


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
