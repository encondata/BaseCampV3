"""HTTP tests for Private items and Allow printing (spec 2026-09-30 §2):
the node payload's is_private / allow_printing / can_print / printing_from /
can_set_private fields, `PATCH /wiki/nodes/{id}/privacy` and
`PATCH /wiki/nodes/{id}/printing`, and the library `allow_printing` setting
going through the existing settings validation."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, WikiFile, WikiNode, WikiSpace
from serversherpa.wiki import tree
from tests.wiki_helpers import _create, _setup, login_as, publish_via_db

NEW_FIELDS = {"is_private", "allow_printing", "can_print", "printing_from",
              "can_set_private"}


async def _get(client, headers, node_id, expect=200):
    resp = await client.get(f"/wiki/nodes/{node_id}", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _privacy(client, headers, node_id, value, expect=200):
    resp = await client.patch(f"/wiki/nodes/{node_id}/privacy", headers=headers,
                              json={"is_private": value})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _printing(client, headers, node_id, value, expect=200):
    resp = await client.patch(f"/wiki/nodes/{node_id}/printing", headers=headers,
                              json={"allow_printing": value})
    assert resp.status_code == expect, resp.text
    return resp.json()


def _code(body):
    return body["detail"]["code"]


# ── payload ─────────────────────────────────────────────────────────


async def test_node_payload_has_the_new_fields_for_pages_files_and_folders(client, db):
    ctx = await _setup(client, db)
    h, space = ctx["owner"], ctx["space"]
    folder = await _create(client, h, space, "Folder")
    page = await _create(client, h, space, "Page", kind="page", parent=folder)
    for node in (folder, page):
        assert NEW_FIELDS <= set(node)
    for node in (folder, page):
        body = await _get(client, h, node["id"])
        assert NEW_FIELDS <= set(body)
        assert body["is_private"] is False
        assert body["allow_printing"] is None
        assert body["can_print"] is True
        assert body["printing_from"] == {"node_id": None, "title": "Library"}
        assert body["can_set_private"] is True     # the owner authored both

    # the tree listing carries them too
    listing = (await client.get(f"/wiki/spaces/{space['key']}/tree", headers=h)).json()
    assert all(NEW_FIELDS <= set(n) for n in listing)

    # a file node
    space_row = await db.get(WikiSpace, uuid.UUID(space["id"]))
    node = await tree.create_node(db, space=space_row, parent=None, kind="file",
                                  title="notes.txt", actor_id=ctx["owner_id"])
    db.add(WikiFile(node_id=node.id, description=""))
    await db.commit()
    body = await _get(client, h, node.id)
    assert NEW_FIELDS <= set(body)
    assert body["can_print"] is True


async def test_can_set_private_is_true_only_for_the_author_or_a_developer(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    dev_h, _ = await login_as(client, db, roles=("staff", "developer"))
    assert (await _get(client, ctx["owner"], page["id"]))["can_set_private"] is True
    assert (await _get(client, dev_h, page["id"]))["can_set_private"] is True
    assert (await _get(client, ctx["editor"], page["id"]))["can_set_private"] is False
    assert (await _get(client, ctx["viewer"], page["id"]))["can_set_private"] is False


# ── privacy ─────────────────────────────────────────────────────────


async def test_author_sets_and_clears_private(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["editor"], ctx["space"], "Mine", kind="page")
    body = await _privacy(client, ctx["editor"], page["id"], True)
    assert body["is_private"] is True
    assert body["my_level"] == "manage"        # the author manages their private item
    assert (await _get(client, ctx["editor"], page["id"]))["is_private"] is True
    # everyone else, the library manager included, no longer sees it
    await _get(client, ctx["owner"], page["id"], expect=404)
    await _get(client, ctx["viewer"], page["id"], expect=404)

    body = await _privacy(client, ctx["editor"], page["id"], False)
    assert body["is_private"] is False
    assert body["my_level"] == "edit"          # back to the grant's level
    await _get(client, ctx["viewer"], page["id"])


async def test_developer_sets_private_on_someone_elses_page(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Theirs", kind="page")
    dev_h, _ = await login_as(client, db, roles=("staff", "developer"))
    body = await _privacy(client, dev_h, page["id"], True)
    assert body["is_private"] is True
    assert body["can_set_private"] is True
    # the author still manages it; other editors no longer see it
    assert (await _get(client, ctx["owner"], page["id"]))["my_level"] == "manage"
    await _get(client, ctx["editor"], page["id"], expect=404)


async def test_editor_who_is_not_the_author_gets_403(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    resp = await client.patch(f"/wiki/nodes/{page['id']}/privacy",
                              headers=ctx["editor"], json={"is_private": True})
    assert resp.status_code == 403
    assert _code(resp.json()) == "forbidden"
    row = await db.get(WikiNode, uuid.UUID(page["id"]))
    await db.refresh(row)
    assert row.is_private is False


async def test_wiki_admin_who_is_not_the_author_gets_403(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    admin_h, _ = await login_as(client, db, roles=("admin",))
    resp = await client.patch(f"/wiki/nodes/{page['id']}/privacy",
                              headers=admin_h, json={"is_private": True})
    assert resp.status_code == 403
    assert _code(resp.json()) == "forbidden"


async def test_home_page_cannot_be_made_private(client, db):
    ctx = await _setup(client, db)
    home_id = ctx["space"]["home_node_id"]
    resp = await client.patch(f"/wiki/nodes/{home_id}/privacy",
                              headers=ctx["owner"], json={"is_private": True})
    assert resp.status_code == 422
    assert _code(resp.json()) == "home_page"


async def test_a_node_the_caller_cannot_see_is_404(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    await _privacy(client, ctx["owner"], page["id"], True)
    # neither the privacy nor the printing endpoint reveals it
    resp = await client.patch(f"/wiki/nodes/{page['id']}/privacy",
                              headers=ctx["viewer"], json={"is_private": False})
    assert resp.status_code == 404
    resp = await client.patch(f"/wiki/nodes/{page['id']}/printing",
                              headers=ctx["viewer"], json={"allow_printing": False})
    assert resp.status_code == 404
    resp = await client.patch(f"/wiki/nodes/{uuid.uuid4()}/privacy",
                              headers=ctx["viewer"], json={"is_private": True})
    assert resp.status_code == 404


async def test_privacy_body_must_be_a_boolean(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    for body in ({}, {"is_private": None}, {"is_private": "yes"},
                 {"is_private": True, "extra": 1}):
        resp = await client.patch(f"/wiki/nodes/{page['id']}/privacy",
                                  headers=ctx["owner"], json=body)
        assert resp.status_code == 422, body


async def test_private_folder_hides_its_children_and_the_change_is_live(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")
    child = await _create(client, ctx["owner"], ctx["space"], "Child", kind="page",
                          parent=folder)
    await publish_via_db(db, child["id"])
    await _privacy(client, ctx["owner"], folder["id"], True)
    await _get(client, ctx["viewer"], child["id"], expect=404)
    await _get(client, ctx["editor"], folder["id"], expect=404)


# ── printing ────────────────────────────────────────────────────────


async def test_manager_sets_printing_true_false_and_null(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")

    body = await _printing(client, ctx["owner"], page["id"], False)
    assert body["allow_printing"] is False
    assert body["can_print"] is False
    assert body["printing_from"] is None       # its own explicit value

    body = await _printing(client, ctx["owner"], page["id"], True)
    assert body["allow_printing"] is True
    assert body["can_print"] is True
    assert body["printing_from"] is None

    body = await _printing(client, ctx["owner"], page["id"], None)
    assert body["allow_printing"] is None
    assert body["can_print"] is True
    assert body["printing_from"] == {"node_id": None, "title": "Library"}


async def test_editor_cannot_change_printing(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    resp = await client.patch(f"/wiki/nodes/{page['id']}/printing",
                              headers=ctx["editor"], json={"allow_printing": False})
    assert resp.status_code == 403
    assert _code(resp.json()) == "forbidden"
    resp = await client.patch(f"/wiki/nodes/{page['id']}/printing",
                              headers=ctx["viewer"], json={"allow_printing": False})
    assert resp.status_code == 403


async def test_printing_body_must_be_a_boolean_or_null(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    for body in ({}, {"allow_printing": "no"}, {"allow_printing": 1.5},
                 {"allow_printing": True, "extra": 1}):
        resp = await client.patch(f"/wiki/nodes/{page['id']}/printing",
                                  headers=ctx["owner"], json=body)
        assert resp.status_code == 422, body


async def test_children_inherit_printing_and_report_where_it_came_from(client, db):
    ctx = await _setup(client, db)
    h, space = ctx["owner"], ctx["space"]
    folder = await _create(client, h, space, "Folder")
    page = await _create(client, h, space, "Page", kind="page", parent=folder)
    await _printing(client, h, folder["id"], False)

    body = await _get(client, h, page["id"])
    assert body["allow_printing"] is None
    assert body["can_print"] is False
    assert body["printing_from"] == {"node_id": folder["id"], "title": "Folder"}
    # a reader sees the same answer
    body = await _get(client, ctx["viewer"], folder["id"])
    assert body["can_print"] is False

    # the page can turn it back on for itself
    body = await _printing(client, h, page["id"], True)
    assert body["can_print"] is True and body["printing_from"] is None
    # and clearing the folder's value returns to the library default
    await _printing(client, h, folder["id"], None)
    body = await _get(client, h, page["id"])
    assert body["allow_printing"] is True


async def test_library_setting_drives_can_print_and_is_validated(client, db):
    ctx = await _setup(client, db)
    h, space = ctx["owner"], ctx["space"]
    page = await _create(client, h, space, "Page", kind="page")

    resp = await client.patch(f"/wiki/spaces/{space['key']}", headers=h,
                              json={"settings": {"allow_printing": False}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["allow_printing"] is False
    body = await _get(client, h, page["id"])
    assert body["can_print"] is False
    assert body["printing_from"] == {"node_id": None, "title": "Library"}

    resp = await client.patch(f"/wiki/spaces/{space['key']}", headers=h,
                              json={"settings": {"allow_printing": "no"}})
    assert resp.status_code == 422
    assert _code(resp.json()) == "bad_setting"
    resp = await client.patch(f"/wiki/spaces/{space['key']}", headers=h,
                              json={"settings": {"allow_printing": None}})
    assert resp.status_code == 422


# ── audit ───────────────────────────────────────────────────────────


async def test_both_endpoints_write_audit_rows(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    await _privacy(client, ctx["owner"], page["id"], True)
    await _printing(client, ctx["owner"], page["id"], False)

    rows = {r.action: r for r in (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == page["id"],
        AuditLog.action.in_(("privacy", "printing"))))).all()}
    assert set(rows) == {"privacy", "printing"}
    assert rows["privacy"].actor_person_id == ctx["owner_id"]
    assert rows["privacy"].changes == {"is_private": {"from": False, "to": True}}
    assert rows["printing"].changes == {"allow_printing": {"from": None, "to": False}}


async def test_a_no_op_change_writes_no_audit_row(client, db):
    ctx = await _setup(client, db)
    page = await _create(client, ctx["owner"], ctx["space"], "Page", kind="page")
    await _privacy(client, ctx["owner"], page["id"], False)
    await _printing(client, ctx["owner"], page["id"], None)
    assert (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == page["id"],
        AuditLog.action.in_(("privacy", "printing"))))).all() == []
