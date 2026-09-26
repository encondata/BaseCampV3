"""Help links (Phase 3, spec §8): context normalization and matching
(`serversherpa.wiki.help`), `GET /wiki/help?context=` (longest stored
prefix, 404 unless the caller can view the guide), and the wiki-admin
CRUD at `/wiki/help-links` (validation, 409 `context_taken`, audit)."""
import uuid

import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import AuditLog, Client, WikiFile, WikiHelpLink, WikiNode
from serversherpa.wiki.help import context_prefixes, is_valid_context, normalize_context
from tests.wiki_helpers import _create, _setup, login_as, publish_via_db

SITE_ID = "5f0c2a8e-3b1c-4c7e-9a55-1d2e3f405162"


# ── normalization and matching rules ─────────────────────────────────


@pytest.mark.parametrize(("raw", "expected"), [
    ("portal:/bulk/time", "portal:/bulk/time"),
    ("Portal:/Bulk/Time", "portal:/bulk/time"),
    ("portal:/bulk/time/", "portal:/bulk/time"),
    ("portal:/bulk/time?tab=history#top", "portal:/bulk/time"),
    ("portal:/bulk#top", "portal:/bulk"),
    ("portal://bulk///time//", "portal:/bulk/time"),
    ("portal:/", "portal:/"),
    ("portal://", "portal:/"),
    ("  kiosk:/enroll  ", "kiosk:/enroll"),
    (f"portal:/sites/{SITE_ID}", "portal:/sites/:id"),
    (f"portal:/sites/{SITE_ID.upper()}/edit", "portal:/sites/:id/edit"),
    ("portal:/assets/12345", "portal:/assets/:id"),
    ("portal:/assets/12a45", "portal:/assets/12a45"),
    ("portal:/sites/:id", "portal:/sites/:id"),
    ("bulk", "bulk"),
])
def test_normalize_context(raw, expected):
    assert normalize_context(raw) == expected


@pytest.mark.parametrize(("context", "ok"), [
    ("portal:/", True),
    ("portal:/bulk/time", True),
    ("kiosk:/enroll", True),
    ("portal:/sites/:id/edit", True),
    ("portal:/a_b-c9", True),
    ("web:/bulk", False),
    ("portal:bulk", False),
    ("portal", False),
    ("portal:/a b", False),
    ("portal:/a.b", False),
    ("portal:/" + "a" * 292, True),     # 300 characters
    ("portal:/" + "a" * 293, False),    # 301
])
def test_is_valid_context(context, ok):
    assert is_valid_context(context) is ok


def test_context_prefixes_stop_at_segment_boundaries():
    assert context_prefixes("portal:/bulk/time") == [
        "portal:/bulk/time", "portal:/bulk", "portal:/"]
    assert context_prefixes("portal:/") == ["portal:/"]
    assert context_prefixes("kiosk:/enroll") == ["kiosk:/enroll", "kiosk:/"]
    assert context_prefixes("bulk") == []
    assert context_prefixes("portal:bulk") == []


# ── fixtures ─────────────────────────────────────────────────────────


async def _admin(client, db):
    headers, _ = await login_as(client, db, roles=("admin",))
    return headers


async def _page(client, s, db, title="Time Guide", publish=True):
    page = await _create(client, s["owner"], s["space"], title, kind="page")
    if publish:
        await publish_via_db(db, page["id"])
    return page


async def _link(client, admin, context, node_id, expect=201):
    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": context, "node_id": str(node_id)})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _help(client, headers, context):
    return await client.get("/wiki/help", headers=headers, params={"context": context})


# ── GET /wiki/help ───────────────────────────────────────────────────


async def test_help_returns_the_linked_guide(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    await _link(client, admin, "portal:/bulk/time", page["id"])

    resp = await _help(client, s["viewer"], "portal:/bulk/time")
    assert resp.status_code == 200, resp.text
    origin = get_settings().wiki_origin.rstrip("/")
    assert resp.json() == {
        "node_id": page["id"], "title": "Time Guide",
        "url": f"{origin}/n/{page['id']}", "context": "portal:/bulk/time"}


async def test_help_longest_prefix_wins_at_segment_boundaries(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    bulk = await _page(client, s, db, "Bulk Guide")
    time = await _page(client, s, db, "Time Guide")
    await _link(client, admin, "portal:/bulk", bulk["id"])
    await _link(client, admin, "portal:/bulk/time", time["id"])

    async def title(context):
        resp = await _help(client, s["viewer"], context)
        return resp.json()["title"] if resp.status_code == 200 else resp.status_code

    assert await title("portal:/bulk/time") == "Time Guide"
    assert await title("portal:/bulk/time/review") == "Time Guide"
    assert await title("portal:/bulk/sites") == "Bulk Guide"
    assert await title("portal:/bulk") == "Bulk Guide"
    assert await title("portal:/bulkx") == 404
    assert await title("portal:/bulk-time") == 404
    assert await title("portal:/") == 404
    # the kiosk is its own namespace
    assert await title("kiosk:/bulk/time") == 404


async def test_help_root_link_covers_the_whole_app(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db, "Portal Guide")
    await _link(client, admin, "portal:/", page["id"])
    assert (await _help(client, s["viewer"], "portal:/assets")).json()["title"] == "Portal Guide"
    assert (await _help(client, s["viewer"], "portal:/")).json()["title"] == "Portal Guide"
    assert (await _help(client, s["viewer"], "kiosk:/assets")).status_code == 404


async def test_help_normalizes_the_requested_context(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db, "Site Guide")
    await _link(client, admin, "portal:/sites/:id", page["id"])

    for context in (f"portal:/sites/{SITE_ID}", f"portal:/Sites/{SITE_ID.upper()}/",
                    f"portal:/sites/{SITE_ID}?tab=assets#x", "portal:/sites/42",
                    f"portal:/sites/{SITE_ID}/people"):
        resp = await _help(client, s["viewer"], context)
        assert resp.status_code == 200, context
        assert resp.json()["context"] == "portal:/sites/:id"
    # a path with characters no stored context has still falls back to its prefixes
    assert (await _help(client, s["viewer"], "portal:/sites/:id/a.b")).status_code == 200
    assert (await _help(client, s["viewer"], "portal:/sites")).status_code == 404
    assert (await _help(client, s["viewer"], "sites")).status_code == 404


async def test_help_is_404_when_the_caller_cannot_view_the_guide(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db, "Internal Guide")
    await _link(client, admin, "portal:/assets", page["id"])

    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    outsider, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    resp = await _help(client, outsider, "portal:/assets")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"
    # everyone who can see it gets it
    assert (await _help(client, s["viewer"], "portal:/assets")).status_code == 200


async def test_help_hides_a_never_published_page_from_view_only(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    draft = await _page(client, s, db, "Draft Guide", publish=False)
    await _link(client, admin, "portal:/assets", draft["id"])

    assert (await _help(client, s["viewer"], "portal:/assets")).status_code == 404
    # an editor can see the draft
    assert (await _help(client, s["editor"], "portal:/assets")).status_code == 200
    await publish_via_db(db, draft["id"])
    assert (await _help(client, s["viewer"], "portal:/assets")).status_code == 200


async def test_help_is_404_for_a_trashed_guide(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    await _link(client, admin, "portal:/assets", page["id"])
    resp = await client.delete(f"/wiki/nodes/{page['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert (await _help(client, s["viewer"], "portal:/assets")).status_code == 404
    assert (await _help(client, admin, "portal:/assets")).status_code == 404


async def test_help_needs_a_context(client, db):
    s = await _setup(client, db)
    assert (await client.get("/wiki/help", headers=s["viewer"])).status_code == 422


# ── /wiki/help-links (admin) ─────────────────────────────────────────


async def test_help_links_are_for_wiki_admins_only(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    created = await _link(client, admin, "portal:/assets", page["id"])

    # the space's own manager is not a wiki admin
    for method, path, body in (
        ("GET", "/wiki/help-links", None),
        ("POST", "/wiki/help-links", {"context": "portal:/sites", "node_id": page["id"]}),
        ("PATCH", f"/wiki/help-links/{created['id']}", {"context": "portal:/sites"}),
        ("DELETE", f"/wiki/help-links/{created['id']}", None),
    ):
        resp = await client.request(method, path, headers=s["owner"], json=body)
        assert resp.status_code == 403, (method, path, resp.text)
        assert resp.json()["detail"]["code"] == "forbidden"


async def test_create_normalizes_and_lists(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    created = await _link(client, admin, f"Portal:/Sites/{SITE_ID}/", page["id"])
    assert created["context"] == "portal:/sites/:id"
    assert created["node"] == {
        "id": page["id"], "title": "Time Guide", "kind": "page",
        "space_key": s["space"]["key"], "space_name": s["space"]["name"]}
    assert created["trashed"] is False
    assert created["created_by"]["name"]

    row = await db.get(WikiHelpLink, uuid.UUID(created["id"]))
    assert row.context == "portal:/sites/:id"

    await _link(client, admin, "kiosk:/enroll", page["id"])
    listed = (await client.get("/wiki/help-links", headers=admin)).json()
    assert [link["context"] for link in listed] == ["kiosk:/enroll", "portal:/sites/:id"]

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_help_link",
        AuditLog.entity_id == created["id"]))).all()
    assert [a.action for a in audits] == ["create"]
    assert audits[0].changes == {"context": "portal:/sites/:id", "node_id": page["id"]}


async def test_create_rejects_a_taken_context(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    await _link(client, admin, "portal:/bulk/time", page["id"])
    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": "PORTAL:/bulk//time/", "node_id": page["id"]})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "context_taken"


async def test_a_context_taken_concurrently_is_a_409(client, db, monkeypatch):
    """The pre-check can miss a link another request adds a moment later:
    the unique index still answers, as a 409 rather than a 500."""
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    first = await _link(client, admin, "portal:/assets", page["id"])
    second = await _link(client, admin, "portal:/sites", page["id"])

    async def never_taken(*_args, **_kwargs):
        return False
    monkeypatch.setattr("serversherpa.api.routes.wiki.help_links._context_taken", never_taken)

    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": "portal:/assets", "node_id": page["id"]})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "context_taken"
    resp = await client.patch(f"/wiki/help-links/{second['id']}", headers=admin,
                              json={"context": "portal:/assets"})
    assert resp.status_code == 409
    listed = (await client.get("/wiki/help-links", headers=admin)).json()
    assert {(link["id"], link["context"]) for link in listed} == {
        (first["id"], "portal:/assets"), (second["id"], "portal:/sites")}


@pytest.mark.parametrize("context", [
    "bulk", "/bulk", "web:/bulk", "portal:bulk", "portal:/a b", "portal:/a.b",
    "portal:/" + "a" * 300, "",
])
async def test_create_rejects_a_bad_context(client, db, context):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": context, "node_id": page["id"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_context"


async def test_create_needs_a_live_page_or_file(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": "portal:/assets", "node_id": folder["id"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_kind"

    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": "portal:/assets", "node_id": str(uuid.uuid4())})
    assert resp.status_code == 404

    page = await _page(client, s, db)
    assert (await client.delete(f"/wiki/nodes/{page['id']}",
                                headers=s["owner"])).status_code == 200
    resp = await client.post("/wiki/help-links", headers=admin,
                             json={"context": "portal:/assets", "node_id": page["id"]})
    assert resp.status_code == 404


async def test_patch_changes_context_and_guide(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    first = await _page(client, s, db, "First")
    second = await _page(client, s, db, "Second")
    link = await _link(client, admin, "portal:/assets", first["id"])
    other = await _link(client, admin, "portal:/sites", first["id"])

    resp = await client.patch(f"/wiki/help-links/{link['id']}", headers=admin,
                              json={"context": "Portal:/Assets/Models/", "node_id": second["id"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["context"] == "portal:/assets/models"
    assert body["node"]["title"] == "Second"
    assert (await _help(client, s["viewer"], "portal:/assets/models")).json()["title"] == "Second"

    # its own context again is no conflict; another link's is
    resp = await client.patch(f"/wiki/help-links/{link['id']}", headers=admin,
                              json={"context": "portal:/assets/models"})
    assert resp.status_code == 200
    resp = await client.patch(f"/wiki/help-links/{link['id']}", headers=admin,
                              json={"context": "portal:/sites/"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "context_taken"
    resp = await client.patch(f"/wiki/help-links/{other['id']}", headers=admin,
                              json={"context": "portal:/a b"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_context"
    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await client.patch(f"/wiki/help-links/{other['id']}", headers=admin,
                              json={"node_id": folder["id"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_kind"
    resp = await client.patch(f"/wiki/help-links/{uuid.uuid4()}", headers=admin,
                              json={"context": "portal:/x"})
    assert resp.status_code == 404

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_help_link",
        AuditLog.entity_id == link["id"], AuditLog.action == "update"))).all()
    # the no-op PATCH (its own context again) wrote nothing
    assert len(audits) == 1
    assert audits[0].changes == {
        "context": {"from": "portal:/assets", "to": "portal:/assets/models"},
        "node_id": {"from": first["id"], "to": second["id"]}}


async def test_delete_removes_the_link(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    link = await _link(client, admin, "portal:/assets", page["id"])

    assert (await client.delete(f"/wiki/help-links/{link['id']}",
                                headers=admin)).status_code == 204
    assert await db.get(WikiHelpLink, uuid.UUID(link["id"])) is None
    assert (await _help(client, s["viewer"], "portal:/assets")).status_code == 404
    assert (await client.delete(f"/wiki/help-links/{link['id']}",
                                headers=admin)).status_code == 404
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_help_link",
        AuditLog.entity_id == link["id"], AuditLog.action == "delete"))).all()
    assert len(audits) == 1


async def test_list_flags_a_trashed_guide(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db)
    await _link(client, admin, "portal:/assets", page["id"])
    assert (await client.delete(f"/wiki/nodes/{page['id']}",
                                headers=s["owner"])).status_code == 200
    listed = (await client.get("/wiki/help-links", headers=admin)).json()
    assert [link["trashed"] for link in listed] == [True]


async def test_a_file_can_be_a_guide(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    node = WikiNode(space_id=uuid.UUID(s["space"]["id"]), kind="file", title="manual.pdf")
    db.add(node)
    await db.flush()
    db.add(WikiFile(node_id=node.id, description=""))
    await db.commit()

    await _link(client, admin, "kiosk:/enroll", node.id)
    resp = await _help(client, s["viewer"], "kiosk:/enroll")
    assert resp.status_code == 200
    assert resp.json()["title"] == "manual.pdf"
