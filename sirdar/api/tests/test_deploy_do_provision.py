"""Step 0, Prepare DigitalOcean, against FakeDigitalOcean, FakeSpaces,
FakeAcme and FakeCloudflare, with the tests' SSH server playing the
droplets: it builds everything once, records it the moment it exists, does
nothing the second time, finds lost droplets by their tag, refuses what no
longer matches, and keeps every secret out of its log."""

import base64
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
    sql = [c for c in b.remote.calls if "PGPASSFILE" in c[1]]
    assert len(sql) == 1
    host, command, stdin = sql[0]
    admin_line, ca_line, rest = stdin.split("\n", 2)
    assert admin_line == DB_ADMIN_PASSWORD and "SCRAM-SHA-256$4096:" in rest
    assert base64.b64decode(ca_line).decode() == CA_PEM          # verify-full against it
    assert "sslmode=verify-full" in command and "export PGPASSWORD" not in command
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
    do_build.remote.codes["PGPASSFILE"] = 3
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


# ---- review fixes ---------------------------------------------------------------------------

def _body(fake, method: str, path: str) -> list[dict]:
    import json
    return [json.loads(r.content) for r in fake.requests
            if r.method == method and r.url.path == "/v2" + path]


def _env_tag(b) -> str:
    return do_envs.env_tag(b.env.id)


# I1: the database is locked from creation

async def test_the_database_is_created_locked_to_the_droplets(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (body,) = _body(fake, "POST", "/databases")
    ids = sorted(str(d["id"]) for d in fake.droplets.values())
    assert sorted(r["value"] for r in body["rules"]) == ids
    assert all(r["type"] == "droplet" for r in body["rules"])
    (database,) = fake.databases.values()
    assert not [w for w in fake.writes() if w == ("PUT", f"/databases/{database['id']}/firewall")]


async def test_a_firewall_never_accepted_says_the_database_may_be_reachable(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (database,) = fake.databases.values()
    fake.db_rules[database["id"]] = []                   # drifted: open to every address
    fake.firewall_wait = 10**6
    with pytest.raises(StepFailed) as err:
        await do_build.run(prov={"waits": {"database": 3}})
    assert "may be reachable" in err.value.reason and "Retry" in err.value.reason
    puts = [w for w in fake.writes() if w == ("PUT", f"/databases/{database['id']}/firewall")]
    assert len(puts) == 3                                # sized from the database wait


async def test_a_refused_firewall_also_says_the_database_may_be_reachable(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (database,) = fake.databases.values()
    fake.db_rules[database["id"]] = []
    fake.fail[("PUT", f"/databases/{database['id']}/firewall")] = 500
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "may be reachable" in err.value.reason


# M1: untaggable resources: adopted by name only when they are plainly ours

async def _forget(db, env_id, kind):
    await db.execute(DoResource.__table__.delete().where(DoResource.environment_id == env_id,
                                                         DoResource.kind == kind))
    await db.commit()


async def test_a_lost_vpc_record_is_adopted_by_name_and_marker(db, do_build):
    await do_build.run()
    await _forget(db, do_build.env.id, "vpc")
    await do_build.run()
    fake = do_build.cloud.do
    assert len(fake.vpcs) == 1 and _body(fake, "POST", "/vpcs").__len__() == 1
    assert ("vpc", None) in await _kinds(db, do_build.env.id)
    assert "VPC ss-uat9: found it by its name" in do_build.log()


async def test_a_same_named_vpc_without_the_marker_is_refused(db, do_build):
    fake = do_build.cloud.do
    fake.vpcs["v-other"] = {"id": "v-other", "name": "ss-uat9", "region": "nyc3",
                            "description": "someone else's", "ip_range": "10.9.0.0/20",
                            "default": False}
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "ss-uat9" in err.value.reason and "isn't Sirdar's" in err.value.reason
    assert fake.writes() == []


async def test_the_fake_refuses_a_second_vpc_with_the_same_name(do_cloud):
    from sirdar_api.deploy import do_api
    async with do_api.connect(DEV_TOKEN) as api:
        await api.create_vpc("ss-dup", "nyc3", "a")
        with pytest.raises(do_api.DoError) as err:
            await api.create_vpc("ss-dup", "nyc3", "b")
    assert err.value.status == 422


async def test_a_lost_load_balancer_record_is_adopted_in_our_vpc(db, do_build):
    await do_build.run()
    await _forget(db, do_build.env.id, "load_balancer")
    await do_build.run()
    fake = do_build.cloud.do
    assert len(fake.load_balancers) == 1 and len(_body(fake, "POST", "/load_balancers")) == 1
    assert ("load_balancer", None) in await _kinds(db, do_build.env.id)


async def test_a_same_named_load_balancer_elsewhere_is_refused(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    await _forget(db, do_build.env.id, "load_balancer")
    (lb,) = fake.load_balancers.values()
    lb["vpc_uuid"] = "some-other-vpc"
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "ss-uat9-lb" in err.value.reason and "isn't in this environment's VPC" in \
        err.value.reason
    assert ("POST", "/load_balancers") not in fake.writes()[before:]


async def test_a_lost_firewall_record_is_adopted_by_its_tag(db, do_build):
    await do_build.run()
    await _forget(db, do_build.env.id, "firewall")
    await do_build.run()
    fake = do_build.cloud.do
    assert len(fake.firewalls) == 1 and len(_body(fake, "POST", "/firewalls")) == 1
    assert ("firewall", None) in await _kinds(db, do_build.env.id)


async def test_a_same_named_firewall_on_other_droplets_is_refused(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    await _forget(db, do_build.env.id, "firewall")
    (fw,) = fake.firewalls.values()
    fw["tags"] = ["someone-else"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "ss-uat9-fw" in err.value.reason
    assert fake.writes()[before:] == []


# M2/M3: both tags, and what is refused

async def test_a_foreign_untagged_droplet_named_like_ours_is_never_adopted(db, do_build):
    fake = do_build.cloud.do
    foreign = fake.add_droplet("ss-uat9-orange", ["someone-else"])
    await do_build.run()
    rows = await db.scalars(select(DoResource.do_id).where(DoResource.kind == "droplet"))
    assert str(foreign["id"]) not in set(rows)
    assert foreign["tags"] == ["someone-else"] and str(foreign["id"]) in fake.droplets


async def test_a_droplet_with_only_the_env_tag_is_refused_not_adopted(db, do_build):
    fake = do_build.cloud.do
    fake.add_droplet("ss-uat9-orange", [_env_tag(do_build)])
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "Sirdar's own tag" in err.value.reason
    assert ("POST", "/droplets") not in fake.writes()


async def test_a_recorded_droplet_without_the_sirdar_tag_is_refused(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    droplet = next(d for d in fake.droplets.values() if d["name"] == "ss-uat9-purple")
    droplet["tags"] = [t for t in droplet["tags"] if t != "sirdar"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


def _foreign_db(fake, tags):
    fake.databases["db-foreign"] = {
        "id": "db-foreign", "name": "ss-uat9-db", "engine": "pg", "version": "16",
        "status": "online", "region": "nyc3", "size": "db-s-1vcpu-1gb", "num_nodes": 1,
        "tags": tags, "private_network_uuid": None, "connection": {}, "private_connection": {},
        "_polls": 0}
    fake.db_rules["db-foreign"] = []


async def test_a_foreign_untagged_cluster_named_like_ours_is_never_adopted(db, do_build):
    fake = do_build.cloud.do
    _foreign_db(fake, ["someone-else"])
    await do_build.run()
    rows = set(await db.scalars(select(DoResource.do_id).where(DoResource.kind == "database")))
    assert "db-foreign" not in rows and len(rows) == 1
    assert fake.db_rules["db-foreign"] == []


async def test_a_cluster_with_only_the_env_tag_is_refused(db, do_build):
    fake = do_build.cloud.do
    _foreign_db(fake, [_env_tag(do_build)])
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "Sirdar's own tag" in err.value.reason
    assert ("POST", "/databases") not in fake.writes()


async def test_a_database_found_by_its_tag_is_recorded(db, do_build):
    await do_build.run()
    await _forget(db, do_build.env.id, "database")
    await do_build.run()
    fake = do_build.cloud.do
    assert len(fake.databases) == 1 and len(_body(fake, "POST", "/databases")) == 1
    assert ("database", None) in await _kinds(db, do_build.env.id)
    assert "Database ss-uat9-db: found it by its tag" in do_build.log()


async def test_a_database_that_lost_its_tag_is_refused(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (database,) = fake.databases.values()
    database["tags"] = ["sirdar"]
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "no longer carries Sirdar's tag" in err.value.reason
    assert fake.writes()[before:] == []


async def test_a_vpc_whose_marker_changed_is_refused(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (vpc,) = fake.vpcs.values()
    vpc["description"] = "edited by hand"
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "no longer looks like Sirdar's" in err.value.reason
    assert fake.writes()[before:] == []


@pytest.mark.parametrize("kind, store", [("load_balancer", "load_balancers"),
                                         ("firewall", "firewalls")])
async def test_a_renamed_load_balancer_or_firewall_is_refused(db, do_build, kind, store):
    await do_build.run()
    fake = do_build.cloud.do
    (found,) = getattr(fake, store).values()
    found["name"] = "renamed-by-hand"
    before = len(fake.writes())
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "no longer named" in err.value.reason
    assert fake.writes()[before:] == []


# M4: live checks of the bucket and the keys

async def test_a_second_run_only_reads_spaces(db, do_build):
    await do_build.run()
    seen = len(do_build.cloud.spaces.requests)
    await do_build.run()
    later = do_build.cloud.spaces.requests[seen:]
    assert [(r.method, "cors" in r.url.params) for r in later] == [("HEAD", False),
                                                                    ("GET", True)]


async def test_a_recorded_bucket_that_is_gone_is_made_again(db, do_build):
    await do_build.run()
    del do_build.cloud.spaces.buckets[do_build.env.spaces_bucket]
    await do_build.run()
    assert do_build.env.spaces_bucket in do_build.cloud.spaces.buckets
    assert "is gone; making it again" in do_build.log()
    assert len(do_build.cloud.do.keys) == 1                 # the setup key went again


async def test_a_recorded_app_key_gone_from_digitalocean_is_replaced(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = fake.keys
    del fake.keys[old]
    await do_build.run()
    (new,) = fake.keys
    assert new != old
    row = await db.get(DoEnvironment, do_build.env.id, populate_existing=True)
    assert row.spaces_key_id == new
    rows = await db.scalars(select(DoResource.do_id).where(DoResource.kind == "spaces_key"))
    assert list(rows) == [new]


async def test_a_recorded_setup_key_renamed_by_hand_is_not_deleted(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fake.keys["DO00LEFT"] = {"name": "someone-elses", "access_key": "DO00LEFT",
                             "secret_key": "x", "grants": []}
    await do_envs.record(do_build.env.id, "spaces_key", "DO00LEFT", "ss-uat9-setup")
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "DO00LEFT" in err.value.reason and "DO00LEFT" in fake.keys


async def test_a_recorded_setup_key_already_gone_is_forgotten(db, do_build):
    await do_build.run()
    await do_envs.record(do_build.env.id, "spaces_key", "DO00GONE", "ss-uat9-setup")
    await do_build.run()
    rows = set(await db.scalars(select(DoResource.do_id).where(DoResource.kind == "spaces_key")))
    assert "DO00GONE" not in rows


# M5: the cloud firewall's rules, fixed in place

def _fw(fake) -> dict:
    (fw,) = fake.firewalls.values()
    return fw


@pytest.mark.parametrize("drift", ["https", "ssh_closed", "tags", "lb_uid", "droplets"])
async def test_firewall_drift_is_fixed_in_place(db, do_build, drift):
    await do_build.run()
    fake = do_build.cloud.do
    fw = _fw(fake)
    good = {k: fw[k] for k in ("inbound_rules", "outbound_rules", "tags")}
    if drift == "https":
        fw["inbound_rules"] = fw["inbound_rules"] + [
            {"protocol": "tcp", "ports": "443", "sources": {"addresses": ["0.0.0.0/0"]}}]
    elif drift == "ssh_closed":
        fw["inbound_rules"] = [r for r in fw["inbound_rules"] if r["ports"] != "22"]
    elif drift == "tags":
        fw["tags"] = ["someone-else", _env_tag(do_build)]
    elif drift == "lb_uid":
        fw["inbound_rules"] = [r if r["ports"] != "80" else
                               {**r, "sources": {"addresses": ["0.0.0.0/0"]}}
                               for r in fw["inbound_rules"]]
    else:
        fw["droplet_ids"] = [12345]
    await do_build.run()
    fw2 = _fw(fake)
    assert fw2["id"] == fw["id"] and {k: fw2[k] for k in good} == good
    assert fw2["droplet_ids"] == []
    assert ("PUT", f"/firewalls/{fw['id']}") in fake.writes()
    assert not [w for w in fake.writes() if w[0] == "DELETE" and w[1].startswith("/firewalls")]


async def test_a_rebuilt_load_balancer_updates_the_firewall_in_place(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    fw_id = _fw(fake)["id"]
    fake.load_balancers.clear()
    await do_build.run()
    (lb,) = fake.load_balancers.values()
    port80 = next(r for r in _fw(fake)["inbound_rules"] if r["ports"] == "80")
    assert _fw(fake)["id"] == fw_id and port80["sources"] == {"load_balancer_uids": [lb["id"]]}
    assert not [w for w in fake.writes() if w[0] == "DELETE" and w[1].startswith("/firewalls")]


# M6: psql through a pgpass file and verify-full

async def test_the_psql_script_uses_a_private_pgpass_and_the_ca(tmp_path):
    import os
    import shlex as sh
    import subprocess

    from sirdar_api.deploy import do_provision
    seen = tmp_path / "seen"
    seen.mkdir()
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "psql").write_text(
        "#!/bin/bash\n"
        f'S={sh.quote(str(seen))}\n'
        'printf "%s\\n" "$@" > "$S/argv"\n'
        'env > "$S/env"\n'
        'cp "$PGPASSFILE" "$S/pgpass"\n'
        'stat -f %Lp "$PGPASSFILE" 2>/dev/null > "$S/mode" '
        '|| stat -c %a "$PGPASSFILE" > "$S/mode"\n'
        'echo "$PGPASSFILE" > "$S/path"\n'
        'for a in "$@"; do case "$a" in *sslrootcert=*) '
        'cp "${a##*sslrootcert=}" "$S/ca";; esac; done\n'
        'cat > "$S/stdin"\n'
        "exit 7\n")
    (stub / "psql").chmod(0o755)
    password = "FAKE_p:a\\ss"
    ca = "-----BEGIN CERTIFICATE-----\nMIIBca\n-----END CERTIFICATE-----\n"
    command = do_provision.psql_command("private-db.example", 25060)
    stdin = f"{password}\n{base64.b64encode(ca.encode()).decode()}\nSELECT 1;\n"
    env = {"PATH": f"{stub}:{os.environ['PATH']}", "PGPASSWORD": ""}
    done = subprocess.run(["bash", "-c", command], input=stdin, text=True, env=env,
                          capture_output=True, check=False)
    assert done.returncode == 7, done.stderr
    argv = (seen / "argv").read_text()
    assert "host=private-db.example port=25060" in argv and "sslmode=verify-full" in argv
    assert password not in argv and password not in command
    assert (seen / "pgpass").read_text() == \
        "private-db.example:25060:defaultdb:doadmin:FAKE_p\\:a\\\\ss\n"
    assert (seen / "mode").read_text().strip() == "600"
    assert (seen / "ca").read_text() == ca
    assert (seen / "stdin").read_text() == "SELECT 1;\n"
    environ = (seen / "env").read_text()
    assert "PGPASSWORD" not in environ and password not in environ
    assert not os.path.exists((seen / "path").read_text().strip())   # removed on exit


# M7: addresses are checked; a gone droplet's pin is forgotten

async def test_pinning_checks_the_address_first(db, do_build, monkeypatch):
    calls = []

    async def taken(s, settings, ip, *, proxy_ip, env_id=None):
        calls.append((ip, env_id))
        return True
    monkeypatch.setattr(vms, "address_in_use", taken)
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "127.0.0.1" in err.value.reason
    assert calls and calls[0] == ("127.0.0.1", do_build.env.id)
    assert await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT) is None


async def test_a_gone_droplets_pin_is_forgotten(db, do_build):
    from sirdar_api.db.models import SshKnownHost
    await do_build.run()
    fake = do_build.cloud.do
    await do_envs.set_slot(do_build.env.id, "orange", public_ip="203.0.113.9")
    pin = await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT)
    db.add(SshKnownHost(host="203.0.113.9", port=vms.VM_SSH_PORT, key_type=pin.key_type,
                        fingerprint_sha256=pin.fingerprint_sha256, public_key=pin.public_key))
    await db.commit()
    gone = next(k for k, d in fake.droplets.items() if d["name"] == "ss-uat9-orange")
    del fake.droplets[gone]
    await do_build.run()
    assert await known_hosts.lookup(db, "203.0.113.9", vms.VM_SSH_PORT) is None
    assert "Forgot 203.0.113.9's SSH host key" in do_build.log()


# M8: distinct host keys per slot; _ssh_remote's errors

async def test_a_droplet_answering_with_another_slots_key_is_refused(db, do_build):
    """Each slot has its own generated host key. The tests' one SSH server
    answers with orange's; purple, given a key of its own, must not be
    pinned at an address answering with orange's."""
    import asyncssh
    other = asyncssh.generate_private_key("ssh-ed25519")
    await do_envs.set_slot(do_build.env.id, "purple",
                           host_key_public=other.export_public_key("openssh").decode().strip(),
                           host_key_private_enc=vault.encrypt(
                               get_settings(), other.export_private_key("openssh").decode()))
    with pytest.raises(StepFailed) as err:
        await do_build.run()
    assert "ss-uat9-purple answered SSH with a host key Sirdar didn't generate" in \
        err.value.reason
    pin = await known_hosts.lookup(db, "127.0.0.1", vms.VM_SSH_PORT)
    assert pin.fingerprint_sha256 != known_hosts.fingerprint(other)        # orange's stays
    slots = await do_envs.slots_of(db, do_build.env.id)
    assert slots["orange"].host_key_private_enc is None
    assert slots["purple"].host_key_private_enc is not None    # never confirmed: kept


@pytest.mark.parametrize("error", ["connect", "unknown", "mismatch"])
async def test_ssh_remote_maps_errors_to_our_copy(db, monkeypatch, error):
    from sirdar_api.deploy import ConnectFailed, do_provision, ssh
    from sirdar_api.deploy.ssh import SshTargetConfig

    async def boom(cfg, s, command, *, input=None, timeout=None):
        raise {"connect": ConnectFailed("Couldn't connect to 203.0.113.9."),
               "unknown": ssh.HostKeyUnknown(cfg.host, 22, "raw-" + input, "SHA256:x"),
               "mismatch": ssh.HostKeyMismatch(cfg.host, 22, "SHA256:a", "raw-" + input,
                                               "ssh-ed25519")}[error]
    monkeypatch.setattr(ssh, "run_command", boom)
    cfg = SshTargetConfig(host="203.0.113.9", port=22, user="deploy", private_key="k",
                          key_name="n")
    with pytest.raises(StepFailed) as err:
        await do_provision._ssh_remote(cfg, "true", "s3cret-stdin")
    assert "s3cret-stdin" not in err.value.reason and "raw" not in err.value.reason
    assert "203.0.113.9" in err.value.reason


# ---- whole-phase review: CORS, firewall ports, lost creates ---------------------------------

def _origins(build) -> set[str]:
    return {f"https://{s}.uat9.serversherpa.com" for s in ("portal", "kiosk", "wiki")}


async def test_the_bucket_lets_the_apps_upload_from_the_browser(db, do_build):
    await do_build.run()
    cors = do_build.cloud.spaces.cors[do_build.env.spaces_bucket]
    (rule,) = cors
    assert set(rule["origins"]) == _origins(do_build)
    assert set(rule["methods"]) == {"GET", "HEAD", "PUT"}
    puts = len([r for r in do_build.cloud.spaces.requests
                if r.method == "PUT" and "cors" in r.url.params])
    await do_build.run()
    assert len([r for r in do_build.cloud.spaces.requests
                if r.method == "PUT" and "cors" in r.url.params]) == puts == 1
    assert "CORS" in do_build.log()


async def test_cors_falls_back_to_the_setup_key(db, do_build):
    do_build.cloud.spaces.cors_needs_fullaccess = True
    await do_build.run()
    assert do_build.env.spaces_bucket in do_build.cloud.spaces.cors
    assert "temporary full-access key" in do_build.log()
    assert not [k for k in do_build.cloud.do.keys.values() if k["name"] == "ss-uat9-setup"]


async def test_firewall_ports_all_and_0_are_the_same(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (fw,) = fake.firewalls.values()
    for rule in fw["outbound_rules"]:
        if rule.get("ports") == "all":
            rule["ports"] = "0"
        if rule["protocol"] == "icmp":
            rule["ports"] = "0"
    before = len(fake.writes())
    await do_build.run()
    assert not [w for w in fake.writes()[before:] if w[1].startswith("/firewalls")]


async def test_an_app_key_whose_create_answer_was_lost_is_replaced(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = [k for k in fake.keys.values() if k["name"] == "ss-uat9"]
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "spaces_key"))
    await db.commit()
    await do_envs.set_do(do_build.env.id, spaces_key_id=None, spaces_secret_enc=None)
    await do_build.run()
    keys = [k for k in fake.keys.values() if k["name"] == "ss-uat9"]
    assert len(keys) == 1 and keys[0]["access_key"] != old["access_key"]
    rows = (await db.scalars(select(DoResource).where(DoResource.kind == "spaces_key"))).all()
    assert [r.do_id for r in rows] == [keys[0]["access_key"]]


async def test_an_app_key_with_a_known_secret_is_adopted_by_name(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (old,) = [k for k in fake.keys.values() if k["name"] == "ss-uat9"]
    await db.execute(DoResource.__table__.delete().where(DoResource.kind == "spaces_key"))
    await db.commit()
    await do_build.run()
    keys = [k for k in fake.keys.values() if k["name"] == "ss-uat9"]
    assert [k["access_key"] for k in keys] == [old["access_key"]]
    rows = (await db.scalars(select(DoResource).where(DoResource.kind == "spaces_key"))).all()
    assert [r.do_id for r in rows] == [old["access_key"]]


async def test_a_certificate_whose_create_answer_was_lost_is_adopted(db, do_build):
    await do_build.run()
    fake = do_build.cloud.do
    (cert,) = fake.certificates.values()
    fake.certificates["lost-1"] = {**cert, "id": "lost-1", "name": "ss-uat9-20991231000000"}
    await do_build.run()
    recorded = {r.do_id for r in (await db.scalars(
        select(DoResource).where(DoResource.kind == "certificate"))).all()}
    assert set(fake.certificates) == recorded          # nothing orphaned
    assert "lost-1" not in fake.certificates           # adopted, then retired
    assert "ss-uat9-20991231000000" in do_build.log()
