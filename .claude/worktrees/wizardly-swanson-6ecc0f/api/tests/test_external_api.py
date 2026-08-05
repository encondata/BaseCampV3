"""GET /external — combined directory of client/partner contacts and
external-role people, with per-org-link metadata and login lifecycle."""

from datetime import UTC, datetime

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Person,
    PersonRole,
    PermissionOverride,
    UserAccount,
)
from serversherpa.security.passwords import hash_password

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


async def _mk_login_person(db, first, last, email, *, disabled=False):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value()),
        password_updated_at=datetime.now(UTC),
        disabled_at=datetime.now(UTC) if disabled else None,
    ))
    await db.commit()
    return person


async def test_external_directory_shape_and_multi_org_and_metadata(
    client, seeded_user, db,
):
    headers = await _headers(client)
    client_org = (await client.post("/clients", headers=headers,
                                    json={"name": "Acme"})).json()
    partner_org = (await client.post("/partners", headers=headers, json={
        "name": "Northwind", "partner_types": ["staffing"]})).json()

    person = await _mk_person(db, first="Carl", last="Contact",
                              email="carl@acme.example.com")

    assert (await client.post(f"/clients/{client_org['id']}/contacts",
                              headers=headers,
                              json={"person_id": str(person.id),
                                    "tier": "admin"})).status_code == 201
    assert (await client.post(f"/partners/{partner_org['id']}/contacts",
                              headers=headers,
                              json={"person_id": str(person.id),
                                    "tier": "viewer"})).status_code == 201

    resp = await client.patch(
        f"/clients/{client_org['id']}/contacts/{person.id}", headers=headers,
        json={"org_title": "VP Sales", "functions": ["billing", "escalation"]})
    assert resp.status_code == 200

    resp = await client.get("/external", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["people"]) == 1     # one row per person, even with 2 org links
    row = body["people"][0]
    assert row["person_id"] == str(person.id)
    assert row["display_name"] == "Carl Contact"
    assert row["first_name"] == "Carl"
    assert row["last_name"] == "Contact"
    assert row["email"] == "carl@acme.example.com"
    assert row["has_login"] is False
    assert row["login_status"] == "none"

    links = {(link["kind"], link["org_id"]): link for link in row["links"]}
    client_link = links[("client", client_org["id"])]
    assert client_link["org_name"] == "Acme"
    assert client_link["tier"] == "admin"
    assert client_link["org_title"] == "VP Sales"
    assert client_link["functions"] == ["billing", "escalation"]

    partner_link = links[("partner", partner_org["id"])]
    assert partner_link["org_name"] == "Northwind"
    assert partner_link["tier"] == "viewer"
    assert partner_link["org_title"] is None
    assert partner_link["functions"] == []

    assert "billing" in body["function_tags"]
    assert "escalation" in body["function_tags"]
    assert body["function_tags"] == sorted(body["function_tags"])


async def test_external_login_status_variants(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()

    none_person = await _mk_person(db, first="No", last="Login",
                                   email="nologin@acme.example.com")
    active_person = await _mk_login_person(
        db, "Active", "Login", "active@acme.example.com")
    disabled_person = await _mk_login_person(
        db, "Disabled", "Login", "disabled@acme.example.com", disabled=True)

    for p in (none_person, active_person, disabled_person):
        assert (await client.post(f"/clients/{org['id']}/contacts",
                                  headers=headers,
                                  json={"person_id": str(p.id)})).status_code == 201

    body = (await client.get("/external", headers=headers)).json()
    status_by_name = {row["display_name"]: row["login_status"]
                      for row in body["people"]}
    has_login_by_name = {row["display_name"]: row["has_login"]
                         for row in body["people"]}
    assert status_by_name["No Login"] == "none"
    assert status_by_name["Active Login"] == "active"
    assert status_by_name["Disabled Login"] == "disabled"
    assert has_login_by_name["No Login"] is False
    assert has_login_by_name["Active Login"] is True
    assert has_login_by_name["Disabled Login"] is True


async def test_external_includes_external_role_holders_with_no_org_link(
    client, seeded_user, db,
):
    headers = await _headers(client)
    ext = await _mk_person(db, first="Ext", last="Only",
                           email="extonly@example.com")
    db.add(PersonRole(person_id=ext.id, role="external"))
    await db.commit()

    body = (await client.get("/external", headers=headers)).json()
    row = next(r for r in body["people"] if r["person_id"] == str(ext.id))
    assert row["links"] == []


async def test_external_non_global_actor_sees_only_self(client, seeded_user, db):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    other = await _mk_person(db, first="Other", last="Contact",
                             email="other@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(other.id)})).status_code == 201

    # a self-anchored external-role person, granted users:view via a
    # per-person override (the only way a non-global anchor can ever reach
    # this gate — see resources.py visible_to)
    self_person = await _mk_login_person(
        db, "Self", "Viewer", "selfviewer@example.com")
    db.add(PersonRole(person_id=self_person.id, role="external"))
    db.add(PermissionOverride(person_id=self_person.id, resource="users",
                              action="view", allow=True,
                              set_by=seeded_user.id))
    await db.commit()

    self_headers = await _headers(client, email="selfviewer@example.com")
    body = (await client.get("/external", headers=self_headers)).json()
    assert [r["person_id"] for r in body["people"]] == [str(self_person.id)]

    # the global actor still sees everyone
    full = (await client.get("/external", headers=headers)).json()
    names = {r["display_name"] for r in full["people"]}
    assert names == {"Other Contact", "Self Viewer"}


async def test_external_function_tags_empty_for_non_global_actor(
    client, seeded_user, db,
):
    headers = await _headers(client)
    org = (await client.post("/clients", headers=headers,
                             json={"name": "Acme"})).json()
    other = await _mk_person(db, first="Other", last="Contact",
                             email="other@acme.example.com")
    assert (await client.post(f"/clients/{org['id']}/contacts", headers=headers,
                              json={"person_id": str(other.id)})).status_code == 201
    assert (await client.patch(
        f"/clients/{org['id']}/contacts/{other.id}", headers=headers,
        json={"functions": ["billing"]})).status_code == 200

    # a self-anchored external-role person, granted users:view via a
    # per-person override — same setup as the "sees only self" scope test
    self_person = await _mk_login_person(
        db, "Self", "Viewer", "selfviewer@example.com")
    db.add(PersonRole(person_id=self_person.id, role="external"))
    db.add(PermissionOverride(person_id=self_person.id, resource="users",
                              action="view", allow=True,
                              set_by=seeded_user.id))
    await db.commit()

    self_headers = await _headers(client, email="selfviewer@example.com")
    self_body = (await client.get("/external", headers=self_headers)).json()
    assert self_body["function_tags"] == []

    # the global actor still sees the aggregated tags
    full = (await client.get("/external", headers=headers)).json()
    assert "billing" in full["function_tags"]


async def test_external_requires_users_view_permission(client, seeded_user, db):
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
    resp = await client.get("/external", headers=headers)
    assert resp.status_code == 403
