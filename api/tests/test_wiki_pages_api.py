"""HTTP tests for the wiki page routes — Task 5: content (published,
draft, a version), publish, the version list/detail, and recording a
restore — plus `pages.person_color` and the search refresh on publish."""
import uuid

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, WikiNode, WikiPage, WikiPageVersion
from serversherpa.wiki import pages
from serversherpa.wiki.content import EMPTY_DOC
from tests.test_wiki_nodes_api import _create, _setup


def _doc(*texts):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": t}]} for t in texts]}


async def _set_draft(db, node_id, content):
    """Stand in for the collab server's store."""
    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(str(node_id)))
    row.draft_json = content
    row.has_unpublished_changes = True
    await db.commit()


async def _publish(client, headers, node_id, note=None, expect=201):
    resp = await client.post(f"/wiki/pages/{node_id}/publish", headers=headers,
                             json={"note": note} if note is not None else {})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _content(client, headers, node_id, version=None, expect=200):
    params = {"version": version} if version else {}
    resp = await client.get(f"/wiki/pages/{node_id}/content", headers=headers,
                            params=params)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _audits(db, node_id, action):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == str(node_id),
        AuditLog.action == action))).all()


# ── publish ─────────────────────────────────────────────────────────


async def test_publish_snapshots_the_draft_once(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await _set_draft(db, page["id"], _doc("step one"))

    body = await _publish(client, s["editor"], page["id"], note="  First cut  ")
    assert body["version_no"] == 1
    assert body["kind"] == "published"
    assert body["title"] == "Runbook"
    assert body["note"] == "First cut"
    assert body["created_by"]["id"] == str(s["editor_id"])

    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert str(row.published_version_id) == body["id"]
    assert row.has_unpublished_changes is False
    node = (await client.get(f"/wiki/nodes/{page['id']}", headers=s["viewer"])).json()
    assert node["page"]["published_version_id"] == body["id"]
    assert node["page"]["has_unpublished_changes"] is False
    assert node["updated_by"]["id"] == str(s["editor_id"])

    # nothing new since: 409
    resp = await client.post(f"/wiki/pages/{page['id']}/publish", headers=s["editor"],
                             json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "nothing_to_publish"

    # a changed draft publishes as version 2
    await _set_draft(db, page["id"], _doc("step one", "step two"))
    body = await _publish(client, s["editor"], page["id"])
    assert body["version_no"] == 2 and body["note"] is None

    rows = await _audits(db, page["id"], "publish")
    assert [r.changes["version_no"] for r in rows] == [1, 2]
    assert rows[0].actor_person_id == s["editor_id"]
    assert rows[0].changes["note"] == "First cut"


async def test_publish_without_a_draft_publishes_an_empty_page(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Blank", kind="page")
    body = await _publish(client, s["owner"], page["id"])
    version = await db.get(WikiPageVersion, uuid.UUID(body["id"]))
    assert version.content_json == EMPTY_DOC
    # and a published page with no draft has nothing more to publish
    await _publish(client, s["owner"], page["id"], expect=409)


async def test_publish_needs_edit(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    await _set_draft(db, page["id"], _doc("a"))
    await _publish(client, s["owner"], page["id"])
    await _set_draft(db, page["id"], _doc("b"))
    resp = await client.post(f"/wiki/pages/{page['id']}/publish", headers=s["viewer"],
                             json={})
    assert resp.status_code == 403
    folder = await _create(client, s["owner"], s["space"], "F")
    resp = await client.post(f"/wiki/pages/{folder['id']}/publish", headers=s["owner"],
                             json={})
    assert resp.status_code == 404


async def test_publish_refreshes_the_search_index(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Router reboot", kind="page")
    await _set_draft(db, page["id"], _doc("power cycle the switch"))
    await _publish(client, s["owner"], page["id"])
    db.expire_all()
    for term in ("router", "switch"):
        hit = await db.scalar(select(WikiNode.id).where(
            WikiNode.id == uuid.UUID(page["id"]),
            WikiNode.search_tsv.op("@@")(func.plainto_tsquery("english", term))))
        assert hit is not None, term


# ── content ─────────────────────────────────────────────────────────


async def test_viewers_see_published_content_and_editors_the_draft(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Guide", kind="page")
    await _set_draft(db, page["id"], _doc("published words"))
    published = await _publish(client, s["owner"], page["id"])
    await _set_draft(db, page["id"], _doc("draft words"))

    body = await _content(client, s["viewer"], page["id"])
    assert body["content_json"] == _doc("published words")
    assert body["version_id"] == published["id"]
    assert body["version_no"] == 1 and body["kind"] == "published"
    assert body["created_by"]["id"] == str(s["owner_id"])
    assert (await _content(client, s["viewer"], page["id"], "published")) == body

    resp = await client.get(f"/wiki/pages/{page['id']}/content", headers=s["viewer"],
                            params={"version": "draft"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    draft = await _content(client, s["editor"], page["id"], "draft")
    assert draft["kind"] == "draft"
    assert draft["version_id"] is None and draft["version_no"] is None
    assert draft["title"] == "Guide"
    assert draft["content_json"] == _doc("draft words")

    await _content(client, s["editor"], page["id"], "junk", expect=422)


async def test_draft_content_falls_back_to_published_then_empty(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "P", kind="page")
    assert (await _content(client, s["editor"], page["id"], "draft"))[
        "content_json"] == EMPTY_DOC
    # the space home page is published but never drafted
    home_id = s["space"]["home_node_id"]
    assert (await _content(client, s["editor"], home_id, "draft"))[
        "content_json"] == EMPTY_DOC


async def test_never_published_page_is_not_found_for_viewers(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Secret", kind="page")
    await _set_draft(db, page["id"], _doc("wip"))
    for version in (None, "draft"):
        body = await _content(client, s["viewer"], page["id"], version, expect=404)
        assert body["detail"]["code"] == "not_published"
    resp = await client.get(f"/wiki/pages/{page['id']}/versions", headers=s["viewer"])
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_published"
    # editors reading "published" get the same answer; the draft is theirs
    body = await _content(client, s["editor"], page["id"], expect=404)
    assert body["detail"]["code"] == "not_published"
    assert (await _content(client, s["editor"], page["id"], "draft"))[
        "content_json"] == _doc("wip")


# ── versions ────────────────────────────────────────────────────────


async def _history(client, db, s):
    """A page with v1 autosave, v2 published, v3 autosave."""
    page = await _create(client, s["owner"], s["space"], "History", kind="page")
    node = await db.get(WikiNode, uuid.UUID(page["id"]))
    v1 = await pages.add_version(db, node, kind="autosave", title="History",
                                 content_json=_doc("v1"), actor_id=s["editor_id"])
    v1_id = str(v1.id)
    await db.commit()
    await _set_draft(db, page["id"], _doc("v2"))
    v2 = await _publish(client, s["owner"], page["id"], note="Go live")
    node = await db.get(WikiNode, uuid.UUID(page["id"]))
    v3 = await pages.add_version(db, node, kind="autosave", title="History",
                                 content_json=_doc("v3"), actor_id=s["editor_id"])
    await db.commit()
    return page, v1_id, v2["id"], str(v3.id)


async def test_versions_list_is_published_only_for_viewers(client, db):
    s = await _setup(client, db)
    page, v1, v2, v3 = await _history(client, db, s)

    resp = await client.get(f"/wiki/pages/{page['id']}/versions", headers=s["editor"])
    assert resp.status_code == 200
    assert [(v["id"], v["version_no"], v["kind"]) for v in resp.json()] == [
        (v3, 3, "autosave"), (v2, 2, "published"), (v1, 1, "autosave")]
    assert resp.json()[1]["note"] == "Go live"

    resp = await client.get(f"/wiki/pages/{page['id']}/versions", headers=s["viewer"])
    assert [v["id"] for v in resp.json()] == [v2]


async def test_version_detail_and_content_by_version(client, db):
    s = await _setup(client, db)
    page, v1, v2, _ = await _history(client, db, s)

    resp = await client.get(f"/wiki/pages/{page['id']}/versions/{v1}", headers=s["editor"])
    assert resp.status_code == 200
    body = resp.json()
    assert body["content_json"] == _doc("v1") and body["kind"] == "autosave"
    assert body["created_by"]["id"] == str(s["editor_id"])

    resp = await client.get(f"/wiki/pages/{page['id']}/versions/{v1}", headers=s["viewer"])
    assert resp.status_code == 403
    resp = await client.get(f"/wiki/pages/{page['id']}/versions/{v2}", headers=s["viewer"])
    assert resp.status_code == 200 and resp.json()["content_json"] == _doc("v2")

    assert (await _content(client, s["editor"], page["id"], v1))["content_json"] == \
        _doc("v1")
    await _content(client, s["viewer"], page["id"], v1, expect=403)
    assert (await _content(client, s["viewer"], page["id"], v2))["version_no"] == 2

    # a version of another page, or none at all
    other = await _create(client, s["owner"], s["space"], "Other", kind="page")
    for vid in (v1, str(uuid.uuid4())):
        resp = await client.get(f"/wiki/pages/{other['id']}/versions/{vid}",
                                headers=s["owner"])
        assert resp.status_code == 404


async def test_restore_records_a_restored_version(client, db):
    s = await _setup(client, db)
    page, v1, _, _ = await _history(client, db, s)

    resp = await client.post(f"/wiki/pages/{page['id']}/versions/restored",
                             headers=s["editor"], json={"from_version_id": v1})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["version_no"] == 4
    assert body["kind"] == "restored"
    assert body["note"] == "Restored from version 1"
    assert body["created_by"]["id"] == str(s["editor_id"])
    version = await db.get(WikiPageVersion, uuid.UUID(body["id"]))
    assert version.content_json == _doc("v1")

    rows = await _audits(db, page["id"], "restore")
    assert len(rows) == 1
    assert rows[0].actor_person_id == s["editor_id"]
    assert rows[0].changes["from_version_no"] == 1
    assert rows[0].changes["version_id"] == body["id"]

    resp = await client.post(f"/wiki/pages/{page['id']}/versions/restored",
                             headers=s["viewer"], json={"from_version_id": v1})
    assert resp.status_code == 403
    resp = await client.post(f"/wiki/pages/{page['id']}/versions/restored",
                             headers=s["editor"],
                             json={"from_version_id": str(uuid.uuid4())})
    assert resp.status_code == 404


# ── import + helpers ────────────────────────────────────────────────


async def test_imported_page_records_an_imported_version_and_can_publish(client, db):
    s = await _setup(client, db)
    imported = _doc("from docx")
    page = await _create(client, s["editor"], s["space"], "Imported", kind="page",
                         initial_content=imported)
    resp = await client.get(f"/wiki/pages/{page['id']}/versions", headers=s["editor"])
    assert [(v["version_no"], v["kind"]) for v in resp.json()] == [(1, "imported")]
    drafts = (await client.get("/wiki/drafts", headers=s["editor"])).json()
    assert page["id"] in [d["id"] for d in drafts]
    body = await _publish(client, s["editor"], page["id"])
    assert body["version_no"] == 2
    assert (await _content(client, s["viewer"], page["id"]))["content_json"] == imported


async def test_create_rejects_oversized_or_non_document_initial_content(client, db):
    s = await _setup(client, db)
    await _create(client, s["owner"], s["space"], "Bad", kind="page",
                  initial_content={"type": "paragraph"}, expect=422)
    big = _doc("x" * (5 * 1024 * 1024))
    await _create(client, s["owner"], s["space"], "Big", kind="page",
                  initial_content=big, expect=413)


def test_person_color_is_stable_and_from_the_palette():
    pid = uuid.UUID("00000000-0000-0000-0000-00000000000d")
    assert pages.person_color(pid) == pages.PERSON_COLORS[13 % 12]
    assert pages.person_color(pid) == pages.person_color(uuid.UUID(str(pid)))
    assert len(set(pages.PERSON_COLORS)) == 12
    seen = {pages.person_color(uuid.uuid4()) for _ in range(500)}
    assert seen <= set(pages.PERSON_COLORS)
