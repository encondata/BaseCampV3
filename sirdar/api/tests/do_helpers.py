"""DigitalOcean for tests: the fakes wired into outbound.transports() (one
fixture for every outbound kind a DigitalOcean environment uses) and saved
accounts."""

import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import do_accounts, outbound

from .fake_acme import FakeAcme
from .fake_cloudflare import FakeCloudflare
from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN, FakeDigitalOcean
from .fake_spaces import FakeSpaces


class Cloud:
    """The fakes one test talks to; `smoke` is any MockTransport the test sets."""

    def __init__(self):
        self.do = FakeDigitalOcean()
        self.spaces = FakeSpaces(self.do)
        self.cloudflare = FakeCloudflare()
        self.acme = FakeAcme(cloudflare=self.cloudflare)
        self.smoke = None

    def transports(self) -> dict:
        found = {k: None for k in outbound.KINDS}
        found["digitalocean"] = self.do.transport()
        for kind in ("spaces", "acme", "cloudflare", "smoke"):
            fake = getattr(self, kind)
            if fake is not None:
                found[kind] = fake if not hasattr(fake, "transport") else fake.transport()
        return found


@pytest.fixture
def do_cloud(monkeypatch):
    cloud = Cloud()
    monkeypatch.setattr(outbound, "transports", cloud.transports)
    return cloud


async def configure_account(db, key: str = "development", *, token: str = DEV_TOKEN,
                            region: str = "nyc3", renewal: str | None = DEV_RENEW_TOKEN,
                            label: str | None = None) -> None:
    """Save an account (needs the secrets_key fixture) and commit."""
    await do_accounts.save(db, get_settings(), key, label=label or key.title(), region=region,
                           token=token, renewal_token=renewal)
    await db.commit()


async def make_do_environment(db, *, name: str = "uat9", type_: str = "dev", slots: int = 2,
                              account: str = "development", snapshot_id=None, **do):
    """A DigitalOcean environment through environments.create_new (needs the
    secrets_key fixture). Saves Cloudflare and the account first."""
    from sirdar_api.deploy import environments, integrations

    from .fake_digitalocean import DO_TOKEN, RENEW_TOKEN
    from .integration_helpers import configure

    if not await integrations.is_configured(db, "cloudflare"):
        await configure(db, npm=False)
    if not await do_accounts.has_token(db, account):
        if account == "production":
            await configure_account(db, "production", token=DO_TOKEN, renewal=RENEW_TOKEN)
        else:
            await configure_account(db)
    env = await environments.create_new(
        db, get_settings(), name=name, type_=type_, target_id="digitalocean",
        snapshot_id=snapshot_id, do={"account": account, "slots": slots, **do})
    await db.commit()
    return env
