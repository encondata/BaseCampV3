"""HTTP tests for the wiki search API — Task 7: full-text and fuzzy
title search, permission filtering, space/kind filters, and safe HTML
snippets — plus a direct test of `wiki.search.refresh_search`'s file
body text."""
import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy import update as sa_update

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


# ── every node is indexed (final review I3 / T7) ────────────────────

LONG = "Network switch configuration {word} for the Dallas site"


async def test_a_new_folder_is_found_by_one_word_of_a_long_title(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], LONG.format(word="runbook"))
    for kind in (None, "folder"):
        hits = await _search(client, s["viewer"], "runbook",
                             **({"kind": kind} if kind else {}))
        assert [h["node"]["id"] for h in hits] == [folder["id"]]


async def test_a_never_published_page_is_found_by_title_for_editors_only(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], LONG.format(word="playbook"),
                         kind="page")
    hits = await _search(client, s["editor"], "playbook")
    assert [h["node"]["id"] for h in hits] == [page["id"]]
    assert await _search(client, s["viewer"], "playbook") == []


async def test_a_new_spaces_home_page_is_found_by_its_title(client, db):
    s = await _setup(client, db)
    space = await _space(client, s["owner"],
                         name="Dallas colocation handbook for field technicians")
    hits = await _search(client, s["owner"], "colocation")
    assert [h["node"]["id"] for h in hits] == [space["home_node_id"]]


async def test_rename_and_copy_reindex(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], LONG.format(word="checklist"))
    target = await _create(client, s["owner"], s["space"], "Archive")
    resp = await client.patch(f"/wiki/nodes/{folder['id']}", headers=s["owner"],
                              json={"title": LONG.format(word="procedure")})
    assert resp.status_code == 200, resp.text
    assert await _search(client, s["owner"], "checklist") == []
    assert [h["node"]["id"] for h in await _search(client, s["owner"], "procedure")] \
        == [folder["id"]]

    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["owner"],
                             json={"parent_id": target["id"]})
    assert resp.status_code == 201, resp.text
    ids = {h["node"]["id"] for h in await _search(client, s["owner"], "procedure")}
    assert ids == {folder["id"], resp.json()["id"]}


async def test_an_archived_spaces_content_is_still_found(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], LONG.format(word="inventory"))
    resp = await client.post(f"/wiki/spaces/{s['space']['key']}/archive", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    hits = await _search(client, s["viewer"], "inventory")
    assert [h["node"]["id"] for h in hits] == [folder["id"]]


async def test_every_live_node_has_a_search_vector(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _create(client, s["owner"], s["space"], "Page", kind="page", parent=folder)
    await _create(client, s["owner"], s["space"], "Imported", kind="page",
                  initial_content=_doc("from a file"))
    await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["owner"],
                      json={"parent_id": None})
    await publish_via_api(client, s["owner"], page["id"])
    db.expire_all()
    missing = (await db.scalars(select(WikiNode.title).where(
        WikiNode.deleted_at.is_(None), WikiNode.search_tsv.is_(None)))).all()
    assert missing == []


# ── huge texts (final review I4) ────────────────────────────────────


def _unique_tokens(n: int) -> str:
    """~33 bytes per token of text Postgres can't compress into fewer
    lexemes — about 1 MB for 30,000 tokens, past tsvector's 1 MB cap."""
    return " ".join(hashlib.md5(str(i).encode()).hexdigest() for i in range(n))


async def test_a_file_with_a_huge_extract_stays_indexable(client, db):
    s = await _setup(client, db)
    text = "zeppelin " + _unique_tokens(30_000)
    file = await _create_file_via_db(db, s["space"], "big.log", text_extract=text)
    await wiki_search.refresh_search(db, uuid.UUID(file["id"]))
    await db.commit()
    hits = await _search(client, s["owner"], "zeppelin")
    assert [h["node"]["id"] for h in hits] == [file["id"]]


async def test_a_huge_page_still_publishes(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Huge", kind="page")
    await _set_draft(db, page["id"], _doc("dirigible " + _unique_tokens(30_000)))
    await publish_via_api(client, s["owner"], page["id"])
    hits = await _search(client, s["owner"], "dirigible")
    assert [h["node"]["id"] for h in hits] == [page["id"]]


async def test_stray_control_characters_never_become_marks(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Odd", kind="page")
    await _set_draft(db, page["id"], _doc("alpha \x02beta\x03 gamma"))
    await publish_via_api(client, s["owner"], page["id"])
    hits = await _search(client, s["owner"], "gamma")
    assert hits[0]["snippet_html"].count("<mark>") == 1
    assert "<mark>gamma</mark>" in hits[0]["snippet_html"]


async def test_an_overflowing_body_falls_back_to_a_shorter_index(client, db, monkeypatch):
    """Even a capped body can overflow a tsvector (unique single-character
    tokens cost more than their text): the index is retried shorter,
    never raised."""
    monkeypatch.setattr(wiki_search, "SEARCH_BODY_CHARS", 2_000_000)
    s = await _setup(client, db)
    file = await _create_file_via_db(db, s["space"], "huge.csv",
                                     text_extract="airship " + _unique_tokens(30_000))
    await wiki_search.refresh_search(db, uuid.UUID(file["id"]))
    await db.commit()
    hits = await _search(client, s["owner"], "airship")
    assert [h["node"]["id"] for h in hits] == [file["id"]]


async def test_backfill_indexes_nodes_created_before_every_node_was(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], LONG.format(word="manifest"))
    await db.execute(sa_update(WikiNode).where(WikiNode.id == uuid.UUID(folder["id"]))
                     .values(search_tsv=None))
    await db.commit()
    assert await _search(client, s["owner"], "manifest") == []

    assert await wiki_search.backfill_search_vectors(db) >= 1
    await db.commit()
    hits = await _search(client, s["owner"], "manifest")
    assert [h["node"]["id"] for h in hits] == [folder["id"]]
