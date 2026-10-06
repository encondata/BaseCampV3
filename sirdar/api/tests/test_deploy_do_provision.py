"""Step 0, Prepare DigitalOcean, against FakeDigitalOcean, FakeSpaces,
FakeAcme and FakeCloudflare, with the tests' SSH server playing the
droplets: it builds everything once, records it the moment it exists, does
nothing the second time, finds lost droplets by their tag, refuses what no
longer matches, and keeps every secret out of its log."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import DoEnvironment, DoResource, DoSlot, EnvironmentSecret
from sirdar_api.deploy import do_envs, known_hosts, vault, vmcommon, vms
from sirdar_api.deploy.publish import StepFailed
from sirdar_api.deploy.vmcommon import VmPrepareError

from .deploy_factories import ENV_SECRETS, secrets_key  # noqa: F401
from .do_helpers import SHA, deploy_env, do_build, do_cloud, ssh_server  # noqa: F401
from .fake_digitalocean import (
    CA_PEM,
    DB_ADMIN_PASSWORD,
    DEV_RENEW_TOKEN,
    DEV_TOKEN,
    LB_IP,
)


async def _kinds(db, env_id) -> list[tuple[str, str | None]]:
    rows = await db.scalars(select(DoResource).where(DoResource.environment_id == env_id))
    return sorted((r.kind, r.slot) for r in rows)


async def _db_password(db, env_id) -> str:
    row = await db.get(EnvironmentSecret, (env_id, "POSTGRES_PASSWORD"), populate_existing=True)
    return vault.decrypt(get_settings(), row.value_enc)


async def _secrets(db, b, *more) -> list[str]:
    """Every secret step 0 handles: tokens, the doadmin and app passwords, the
    environment's SSH key, the slots' host keys and whatever the test adds."""
    settings = get_settings()
    row = await db.get(DoEnvironment, b.env.id, populate_existing=True)
    keys = [vault.decrypt(settings, row.ssh_private_key_enc)]
    for slot in (await do_envs.slots_of(db, b.env.id)).values():
        if slot.host_key_private_enc is not None:
            keys.append(vault.decrypt(settings, slot.host_key_private_enc))
    keys += [b.host_key_private, b.host_key_private.splitlines()[1]]
    return [DEV_TOKEN, DEV_RENEW_TOKEN, DB_ADMIN_PASSWORD, await _db_password(db, b.env.id),
            *[k for k in keys if k], *more]


async def test_the_first_run_builds_everything(db, do_build):
    b, fake = do_build, do_build.cloud.do
    outcome = await b.run()
    assert outcome.sha == SHA
    env_tag = do_envs.env_tag(b.env.id)
    # One of each, recorded.
    assert await _kinds(db, b.env.id) == [
        ("bucket", None), ("certificate", None), ("database", None), ("droplet", "orange"),
        ("droplet", "purple"), ("firewall", None), ("load_balancer", None), ("spaces_key", None),
        ("vpc", None)]
    droplets = sorted(fake.droplets.values(), key=lambda d: d["name"])
    assert [d["name"] for d in droplets] == ["ss-uat9-orange", "ss-uat9-purple"]
    assert all(env_tag in d["tags"] and "sirdar" in d["tags"] for d in droplets)
    assert "sirdar-slot:orange" in droplets[0]["tags"]
    assert "postgresql-client" in droplets[0]["_user_data"]
    (database,) = fake.databases.values()
    assert (database["version"], database["num_nodes"], database["size"]) == (
        "16", 1, "db-s-2vcpu-4gb")
    assert database["private_network_uuid"] == next(iter(fake.vpcs))
    assert sorted(r["value"] for r in fake.db_rules[database["id"]]) == sorted(
        str(d["id"]) for d in droplets)
    (key,) = fake.keys.values()                                   # the setup key is gone
    assert key["grants"] == [{"bucket": b.env.spaces_bucket, "permission": "readwrite"}]
    assert b.env.spaces_bucket in b.cloud.spaces.buckets
    (cert,) = fake.certificates.values()
    assert sorted(cert["dns_names"]) == sorted(
        f"{s}.uat9.serversherpa.com" for s in ("api", "portal", "kiosk", "wiki", "status"))
    (lb,) = fake.load_balancers.values()
    assert lb["droplet_ids"] == [] and lb["vpc_uuid"] == database["private_network_uuid"]
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert (https["certificate_id"], https["target_port"]) == (cert["id"], 80)
    assert lb["health_check"]["path"] == "/healthz"
    (fw,) = fake.firewalls.values()
    assert fw["tags"] == [env_tag]
    port80 = next(r for r in fw["inbound_rules"] if r["ports"] == "80")
    assert port80["sources"] == {"load_balancer_uids": [lb["id"]]}
    row = await db.get(DoEnvironment, b.env.id, populate_existing=True)
    assert (row.lb_ip, row.vpc_ip_range, row.team_uuid, row.db_port) == (
        LB_IP, "10.116.0.0/20", "team-dev-0002", 25060)
    assert row.db_host.startswith("private-ss-uat9-db") and row.spaces_key_id == key["access_key"]
    assert row.cert_not_after is not None
    slots = (await db.scalars(select(DoSlot).where(DoSlot.environment_id == b.env.id)
                              .execution_options(populate_existing=True))).all()
    assert all(s.droplet_id and s.public_ip == "127.0.0.1" and s.host_key_private_enc is None
               for s in slots)
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is not None
    # The role's password reached the droplet only as a SCRAM verifier, on stdin.
    sql = [c for c in b.remote.calls if "exec psql" in c[1]]
    assert len(sql) == 1
    host, command, stdin = sql[0]
    assert stdin.startswith(DB_ADMIN_PASSWORD + "\n") and "SCRAM-SHA-256$4096:" in stdin
    password = await _db_password(db, b.env.id)
    assert ENV_SECRETS["POSTGRES_PASSWORD"] not in stdin and password not in stdin
    assert DB_ADMIN_PASSWORD not in command and password not in command
    assert all(password not in c[1] and DB_ADMIN_PASSWORD not in c[1] for c in b.remote.calls)
    log = b.log()
    for secret in await _secrets(db, b, key["secret_key"]):
        assert secret not in log
    assert CA_PEM.strip() not in log
    assert "Created the VPC ss-uat9" in log and "Load balancer ss-uat9-lb: active" in log


async def test_a_second_run_changes_nothing(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    before = len(fake.writes())
    await do_build.run()
    assert fake.writes()[before:] == []
    assert "in place" in do_build.log()


async def test_a_lost_droplet_record_is_found_by_its_tag(db, do_build):
    await do_build.run()
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "droplet",
                                                         DoResource.slot == "purple"))
    await db.commit()
    count = len(do_build.cloud.do.droplets)
    await do_build.run()
    assert len(do_build.cloud.do.droplets) == count
    assert ("droplet", "purple") in await _kinds(db, do_build.env.id)
    assert "found it by its tag" in do_build.log()


async def test_a_droplet_that_lost_its_tag_stops_the_step(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    droplet = next(d for d in fake.droplets.values() if d["name"] == "ss-uat9-orange")
    droplet["tags"] = ["someone-else"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_a_token_from_another_team_stops_the_step(db, do_build):
    await do_build.run()
    await do_envs.set_do(do_build.env.id, team_uuid="team-somewhere-else")
    before = len(do_build.cloud.do.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "another team" in err.value.reason
    assert do_build.cloud.do.writes()[before:] == []


async def test_the_database_firewall_waits_until_accepted(db, do_build):
    do_build.cloud.do.firewall_wait = 2
    await do_build.run()
    (database,) = do_build.cloud.do.databases.values()
    assert len(do_build.cloud.do.db_rules[database["id"]]) == 2


async def test_a_leftover_setup_key_is_removed(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.keys["DO00LEFT"] = {"name": "ss-uat9-setup", "access_key": "DO00LEFT",
                             "secret_key": "x", "grants": []}
    await do_envs.record(do_build.env.id, "spaces_key", "DO00LEFT", "ss-uat9-setup")
    await do_build.run()
    assert "DO00LEFT" not in fake.keys


@pytest.mark.parametrize("days, renewed", [(10, True), (20, False), (60, False)])
async def test_sirdar_renews_only_inside_14_days(db, do_build, days, renewed):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    cert["not_after"] = (datetime.now(UTC) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    await do_build.run()
    assert (len(fake.certificates) == 1) and ((cert["id"] in fake.certificates) is not renewed)
    (lb,) = fake.load_balancers.values()
    https = next(r for r in lb["forwarding_rules"] if r["entry_protocol"] == "https")
    assert https["certificate_id"] == next(iter(fake.certificates))


async def test_a_certificate_the_worker_swapped_in_is_recorded(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (lb,) = fake.load_balancers.values()
    (old,) = fake.certificates.values()
    later = datetime.strptime(old["not_after"], "%Y-%m-%dT%H:%M:%SZ") + timedelta(days=1)
    swapped = {**old, "id": "cert-from-worker", "name": "ss-uat9-209901010000",
               "not_after": later.strftime("%Y-%m-%dT%H:%M:%SZ")}
    fake.certificates["cert-from-worker"] = swapped
    for rule in lb["forwarding_rules"]:
        if rule["entry_protocol"] == "https":
            rule["certificate_id"] = "cert-from-worker"
    await do_build.run()
    rows = await db.scalars(select(DoResource.do_id).where(DoResource.kind == "certificate"))
    assert "cert-from-worker" in set(rows)
    assert "Recorded the certificate ss-uat9-209901010000" in do_build.log()


async def test_no_renewal_token_stops_before_anything(db, do_build):
    from sirdar_api.config import get_settings
    from sirdar_api.deploy import do_accounts
    await do_accounts.save(db, get_settings(), "development", label="Development",
                           region="nyc3", clear_renewal=True)
    await db.commit()
    with pytest.raises(VmPrepareError) as err:
        await do_build.run()
    assert "renewal token" in err.value.reason
    assert do_build.cloud.do.writes() == []


# ---- the team is frozen before anything is made ------------------------------------------

def _account_reads(fake) -> int:
    return sum(r.method == "GET" and r.url.path == "/v2/account" for r in fake.requests)


async def test_the_first_run_freezes_the_team_with_one_account_read(db, do_build):
    fake = do_build.cloud.do
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.team_uuid is None                    # the account was never team-checked
    await do_build.run()
    assert _account_reads(fake) == 1
    assert fake.requests[0].url.path == "/v2/account"     # before anything is made
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.team_uuid == "team-dev-0002"
    await do_build.run()
    assert _account_reads(fake) == 2
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.team_uuid == "team-dev-0002"


async def test_a_frozen_foreign_team_creates_nothing_on_the_first_run(db, do_build):
    await do_envs.set_do(do_build.env.id, team_uuid="team-somewhere-else")
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "another team" in err.value.reason
    assert do_build.cloud.do.writes() == []
    assert await _kinds(db, do_build.env.id) == []
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.team_uuid == "team-somewhere-else"


async def test_a_team_frozen_meanwhile_is_not_overwritten(db, do_build, monkeypatch):
    """Another writer froze the team between prepare() and step 0: the frozen
    value wins, and a different team is refused."""
    from sirdar_api.deploy import do_provision
    real = do_provision.prepare

    async def racing(*args, **kw):
        ctx = await real(*args, **kw)
        await do_envs.set_do(do_build.env.id, team_uuid="team-somewhere-else")
        return ctx
    monkeypatch.setattr(do_provision, "prepare", racing)
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "another team" in err.value.reason
    assert do_build.cloud.do.writes() == []
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.team_uuid == "team-somewhere-else"


# ---- recorded the moment DigitalOcean answers, adopted on retry ---------------------------

def _posts(fake, path: str) -> int:
    return sum(w == ("POST", path) for w in fake.writes())


async def test_droplets_that_never_boot_are_recorded_and_adopted(db, do_build):
    fake = do_build.cloud.do
    fake.boot_polls = 10**6
    with pytest.raises(StepFailed) as err:
        await do_build.run(prov={"waits": {"droplet": 2}})
    assert "wasn't ready" in err.value.reason
    kinds = await _kinds(db, do_build.env.id)
    assert ("droplet", "orange") in kinds and ("droplet", "purple") in kinds
    fake.boot_polls = 1
    await do_build.run()
    assert len(fake.droplets) == 2 and _posts(fake, "/droplets") == 2


async def test_a_database_that_never_comes_online_is_recorded_and_adopted(db, do_build):
    fake = do_build.cloud.do
    fake.db_polls = 10**6
    with pytest.raises(StepFailed):
        await do_build.run(prov={"waits": {"database": 2}})
    assert ("database", None) in await _kinds(db, do_build.env.id)
    fake.db_polls = 1
    await do_build.run()
    assert len(fake.databases) == 1 and _posts(fake, "/databases") == 1


async def test_a_load_balancer_that_never_activates_is_recorded_and_adopted(db, do_build):
    fake = do_build.cloud.do
    fake.lb_polls = 10**6
    with pytest.raises(StepFailed):
        await do_build.run(prov={"waits": {"lb": 2}})
    assert ("load_balancer", None) in await _kinds(db, do_build.env.id)
    fake.lb_polls = 1
    await do_build.run()
    assert len(fake.load_balancers) == 1 and _posts(fake, "/load_balancers") == 1


async def test_a_failed_bucket_create_leaves_no_setup_key(db, do_build):
    do_build.cloud.spaces.down = True
    with pytest.raises(StepFailed):
        await do_build.run()
    assert do_build.cloud.do.keys == {}
    assert [k for k, _ in await _kinds(db, do_build.env.id)] == ["vpc"]
    do_build.cloud.spaces.down = False
    await do_build.run()
    assert ("bucket", None) in await _kinds(db, do_build.env.id)


# ---- secrets stay out of failures --------------------------------------------------------

async def test_a_refused_database_setup_names_no_secret(db, do_build):
    do_build.remote.codes["exec psql"] = 3
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "psql exited 3" in err.value.reason
    text = err.value.reason + repr(err.value) + do_build.log()
    for secret in await _secrets(db, do_build):
        assert secret not in text


async def test_the_context_repr_holds_no_secret(db, do_build):
    from sirdar_api.db.models import Environment
    from sirdar_api.deploy import do_provision
    await do_build.run()
    env = await db.get(Environment, do_build.env.id, populate_existing=True)
    dep = await do_build.deployment()
    ctx = await do_provision.prepare(db, env, dep, get_settings())
    text = repr(ctx)
    for secret in await _secrets(db, do_build):
        assert secret not in text
    assert DB_ADMIN_PASSWORD in ctx.secret_values and DEV_TOKEN in ctx.secret_values


# ---- the slot's own droplet --------------------------------------------------------------

async def test_resolve_ref_uses_the_given_slot(db, do_build):
    await do_build.run()
    seen = []

    async def resolve(cfg, s, repo_url, ref):
        seen.append(cfg.key_name)
        return SHA
    await vmcommon.resolve_ref(get_settings(), resolve, env_id=do_build.env.id, git_ref="main",
                               repo_url="https://example.invalid/r.git", out=lambda _: None,
                               slot="purple")
    await vmcommon.resolve_ref(get_settings(), resolve, env_id=do_build.env.id, git_ref="main",
                               repo_url="https://example.invalid/r.git", out=lambda _: None)
    assert seen == ["Sirdar's key for ss-uat9-purple", "Sirdar's key for ss-uat9-orange"]


async def test_a_bucket_key_whose_secret_was_lost_is_replaced(db, do_build):
    """A key recorded the moment DigitalOcean made it, whose secret never
    reached do_environments (DigitalOcean shows a secret once): step 0
    deletes it and makes a new one, rather than leaving a key nobody can use."""
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = fake.keys
    await do_envs.set_do(do_build.env.id, spaces_secret_enc=None)
    await do_build.run()
    (new,) = fake.keys
    assert new != old
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.spaces_key_id == new and row.spaces_secret_enc is not None
    rows = await db.scalars(select(DoResource.do_id).where(DoResource.kind == "spaces_key"))
    assert list(rows) == [new]
    await do_build.run()
    assert list(fake.keys) == [new]
