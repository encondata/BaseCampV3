"""HTTP tests for the wiki's internal (collab server) API — Task 5: the
service-token gate, `collab/authorize`, and page state load/store
(drafts, `has_unpublished_changes`, autosave versions)."""
import base64
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy import update as sa_update

from serversherpa.api.routes.wiki import internal as internal_routes
from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuthSession,
    Person,
    UserAccount,
    WikiNode,
    WikiPage,
    WikiPageVersion,
)
from serversherpa.wiki import pages
from serversherpa.wiki.content import MAX_DOC_BYTES
from tests.wiki_helpers import _create, _doc, _setup, _space, login_as, publish_via_db

TOKEN = "collab-service-token-for-tests"
ENV = "SS_WIKI_SERVICE_TOKEN"


def _set_token(value):
    if value is None:
        os.environ.pop(ENV, None)
    else:
        os.environ[ENV] = value
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def service_token():
    """Configure the service token for every test here, and put the
    environment (and the cached settings) back afterwards."""
    before = os.environ.get(ENV)
    _set_token(TOKEN)
    yield TOKEN
    _set_token(before)


SVC = {"X-Wiki-Service-Token": TOKEN}


async def _put_state(client, node_id, content, *, editors=(), ydoc=b"\x01\x02\x03",
                     expect=204):
    resp = await client.put(f"/wiki/internal/pages/{node_id}/state", headers=SVC, json={
        "ydoc_b64": base64.b64encode(ydoc).decode(), "content_json": content,
        "editor_ids": [str(e) for e in editors]})
    assert resp.status_code == expect, resp.text
    return resp


async def _page_row(db, node_id) -> WikiPage:
    db.expire_all()
    return await db.get(WikiPage, uuid.UUID(str(node_id)))


async def _versions(db, node_id):
    return (await db.scalars(
        select(WikiPageVersion).where(WikiPageVersion.node_id == uuid.UUID(str(node_id)))
        .order_by(WikiPageVersion.version_no))).all()


# ── service token ───────────────────────────────────────────────────


async def test_service_token_is_required_and_compared(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    url = f"/wiki/internal/pages/{page['id']}/state"

    resp = await client.get(url)
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "bad_service_token"
    resp = await client.get(url, headers={"X-Wiki-Service-Token": "nope"})
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "bad_service_token"
    # a user's bearer is no substitute for the service token
    resp = await client.get(f"/wiki/internal/collab/authorize?node={page['id']}",
                            headers=s["owner"])
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "bad_service_token"
    assert (await client.get(url, headers=SVC)).status_code == 200

    _set_token("")
    resp = await client.get(url, headers=SVC)
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "internal_disabled"


# ── authorize ───────────────────────────────────────────────────────


async def _authorize(client, user_headers, node_id, expect=200):
    resp = await client.get("/wiki/internal/collab/authorize",
                            params={"node": str(node_id)},
                            headers={**SVC, **(user_headers or {})})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def test_authorize_reports_level_person_and_color(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Live", kind="page")
    await publish_via_db(db, page["id"])

    body = await _authorize(client, s["editor"], page["id"])
    assert body["level"] == "edit"
    assert body["person"]["id"] == str(s["editor_id"])
    assert body["person"]["name"].startswith("Wiki Tester")
    assert body["color"] == pages.person_color(s["editor_id"])
    assert (await _authorize(client, s["owner"], page["id"]))["level"] == "manage"
    # live editing is for editors: the live document IS the draft
    body = await _authorize(client, s["viewer"], page["id"], expect=403)
    assert body["detail"]["code"] == "forbidden"


async def test_authorize_refuses_what_the_user_cant_see(client, db):
    s = await _setup(client, db)
    space = s["space"]
    page = await _create(client, s["owner"], space, "Draft only", kind="page")
    folder = await _create(client, s["owner"], space, "Folder")
    private = await _space(client, s["owner"], default_access="private", name="Private")
    hidden = await _create(client, s["owner"], private, "Hidden", kind="page")
    await publish_via_db(db, hidden["id"])

    # a view-only user can't open a never-published page; an editor can
    await _authorize(client, s["viewer"], page["id"], expect=404)
    assert (await _authorize(client, s["editor"], page["id"]))["level"] == "edit"
    # no level at all, not a page, unknown, trashed
    await _authorize(client, s["viewer"], hidden["id"], expect=404)
    await _authorize(client, s["owner"], folder["id"], expect=404)
    await _authorize(client, s["owner"], uuid.uuid4(), expect=404)
    assert (await client.delete(f"/wiki/nodes/{page['id']}",
                                headers=s["owner"])).status_code == 200
    await _authorize(client, s["editor"], page["id"], expect=404)


async def test_authorize_needs_a_valid_user_bearer(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    body = await _authorize(client, None, page["id"], expect=401)
    assert body["detail"]["code"] == "unauthenticated"
    body = await _authorize(client, {"Authorization": "Bearer not-a-jwt"},
                            page["id"], expect=401)
    assert body["detail"]["code"] == "unauthenticated"


async def test_authorize_needs_wiki_view(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    await publish_via_db(db, page["id"])
    # a client-portal user without wiki:view can't see the page, even
    # though the space grants everyone view
    resp = await client.put(
        f"/wiki/spaces/{s['space']['key']}/grants", headers=s["owner"], json={"grants": [
            {"principal_type": "person", "principal_id": str(s["owner_id"]),
             "level": "manage"},
            {"principal_type": "everyone", "level": "view"}]})
    assert resp.status_code == 200, resp.text
    await _authorize(client, s["viewer"], page["id"], expect=403)
    outsider_h, _ = await login_as(client, db, roles=())
    await _authorize(client, outsider_h, page["id"], expect=404)


# ── level (re-authorization by person) ──────────────────────────────


async def _level(client, node_id, person_id, expect=200, headers=SVC):
    resp = await client.get("/wiki/internal/collab/level",
                            params={"node": str(node_id), "person": str(person_id)},
                            headers=headers)
    assert resp.status_code == expect, resp.text
    if expect == 404:
        # the route's own 404, not a missing route
        assert resp.json()["detail"]["code"] == "not_found"
    return resp.json()


async def test_level_reports_each_persons_level(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Live", kind="page")
    await publish_via_db(db, page["id"])

    assert await _level(client, page["id"], s["owner_id"]) == {"level": "manage"}
    assert await _level(client, page["id"], s["editor_id"]) == {"level": "edit"}
    body = await _level(client, page["id"], s["viewer_id"], expect=403)
    assert body["detail"]["code"] == "forbidden"


async def test_viewers_never_open_the_live_draft(client, db, monkeypatch):
    """A view-only reader gets the published version over REST and is
    refused the draft (403); the live document is that draft, so a
    live connection is refused the same way — also during a freeze, when
    editors still connect, read-only."""
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    resp = await client.get(f"/wiki/pages/{page['id']}/content",
                            headers=s["viewer"], params={"version": "draft"})
    assert resp.status_code == 403
    await _authorize(client, s["viewer"], page["id"], expect=403)
    await _level(client, page["id"], s["viewer_id"], expect=403)

    async def _read_only(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}
    monkeypatch.setattr("serversherpa.system.admin_config.read_admin_config", _read_only)
    await _authorize(client, s["viewer"], page["id"], expect=403)
    await _level(client, page["id"], s["viewer_id"], expect=403)
    assert (await _authorize(client, s["editor"], page["id"]))["level"] == "view"


async def test_level_follows_authorize_for_what_a_person_cant_see(client, db):
    s = await _setup(client, db)
    space = s["space"]
    draft = await _create(client, s["owner"], space, "Draft only", kind="page")
    folder = await _create(client, s["owner"], space, "Folder")
    private = await _space(client, s["owner"], default_access="private", name="Private")
    hidden = await _create(client, s["owner"], private, "Hidden", kind="page")
    await publish_via_db(db, hidden["id"])

    # view-only on a never-published page, no level, not a page, unknown
    await _level(client, draft["id"], s["viewer_id"], expect=404)
    assert (await _level(client, draft["id"], s["editor_id"]))["level"] == "edit"
    await _level(client, hidden["id"], s["viewer_id"], expect=404)
    await _level(client, folder["id"], s["owner_id"], expect=404)
    await _level(client, uuid.uuid4(), s["owner_id"], expect=404)
    # trashed
    assert (await client.delete(f"/wiki/nodes/{draft['id']}",
                                headers=s["owner"])).status_code == 200
    await _level(client, draft["id"], s["editor_id"], expect=404)


async def test_level_refuses_a_person_without_an_active_account(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Live", kind="page")
    await publish_via_db(db, page["id"])

    # a person record with no user account at all
    nobody = Person(first_name="No", last_name="Account")
    db.add(nobody)
    await db.commit()
    await _level(client, page["id"], nobody.id, expect=404)
    await _level(client, page["id"], uuid.uuid4(), expect=404)

    # a disabled account loses its level straight away
    await db.execute(sa_update(UserAccount)
                     .where(UserAccount.person_id == s["editor_id"])
                     .values(disabled_at=datetime.now(UTC)))
    await db.commit()
    await _level(client, page["id"], s["editor_id"], expect=404)

    # so does an archived person
    await db.execute(sa_update(Person)
                     .where(Person.id == s["viewer_id"])
                     .values(archived_at=datetime.now(UTC)))
    await db.commit()
    await _level(client, page["id"], s["viewer_id"], expect=404)
    assert (await _level(client, page["id"], s["owner_id"]))["level"] == "manage"


async def test_level_refuses_a_person_without_a_live_session(client, db):
    """"Revoke all sessions" or a password reset cuts live editing off at
    the collab server's next re-check, like it does every other request."""
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Live", kind="page")
    await publish_via_db(db, page["id"])
    assert (await _level(client, page["id"], s["editor_id"]))["level"] == "edit"

    # every session revoked
    await db.execute(sa_update(AuthSession)
                     .where(AuthSession.person_id == s["editor_id"])
                     .values(revoked_at=datetime.now(UTC), revoke_reason="admin"))
    await db.commit()
    await _level(client, page["id"], s["editor_id"], expect=404)

    # every session expired
    await db.execute(sa_update(AuthSession)
                     .where(AuthSession.person_id == s["viewer_id"])
                     .values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
    await db.commit()
    await _level(client, page["id"], s["viewer_id"], expect=404)

    # one live session is enough
    assert (await _level(client, page["id"], s["owner_id"]))["level"] == "manage"


async def test_level_needs_wiki_view(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    await publish_via_db(db, page["id"])
    resp = await client.put(
        f"/wiki/spaces/{s['space']['key']}/grants", headers=s["owner"], json={"grants": [
            {"principal_type": "person", "principal_id": str(s["owner_id"]),
             "level": "manage"},
            {"principal_type": "everyone", "level": "view"}]})
    assert resp.status_code == 200, resp.text
    _, outsider_id = await login_as(client, db, roles=())
    await _level(client, page["id"], outsider_id, expect=404)


async def test_level_needs_the_service_token(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    await publish_via_db(db, page["id"])

    body = await _level(client, page["id"], s["owner_id"], expect=401, headers={})
    assert body["detail"]["code"] == "bad_service_token"
    body = await _level(client, page["id"], s["owner_id"], expect=401,
                        headers={"X-Wiki-Service-Token": "nope"})
    assert body["detail"]["code"] == "bad_service_token"
    # a user's bearer is no substitute
    body = await _level(client, page["id"], s["owner_id"], expect=401, headers=s["owner"])
    assert body["detail"]["code"] == "bad_service_token"

    _set_token("")
    body = await _level(client, page["id"], s["owner_id"], expect=503)
    assert body["detail"]["code"] == "internal_disabled"


# ── state: load ─────────────────────────────────────────────────────


async def test_get_state_for_new_imported_and_stored_pages(client, db):
    s = await _setup(client, db)
    space = s["space"]
    fresh = await _create(client, s["owner"], space, "Fresh", kind="page")
    resp = await client.get(f"/wiki/internal/pages/{fresh['id']}/state", headers=SVC)
    assert resp.status_code == 200
    assert resp.json() == {"ydoc_b64": None, "draft_json": None, "title": "Fresh"}

    imported = _doc("from a file")
    page = await _create(client, s["owner"], space, "Imported", kind="page",
                         initial_content=imported)
    resp = await client.get(f"/wiki/internal/pages/{page['id']}/state", headers=SVC)
    assert resp.json() == {"ydoc_b64": None, "draft_json": imported, "title": "Imported"}

    await _put_state(client, fresh["id"], _doc("stored"), ydoc=b"\x00\xffyjs")
    resp = await client.get(f"/wiki/internal/pages/{fresh['id']}/state", headers=SVC)
    body = resp.json()
    assert base64.b64decode(body["ydoc_b64"]) == b"\x00\xffyjs"
    assert body["draft_json"] == _doc("stored")

    folder = await _create(client, s["owner"], space, "Folder")
    for node_id in (folder["id"], uuid.uuid4()):
        resp = await client.get(f"/wiki/internal/pages/{node_id}/state", headers=SVC)
        assert resp.status_code == 404


# ── state: store ────────────────────────────────────────────────────


async def test_put_state_stores_the_draft_and_autosaves_every_ten_minutes(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Notes", kind="page")
    node_id = uuid.UUID(page["id"])

    await _put_state(client, node_id, _doc("one"), editors=[s["owner_id"], s["editor_id"]],
                     ydoc=b"ydoc-1")
    row = await _page_row(db, node_id)
    assert row.ydoc == b"ydoc-1"
    assert row.draft_json == _doc("one")
    assert row.draft_text == "one"
    assert row.draft_updated_by == s["editor_id"]
    assert row.draft_updated_at is not None
    assert row.has_unpublished_changes is True
    node = await db.get(WikiNode, node_id)
    assert node.updated_by == s["editor_id"]
    versions = await _versions(db, node_id)
    assert [(v.version_no, v.kind, v.content_json, v.created_by) for v in versions] == [
        (1, "autosave", _doc("one"), s["editor_id"])]
    first_autosave = row.last_autosave_version_at
    assert first_autosave is not None

    # changed again within ten minutes: stored, but no new version
    await _put_state(client, node_id, _doc("two"), editors=[s["owner_id"]])
    row = await _page_row(db, node_id)
    assert row.draft_json == _doc("two")
    assert row.draft_updated_by == s["owner_id"]
    assert len(await _versions(db, node_id)) == 1

    # ten minutes later: unchanged content still takes no version...
    row.last_autosave_version_at = first_autosave - timedelta(minutes=11)
    await db.commit()
    await _put_state(client, node_id, _doc("two"), editors=[s["editor_id"]])
    assert len(await _versions(db, node_id)) == 1
    # ...changed content does
    await _put_state(client, node_id, _doc("three"), editors=[s["editor_id"]])
    versions = await _versions(db, node_id)
    assert [(v.version_no, v.kind, v.content_text) for v in versions] == [
        (1, "autosave", "one"), (2, "autosave", "three")]
    row = await _page_row(db, node_id)
    assert row.last_autosave_version_at > first_autosave


async def test_put_state_tracks_unpublished_changes_against_the_published_version(
        client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Tracked", kind="page")
    node_id = uuid.UUID(page["id"])
    await publish_via_db(db, node_id, _doc("live"))

    await _put_state(client, node_id, _doc("edited"), editors=[s["editor_id"]])
    assert (await _page_row(db, node_id)).has_unpublished_changes is True
    # key order doesn't matter
    await _put_state(client, node_id, {"content": _doc("live")["content"], "type": "doc"})
    row = await _page_row(db, node_id)
    assert row.has_unpublished_changes is False
    # no editors: who last edited the draft is kept
    assert row.draft_updated_by == s["editor_id"]


async def test_put_state_ignores_unknown_editor_ids(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    await _put_state(client, page["id"], _doc("x"), editors=[s["editor_id"], uuid.uuid4()])
    assert (await _page_row(db, page["id"])).draft_updated_by == s["editor_id"]


async def test_put_state_rejects_bad_and_oversized_documents(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    big = _doc("x" * (MAX_DOC_BYTES + 1))
    resp = await _put_state(client, page["id"], big, expect=413)
    assert resp.json()["detail"]["code"] == "too_large"
    for bad in ([1, 2], {"type": "paragraph"}, "doc"):
        resp = await _put_state(client, page["id"], bad, expect=422)
        assert resp.json()["detail"]["code"] == "bad_doc"
    resp = await client.put(f"/wiki/internal/pages/{page['id']}/state", headers=SVC, json={
        "ydoc_b64": "not base64!", "content_json": _doc("x"), "editor_ids": []})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_ydoc"
    row = await _page_row(db, page["id"])
    assert row.draft_json is None and row.ydoc is None


async def test_put_state_rejects_an_oversized_ydoc(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    huge_ydoc = b"\x00" * (4 * MAX_DOC_BYTES + 1)
    resp = await _put_state(client, page["id"], _doc("x"), ydoc=huge_ydoc, expect=413)
    assert resp.json()["detail"]["code"] == "too_large"
    row = await _page_row(db, page["id"])
    assert row.draft_json is None and row.ydoc is None


async def test_put_state_too_large_message_follows_the_cap(client, db, monkeypatch):
    monkeypatch.setattr(internal_routes, "MAX_YDOC_BYTES", 3 * 1024 * 1024)
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    resp = await _put_state(client, page["id"], _doc("x"),
                            ydoc=b"\x00" * (3 * 1024 * 1024 + 1), expect=413)
    assert resp.json()["detail"]["message"] == "The document is larger than 3 MB."


async def test_put_state_to_a_trashed_page_is_refused(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Gone", kind="page")
    assert (await client.delete(f"/wiki/nodes/{page['id']}",
                                headers=s["owner"])).status_code == 200
    resp = await _put_state(client, page["id"], _doc("late"), expect=409)
    assert resp.json()["detail"]["code"] == "deleted"
    assert (await _page_row(db, page["id"])).draft_json is None
    resp = await _put_state(client, uuid.uuid4(), _doc("x"), expect=404)


async def test_put_state_is_refused_in_read_only_mode(client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")

    async def _read_only(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}

    monkeypatch.setattr("serversherpa.system.admin_config.read_admin_config", _read_only)
    resp = await _put_state(client, page["id"], _doc("x"), expect=423)
    assert resp.json()["detail"]["code"] == "read_only_mode"
    # reads still work
    resp = await client.get(f"/wiki/internal/pages/{page['id']}/state", headers=SVC)
    assert resp.status_code == 200


# ── link titles never stored ────────────────────────────────────────

LINKING = {"type": "doc", "content": [
    {"type": "paragraph", "content": [
        {"type": "text", "text": "See "},
        {"type": "pageLink", "attrs": {"nodeId": str(uuid.uuid4()),
                                       "title": "Quartermaster reduction plan"}}]},
    {"type": "fileEmbed", "attrs": {"nodeId": str(uuid.uuid4()), "assetId": None,
                                    "filename": "quartermaster.xlsx", "contentType": ""}},
]}


async def test_stored_and_published_content_never_names_a_links_target(client, db):
    """A restricted page's title must not reach readers of a page that
    links to it: not in the stored draft, the published version, the
    content API, or the search index."""
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Linking page", kind="page")
    await _put_state(client, page["id"], LINKING, editors=[s["editor_id"]])
    row = await _page_row(db, page["id"])
    for text in (str(row.draft_json), row.draft_text):
        assert "Quartermaster" not in text and "quartermaster" not in text

    resp = await client.post(f"/wiki/pages/{page['id']}/publish", headers=s["editor"],
                             json={})
    assert resp.status_code == 201, resp.text
    resp = await client.get(f"/wiki/pages/{page['id']}/content", headers=s["viewer"])
    assert resp.status_code == 200
    assert "uartermaster" not in resp.text
    resp = await client.get("/wiki/search", headers=s["viewer"],
                            params={"q": "quartermaster"})
    assert resp.status_code == 200
    assert resp.json() == []


async def test_read_only_mode_opens_live_editing_read_only(client, db, monkeypatch):
    """Stores are refused during a freeze, so an editor must not type into
    a document that can't be saved: authorize and the re-check both say
    view (developers, whom the freeze exempts, keep their level)."""
    s = await _setup(client, db)
    dev_h, dev_id = await login_as(client, db, roles=("staff", "developer"))
    await _put_grants_for(client, s, dev_id)
    page = await _create(client, s["owner"], s["space"], "Frozen", kind="page")

    async def _read_only(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}
    monkeypatch.setattr("serversherpa.system.admin_config.read_admin_config", _read_only)

    # a never-published page stays open (read-only) to its editors
    assert (await _authorize(client, s["editor"], page["id"]))["level"] == "view"
    assert (await _authorize(client, s["owner"], page["id"]))["level"] == "view"
    assert await _level(client, page["id"], s["editor_id"]) == {"level": "view"}
    # (a developer is a wiki admin too, hence manage)
    assert (await _authorize(client, dev_h, page["id"]))["level"] == "manage"
    assert await _level(client, page["id"], dev_id) == {"level": "manage"}


async def _put_grants_for(client, s, person_id):
    resp = await client.put(f"/wiki/spaces/{s['space']['key']}/grants", headers=s["owner"],
                            json={"grants": [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
        {"principal_type": "person", "principal_id": str(person_id), "level": "edit"},
        {"principal_type": "internal", "level": "view"}]})
    assert resp.status_code == 200, resp.text
