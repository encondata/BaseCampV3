"""GET /status-values/record-types — the frozen code registry, served so the
portal's status modal offers every record type without a code change."""

from serversherpa.status.registry import STATUS_RECORD_TYPES

from tests.test_status_values_read import _make


async def test_record_types_come_from_the_registry_in_order(client, db, seeded_user):
    hdrs = await _make(db, client, "staff", "st@test.example.com")
    resp = await client.get("/status-values/record-types", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["id"] for r in body] == [rt.id for rt in STATUS_RECORD_TYPES]
    assert len(body) >= 15
    partner = next(r for r in body if r["id"] == "partner_type")
    assert partner == {"id": "partner_type", "label": "Partner type",
                       "resource": "partners", "array": True}
    site = next(r for r in body if r["id"] == "site")
    assert site["array"] is False and site["label"] == "Site"


async def test_record_types_require_a_session(client):
    resp = await client.get("/status-values/record-types")
    assert resp.status_code == 401
