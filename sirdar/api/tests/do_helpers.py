"""DigitalOcean for tests: the fakes wired into outbound.transports() (one
fixture for every outbound kind a DigitalOcean environment uses) and saved
accounts."""

import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import do_accounts, outbound

from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN, FakeDigitalOcean
from .fake_spaces import FakeSpaces


class Cloud:
    """The fakes one test talks to; `smoke` is any MockTransport the test sets."""

    def __init__(self):
        self.do = FakeDigitalOcean()
        self.spaces = FakeSpaces(self.do)
        self.acme = None
        self.cloudflare = None
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
