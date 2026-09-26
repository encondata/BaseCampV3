"""HTTP tests for the wiki search API — Task 7: full-text and fuzzy
title search, permission filtering, space/kind filters, and safe HTML
snippets — plus a direct test of `wiki.search.refresh_search`'s file
body text."""
import uuid

from serversherpa.db.models import (
    Client,
    WikiFile,
    WikiFileVersion,
    WikiGrant,
    WikiNode,
    WikiPage,
)
from serversherpa.wiki import search as wiki_search
from tests.wiki_helpers import _create, _doc, _setup, _space, login_as, publish_via_api


async def _set_draft(db, node_id, content):
    """Stand in for the collab server's store (see test_wiki_pages_api.py)."""
    db.expire_all()
    row = await db.get(WikiPage, uuid.UUID(str(node_id)))
    row.draft_json = content
    row.has_unpublished_changes = True
    await db.commit()


async def _create_file_via_db(db, space, title, *, description="",
                              text_extract=None) -> dict:
    """A file node with one version, its `text_extract` set directly —
    for tests exercising search over extracted text without wiring up
    real storage or the worker."""
    node = WikiNode(space_id=uuid.UUID(str(space["id"])), kind="file", title=title)
    db.add(node)
    await db.flush()
    version = WikiFileVersion(
        node_id=node.id, version_no=1, storage_key=f"wiki/test/{node.id}",
        filename=title, content_type="text/plain", size_bytes=10,
        preview_kind="none", preview_status="skipped",
        text_extract=text_extract,
        extract_status="ready" if text_extract else "skipped")
    db.add(version)
    await db.flush()
    db.add(WikiFile(node_id=node.id, description=description,
                    current_version_id=version.id))
    await db.commit()
    return {"id": str(node.id)}


async def _search(client, headers, q, *, expect=200, **params):
    resp = await client.get("/wiki/search", headers=headers,
                            params={"q": q, **params})
    assert resp.status_code == expect, resp.text
    return resp.json()


# ── body search ─────────────────────────────────────────────────────


async def test_search_matches_published_page_body(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await _set_draft(db, page["id"], _doc("reticulating splines carefully"))
    await publish_via_api(client, s["owner"], page["id"])

    hits = await _search(client, s["owner"], "reticulating")
    assert [h["node"]["id"] for h in hits] == [page["id"]]
    assert hits[0]["node"]["kind"] == "page"
    assert hits[0]["node"]["space_key"] == s["space"]["key"]


async def test_body_search_ignores_the_draft(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await _set_draft(db, page["id"], _doc("published content only"))
    await publish_via_api(client, s["owner"], page["id"])
    await _set_draft(db, page["id"], _doc("secret draftonly wording"))

    hits = await _search(client, s["owner"], "draftonly")
    assert hits == []


# ── title typo tolerance ─────────────────────────────────────────────


async def test_title_typo_finds_the_page(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Installation guide",
                         kind="page")
    await publish_via_api(client, s["owner"], page["id"])

    hits = await _search(client, s["owner"], "instalation")
    assert page["id"] in [h["node"]["id"] for h in hits]


# ── file text_extract ─────────────────────────────────────────────────


async def test_search_matches_file_extracted_text(client, db):
    s = await _setup(client, db)
    file_node = await _create_file_via_db(
        db, s["space"], "notes.txt", text_extract="contains the word zephyrine")
    await wiki_search.refresh_search(db, uuid.UUID(file_node["id"]))
    await db.commit()

    hits = await _search(client, s["owner"], "zephyrine")
    assert file_node["id"] in [h["node"]["id"] for h in hits]
    [hit] = [h for h in hits if h["node"]["id"] == file_node["id"]]
    assert hit["node"]["kind"] == "file"


# ── permission filtering ────────────────────────────────────────────


async def test_view_only_caller_does_not_see_internal_space_hits(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Router install guide",
                         kind="page")
    await _set_draft(db, page["id"], _doc("connect the switch"))
    await publish_via_api(client, s["owner"], page["id"])

    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    outsider, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    hits = await _search(client, outsider, "router")
    assert hits == []


async def test_node_level_grant_reaches_into_an_otherwise_private_space(client, db):
    """A person with no space-level access at all — the space is
    `private`, so there's no `internal`/`everyone` grant to fall back on
    — but a `view` grant on one page must still find that page (they can
    already open it by link) without surfacing its sibling."""
    owner_h, _ = await login_as(client, db, roles=("staff",))
    space = await _space(client, owner_h, default_access="private", name="Private Space")
    page = await _create(client, owner_h, space, "Secret Runbook", kind="page")
    await publish_via_api(client, owner_h, page["id"])
    sibling = await _create(client, owner_h, space, "Secret Sibling", kind="page")
    await publish_via_api(client, owner_h, sibling["id"])

    outsider_h, outsider_id = await login_as(client, db, roles=("staff",))
    db.add(WikiGrant(
        space_id=uuid.UUID(space["id"]), node_id=uuid.UUID(page["id"]),
        principal_type="person", principal_id=str(outsider_id), level="view"))
    await db.commit()

    hits = await _search(client, outsider_h, "secret")
    ids = [h["node"]["id"] for h in hits]
    assert page["id"] in ids
    assert sibling["id"] not in ids


async def test_unpublished_page_found_by_title_for_editors_only(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Distinctive Draft Title",
                         kind="page")
    # never published

    hits = await _search(client, s["editor"], "distinctive")
    assert page["id"] in [h["node"]["id"] for h in hits]

    hits = await _search(client, s["viewer"], "distinctive")
    assert hits == []


# ── filters ──────────────────────────────────────────────────────────


async def test_space_filter_limits_to_one_space(client, db):
    s = await _setup(client, db)
    other = await _setup(client, db)
    page_a = await _create(client, s["owner"], s["space"], "Quokka notes", kind="page")
    await publish_via_api(client, s["owner"], page_a["id"])
    page_b = await _create(client, other["owner"], other["space"], "Quokka facts",
                           kind="page")
    await publish_via_api(client, other["owner"], page_b["id"])

    hits = await _search(client, s["owner"], "quokka", space=s["space"]["key"])
    assert [h["node"]["id"] for h in hits] == [page_a["id"]]


async def test_unknown_space_key_returns_empty_list(client, db):
    s = await _setup(client, db)
    hits = await _search(client, s["owner"], "anything", space="no-such-space-xyz")
    assert hits == []


async def test_kind_filter_only_returns_that_kind(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Wombat archive")
    page = await _create(client, s["owner"], s["space"], "Wombat guide", kind="page")
    await publish_via_api(client, s["owner"], page["id"])

    hits = await _search(client, s["owner"], "wombat", kind="page")
    ids = [h["node"]["id"] for h in hits]
    assert page["id"] in ids
    assert folder["id"] not in ids


async def test_bad_kind_is_422(client, db):
    s = await _setup(client, db)
    resp = await client.get("/wiki/search", headers=s["owner"],
                            params={"q": "x", "kind": "blob"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_kind"


# ── snippet escaping ─────────────────────────────────────────────────


async def test_snippet_escapes_html_and_keeps_marks(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Notes", kind="page")
    await _set_draft(db, page["id"], _doc(
        "This report mentions <script>alert(1)</script> a xylophone somewhere."))
    await publish_via_api(client, s["owner"], page["id"])

    hits = await _search(client, s["owner"], "xylophone")
    [hit] = [h for h in hits if h["node"]["id"] == page["id"]]
    snippet = hit["snippet_html"]
    assert "<script>" not in snippet
    assert "&lt;script&gt;" in snippet
    assert "<mark>" in snippet and "</mark>" in snippet


# ── validation ───────────────────────────────────────────────────────


async def test_query_too_long_is_422(client, db):
    s = await _setup(client, db)
    resp = await client.get("/wiki/search", headers=s["owner"],
                            params={"q": "x" * 201})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_query"


async def test_empty_query_is_422(client, db):
    s = await _setup(client, db)
    resp = await client.get("/wiki/search", headers=s["owner"], params={"q": "  "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_query"
