"""Private items and "Allow printing" enforced outside the tree (spec
2026-09-30 §4–§5): public share links, help links, templates, exports,
downloads, and every listing that could name or count a private item.

Each listing test either failed before the enforcement change or already
passed because the listing goes through `AccessIndex`; the ones that
already passed stay as regression guards.

Storage presigning is pure local signing and runs for real; the export
worker tests use the worker suite's stand-ins (storage dict, renderer)."""
# the worker suite's fixtures are imported by name: unused as names here,
# and a test taking one "redefines" it
# ruff: noqa: F401, F811
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from serversherpa.db.models import (
    Notification,
    WikiFile,
    WikiFileVersion,
    WikiNode,
    WikiPageAsset,
    WikiPageView,
)
from serversherpa.wiki import share_links
from serversherpa.wiki.permissions import ANONYMOUS, AccessIndex
from tests import test_wiki_export_worker as worker_tests
from tests.test_wiki_export_worker import renderer, service_token, store
from tests.wiki_helpers import _create, _setup, login_as, publish_via_api, publish_via_db


@pytest.fixture(autouse=True)
def _fresh_limiter():
    share_links.public_limiter.reset()
    yield
    share_links.public_limiter.reset()


# ── helpers ─────────────────────────────────────────────────────────


def _code(resp):
    return resp.json()["detail"]["code"]


async def _private(client, headers, node_id, value=True):
    resp = await client.patch(f"/wiki/nodes/{node_id}/privacy", headers=headers,
                              json={"is_private": value})
    assert resp.status_code == 200, resp.text


async def _printing(client, headers, node_id, value):
    resp = await client.patch(f"/wiki/nodes/{node_id}/printing", headers=headers,
                              json={"allow_printing": value})
    assert resp.status_code == 200, resp.text


async def _developer(client, db, roles=("staff", "developer")):
    return (await login_as(client, db, roles=roles))[0]


async def _page(client, s, db, title="Guide", publish=True, parent=None):
    page = await _create(client, s["owner"], s["space"], title, kind="page", parent=parent)
    if publish:
        await publish_via_db(db, page["id"])
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


# ── share links ─────────────────────────────────────────────────────


async def _allow_links(client, s):
    resp = await client.patch(f"/wiki/spaces/{s['space']['key']}", headers=s["owner"],
                              json={"settings": {"allow_public_links": True}})
    assert resp.status_code == 200, resp.text


async def _share(client, headers, node_id):
    return await client.post(f"/wiki/nodes/{node_id}/share-links", headers=headers, json={})


async def _public(client, resp_or_token):
    token = (resp_or_token.json()["url"].rsplit("/p/", 1)[1]
             if hasattr(resp_or_token, "json") else resp_or_token)
    return await client.get(f"/wiki/public/{token}")


async def test_a_private_page_gets_no_share_link(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    page = await _page(client, s, db)
    await _private(client, s["owner"], page["id"])
    resp = await _share(client, s["owner"], page["id"])
    assert resp.status_code == 422
    assert _code(resp) == "private"


async def test_a_page_inside_a_private_folder_gets_no_share_link(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    await _private(client, s["owner"], folder["id"])
    resp = await _share(client, s["owner"], page["id"])
    assert resp.status_code == 422
    assert _code(resp) == "private"


async def test_a_page_with_printing_off_gets_no_share_link(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    page = await _page(client, s, db)
    await _printing(client, s["owner"], page["id"], False)
    resp = await _share(client, s["owner"], page["id"])
    assert resp.status_code == 422
    assert _code(resp) == "printing_disabled"


async def test_a_developer_gets_no_share_link_for_a_private_page_either(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    page = await _page(client, s, db)
    await _private(client, s["owner"], page["id"])
    dev = await _developer(client, db)
    resp = await _share(client, dev, page["id"])
    assert resp.status_code == 422
    assert _code(resp) == "private"


async def test_an_existing_link_is_404_while_the_page_is_private_and_works_again(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    page = await _page(client, s, db)
    created = await _share(client, s["owner"], page["id"])
    assert created.status_code == 201, created.text
    assert (await _public(client, created)).status_code == 200

    await _private(client, s["owner"], page["id"])
    assert (await _public(client, created)).status_code == 404
    await _private(client, s["owner"], page["id"], False)
    assert (await _public(client, created)).status_code == 200


async def test_an_existing_link_is_404_while_an_ancestor_folder_is_private(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    created = await _share(client, s["owner"], page["id"])
    assert (await _public(client, created)).status_code == 200

    await _private(client, s["owner"], folder["id"])
    assert (await _public(client, created)).status_code == 404
    await _private(client, s["owner"], folder["id"], False)
    assert (await _public(client, created)).status_code == 200


async def test_an_existing_link_is_404_while_printing_is_off_and_works_again(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    created = await _share(client, s["owner"], page["id"])

    await _printing(client, s["owner"], folder["id"], False)     # inherited by the page
    assert (await _public(client, created)).status_code == 404
    await _printing(client, s["owner"], page["id"], True)        # the page turns it back on
    assert (await _public(client, created)).status_code == 200
    await _printing(client, s["owner"], page["id"], None)
    assert (await _public(client, created)).status_code == 404
    await _printing(client, s["owner"], folder["id"], None)
    assert (await _public(client, created)).status_code == 200


async def test_a_shared_file_with_printing_off_is_404_and_its_urls_are_not_served(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    file_id = await _file(db, s)
    created = await _share(client, s["owner"], file_id)
    assert created.status_code == 201, created.text
    body = (await _public(client, created)).json()
    assert body["download_url"]

    await _printing(client, s["owner"], file_id, False)
    resp = await _public(client, created)
    assert resp.status_code == 404
    assert "download_url" not in resp.text


async def _admin_link_titles(client, headers):
    resp = await client.get("/wiki/share-links", headers=headers)
    assert resp.status_code == 200, resp.text
    return {row["node"]["title"] for row in resp.json()}


async def test_the_admin_link_list_leaves_out_a_private_page_s_link(client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    page = await _page(client, s, db, "Secret guide")
    folder = await _create(client, s["owner"], s["space"], "Folder")
    inside = await _page(client, s, db, "Inside guide", parent=folder)
    for node in (page, inside):
        assert (await _share(client, s["owner"], node["id"])).status_code == 201
    admin, _ = await login_as(client, db, roles=("admin",))
    assert await _admin_link_titles(client, admin) == {"Secret guide", "Inside guide"}

    await _private(client, s["owner"], page["id"])
    await _private(client, s["owner"], folder["id"])         # the ancestor counts too
    assert await _admin_link_titles(client, admin) == set()
    # a developer can see the pages, so their links are listed
    both = await _developer(client, db, roles=("admin", "developer"))
    assert await _admin_link_titles(client, both) == {"Secret guide", "Inside guide"}


async def test_the_admin_link_list_still_shows_an_admin_author_their_own_private_link(
        client, db):
    s = await _setup(client, db)
    await _allow_links(client, s)
    admin, _ = await login_as(client, db, roles=("admin",))
    page = await _create(client, admin, s["space"], "Admin's page", kind="page")
    await publish_via_db(db, page["id"])
    assert (await _share(client, admin, page["id"])).status_code == 201
    await _private(client, admin, page["id"])
    other_admin, _ = await login_as(client, db, roles=("admin",))

    assert await _admin_link_titles(client, admin) == {"Admin's page"}
    assert await _admin_link_titles(client, other_admin) == set()


# ── help links ──────────────────────────────────────────────────────


async def test_a_private_page_cannot_become_a_help_guide(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await _private(client, s["owner"], page["id"])
    both = await _developer(client, db, roles=("admin", "developer"))
    resp = await client.post("/wiki/help-links", headers=both, json={
        "context": "portal:/bulk/time", "node_id": page["id"]})
    assert resp.status_code == 422
    assert _code(resp) == "private"


async def test_help_for_a_page_that_became_private_is_404_for_who_cant_see_it(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    admin, _ = await login_as(client, db, roles=("admin",))
    resp = await client.post("/wiki/help-links", headers=admin, json={
        "context": "portal:/bulk/time", "node_id": page["id"]})
    assert resp.status_code == 201, resp.text
    ask = {"context": "portal:/bulk/time"}
    assert (await client.get("/wiki/help", headers=s["viewer"], params=ask)).status_code == 200

    await _private(client, s["owner"], page["id"])
    assert (await client.get("/wiki/help", headers=s["viewer"], params=ask)).status_code == 404
    assert (await client.get("/wiki/help", headers=admin, params=ask)).status_code == 404
    # the author still finds it
    assert (await client.get("/wiki/help", headers=s["owner"], params=ask)).status_code == 200


async def test_the_admin_help_link_list_leaves_out_a_private_guide(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db, "Secret guide")
    admin, _ = await login_as(client, db, roles=("admin",))
    resp = await client.post("/wiki/help-links", headers=admin, json={
        "context": "portal:/bulk/time", "node_id": page["id"]})
    assert resp.status_code == 201, resp.text

    async def titles(headers):
        resp = await client.get("/wiki/help-links", headers=headers)
        assert resp.status_code == 200, resp.text
        return {row["node"]["title"] for row in resp.json()}

    assert await titles(admin) == {"Secret guide"}
    await _private(client, s["owner"], page["id"])
    assert await titles(admin) == set()
    both = await _developer(client, db, roles=("admin", "developer"))
    assert await titles(both) == {"Secret guide"}


async def test_the_admin_help_link_list_still_shows_an_admin_author_their_own_guide(
        client, db):
    s = await _setup(client, db)
    admin, _ = await login_as(client, db, roles=("admin",))
    page = await _create(client, admin, s["space"], "Admin's guide", kind="page")
    await publish_via_db(db, page["id"])
    resp = await client.post("/wiki/help-links", headers=admin, json={
        "context": "portal:/bulk/time", "node_id": page["id"]})
    assert resp.status_code == 201, resp.text
    await _private(client, admin, page["id"])

    resp = await client.get("/wiki/help-links", headers=admin)
    assert [row["node"]["title"] for row in resp.json()] == ["Admin's guide"]
    other_admin, _ = await login_as(client, db, roles=("admin",))
    assert (await client.get("/wiki/help-links", headers=other_admin)).json() == []


# ── templates ───────────────────────────────────────────────────────


async def test_a_private_page_cannot_be_saved_as_a_template(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    body = {"space_id": s["space"]["id"], "name": "From page", "from_node_id": page["id"]}
    resp = await client.post("/wiki/templates", headers=s["owner"], json=body)
    assert resp.status_code == 201, resp.text

    await _private(client, s["owner"], page["id"])
    resp = await client.post("/wiki/templates", headers=s["owner"],
                             json={**body, "name": "From private"})
    assert resp.status_code == 422
    assert _code(resp) == "private"


async def test_a_page_with_printing_off_cannot_be_saved_as_a_template(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    body = {"space_id": s["space"]["id"], "name": "From page", "from_node_id": page["id"]}
    await _printing(client, s["owner"], page["id"], False)
    resp = await client.post("/wiki/templates", headers=s["owner"], json=body)
    assert resp.status_code == 422
    assert _code(resp) == "printing_disabled"

    # turned back on (inherit), it can be
    await _printing(client, s["owner"], page["id"], None)
    resp = await client.post("/wiki/templates", headers=s["owner"], json=body)
    assert resp.status_code == 201, resp.text


async def test_a_page_under_a_printing_off_folder_cannot_be_saved_as_a_template(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    await _printing(client, s["owner"], folder["id"], False)
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "From page", "from_node_id": page["id"]})
    assert resp.status_code == 422
    assert _code(resp) == "printing_disabled"


# ── exports: the request ────────────────────────────────────────────


async def test_exporting_a_page_with_printing_off_is_refused(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await _printing(client, s["owner"], page["id"], False)
    resp = await client.post("/wiki/exports", headers=s["owner"],
                             json={"node_id": page["id"], "format": "pdf"})
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"


async def test_no_one_is_exempt_from_the_export_refusal(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await _printing(client, s["owner"], page["id"], False)
    for headers in (await _developer(client, db),
                    (await login_as(client, db, roles=("admin",)))[0]):
        resp = await client.post("/wiki/exports", headers=headers,
                                 json={"node_id": page["id"], "format": "md"})
        assert resp.status_code == 403, resp.text
        assert _code(resp) == "printing_disabled"


async def test_a_hidden_never_published_page_is_404_not_printing_disabled(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db, publish=False)
    await _printing(client, s["owner"], page["id"], False)
    body = {"node_id": page["id"], "format": "pdf"}
    # view-only: the page doesn't exist for them, so printing isn't mentioned
    resp = await client.post("/wiki/exports", headers=s["viewer"], json=body)
    assert resp.status_code == 404, resp.text
    # anyone who can see it is told why
    resp = await client.post("/wiki/exports", headers=s["editor"], json=body)
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"


async def test_exporting_a_folder_with_printing_off_is_refused(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    await _printing(client, s["owner"], folder["id"], False)
    resp = await client.post("/wiki/exports", headers=s["owner"],
                             json={"node_id": folder["id"], "format": "zip"})
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"


# ── exports: the zip builder ────────────────────────────────────────


async def _zip_tree(client, db, store, s):
    """Runbooks/ holding A (printable), B (printing off, its subpage C turns
    it back on), U (never published) and manual.pdf (printing off)."""
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    a = await _page(client, s, db, "A", parent=folder)
    b = await _page(client, s, db, "B", parent=folder)
    c = await _page(client, s, db, "C", parent=b)
    u = await _page(client, s, db, "U", publish=False, parent=folder)
    manual = await worker_tests._file(db, store, s, folder)
    await _printing(client, s["owner"], b["id"], False)
    await _printing(client, s["owner"], c["id"], True)
    await _printing(client, s["owner"], str(manual.id), False)
    return {"folder": folder, "a": a, "b": b, "c": c, "u": u, "manual": manual}


async def test_a_zip_leaves_out_what_cannot_be_printed_and_says_so(client, db, store, renderer):
    s = await _setup(client, db)
    t = await _zip_tree(client, db, store, s)

    job = await worker_tests._run(db, await worker_tests._request(
        client, s["viewer"], node_id=t["folder"]["id"], format="zip", zip_format="md"))

    assert job.status == "done", job.error
    zf = worker_tests._zip(store)
    assert sorted(zf.namelist()) == ["Runbooks/", "Runbooks/A.md", "Runbooks/B/C.md",
                                     "_skipped.txt"]
    # the viewer never sees the never-published U, so it isn't named
    assert zf.read("_skipped.txt").decode() == (
        "These items were left out because printing is turned off for them:\n\n"
        "Runbooks/B\nRunbooks/manual.pdf\n")
    assert job.result["unprintable"] == 2


async def test_the_skip_list_keeps_unpublished_pages_and_printing_off_apart(
        client, db, store, renderer):
    s = await _setup(client, db)
    t = await _zip_tree(client, db, store, s)

    job = await worker_tests._run(db, await worker_tests._request(
        client, s["editor"], node_id=t["folder"]["id"], format="zip", zip_format="md"))

    assert job.status == "done", job.error
    zf = worker_tests._zip(store)
    assert zf.namelist().count("_skipped.txt") == 1
    assert zf.read("_skipped.txt").decode() == (
        "These pages were left out because they have never been published:\n\n"
        "Runbooks/U\n\n"
        "These items were left out because printing is turned off for them:\n\n"
        "Runbooks/B\nRunbooks/manual.pdf\n")


async def test_printing_off_binds_a_developer_s_zip_too(client, db, store, renderer):
    s = await _setup(client, db)
    t = await _zip_tree(client, db, store, s)
    dev = await _developer(client, db)

    job = await worker_tests._run(db, await worker_tests._request(
        client, dev, node_id=t["folder"]["id"], format="zip", zip_format="md"))

    assert job.status == "done", job.error
    assert "Runbooks/manual.pdf" not in worker_tests._zip(store).namelist()


async def test_a_private_page_is_absent_from_someone_elses_zip_without_a_trace(
        client, db, store, renderer):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    await _page(client, s, db, "Visible", parent=folder)
    secret = await _page(client, s, db, "Secret", parent=folder)
    await _private(client, s["owner"], secret["id"])

    job = await worker_tests._run(db, await worker_tests._request(
        client, s["editor"], node_id=folder["id"], format="zip", zip_format="md"))

    assert job.status == "done", job.error
    zf = worker_tests._zip(store)
    assert sorted(zf.namelist()) == ["Runbooks/", "Runbooks/Visible.md"]

    # the author's own export has it
    store.uploads.clear()
    job = await worker_tests._run(db, await worker_tests._request(
        client, s["owner"], node_id=folder["id"], format="zip", zip_format="md"))
    assert job.status == "done", job.error
    assert "Runbooks/Secret.md" in worker_tests._zip(store).namelist()


async def test_a_page_export_fails_when_printing_was_turned_off_after_the_request(
        client, db, store, renderer):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    job_id = await worker_tests._request(client, s["owner"], node_id=page["id"], format="md")
    await _printing(client, s["owner"], page["id"], False)

    job = await worker_tests._run(db, job_id)

    assert job.status == "failed"
    assert "Printing is turned off" in job.result["message"]
    assert not store.uploads


async def test_a_finished_export_is_refused_once_printing_is_turned_off(
        client, db, store, renderer):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    job_id = await worker_tests._request(client, s["owner"], node_id=page["id"], format="md")
    job = await worker_tests._run(db, job_id)
    assert job.status == "done", job.error
    resp = await client.get(f"/wiki/exports/{job_id}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["url"]

    await _printing(client, s["owner"], page["id"], False)
    resp = await client.get(f"/wiki/exports/{job_id}", headers=s["owner"])
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"
    await _printing(client, s["owner"], page["id"], None)
    assert (await client.get(f"/wiki/exports/{job_id}", headers=s["owner"])).status_code == 200


# ── downloads ───────────────────────────────────────────────────────


async def _url(client, headers, file_id, **params):
    return await client.get(f"/wiki/files/{file_id}/url", headers=headers, params=params)


async def test_downloads_are_refused_while_printing_is_off_and_previews_are_not(client, db):
    s = await _setup(client, db)
    file_id = await _file(db, s)
    version_id = (await db.get(WikiFile, file_id)).current_version_id
    assert (await _url(client, s["viewer"], file_id)).status_code == 200

    await _printing(client, s["owner"], file_id, False)
    for params in ({}, {"disposition": "attachment"},
                   {"disposition": "attachment", "version_id": str(version_id)}):
        resp = await _url(client, s["viewer"], file_id, **params)
        assert resp.status_code == 403, resp.text
        assert _code(resp) == "printing_disabled"
    # the in-browser preview keeps working
    assert (await _url(client, s["viewer"], file_id, disposition="inline")).status_code == 200
    assert (await _url(client, s["viewer"], file_id, disposition="inline",
                       version_id=str(version_id))).status_code == 200


async def test_an_inline_request_that_can_only_be_an_attachment_is_a_download(client, db):
    s = await _setup(client, db)
    file_id = await _file(db, s, filename="bundle.zip", content_type="application/zip",
                          preview_kind="none")
    assert (await _url(client, s["viewer"], file_id, disposition="inline")).status_code == 200
    await _printing(client, s["owner"], file_id, False)
    resp = await _url(client, s["viewer"], file_id, disposition="inline")
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"


async def test_no_one_is_exempt_from_the_download_refusal(client, db):
    s = await _setup(client, db)
    file_id = await _file(db, s)
    await _printing(client, s["owner"], file_id, False)
    admin_dev = await _developer(client, db, roles=("admin", "developer"))
    for headers in (s["owner"], admin_dev):
        resp = await _url(client, headers, file_id, disposition="attachment")
        assert resp.status_code == 403, resp.text
        assert _code(resp) == "printing_disabled"


async def test_a_file_under_a_folder_with_printing_off_cannot_be_downloaded(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    file_id = await _file(db, s)
    node = await db.get(WikiNode, file_id)
    node.parent_id = uuid.UUID(folder["id"])
    node.path = [uuid.UUID(folder["id"])]
    await db.commit()
    await _printing(client, s["owner"], folder["id"], False)
    resp = await _url(client, s["viewer"], file_id, disposition="attachment")
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"


async def _asset(db, page, filename, content_type):
    asset = WikiPageAsset(node_id=uuid.UUID(page["id"]), storage_key=f"wiki/x/{filename}",
                          filename=filename, content_type=content_type, size_bytes=10)
    db.add(asset)
    await db.commit()
    return str(asset.id)


async def test_page_assets_with_printing_off_get_no_attachment_urls(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    ids = {
        "zip": await _asset(db, page, "bundle.zip", "application/zip"),
        "docx": await _asset(db, page, "plan.docx", "application/vnd.openxmlformats-"
                             "officedocument.wordprocessingml.document"),
        "png": await _asset(db, page, "pic.png", "image/png"),
        "pdf": await _asset(db, page, "manual.pdf", "application/pdf"),
    }

    async def urls():
        resp = await client.post("/wiki/assets/urls", headers=s["viewer"],
                                 json={"ids": list(ids.values())})
        assert resp.status_code == 200, resp.text
        return {name for name, asset_id in ids.items() if asset_id in resp.json()["urls"]}

    assert await urls() == {"zip", "docx", "png", "pdf"}
    await _printing(client, s["owner"], page["id"], False)
    # the inline-previewable ones stay; the downloads don't
    assert await urls() == {"png", "pdf"}
    await _printing(client, s["owner"], page["id"], None)
    assert await urls() == {"zip", "docx", "png", "pdf"}


# ── copy and move never turn printing on ────────────────────────────


async def _copy(client, headers, node_id, parent_id=None):
    resp = await client.post(f"/wiki/nodes/{node_id}/copy", headers=headers,
                             json={"parent_id": parent_id})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _export_code(client, headers, node_id):
    resp = await client.post("/wiki/exports", headers=headers,
                             json={"node_id": node_id, "format": "md"})
    return resp.status_code, (_code(resp) if resp.status_code != 202 else None)


async def test_a_copy_of_a_printing_off_page_cannot_be_exported(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await _printing(client, s["owner"], page["id"], False)
    copy = await _copy(client, s["owner"], page["id"])
    await publish_via_db(db, copy["id"])
    assert copy["allow_printing"] is False
    assert await _export_code(client, s["owner"], copy["id"]) == (403, "printing_disabled")


async def test_a_copy_of_a_page_in_a_printing_off_folder_cannot_be_exported(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    await _printing(client, s["owner"], folder["id"], False)
    # copied out to the library root, where nothing turns printing off
    copy = await _copy(client, s["editor"], page["id"])
    await publish_via_db(db, copy["id"])
    assert copy["allow_printing"] is False
    assert await _export_code(client, s["owner"], copy["id"]) == (403, "printing_disabled")


async def test_a_copied_folder_keeps_each_items_own_printing_value(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    on = await _page(client, s, db, "On", parent=folder)
    off = await _page(client, s, db, "Off", parent=folder)
    plain = await _page(client, s, db, "Plain", parent=folder)
    await _printing(client, s["owner"], off["id"], False)
    await _printing(client, s["owner"], on["id"], True)
    copy = await _copy(client, s["owner"], folder["id"])
    assert copy["allow_printing"] is None                     # the source's own value

    rows = (await db.scalars(select(WikiNode).where(
        WikiNode.parent_id == uuid.UUID(copy["id"])).execution_options(
            populate_existing=True))).all()
    assert {r.title: r.allow_printing for r in rows} == {"On": True, "Off": False, "Plain": None}
    # and what each can do follows: the copy of Plain inherits "allowed"
    # from the copied folder, as Plain does from its own
    effective = {}
    for r in rows:
        resp = await client.get(f"/wiki/nodes/{r.id}", headers=s["owner"])
        assert resp.status_code == 200, resp.text
        effective[r.title] = resp.json()["can_print"]
    assert effective == {"On": True, "Off": False, "Plain": True}
    resp = await client.get(f"/wiki/nodes/{plain['id']}", headers=s["owner"])
    assert resp.json()["can_print"] is True


async def test_moving_a_page_out_of_a_printing_off_folder_leaves_printing_off(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    await _printing(client, s["owner"], folder["id"], False)
    assert await _export_code(client, s["owner"], page["id"]) == (403, "printing_disabled")

    resp = await client.post(f"/wiki/nodes/{page['id']}/move", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["allow_printing"] is False
    assert await _export_code(client, s["owner"], page["id"]) == (403, "printing_disabled")


async def test_moving_a_page_with_printing_on_changes_nothing_about_printing(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s, db, parent=folder)
    resp = await client.post(f"/wiki/nodes/{page['id']}/move", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["allow_printing"] is None
    assert (await _export_code(client, s["owner"], page["id"]))[0] == 202


# ── listings: a private item is invisible to a non-author ───────────
#
# `_hidden_page`: a published page the owner authored — each test makes it
# private after the other people have had dealings with it.


async def _hidden_page(client, db, s, title="Quokka handbook"):
    return await _page(client, s, db, title)


async def test_search_quick_and_full_leave_out_a_private_page(client, db):
    s = await _setup(client, db)
    page = await _hidden_page(client, db, s)
    admin, _ = await login_as(client, db, roles=("admin",))
    dev = await _developer(client, db)

    async def found(headers, **params):
        resp = await client.get("/wiki/search", headers=headers,
                                params={"q": "Quokka handbook", "log": "false", **params})
        assert resp.status_code == 200, resp.text
        return [h["node"]["id"] for h in resp.json()]

    for headers in (s["viewer"], admin):
        assert page["id"] in await found(headers)
    await _private(client, s["owner"], page["id"])
    for headers in (s["viewer"], s["editor"], admin):
        assert await found(headers) == []
        assert await found(headers, limit=5, space=s["space"]["key"]) == []
    for headers in (s["owner"], dev):
        assert page["id"] in await found(headers)


async def test_recently_updated_leaves_out_a_private_page(client, db):
    s = await _setup(client, db)
    page = await _hidden_page(client, db, s)
    admin, _ = await login_as(client, db, roles=("admin",))

    async def recent(headers, **params):
        resp = await client.get("/wiki/recent", headers=headers, params=params)
        assert resp.status_code == 200, resp.text
        return [n["id"] for n in resp.json()]

    assert page["id"] in await recent(s["viewer"])
    await _private(client, s["owner"], page["id"])
    for headers in (s["viewer"], s["editor"], admin):
        assert page["id"] not in await recent(headers)
    for headers in (s["viewer"], s["editor"]):
        assert page["id"] not in await recent(headers, space=s["space"]["key"])
    assert page["id"] in await recent(s["owner"])


async def test_drafts_leave_out_a_page_that_became_private(client, db):
    s = await _setup(client, db)
    page = await _hidden_page(client, db, s)
    resp = await client.put(f"/wiki/nodes/{page['id']}/draft", headers=s["editor"], json={
        "content_json": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "edit"}]}]}})
    assert resp.status_code == 204, resp.text
    resp = await client.get("/wiki/drafts", headers=s["editor"])
    assert [n["id"] for n in resp.json()] == [page["id"]]

    await _private(client, s["owner"], page["id"])
    resp = await client.get("/wiki/drafts", headers=s["editor"])
    assert resp.status_code == 200
    assert resp.json() == []


async def test_favorites_leave_out_a_page_that_became_private(client, db):
    s = await _setup(client, db)
    page = await _hidden_page(client, db, s)
    resp = await client.put(f"/wiki/nodes/{page['id']}/favorite", headers=s["viewer"])
    assert resp.status_code == 204
    assert [n["id"] for n in (await client.get(
        "/wiki/favorites", headers=s["viewer"])).json()] == [page["id"]]

    await _private(client, s["owner"], page["id"])
    assert (await client.get("/wiki/favorites", headers=s["viewer"])).json() == []
    # and it can no longer be favorited by someone who can't see it
    resp = await client.put(f"/wiki/nodes/{page['id']}/favorite", headers=s["editor"])
    assert resp.status_code == 404


async def test_the_watching_list_leaves_out_a_page_that_became_private(client, db):
    s = await _setup(client, db)
    page = await _hidden_page(client, db, s)
    resp = await client.put("/wiki/watches", headers=s["viewer"],
                            json={"node_id": page["id"]})
    assert resp.status_code == 200, resp.text
    assert len((await client.get("/wiki/watches", headers=s["viewer"])).json()) == 1

    await _private(client, s["owner"], page["id"])
    assert (await client.get("/wiki/watches", headers=s["viewer"])).json() == []
    # the row stays: it works again once the page is public
    await _private(client, s["owner"], page["id"], False)
    assert len((await client.get("/wiki/watches", headers=s["viewer"])).json()) == 1


async def _view(client, headers, node_id):
    resp = await client.post(f"/wiki/nodes/{node_id}/view", headers=headers)
    assert resp.status_code == 204, resp.text


async def _analytics(client, headers, **params):
    resp = await client.get("/wiki/analytics", headers=headers,
                            params={"days": 30, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_analytics_never_counts_or_names_a_private_page(client, db):
    s = await _setup(client, db)
    open_page = await _hidden_page(client, db, s, "Open page")
    secret = await _hidden_page(client, db, s, "Secret page")
    for page in (open_page, secret):
        await _view(client, s["viewer"], page["id"])
        await _view(client, s["editor"], page["id"])
    # stale (untouched for two years) and overdue for review
    old = datetime.now(UTC) - timedelta(days=730)
    await db.execute(update(WikiNode).where(WikiNode.id.in_(
        [uuid.UUID(open_page["id"]), uuid.UUID(secret["id"])])).values(
            updated_at=old, review_interval_months=6,
            next_review_at=datetime.now(UTC) - timedelta(days=3)))
    await db.commit()
    admin, _ = await login_as(client, db, roles=("admin",))

    before = await _analytics(client, admin)
    assert sum(d["views"] for d in before["views_by_day"]) == 4
    assert {n["node"]["id"] for n in before["top_pages"]} == {open_page["id"], secret["id"]}

    await _private(client, s["owner"], secret["id"])

    after = await _analytics(client, admin)
    assert sum(d["views"] for d in after["views_by_day"]) == 2
    for section in ("top_pages", "stale_pages", "overdue_reviews"):
        ids = {row["node"]["id"] for row in after[section]}
        assert ids == {open_page["id"]}, section
    assert secret["id"] not in str(after)

    # the author's numbers still include it
    mine = await _analytics(client, s["owner"], space=s["space"]["key"])
    assert sum(d["views"] for d in mine["views_by_day"]) == 4
    assert {n["node"]["id"] for n in mine["top_pages"]} == {open_page["id"], secret["id"]}


async def test_analytics_counts_stay_correct_for_a_developer(client, db):
    s = await _setup(client, db)
    secret = await _hidden_page(client, db, s, "Secret page")
    await _view(client, s["viewer"], secret["id"])
    await _private(client, s["owner"], secret["id"])
    dev = await _developer(client, db, roles=("admin", "developer"))
    body = await _analytics(client, dev)
    assert sum(d["views"] for d in body["views_by_day"]) == 1
    assert [n["node"]["id"] for n in body["top_pages"]] == [secret["id"]]


async def test_the_library_trash_leaves_out_a_private_item(client, db):
    s = await _setup(client, db)
    open_page = await _hidden_page(client, db, s, "Open page")
    secret = await _hidden_page(client, db, s, "Secret page")
    await _private(client, s["owner"], secret["id"])
    for page in (open_page, secret):
        resp = await client.delete(f"/wiki/nodes/{page['id']}", headers=s["owner"])
        assert resp.status_code == 200, resp.text
    admin, _ = await login_as(client, db, roles=("admin",))

    async def trash(headers):
        resp = await client.get(f"/wiki/spaces/{s['space']['key']}/trash", headers=headers)
        assert resp.status_code == 200, resp.text
        return resp.json()

    assert {b["root"]["title"] for b in await trash(s["owner"])} == {
        "Open page", "Secret page"}
    assert {b["root"]["title"] for b in await trash(admin)} == {"Open page"}
    # nor can the admin restore or purge it by batch id
    batch_id = next(b["batch_id"] for b in await trash(s["owner"])
                    if b["root"]["title"] == "Secret page")
    resp = await client.post(f"/wiki/trash/{batch_id}/restore", headers=admin)
    assert resp.status_code == 404
    resp = await client.delete(f"/wiki/trash/{batch_id}", headers=admin)
    assert resp.status_code == 404
    resp = await client.post(f"/wiki/trash/{batch_id}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text


async def test_a_trash_batch_counts_and_purges_only_what_the_caller_can_see(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    await _page(client, s, db, "Open", parent=folder)
    secret = await _page(client, s, db, "Secret", parent=folder)
    await _private(client, s["owner"], secret["id"])
    resp = await client.delete(f"/wiki/nodes/{folder['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    admin, _ = await login_as(client, db, roles=("admin",))

    async def batches(headers):
        resp = await client.get(f"/wiki/spaces/{s['space']['key']}/trash", headers=headers)
        assert resp.status_code == 200, resp.text
        return resp.json()

    [mine] = await batches(s["owner"])
    [theirs] = await batches(admin)
    assert (mine["count"], theirs["count"]) == (3, 2)        # the folder, Open, Secret

    # forever-deleting it would destroy what the admin can't see — as live delete refuses
    resp = await client.delete(f"/wiki/trash/{theirs['batch_id']}", headers=admin)
    assert resp.status_code == 409, resp.text
    assert _code(resp) == "hidden_items"
    resp = await client.delete(f"/wiki/trash/{mine['batch_id']}", headers=s["owner"])
    assert resp.status_code == 204, resp.text


async def test_due_for_review_leaves_out_a_private_page(client, db):
    s = await _setup(client, db)
    open_page = await _hidden_page(client, db, s, "Open page")
    secret = await _hidden_page(client, db, s, "Secret page")
    await db.execute(update(WikiNode).where(WikiNode.id.in_(
        [uuid.UUID(open_page["id"]), uuid.UUID(secret["id"])])).values(
            review_interval_months=6,
            next_review_at=datetime.now(UTC) + timedelta(days=3)))
    await db.commit()
    await _private(client, s["owner"], secret["id"])

    async def due(headers):
        resp = await client.get(f"/wiki/spaces/{s['space']['key']}/due-reviews",
                                headers=headers)
        assert resp.status_code == 200, resp.text
        return {n["id"] for n in resp.json()}

    assert await due(s["viewer"]) == {open_page["id"]}
    assert await due(s["owner"]) == {open_page["id"], secret["id"]}


async def test_mention_candidates_for_a_private_page_are_the_author_and_developers(
        client, db):
    s = await _setup(client, db)
    page = await _hidden_page(client, db, s)
    dev, dev_id = await login_as(client, db, roles=("staff", "developer"))

    async def candidates(headers):
        resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable", headers=headers,
                                params={"q": "Tester"})
        assert resp.status_code == 200, resp.text
        return {p["id"] for p in resp.json()}

    open_now = await candidates(s["owner"])
    assert {str(s["editor_id"]), str(s["viewer_id"]), str(dev_id)} <= open_now

    await _private(client, s["owner"], page["id"])
    assert await candidates(s["owner"]) == {str(dev_id)}
    # the author is offered to a developer, and no one else can ask at all
    assert str(s["owner_id"]) in await candidates(dev)
    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable", headers=s["editor"],
                            params={"q": "Tester"})
    assert resp.status_code == 404


async def test_publishing_a_private_page_notifies_no_watcher_but_developers(client, db):
    s = await _setup(client, db)
    dev, dev_id = await login_as(client, db, roles=("staff", "developer"))
    for headers in (s["viewer"], s["editor"], dev):
        resp = await client.put("/wiki/watches", headers=headers,
                                json={"space_id": s["space"]["id"]})
        assert resp.status_code == 200, resp.text
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await _private(client, s["owner"], page["id"])
    resp = await client.put(f"/wiki/nodes/{page['id']}/draft", headers=s["owner"], json={
        "content_json": {"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "v1"}]}]}})
    assert resp.status_code == 204, resp.text

    await publish_via_api(client, s["owner"], page["id"], note="First")

    async def inbox(person_id):
        # the page's creation was announced to the space's watchers while it
        # was still public; the publish is what this test is about
        rows = (await db.scalars(select(Notification).where(
            Notification.person_id == person_id,
            Notification.kind == "wiki_update"))).all()
        return [n for n in rows if n.payload["event"] == "published"]

    assert await inbox(s["viewer_id"]) == []
    assert await inbox(s["editor_id"]) == []
    assert len(await inbox(dev_id)) == 1


# ── the shared helpers ──────────────────────────────────────────────


async def test_is_private_reads_the_node_and_its_ancestors_the_same_for_anyone(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    child = await _page(client, s, db, "Child", parent=folder)
    other = await _page(client, s, db, "Other")
    await _private(client, s["owner"], folder["id"])
    ix = AccessIndex(db, ANONYMOUS)
    rows = {n["id"]: await db.get(WikiNode, uuid.UUID(n["id"]), populate_existing=True)
            for n in (folder, child, other)}
    assert await ix.is_private(rows[folder["id"]]) is True
    assert await ix.is_private(rows[child["id"]]) is True
    assert await ix.is_private(rows[other["id"]]) is False


async def test_a_view_row_for_a_private_page_is_not_counted_for_a_reader(client, db):
    s = await _setup(client, db)
    secret = await _hidden_page(client, db, s, "Secret page")
    db.add(WikiPageView(node_id=uuid.UUID(secret["id"]), person_id=s["viewer_id"],
                        viewed_on=datetime.now(UTC).date(), count=5))
    await db.commit()
    await _private(client, s["owner"], secret["id"])
    admin, _ = await login_as(client, db, roles=("admin",))
    body = await _analytics(client, admin)
    assert sum(d["views"] for d in body["views_by_day"]) == 0
