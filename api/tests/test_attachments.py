"""Attachment flow: avatar upload/replace/delete against real MinIO."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
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

    # unaffected: self-service still works for her own avatar
    assert (await _upload(client, headers, alice_id)).status_code == 201
    resp = await client.get(
        "/attachments",
        headers=headers,
        params={"entity_type": "person", "entity_id": alice_id},
    )
    assert resp.status_code == 200
