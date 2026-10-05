import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog
from sirdar_api.deploy import ConnectFailed, tls_pin

from .api_helpers import auth_headers
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .esxi_helpers import esxi_fake  # noqa: F401
from .integration_helpers import (
    ESXI_BODY,
    ESXI_CERT,
    ESXI_FINGERPRINT,
    ESXI_PASSWORD,
    configure_esxi,
)
from .tls_helpers import make_cert

URL = "/api/deploy/integrations/esxi"
UNPINNED = {k: v for k, v in ESXI_BODY.items() if k != "tls_fingerprint"}


@pytest.fixture
def certificate(monkeypatch):
    """The certificate the ESXi host serves (the real fetch is guarded)."""
    state = {"pem": ESXI_CERT, "calls": []}

    async def fetch(host, port):
        state["calls"].append((host, port))
        if state["pem"] is None:
            raise ConnectFailed(f"Couldn't reach {host}:{port} over TLS.")
        return state["pem"]

    monkeypatch.setattr(tls_pin, "fetch_certificate", fetch)
    return state


@pytest.fixture
async def no_password_leaks(client, db):
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
        assert ESXI_PASSWORD not in text and "BEGIN CERTIFICATE" not in text


async def test_saving_asks_to_trust_the_certificate_first(client, db, secrets_key, certificate,
                                                          no_password_leaks):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**UNPINNED, "password": ESXI_PASSWORD})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert (detail["code"], detail["fingerprint"], detail["subject"]) == (
        "tls_untrusted", ESXI_FINGERPRINT, "localhost.localdomain")
    assert certificate["calls"] == [("10.10.48.10", 443)]
    resp = await client.put(URL, headers=h, json={**ESXI_BODY, "password": ESXI_PASSWORD})
    assert resp.status_code == 200, resp.text
    shown = resp.json()["esxi"]
    assert (shown["configured"], shown["password_set"], shown["user"], shown["tls_fingerprint"],
            shown["source_vm"], shown["dns_servers"]) == (
        True, True, "sirdar", ESXI_FINGERPRINT, "sirdar-ubuntu-2404-seed", [])
    rows = await db.scalars(select(AuditLog).where(AuditLog.action == "deploy.integration_update"))
    [change] = [r.changes for r in rows]
    assert change["kind"] == "esxi" and "password" in change["changed"]


async def test_a_changed_certificate_is_refused(client, db, secrets_key, certificate):
    h = await auth_headers(client, db)
    certificate["pem"], _ = make_cert(cn="impostor")
    resp = await client.put(URL, headers=h, json={**ESXI_BODY, "password": ESXI_PASSWORD})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "tls_mismatch"
    assert resp.json()["detail"]["expected"] == ESXI_FINGERPRINT


async def test_the_stored_pin_is_reused_without_fetching(client, db, secrets_key, certificate):
    await configure_esxi(db)
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h, json={**ESXI_BODY, "datastore": "ssd2"})
    assert resp.status_code == 200, resp.text
    assert certificate["calls"] == []
    assert resp.json()["esxi"]["datastore"] == "ssd2"


@pytest.mark.parametrize(("change", "code"), [
    ({"url": "http://10.10.48.10"}, "esxi_url_invalid"),
    ({"user": "a b"}, "esxi_user_invalid"),
    ({"source_vm": ""}, "source_vm_invalid"),
    ({"dns_servers": ["x"]}, "dns_servers_invalid"),
    ({"password": "a\nb"}, "password_invalid"),
])
async def test_validation(client, db, secrets_key, certificate, change, code):
    h = await auth_headers(client, db)
    resp = await client.put(URL, headers=h,
                            json={**ESXI_BODY, "password": ESXI_PASSWORD, **change})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == code


async def test_test_saved_and_unsaved(client, db, secrets_key, certificate, esxi_fake,
                                      no_password_leaks):
    h = await auth_headers(client, db)
    resp = await client.post(f"{URL}/test", headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "integration_not_configured", "kinds": ["esxi"]}
    resp = await client.post(f"{URL}/test", headers=h,
                             json={**ESXI_BODY, "password": ESXI_PASSWORD})
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] and resp.json()["target"] == "esxi"
    await configure_esxi(db)
    resp = await client.post(f"{URL}/test", headers=h)
    assert resp.status_code == 200 and resp.json()["facts"]["user"] == "sirdar"


async def test_remove_refuses_while_an_environment_uses_it(client, db, secrets_key):
    await configure_esxi(db)
    env = await make_environment(db, name="uat3")
    env.target_id = "esxi"
    await db.commit()
    h = await auth_headers(client, db)
    resp = await client.delete(URL, headers=h)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "integration_in_use", "environments": ["uat3"]}


async def test_the_target_list_has_esxi_once_saved(client, db, secrets_key):
    h = await auth_headers(client, db)
    ids = [t["id"] for t in (await client.get("/api/deploy/targets", headers=h)).json()["targets"]]
    assert "esxi" not in ids
    await configure_esxi(db)
    listed = (await client.get("/api/deploy/targets", headers=h)).json()["targets"]
    assert listed[-1] == {"id": "esxi", "label": "VMware ESXi", "kind": "esxi",
                          "available": True, "configured": True}
