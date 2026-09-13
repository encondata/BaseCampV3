"""Attachment flow: avatar upload/replace/delete against real MinIO."""

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Initiative, Partner, Person, PersonRole, ReportDefinition, UserAccount,
)
from serversherpa.security.passwords import hash_password

LOGIN = {"email": "alice@test.example.com", "password": "CorrectHorse9!"}

# tiny valid 1x1 PNG
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082")


async def _login(client, email=LOGIN["email"]):
    resp = await client.post("/auth/login",
                             json={"email": email, "password": LOGIN["password"]})
    assert resp.status_code == 200
    body = resp.json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body["person"]["id"]


def _upload(client, headers, person_id, data=PNG, filename="me.png"):
    return client.post(
        "/attachments",
        headers=headers,
        data={"entity_type": "person", "entity_id": str(person_id), "kind": "avatar"},
        files={"file": (filename, data, "image/png")},
    )


async def test_avatar_upload_sets_person_avatar(client, seeded_user):
    headers, person_id = await _login(client)

    resp = await _upload(client, headers, person_id)
    assert resp.status_code == 201
    body = resp.json()
    assert body["kind"] == "avatar"
    assert body["content_type"] == "image/png"
    assert body["storage_key"].startswith(f"attachments/person/{person_id}/avatar/")
    assert body["url"] and "X-Amz-Signature" in body["url"]

    # profile + session responses now carry the presigned avatar url
    me = (await client.get("/auth/me/profile", headers=headers)).json()
    assert me["avatar_key"] == body["storage_key"]
    assert me["avatar_url"]

    # and the stored object is actually retrievable via the presigned URL
    import httpx
    async with httpx.AsyncClient() as raw:
        obj = await raw.get(body["url"])
    assert obj.status_code == 200
    assert obj.content == PNG


async def test_avatar_replace_retires_previous(client, seeded_user):
    headers, person_id = await _login(client)
    first = (await _upload(client, headers, person_id)).json()
    second = (await _upload(client, headers, person_id)).json()
    assert first["storage_key"] != second["storage_key"]

    listing = (await client.get(
        "/attachments",
        headers=headers,
        params={"entity_type": "person", "entity_id": person_id, "kind": "avatar"},
    )).json()
    assert [a["storage_key"] for a in listing] == [second["storage_key"]]

    me = (await client.get("/auth/me/profile", headers=headers)).json()
    assert me["avatar_key"] == second["storage_key"]


async def test_avatar_delete_clears_person(client, seeded_user):
    headers, person_id = await _login(client)
    att = (await _upload(client, headers, person_id)).json()
    resp = await client.delete(f"/attachments/{att['id']}", headers=headers)
    assert resp.status_code == 204
    me = (await client.get("/auth/me/profile", headers=headers)).json()
    assert me["avatar_key"] is None
    assert me["avatar_url"] is None


async def test_non_image_rejected(client, seeded_user):
    headers, person_id = await _login(client)
    resp = await _upload(client, headers, person_id,
                         data=b"#!/bin/sh\nrm -rf /\n", filename="evil.png")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_an_image"


async def test_worker_cannot_set_someone_elses_avatar(client, seeded_user, db):
    person = Person(first_name="Wan", last_name="Worker", email="wan@test.example.com")
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email="wan@test.example.com",
        password_hash=hash_password(
            LOGIN["password"], pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role="worker"))
    await db.commit()

    _, alice_id = await _login(client)
    wan_headers, wan_id = await _login(client, email="wan@test.example.com")

    # wan can set his own…
    assert (await _upload(client, wan_headers, wan_id)).status_code == 201
    # …but not alice's — "worker" holds no attachments grant, and it's not
    # his own avatar, so require_permission-style access.can() says no.
    resp = await _upload(client, wan_headers, alice_id)
    assert resp.status_code == 403


async def _login_as(client, db, seeded_user, role):
    """Retarget the seeded staff grant to a different role, then log in."""
    from sqlalchemy import text
    await db.execute(text(
        "UPDATE person_roles SET role=:r WHERE person_id=:p"),
        {"r": role, "p": seeded_user.id})
    await db.commit()
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def test_founder_can_manage_someone_elses_avatar(client, seeded_user, db):
    """founder/super_admin hold `attachments` grants via the permission
    matrix, not the literal role name "admin"/"staff" — require_permission
    (via access.can) must honor that, unlike the old has_role bypass."""
    worker = Person(first_name="Wan", last_name="Worker", email="wan@test.example.com")
    db.add(worker)
    await db.flush()
    db.add(UserAccount(
        person_id=worker.id, email="wan@test.example.com",
        password_hash=hash_password(
            LOGIN["password"], pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    wan_id = worker.id

    for role in ("founder", "super_admin"):
        headers = await _login_as(client, db, seeded_user, role)
        resp = await _upload(client, headers, wan_id)
        assert resp.status_code == 201, f"{role} should manage another person's avatar"


async def test_plain_worker_manages_own_avatar_only(client, seeded_user, db):
    """A plain worker (no attachments grant at all) can always manage their
    own avatar via the self-service bypass, but never someone else's."""
    headers = await _login_as(client, db, seeded_user, "worker")
    person_id = seeded_user.id

    assert (await _upload(client, headers, person_id)).status_code == 201

    other = Person(first_name="Other", last_name="Person")
    db.add(other)
    await db.commit()
    resp = await _upload(client, headers, other.id)
    assert resp.status_code == 403


async def test_initiative_attachments_list_empty(client, seeded_user, db):
    """initiative is a registered attachment host (ENTITY_MODEL) even though
    it has no avatar slot — listing on a fresh initiative just 200s empty."""
    headers, _ = await _login(client)
    initiative = Initiative(name="host-initiative-1", initiative_type="project")
    db.add(initiative)
    await db.commit()

    resp = await client.get(
        "/attachments",
        headers=headers,
        params={"entity_type": "initiative", "entity_id": str(initiative.id)},
    )
    assert resp.status_code == 200
    assert resp.json() == []


async def test_client_anchored_override_denied_without_scope_map(client, seeded_user, db):
    """A client_viewer (client-anchored, non-global) who has been handed an
    admin-set `attachments:view` override must still be denied on someone
    else's attachments — attachments has no SCOPE_COLUMNS entry, so there's
    nothing to check the override against, and the backstop in _authorize
    denies any non-global actor outright. Self-service on her own avatar
    stays unaffected."""
    from sqlalchemy import text as sa_text

    from serversherpa.db.models import Client, PermissionOverride

    other = Person(first_name="Other", last_name="Person")
    db.add(other)
    await db.commit()
    other_id = other.id

    # while alice is still plain staff, seed an avatar for the other person
    headers, alice_id = await _login(client)
    assert (await _upload(client, headers, other_id)).status_code == 201

    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()

    # retarget alice to a client-anchored role and hand her an explicit
    # admin override for attachments:view
    await db.execute(sa_text(
        "UPDATE person_roles SET role='client_viewer', client_id=:c "
        "WHERE person_id=:p"),
        {"c": acme.id, "p": seeded_user.id})
    db.add(PermissionOverride(person_id=seeded_user.id, resource="attachments",
                              action="view", allow=True))
    await db.commit()

    headers, _ = await _login(client)

    # blocked: the override says "view" is allowed, but she's not a global
    # actor and attachments has no scope map to vet the grant against
    resp = await client.get(
        "/attachments",
        headers=headers,
        params={"entity_type": "person", "entity_id": other_id},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    # unaffected: self-service still works for her own avatar — but the
    # list route only recognizes the bypass with an explicit kind=avatar
    # filter (security-fixes task 2 finding (a): the self-service bypass
    # is avatars-only, and a list request with no kind filter can't prove
    # every row would be one, so it falls through to the same denied
    # `attachments` gate as everything else on this account)
    assert (await _upload(client, headers, alice_id)).status_code == 201
    resp = await client.get(
        "/attachments",
        headers=headers,
        params={"entity_type": "person", "entity_id": alice_id, "kind": "avatar"},
    )
    assert resp.status_code == 200


async def test_truck_attachments_list_empty(client, seeded_user, db):
    """truck is a registered attachment host (ENTITY_MODEL) — the truck
    detail page's Notes & Files panel lists attachments on it."""
    from serversherpa.db.models import Truck
    headers, _ = await _login(client)
    truck = Truck(name="host-truck-att-1")
    db.add(truck)
    await db.commit()

    resp = await client.get(
        "/attachments",
        headers=headers,
        params={"entity_type": "truck", "entity_id": str(truck.id)},
    )
    assert resp.status_code == 200
    assert resp.json() == []


# ── Site & Move Survey: survey_template / report_asset kinds ────────

async def _make(db, client, role, email):
    """A fresh user with the given role, logged in — same recipe as
    test_status_values_write.py's helper, duplicated here to keep this
    file's fixture-free login story self-contained."""
    p = Person(first_name="R", last_name="X", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            LOGIN["password"], pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    headers, _ = await _login(client, email=email)
    return headers


def _upload_entity(client, headers, entity_type, entity_id, kind, data, filename):
    return client.post(
        "/attachments",
        headers=headers,
        data={"entity_type": entity_type, "entity_id": str(entity_id), "kind": kind},
        files={"file": (filename, data, "application/octet-stream")},
    )


async def test_survey_template_rejected_on_a_partner(client, db, seeded_user):
    """survey_template is the Site & Move Survey xlsx questionnaire
    template — templates are company-owned, attached to the report
    definition, not the partner, so a partner-targeted upload 422s."""
    headers, _ = await _login(client)
    partner = Partner(name="Champagne Logistics")
    db.add(partner)
    await db.commit()

    resp = await _upload_entity(client, headers, "partner", partner.id, "survey_template",
                                b"fake xlsx bytes", "template.xlsx")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "kind_not_allowed"


async def test_survey_template_rejected_on_a_site(client, db, seeded_user):
    from serversherpa.db.models import Site
    headers, _ = await _login(client)
    site = Site(name="DC-A")
    db.add(site)
    await db.commit()

    resp = await _upload_entity(client, headers, "site", site.id, "survey_template",
                                b"fake xlsx bytes", "template.xlsx")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "kind_not_allowed"


async def test_survey_template_uploads_on_a_definition_with_reports_change(client, db, seeded_user):
    """survey_template lives on the report definition itself, gated on the
    `reports` resource — admin holds reports:change."""
    definition = ReportDefinition(name="Site & Move Survey", report_type="site_move_survey",
                                  options={}, is_system=True)
    db.add(definition)
    await db.commit()

    admin = await _make(db, client, "admin", "admin-template@test.example.com")
    resp = await _upload_entity(client, admin, "report_definition", definition.id,
                                "survey_template", b"fake xlsx bytes", "template.xlsx")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "survey_template"
    assert body["content_type"] == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert body["storage_key"].endswith(".xlsx")


async def test_survey_template_requires_the_xlsx_extension(client, db, seeded_user):
    definition = ReportDefinition(name="Site & Move Survey", report_type="site_move_survey",
                                  options={}, is_system=True)
    db.add(definition)
    await db.commit()
    admin = await _make(db, client, "admin", "admin-template-ext@test.example.com")

    resp = await _upload_entity(client, admin, "report_definition", definition.id,
                                "survey_template", b"not really a workbook", "template.pdf")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_file_type"


async def test_report_asset_uploads_on_a_definition_with_reports_change(client, db, seeded_user):
    """report_asset (the Transportation Standards docx) lives on the report
    definition itself, gated on the `reports` resource — admin holds
    reports:change; staff (view + add only) does not."""
    definition = ReportDefinition(name="Site & Move Survey", report_type="site_move_survey",
                                  options={}, is_system=True)
    db.add(definition)
    await db.commit()

    admin = await _make(db, client, "admin", "admin@test.example.com")
    resp = await _upload_entity(client, admin, "report_definition", definition.id,
                                "report_asset", b"fake docx bytes", "standards.docx")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "report_asset"
    assert body["content_type"] == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    staff = await _login(client)
    resp = await _upload_entity(client, staff[0], "report_definition", definition.id,
                                "report_asset", b"fake docx bytes", "standards2.docx")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_report_asset_rejected_on_a_partner(client, db, seeded_user):
    definition_owner = await _make(db, client, "admin", "admin2@test.example.com")
    partner = Partner(name="Champagne Logistics")
    db.add(partner)
    await db.commit()

    resp = await _upload_entity(client, definition_owner, "partner", partner.id,
                                "report_asset", b"fake docx bytes", "standards.docx")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "kind_not_allowed"


async def test_report_asset_accepts_pdf_but_not_other_extensions(client, db, seeded_user):
    definition = ReportDefinition(name="Site & Move Survey", report_type="site_move_survey",
                                  options={}, is_system=True)
    db.add(definition)
    await db.commit()
    admin = await _make(db, client, "admin", "admin3@test.example.com")

    resp = await _upload_entity(client, admin, "report_definition", definition.id,
                                "report_asset", b"%PDF-1.4 fake", "standards.pdf")
    assert resp.status_code == 201, resp.text
    assert resp.json()["content_type"] == "application/pdf"

    resp = await _upload_entity(client, admin, "report_definition", definition.id,
                                "report_asset", b"not a docx or pdf", "standards.txt")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_file_type"


async def test_report_definition_attachments_view_requires_reports_view(client, db, seeded_user):
    """A worker holds no `reports` grant at all — listing report_asset
    attachments on a definition must 403, not fall through to the generic
    `attachments` gate (which a plain worker also lacks)."""
    definition = ReportDefinition(name="Site & Move Survey", report_type="site_move_survey",
                                  options={}, is_system=True)
    db.add(definition)
    await db.commit()

    worker = await _make(db, client, "worker", "worker@test.example.com")
    resp = await client.get(
        "/attachments", headers=worker,
        params={"entity_type": "report_definition", "entity_id": str(definition.id)},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    staff = await _login(client)                          # reports:view — allowed
    resp = await client.get(
        "/attachments", headers=staff[0],
        params={"entity_type": "report_definition", "entity_id": str(definition.id)},
    )
    assert resp.status_code == 200
    assert resp.json() == []


# ── self-service bypass is avatars-only (security-fixes task 2) ─────

async def test_worker_document_upload_and_list_denied_on_own_person(client, seeded_user, db):
    """The self-service bypass in `_authorize` is for AVATARS only. A
    worker uploading `kind=document` on their own person record, or
    listing without an explicit `kind=avatar` filter, must fall through
    to the normal `attachments` permission check (which a plain worker
    lacks) — entity_id == actor.person.id is never on its own enough."""
    wes = Person(first_name="Wes", last_name="Worker", email="wes@test.example.com")
    db.add(wes)
    await db.flush()
    db.add(UserAccount(
        person_id=wes.id, email="wes@test.example.com",
        password_hash=hash_password(
            LOGIN["password"], pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=wes.id, role="worker"))
    await db.commit()

    staff_headers, _ = await _login(client)
    wes_headers, wes_id = await _login(client, email="wes@test.example.com")

    # a staff member attaches a document to Wes's own person record
    doc = await _upload_entity(client, staff_headers, "person", wes_id,
                               "document", b"%PDF-1.4 fake", "resume.pdf")
    assert doc.status_code == 201, doc.text

    # Wes uploading a document on himself: denied — not his avatar
    resp = await _upload_entity(client, wes_headers, "person", wes_id,
                                "document", b"%PDF-1.4 fake", "another.pdf")
    assert resp.status_code == 403

    # Wes listing WITHOUT a kind filter: falls through to the normal
    # attachments gate, which he doesn't hold — denied, not a leaked list
    resp = await client.get(
        "/attachments", headers=wes_headers,
        params={"entity_type": "person", "entity_id": wes_id})
    assert resp.status_code == 403

    # ...but his OWN avatar kind is still self-service
    assert (await _upload(client, wes_headers, wes_id)).status_code == 201
    resp = await client.get(
        "/attachments", headers=wes_headers,
        params={"entity_type": "person", "entity_id": wes_id, "kind": "avatar"})
    assert resp.status_code == 200
