"""The two DigitalOcean accounts Sirdar builds environments in (deploy phase
7): "production" and "development", each with a label, a default region, an
API token and the renewal token droplets get (a custom-scoped token Jimmy
makes by hand in the control panel: certificate create/read/delete and
load_balancer read/update). Both tokens are Fernet-encrypted with
SIRDAR_SECRETS_KEY and write-only. SIRDAR_DEPLOY_DO_TOKEN (and _REGION) stay
the Production account's fallback.

An environment is built in one account and stays there: a token from
another DigitalOcean team is refused while environments use the account, and
the same token can't be both accounts. Errors are IntegrationError (codes
only, never values). Callers audit and commit."""

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import DoAccount, DoEnvironment, Environment, User
from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, do_api, integrations, vault
from sirdar_api.deploy.integrations import IntegrationError

log = logging.getLogger(__name__)

KEYS = ("production", "development")
DEFAULT_LABELS = {"production": "Production", "development": "Development"}
_REGION_RE = re.compile(r"[a-z]{3}[0-9]")
_LABEL_BAD = re.compile(r"[\x00-\x1f\x7f]")
_NO_TEAM = "DigitalOcean didn't say which team this token belongs to."
_UNEXPECTED = "DigitalOcean sent a response Sirdar didn't understand."


@dataclass(frozen=True)
class Account:
    key: str
    label: str
    region: str | None
    team_uuid: str | None
    token: str = field(repr=False)
    renewal_token: str | None = field(default=None, repr=False)
    source: str = "stored"          # "stored" | "environment" (SIRDAR_DEPLOY_DO_TOKEN)


def check_key(key) -> str:
    if key not in KEYS:
        raise IntegrationError("do_account_invalid")
    return key


def check_label(value) -> str:
    label = str(value or "").strip()
    if not 1 <= len(label) <= 40 or _LABEL_BAD.search(label):
        raise IntegrationError("label_invalid")
    return label


def check_region(value) -> str | None:
    region = str(value or "").strip().lower()
    if not region:
        return None
    if not _REGION_RE.fullmatch(region):
        raise IntegrationError("region_invalid")
    return region


def check_token(value, code: str = "do_token_invalid") -> str:
    try:
        return integrations.check_secret("digitalocean", value)
    except IntegrationError:
        raise IntegrationError(code) from None


def _other(key: str) -> str:
    return KEYS[1] if key == KEYS[0] else KEYS[0]


async def _row(db: AsyncSession, key: str) -> DoAccount:
    return await db.get(DoAccount, check_key(key), populate_existing=True)


async def lock_account(db: AsyncSession, key: str) -> DoAccount:
    """The account's row, locked FOR UPDATE until the transaction ends (an
    environment create holds it so a token save or clear can't race it)."""
    return await db.scalar(select(DoAccount).where(DoAccount.key == check_key(key))
                           .with_for_update().execution_options(populate_existing=True))


async def _lock_both(db: AsyncSession) -> dict[str, DoAccount]:
    """Both rows, locked in KEYS order (every writer takes them in this order)."""
    return {key: await lock_account(db, key) for key in KEYS}


def _decrypt(settings: Settings, blob: bytes) -> str:
    try:
        return vault.decrypt(settings, blob)
    except vault.SecretsKeyMissing:
        raise IntegrationError("secrets_key_missing") from None
    except vault.SecretUnreadable:
        raise IntegrationError("integration_unreadable", kind="digitalocean") from None


def _readable(settings: Settings, blob: bytes | None) -> str | None:
    """A stored token for a comparison; None when absent or unreadable (a
    token that won't open can't block another save; only its type is logged)."""
    if blob is None:
        return None
    try:
        return vault.decrypt(settings, blob)
    except Exception as e:
        log.warning("a stored DigitalOcean token could not be compared: %s", type(e).__name__)
        return None


def _env_token(settings: Settings, key: str) -> str | None:
    if key == "production" and settings.deploy_do_token is not None:
        return settings.deploy_do_token.get_secret_value()
    return None


def _region(settings: Settings, row: DoAccount) -> str | None:
    if row.region:
        return row.region
    if row.key == "production":
        return check_region_or_none(settings.deploy_do_region)
    return None


def check_region_or_none(value) -> str | None:
    try:
        return check_region(value)
    except IntegrationError:
        return None


async def has_token(db: AsyncSession, key: str) -> bool:
    return (await _row(db, key)).token_enc is not None


def source_of(row: DoAccount, settings: Settings) -> str | None:
    if row.token_enc is not None:
        return "stored"
    return "environment" if _env_token(settings, row.key) else None


async def load(db: AsyncSession, settings: Settings, key: str) -> Account | None:
    """The account with its tokens decrypted; None when it has no token. A
    stored token that won't decrypt raises IntegrationError: it is never
    silently replaced by SIRDAR_DEPLOY_DO_TOKEN."""
    row = await _row(db, key)
    if row.token_enc is not None:
        token, source = _decrypt(settings, row.token_enc), "stored"
    else:
        token, source = _env_token(settings, key), "environment"
    if token is None:
        return None
    renewal = _decrypt(settings, row.renewal_token_enc) if row.renewal_token_enc else None
    return Account(key=row.key, label=row.label, region=_region(settings, row),
                   team_uuid=row.team_uuid, token=token, renewal_token=renewal, source=source)


async def require(db: AsyncSession, settings: Settings, key: str) -> Account:
    account = await load(db, settings, key)
    if account is None:
        raise IntegrationError("do_account_not_configured", account=key)
    return account


async def in_use(db: AsyncSession, key: str) -> list[str]:
    """Environments built in this account (by name)."""
    return list(await db.scalars(
        select(Environment.name).join(DoEnvironment, DoEnvironment.environment_id == Environment.id)
        .where(DoEnvironment.account_key == key).order_by(Environment.name)))


async def team_of(token: str) -> tuple[str, str | None]:
    """(team uuid, team name) the token answers for; a token without a team
    gets "personal:<account uuid, else email>". ConnectFailed with our copy,
    also when DigitalOcean names neither."""
    try:
        async with do_api.connect(token) as api:
            return await read_team(api)
    except do_api.DoError as e:
        raise ConnectFailed(e.reason) from None


async def read_team(api: do_api.DigitalOceanApi) -> tuple[str, str | None]:
    """team_of through an open client: one /account read. DoError (from the
    read) and ConnectFailed (no team or owner named) propagate."""
    return _team_of_account(await api.account())


def _team_of_account(account) -> tuple[str, str | None]:
    if not isinstance(account, dict):
        raise ConnectFailed(_NO_TEAM)
    team = account.get("team") if isinstance(account.get("team"), dict) else {}
    uuid = team.get("uuid")
    if isinstance(uuid, str) and uuid:
        name = team.get("name")
        return uuid, name if isinstance(name, str) else None
    for owner in (account.get("uuid"), account.get("email")):
        if isinstance(owner, str) and owner:
            return f"personal:{owner}", None
    raise ConnectFailed(_NO_TEAM)


async def _frozen_teams(db: AsyncSession, key: str) -> set[str]:
    return {t for t in await db.scalars(select(DoEnvironment.team_uuid)
                                        .where(DoEnvironment.account_key == key)) if t}


async def save(db: AsyncSession, settings: Settings, key: str, *, label, region,
               token: str | None = None, renewal_token: str | None = None,
               clear_renewal: bool = False, actor_id=None) -> list[str]:
    """Store the label and region, and each token given (None keeps the
    stored one). Returns the names of what changed (tokens as `token` and
    `renewal_token`, never their values). May call DigitalOcean (the team
    check) when environments use the account: ConnectFailed then."""
    key, label, region = check_key(key), check_label(label), check_region(region)
    if token is not None:
        check_token(token)
    if renewal_token is not None:
        check_token(renewal_token, "renewal_token_invalid")
    if (token is not None or renewal_token is not None) and not vault.is_configured(settings):
        raise IntegrationError("secrets_key_missing")
    # DigitalOcean is asked (seconds, maybe) before the rows are locked; under
    # the lock only the database checks and the writes.
    checked = None
    if token is not None and await in_use(db, key):
        checked = await team_of(token)
    rows = await _lock_both(db)
    row, other = rows[key], rows[_other(key)]
    if token is not None or renewal_token is not None:
        other_token = _readable(settings, other.token_enc) or _env_token(settings, _other(key))
        if token is not None and token == other_token:
            raise IntegrationError("do_token_shared")
        if renewal_token is not None:
            own = token if token is not None else (
                _readable(settings, row.token_enc) or _env_token(settings, key))
            if renewal_token in (own, other_token):
                raise IntegrationError("renewal_token_shared")
    changed: list[str] = []
    if row.label != label:
        row.label = label
        changed.append("label")
    if row.region != region:
        row.region = region
        changed.append("region")
    if token is not None:
        users = await in_use(db, key)
        if users:
            if checked is None:
                # An environment started using the account after the
                # unlocked look: its team wasn't checked. Save again.
                raise IntegrationError("do_account_changed")
            team, team_name = checked
            known = await _frozen_teams(db, key) | ({row.team_uuid} if row.team_uuid else set())
            if known and team not in known:
                raise IntegrationError("do_team_changed", environments=users)
            row.team_uuid, row.team_name = team, team_name
        else:
            # Learned again by Test or the next step 0.
            row.team_uuid = row.team_name = None
        row.token_enc = vault.encrypt(settings, token)
        changed.append("token")
    if renewal_token is not None:
        row.renewal_token_enc = vault.encrypt(settings, renewal_token)
        changed.append("renewal_token")
    elif clear_renewal and row.renewal_token_enc is not None:
        row.renewal_token_enc = None
        changed.append("renewal_token")
    if changed:
        row.updated_by, row.updated_at = actor_id, datetime.now(UTC)
    await db.flush()
    return changed


async def remember_team(db: AsyncSession, key: str, team: str, name: str | None) -> None:
    row = await _row(db, key)
    row.team_uuid, row.team_name = team, name
    await db.flush()


async def clear(db: AsyncSession, key: str, *, actor_id=None) -> bool:
    """Drop both tokens (label and region stay). False (and nothing changed)
    when neither was stored."""
    row = (await _lock_both(db))[check_key(key)]
    users = await in_use(db, key)
    if users:
        raise IntegrationError("account_in_use", environments=users)
    if row.token_enc is None and row.renewal_token_enc is None:
        return False
    row.token_enc = row.renewal_token_enc = None
    row.team_uuid = row.team_name = None
    row.updated_by, row.updated_at = actor_id, datetime.now(UTC)
    await db.flush()
    return True


async def public(db: AsyncSession, settings: Settings) -> list[dict]:
    out = []
    for key in KEYS:
        row = await _row(db, key)
        by = await db.get(User, row.updated_by) if row.updated_by else None
        source = source_of(row, settings)
        out.append({"key": key, "label": row.label, "region": _region(settings, row),
                    "configured": source is not None, "token_set": row.token_enc is not None,
                    "source": source, "renewal_token_set": row.renewal_token_enc is not None,
                    "team_name": row.team_name, "environments": await in_use(db, key),
                    "updated_at": row.updated_at, "updated_by_name":
                        by.display_name if by else None})
    return out


async def _status(api: do_api.DigitalOceanApi, path: str) -> int:
    try:
        await api.call("GET", path, params={"per_page": 1})
    except do_api.DoForbidden:
        return 403
    except do_api.DoError as e:
        return e.status or 0
    return 200


async def test(db: AsyncSession, settings: Settings, key: str, *, token: str | None = None,
               renewal_token: str | None = None, region: str | None = None) -> ConnectResult:
    """Read-only checks with the given tokens, else the stored ones:
    Account, Team, Droplets, Region, Renewal token. Facts carry no secret."""
    stored = await load(db, settings, key)
    token = token if token is not None else (stored.token if stored else None)
    if token is None:
        raise IntegrationError("do_account_not_configured", account=key)
    renewal = renewal_token if renewal_token is not None else (
        stored.renewal_token if stored else None)
    region = region if region is not None else (stored.region if stored else None)
    try:
        async with do_api.connect(token) as api:
            account = await api.account()
            count = int((await api.call("GET", "/droplets", params={"per_page": 1}))
                        ["meta"]["total"])
            regions = (await api.call("GET", "/regions", params={"per_page": 200}))["regions"]
        if not isinstance(regions, list):
            raise TypeError
        team = account.get("team") if isinstance(account.get("team"), dict) else {}
        team_name = team.get("name") if isinstance(team.get("name"), str) else None
        try:
            team_uuid = _team_of_account(account)[0]
        except ConnectFailed:
            team_uuid = None
        limit = int(account.get("droplet_limit") or 0)
        status = str(account.get("status") or "")
        renewal_status = None
        if renewal is not None:
            async with do_api.connect(renewal) as api:
                renewal_status = (await _status(api, "/certificates"),
                                  await _status(api, "/load_balancers"),
                                  await _status(api, "/droplets"))
    except do_api.DoError as e:
        raise ConnectFailed(e.reason) from None
    except (KeyError, TypeError, ValueError, AttributeError):
        raise ConnectFailed(_UNEXPECTED) from None
    checks = [
        Check("Account", "pass" if status == "active" else "warn",
              f"{account.get('email')} · {status}"),
        Check("Team", "pass" if team_name else "warn", team_name or "No team"),
        Check("Droplets", "pass" if count < limit else "warn", f"{count} of {limit}"),
    ]
    match = next((r for r in regions if isinstance(r, dict) and r.get("slug") == region), None)
    if region is None:
        checks.append(Check("Region", "warn", "Not set"))
    else:
        ok = bool(match and match.get("available"))
        checks.append(Check("Region", "pass" if ok else "fail",
                            f"{region} available" if ok else f"{region} not available"))
    if renewal_status is None:
        checks.append(Check("Renewal token", "warn",
                            "Not set: Sirdar can't build environments in this account yet."))
    else:
        certs, lbs, droplets = renewal_status
        if certs != 200 or lbs != 200:
            checks.append(Check("Renewal token", "fail",
                                "It can't read certificates and load balancers."))
        elif droplets == 200:
            checks.append(Check("Renewal token", "warn",
                                "It can read droplets; give it only the certificate and load "
                                "balancer scopes."))
        else:
            checks.append(Check("Renewal token", "pass", "Certificates and load balancers only"))
    facts = {"email": account.get("email"), "team_name": team_name, "team_uuid": team_uuid,
             "region": region, "droplet_count": count, "droplet_limit": limit}
    return ConnectResult(ok=True, target="digitalocean", checks=checks, facts=facts)


test.__test__ = False   # not a pytest test, despite the name
