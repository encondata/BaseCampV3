"""Stakeholders: client/partner CRUD, contacts as scoped role grants."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import make_login

PW = "CorrectHorse9!"


async def _headers(client, email="alice@test.example.com"):
    resp = await client.post("/auth/login", json={"email": email, "password": PW})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _mk_person(db, first="Carl", last="Contact", email=None):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.commit()
    return person


async def test_client_crud_cycle(client, seeded_user):
    headers = await _headers(client)

    resp = await client.post("/clients", headers=headers, json={
        "name": "Acme Datacenters", "code": "ACME", "tier": "preferred",
        "city": "Las Vegas", "region": "NV", "website": "https://acme.example.com",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "Acme Datacenters"
    assert body["tier"] == "preferred"
    assert body["status"] == "active"
    assert body["contact_count"] == 0
    org_id = body["id"]

    # duplicate name rejected
    resp = await client.post("/clients", headers=headers,
                             json={"name": "acme datacenters"})
    assert resp.status_code == 409

    # update + manager assignment
    me = (await client.get("/auth/me/profile", headers=headers)).json()
    resp = await client.patch(f"/clients/{org_id}", headers=headers, json={
        "status": "inactive", "account_manager_id": me["id"]})
    assert resp.status_code == 200
    assert resp.json()["status"] == "inactive"
    assert resp.json()["account_manager"]["display_name"] == "Alice Anderson"

    # archive / unarchive
    assert (await client.post(f"/clients/{org_id}/archive",
                              headers=headers)).status_code == 204
    listing = (await client.get("/clients", headers=headers)).json()
    assert listing[0]["archived_at"] is not None
    assert (await client.post(f"/clients/{org_id}/unarchive",
                              headers=headers)).status_code == 204


async def test_client_contacts_are_scoped_grants(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")

    resp = await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 201
    # duplicate add → 409
    resp = await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 409

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert [c["display_name"] for c in contacts] == ["Carl Contact"]
    assert contacts[0]["has_account"] is False

    # the grant is a real person_roles row scoped to the client
    listing = (await client.get("/clients", headers=headers)).json()
    assert listing[0]["contact_count"] == 1

    # remove → revoked (history kept), count drops
    resp = await client.delete(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers)
    assert resp.status_code == 204
    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts == []
    from sqlalchemy import func, select
    total = await db.scalar(select(func.count()).select_from(PersonRole)
                            .where(PersonRole.person_id == person.id))
    assert total == 1  # revoked row preserved


async def test_partner_with_type_and_vendor_contact(client, seeded_user, db):
    headers = await _headers(client)
    resp = await client.post("/partners", headers=headers, json={
        "name": "Northwind Staffing", "partner_types": ["staffing"]})
    assert resp.status_code == 201
    org = resp.json()
    assert org["partner_types"] == ["staffing"]

    person = await _mk_person(db, first="Wanda", last="Worker")
    assert (await client.post(f"/partners/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    # vendor grant is partner-scoped in person_roles
    from sqlalchemy import select
    grant = (await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person.id,
        PersonRole.revoked_at.is_(None)))).one()
    assert grant.role == "vendor_viewer"
    assert str(grant.partner_id) == org["id"]
    assert grant.client_id is None


async def test_people_picker_lists_unaccounted(client, seeded_user, db):
    await _mk_person(db, first="No", last="Account")
    headers = await _headers(client)
    people = (await client.get("/people", headers=headers)).json()
    names = {p["display_name"]: p["has_account"] for p in people}
    assert names["Alice Anderson"] is True
    assert names["No Account"] is False


async def test_worker_cannot_touch_stakeholders(client, seeded_user, db):
    person = Person(first_name="Wan", last_name="Worker",
                    email="wan@test.example.com")
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email="wan@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role="worker"))
    await db.commit()

    headers = await _headers(client, email="wan@test.example.com")
    assert (await client.get("/clients", headers=headers)).status_code == 403
    assert (await client.post("/clients", headers=headers,
                              json={"name": "X"})).status_code == 403
    assert (await client.get("/people", headers=headers)).status_code == 403


async def test_search_finds_orgs(client, seeded_user):
    headers = await _headers(client)
    await client.post("/clients", headers=headers, json={"name": "Acme", "code": "ACM"})
    await client.post("/partners", headers=headers,
                      json={"name": "Northwind", "partner_types": ["staffing"]})
    body = (await client.get("/search?q=acm", headers=headers)).json()
    kinds = {(r["kind"], r["label"]) for r in body["results"]}
    assert ("client", "Acme") in kinds
    body = (await client.get("/search?q=northw", headers=headers)).json()
    assert ("partner", "Northwind") in {(r["kind"], r["label"]) for r in body["results"]}


async def test_partner_supplied_workers_list(client, seeded_user, db):
    headers = await _headers(client)
    partner = (await client.post("/partners", headers=headers, json={
        "name": "Northwind", "partner_types": ["staffing"]})).json()

    # a worker assigned to this partner
    w = await _mk_person(db, first="Wanda", last="Worker")
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    await client.put(f"/workers/{w.id}/profile", headers=headers, json={
        "trade": "Packer", "level": "L3", "partner_id": partner["id"]})

    # a direct-hire worker (no partner) — must NOT appear
    d = await _mk_person(db, first="Dee", last="Direct", email="dee2@test.example.com")
    db.add(PersonRole(person_id=d.id, role="worker"))
    await db.commit()
    await client.put(f"/workers/{d.id}/profile", headers=headers,
                     json={"trade": "Driver"})

    supplied = (await client.get(f"/partners/{partner['id']}/workers",
                                 headers=headers)).json()
    assert [x["display_name"] for x in supplied] == ["Wanda Worker"]
    assert supplied[0]["trade"] == "Packer"
    assert supplied[0]["level"] == "L3"
    # this route builds WorkerItem independently of workers.py:list_workers, and
    # OrgDirectory's rollup renders the chip straight from these two — a drift
    # here shows up as a blank chip, not an error
    assert supplied[0]["status_label"] == "Active"
    assert supplied[0]["status_color"] == "#178a4c"

    # unknown partner → 404
    import uuid
    assert (await client.get(f"/partners/{uuid.uuid4()}/workers",
                             headers=headers)).status_code == 404


async def _dev_headers(db, client, email="devlvl@test.example.com"):
    dev = Person(first_name="D", last_name="Ev", email=email)
    db.add(dev)
    await db.flush()
    db.add(UserAccount(
        person_id=dev.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=dev.id, role="developer"))
    await db.commit()
    return await _headers(client, email=email)


async def _partner_with_levelled_worker(client, db, headers, name, level):
    partner = (await client.post("/partners", headers=headers, json={
        "name": name, "partner_types": ["staffing"]})).json()
    w = await _mk_person(db, first="Lev", last=name.split()[0])
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    await client.put(f"/workers/{w.id}/profile", headers=headers, json={
        "trade": "Tech", "level": level, "partner_id": partner["id"]})
    return partner, w


async def test_vendor_viewer_gets_level_colour_without_workers_view(
        client, seeded_user, db):
    """The supplied-workers panel is reachable with partners:view alone, but
    /worker-levels needs workers:view — which vendor_viewer does NOT hold
    (access/defaults.py:35; vendor_owner/vendor_admin do). So the badge colour
    has to ride in on the row: fetch the scale client-side instead and every
    level badge silently greys out to the fallback for exactly this actor,
    while the roster beside it renders fine. That is a regression from the
    hardcoded LEVEL_COLORS map this replaced, which needed no permission."""
    import uuid

    headers = await _headers(client)
    partner, _w = await _partner_with_levelled_worker(
        client, db, headers, "Viewer Staffing", "L3")

    viewer = await _mk_person(db, first="Vera", last="Viewer")
    db.add(PersonRole(person_id=viewer.id, role="vendor_viewer",
                      partner_id=uuid.UUID(partner["id"])))
    await db.commit()
    vhdrs = await make_login(db, client, viewer, "vera@partner.example.com")

    # the premise — if this ever starts passing, the fix above is moot and the
    # client-side fetch would have been fine after all
    assert (await client.get("/worker-levels", headers=vhdrs)).status_code == 403

    supplied = (await client.get(f"/partners/{partner['id']}/workers",
                                 headers=vhdrs)).json()
    assert [x["display_name"] for x in supplied] == ["Lev Viewer"]
    assert supplied[0]["level"] == "L3"
    assert supplied[0]["level_color"] == "#35e0c8"      # real, not grey
    assert supplied[0]["level_color"] != "#8a93a6"      # the fallback


async def test_both_worker_routes_agree_on_level_colour(client, seeded_user, db):
    """workers.py:list_workers and stakeholders.py:list_partner_workers build
    WorkerItem independently — the drift status/labels.py exists to close. Both
    must read the colour through the shared level_fields() helper.

    The edit is load-bearing, not decoration: LEVEL_HEX seeded worker_levels
    with the *same* values the old hardcoded LEVEL_COLORS map held, so asserting
    a canonical colour cannot tell a table read from a re-hardcoded map. Only a
    colour that has since MOVED discriminates."""
    headers = await _headers(client)
    partner, w = await _partner_with_levelled_worker(
        client, db, headers, "Drift Staffing", "L5")

    dev = await _dev_headers(db, client)
    assert (await client.patch("/worker-levels/L5", headers=dev,
                               json={"color": "#ff5733"})).status_code == 200

    listed = (await client.get("/workers", headers=headers)).json()
    supplied = (await client.get(f"/partners/{partner['id']}/workers",
                                 headers=headers)).json()
    mine = next(x for x in listed if x["person_id"] == str(w.id))
    theirs = next(x for x in supplied if x["person_id"] == str(w.id))

    assert mine["level"] == theirs["level"] == "L5"
    # agree with each other AND with the edit — a route that re-derived the
    # colour locally would still be sitting on L5's seeded #a78bfa
    assert mine["level_color"] == theirs["level_color"] == "#ff5733"


async def test_unleveled_worker_has_no_level_colour(client, seeded_user, db):
    """level is nullable — 'unleveled' is not an unknown level. It renders as a
    neutral chip with no colour, so level_color must be null rather than taking
    the fallback (mirroring sites.py's null site_type -> type_color)."""
    headers = await _headers(client)
    d = await _mk_person(db, first="Dee", last="Direct", email="dee3@test.example.com")
    db.add(PersonRole(person_id=d.id, role="worker"))
    await db.commit()
    await client.put(f"/workers/{d.id}/profile", headers=headers,
                     json={"trade": "Driver"})

    listed = (await client.get("/workers", headers=headers)).json()
    row = next(x for x in listed if x["person_id"] == str(d.id))
    assert row["level"] is None and row["level_color"] is None


async def test_partner_multiple_types(client, seeded_user):
    headers = await _headers(client)
    resp = await client.post("/partners", headers=headers, json={
        "name": "OmniCorp", "partner_types": ["staffing", "logistics"]})
    assert resp.status_code == 201
    assert resp.json()["partner_types"] == ["staffing", "logistics"]

    # edit to a different set
    pid = resp.json()["id"]
    resp = await client.patch(f"/partners/{pid}", headers=headers, json={
        "partner_types": ["logistics", "subcontractor", "consultant"]})
    assert resp.json()["partner_types"] == ["logistics", "subcontractor", "consultant"]

    # invalid type rejected
    resp = await client.post("/partners", headers=headers, json={
        "name": "Bad", "partner_types": ["staffing", "spaceships"]})
    assert resp.status_code == 422


async def test_patch_org_writes_audit_row(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()

    resp = await client.patch(f"/clients/{org['id']}", headers=headers,
                              json={"status": "inactive"})
    assert resp.status_code == 200

    from sqlalchemy import select
    from serversherpa.db.models import AuditLog
    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "client",
        AuditLog.entity_id == org["id"],
        AuditLog.action == "update"))).one_or_none()
    assert row is not None                      # the audit row was committed
    assert row.changes["status"] == {"from": "active", "to": "inactive"}
    assert row.actor_person_id == seeded_user.id


async def test_contact_add_defaults_to_viewer_tier(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")

    resp = await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 201

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["tier"] == "viewer"

    from sqlalchemy import select
    grant = (await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person.id,
        PersonRole.revoked_at.is_(None)))).one()
    assert grant.role == "client_viewer"


async def test_contact_add_with_explicit_tier(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/partners", headers=headers, json={
        "name": "Northwind", "partner_types": ["staffing"]})).json()
    person = await _mk_person(db, first="Wanda", last="Worker")

    resp = await client.post(f"/partners/{org['id']}/contacts", headers=headers,
                             json={"person_id": str(person.id), "tier": "admin"})
    assert resp.status_code == 201

    contacts = (await client.get(f"/partners/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["tier"] == "admin"

    from sqlalchemy import select
    grant = (await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person.id,
        PersonRole.revoked_at.is_(None)))).one()
    assert grant.role == "vendor_admin"


async def test_contact_tier_change_revokes_and_grants_with_history(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"tier": "admin"})
    assert resp.status_code == 200

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["tier"] == "admin"

    from sqlalchemy import func, select
    total = await db.scalar(select(func.count()).select_from(PersonRole)
                            .where(PersonRole.person_id == person.id))
    assert total == 2  # old revoked row preserved + new grant

    active = (await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person.id,
        PersonRole.revoked_at.is_(None)))).one()
    assert active.role == "client_admin"

    revoked = (await db.scalars(select(PersonRole).where(
        PersonRole.person_id == person.id,
        PersonRole.revoked_at.is_not(None)))).one()
    assert revoked.role == "client_viewer"
    assert revoked.revoked_by == seeded_user.id

    from serversherpa.db.models import AuditLog
    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "client",
        AuditLog.entity_id == org["id"],
        AuditLog.action == "contact.tier"))).one()
    assert row.changes["tier"] == {"from": "viewer", "to": "admin"}


async def test_contact_tier_change_404_when_not_a_contact(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db)

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"tier": "admin"})
    assert resp.status_code == 404


async def test_contact_remove_revokes_whatever_tier_is_active(client, seeded_user, db):
    """A contact upgraded past the default viewer tier must still be
    removable — remove_contact must not hardcode the viewer role."""
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id),
                                    "tier": "owner"})).status_code == 201

    resp = await client.delete(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers)
    assert resp.status_code == 204

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts == []


async def test_contact_add_rank_too_low_for_new_tier(client, seeded_user, db):
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import Client
    from serversherpa.security.passwords import hash_password

    org = Client(name="Acme")
    db.add(org)
    await db.flush()
    owner = Person(first_name="Own", last_name="Er", email="owner@acme.example.com")
    db.add(owner)
    await db.flush()
    db.add(UserAccount(
        person_id=owner.id, email="owner@acme.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=owner.id, role="client_owner", client_id=org.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "owner@acme.example.com", "password": PW})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    target = await _mk_person(db, first="New", last="Contact",
                              email="newc@acme.example.com")
    resp = await client.post(f"/clients/{org.id}/contacts", headers=hdrs,
                             json={"person_id": str(target.id), "tier": "owner"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_contact_tier_change_rank_too_low_for_target(client, seeded_user, db):
    """Even when the new tier is within reach, changing the tier of a
    person whose current max rank the actor can't touch is blocked."""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import Client
    from serversherpa.security.passwords import hash_password

    org = Client(name="Acme")
    db.add(org)
    await db.flush()
    admin = Person(first_name="Ad", last_name="Min", email="admin@acme.example.com")
    db.add(admin)
    await db.flush()
    db.add(UserAccount(
        person_id=admin.id, email="admin@acme.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=admin.id, role="client_admin", client_id=org.id))
    await db.commit()

    # target already a viewer-tier contact of this org, but ALSO holds a
    # global "staff" role (rank 40) — above the client_admin actor's rank (20)
    target = Person(first_name="Hi", last_name="Rank", email="hirank@acme.example.com")
    db.add(target)
    await db.flush()
    db.add(PersonRole(person_id=target.id, role="client_viewer", client_id=org.id))
    db.add(PersonRole(person_id=target.id, role="staff"))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "admin@acme.example.com", "password": PW})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    resp = await client.patch(f"/clients/{org.id}/contacts/{target.id}",
                              headers=hdrs, json={"tier": "viewer"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_inline_created_person_can_be_linked_as_contact(client, seeded_user):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()

    resp = await client.post("/users", headers=headers, json={
        "first_name": "Bare", "last_name": "Person",
        "create_account": False, "roles": []})
    assert resp.status_code == 201
    person_id = resp.json()["person_id"]

    resp = await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                             json={"person_id": person_id, "tier": "admin"})
    assert resp.status_code == 201

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["tier"] == "admin"
    assert contacts[0]["has_account"] is False


async def test_contact_patch_metadata_upserts_org_title_and_functions(
    client, seeded_user, db,
):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers,
                              json={"org_title": "  VP Sales  ",
                                    "functions": ["billing", "billing", " escalation "]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["org_title"] == "VP Sales"                 # trimmed
    assert body["functions"] == ["billing", "escalation"]  # dedupe + trim, order kept
    assert body["tier"] == "viewer"                         # untouched

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["org_title"] == "VP Sales"
    assert contacts[0]["functions"] == ["billing", "escalation"]

    # a second PATCH updates the same row in place (upsert, not insert)
    from sqlalchemy import func, select
    from serversherpa.db.models import ContactProfile
    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"org_title": "Director"})
    assert resp.status_code == 200
    count = await db.scalar(select(func.count()).select_from(ContactProfile)
                            .where(ContactProfile.person_id == person.id))
    assert count == 1
    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["org_title"] == "Director"
    assert contacts[0]["functions"] == ["billing", "escalation"]  # untouched by 2nd PATCH


async def test_contact_patch_org_title_null_clears(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201
    await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                       headers=headers, json={"org_title": "VP Sales"})

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"org_title": None})
    assert resp.status_code == 200
    assert resp.json()["org_title"] is None


async def test_contact_patch_functions_validation(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    # empty-after-trim tag rejected
    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"functions": ["  "]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_functions"

    # over the 40-char per-tag cap rejected
    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"functions": ["x" * 41]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_functions"

    # over the 12-tag cap (after dedupe) rejected
    resp = await client.patch(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers,
        json={"functions": [f"tag{i}" for i in range(13)]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_functions"

    # exactly 12 distinct tags is fine
    resp = await client.patch(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers,
        json={"functions": [f"tag{i}" for i in range(12)]})
    assert resp.status_code == 200
    assert len(resp.json()["functions"]) == 12


async def test_contact_patch_functions_null_clears(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201
    await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                       headers=headers, json={"functions": ["billing"]})

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={"functions": None})
    assert resp.status_code == 200
    assert resp.json()["functions"] == []

    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["functions"] == []


async def test_contact_patch_functions_dedupe_is_case_insensitive(
    client, seeded_user, db,
):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    resp = await client.patch(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers,
        json={"functions": ["Billing", "billing", "BILLING", "Escalation"]})
    assert resp.status_code == 200
    # first-seen casing wins, case-insensitive dedupe
    assert resp.json()["functions"] == ["Billing", "Escalation"]


async def test_contact_patch_writes_contact_update_audit_row(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers,
                              json={"org_title": "VP Sales", "functions": ["billing"]})
    assert resp.status_code == 200

    from sqlalchemy import select
    from serversherpa.db.models import AuditLog
    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "client",
        AuditLog.entity_id == org["id"],
        AuditLog.action == "contact.update"))).one()
    assert row.changes["org_title"] == {"from": None, "to": "VP Sales"}
    assert row.changes["functions"] == {"from": [], "to": ["billing"]}
    assert row.actor_person_id == seeded_user.id


async def test_contact_patch_tier_and_metadata_together_writes_both_audit_rows(
    client, seeded_user, db,
):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    resp = await client.patch(
        f"/clients/{org['id']}/contacts/{person.id}", headers=headers,
        json={"tier": "admin", "org_title": "VP Sales"})
    assert resp.status_code == 200
    assert resp.json()["tier"] == "admin"
    assert resp.json()["org_title"] == "VP Sales"

    from sqlalchemy import select
    from serversherpa.db.models import AuditLog
    actions = {row.action for row in (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "client", AuditLog.entity_id == org["id"])))}
    assert "contact.tier" in actions
    assert "contact.update" in actions


async def test_contact_patch_metadata_only_no_op_writes_no_audit_row(
    client, seeded_user, db,
):
    """A PATCH with unset/matching values shouldn't fabricate an audit row
    (mirrors the empty-diff-skip convention used elsewhere in the app)."""
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201

    resp = await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                              headers=headers, json={})
    assert resp.status_code == 200

    from sqlalchemy import func, select
    from serversherpa.db.models import AuditLog
    count = await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.entity_type == "client", AuditLog.entity_id == org["id"],
        AuditLog.action.in_(("contact.tier", "contact.update"))))
    assert count == 0


async def test_contact_patch_metadata_only_still_enforces_target_rank_rule(
    client, seeded_user, db,
):
    """Rank rules apply only when tier changes per the design spec — but a
    metadata-only edit must still respect the target-person rank rule."""
    from datetime import UTC, datetime

    from serversherpa.config import get_settings
    from serversherpa.db.models import Client
    from serversherpa.security.passwords import hash_password

    org = Client(name="Acme")
    db.add(org)
    await db.flush()
    admin = Person(first_name="Ad", last_name="Min", email="admin@acme.example.com")
    db.add(admin)
    await db.flush()
    db.add(UserAccount(
        person_id=admin.id, email="admin@acme.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=admin.id, role="client_admin", client_id=org.id))
    await db.commit()

    target = Person(first_name="Hi", last_name="Rank", email="hirank@acme.example.com")
    db.add(target)
    await db.flush()
    db.add(PersonRole(person_id=target.id, role="client_viewer", client_id=org.id))
    db.add(PersonRole(person_id=target.id, role="staff"))  # rank 40 > client_admin's 20
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "admin@acme.example.com", "password": PW})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    resp = await client.patch(f"/clients/{org.id}/contacts/{target.id}",
                              headers=hdrs, json={"org_title": "VP Sales"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"


async def test_contact_delete_removes_contact_profile_row(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    person = await _mk_person(db, email="carl@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201
    await client.patch(f"/clients/{org['id']}/contacts/{person.id}",
                       headers=headers, json={"org_title": "VP Sales"})

    from sqlalchemy import func, select
    from serversherpa.db.models import ContactProfile
    count_before = await db.scalar(select(func.count()).select_from(ContactProfile)
                                   .where(ContactProfile.person_id == person.id))
    assert count_before == 1

    resp = await client.delete(f"/clients/{org['id']}/contacts/{person.id}",
                               headers=headers)
    assert resp.status_code == 204

    count_after = await db.scalar(select(func.count()).select_from(ContactProfile)
                                  .where(ContactProfile.person_id == person.id))
    assert count_after == 0

    # re-adding the contact starts with clean metadata (no leftover title/tags)
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(person.id)})).status_code == 201
    contacts = (await client.get(f"/clients/{org['id']}/contacts",
                                 headers=headers)).json()
    assert contacts[0]["org_title"] is None
    assert contacts[0]["functions"] == []


async def test_client_contact_sees_only_their_org(client, db, seeded_user):
    from serversherpa.config import get_settings
    from serversherpa.db.models import Client, Person, PersonRole, UserAccount
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    ca, cb = Client(name="Acme"), Client(name="Bcme")
    db.add_all([ca, cb])
    await db.flush()
    contact = Person(first_name="C", last_name="Contact",
                     email="contact@acme.example.com")
    db.add(contact)
    await db.flush()
    db.add(UserAccount(person_id=contact.id, email="contact@acme.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=ca.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "contact@acme.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    listing = (await client.get("/clients", headers=hdrs)).json()
    names = {c["name"] for c in listing}
    assert names == {"Acme"}                       # scoped list
    resp = await client.get(f"/clients/{cb.id}", headers=hdrs)
    assert resp.status_code == 404                 # out-of-scope detail = 404
    resp = await client.get("/partners", headers=hdrs)
    assert resp.status_code == 403                 # no partners:view


async def test_partner_type_vocabulary(client, seeded_user, db):
    """partner_types is now an admin-editable status_values vocabulary,
    not a hardcoded Literal — validated against status_values on write."""
    headers = await _headers(client)

    resp = await client.post("/partners", headers=headers, json={
        "name": "Tech Co", "partner_types": ["tech"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["partner_types"] == ["tech"]
    pid = resp.json()["id"]

    resp = await client.post("/partners", headers=headers, json={
        "name": "Bad Co", "partner_types": ["hovercraft"]})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "unknown_partner_type"
    assert resp.json()["detail"]["values"] == ["hovercraft"]

    # the five keys that already existed before this migration still work
    resp = await client.post("/partners", headers=headers, json={
        "name": "Legacy Co",
        "partner_types": ["staffing", "logistics", "subcontractor",
                          "consultant", "other"]})
    assert resp.status_code == 201, resp.text
    assert resp.json()["partner_types"] == [
        "staffing", "logistics", "subcontractor", "consultant", "other"]

    resp = await client.patch(f"/partners/{pid}", headers=headers, json={
        "partner_types": ["hovercraft"]})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "unknown_partner_type"

    # the Variables page usage counter must see partner_types the same way
    # it sees initiatives.shipping_types — via unnest() on a text[] column
    dev = Person(first_name="D", last_name="Dev")
    db.add(dev)
    await db.flush()
    db.add(PersonRole(person_id=dev.id, role="developer"))
    await db.commit()
    dev_headers = await make_login(db, client, dev, "dev@test.example.com")

    resp = await client.get("/status-values", headers=dev_headers)
    assert resp.status_code == 200, resp.text
    by_key = {r["key"]: r for r in resp.json() if r["record_type"] == "partner_type"}
    assert len(by_key) == 7
    assert by_key["tech"]["usage_count"] == 1
    assert by_key["cable"]["usage_count"] == 0
    assert by_key["staffing"]["usage_count"] == 1


async def test_partner_has_no_tier_but_records_service_region(client, seeded_user):
    """Partners dropped tier in favor of a freeform service_region. Creating
    one without tier succeeds (tier comes back None), sending tier is
    rejected outright, and service_region round-trips through create and
    patch — including '' normalizing to NULL."""
    headers = await _headers(client)

    resp = await client.post("/partners", headers=headers, json={"name": "Southline Corp"})
    assert resp.status_code == 201, resp.text
    org = resp.json()
    assert org["tier"] is None
    assert org["service_region"] is None
    pid = org["id"]

    # sending tier to a partner is rejected, not silently ignored
    resp = await client.post("/partners", headers=headers,
                             json={"name": "Bad Tier Co", "tier": "standard"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "tier_not_allowed"

    resp = await client.patch(f"/partners/{pid}", headers=headers, json={"tier": "preferred"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "tier_not_allowed"

    # service_region accepts any freeform string and round-trips
    resp = await client.patch(f"/partners/{pid}", headers=headers,
                              json={"service_region": "Southeast US"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["service_region"] == "Southeast US"

    listed = (await client.get("/partners", headers=headers)).json()
    row = next(r for r in listed if r["id"] == pid)
    assert row["service_region"] == "Southeast US"
    assert row["tier"] is None

    # '' normalizes to NULL
    resp = await client.patch(f"/partners/{pid}", headers=headers,
                              json={"service_region": ""})
    assert resp.status_code == 200, resp.text
    assert resp.json()["service_region"] is None

    # can be set directly on create too
    resp = await client.post("/partners", headers=headers, json={
        "name": "Northline Corp", "service_region": "Pacific Northwest"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["service_region"] == "Pacific Northwest"


async def test_client_tier_unchanged_and_rejects_service_region(client, seeded_user):
    """Clients keep tier exactly as before; sending service_region to a
    client is rejected the same way tier is rejected for partners."""
    headers = await _headers(client)

    resp = await client.post("/clients", headers=headers, json={"name": "Acme West"})
    assert resp.status_code == 201, resp.text
    org = resp.json()
    assert org["tier"] == "standard"     # unchanged default behavior
    assert org["service_region"] is None
    cid = org["id"]

    resp = await client.patch(f"/clients/{cid}", headers=headers, json={"tier": "strategic"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["tier"] == "strategic"

    # tier still required (cannot be nulled) for clients
    resp = await client.patch(f"/clients/{cid}", headers=headers, json={"tier": None})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "tier_required"

    # sending service_region to a client is rejected outright
    resp = await client.post("/clients", headers=headers,
                             json={"name": "Bad Region Co", "service_region": "Midwest"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "service_region_not_allowed"

    resp = await client.patch(f"/clients/{cid}", headers=headers,
                              json={"service_region": "Midwest"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "service_region_not_allowed"


async def test_partner_service_region_change_is_audited(client, seeded_user, db):
    from sqlalchemy import select

    from serversherpa.db.models import AuditLog

    headers = await _headers(client)
    org = (await client.post("/partners", headers=headers,
                             json={"name": "Auditable Partners"})).json()

    resp = await client.patch(f"/partners/{org['id']}", headers=headers,
                              json={"service_region": "New England"})
    assert resp.status_code == 200, resp.text

    row = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "partner", AuditLog.entity_id == org["id"],
        AuditLog.action == "update"))).one()
    assert row.changes["service_region"] == {"from": None, "to": "New England"}
