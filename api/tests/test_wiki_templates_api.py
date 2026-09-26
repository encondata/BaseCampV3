"""HTTP tests for the wiki templates API (Phase 2 Task 4):
`GET /wiki/templates`, `GET/POST/PATCH/DELETE /wiki/templates/{id}`, and
`POST /wiki/nodes` creating a page from a template.

`clean_db` (api/tests/conftest.py) truncates `wiki_templates` before every
test, dropping migration 0075's four seeded builtins with it. This file
re-seeds them (`wiki_helpers.seed_builtin_templates`: 0075's seed plus
0077's icon rewrite) in an autouse fixture instead of
assuming the builtins are already there — the same convention
`test_container_zpl_templates.py` uses for migration 0066's rows.
"""
import uuid

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Client, WikiTemplate
from tests.wiki_helpers import (
    _create,
    _doc,
    _put_grants,
    _setup,
    _space,
    login_as,
    publish_via_api,
    publish_via_db,
    seed_builtin_templates,
)

BUILTIN_NAMES = ["How-to guide", "Meeting notes", "SOP", "Troubleshooting"]


@pytest.fixture(autouse=True)
async def _seed_builtin_templates(clean_db, db):
    """Re-seed the builtins (0075's seed + 0077's icon rewrite) into the
    freshly truncated test database before every test in this file."""
    await seed_builtin_templates(db)


async def _list(client, headers, space=None, expect=200):
    params = {"space": space} if space else {}
    resp = await client.get("/wiki/templates", headers=headers, params=params)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _get(client, headers, template_id, expect=200):
    resp = await client.get(f"/wiki/templates/{template_id}", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _post(client, headers, expect=201, **body):
    resp = await client.post("/wiki/templates", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _patch(client, headers, template_id, expect=200, **body):
    resp = await client.patch(f"/wiki/templates/{template_id}", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _delete(client, headers, template_id, expect=204):
    resp = await client.delete(f"/wiki/templates/{template_id}", headers=headers)
    assert resp.status_code == expect, resp.text


async def _admin(client, db):
    return (await login_as(client, db, roles=("admin",)))[0]


async def _outsider(client, db):
    """A non-internal caller with no grant anywhere — unlike a fresh
    `roles=("staff",)` login, which is internal and so already has view
    through any space's `default_access="internal"` grant (`_setup`'s
    default)."""
    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    db.add(acme)
    await db.flush()
    headers, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    return headers


# ── list / get ───────────────────────────────────────────────────────


async def test_list_groups_builtin_global_and_space_templates_name_ordered(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    await _post(client, admin, name="ZZZ Global", content_json=_doc("g"))
    await _post(client, admin, name="AAA Global", content_json=_doc("g"))
    await _post(client, s["owner"], space_id=s["space"]["id"], name="Beta Space",
               content_json=_doc("s"))
    await _post(client, s["owner"], space_id=s["space"]["id"], name="Alpha Space",
               content_json=_doc("s"))

    listed = await _list(client, s["viewer"], space=s["space"]["key"])
    assert [t["name"] for t in listed] == [
        *BUILTIN_NAMES, "AAA Global", "ZZZ Global", "Alpha Space", "Beta Space"]
    assert [t["is_builtin"] for t in listed[:4]] == [True, True, True, True]
    assert all(t["space_id"] is None for t in listed[:6])
    assert all(t["space_id"] == s["space"]["id"] for t in listed[6:])

    # without ?space, only builtin + global
    no_space = await _list(client, s["viewer"])
    assert [t["name"] for t in no_space] == [*BUILTIN_NAMES, "AAA Global", "ZZZ Global"]


async def test_builtin_templates_list_with_glyph_icons(client, db):
    """What a migrated database serves: each builtin's icon is a glyph the
    UI can print before the name, never an icon *name* like "compass"."""
    headers, _ = await login_as(client, db)
    builtins = {t["name"]: t["icon"] for t in await _list(client, headers) if t["is_builtin"]}
    assert builtins == {"SOP": "📋", "How-to guide": "🧭",
                        "Troubleshooting": "🔧", "Meeting notes": "👥"}


async def test_template_description_and_icon_are_capped(client, db):
    s = await _setup(client, db)
    base = {"space_id": s["space"]["id"], "content_json": _doc("x")}
    await _post(client, s["owner"], expect=422, name="Long", description="d" * 501, **base)
    await _post(client, s["owner"], expect=422, name="Icon", icon="i" * 17, **base)
    tmpl = await _post(client, s["owner"], name="Fits", description="d" * 500,
                       icon="🧭" * 8, **base)
    await _patch(client, s["owner"], tmpl["id"], expect=422, description="d" * 501)
    await _patch(client, s["owner"], tmpl["id"], expect=422, icon="i" * 17)


async def test_list_hides_space_templates_the_caller_cant_see(client, db):
    s = await _setup(client, db)
    await _post(client, s["owner"], space_id=s["space"]["id"], name="Space Only",
               content_json=_doc("s"))
    outsider = await _outsider(client, db)

    # can't see the space at all -> 404 for ?space=
    await _list(client, outsider, space=s["space"]["key"], expect=404)
    # no space filter still works (builtins only, since no globals exist)
    assert [t["name"] for t in await _list(client, outsider)] == BUILTIN_NAMES


async def test_get_template_detail_has_content_and_404_when_invisible(client, db):
    s = await _setup(client, db)
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Detail",
                       description="desc", icon="star", content_json=_doc("hello"))
    assert tmpl["description"] == "desc"
    assert tmpl["icon"] == "star"

    detail = await _get(client, s["owner"], tmpl["id"])
    assert detail["content_json"] == _doc("hello")

    outsider = await _outsider(client, db)
    await _get(client, outsider, tmpl["id"], expect=404)
    await _get(client, s["viewer"], str(uuid.uuid4()), expect=404)


# ── create: rights ───────────────────────────────────────────────────


async def test_create_space_template_needs_manage(client, db):
    s = await _setup(client, db)
    await _post(client, s["viewer"], expect=403, space_id=s["space"]["id"],
               name="Nope", content_json=_doc("x"))
    await _post(client, s["editor"], expect=403, space_id=s["space"]["id"],
               name="Nope", content_json=_doc("x"))
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Ok",
                       content_json=_doc("x"))
    assert tmpl["space_id"] == s["space"]["id"]
    assert tmpl["space_key"] == s["space"]["key"]
    assert tmpl["is_builtin"] is False


async def test_create_global_template_needs_wiki_admin(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    # a space manager isn't a wiki admin
    await _post(client, s["owner"], expect=403, name="Nope", content_json=_doc("x"))
    tmpl = await _post(client, admin, name="Global Ok", content_json=_doc("x"))
    assert tmpl["space_id"] is None
    assert tmpl["is_builtin"] is False


async def test_create_needs_content_json_xor_from_node_id(client, db):
    s = await _setup(client, db)
    await _post(client, s["owner"], expect=422, space_id=s["space"]["id"], name="Neither")
    await _post(client, s["owner"], expect=422, space_id=s["space"]["id"], name="Both",
               content_json=_doc("x"), from_node_id=str(uuid.uuid4()))


async def test_create_validates_content_size_and_shape(client, db):
    s = await _setup(client, db)
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "Bad doc", "content_json": {"not": "a doc"}})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_doc"


async def test_name_uniqueness_is_409_scoped_per_space(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    await _post(client, s["owner"], space_id=s["space"]["id"], name="Runbook",
               content_json=_doc("x"))
    # same name, same space -> 409 (case-insensitive)
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "runbook", "content_json": _doc("y")})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "name_taken"
    # same name, global scope -> fine (different scope)
    await _post(client, admin, name="Runbook", content_json=_doc("z"))
    # same name, a different space -> fine
    other_owner_h, other_owner_id = await login_as(client, db, roles=("staff",))
    other_space = await _space(client, other_owner_h)
    await _put_grants(client, other_owner_h, other_space, [
        {"principal_type": "person", "principal_id": str(other_owner_id), "level": "manage"}])
    await _post(client, other_owner_h, space_id=other_space["id"], name="Runbook",
               content_json=_doc("w"))


# ── create: from_node_id ─────────────────────────────────────────────
#
# Rights to CREATE a template (manage on the destination space) are
# separate from the caller's LEVEL on the source page (from_node_id),
# which decides draft vs published. A space manager always has at least
# edit on their own space's pages, so the "view-only source" tests use a
# page in a DIFFERENT space, where a manager of space B is merely an
# internal viewer of space A's pages (both `_setup()` spaces default to
# default_access="internal").


async def test_from_node_id_edit_level_copies_the_draft(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page",
                         initial_content=_doc("draft body"))
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="From draft",
                       from_node_id=page["id"])
    detail = await _get(client, s["owner"], tmpl["id"])
    assert detail["content_json"] == _doc("draft body")


async def test_from_node_id_edit_level_falls_back_to_published_with_no_draft(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"], content=_doc("published body"))
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="From published",
                       from_node_id=page["id"])
    detail = await _get(client, s["owner"], tmpl["id"])
    assert detail["content_json"] == _doc("published body")


async def test_from_node_id_view_level_copies_published_and_404_when_never_published(client, db):
    source = await _setup(client, db)   # space A: the source page lives here
    dest = await _setup(client, db)     # space B: dest.owner has manage here only
    page = await _create(client, source["owner"], source["space"], "Runbook", kind="page",
                         initial_content=_doc("draft only"))

    # dest.owner is only an internal viewer of space A's pages, and a
    # never-published page is invisible to a view-only caller
    resp = await client.post("/wiki/templates", headers=dest["owner"], json={
        "space_id": dest["space"]["id"], "name": "Too soon", "from_node_id": page["id"]})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "not_published"

    await publish_via_api(client, source["owner"], page["id"])
    tmpl = await _post(client, dest["owner"], space_id=dest["space"]["id"],
                       name="From published", from_node_id=page["id"])
    detail = await _get(client, dest["owner"], tmpl["id"])
    assert detail["content_json"] == _doc("draft only")

    # creating the template still needs manage on the DESTINATION space
    resp = await client.post("/wiki/templates", headers=dest["viewer"], json={
        "space_id": dest["space"]["id"], "name": "No rights", "from_node_id": page["id"]})
    assert resp.status_code == 403, resp.text


async def test_from_node_id_must_be_a_page(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "Not a page", "from_node_id": folder["id"]})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "not_a_page"


async def test_from_node_id_strips_page_asset_embeds_but_keeps_file_node_embeds(client, db):
    s = await _setup(client, db)
    content = {"type": "doc", "content": [
        {"type": "wikiImage", "attrs": {"assetId": "11111111-1111-1111-1111-111111111111",
                                        "alt": "photo", "caption": ""}},
        {"type": "fileEmbed", "attrs": {"assetId": None, "nodeId": "n1",
                                        "filename": "manual.pdf", "contentType": "x"}},
        {"type": "paragraph", "content": [{"type": "text", "text": "body"}]},
    ]}
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page",
                         initial_content=content)
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Stripped",
                       from_node_id=page["id"])
    detail = await _get(client, s["owner"], tmpl["id"])
    types = [n["type"] for n in detail["content_json"]["content"]]
    assert types == ["fileEmbed", "paragraph"]


async def test_content_json_path_also_strips_page_asset_embeds(client, db):
    s = await _setup(client, db)
    content = {"type": "doc", "content": [
        {"type": "wikiImage", "attrs": {"assetId": "11111111-1111-1111-1111-111111111111",
                                        "alt": "photo", "caption": ""}},
        {"type": "paragraph", "content": [{"type": "text", "text": "body"}]},
    ]}
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Stripped2",
                       content_json=content)
    detail = await _get(client, s["owner"], tmpl["id"])
    assert [n["type"] for n in detail["content_json"]["content"]] == ["paragraph"]


# ── builtin protection ───────────────────────────────────────────────


async def test_builtins_cannot_be_patched_or_deleted_by_anyone(client, db):
    admin = await _admin(client, db)
    builtin = (await db.scalar(select(WikiTemplate).where(WikiTemplate.name == "SOP")))
    resp = await client.patch(f"/wiki/templates/{builtin.id}", headers=admin,
                              json={"name": "Renamed"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "builtin"

    # content edits are refused too, even for an admin
    resp = await client.patch(f"/wiki/templates/{builtin.id}", headers=admin,
                              json={"content_json": _doc("nope")})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "builtin"

    resp = await client.delete(f"/wiki/templates/{builtin.id}", headers=admin)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "builtin"


# ── patch / delete: non-builtin ──────────────────────────────────────


async def test_patch_updates_fields_checks_rights_and_uniqueness(client, db):
    s = await _setup(client, db)
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Original",
                       description="d1", icon="i1", content_json=_doc("x"))
    other = await _post(client, s["owner"], space_id=s["space"]["id"], name="Other",
                        content_json=_doc("y"))

    await _patch(client, s["viewer"], tmpl["id"], expect=403, name="Nope")
    await _patch(client, s["editor"], tmpl["id"], expect=403, name="Nope")

    resp = await client.patch(f"/wiki/templates/{tmpl['id']}", headers=s["owner"],
                              json={"name": "Other"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "name_taken"

    updated = await _patch(client, s["owner"], tmpl["id"], name="Renamed",
                           description="d2", icon="i2")
    assert updated["name"] == "Renamed"
    assert updated["description"] == "d2"
    assert updated["icon"] == "i2"
    # content is unchanged by patch
    detail = await _get(client, s["owner"], tmpl["id"])
    assert detail["content_json"] == _doc("x")
    assert other["name"] == "Other"

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_template", AuditLog.entity_id == tmpl["id"],
        AuditLog.action == "update"))).all()
    assert len(audits) == 1


async def test_patch_can_update_content_json_validated_and_stripped(client, db):
    s = await _setup(client, db)
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Editable",
                       content_json=_doc("original"))

    await _patch(client, s["viewer"], tmpl["id"], expect=403, content_json=_doc("nope"))
    await _patch(client, s["editor"], tmpl["id"], expect=403, content_json=_doc("nope"))

    resp = await client.patch(f"/wiki/templates/{tmpl['id']}", headers=s["owner"],
                              json={"content_json": {"not": "a doc"}})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_doc"

    new_content = {"type": "doc", "content": [
        {"type": "wikiImage", "attrs": {"assetId": "11111111-1111-1111-1111-111111111111",
                                        "alt": "photo", "caption": ""}},
        {"type": "paragraph", "content": [{"type": "text", "text": "updated"}]},
    ]}
    updated = await _patch(client, s["owner"], tmpl["id"], content_json=new_content)
    assert updated["name"] == "Editable"   # other fields untouched

    detail = await _get(client, s["owner"], tmpl["id"])
    assert [n["type"] for n in detail["content_json"]["content"]] == ["paragraph"]
    assert detail["content_json"]["content"][0]["content"][0]["text"] == "updated"

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_template", AuditLog.entity_id == tmpl["id"],
        AuditLog.action == "update"))).all()
    assert len(audits) == 1


async def test_delete_a_space_template_needs_manage_and_is_audited(client, db):
    s = await _setup(client, db)
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="Doomed",
                       content_json=_doc("x"))
    await _delete(client, s["editor"], tmpl["id"], expect=403)
    await _delete(client, s["owner"], tmpl["id"])
    await _get(client, s["owner"], tmpl["id"], expect=404)

    count = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_template", AuditLog.entity_id == tmpl["id"],
        AuditLog.action == "delete"))).all()
    assert len(count) == 1


async def test_global_template_delete_needs_wiki_admin(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    tmpl = await _post(client, admin, name="Global Doomed", content_json=_doc("x"))
    await _delete(client, s["owner"], tmpl["id"], expect=403)
    await _delete(client, admin, tmpl["id"])


# ── create a page from a template (nodes.py) ─────────────────────────


async def test_create_node_from_template_sets_title_and_imported_content(client, db):
    s = await _setup(client, db)
    tmpl = await _post(client, s["owner"], space_id=s["space"]["id"], name="From Template",
                       description="d", content_json=_doc("template body"))

    # blank/omitted title defaults to the template's name
    resp = await client.post("/wiki/nodes", headers=s["editor"], json={
        "space_id": s["space"]["id"], "parent_id": None, "kind": "page",
        "template_id": tmpl["id"]})
    assert resp.status_code == 201, resp.text
    page = resp.json()
    assert page["title"] == "From Template"

    draft = await client.get(f"/wiki/pages/{page['id']}/content", headers=s["editor"],
                             params={"version": "draft"})
    assert draft.json()["content_json"] == _doc("template body")

    versions = await client.get(f"/wiki/pages/{page['id']}/versions", headers=s["editor"])
    versions = versions.json()
    assert len(versions) == 1
    assert versions[0]["kind"] == "imported"

    # an explicit title overrides the template's name
    page2 = await _create(client, s["editor"], s["space"], "My Own Title", kind="page",
                          template_id=tmpl["id"])
    assert page2["title"] == "My Own Title"


async def test_create_node_with_unknown_or_invisible_template_is_404(client, db):
    s = await _setup(client, db)
    # a private space (no internal grant) that only its owner can see —
    # the template lives there, s["editor"] otherwise has no access to it
    private_space = await _space(client, s["owner"], default_access="private")
    hidden_tmpl = await _post(client, s["owner"], space_id=private_space["id"],
                              name="Hidden", content_json=_doc("x"))

    # s["editor"] has edit on their own space, but no access at all to the
    # space that owns this template
    resp = await client.post("/wiki/nodes", headers=s["editor"], json={
        "space_id": s["space"]["id"], "parent_id": None, "kind": "page",
        "template_id": hidden_tmpl["id"]})
    assert resp.status_code == 404, resp.text

    resp = await client.post("/wiki/nodes", headers=s["editor"], json={
        "space_id": s["space"]["id"], "parent_id": None, "kind": "page",
        "template_id": str(uuid.uuid4())})
    assert resp.status_code == 404, resp.text


async def test_create_node_needs_a_title_when_no_template(client, db):
    s = await _setup(client, db)
    resp = await client.post("/wiki/nodes", headers=s["editor"], json={
        "space_id": s["space"]["id"], "parent_id": None, "kind": "page"})
    assert resp.status_code == 422, resp.text
    resp = await client.post("/wiki/nodes", headers=s["editor"], json={
        "space_id": s["space"]["id"], "parent_id": None, "kind": "page", "title": "   "})
    assert resp.status_code == 422, resp.text
