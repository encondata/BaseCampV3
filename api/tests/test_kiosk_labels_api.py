"""Kiosk label vocabulary: GET /kiosk/labels/vocab — the same rows the
portal's GET /labels/vocab returns, but gated on kiosk:view so a worker
at a kiosk (who holds kiosk:view and NOT labels:view) can size a test
label on /labels/printers."""

from serversherpa.db.models import LabelTemplate

from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make


async def test_worker_reads_sizes_and_dpi(client, db, seeded_user):
    hdrs = await _make(db, client, "worker", "w-vocab@test.example.com")
    resp = await client.get("/kiosk/labels/vocab", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    kinds = {r["kind"] for r in rows}
    assert {"size", "dpi"} <= kinds
    sizes = {r["key"] for r in rows if r["kind"] == "size"}
    assert "4x2" in sizes
    dpi = {r["key"]: r["meta"] for r in rows if r["kind"] == "dpi"}
    assert dpi["203"]["dots"] == 203


async def test_worker_has_no_labels_view(client, db, seeded_user):
    """The reason this endpoint exists: kiosk:view does not imply
    labels:view, so the portal's own vocab route is closed to a worker."""
    hdrs = await _make(db, client, "worker", "w-vocab2@test.example.com")
    assert (await client.get("/labels/vocab", headers=hdrs)).status_code == 403


async def test_client_viewer_is_forbidden(client, db, seeded_user):
    hdrs = await _client_viewer(db, client, "cv-vocab@test.example.com")
    resp = await client.get("/kiosk/labels/vocab", headers=hdrs)
    assert resp.status_code == 403


async def test_payload_matches_the_portal_endpoint(client, db, seeded_user):
    """Same rows, same order, same usage counts — it is the portal's
    listing, re-gated. A template makes the usage counts non-zero so an
    all-zeros stub would fail here."""
    db.add(LabelTemplate(name="kiosk-vocab-1", label_type="top", size_key="4x2",
                         dpi_key="203", language_key="zpl", kind="code",
                         code="^XA^XZ"))
    await db.commit()
    portal_hdrs = await login(client)                 # alice: staff → labels:view
    kiosk_hdrs = await _make(db, client, "worker", "w-vocab3@test.example.com")
    portal_rows = (await client.get("/labels/vocab", headers=portal_hdrs)).json()
    kiosk_rows = (await client.get("/kiosk/labels/vocab", headers=kiosk_hdrs)).json()
    assert kiosk_rows == portal_rows
    assert next(r for r in kiosk_rows if r["kind"] == "size"
                and r["key"] == "4x2")["usage_count"] == 1


async def test_read_only_mode_does_not_block_the_read(client, db, seeded_user):
    """Reference data, read-only by construction — nothing to gate."""
    hdrs = await _make(db, client, "worker", "w-vocab4@test.example.com")
    resp = await client.get("/kiosk/labels/vocab", headers=hdrs)
    assert resp.status_code == 200
