"""/spec-lookup routes: permissions, status, queue, suggestions lifecycle, bulk, dev."""
from sqlalchemy import select

from serversherpa.db.models import AssetModel, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import provider as provider_mod
from tests.test_assets_api import login
from tests.test_initiatives_client_scope import client_login
from tests.test_system_api import _developer_headers

URL = "https://www.hpe.com/a"


def _configured(monkeypatch, ok=True):
    class P:
        async def ping(self):
            if not ok:
                raise provider_mod.ProviderNotConfigured("not_configured")

        async def aclose(self):
            return None
    monkeypatch.setattr(provider_mod, "is_configured", lambda: True)
    monkeypatch.setattr(provider_mod, "get_provider", lambda: P())


async def _m(db, **kw):
    m = AssetModel(make=kw.pop("make", "HPE"), model=kw.pop("model", "DL320"), **kw)
    db.add(m)
    await db.commit()
    return m


async def _sugg(db, m, **kw):
    s = SpecSuggestion(model_id=m.id, field=kw.get("field", "ru_size"),
                       value=kw.get("value", "1"), unit=kw.get("unit"),
                       quote="1U", source_url=URL, previous_value=None,
                       status=kw.get("status", "pending"))
    db.add(s)
    await db.commit()
    return s


async def test_client_user_refused(client, db, seeded_user):
    from serversherpa.db.models import Client
    c = Client(name="Acme")
    db.add(c)
    await db.commit()
    hdrs = await client_login(db, client, c.id)
    assert (await client.get("/spec-lookup/status", headers=hdrs)).status_code == 403


async def test_status(client, db, seeded_user, monkeypatch):
    hdrs = await login(client)
    m = await _m(db)
    await _sugg(db, m)
    body = (await client.get("/spec-lookup/status", headers=hdrs)).json()
    assert body["configured"] is False and body["pending_count"] == 1
    assert body["month"]["lookups"] == 0


async def test_queue_requires_configuration(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db)
    resp = await client.post("/spec-lookup/queue", headers=hdrs, json={"model_ids": [str(m.id)]})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_configured"


async def test_queue_ids_skips_private_and_skip(client, db, seeded_user, monkeypatch):
    _configured(monkeypatch)
    hdrs = await login(client)
    ok = await _m(db, model="ok", specs_looked_up_at=None)
    priv = await _m(db, model="priv", private=True)
    junk = await _m(db, model="junk", spec_lookup_skip=True)
    resp = await client.post("/spec-lookup/queue", headers=hdrs,
                             json={"model_ids": [str(ok.id), str(priv.id), str(junk.id)]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["queued"] == 1
    assert {(s["id"], s["reason"]) for s in body["skipped"]} == {
        (str(priv.id), "private"), (str(junk.id), "skipped")}
    job = await db.scalar(select(SpecLookupJob))
    assert job.priority == 20 and job.requested_by == seeded_user.id


async def test_queue_all_eligible(client, db, seeded_user, monkeypatch):
    _configured(monkeypatch)
    hdrs = await login(client)
    await _m(db, model="a")
    await _m(db, model="b")
    resp = await client.post("/spec-lookup/queue", headers=hdrs, json={})
    assert resp.json()["queued"] == 2


async def test_suggestion_lifecycle(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db)
    s = await _sugg(db, m)
    listed = (await client.get("/spec-lookup/suggestions?status=pending", headers=hdrs)).json()
    assert [x["id"] for x in listed] == [str(s.id)] and listed[0]["make"] == "HPE"
    assert listed[0]["current_value"] is None
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/approve", headers=hdrs)
    assert resp.status_code == 200 and resp.json()["status"] == "approved"
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/approve", headers=hdrs)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "bad_state"
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/undo", headers=hdrs)
    assert resp.json()["status"] == "reverted"


async def test_field_changed_409(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db, ru_size=4)
    s = await _sugg(db, m)
    resp = await client.post(f"/spec-lookup/suggestions/{s.id}/approve", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "field_changed", "current": "4"}


async def test_bulk(client, db, seeded_user):
    hdrs = await login(client)
    m = await _m(db)
    a = await _sugg(db, m, field="ru_size")
    b = await _sugg(db, m, field="height", value="1.7", unit="in", status="rejected")
    resp = await client.post("/spec-lookup/suggestions/bulk", headers=hdrs,
                             json={"ids": [str(a.id), str(b.id)], "action": "approve"})
    res = {r["id"]: r for r in resp.json()["results"]}
    assert res[str(a.id)]["ok"] is True
    assert res[str(b.id)]["ok"] is False and res[str(b.id)]["error"] == "bad_state"


async def test_dev_endpoints_gated_and_masked(client, db, seeded_user, monkeypatch):
    staff = await login(client)
    assert (await client.get("/spec-lookup/dev", headers=staff)).status_code == 403
    dev = await _developer_headers(db, client)
    body = (await client.get("/spec-lookup/dev", headers=dev)).json()
    assert body["key_set"] is False and body["key_last4"] is None
    assert body["model"] == "claude-sonnet-5" and body["worker_status"] in ("failed", "stopped", "missing")
    _configured(monkeypatch, ok=False)
    body = (await client.post("/spec-lookup/dev/test", headers=dev)).json()
    assert body["ok"] is False and body["error"] == "not_configured"
