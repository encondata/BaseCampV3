"""Publishing through Switchyard (Environment.proxy "switchyard"): step 13's
hosts, one apply per change set, the wait for Caddy's certificates, the
status preview, claims, and removal. FakeSwitchyard stands in for the API."""

import pytest
from sqlalchemy import select, update

from sirdar_api.config import get_settings
from sirdar_api.db.models import Environment, ManagedRecord
from sirdar_api.deploy import publish, switchyard
from sirdar_api.deploy.publish import DNS, PROXY, SY_HOST, StepFailed

from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import CF_TOKEN, NPM_PASSWORD, SY_KEY, configure
from .publish_helpers import managed, publish_fakes, sp  # noqa: F401

PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096, "learn": 8092,
         "spaces": 9000, "status": 8095}
NAMES = sorted(f"{s}.uat2.serversherpa.com" for s in PORTS)
HOME = "uat2.serversherpa.com"


@pytest.fixture
async def env(db, secrets_key, publish_fakes):  # noqa: F811
    await configure(db, switchyard=True)
    return await make_environment(db, name="uat2", host="10.10.48.63", proxy="switchyard")


def _publisher(sleeps=None) -> publish.HttpPublisher:
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)
    return publish.HttpPublisher(sleep=sleep)


async def _run(db, env, step, publisher=None) -> list[str]:
    ctx = await publish.prepare(db, env, get_settings())
    lines: list[str] = []
    await (publisher or _publisher()).run(step, ctx, lines.append)
    text = "".join(lines)
    assert SY_KEY not in text and CF_TOKEN not in text and NPM_PASSWORD not in text
    return lines


async def _rows(db) -> list[tuple]:
    rows = await db.scalars(select(ManagedRecord)
                            .order_by(ManagedRecord.service, ManagedRecord.kind)
                            .execution_options(populate_existing=True))
    return [(r.service, r.kind, r.external_id, r.origin) for r in rows]


def _by_name(fake) -> dict[str, dict]:
    return {h["domains"][0]: h for h in fake.hosts.values()}


def _writes(fake) -> list[tuple[str, str]]:
    return [(r.method, r.url.path) for r in fake.requests if r.method != "GET"]


# ---- the context ---------------------------------------------------------------------

async def test_prepare_loads_switchyard_and_hides_its_key(db, env):
    ctx = await publish.prepare(db, env, get_settings())
    assert ctx.proxy == "switchyard" and ctx.switchyard.url == "https://switchyard.lan:8443"
    assert SY_KEY in ctx.secret_values
    assert SY_KEY not in repr(ctx)


async def test_proxy_of(db, secrets_key):  # noqa: F811
    lan = await make_environment(db, name="a")
    sy = await make_environment(db, name="b", proxy="switchyard")
    cloud = await make_environment(db, name="c", target_id="digitalocean")
    assert [publish.proxy_of(e) for e in (lan, sy, cloud)] == ["npm", "switchyard", None]


async def test_missing_integrations_names_the_environments_proxy(db, secrets_key):  # noqa: F811
    await configure(db, switchyard=False)
    env = await make_environment(db, name="uat2", proxy="switchyard")
    assert await publish.missing_integrations(db, env) == ["switchyard"]
    await managed(db, env, "api", SY_HOST, 4)
    assert await publish.missing_integrations(db, env, teardown=True) == ["switchyard"]


# ---- step 13 -----------------------------------------------------------------------------

async def test_proxy_creates_hosts_applies_once_and_waits_for_certificates(db, env,
                                                                         publish_fakes):
    fake = publish_fakes.sy
    lines = await _run(db, env, "proxy")
    hosts = _by_name(fake)
    assert sorted(hosts) == NAMES
    for service, port in PORTS.items():
        h = hosts[f"{service}.uat2.serversherpa.com"]
        assert (h["type"], h["enabled"], h["tls_mode"], h["force_https"], h["hsts"]) == (
            "proxy", True, "auto", True, False)
        assert h["upstreams"] == [{"scheme": "http", "host": "10.10.48.63", "port": port,
                                   "skip_tls_verify": False}]
        assert h["notes"] == f"Managed by Sirdar: uat2 ({env.id})"
        assert h["advanced_json"] == ""              # spaces: Caddy has no body-size cap
    assert fake.applies == ["Sirdar: uat2 proxy hosts"]
    assert fake.applied.keys() == fake.hosts.keys()
    assert lines[0] == "api.uat2.serversherpa.com: created a Switchyard host (10.10.48.63:8000)\n"
    assert "Applied in Switchyard: Sirdar: uat2 proxy hosts\n" in lines
    assert [(s, k, o) for s, k, _, o in await _rows(db)] == sorted(
        (s, SY_HOST, "created") for s in PORTS)
    # Again: nothing changes, so nothing is applied.
    writes = len(_writes(fake))
    again = await _run(db, env, "proxy")
    assert len(_writes(fake)) == writes and len(fake.applies) == 1
    assert again[0] == "api.uat2.serversherpa.com: Switchyard host (10.10.48.63:8000), unchanged\n"


async def test_the_bare_name_is_a_redirect_host(db, secrets_key, publish_fakes):  # noqa: F811
    await configure(db, switchyard=True)
    env = await make_environment(db, name="uat2", host="10.10.48.63", proxy="switchyard",
                                 with_home=True)
    lines = await _run(db, env, "proxy")
    h = _by_name(publish_fakes.sy)[HOME]
    assert (h["type"], h["redirect_to"], h["redirect_code"], h["preserve_path"],
            h["upstreams"], h["tls_mode"], h["force_https"]) == (
        "redirect", "https://portal.uat2.serversherpa.com", 302, True, [], "auto", True)
    assert (f"{HOME}: created a Switchyard host (redirect to "
            "https://portal.uat2.serversherpa.com)\n") in lines


async def test_proxy_waits_for_certificates_and_times_out(db, env, publish_fakes):
    fake = publish_fakes.sy
    fake.auto_issue = False
    sleeps: list = []
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy", _publisher(sleeps))
    assert sum(sleeps) == switchyard.CERT_TIMEOUT
    assert e.value.reason.startswith("Caddy didn't get a certificate for api.uat2.serversherpa.com"
                                     " within 5 minutes.")
    # The hosts stay applied and recorded: a retry only waits again.
    assert fake.applies == ["Sirdar: uat2 proxy hosts"]
    assert len(await _rows(db)) == len(PORTS)
    fake.issue(*NAMES)
    await _run(db, env, "proxy")
    assert len(fake.applies) == 1


async def test_proxy_corrects_drift_and_keeps_claimed_fields(db, env, publish_fakes):
    fake = publish_fakes.sy
    mine = fake.add_host("api.uat2.serversherpa.com", "10.10.48.63", 7999,
                         notes=f"Managed by Sirdar: uat2 ({env.id})")
    theirs = fake.add_host("portal.uat2.serversherpa.com", "10.10.48.63", 8091,
                           tls_mode="internal", notes="by hand", compression=True,
                           policy_ids=[3])
    await managed(db, env, "api", SY_HOST, mine)
    await managed(db, env, "portal", SY_HOST, theirs, origin="claimed")
    lines = await _run(db, env, "proxy")
    assert fake.hosts[mine]["upstreams"][0]["port"] == 8000
    p = fake.hosts[theirs]
    assert (p["tls_mode"], p["notes"], p["compression"], p["policy_ids"]) == (
        "auto", "by hand", True, [3])
    assert "api.uat2.serversherpa.com: Switchyard host now goes to 10.10.48.63:8000\n" in lines
    assert "portal.uat2.serversherpa.com: Switchyard host updated (HTTPS)\n" in lines
    assert len(fake.applies) == 1


async def test_a_host_sirdar_made_but_lost_is_taken_back(db, env, publish_fakes):
    fake = publish_fakes.sy
    hid = fake.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000,
                        tls_mode="auto", force_https=True,
                        notes=f"Managed by Sirdar: uat2 ({env.id})")
    lines = await _run(db, env, "proxy")
    assert "api.uat2.serversherpa.com: Switchyard host is Sirdar's again\n" in lines
    rows = {(s, k): (e, o) for s, k, e, o in await _rows(db)}
    assert rows[("api", SY_HOST)] == (str(hid), "created")


async def test_blockers_change_nothing(db, env, publish_fakes):
    fake = publish_fakes.sy
    fake.add_host("kiosk.uat2.serversherpa.com", "10.10.48.63", 8090)
    fake.add_host("wiki.uat2.serversherpa.com", notes="Managed by Sirdar: lan9 (some-id)")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert e.value.reason == (
        "Sirdar changed nothing: these Switchyard hosts are in the way.\n"
        "  kiosk.uat2.serversherpa.com: To 10.10.48.63:8090, made outside Sirdar.\n"
        "  wiki.uat2.serversherpa.com: The environment lan9 manages this Switchyard host.\n"
        "Claim the existing ones on the Publish tab, or remove them by hand, then retry.")
    assert _writes(fake) == [] and await _rows(db) == []


async def test_a_failure_after_changes_still_applies_them(db, env, publish_fakes):
    fake = publish_fakes.sy
    real = fake.handler
    made = []

    def handler(request):
        if request.method == "POST" and request.url.path == "/api/hosts":
            made.append(1)
            if len(made) == 3:
                return publish_fakes.sy._error(500, "internal", "Something went wrong.")
        return real(request)

    fake.handler = handler
    lines: list[str] = []
    ctx = await publish.prepare(db, env, get_settings())
    with pytest.raises(StepFailed) as e:
        await _publisher().run("proxy", ctx, lines.append)
    assert e.value.reason == "Switchyard answered with HTTP 500."
    assert fake.applies == ["Sirdar: uat2 proxy hosts"]          # the two made so far
    assert len(fake.applied) == 2 and len(await _rows(db)) == 2


async def test_caddy_refusing_the_apply_fails_the_step(db, env, publish_fakes):
    publish_fakes.sy.reject_apply = "loading config: bad upstream"
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert e.value.reason == ("Caddy refused the change and kept the old config: loading "
                              "config: bad upstream")


async def test_a_key_without_a_permission_fails_with_our_copy(db, env, publish_fakes):
    publish_fakes.sy.permissions.discard("config.apply")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert e.value.reason == ("Switchyard's API key doesn't have the config.apply permission. "
                              "Add it to the key in Switchyard.")


async def test_proxy_needs_switchyard(db, secrets_key, publish_fakes):  # noqa: F811
    await configure(db)
    env = await make_environment(db, name="uat2", proxy="switchyard")
    with pytest.raises(StepFailed) as e:
        await _run(db, env, "proxy")
    assert e.value.reason == ("Switchyard isn't set up. Add it in Settings › Integrations, or "
                              "turn Publish off for this environment.")


async def test_a_npm_environment_still_publishes_through_npm(db, secrets_key,  # noqa: F811
                                                            publish_fakes):
    await configure(db, switchyard=True)
    env = await make_environment(db, name="uat2", proxy="npm")
    await _run(db, env, "proxy")
    assert publish_fakes.npm.hosts and not publish_fakes.sy.hosts


async def test_stale_names_go_first_and_are_applied(db, env, publish_fakes):
    fake = publish_fakes.sy
    old = fake.add_host("api.old.serversherpa.com", notes=f"Managed by Sirdar: uat2 ({env.id})")
    await managed(db, env, "api", SY_HOST, old, name="api.old.serversherpa.com")
    lines = await _run(db, env, "proxy")
    assert old not in fake.hosts
    assert f"api.old.serversherpa.com: deleted the Switchyard host #{old}\n" in lines
    assert len(fake.applies) == 1


# ---- step 16: removal ------------------------------------------------------------------

async def test_unproxy_deletes_created_hosts_keeps_claimed_and_applies(db, env, publish_fakes):
    fake = publish_fakes.sy
    await _run(db, env, "proxy")
    status_host = _by_name(fake)["status.uat2.serversherpa.com"]["id"]
    claimed = fake.add_host("status.other.serversherpa.com")
    await db.execute(update(ManagedRecord).where(ManagedRecord.service == "status")
                     .values(external_id=str(claimed), origin="claimed",
                             name="status.other.serversherpa.com"))
    await db.commit()
    lines = await _run(db, env, "unproxy")
    # The status row now names the claimed host: Sirdar's own status host is
    # no longer recorded, so it stays too.
    assert set(fake.hosts) == {status_host, claimed}
    assert fake.applies[-1] == "Sirdar: uat2 remove proxy hosts"
    assert ("status.other.serversherpa.com: left the Switchyard host in place (claimed, not "
            "made by Sirdar)\n") in lines
    assert await _rows(db) == []
    again = await _run(db, env, "unproxy")
    assert again == ["No proxy hosts or certificates to remove.\n"]


async def test_unproxy_leaves_a_host_someone_repurposed(db, env, publish_fakes):
    fake = publish_fakes.sy
    hid = fake.add_host("api.uat2.serversherpa.com")
    fake.hosts[hid]["domains"] = ["api.uat2.serversherpa.com", "extra.example.com"]
    await managed(db, env, "api", SY_HOST, hid)
    lines = await _run(db, env, "unproxy")
    assert hid in fake.hosts and fake.applies == []
    assert (f"api.uat2.serversherpa.com: Switchyard host #{hid} left in place: it no longer "
            "matches what Sirdar made.\n") in lines


async def test_unproxy_removes_both_proxies_rows(db, env, publish_fakes):
    """Rows say where Sirdar made things, whatever the environment uses."""
    await configure(db, switchyard=True)
    npm_host = publish_fakes.npm.add_host("kiosk.uat2.serversherpa.com", "10.10.48.63", 8090)
    await managed(db, env, "kiosk", PROXY, npm_host)
    sy_host = publish_fakes.sy.add_host("api.uat2.serversherpa.com")
    await managed(db, env, "api", SY_HOST, sy_host)
    await _run(db, env, "unproxy")
    assert publish_fakes.npm.hosts == {} and publish_fakes.sy.hosts == {}


# ---- the Publish tab -------------------------------------------------------------------

async def test_inspect_reads_switchyard(db, env, publish_fakes):
    fake = publish_fakes.sy
    fake.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000)
    fake.issue("portal.uat2.serversherpa.com")
    state = await publish.inspect(db, env, get_settings())
    assert state["proxy"] == {"kind": "switchyard", "configured": True,
                              "url": "https://switchyard.lan:8443", "error": None}
    by = {s["service"]: s for s in state["services"]}
    assert by["api"]["proxy"]["state"] == "claimable"
    assert by["api"]["proxy"]["detail"] == "To 10.10.48.63:8000, made outside Sirdar."
    assert by["api"]["certificate"]["state"] == "unknown"
    assert by["portal"]["proxy"]["state"] == "create"
    assert by["portal"]["proxy"]["detail"] == ("Sirdar will create a Switchyard host to "
                                               "10.10.48.63:8091.")
    assert by["portal"]["certificate"]["detail"] == "Caddy will get one once the host is applied."


async def test_inspect_reports_switchyard_errors(db, env, publish_fakes):
    publish_fakes.sy.key = "sy_another"
    state = await publish.inspect(db, env, get_settings())
    assert state["proxy"]["error"] == "Switchyard rejected the API key."
    assert {s["proxy"]["state"] for s in state["services"]} == {"unknown"}


async def test_claim_records_switchyard_hosts(db, env, publish_fakes):
    fake = publish_fakes.sy
    hid = fake.add_host("api.uat2.serversherpa.com", "10.10.48.63", 8000, notes="by hand")
    state = await publish.inspect(db, env, get_settings())
    claimed = await publish.claim(db, env, state)
    await db.commit()
    assert claimed == ["proxy:api.uat2.serversherpa.com"]
    assert ("api", SY_HOST, str(hid), "claimed") in await _rows(db)
    await _run(db, env, "proxy")
    assert fake.hosts[hid]["notes"] == "by hand"           # claimed: not re-marked
    state = await publish.inspect(db, env, get_settings())
    api = next(s for s in state["services"] if s["service"] == "api")
    assert (api["proxy"]["state"], api["proxy"]["origin"]) == ("ok", "claimed")


# ---- the pure status ---------------------------------------------------------------------

def _host(hid=1, domain="api.uat2.serversherpa.com", **over) -> switchyard.Host:
    raw = {"id": hid, "type": "proxy", "domains": [domain], "enabled": True,
           "upstreams": [{"scheme": "http", "host": "10.10.48.63", "port": 8100}],
           "tls_mode": "auto", "force_https": True, "notes": "", **over}
    return switchyard._host(raw)


def test_sy_status_drift_names_what_changes():
    host = _host(upstreams=[{"scheme": "http", "host": "10.0.0.1", "port": 8100}],
                 tls_mode="internal", enabled=False)
    row = ManagedRecord(service="api", kind=SY_HOST, external_id="1",
                        name="api.uat2.serversherpa.com", origin="created")
    st = publish.sy_status(sp(), [host], row, {}, "env-id")
    assert (st.state, st.detail) == (
        "update", "Sirdar will change the upstream, HTTPS and the enabled switch.")


def test_sy_status_conflicts():
    row = ManagedRecord(service="api", kind=SY_HOST, external_id="1",
                        name="api.uat2.serversherpa.com", origin="created")
    moved = _host(domain="other.example.com")
    assert publish.sy_status(sp(), [moved], row, {}, "e").detail == (
        "Sirdar's Switchyard host #1 no longer serves api.uat2.serversherpa.com; fix it in "
        "Switchyard or remove it.")
    two = [_host(1), _host(2)]
    assert publish.sy_status(sp(), two, None, {}, "e").detail == (
        "More than one Switchyard host serves this name.")
    assert publish.sy_status(sp(), [_host(5)], None, {"5": "beta"}, "e").detail == (
        "The environment beta manages this Switchyard host.")
    gone = publish.sy_status(sp(), [_host(7, notes="by hand")], row, {}, "e")
    assert (gone.state, gone.detail) == (
        "conflict", "Sirdar's Switchyard host is gone and another host now serves this name.")
    assert publish.sy_status(sp(), [], row, {}, "e").detail == (
        "Sirdar's Switchyard host is gone; it will be created again.")


def test_sy_owner_reads_the_notes():
    assert publish.sy_owner(_host(notes="Managed by Sirdar: uat2 (abc-1)")) == ("uat2", "abc-1")
    assert publish.sy_owner(_host(notes="by hand")) is None


async def test_the_switchyard_kind_exists_in_the_database(db, env):
    db.add(ManagedRecord(environment_id=env.id, service="api", kind=SY_HOST,
                         external_id="1", name="api.uat2.serversherpa.com", origin="created"))
    db.add(ManagedRecord(environment_id=env.id, service="api", kind=PROXY,
                         external_id="1", name="api.uat2.serversherpa.com", origin="created"))
    await db.commit()                    # NPM's host #1 and Switchyard's #1 both fit
    assert (await db.get(Environment, env.id)).proxy == "switchyard"
    assert DNS != SY_HOST
