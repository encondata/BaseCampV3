import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import ConnectFailed, tls_pin

from .api_helpers import auth_headers
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .integration_helpers import (
    PX_BODY,
    PX_CERT,
    PX_FINGERPRINT,
    PX_TOKEN,
    PX_TOKEN_ID,
    PX_TOKEN_SECRET,
    configure_proxmox,
)
from .proxmox_helpers import proxmox_fake  # noqa: F401
from .tls_helpers import make_cert

URL = "/api/deploy/integrations/proxmox"
UNPINNED = {k: v for k, v in PX_BODY.items() if k != "tls_fingerprint"}


@pytest.fixture
def certificate(monkeypatch):
    """The certificate the Proxmox host serves (the real fetch is guarded)."""
    state = {"pem": PX_CERT, "calls": []}

    async def fetch(host, port):
        state["calls"].append((host, port))
        if state["pem"] is None:
            raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.")
        return state["pem"]

    monkeypatch.setattr(tls_pin, "fetch_certificate", fetch)
    return state


@pytest.fixture
async def no_token_leaks(client, db):
    seen: list[str] = []

    async def record(response):
        await response.aread()
        seen.append(response.text)

    client.event_hooks["response"].append(record)
    yield
    await db.rollback()
    audits = [repr(c) for c in await db.scalars(select(AuditLog.changes))]
    assert seen
    for text in seen + audits:
        assert PX_TOKEN_SECRET not in text and "BEGIN CERTIFICATE" not in text


async def _audits(db, action: str) -> list[dict]:
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == action)
                            .order_by(AuditLog.id))
    return [r.changes for r in rows]


async def test_saving_asks_to_trust_the_certificate_first(client, db, secrets_key, certificate,
                                                          no_token_leaks):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**UNPINNED, "token": PX_TOKEN})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert (detail["code"], detail["fingerprint"], detail["subject"]) == (
        "tls_untrusted", PX_FINGERPRINT, "pve.lab")
    assert {"10.10.48.5", "pve"} <= set(detail["names"]) and detail["not_after"]
    assert certificate["calls"] == [("10.10.48.5", 8006)]
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN})
    assert resp.status_code == 200, resp.text
    px = resp.json()["proxmox"]
    assert (px["configured"], px["token_set"], px["token_id"], px["tls_fingerprint"],
            px["template_vmid"]) == (True, True, PX_TOKEN_ID, PX_FINGERPRINT, 9000)
    [change] = await _audits(db, "deploy.integration_update")
    assert change["kind"] == "proxmox" and "token" in change["changed"]


async def test_a_changed_certificate_is_refused(client, db, secrets_key, certificate,
                                                no_token_leaks):
    h = await auth_headers(client, db)
    certificate["pem"], _ = make_cert(cn="impostor")
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN})
    detail = resp.json()["detail"]
    assert (resp.status_code, detail["code"], detail["expected"]) == (
        409, "tls_mismatch", PX_FINGERPRINT)
    assert detail["actual"] == tls_pin.fingerprint_of(certificate["pem"])
    certificate["pem"] = None
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN})
    assert (resp.status_code, resp.json()["detail"]) == (
        502, {"code": "connect_failed", "reason": "Couldn't reach 10.10.48.5:8006 over TLS."})


async def test_the_stored_pin_is_reused_without_fetching(client, db, secrets_key, certificate,
                                                         no_token_leaks):
    await configure_proxmox(db)
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**PX_BODY, "bridge": "vmbr1"})
    assert resp.status_code == 200 and resp.json()["proxmox"]["bridge"] == "vmbr1"
    assert certificate["calls"] == []
    # another server: its certificate must be trusted, and the token entered again
    resp = await client.put(URL, headers=h, json={**UNPINNED, "url": "https://10.10.48.9:8006"})
    assert resp.json()["detail"]["code"] == "tls_untrusted"
    assert certificate["calls"] == [("10.10.48.9", 8006)]
    resp = await client.put(URL, headers=h, json={**PX_BODY, "url": "https://10.10.48.9:8006"})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, "secret_required")


@pytest.mark.parametrize("change,code", [
    ({"url": "http://10.10.48.5:8006"}, "proxmox_url_invalid"),
    ({"node": "pve node"}, "node_invalid"),
    ({"template_vmid": 12}, "template_vmid_invalid"),
    ({"vlan_tag": 0}, "vlan_tag_invalid"),
    ({"token": "sirdar@pve!sirdar=nope"}, "proxmox_token_invalid"),
])
async def test_validation(client, db, secrets_key, certificate, change, code):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**PX_BODY, "token": PX_TOKEN, **change})
    assert (resp.status_code, resp.json()["detail"]["code"]) == (422, code)


async def test_fingerprint_format(client, db, secrets_key, certificate, no_token_leaks):
    h = await auth_headers(client, db)
    for path in ("", "/test"):
        verb = client.put if not path else client.post
        resp = await verb(URL + path, headers=h,
                          json={**PX_BODY, "tls_fingerprint": "AB:CD", "token": PX_TOKEN})
        assert (resp.status_code, resp.json()["detail"]) == (
            422, {"code": "tls_fingerprint_invalid"})
    assert certificate["calls"] == []
    # pasted without colons and in lowercase: the same pin
    typed = PX_FINGERPRINT.replace(":", "").lower()
    resp = await client.put(URL, headers=h,
                            json={**PX_BODY, "tls_fingerprint": typed, "token": PX_TOKEN})
    assert resp.status_code == 200, resp.text
    assert resp.json()["proxmox"]["tls_fingerprint"] == PX_FINGERPRINT
    resp = await client.put(URL, headers=h, json={**PX_BODY, "tls_fingerprint": typed})
    assert resp.status_code == 200 and certificate["calls"] == [("10.10.48.5", 8006)]


async def test_test_saved_and_unsaved(client, db, secrets_key, certificate, proxmox_fake,
                                      no_token_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/test", headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_not_configured", "kinds": ["proxmox"]})
    resp = await client.post(f"{URL}/test", headers=h, json={**UNPINNED, "token": PX_TOKEN})
    assert resp.json()["detail"]["code"] == "tls_untrusted"
    resp = await client.post(f"{URL}/test", headers=h, json={**PX_BODY, "token": PX_TOKEN})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] and [c["label"] for c in body["checks"]] == [
        "Proxmox", "Node", "Pool", "Template", "Storage", "Bridge"]
    assert body["facts"]["token_id"] == PX_TOKEN_ID
    await configure_proxmox(db)
    proxmox_fake.bridges = set()
    resp = await client.post(f"{URL}/test", headers=h)
    assert resp.status_code == 200 and resp.json()["ok"] is False
    assert await _audits(db, "deploy.integration_test") == [
        {"kind": "proxmox", "ok": True}, {"kind": "proxmox", "ok": True}]


async def test_remove_refuses_while_an_environment_uses_it(client, db, secrets_key):
    await configure_proxmox(db)
    env = await make_environment(db, name="uat3", target_id="proxmox")
    h = await auth_headers(client, db)
    resp = await client.delete(URL, headers=h)
    assert (resp.status_code, resp.json()["detail"]) == (
        409, {"code": "integration_in_use", "environments": ["uat3"]})
    await db.delete(env)
    await db.commit()
    assert (await client.delete(URL, headers=h)).status_code == 204
    assert await _audits(db, "deploy.integration_remove") == [{"kind": "proxmox"}]


async def test_permissions(client, db, secrets_key):
    admin = await auth_headers(client, db, email="admin@test.example.com", roles=("admin",))
    for method, path, body in (("PUT", "", PX_BODY), ("POST", "/test", None),
                               ("DELETE", "", None)):
        resp = await client.request(method, URL + path, headers=admin, json=body)
        assert resp.status_code == 403, (method, path)
