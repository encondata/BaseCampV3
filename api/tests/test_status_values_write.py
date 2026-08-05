"""The vocabulary is developer-only; the value on a record is not. A
settings:change admin who can still edit a site's status must not be able to
invent a new one."""

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog, Client, Person, PersonRole, PermissionOverride, UserAccount,
)
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login, make_login

PW = "CorrectHorse9!"


async def _make(db, client, role, email):
    p = Person(first_name="R", last_name="X", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return await login(client, email=email)


async def test_developer_creates_a_status(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev@test.example.com")
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "mothballed", "label": "Mothballed",
        "description": "Shut down, retained.", "color": "#8e44ad",
        "sort_order": 5,
    })
    assert resp.status_code == 201
    assert resp.json()["key"] == "mothballed"
    assert resp.json()["is_active"] is True

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_value", AuditLog.action == "create"))
    assert audit_row is not None
    assert audit_row.entity_id == "site:mothballed"


async def test_created_status_is_usable_on_a_site(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev2@test.example.com")
    await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "mothballed", "label": "Mothballed",
        "color": "#8e44ad", "sort_order": 5,
    })
    staff = await login(client)
    resp = await client.post("/sites", headers=staff, json={
        "name": "Mothball Site", "status": "mothballed"})
    assert resp.status_code == 201


async def test_created_status_is_usable_on_a_worker_profile(client, db, seeded_user):
    """Mirrors test_created_status_is_usable_on_a_site: workers must be able
    to use a status the moment a developer creates it, exactly like sites.
    WorkerProfileIn.status used to be a frozen Literal that made this
    impossible — see routes/workers.py's upsert_profile for the runtime
    check that replaced it."""
    from serversherpa.db.models import Person, PersonRole

    hdrs = await _make(db, client, "developer", "dev12@test.example.com")
    await client.post("/status-values", headers=hdrs, json={
        "record_type": "worker", "key": "probation", "label": "Probation",
        "color": "#e8a33d", "sort_order": 5,
    })
    worker = Person(first_name="Pat", last_name="Probation")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()

    staff = await login(client)
    resp = await client.put(f"/workers/{worker.id}/profile", headers=staff,
                            json={"status": "probation"})
    assert resp.status_code == 204

    row = (await client.get("/workers", headers=staff)).json()
    assert [w for w in row if w["person_id"] == str(worker.id)][0]["status"] == "probation"


async def test_unknown_worker_status_is_422(client, db, seeded_user):
    from serversherpa.db.models import Person, PersonRole

    worker = Person(first_name="No", last_name="Status")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()

    staff = await login(client)
    resp = await client.put(f"/workers/{worker.id}/profile", headers=staff,
                            json={"status": "made_up"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_status"


async def test_explicit_null_worker_status_is_422(client, db, seeded_user):
    """worker_profiles.status is NOT NULL (db/models.py:251) and the schema
    types it `str | None`, so an explicit null skips the unknown_status check
    and setattr's None straight into the write. Pre-existing (the old Literal
    had the identical hole), and the fourth instance of this bug class on
    this branch — sites' NON_NULLABLE_SITE_FIELDS already includes "status".

    Both paths must 422, and they failed DIFFERENTLY before the guard:
      - profile row exists  → UPDATE ... SET status=NULL → IntegrityError/500
      - no profile row yet  → INSERT omits the None (status has a
        server_default), so it silently returned 204 and coerced to 'active'
    The second is why this test seeds a profile first: without that, it only
    ever exercised the 204 path and would not have pinned the 500 at all."""
    from serversherpa.db.models import Person, PersonRole

    worker = Person(first_name="Null", last_name="Status")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()

    staff = await login(client)
    # no profile row yet — the silent-coercion path
    resp = await client.put(f"/workers/{worker.id}/profile", headers=staff,
                            json={"status": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "status_required"

    # now with a profile row on disk — the IntegrityError/500 path
    assert (await client.put(f"/workers/{worker.id}/profile", headers=staff,
                             json={"trade": "racking"})).status_code == 204
    resp = await client.put(f"/workers/{worker.id}/profile", headers=staff,
                            json={"status": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "status_required"

    # the status that was already there is untouched
    listing = (await client.get("/workers", headers=staff)).json()
    row = [w for w in listing if w["person_id"] == str(worker.id)][0]
    assert row["status"] == "active"

    # clearing a genuinely nullable field is still a real edit, not a 422
    resp = await client.put(f"/workers/{worker.id}/profile", headers=staff,
                            json={"trade": None, "level": None})
    assert resp.status_code == 204


async def test_duplicate_key_within_a_record_type_is_409(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev3@test.example.com")
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "active", "label": "Dupe",
        "color": "#178a4c",
    })
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "status_value_exists"


async def test_same_key_across_record_types_is_allowed(client, db, seeded_user):
    """'active' already exists for both site and worker — the composite PK is
    what makes that fine."""
    hdrs = await _make(db, client, "developer", "dev4@test.example.com")
    rows = (await client.get("/status-values", headers=hdrs)).json()
    actives = [r for r in rows if r["key"] == "active"]
    assert {r["record_type"] for r in actives} == {"site", "worker"}


async def test_deactivating_an_in_use_status_keeps_the_record_rendering(
        client, db, seeded_user):
    """No DELETE — is_active is the retirement mechanism, and the FK is what
    makes it safe."""
    dev = await _make(db, client, "developer", "dev5@test.example.com")
    staff = await login(client)
    site = (await client.post("/sites", headers=staff, json={
        "name": "Retired Status Site", "status": "planned"})).json()

    resp = await client.patch("/status-values/site/planned", headers=dev,
                              json={"is_active": False})
    assert resp.status_code == 200
    assert resp.json()["is_active"] is False

    row = (await client.get(f"/sites/{site['id']}", headers=staff)).json()
    assert row["status"] == "planned"
    assert row["status_label"] == "Planned"       # still renders
    assert row["status_color"] == "#0f7c86"


async def test_key_and_record_type_are_immutable(client, db, seeded_user):
    """Renaming a key would strand worker_profiles' blacklist_note_check, which
    hardcodes the literal 'blacklist' — extra="forbid" is the only thing
    stopping it, since nothing at the DB level does."""
    hdrs = await _make(db, client, "developer", "dev6@test.example.com")
    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"key": "renamed"})
    assert resp.status_code == 422
    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"record_type": "worker"})
    assert resp.status_code == 422


async def test_explicit_null_on_a_non_nullable_field_is_422(
        client, db, seeded_user):
    """All five mutable columns are NOT NULL (0012_status_values.py:33-38), but
    the schema types them `X | None` and exclude_unset INCLUDES an explicit
    null. Without the pre-check this setattr's None and 500s on IntegrityError.
    `description` has no min_length, so nothing else catches it."""
    hdrs = await _make(db, client, "developer", "dev9@test.example.com")
    for field in ("label", "description", "color", "sort_order", "is_active"):
        resp = await client.patch("/status-values/site/active", headers=hdrs,
                                  json={field: None})
        assert resp.status_code == 422, f"{field}: {resp.status_code}"


async def test_falsy_but_legal_values_are_accepted(client, db, seeded_user):
    """The regression guard for the null pre-check: `is_active=False` and
    `sort_order=0` are REAL values, not absent ones. A `not data[field]`
    predicate (as sites.py uses) would 422 both and silently kill the
    retirement mechanism. The predicate must reject null, not falsy."""
    hdrs = await _make(db, client, "developer", "dev10@test.example.com")
    # decommissioned seeds sort_order=4, so 0 is a genuine change
    resp = await client.patch("/status-values/site/decommissioned", headers=hdrs,
                              json={"sort_order": 0})
    assert resp.status_code == 200
    assert resp.json()["sort_order"] == 0

    resp = await client.patch("/status-values/site/decommissioned", headers=hdrs,
                              json={"is_active": False})
    assert resp.status_code == 200
    assert resp.json()["is_active"] is False

    # and empty-string description is legal — only null is not
    resp = await client.patch("/status-values/site/decommissioned", headers=hdrs,
                              json={"description": ""})
    assert resp.status_code == 200
    assert resp.json()["description"] == ""


async def test_unknown_record_type_on_write_is_422(client, db, seeded_user):
    """_record_type() is the registry chokepoint on both write paths — it is
    what keeps rt.table/rt.column out of user control."""
    hdrs = await _make(db, client, "developer", "dev11@test.example.com")
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "invoice", "key": "paid", "label": "Paid",
        "color": "#178a4c"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_record_type"

    resp = await client.patch("/status-values/invoice/paid", headers=hdrs,
                              json={"label": "Paid"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_record_type"


async def test_admin_with_settings_change_cannot_touch_the_vocabulary(
        client, db, seeded_user):
    """The capability admins lose: PATCH /site-statuses was settings:change."""
    hdrs = await _make(db, client, "admin", "ada@test.example.com")
    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"label": "Live"})
    assert resp.status_code == 403
    resp = await client.post("/status-values", headers=hdrs, json={
        "record_type": "site", "key": "x", "label": "X", "color": "#178a4c"})
    assert resp.status_code == 403


async def test_non_global_actor_with_devtools_override_is_hard_gated(
        client, db, seeded_user):
    """devtools is developer_only + visible_to={'global'} — the resolver hard
    gate blocks before overrides are read, so no _require_global is needed."""
    acme = Client(name="Acme SV")
    db.add(acme)
    await db.flush()
    contact = Person(first_name="C", last_name="SV")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_admin", client_id=acme.id))
    db.add(PermissionOverride(person_id=contact.id, resource="devtools",
                              action="change", allow=True))
    await db.commit()
    hdrs = await make_login(db, client, contact, "sv@acme.example.com")

    resp = await client.patch("/status-values/site/active", headers=hdrs,
                              json={"label": "Sneaky"})
    assert resp.status_code == 403


async def test_unknown_key_404s(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev7@test.example.com")
    resp = await client.patch("/status-values/site/haunted", headers=hdrs,
                              json={"label": "Nope"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "status_value_not_found"


async def test_patch_writes_an_audit_row(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev8@test.example.com")
    await client.patch("/status-values/site/active", headers=hdrs,
                       json={"label": "Live"})
    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "status_value", AuditLog.action == "update"))
    assert audit_row is not None
    assert audit_row.entity_id == "site:active"
    assert audit_row.changes["label"]["to"] == "Live"
