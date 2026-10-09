"""Certificates for DigitalOcean environments (deploy phase 7): Sirdar
issues the first one, and is the backup renewer, by DNS-01 through the
Cloudflare integration; the environment's cert-worker (7b) renews by
HTTP-01. A certificate is uploaded to DigitalOcean as a custom certificate
named ss-<env>-<UTC yyyymmddhhmm> covering exactly public_names(env) (the
running apps' names and, outside production, the bare name).

Sirdar's ACME account key (one per directory) is kept Fernet-encrypted in
acme_accounts. Errors are CertError with our own copy."""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert

from sirdar_api.config import Settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.db.models import AcmeAccount
from sirdar_api.deploy import acme, home, outbound, vault
from sirdar_api.deploy import apps as app_rules
from sirdar_api.deploy.cloudflare import Cloudflare, CloudflareError
from sirdar_api.deploy.integrations import CloudflareConfig

SIRDAR_RENEW_DAYS = 14
WORKER_RENEW_DAYS = 30
DNS_WAIT = 15                     # seconds for Cloudflare's answer to settle
PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "status")
CHALLENGE_COMMENT = "Managed by Sirdar (ACME challenge)"


class CertError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def public_hosts(env) -> tuple[tuple[str, str], ...]:
    """(service, hostname) a droplet environment serves: its running apps'
    names, then the bare name (home) unless it is production. The
    certificate, the cert-worker (SS_CERT_NAMES) and the load balancer's
    smoke test all use this list."""
    found = [(s, f"{s}.{env.base_domain}") for s in PUBLIC_SERVICES
             if app_rules.is_public(env, s)]
    if home.wants_home(env):
        found.append((home.HOME, home.home_hostname(env)))
    return tuple(found)


def public_names(env) -> tuple[str, ...]:
    return tuple(name for _, name in public_hosts(env))


def cert_name(env_name: str, now: datetime) -> str:
    return f"ss-{env_name}-{now.astimezone(UTC):%Y%m%d%H%M}"


def is_ours(cert: dict, env_name: str, names) -> bool:
    """A DigitalOcean certificate named for this environment that covers
    exactly its public names (what Sirdar or its cert-worker uploads)."""
    if not isinstance(cert, dict):
        return False
    found = cert.get("dns_names")
    return (isinstance(cert.get("name"), str) and cert["name"].startswith(f"ss-{env_name}-")
            and isinstance(found, list) and sorted(found) == sorted(names))


def not_after(cert: dict) -> datetime | None:
    try:
        return datetime.strptime(str(cert.get("not_after")),
                                 "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None


def days_left(when: datetime, now: datetime) -> float:
    return (when - now).total_seconds() / 86400


async def _load_account(directory: str) -> AcmeAccount | None:
    async with get_sessionmaker()() as s:
        return await s.get(AcmeAccount, directory)


async def _insert_account(directory: str, key_enc: bytes) -> None:
    """Insert unless another task got there first (then its key wins)."""
    async with get_sessionmaker()() as s:
        await s.execute(pg_insert(AcmeAccount).values(directory=directory, key_enc=key_enc)
                        .on_conflict_do_nothing(index_elements=["directory"]))
        await s.commit()


async def _account_key(settings: Settings, directory: str) -> tuple[str, str | None]:
    """Sirdar's account key for `directory` (made on first use) and its kid."""
    try:
        row = await _load_account(directory)
        if row is None:
            await _insert_account(directory, vault.encrypt(settings, acme.new_key_pem()))
            row = await _load_account(directory)
        return vault.decrypt(settings, row.key_enc), row.kid
    except vault.SecretsKeyMissing:
        raise CertError("Set SIRDAR_SECRETS_KEY before Sirdar can keep an ACME account "
                        "key.") from None
    except vault.SecretUnreadable:
        raise CertError("Sirdar's ACME account key doesn't open with the current "
                        "SIRDAR_SECRETS_KEY.") from None


async def _remember_kid(directory: str, kid: str) -> None:
    async with get_sessionmaker()() as s:
        row = await s.get(AcmeAccount, directory)
        row.kid = kid
        await s.commit()


def dns01_solver(api: Cloudflare, *, sleep, wait: float, out) -> acme.Solver:
    @asynccontextmanager
    async def solve(kind: str, name: str, token: str, key_auth: str):
        record = await api.create_record("TXT", f"_acme-challenge.{name}",
                                         acme.dns01_value(key_auth), comment=CHALLENGE_COMMENT)
        out(f"{name}: DNS challenge record added\n")
        try:
            await sleep(wait)
            yield
        finally:
            try:
                await api.delete(record.id)
            except CloudflareError:
                out(f"{name}: couldn't remove the DNS challenge record; it stays in "
                    "Cloudflare\n")
    return solve


async def issue_dns01(settings: Settings, *, names, directory: str,
                      cloudflare: CloudflareConfig, out, sleep=asyncio.sleep,
                      dns_wait: float = DNS_WAIT, poll: float = acme.POLL_SECONDS
                      ) -> acme.Issued:
    key_pem, kid = await _account_key(settings, directory)
    transports = outbound.transports()
    try:
        async with Cloudflare(cloudflare, transport=transports.get("cloudflare")) as cf, \
                acme.AcmeClient(directory, key_pem, kid=kid, transport=transports.get("acme"),
                                sleep=sleep, poll=poll) as client:
            issued = await acme.issue(client, names, "dns-01",
                                      dns01_solver(cf, sleep=sleep, wait=dns_wait, out=out))
            if client.kid != kid:
                await _remember_kid(directory, client.kid)
    except CloudflareError as e:
        raise CertError(e.reason) from None
    except acme.AcmeError as e:
        raise CertError(e.reason) from None
    return issued
