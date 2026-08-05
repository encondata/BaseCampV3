"""Developer coverage for the editable site-type/site-status lookups.
Editing what values exist is vocabulary and is gated on `devtools`
(developer-only) — see test_lookup_gates.py for the admin-forbidden /
developer-allowed matrix across all three lookup tabs.

NOTE: conftest.clean_db restores canonical site_type/site_status labels and
colors between tests, so edits here don't leak into other test modules."""

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import AuditLog, Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _make_developer(db, client, email="dev@test.example.com"):
    dev = Person(first_name="Dee", last_name="Veloper", email=email)
    db.add(dev)
    await db.flush()
    db.add(UserAccount(
        person_id=dev.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=dev.id, role="developer"))
    await db.commit()
    return await login(client, email=email)


async def test_admin_patches_site_type_label(client, db, seeded_user):
    hdrs = await _make_developer(db, client)
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": "Data Center v2"})
    assert resp.status_code == 200
    assert resp.json()["label"] == "Data Center v2"

    types = (await client.get("/site-types", headers=hdrs)).json()
    row = next(t for t in types if t["key"] == "datacenter")
    assert row["label"] == "Data Center v2"          # persisted

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "site_type", AuditLog.action == "update"))
    assert audit_row is not None
    assert audit_row.entity_id == "datacenter"
    assert audit_row.changes["label"]["to"] == "Data Center v2"


async def test_unknown_lookup_key_404s(client, db, seeded_user):
    hdrs = await _make_developer(db, client)
    resp = await client.patch("/site-types/spaceport", headers=hdrs,
                              json={"label": "Nope"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "site_type_not_found"


async def test_icon_can_be_cleared_to_null(client, db, seeded_user):
    """site_types.icon is nullable, so NULL is how "no icon" is spelled. The
    old `if value is not None` in-loop guard silently DROPPED an explicit
    null: the row kept its icon, `changes` came back empty (no audit, no
    updated_at), and the handler still returned 200 — so the Variables modal
    reported success while nothing had changed. Asserting the READ-BACK is
    what makes this bite; a 200-only assertion passes under the old code."""
    hdrs = await _make_developer(db, client)
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"icon": None})
    assert resp.status_code == 200
    assert resp.json()["icon"] is None

    types = (await client.get("/site-types", headers=hdrs)).json()
    row = next(t for t in types if t["key"] == "datacenter")
    assert row["icon"] is None                        # actually persisted

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "site_type", AuditLog.action == "update"))
    assert audit_row is not None                      # the clear was audited
    assert audit_row.changes["icon"]["to"] is None


async def test_null_on_a_non_nullable_field_422s(client, db, seeded_user):
    """label/description/sort_order are NOT NULL, so the pre-check rejects an
    explicit null up front rather than letting it reach the UPDATE as an
    IntegrityError. Mirrors NON_NULLABLE_STATUS_FIELDS in status_values.py."""
    hdrs = await _make_developer(db, client)
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"label": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "label_required"


async def test_sort_order_zero_is_not_rejected(client, db, seeded_user):
    """The falsy-but-legal guard. The pre-check predicate must be `is None`,
    never a falsy check — sort_order=0 is a legitimate ordering value and a
    `not data[field]` predicate would 422 it. Task 4 learned this the hard
    way; status_values.py:126-128 carries the correct form."""
    hdrs = await _make_developer(db, client)
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"sort_order": 0})
    assert resp.status_code == 200
    assert resp.json()["sort_order"] == 0
