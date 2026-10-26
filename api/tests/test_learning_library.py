"""Learning library: documents linked to pages in the `learning` wiki
space, versions snapshotted at publish (the page's published content plus
HTML rendered once by the wiki render server), and reading a snapshot
after the wiki page changes or is purged (Review Focus 3).

The render server is an httpx MockTransport with a tiny renderer of its
own, as in test_wiki_export_worker.py; presigning runs for real (it is
local signing)."""
import html
import json
import os
import uuid

import httpx
import pytest
from sqlalchemy import delete, func, select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.learning.models import (
    LearningDocument,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningTranslation,
)
from serversherpa.wiki import export_html, tree
from tests.test_sites_api import login  # noqa: F401
from tests.test_status_values_write import _make

TOKEN = "learning-render-token-for-tests"


# ── the render server's stand-in ─────────────────────────────────────


@pytest.fixture(autouse=True)
def service_token():
    before = os.environ.get("SS_WIKI_SERVICE_TOKEN")
    os.environ["SS_WIKI_SERVICE_TOKEN"] = TOKEN
    get_settings.cache_clear()
    yield
    if before is None:
        os.environ.pop("SS_WIKI_SERVICE_TOKEN", None)
    else:
        os.environ["SS_WIKI_SERVICE_TOKEN"] = before
    get_settings.cache_clear()


def _render(node) -> str:
    kind = node.get("type")
    inner = "".join(_render(c) for c in node.get("content") or [])
    attrs = node.get("attrs") or {}
    if kind == "paragraph":
        return f"<p>{inner}</p>"
    if kind == "text":
        return html.escape(node["text"])
    if kind == "wikiImage":
        return (f'<figure data-wiki-image="{attrs["assetId"]}"><img '
                f'alt="{html.escape(attrs.get("alt", ""))}"></figure>')
    if kind == "details":
        return f"<details>{inner}</details>"
    return inner


class FakeRenderer:
    """The wiki server's /internal/render, as an httpx transport."""

    def __init__(self):
        self.status = 200
        self.unreachable = False
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        if self.status != 200:
            return httpx.Response(self.status, json={"detail": {"code": "boom"}})
        return httpx.Response(200, json={"html": _render(json.loads(request.content)["doc"])})


@pytest.fixture
def renderer(monkeypatch):
    fake = FakeRenderer()
    monkeypatch.setattr(export_html, "_transport", httpx.MockTransport(fake.handler))
    return fake


# ── fixtures ─────────────────────────────────────────────────────────


def _doc(*parts):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": p}]}
        if isinstance(p, str) else p for p in parts]}


def _image(asset_id, alt="Boots"):
    return {"type": "wikiImage", "attrs": {"assetId": str(asset_id), "alt": alt}}


async def _space(db, key="learning", name="Learning"):
    space = WikiSpace(key=key, name=name)
    db.add(space)
    await db.flush()
    return space


async def _node(db, space, title, kind="page", parent=None):
    node = await tree.create_node(db, space=space, parent=parent, kind=kind,
                                  title=title, actor_id=None)
    await db.commit()
    return node


async def _publish_wiki(db, node, content, title=None):
    """A new published version of the wiki page (what POST
    /wiki/pages/{id}/publish leaves behind)."""
    last = await db.scalar(select(func.max(WikiPageVersion.version_no))
                           .where(WikiPageVersion.node_id == node.id))
    version = WikiPageVersion(node_id=node.id, version_no=(last or 0) + 1,
                              title=title or node.title, content_json=content,
                              kind="published")
    db.add(version)
    await db.flush()
    (await db.get(WikiPage, node.id)).published_version_id = version.id
    await db.commit()
    return version


async def _manager(db, client):
    return await _make(db, client, "admin", f"lib-{uuid.uuid4().hex[:8]}@test.example.com")


async def _create(client, hdrs, node, title="Dress code", expect=201, **extra):
    resp = await client.post("/learning/documents", headers=hdrs, json={
        "title": title, "wiki_node_id": str(node.id), **extra})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _publish(client, hdrs, doc_id, note=None, expect=201):
    resp = await client.post(f"/learning/documents/{doc_id}/publish", headers=hdrs,
                             json={"change_note": note})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _actions(db, doc_id):
    return list(await db.scalars(select(AuditLog.action).where(
        AuditLog.entity_type == "learning_document", AuditLog.entity_id == str(doc_id))
        .order_by(AuditLog.at)))


# ── tests ────────────────────────────────────────────────────────────


async def test_create_requires_learning_space_page(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    learning = await _space(db)
    other = await _space(db, key="ops-guides", name="Ops guides")
    folder = await _node(db, learning, "Onboarding", kind="folder")
    page = await _node(db, learning, "Dress code", parent=folder)
    await _publish_wiki(db, page, _doc("Wear boots."))
    await _node(db, learning, "Draft only")
    elsewhere = await _node(db, other, "Ops page")
    trashed = await _node(db, learning, "Old page")
    trashed.deleted_at = func.now()
    await db.commit()

    for target in (elsewhere, folder, trashed):
        resp = await client.post("/learning/documents", headers=hdrs, json={
            "title": "X", "wiki_node_id": str(target.id)})
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "not_learning_page"
    resp = await client.post("/learning/documents", headers=hdrs, json={
        "title": "X", "wiki_node_id": str(uuid.uuid4())})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "not_learning_page"

    body = await _create(client, hdrs, page, validity_days=365, min_read_seconds=60)
    assert body["title"] == "Dress code" and body["wiki_node_id"] == str(page.id)
    assert body["validity_days"] == 365 and body["min_read_seconds"] == 60
    assert body["resign_rule"] == "expired_or_new_version" and body["sign_style"] == "typed_name"
    assert body["current_version_no"] is None and body["versions"] == []
    assert body["current_html"] is None
    assert body["wiki_page"] == {"id": str(page.id), "title": "Dress code",
                                 "published_version_no": 1}
    assert body["has_wiki_changes"] is True
    assert await _actions(db, body["id"]) == ["learning_document_create"]

    # the "link a page" picker: pages in the learning space only
    resp = await client.get("/learning/wiki-pages", headers=hdrs)
    assert resp.status_code == 200, resp.text
    pages = {p["title"]: p for p in resp.json()}
    assert set(pages) == {"Dress code", "Draft only"}
    assert pages["Dress code"] == {"id": str(page.id), "title": "Dress code",
                                   "path": ["Onboarding"], "published_version_no": 1}
    assert pages["Draft only"]["path"] == [] and pages["Draft only"]["published_version_no"] is None


async def test_publish_snapshots_and_numbers_versions(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    asset = WikiPageAsset(node_id=page.id, storage_key=f"wiki/assets/{uuid.uuid4()}/boots.png",
                          filename="boots.png", content_type="image/png", size_bytes=10)
    db.add(asset)
    await db.flush()
    first = _doc("Wear boots.", _image(asset.id))
    wiki_v1 = await _publish_wiki(db, page, first)
    doc = await _create(client, hdrs, page)

    v1 = await _publish(client, hdrs, doc["id"], note="First issue")
    assert v1["version_no"] == 1 and v1["wiki_version_no"] == 1
    assert v1["change_note"] == "First issue" and v1["title"] == "Dress code"
    assert "<p>Wear boots.</p>" in v1["html"]
    assert len(renderer.requests) == 1
    assert renderer.requests[0].headers[export_html.SERVICE_TOKEN_HEADER] == TOKEN
    row = await db.scalar(select(LearningDocumentVersion).where(
        LearningDocumentVersion.document_id == uuid.UUID(doc["id"])))
    assert row.content_json == first and row.wiki_version_id == wiki_v1.id
    assert row.image_asset_ids == [asset.id]
    # the stored HTML has no image source; reading adds a presigned one
    assert f'<figure data-wiki-image="{asset.id}"><img alt=' in row.content_html
    assert "src=" not in row.content_html

    detail = (await client.get(f"/learning/documents/{doc['id']}", headers=hdrs)).json()
    assert detail["current_version_no"] == 1 and detail["has_wiki_changes"] is False
    assert [v["version_no"] for v in detail["versions"]] == [1]
    assert detail["versions"][0]["published_by"]["id"]
    assert f'<figure data-wiki-image="{asset.id}"><img src="' in detail["current_html"]
    assert "boots.png" in detail["current_html"]

    await _publish_wiki(db, page, _doc("Wear steel-toe boots."))
    v2 = await _publish(client, hdrs, doc["id"])
    assert v2["version_no"] == 2 and v2["wiki_version_no"] == 2 and v2["change_note"] is None
    stored = await db.get(LearningDocument, uuid.UUID(doc["id"]))
    await db.refresh(stored)
    assert stored.current_version_id == uuid.UUID(v2["id"])

    # the list: version, packets, sign-offs, translation status per language
    packet = LearningPacket(name="Standard onboarding")
    db.add(packet)
    await db.flush()
    db.add(LearningPacketItem(packet_id=packet.id, document_id=stored.id))
    db.add(LearningTranslation(version_id=uuid.UUID(v1["id"]), language="ja",
                               status="published", title="ドレスコード", content_html="<p>x</p>"))
    db.add(LearningTranslation(version_id=uuid.UUID(v2["id"]), language="ko",
                               status="draft", title="복장", content_html="<p>x</p>"))
    await db.commit()
    resp = await client.get("/learning/documents", headers=hdrs)
    assert resp.status_code == 200, resp.text
    (item,) = resp.json()
    assert item["id"] == doc["id"] and item["current_version_no"] == 2
    assert item["published_at"] is not None
    assert item["packets"] == ["Standard onboarding"] and item["signoff_count"] == 0
    assert item["languages"] == {"ja": "out_of_date", "ko": "draft"}
    assert await _actions(db, doc["id"]) == [
        "learning_document_create", "learning_document_publish", "learning_document_publish"]


async def test_publish_twice_without_wiki_change_is_409(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    doc = await _create(client, hdrs, page)
    resp = await client.post(f"/learning/documents/{doc['id']}/publish", headers=hdrs, json={})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "wiki_not_published"

    await _publish_wiki(db, page, _doc("Wear boots."))
    await _publish(client, hdrs, doc["id"])
    resp = await client.post(f"/learning/documents/{doc['id']}/publish", headers=hdrs,
                             json={"change_note": "again"})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "no_changes"
    assert len(renderer.requests) == 1          # refused before rendering
    assert await db.scalar(select(func.count()).select_from(LearningDocumentVersion)) == 1


async def test_wiki_edit_after_publish_does_not_change_snapshot(client, db, seeded_user,
                                                                renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    await _publish_wiki(db, page, _doc("Wear boots."))
    doc = await _create(client, hdrs, page)
    v1 = await _publish(client, hdrs, doc["id"])

    # the wiki moves on: a new published version and an unpublished draft
    await _publish_wiki(db, page, _doc("Sandals are fine."), title="Footwear")
    wiki_page = await db.get(WikiPage, page.id)
    wiki_page.draft_json = _doc("Bare feet.")
    wiki_page.has_unpublished_changes = True
    await db.commit()

    detail = (await client.get(f"/learning/documents/{doc['id']}", headers=hdrs)).json()
    assert "<p>Wear boots.</p>" in detail["current_html"]
    assert "Sandals" not in detail["current_html"]
    assert detail["has_wiki_changes"] is True
    assert detail["wiki_page"]["published_version_no"] == 2
    resp = await client.get(f"/learning/documents/{doc['id']}/versions/{v1['id']}",
                            headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert "<p>Wear boots.</p>" in resp.json()["html"]
    assert resp.json()["title"] == "Dress code"
    assert len(renderer.requests) == 1          # reading never renders


async def test_purged_wiki_node_keeps_version_readable(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    await _publish_wiki(db, page, _doc("Wear boots."))
    doc = await _create(client, hdrs, page)
    v1 = await _publish(client, hdrs, doc["id"])

    # the wiki trash purge hard-deletes the node; its versions cascade
    await db.execute(delete(WikiNode).where(WikiNode.id == page.id))
    await db.commit()
    assert await db.scalar(select(func.count()).select_from(WikiPageVersion)) == 0

    resp = await client.get(f"/learning/documents/{doc['id']}/versions/{v1['id']}",
                            headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert "<p>Wear boots.</p>" in resp.json()["html"]
    detail = (await client.get(f"/learning/documents/{doc['id']}", headers=hdrs)).json()
    assert detail["wiki_node_id"] is None and detail["wiki_page"] is None
    assert "<p>Wear boots.</p>" in detail["current_html"]
    resp = await client.post(f"/learning/documents/{doc['id']}/publish", headers=hdrs, json={})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "wiki_page_missing"
    # a version id from another document is not found
    other = await _node(db, space, "Other")
    other_doc = await _create(client, hdrs, other, title="Other")
    resp = await client.get(f"/learning/documents/{other_doc['id']}/versions/{v1['id']}",
                            headers=hdrs)
    assert resp.status_code == 404


async def test_render_unavailable_is_503(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    await _publish_wiki(db, page, _doc("Wear boots."))
    doc = await _create(client, hdrs, page)

    renderer.unreachable = True
    resp = await client.post(f"/learning/documents/{doc['id']}/publish", headers=hdrs, json={})
    assert resp.status_code == 503 and resp.json()["detail"]["code"] == "render_unavailable"
    renderer.unreachable, renderer.status = False, 500
    resp = await client.post(f"/learning/documents/{doc['id']}/publish", headers=hdrs, json={})
    assert resp.status_code == 503 and resp.json()["detail"]["code"] == "render_unavailable"
    assert await db.scalar(select(func.count()).select_from(LearningDocumentVersion)) == 0

    renderer.status = 200
    assert (await _publish(client, hdrs, doc["id"]))["version_no"] == 1


async def test_patch_validates_settings_and_archive(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    doc = await _create(client, hdrs, page)
    url = f"/learning/documents/{doc['id']}"

    resp = await client.patch(url, headers=hdrs, json={
        "title": "Dress code policy", "validity_days": 180, "sign_style": "drawn_signature",
        "require_scroll": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "Dress code policy" and body["validity_days"] == 180
    assert body["sign_style"] == "drawn_signature" and body["require_scroll"] is False
    # null clears validity (never expires)
    resp = await client.patch(url, headers=hdrs, json={"validity_days": None})
    assert resp.status_code == 200 and resp.json()["validity_days"] is None

    for bad in (
        {"validity_days": 0}, {"validity_days": -5}, {"min_read_seconds": 0},
        {"title": ""}, {"title": None}, {"sign_style": "stamp"}, {"resign_rule": None},
        {"quiz_pass_percent": 101}, {"quiz_max_attempts": 0}, {"bogus": 1},
        # a quiz needs a pass mark; locking needs an attempt limit
        {"quiz_enabled": True},
        {"quiz_enabled": True, "quiz_pass_percent": 75, "quiz_fail_action": "lock"},
    ):
        resp = await client.patch(url, headers=hdrs, json=bad)
        assert resp.status_code == 422, (bad, resp.text)
    resp = await client.patch(url, headers=hdrs, json={
        "quiz_enabled": True, "quiz_pass_percent": 75, "quiz_max_attempts": 3})
    assert resp.status_code == 200, resp.text
    assert resp.json()["quiz_enabled"] is True and resp.json()["quiz_pass_percent"] == 75
    # the merged settings are checked: lock is fine now max attempts is set
    resp = await client.patch(url, headers=hdrs, json={"quiz_fail_action": "lock"})
    assert resp.status_code == 200, resp.text
    resp = await client.patch(url, headers=hdrs, json={"quiz_pass_percent": None})
    assert resp.status_code == 422

    resp = await client.delete(url, headers=hdrs)
    assert resp.status_code == 204, resp.text
    assert (await client.get(url, headers=hdrs)).json()["archived_at"] is not None
    assert (await client.get("/learning/documents", headers=hdrs)).json() == []
    listed = (await client.get("/learning/documents?include_archived=true",
                               headers=hdrs)).json()
    assert [d["id"] for d in listed] == [doc["id"]]
    actions = await _actions(db, doc["id"])
    assert actions[0] == "learning_document_create"
    assert actions[-1] == "learning_document_archive"
    assert "learning_document_update" in actions


async def test_non_manager_forbidden(client, db, seeded_user, renderer):
    hdrs = await _manager(db, client)
    space = await _space(db)
    page = await _node(db, space, "Dress code")
    await _publish_wiki(db, page, _doc("Wear boots."))
    doc = await _create(client, hdrs, page)
    version = await _publish(client, hdrs, doc["id"])
    doc_url = f"/learning/documents/{doc['id']}"
    reads = [("GET", "/learning/documents"), ("GET", "/learning/wiki-pages"),
             ("GET", doc_url), ("GET", f"{doc_url}/versions/{version['id']}")]
    writes = [("POST", "/learning/documents", {"title": "X", "wiki_node_id": str(page.id)}),
              ("PATCH", doc_url, {"title": "Y"}),
              ("POST", f"{doc_url}/publish", {}),
              ("DELETE", doc_url, None)]

    worker = await _make(db, client, "worker", "lib-worker@test.example.com")
    for method, url in reads:
        assert (await client.request(method, url, headers=worker)).status_code == 403, url
    for method, url, body in writes:
        resp = await client.request(method, url, headers=worker, json=body)
        assert resp.status_code == 403, (method, url)

    # staff hold learning:view: they read the library but change nothing
    staff = await _make(db, client, "staff", "lib-staff@test.example.com")
    for method, url in reads:
        assert (await client.request(method, url, headers=staff)).status_code == 200, url
    for method, url, body in writes:
        resp = await client.request(method, url, headers=staff, json=body)
        assert resp.status_code == 403, (method, url)
    assert await _actions(db, doc["id"]) == [
        "learning_document_create", "learning_document_publish"]
