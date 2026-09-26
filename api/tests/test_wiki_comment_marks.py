"""Comment anchors (`commentThread` marks) belong to one page's threads:
they never travel into a template or a copy, where they'd point at
threads of the source page (and show as highlights wherever the rail's
plugin doesn't hide them — previews, diffs, the server renderer)."""
import json
import uuid

from serversherpa.db.models import WikiPage, WikiTemplate
from tests.wiki_helpers import _create, _doc, _setup, publish_via_db


def _anchored(text="Check the spare PDU stock."):
    head, tail = text[:10], text[10:]
    return {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": head},
        {"type": "text", "text": tail, "marks": [
            {"type": "bold"},
            {"type": "commentThread", "attrs": {"threadId": str(uuid.uuid4())}}]},
    ]}]}


def _has_marks(doc) -> bool:
    return "commentThread" in json.dumps(doc)


async def _set_draft(db, page_id, doc):
    row = await db.get(WikiPage, uuid.UUID(str(page_id)))
    row.draft_json = doc
    await db.commit()


async def _template_content(db, template_id):
    db.expire_all()
    return (await db.get(WikiTemplate, uuid.UUID(template_id))).content_json


async def test_saving_a_page_as_a_template_drops_its_comment_anchors(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await _set_draft(db, page["id"], _anchored())
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "From page", "from_node_id": page["id"]})
    assert resp.status_code == 201, resp.text
    content = await _template_content(db, resp.json()["id"])
    assert not _has_marks(content)
    # the bold survives; only the anchor goes
    assert content["content"][0]["content"][1]["marks"] == [{"type": "bold"}]


async def test_template_content_is_stored_without_comment_anchors(client, db):
    s = await _setup(client, db)
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "Given", "content_json": _anchored()})
    assert resp.status_code == 201, resp.text
    template_id = resp.json()["id"]
    assert not _has_marks(await _template_content(db, template_id))

    resp = await client.patch(f"/wiki/templates/{template_id}", headers=s["owner"],
                              json={"content_json": _anchored("Another anchored text")})
    assert resp.status_code == 200, resp.text
    content = await _template_content(db, template_id)
    assert not _has_marks(content)
    assert content["content"][0]["content"][1]["text"] == "chored text"


async def test_a_page_made_from_an_older_anchored_template_starts_without_them(client, db):
    s = await _setup(client, db)
    template = WikiTemplate(space_id=uuid.UUID(s["space"]["id"]), name="Legacy",
                            content_json=_anchored())
    db.add(template)
    await db.commit()
    page = await _create(client, s["owner"], s["space"], "From legacy", kind="page",
                         template_id=str(template.id))
    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert row.draft_json is not None and not _has_marks(row.draft_json)


async def test_copying_a_page_drops_its_comment_anchors(client, db):
    s = await _setup(client, db)
    drafted = await _create(client, s["owner"], s["space"], "Drafted", kind="page")
    await _set_draft(db, drafted["id"], _anchored())
    published = await _create(client, s["owner"], s["space"], "Published", kind="page")
    await publish_via_db(db, published["id"], content=_anchored())
    await _set_draft(db, published["id"], None)

    for source in (drafted, published):
        resp = await client.post(f"/wiki/nodes/{source['id']}/copy", headers=s["owner"],
                                 json={"parent_id": None})
        assert resp.status_code == 201, resp.text
        db.expire_all()
        copy = await db.get(WikiPage, uuid.UUID(resp.json()["id"]))
        assert copy.draft_json is not None and not _has_marks(copy.draft_json), source["title"]
        assert copy.draft_json != _doc()
