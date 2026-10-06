"""DigitalOcean for tests: the fakes wired into outbound.transports() (one
fixture for every outbound kind a DigitalOcean environment uses) and saved
accounts."""

from types import SimpleNamespace

import pytest

from sirdar_api.config import get_settings
from sirdar_api.deploy import do_accounts, outbound

from .deploy_factories import secrets_key  # noqa: F401
from .fake_acme import FakeAcme
from .fake_cloudflare import FakeCloudflare
from .fake_digitalocean import DEV_RENEW_TOKEN, DEV_TOKEN, FakeDigitalOcean
from .fake_spaces import FakeSpaces
from .ssh_server import ssh_server  # noqa: F401
from .test_deploy_api import deploy_env  # noqa: F401


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


SHA = "d0" * 20


class Remote:
    """Stands in for the SSH commands step 0 runs on a droplet."""

    def __init__(self):
        self.calls: list[tuple[str, str, str | None]] = []
        self.codes: dict[str, int] = {}

    async def __call__(self, cfg, command: str, stdin: str | None) -> int:
        self.calls.append((cfg.host, command, stdin))
        return next((code for key, code in self.codes.items() if key in command), 0)


async def _resolve(cfg, db, repo_url, ref):
    return SHA


async def _nap(_seconds):
    return None


class Build:
    """One DigitalOcean environment, the provisioner wired to the fakes, and
    helpers to run a step the way the pipeline would."""

    def __init__(self, db, cloud, env, settings, remote):
        # The environment's id and name only: the session's objects expire.
        self.env = SimpleNamespace(id=env.id, name=env.name, spaces_bucket=env.spaces_bucket)
        self.db, self.cloud, self.settings, self.remote = db, cloud, settings, remote
        self.lines: list[str] = []
        self.host_key_private = ""

    def provisioner(self, **kw):
        from sirdar_api.deploy import do_provision
        base = dict(settings=self.settings, sleep=_nap, poll=0, resolve=_resolve,
                    remote=self.remote, dns_wait=0, smoke_attempts=1, smoke_delay=0)
        return do_provision.DoProvisioner(**{**base, **kw})

    async def deployment(self, *, mode="update", slot="orange", go_live=True):
        from sqlalchemy import update

        from sirdar_api.db.models import Deployment
        # The pipeline's one-running lock: the previous run is over.
        await self.db.execute(update(Deployment).where(
            Deployment.environment_id == self.env.id, Deployment.status == "running")
            .values(status="succeeded"))
        dep = Deployment(environment_id=self.env.id, mode=mode, git_ref="main", sha="",
                         status="running", start_step=0, cloud=True, slot=slot,
                         go_live=go_live)
        self.db.add(dep)
        await self.db.commit()
        return dep

    async def run(self, step="do_prepare", *, prov: dict | None = None, **kw):
        from sirdar_api.db.models import Environment
        from sirdar_api.deploy import do_provision
        self.db.expire_all()
        env = await self.db.get(Environment, self.env.id)
        dep = await self.deployment(**kw)
        ctx = await do_provision.prepare(self.db, env, dep, self.settings)
        return await self.provisioner(**(prov or {})).run(step, ctx, self.lines.append)

    def log(self) -> str:
        return "".join(self.lines)


@pytest.fixture
async def do_build(db, do_cloud, secrets_key, ssh_server, monkeypatch, deploy_env):
    """uat9 (orange + purple) on DigitalOcean in the Development account. The
    tests' SSH server plays every droplet at 127.0.0.1, with the host key
    Sirdar 'generated' (the server's own)."""
    from sirdar_api.deploy import vms
    key = ssh_server.host_key
    private = key.export_private_key("openssh").decode()   # once: the export is salted
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    monkeypatch.setattr(vms, "new_host_keypair", lambda name: (
        private, key.export_public_key("openssh").decode().strip()))
    env = await make_do_environment(db)
    build = Build(db, do_cloud, env, get_settings(), Remote())
    build.host_key_private = private
    return build
