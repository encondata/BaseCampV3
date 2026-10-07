import httpx
import pytest

from sirdar_api.dashboard import service
from sirdar_api.deploy import ConnectFailed, digitalocean

from .test_deploy_digitalocean import TOKEN
from .test_scaffold import _settings


def droplet(id_, name, status="active", tags=(), private="10.0.0.1", public="1.2.3.4",
            region="nyc3"):
    v4 = [{"type": "public", "ip_address": public}]
    if private:
        v4.insert(0, {"type": "private", "ip_address": private})
    return {"id": id_, "name": name, "status": status, "tags": list(tags),
            "region": {"slug": region}, "networks": {"v4": v4}}


DROPLETS = [
    droplet(1, "prod-blue-api", tags=["sirdar-env:production", "sirdar-slot:blue"]),
    droplet(2, "prod-green-api", "off", ["sirdar-env:production", "sirdar-slot:green"]),
    droplet(3, "dev-web", "off", ["sirdar-env:dev"], private=None, public="5.6.7.8"),
    droplet(4, "qa-web", "new", ["sirdar-env:qa-team"]),
    droplet(5, "stray", "archive", []),
]
DATABASES = [
    {"id": "d1", "name": "prod-db", "status": "online", "region": "nyc3",
     "tags": ["sirdar-env:production", "sirdar-shared"],
     "connection": {"host": "pub.db"}, "private_connection": {"host": "prv.db"}},
    {"id": "d2", "name": "beta-db", "status": "creating", "region": "nyc3",
     "tags": ["sirdar-env:beta"], "connection": {"host": "beta.db"}},
]
LBS = [{"id": "lb1", "name": "prod-lb", "status": "active", "ip": "9.9.9.9",
        "region": {"slug": "nyc3"}, "tags": ["sirdar-env:production", "sirdar-shared"]}]


def do_transport(*, pages=None, status=200, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"id": "x"})
        path = request.url.path
        if path == "/v2/droplets":
            if pages:
                n = int(request.url.params.get("page", "1"))
                body = {"droplets": pages[n - 1]}
                if n < len(pages):
                    nxt = f"https://api.digitalocean.com/v2/droplets?page={n + 1}&per_page=200"
                    body["links"] = {"pages": {"next": nxt}}
                return httpx.Response(200, json=body)
            return httpx.Response(200, json={"droplets": DROPLETS})
        if path == "/v2/databases":
            return httpx.Response(200, json={"databases": DATABASES})
        if path == "/v2/load_balancers":
            return httpx.Response(200, json={"load_balancers": LBS})
        return httpx.Response(404, json={})
    return httpx.MockTransport(handler)


async def inv(**kw):
    return await digitalocean.inventory(_settings(deploy_do_token=TOKEN),
                                        transport=do_transport(**kw))


def by(nodes, name):
    return next(n for n in nodes if n["name"] == name)


PRODUCTION = {"key": "production", "label": "Production", "error": None}


async def test_unmanaged_resources_and_their_mappings():
    group = service.other_resources(PRODUCTION, await inv(), set(), single=True)
    assert (group["id"], group["name"], group["kind"]) == (
        "other:production", "Other DigitalOcean resources", "group")
    assert [n["name"] for n in group["children"]] == [
        "prod-blue-api", "prod-green-api", "dev-web", "qa-web", "stray", "prod-db", "beta-db",
        "prod-lb"]
    api = by(group["children"], "prod-blue-api")
    assert (api["status"], api["status_label"], api["endpoint"], api["region"], api["dot"]) == \
        ("running", "Running", "10.0.0.1", "NYC3", "green")
    assert api["id"] == "other:production:droplet-1"
    assert by(group["children"], "prod-green-api")["status"] == "stopped"
    assert by(group["children"], "dev-web")["endpoint"] == "5.6.7.8"      # public fallback
    assert by(group["children"], "qa-web")["status"] == "provisioning"
    assert by(group["children"], "stray")["status"] == "unknown"
    db = by(group["children"], "prod-db")
    assert (db["status"], db["status_label"], db["endpoint"]) == ("healthy", "Healthy", "prv.db")
    beta_db = by(group["children"], "beta-db")          # no private host: never the public one
    assert (beta_db["status"], beta_db["endpoint"]) == ("provisioning", "—")
    assert by(group["children"], "prod-lb")["kind"] == "load_balancer"
    assert group["status"] == "active"


async def test_managed_resources_are_left_out_and_an_empty_account_has_no_group():
    two = {**PRODUCTION, "label": "Development", "key": "development"}
    group = service.other_resources(two, await inv(), {"1", "2", "d1", "lb1"}, single=False)
    assert group["name"] == "Other resources · Development account"
    assert [n["name"] for n in group["children"]] == ["dev-web", "qa-web", "stray", "beta-db"]
    empty = {"droplets": [], "databases": [], "load_balancers": []}
    assert service.other_resources(PRODUCTION, empty, set(), single=True) is None


def test_a_failed_account_keeps_its_group_with_the_error():
    group = service.other_resources({**PRODUCTION, "error": "Nope."}, None, set(), single=False)
    assert (group["children"], group["status_label"], group["endpoint"]) == (
        [], "Unavailable", "Nope.")


async def test_droplet_pagination_follows_next_up_to_five_pages():
    pages = [[droplet(i, f"d{i}", tags=["sirdar-env:dev"])] for i in range(1, 8)]
    seen = []
    result = await inv(pages=pages, seen=seen)
    assert len(result["droplets"]) == 5
    assert [r.url.params.get("page") for r in seen if r.url.path == "/v2/droplets"] == \
        [None, "2", "3", "4", "5"]
    assert all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in seen)


async def test_inventory_401_is_sanitized():
    with pytest.raises(ConnectFailed) as e:
        await inv(status=401)
    assert TOKEN not in e.value.reason


async def test_inventory_malformed_body():
    def handler(request):
        return httpx.Response(200, json={"droplets": "nope"})
    with pytest.raises(ConnectFailed):
        await digitalocean.inventory(_settings(deploy_do_token=TOKEN),
                                     transport=httpx.MockTransport(handler))


async def test_pagination_ignores_next_url_host():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v2/droplets":
            body = {"droplets": [droplet(1, "d1", tags=["sirdar-env:dev"])]}
            if request.url.params.get("page") is None:
                body["links"] = {"pages": {"next": "https://evil.example.com/v2/droplets?page=2"}}
            return httpx.Response(200, json=body)
        return httpx.Response(200, json={"databases": [], "load_balancers": []})
    await digitalocean.inventory(_settings(deploy_do_token=TOKEN),
                                 transport=httpx.MockTransport(handler))
    assert {r.url.host for r in seen} == {"api.digitalocean.com"}
    assert [r.url.params.get("page") for r in seen if r.url.path == "/v2/droplets"] == [None, "2"]


def test_only_valid_env_tags_name_environments():
    long_name = "a" * 500
    found = [service._env_of(droplet(i, f"d{i}", tags=[f"sirdar-env:{n}"]))
             for i, n in enumerate(["Production", "a b", long_name, "qa-team", "blue", "dev"])]
    assert found == [None, None, None, "qa-team", None, "dev"]


@pytest.mark.parametrize("empty", ["databases", "load_balancers", "droplets"])
async def test_an_account_with_none_of_a_kind_answers_null(empty):
    """DigitalOcean answers {"databases": null} (and the like) for an account with
    none: that is an empty list, not a response Sirdar doesn't understand."""
    def handler(request: httpx.Request) -> httpx.Response:
        kind = request.url.path.rsplit("/", 1)[-1]
        full = {"droplets": DROPLETS, "databases": DATABASES, "load_balancers": LBS}[kind]
        return httpx.Response(200, json={kind: None if kind == empty else full})
    got = await digitalocean.inventory(_settings(deploy_do_token=TOKEN),
                                       transport=httpx.MockTransport(handler))
    assert got[empty] == []


async def test_a_response_it_cannot_read_logs_the_part_never_the_values(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/load_balancers":
            return httpx.Response(200, json={"load_balancers": {"secret-ish": "value-123"}})
        kind = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={kind: []})
    with pytest.raises(ConnectFailed):
        await digitalocean.inventory(_settings(deploy_do_token=TOKEN),
                                     transport=httpx.MockTransport(handler))
    text = caplog.text
    assert "load_balancers" in text
    assert "value-123" not in text and TOKEN not in text
