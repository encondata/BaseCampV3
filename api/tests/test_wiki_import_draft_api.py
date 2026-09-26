"""HTTP tests for `PUT /wiki/nodes/{id}/draft` — Task 14: an import seeds a
page's draft (and records an `imported` version) while the page has never
been opened live; once the collab server holds its Y.Doc, the route is
refused with 409 `already_live`."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Client, WikiPage, WikiPageVersion
from serversherpa.wiki import content as wiki_content
from tests.wiki_helpers import _create, _doc, _setup, login_as, publish_via_db


async def _put_draft(client, headers, node_id, content, expect=204):
    resp = await client.put(f"/wiki/nodes/{node_id}/draft", headers=headers,
                            json={"content_json": content})
    assert resp.status_code == expect, resp.text
    return resp


async def test_an_editor_seeds_a_new_pages_draft(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Imported guide", kind="page")
    doc = _doc("first paragraph", "second paragraph")

    await _put_draft(client, s["editor"], page["id"], doc)

    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert row.draft_json == doc
    assert row.draft_text == "first paragraph\nsecond paragraph"
    assert row.draft_updated_by == s["editor_id"]
    assert row.draft_updated_at is not None
    assert row.has_unpublished_changes is True
    assert row.ydoc is None  # the collab server seeds the Y.Doc from draft_json

    versions = (await db.scalars(select(WikiPageVersion).where(
        WikiPageVersion.node_id == uuid.UUID(page["id"])))).all()
    assert [(v.kind, v.version_no) for v in versions] == [("imported", 1)]
    assert versions[0].content_json == doc
    assert versions[0].title == "Imported guide"
    assert versions[0].created_by == s["editor_id"]

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == page["id"],
        AuditLog.action == "import"))).all()
    assert len(audits) == 1
    assert audits[0].actor_person_id == s["editor_id"]
    assert audits[0].changes["version_no"] == 1

    # the editor reads it back as the draft
    resp = await client.get(f"/wiki/pages/{page['id']}/content", headers=s["editor"],
                            params={"version": "draft"})
    assert resp.status_code == 200
    assert resp.json()["content_json"] == doc


async def test_seeding_again_before_it_goes_live_replaces_the_draft(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Twice", kind="page")
    await _put_draft(client, s["owner"], page["id"], _doc("one"))
    await _put_draft(client, s["owner"], page["id"], _doc("two"))
    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert row.draft_json == _doc("two")
    kinds = (await db.scalars(select(WikiPageVersion.version_no).where(
        WikiPageVersion.node_id == uuid.UUID(page["id"]),
        WikiPageVersion.kind == "imported").order_by(WikiPageVersion.version_no))).all()
    assert kinds == [1, 2]


async def test_seeding_a_published_page_keeps_unpublished_changes_honest(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Pub", kind="page")
    await publish_via_db(db, page["id"], _doc("same"))
    await _put_draft(client, s["owner"], page["id"], _doc("same"))
    db.expire_all()
    assert (await db.get(WikiPage, uuid.UUID(page["id"]))).has_unpublished_changes is False
    await _put_draft(client, s["owner"], page["id"], _doc("different"))
    db.expire_all()
    assert (await db.get(WikiPage, uuid.UUID(page["id"]))).has_unpublished_changes is True


async def test_a_page_opened_live_refuses_the_seed(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Live", kind="page")
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    row.ydoc = b"\x00\x00"
    row.draft_json = _doc("live words")
    await db.commit()

    resp = await _put_draft(client, s["owner"], page["id"], _doc("imported"), expect=409)
    assert resp.json()["detail"]["code"] == "already_live"
    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert row.draft_json == _doc("live words")
    count = (await db.scalars(select(WikiPageVersion.id).where(
        WikiPageVersion.node_id == uuid.UUID(page["id"])))).all()
    assert count == []


async def test_seeding_needs_edit_on_a_page(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Guarded", kind="page")
    await publish_via_db(db, page["id"])

    resp = await _put_draft(client, s["viewer"], page["id"], _doc("x"), expect=403)
    assert resp.json()["detail"]["code"] == "forbidden"

    # someone who can't see the space at all: 404, never 403
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    outsider, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    resp = await _put_draft(client, outsider, page["id"], _doc("x"), expect=404)
    assert resp.json()["detail"]["code"] == "not_found"

    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await _put_draft(client, s["owner"], folder["id"], _doc("x"), expect=404)
    assert resp.json()["detail"]["code"] == "not_found"

    await _put_draft(client, s["owner"], uuid.uuid4(), _doc("x"), expect=404)


async def test_seeding_validates_the_document(client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Checked", kind="page")

    resp = await _put_draft(client, s["owner"], page["id"], {"type": "paragraph"}, expect=422)
    assert resp.json()["detail"]["code"] == "bad_doc"
    resp = await _put_draft(client, s["owner"], page["id"], ["not", "a", "doc"], expect=422)
    assert resp.json()["detail"]["code"] == "bad_doc"

    monkeypatch.setattr("serversherpa.wiki.pages.MAX_DOC_BYTES", 64)
    resp = await _put_draft(client, s["owner"], page["id"],
                            _doc("x" * 200), expect=413)
    assert resp.json()["detail"]["code"] == "too_large"
    assert wiki_content.MAX_DOC_BYTES > 64  # only the patched copy changed

    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert row.draft_json is None
