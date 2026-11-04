"""POST /labels/printer-events — the portal's Factory Reset dialog reporting
a printer reset it performed over WebUSB (spec
docs/superpowers/specs/2026-11-03-portal-printer-tools-design.md §5). The
portal twin of POST /kiosk/printer-events: nothing but an audit row is
written, but with no kiosk device to hang it on, the row is against a
`label_printer` entity keyed by the printer's serial (when the browser
reported one). Gated on labels:view; deliberately EXEMPT from read-only
mode, like the kiosk route."""

import uuid

from sqlalchemy import select, update

from serversherpa.db.models import AuditLog, Person, PersonRole, UserAccount
from tests.test_sites_api import login, make_login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin, _freeze

URL = "/labels/printer-events"
PRINTER_SERIAL = "D2J000001"


def _event(**kw):
    return {"event": "factory_reset", "outcome": "completed",
            "printer_model": "ZD421-203dpi ZPL", "printer_firmware": "V92.21.16Z",
            "printer_serial": PRINTER_SERIAL, "calibrated": True, **kw}


async def _rows(db, action="printer_factory_reset"):
    db.expire_all()
    return (await db.scalars(
        select(AuditLog).where(AuditLog.action == action))).all()


async def test_completed_reset_writes_one_audit_row(client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id

    resp = await client.post(URL, headers=hdrs, json=_event())
    assert resp.status_code == 204, resp.text
    assert resp.content == b""

    rows = await _rows(db)
    assert len(rows) == 1
    row = rows[0]
    assert row.entity_type == "label_printer"
    assert row.entity_id == PRINTER_SERIAL
    assert row.actor_person_id == actor_id
    assert row.changes == {"outcome": "completed",
                           "printer_model": "ZD421-203dpi ZPL",
                           "printer_firmware": "V92.21.16Z",
                           "printer_serial": PRINTER_SERIAL,
                           "calibrated": True}
    # null-valued keys are omitted, not stored as nulls
    assert "failed_step" not in row.changes
    assert "error" not in row.changes


async def test_failed_reset_carries_the_step_and_error(client, db, seeded_user):
    hdrs = await login(client)

    resp = await client.post(URL, headers=hdrs, json=_event(
        outcome="failed", calibrated=False, failed_step="restart",
        error="The printer did not come back. Power-cycle it, reconnect, and try again.",
        printer_firmware=None))
    assert resp.status_code == 204, resp.text

    row = (await _rows(db))[0]
    assert row.changes["outcome"] == "failed"
    assert row.changes["failed_step"] == "restart"
    assert row.changes["error"].startswith("The printer did not come back")
    assert row.changes["calibrated"] is False
    assert "printer_firmware" not in row.changes


async def test_null_fields_are_left_out(client, db, seeded_user):
    """A printer the browser never identified: no serial to key the row on,
    and no model or firmware to report."""
    hdrs = await login(client)

    resp = await client.post(URL, headers=hdrs, json={
        "event": "factory_reset", "outcome": "failed", "failed_step": "reset"})
    assert resp.status_code == 204, resp.text

    row = (await _rows(db))[0]
    assert row.entity_type == "label_printer"
    assert row.entity_id is None
    assert row.changes == {"outcome": "failed", "calibrated": False,
                           "failed_step": "reset"}
    for key in ("printer_model", "printer_firmware", "printer_serial", "error"):
        assert key not in row.changes


async def test_bad_bodies_are_422(client, db, seeded_user):
    hdrs = await login(client)
    for bad in ({"event": "head_clean", "outcome": "completed"},
                {"event": "factory_reset", "outcome": "unknown"},
                {"event": "factory_reset"},
                _event(serial="kiosk-web-1"),  # unknown fields are refused, not dropped
                _event(printer_serial="s" * 121),
                _event(printer_model="m" * 121),
                _event(printer_firmware="f" * 121),
                _event(failed_step="x" * 61),
                _event(error="e" * 501)):
        r = await client.post(URL, headers=hdrs, json=bad)
        assert r.status_code == 422, (bad, r.text)
    assert await _rows(db) == []
    # the caps are inclusive
    ok = await client.post(URL, headers=hdrs, json=_event(
        printer_serial="s" * 120, failed_step="x" * 60, error="e" * 500))
    assert ok.status_code == 204, ok.text


async def test_needs_labels_view(client, db, seeded_user):
    worker = await _make(db, client, "worker", "w-label-printer-events@test.example.com")
    assert (await client.post(URL, headers=worker, json=_event())).status_code == 403
    assert (await client.post(URL, json=_event())).status_code == 401
    assert await _rows(db) == []
    # a non-designer staff user is allowed
    r = await client.post(URL, headers=await login(client), json=_event())
    assert r.status_code == 204, r.text


async def test_read_only_mode_still_accepts_the_report(client, db, seeded_user):
    """The physical reset already happened. Refusing to record it during a
    maintenance freeze loses the very trail this endpoint exists to keep,
    and an append-only audit row is safe to write while frozen — so this
    path is read-only exempt. A real write under /labels, whose data the
    portal can retry later, still returns 423."""
    hdrs = await login(client)
    admin = await _admin(db, client)
    await _freeze(db, client, admin)

    resp = await client.post(URL, headers=hdrs, json=_event())
    assert resp.status_code == 204, resp.text
    assert len(await _rows(db)) == 1

    frozen = await client.post("/labels/generate/runs", headers=admin, json={
        "initiative_id": str(uuid.uuid4()), "label_types": ["top"]})
    assert frozen.status_code == 423, frozen.text
    assert frozen.json()["detail"]["code"] == "read_only_mode"


async def test_a_password_change_owed_blocks_it(client, db, seeded_user):
    """Exempt from the freeze is not exempt from signing in: a session that
    owes a password change gets nothing but the change."""
    await db.execute(update(UserAccount).where(UserAccount.email == "alice@test.example.com")
                     .values(must_change_password=True))
    await db.commit()
    owes = await login(client)
    r = await client.post(URL, headers=owes, json=_event())
    assert (r.status_code, r.json()["detail"]["code"]) == (403, "password_change_required")
    assert await _rows(db) == []


async def test_the_row_shows_up_on_the_audit_page(client, db, seeded_user):
    """An audit:view persona sees the reset, keyed by the printer's serial
    (there is no printer page and no name to resolve for `label_printer`)."""
    hdrs = await login(client)
    admin_person = Person(first_name="Ada", last_name="Admin",
                          email="ada-label-printer-events@test.example.com")
    db.add(admin_person)
    await db.flush()
    db.add(PersonRole(person_id=admin_person.id, role="admin"))
    await db.commit()
    admin_hdrs = await make_login(db, client, admin_person,
                                  "ada-label-printer-events@test.example.com")

    assert (await client.post(URL, headers=hdrs, json=_event())).status_code == 204

    rows = (await client.get("/audit?action=printer_factory_reset",
                             headers=admin_hdrs)).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["entity_type"] == "label_printer"
    assert row["entity_id"] == PRINTER_SERIAL
    assert row["entity_name"] is None
    assert row["actor_name"] == "Alice Anderson"
    assert row["changes"]["outcome"] == "completed"
    assert row["changes"]["printer_model"] == "ZD421-203dpi ZPL"


async def test_the_actor_sees_it_in_their_own_activity(client, db, seeded_user):
    """/auth/me/activity reads the same audit_log, so the person who ran
    the reset finds it in their own history."""
    hdrs = await login(client)
    assert (await client.post(URL, headers=hdrs, json=_event())).status_code == 204

    rows = (await client.get("/auth/me/activity", headers=hdrs)).json()
    mine = next(r for r in rows if r["action"] == "printer_factory_reset")
    assert mine["by_me"] is True
    assert mine["changes"]["printer_serial"] == PRINTER_SERIAL
