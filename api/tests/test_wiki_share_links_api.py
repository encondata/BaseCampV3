"""HTTP tests for public share links (Phase 3, spec §8): creating,
listing and revoking a page's or file's links (manage level, the space's
`allow_public_links`), the wiki-admin list of every link, and the
unauthenticated `GET /wiki/public/{token}` — published content only, 404
for every failure, IP rate-limited, tokens stored only as sha256 hashes.

Storage presigning is pure local signing and runs for real."""
import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import select, text

from serversherpa.config import get_settings
from serversherpa.db.models import (
    AuditLog,
    Client,
    WikiFile,
    WikiFileVersion,
    WikiNode,
    WikiPageAsset,
    WikiShareLink,
)
from serversherpa.wiki import share_links
from serversherpa.wiki.content import PUBLIC_PAGE_TEXT
from tests.wiki_helpers import _create, _setup, login_as, publish_via_db


@pytest.fixture(autouse=True)
def _fresh_limiter():
    """Every test starts with an empty public rate-limit window."""
    share_links.public_limiter.reset()
    yield
    share_links.public_limiter.reset()


async def _allow(client, s, allowed=True):
    resp = await client.patch(f"/wiki/spaces/{s['space']['key']}", headers=s["owner"],
                              json={"settings": {"allow_public_links": allowed}})
    assert resp.status_code == 200, resp.text


async def _page(client, s, db, title="Rack Guide", content=None, publish=True):
    page = await _create(client, s["owner"], s["space"], title, kind="page")
    if publish:
        await publish_via_db(db, page["id"], content)
    return page


async def _file(db, s, *, filename="manual.pdf", content_type="application/pdf",
                preview_kind="native"):
    node = WikiNode(space_id=uuid.UUID(s["space"]["id"]), kind="file", title=filename)
    db.add(node)
    await db.flush()
    db.add(WikiFile(node_id=node.id, description=""))
    version = WikiFileVersion(
        node_id=node.id, version_no=1, storage_key=f"wiki/test/{uuid.uuid4()}/{filename}",
        filename=filename, content_type=content_type, size_bytes=1234,
        preview_kind=preview_kind, preview_status="ready", extract_status="skipped")
    db.add(version)
    await db.flush()
    (await db.get(WikiFile, node.id)).current_version_id = version.id
    await db.commit()
    return node.id


async def _share(client, headers, node_id, expect=201, **body):
    resp = await client.post(f"/wiki/nodes/{node_id}/share-links", headers=headers,
                             json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


def _token(created):
    return created["url"].rsplit("/p/", 1)[1]


async def _public(client, token, headers=None):
    return await client.get(f"/wiki/public/{token}", headers=headers or {})


# ── create ───────────────────────────────────────────────────────────


async def test_create_needs_manage(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    outsider, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)

    await _share(client, s["viewer"], page["id"], expect=403)
    await _share(client, s["editor"], page["id"], expect=403)
    # someone who can't see it at all: 404, never 403
    resp = await _share(client, outsider, page["id"], expect=404)
    assert resp["detail"]["code"] == "not_found"
    await _share(client, s["owner"], page["id"])


async def test_create_is_for_pages_and_files_only(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await client.post(f"/wiki/nodes/{folder['id']}/share-links",
                             headers=s["owner"], json={})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_kind"

    file_id = await _file(db, s)
    await _share(client, s["owner"], file_id)


async def test_create_needs_the_space_to_allow_public_links(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    resp = await client.post(f"/wiki/nodes/{page['id']}/share-links",
                             headers=s["owner"], json={})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "links_disabled"


async def test_create_returns_the_token_once_and_stores_only_its_hash(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)

    created = await _share(client, s["owner"], page["id"])
    assert set(created) == {"id", "url", "expires_at"}
    origin = get_settings().wiki_origin.rstrip("/")
    assert created["url"].startswith(f"{origin}/p/")
    token = _token(created)
    assert len(token) >= 43

    row = await db.get(WikiShareLink, uuid.UUID(created["id"]))
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    # the token itself is nowhere in the table
    dump = str((await db.execute(text(
        "SELECT row_to_json(l)::text FROM wiki_share_links l"))).scalars().all())
    assert token not in dump

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_share_link",
        AuditLog.entity_id == created["id"]))).all()
    assert [a.action for a in audits] == ["create"]
    assert token not in str(audits[0].changes)
    assert row.token_hash not in str(audits[0].changes)

    # listing never shows a token again
    listed = (await client.get(f"/wiki/nodes/{page['id']}/share-links",
                               headers=s["owner"])).json()
    assert token not in str(listed) and row.token_hash not in str(listed)


async def test_create_expiry_options(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    now = datetime.now(UTC)

    default = await _share(client, s["owner"], page["id"])
    assert abs(datetime.fromisoformat(default["expires_at"]) - (now + timedelta(days=30))) \
        < timedelta(minutes=1)
    week = await _share(client, s["owner"], page["id"], expires_in_days=7)
    assert abs(datetime.fromisoformat(week["expires_at"]) - (now + timedelta(days=7))) \
        < timedelta(minutes=1)
    never = await _share(client, s["owner"], page["id"], expires_in_days=None)
    assert never["expires_at"] is None
    await _share(client, s["owner"], page["id"], expect=422, expires_in_days=5)


# ── list / revoke / admin list ───────────────────────────────────────


async def test_list_needs_manage_and_shows_status(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    a = await _share(client, s["owner"], page["id"])
    b = await _share(client, s["owner"], page["id"], expires_in_days=None)
    resp = await client.delete(f"/wiki/share-links/{b['id']}", headers=s["owner"])
    assert resp.status_code == 204

    assert (await client.get(f"/wiki/nodes/{page['id']}/share-links",
                             headers=s["viewer"])).status_code == 403
    listed = (await client.get(f"/wiki/nodes/{page['id']}/share-links",
                               headers=s["owner"])).json()
    by_id = {link["id"]: link for link in listed}
    assert by_id[a["id"]]["status"] == "active"
    assert by_id[b["id"]]["status"] == "revoked"
    assert by_id[a["id"]]["view_count"] == 0
    assert by_id[a["id"]]["created_by"]["id"] == str(s["owner_id"])
    assert by_id[a["id"]]["node"]["title"] == "Rack Guide"


async def test_revoke_by_manager_or_creator(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])

    # an editor who didn't create it can't
    resp = await client.delete(f"/wiki/share-links/{created['id']}", headers=s["editor"])
    assert resp.status_code == 403
    # unknown id
    resp = await client.delete(f"/wiki/share-links/{uuid.uuid4()}", headers=s["owner"])
    assert resp.status_code == 404

    # a creator who has since lost manage still can
    await client.put(f"/wiki/spaces/{s['space']['key']}/grants", headers=s["owner"], json={
        "grants": [
            {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "manage"},
            {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "view"},
        ]})
    resp = await client.delete(f"/wiki/share-links/{created['id']}", headers=s["owner"])
    assert resp.status_code == 204

    row = await db.get(WikiShareLink, uuid.UUID(created["id"]))
    await db.refresh(row)
    assert row.revoked_at is not None
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_share_link",
        AuditLog.entity_id == created["id"], AuditLog.action == "revoke"))).all()
    assert len(audits) == 1
    assert (await _public(client, _token(created))).status_code == 404


async def test_admin_lists_every_link(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])
    admin, _ = await login_as(client, db, roles=("admin",))

    assert (await client.get("/wiki/share-links", headers=s["owner"])).status_code == 403
    resp = await client.get("/wiki/share-links", headers=admin)
    assert resp.status_code == 200
    listed = resp.json()
    assert [link["id"] for link in listed] == [created["id"]]
    assert listed[0]["node"] == {
        "id": page["id"], "title": "Rack Guide", "kind": "page",
        "space_key": s["space"]["key"], "space_name": s["space"]["name"]}
    # an admin can revoke any link
    assert (await client.delete(f"/wiki/share-links/{created['id']}",
                                headers=admin)).status_code == 204


# ── public: pages ────────────────────────────────────────────────────


async def test_public_page_serves_published_content_without_a_session(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    other = await _page(client, s, db, title="Secret Runbook")
    page = await _create(client, s["owner"], s["space"], "Rack Guide", kind="page")

    mine = WikiPageAsset(node_id=uuid.UUID(page["id"]), storage_key="wiki/x/img.png",
                         filename="img.png", content_type="image/png", size_bytes=10)
    unused = WikiPageAsset(node_id=uuid.UUID(page["id"]), storage_key="wiki/x/old.png",
                           filename="old.png", content_type="image/png", size_bytes=10)
    theirs = WikiPageAsset(node_id=uuid.UUID(other["id"]), storage_key="wiki/x/t.png",
                           filename="t.png", content_type="image/png", size_bytes=10)
    svg = WikiPageAsset(node_id=uuid.UUID(page["id"]), storage_key="wiki/x/a.svg",
                        filename="a.svg", content_type="image/svg+xml", size_bytes=10)
    db.add_all([mine, unused, theirs, svg])
    await db.commit()

    content = {"type": "doc", "content": [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "See "},
            {"type": "pageLink", "attrs": {"nodeId": other["id"]}},
            {"type": "text", "text": "anchored", "marks": [
                {"type": "commentThread", "attrs": {"threadId": "t-1"}}]}]},
        {"type": "wikiImage", "attrs": {"assetId": str(mine.id)}},
        {"type": "wikiImage", "attrs": {"assetId": str(theirs.id)}},
        {"type": "wikiImage", "attrs": {"assetId": str(svg.id)}},
        {"type": "wikiImage", "attrs": {"assetId": "not-a-uuid"}},
    ]}
    version = await publish_via_db(db, page["id"], content)
    created = await _share(client, s["owner"], page["id"])

    resp = await _public(client, _token(created))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "page"
    # the node's live title, as signed-in readers see it (renames aren't drafts)
    assert body["title"] == "Rack Guide"
    assert datetime.fromisoformat(body["published_at"]) == version.created_at
    first = body["content_json"]["content"][0]["content"]
    assert first == [{"type": "text", "text": f"See {PUBLIC_PAGE_TEXT}anchored"}]
    assert other["id"] not in str(body) and "Secret Runbook" not in str(body)

    # only this page's assets that the published content references
    assert set(body["asset_urls"]) == {str(mine.id), str(svg.id)}
    img = parse_qs(urlparse(body["asset_urls"][str(mine.id)]).query)
    assert img["response-content-type"] == ["image/png"]
    assert int(img["X-Amz-Expires"][0]) <= 600
    # active markup never inline
    svg_q = parse_qs(urlparse(body["asset_urls"][str(svg.id)]).query)
    assert svg_q["response-content-type"] == ["application/octet-stream"]
    assert svg_q["response-content-disposition"][0].startswith("attachment")


async def test_public_view_counts(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])
    for _ in range(3):
        assert (await _public(client, _token(created))).status_code == 200
    row = await db.get(WikiShareLink, uuid.UUID(created["id"]))
    await db.refresh(row)
    assert row.view_count == 3
    assert row.last_viewed_at is not None


async def test_public_serves_the_published_version_not_the_draft(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db, content={"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "live words"}]}]})
    await db.execute(text("UPDATE wiki_pages SET draft_json = :d WHERE node_id = :n"),
                     {"d": '{"type":"doc","content":[{"type":"paragraph","content":'
                           '[{"type":"text","text":"draft words"}]}]}', "n": page["id"]})
    await db.commit()
    created = await _share(client, s["owner"], page["id"])
    body = (await _public(client, _token(created))).json()
    assert "live words" in str(body["content_json"])
    assert "draft words" not in str(body)


# ── public: files ────────────────────────────────────────────────────


@pytest.mark.parametrize("filename, content_type, preview_kind, inline_type", [
    ("manual.pdf", "application/pdf", "native", "application/pdf"),
    ("notes.md", "application/octet-stream", "native", "text/plain; charset=utf-8"),
    ("logo.svg", "image/svg+xml", "none", None),
    ("bundle.zip", "application/zip", "none", None),
])
async def test_public_file_follows_the_inline_rules(client, db, filename, content_type,
                                                    preview_kind, inline_type):
    s = await _setup(client, db)
    await _allow(client, s)
    file_id = await _file(db, s, filename=filename, content_type=content_type,
                          preview_kind=preview_kind)
    created = await _share(client, s["owner"], file_id)

    body = (await _public(client, _token(created))).json()
    assert body["kind"] == "file"
    assert body["title"] == filename
    assert body["filename"] == filename
    assert body["content_type"] == content_type
    assert body["size_bytes"] == 1234
    query = parse_qs(urlparse(body["url"]).query)
    assert int(query["X-Amz-Expires"][0]) <= 600
    disposition = query["response-content-disposition"][0]
    assert body["inline"] is (inline_type is not None)
    if inline_type is None:
        assert disposition.startswith("attachment")
        assert query["response-content-type"] == ["application/octet-stream"]
    else:
        assert disposition.startswith("inline")
        assert query["response-content-type"] == [inline_type]
    download = parse_qs(urlparse(body["download_url"]).query)
    assert download["response-content-disposition"][0].startswith("attachment")


# ── public: every failure is a 404 ───────────────────────────────────


async def _expect_404(client, token):
    resp = await _public(client, token)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "not_found"


async def test_public_unknown_token(client, db):
    await _expect_404(client, share_links.new_token())
    await _expect_404(client, "x")
    await _expect_404(client, "a" * 500)


async def test_public_expired(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"], expires_in_days=1)
    await db.execute(text("UPDATE wiki_share_links SET expires_at = now() - interval '1 second' "
                          "WHERE id = :id"), {"id": created["id"]})
    await db.commit()
    await _expect_404(client, _token(created))


async def test_public_space_setting_turned_off(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])
    assert (await _public(client, _token(created))).status_code == 200
    await _allow(client, s, False)
    await _expect_404(client, _token(created))


async def test_public_node_trashed_or_purged(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])
    resp = await client.delete(f"/wiki/nodes/{page['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    await _expect_404(client, _token(created))

    await db.execute(text("DELETE FROM wiki_nodes WHERE id = :id"), {"id": page["id"]})
    await db.commit()
    await _expect_404(client, _token(created))


async def test_public_page_never_published(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db, publish=False)
    created = await _share(client, s["owner"], page["id"])
    await _expect_404(client, _token(created))


async def test_public_archived_space_still_serves(client, db):
    s = await _setup(client, db)
    await _allow(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])
    resp = await client.post(f"/wiki/spaces/{s['space']['key']}/archive", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert (await _public(client, _token(created))).status_code == 200


# ── public: rate limit ───────────────────────────────────────────────


async def test_public_is_rate_limited_per_ip(client, db):
    limit = share_links.PUBLIC_RATE_LIMIT
    token = share_links.new_token()
    a = {"X-Forwarded-For": "203.0.113.7"}
    b = {"X-Forwarded-For": "203.0.113.8"}
    for _ in range(limit):
        assert (await _public(client, token, a)).status_code == 404
    resp = await _public(client, token, a)
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "rate_limited"
    # another address has its own bucket (the key is deps.rate_limit_ip's)
    assert (await _public(client, token, b)).status_code == 404


def test_limiter_window_resets():
    limiter = share_links.IpRateLimiter(limit=2, window_seconds=60)
    assert limiter.hit("ip", now=0) and limiter.hit("ip", now=1)
    assert not limiter.hit("ip", now=2)
    assert limiter.hit("ip", now=61)
