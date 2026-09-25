"""Shared helpers for the wiki HTTP test suites: `login_as` — modeled on
`test_attachments.py::_login`/`_login_as`, but general enough to mint a
fresh person with any role set (and, for client_* roles, a client
anchor) rather than only retargeting the one seeded staff user — plus
the small space/node/publish fixtures every wiki test module needs, so
they live in one place instead of being cross-imported between test
modules (Task 4/5's `test_wiki_nodes_api.py` used to be that place —
`test_wiki_pages_api.py` and `test_wiki_internal_api.py` imported from
it directly)."""
import uuid

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount, WikiPage, WikiPageVersion
from serversherpa.security.passwords import hash_password

PASSWORD = "CorrectHorse9!"


async def login_as(client, db, *, roles=("staff",), email=None,
                   client_id=None) -> tuple[dict, uuid.UUID]:
    """Create a fresh person + user account holding `roles` (each
    anchored to `client_id` when given, for client_* roles), log in, and
    return (headers, person_id)."""
    tag = uuid.uuid4().hex[:10]
    email = email or f"wiki-{tag}@test.example.com"

    person = Person(first_name="Wiki", last_name=f"Tester {tag}", email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            PASSWORD, pepper=get_settings().password_pepper.get_secret_value())))
    for role in roles:
        db.add(PersonRole(person_id=person.id, role=role, client_id=client_id))
    await db.commit()

    resp = await client.post(
        "/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['access_token']}"}, person.id


def _doc(*texts):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": t}]} for t in texts]}


async def _space(client, headers, default_access="internal", name="Tree Space"):
    resp = await client.post("/wiki/spaces", headers=headers, json={
        "key": f"t4-{uuid.uuid4().hex[:10]}", "name": name,
        "default_access": default_access})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _put_grants(client, headers, space, grants):
    resp = await client.put(f"/wiki/spaces/{space['key']}/grants",
                            headers=headers, json={"grants": grants})
    assert resp.status_code == 200, resp.text


async def _create(client, headers, space, title, kind="folder", parent=None,
                  expect=201, **extra):
    resp = await client.post("/wiki/nodes", headers=headers, json={
        "space_id": space["id"], "parent_id": parent["id"] if parent else None,
        "kind": kind, "title": title, **extra})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _setup(client, db):
    """A space owned by `owner` (manage), with `editor` granted edit and
    every other staff user (`viewer`) getting view through `internal`."""
    owner_h, owner_id = await login_as(client, db, roles=("staff",))
    editor_h, editor_id = await login_as(client, db, roles=("staff",))
    viewer_h, viewer_id = await login_as(client, db, roles=("staff",))
    space = await _space(client, owner_h)
    await _put_grants(client, owner_h, space, [
        {"principal_type": "person", "principal_id": str(owner_id), "level": "manage"},
        {"principal_type": "person", "principal_id": str(editor_id), "level": "edit"},
        {"principal_type": "internal", "level": "view"},
    ])
    return {"space": space, "owner": owner_h, "owner_id": owner_id,
            "editor": editor_h, "editor_id": editor_id,
            "viewer": viewer_h, "viewer_id": viewer_id}


async def publish_via_db(db, node_id, content=None):
    """Give a page a published version directly, bypassing the publish
    route — for tests that need a published page but aren't testing
    publish itself."""
    node_id = uuid.UUID(str(node_id))
    version = WikiPageVersion(
        node_id=node_id, version_no=1, title="Published",
        content_json=content or {"type": "doc", "content": [{"type": "paragraph"}]},
        kind="published")
    db.add(version)
    await db.flush()
    page = await db.get(WikiPage, node_id)
    page.published_version_id = version.id
    await db.commit()
    return version


async def publish_via_api(client, headers, node_id, note=None, expect=201):
    """Publish through `POST /pages/{id}/publish` — for tests exercising
    the publish flow itself (audit rows, version numbering, the
    nothing-to-publish 409)."""
    resp = await client.post(f"/wiki/pages/{node_id}/publish", headers=headers,
                             json={"note": note} if note is not None else {})
    assert resp.status_code == expect, resp.text
    return resp.json()
