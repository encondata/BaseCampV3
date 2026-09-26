"""HTTP tests for the wiki tree API — Task 4: create, tree listing, node
detail/breadcrumbs, rename, move, copy, delete (to trash), favorites,
recent and drafts — plus direct tests of `tree.next_position`."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select

from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    AuditLog,
    WikiFile,
    WikiFileVersion,
    WikiGrant,
    WikiJob,
    WikiNode,
    WikiPage,
    WikiPageAsset,
    WikiPageVersion,
    WikiSpace,
)
from serversherpa.wiki import tree
from tests.wiki_helpers import _create, _put_grants, _setup, _space, publish_via_db

ELLIPSIS = "…"


# ── helpers ─────────────────────────────────────────────────────────
# `_space`, `_put_grants`, `_create`, `_setup`, and `publish_via_db` live
# in tests/wiki_helpers.py so every wiki test module can import them
# without cross-importing this one.


async def _node_row(db, node_id) -> WikiNode:
    await db.flush()     # expire_all would discard unflushed edits
    db.expire_all()
    return await db.get(WikiNode, uuid.UUID(str(node_id)))


async def _tree(client, headers, space, parent=None):
    params = {"parent_id": parent["id"]} if parent else {}
    resp = await client.get(f"/wiki/spaces/{space['key']}/tree",
                            headers=headers, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _titles(nodes):
    return [n["title"] for n in nodes]


async def _break_inheritance(db, node_id, *, person_id, level="manage"):
    node = await _node_row(db, node_id)
    node.inherit_permissions = False
    db.add(WikiGrant(space_id=node.space_id, node_id=node.id,
                     principal_type="person", principal_id=str(person_id),
                     level=level))
    await db.commit()


def _count_statements():
    statements: list[str] = []

    def _count(conn, cursor, statement, *args):
        statements.append(statement)

    return statements, _count


# ── next_position ───────────────────────────────────────────────────


async def _raw_space(db):
    space = WikiSpace(key=f"np-{uuid.uuid4().hex[:10]}", name="Positions")
    db.add(space)
    await db.flush()
    return space


async def _raw_nodes(db, space, positions, parent=None):
    nodes = []
    for i, pos in enumerate(positions):
        n = WikiNode(space_id=space.id, parent_id=parent.id if parent else None,
                     path=[parent.id] if parent else [], kind="folder",
                     title=f"N{i}", position=pos)
        db.add(n)
        nodes.append(n)
    await db.flush()
    return nodes


async def test_next_position_branches(db):
    space = await _raw_space(db)
    assert await tree.next_position(db, space.id, None) == 1024.0   # empty

    a, b, c = await _raw_nodes(db, space, [1024.0, 2048.0, 4096.0])
    assert await tree.next_position(db, space.id, None) == 4096.0 + 1024
    assert await tree.next_position(db, space.id, None, after_id=a.id) == 1536.0
    assert await tree.next_position(db, space.id, None, after_id=c.id) == 4096.0 + 1024
    assert await tree.next_position(db, space.id, None,
                                    after_id=uuid.uuid4()) == 4096.0 + 1024
    assert await tree.next_position(db, space.id, None, before_id=b.id) == 1536.0
    assert await tree.next_position(db, space.id, None, before_id=a.id) == 0.0
    assert await tree.next_position(db, space.id, None,
                                    before_id=uuid.uuid4()) == 4096.0 + 1024
    # the moving node itself doesn't count as a sibling
    assert await tree.next_position(db, space.id, None, after_id=a.id,
                                    exclude_id=b.id) == (1024.0 + 4096.0) / 2
    # other parents' children and deleted siblings don't count
    await _raw_nodes(db, space, [99999.0], parent=a)
    gone, = await _raw_nodes(db, space, [50000.0])
    gone.deleted_at = datetime.now(UTC)
    await db.flush()
    assert await tree.next_position(db, space.id, None) == 4096.0 + 1024
    await db.rollback()


async def test_next_position_renumbers_a_crowded_sibling_set(db):
    space = await _raw_space(db)
    a, b, c = await _raw_nodes(db, space, [1.0, 1.0 + 5e-7, 3.0])
    pos = await tree.next_position(db, space.id, None, after_id=a.id)
    await db.flush()
    assert (a.position, b.position, c.position) == (1024.0, 2048.0, 3072.0)
    assert pos == 1536.0
    await db.rollback()


# ── create + tree ───────────────────────────────────────────────────


async def test_create_folders_and_pages_at_root_and_nested(client, db):
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["editor"], space, "Runbooks")
    assert folder["kind"] == "folder" and folder["parent_id"] is None
    assert folder["my_level"] == "edit"
    assert folder["owner"]["id"] == str(s["editor_id"])
    page = await _create(client, s["editor"], space, "Restart", kind="page",
                         parent=folder)
    assert page["parent_id"] == folder["id"]
    assert page["page"] == {"is_home": False, "published_version_id": None,
                            "published_at": None, "has_unpublished_changes": False}
    nested = await _create(client, s["editor"], space, "Details", kind="page",
                           parent=page)
    assert (await _node_row(db, nested["id"])).path == [
        uuid.UUID(folder["id"]), uuid.UUID(page["id"])]

    root = await _tree(client, s["editor"], space)
    assert _titles(root) == ["Tree Space", "Runbooks"]
    assert root[1]["has_children"] is True
    assert root[0]["page"]["is_home"] is True

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == folder["id"],
        AuditLog.action == "create"))).all()
    assert len(audit) == 1


async def test_create_with_after_id_orders_siblings(client, db):
    s = await _setup(client, db)
    space = s["space"]
    parent = await _create(client, s["owner"], space, "Parent")
    a = await _create(client, s["owner"], space, "A", parent=parent)
    await _create(client, s["owner"], space, "C", parent=parent)
    await _create(client, s["owner"], space, "B", parent=parent, after_id=a["id"])
    assert _titles(await _tree(client, s["owner"], space, parent)) == ["A", "B", "C"]


async def test_create_needs_edit_and_a_valid_parent(client, db):
    s = await _setup(client, db)
    space = s["space"]
    await _create(client, s["viewer"], space, "Nope", expect=403)

    folder = await _create(client, s["owner"], space, "F")
    file_node = WikiNode(space_id=uuid.UUID(space["id"]), parent_id=uuid.UUID(folder["id"]),
                         path=[uuid.UUID(folder["id"])], kind="file", title="f.pdf")
    db.add(file_node)
    await db.commit()
    # a view-only caller learns they lack edit (403) before whether the
    # parent could hold the node (422) — same order as move/copy
    resp = await client.post("/wiki/nodes", headers=s["viewer"], json={
        "space_id": space["id"], "parent_id": str(file_node.id), "kind": "page",
        "title": "Under a file"})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "forbidden"
    resp = await client.post("/wiki/nodes", headers=s["owner"], json={
        "space_id": space["id"], "parent_id": str(file_node.id), "kind": "page",
        "title": "Under a file"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_parent"

    other = await _space(client, s["owner"])
    resp = await client.post("/wiki/nodes", headers=s["owner"], json={
        "space_id": other["id"], "parent_id": folder["id"], "kind": "page",
        "title": "Wrong space"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_parent"

    resp = await client.post("/wiki/nodes", headers=s["owner"], json={
        "space_id": space["id"], "parent_id": None, "kind": "file", "title": "x"})
    assert resp.status_code == 422

    resp = await client.post("/wiki/nodes", headers=s["owner"], json={
        "space_id": space["id"], "parent_id": None, "kind": "page", "title": ""})
    assert resp.status_code == 422


async def test_view_only_tree_hides_unpublished_pages_and_broken_inheritance(client, db):
    s = await _setup(client, db)
    space = s["space"]
    published = await _create(client, s["owner"], space, "Published", kind="page")
    await publish_via_db(db, published["id"])
    draft = await _create(client, s["owner"], space, "Draft only", kind="page")
    secret = await _create(client, s["owner"], space, "Secret")
    await _break_inheritance(db, secret["id"], person_id=s["owner_id"])

    viewer_titles = _titles(await _tree(client, s["viewer"], space))
    assert "Published" in viewer_titles
    assert "Draft only" not in viewer_titles
    assert "Secret" not in viewer_titles

    editor_titles = _titles(await _tree(client, s["editor"], space))
    assert "Draft only" in editor_titles
    assert "Secret" not in editor_titles     # the break drops the editor too
    assert "Secret" in _titles(await _tree(client, s["owner"], space))

    resp = await client.get(f"/wiki/nodes/{secret['id']}", headers=s["viewer"])
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"
    resp = await client.get(f"/wiki/spaces/{space['key']}/tree",
                            headers=s["viewer"], params={"parent_id": secret["id"]})
    assert resp.status_code == 404
    assert draft["id"]


async def test_tree_listing_uses_a_bounded_number_of_statements(client, db):
    s = await _setup(client, db)
    space = s["space"]
    small = await _create(client, s["owner"], space, "Small")
    large = await _create(client, s["owner"], space, "Large")
    # the same mix under each (the first page published, so the viewer
    # sees a page and folders under both); only the count differs
    for parent, prefix, n in ((small, "S", 3), (large, "L", 30)):
        for i in range(n):
            child = await _create(client, s["owner"], space, f"{prefix}{i}",
                                  kind=("page", "folder")[i % 2], parent=parent)
            if i == 0:
                await publish_via_db(db, child["id"])

    engine = get_engine().sync_engine
    counts = []
    for parent in (small, large):
        statements, listener = _count_statements()
        event.listen(engine, "before_cursor_execute", listener)
        try:
            viewer_nodes = await _tree(client, s["viewer"], space, parent)
            nodes = await _tree(client, s["owner"], space, parent)
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        counts.append(len(statements))
    assert len(nodes) == 30 and len(viewer_nodes) == 16
    assert counts[0] == counts[1], counts


# ── node detail / breadcrumbs / rename ─────────────────────────────


async def test_node_detail_breadcrumbs_hide_unviewable_ancestors(client, db):
    s = await _setup(client, db)
    space = s["space"]
    top = await _create(client, s["owner"], space, "Top")
    hidden = await _create(client, s["owner"], space, "Hidden", parent=top)
    leaf = await _create(client, s["owner"], space, "Leaf", kind="page", parent=hidden)
    await publish_via_db(db, leaf["id"])
    await _break_inheritance(db, hidden["id"], person_id=s["owner_id"])
    db.add(WikiGrant(space_id=uuid.UUID(space["id"]), node_id=uuid.UUID(leaf["id"]),
                     principal_type="person", principal_id=str(s["viewer_id"]),
                     level="view"))
    await db.commit()

    owner_view = (await client.get(f"/wiki/nodes/{leaf['id']}", headers=s["owner"])).json()
    assert [(b["id"], b["title"]) for b in owner_view["breadcrumbs"]] == [
        (top["id"], "Top"), (hidden["id"], "Hidden")]
    assert owner_view["space"]["key"] == space["key"]
    assert owner_view["my_level"] == "manage"

    resp = await client.get(f"/wiki/nodes/{leaf['id']}", headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["my_level"] == "view"
    assert body["breadcrumbs"] == [
        {"id": top["id"], "title": "Top", "kind": "folder"},
        {"id": None, "title": ELLIPSIS, "kind": "folder"},
    ]


async def test_rename_needs_edit_and_is_audited(client, db):
    s = await _setup(client, db)
    space = s["space"]
    page = await _create(client, s["owner"], space, "Old", kind="page")
    await publish_via_db(db, page["id"])

    resp = await client.patch(f"/wiki/nodes/{page['id']}", headers=s["viewer"],
                              json={"title": "Viewer rename"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    resp = await client.patch(f"/wiki/nodes/{page['id']}", headers=s["editor"],
                              json={"title": "New", "owner_id": str(s["editor_id"])})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "New"
    assert body["owner"]["id"] == str(s["editor_id"])
    assert body["updated_by"]["id"] == str(s["editor_id"])

    resp = await client.patch(f"/wiki/nodes/{page['id']}", headers=s["editor"],
                              json={"owner_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_owner"

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == page["id"],
        AuditLog.action == "update"))).all()
    assert len(audit) == 1
    assert audit[0].changes["title"] == {"from": "Old", "to": "New"}
    assert audit[0].changes["owner_id"]["to"] == str(s["editor_id"])


# ── move ────────────────────────────────────────────────────────────


async def test_move_reorders_and_repaths_descendants(client, db):
    s = await _setup(client, db)
    space = s["space"]
    f1 = await _create(client, s["editor"], space, "F1")
    f2 = await _create(client, s["editor"], space, "F2", parent=f1)
    p3 = await _create(client, s["editor"], space, "P3", kind="page", parent=f2)
    p4 = await _create(client, s["editor"], space, "P4", kind="page", parent=p3)
    trashed = await _create(client, s["editor"], space, "Trashed", parent=f2)
    assert (await client.delete(f"/wiki/nodes/{trashed['id']}",
                                headers=s["editor"])).status_code == 200
    f5 = await _create(client, s["editor"], space, "F5")
    x = await _create(client, s["editor"], space, "X", parent=f5)
    y = await _create(client, s["editor"], space, "Y", parent=f5)

    resp = await client.post(f"/wiki/nodes/{f2['id']}/move", headers=s["editor"],
                             json={"parent_id": f5["id"], "before_id": y["id"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_id"] == f5["id"]

    assert _titles(await _tree(client, s["editor"], space, f5)) == ["X", "F2", "Y"]
    assert await _tree(client, s["editor"], space, f1) == []
    f5_id, f2_id, p3_id = (uuid.UUID(f5["id"]), uuid.UUID(f2["id"]),
                           uuid.UUID(p3["id"]))
    assert (await _node_row(db, f2["id"])).path == [f5_id]
    assert (await _node_row(db, p3["id"])).path == [f5_id, f2_id]
    assert (await _node_row(db, p4["id"])).path == [f5_id, f2_id, p3_id]
    assert (await _node_row(db, trashed["id"])).path == [f5_id, f2_id]

    # reorder within the same parent
    resp = await client.post(f"/wiki/nodes/{x['id']}/move", headers=s["editor"],
                             json={"parent_id": f5["id"], "after_id": y["id"]})
    assert resp.status_code == 200, resp.text
    assert _titles(await _tree(client, s["editor"], space, f5)) == ["F2", "Y", "X"]

    # to the root
    resp = await client.post(f"/wiki/nodes/{p3['id']}/move", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 200, resp.text
    assert (await _node_row(db, p3["id"])).path == []
    assert (await _node_row(db, p4["id"])).path == [p3_id]

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == f2["id"],
        AuditLog.action == "move"))).all()
    assert len(audit) == 1


async def test_move_rejects_bad_parents_home_and_viewers(client, db):
    s = await _setup(client, db)
    space = s["space"]
    f1 = await _create(client, s["owner"], space, "F1")
    f2 = await _create(client, s["owner"], space, "F2", parent=f1)
    file_node = WikiNode(space_id=uuid.UUID(space["id"]), parent_id=None, path=[],
                         kind="file", title="f.pdf")
    db.add(file_node)
    await db.commit()

    for target in (f2["id"], f1["id"], str(file_node.id)):
        resp = await client.post(f"/wiki/nodes/{f1['id']}/move", headers=s["owner"],
                                 json={"parent_id": target})
        assert resp.status_code == 422, (target, resp.text)
        assert resp.json()["detail"]["code"] == "bad_parent"

    resp = await client.post(f"/wiki/nodes/{space['home_node_id']}/move",
                             headers=s["owner"], json={"parent_id": f1["id"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "is_home"
    # people see "library" (the code says space)
    assert resp.json()["detail"]["message"] == "The library's home page can't be moved."

    resp = await client.post(f"/wiki/nodes/{f2['id']}/move", headers=s["viewer"],
                             json={"parent_id": None})
    assert resp.status_code == 403


async def test_cross_space_move_needs_manage_and_carries_the_subtree(client, db):
    s = await _setup(client, db)
    src = s["space"]
    dest = await _space(client, s["owner"], name="Destination")
    await _put_grants(client, s["owner"], dest, [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
    ])
    folder = await _create(client, s["owner"], src, "Moving")
    child = await _create(client, s["owner"], src, "Child", kind="page", parent=folder)
    db.add(WikiGrant(space_id=uuid.UUID(src["id"]), node_id=uuid.UUID(child["id"]),
                     principal_type="person", principal_id=str(s["viewer_id"]),
                     level="edit"))
    await db.commit()

    resp = await client.post(f"/wiki/nodes/{folder['id']}/move", headers=s["editor"],
                             json={"parent_id": None, "space_id": dest["id"]})
    assert resp.status_code == 403, resp.text

    resp = await client.post(f"/wiki/nodes/{folder['id']}/move", headers=s["owner"],
                             json={"parent_id": None, "space_id": dest["id"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["space_id"] == dest["id"] and body["space_key"] == dest["key"]
    assert body["my_level"] == "manage"

    dest_id = uuid.UUID(dest["id"])
    assert (await _node_row(db, child["id"])).space_id == dest_id
    grant = await db.scalar(select(WikiGrant).where(
        WikiGrant.node_id == uuid.UUID(child["id"])))
    assert grant.space_id == dest_id
    assert _titles(await _tree(client, s["owner"], dest)) == ["Destination", "Moving"]
    assert "Moving" not in _titles(await _tree(client, s["owner"], src))


# ── copy ────────────────────────────────────────────────────────────


async def test_copy_page_copies_draft_and_assets_not_versions_or_grants(client, db):
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["owner"], space, "Docs")
    page = await _create(client, s["owner"], space, "Guide", kind="page", parent=folder)
    await publish_via_db(db, page["id"])
    page_id = uuid.UUID(page["id"])
    used = WikiPageAsset(node_id=page_id, storage_key="assets/abc.png",
                         filename="abc.png", content_type="image/png", size_bytes=5)
    unused = WikiPageAsset(node_id=page_id, storage_key="assets/old.png",
                           filename="old.png", content_type="image/png", size_bytes=5)
    db.add_all([used, unused])
    await db.flush()
    used_id = used.id
    draft = {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "draft words"}]},
        {"type": "wikiImage", "attrs": {"assetId": str(used_id), "alt": "abc"}}]}
    row = await db.get(WikiPage, page_id)
    row.draft_json = draft
    row.draft_text = "draft words"
    row.ydoc = b"\x01\x02"
    row.has_unpublished_changes = True
    db.add(WikiGrant(space_id=uuid.UUID(space["id"]), node_id=page_id,
                     principal_type="person", principal_id=str(s["viewer_id"]),
                     level="edit"))
    await db.commit()

    resp = await client.post(f"/wiki/nodes/{page['id']}/copy", headers=s["editor"],
                             json={"parent_id": folder["id"]})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["title"] == "Copy of Guide"
    assert body["id"] != page["id"]
    assert body["inherit_permissions"] is True
    assert body["owner"]["id"] == str(s["editor_id"])
    assert body["page"]["published_version_id"] is None
    assert body["page"]["has_unpublished_changes"] is True
    assert _titles(await _tree(client, s["editor"], space, folder)) == [
        "Guide", "Copy of Guide"]

    copy_id = uuid.UUID(body["id"])
    db.expire_all()
    copy_page = await db.get(WikiPage, copy_id)
    assert copy_page.draft_text == "draft words"
    assert copy_page.ydoc is None
    assert (await db.scalars(select(WikiPageVersion).where(
        WikiPageVersion.node_id == copy_id))).all() == []
    assert (await db.scalars(select(WikiGrant).where(
        WikiGrant.node_id == copy_id))).all() == []
    # only the embedded asset is copied, and the copy's content points at
    # the new row (the unused one stays behind)
    assets = (await db.scalars(select(WikiPageAsset).where(
        WikiPageAsset.node_id == copy_id))).all()
    assert [a.storage_key for a in assets] == ["assets/abc.png"]
    assert assets[0].id != used_id
    assert copy_page.draft_json == {"type": "doc", "content": [
        draft["content"][0],
        {"type": "wikiImage", "attrs": {"assetId": str(assets[0].id), "alt": "abc"}}]}

    # into a different parent: no "Copy of"
    resp = await client.post(f"/wiki/nodes/{page['id']}/copy", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 201
    assert resp.json()["title"] == "Guide"


async def test_copy_folder_is_recursive_and_shares_file_objects(client, db):
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["owner"], space, "Folder")
    sub = await _create(client, s["owner"], space, "Sub", kind="page", parent=folder)
    await _create(client, s["owner"], space, "Deep", kind="page", parent=sub)
    gone = await _create(client, s["owner"], space, "Gone", parent=folder)
    assert (await client.delete(f"/wiki/nodes/{gone['id']}",
                                headers=s["owner"])).status_code == 200
    file_node = WikiNode(space_id=uuid.UUID(space["id"]), parent_id=uuid.UUID(folder["id"]),
                         path=[uuid.UUID(folder["id"])], kind="file", title="spec.pdf",
                         position=99999.0)
    db.add(file_node)
    await db.flush()
    db.add(WikiFile(node_id=file_node.id, description="The spec"))
    await db.flush()
    versions = [WikiFileVersion(
        node_id=file_node.id, version_no=n, storage_key=f"files/spec-v{n}",
        filename="spec.pdf", content_type="application/pdf", size_bytes=10 * n,
        preview_kind="pdf", preview_key=f"previews/spec-v{n}.pdf",
        preview_status="ready", extract_status="ready", text_extract="spec text")
        for n in (1, 2)]
    db.add_all(versions)
    await db.flush()
    (await db.get(WikiFile, file_node.id)).current_version_id = versions[1].id
    await db.commit()
    dest = await _create(client, s["owner"], space, "Dest")

    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["owner"],
                             json={"parent_id": dest["id"]})
    assert resp.status_code == 201, resp.text
    copy = resp.json()
    assert copy["title"] == "Folder" and copy["has_children"] is True

    children = await _tree(client, s["owner"], space, copy)
    assert _titles(children) == ["Sub", "spec.pdf"]
    sub_copy, file_copy = children
    assert _titles(await _tree(client, s["owner"], space, sub_copy)) == ["Deep"]
    assert file_copy["file"]["description"] == "The spec"
    assert file_copy["file"]["current_version"]["version_no"] == 1
    assert file_copy["file"]["current_version"]["size_bytes"] == 20
    file_versions = (await db.scalars(select(WikiFileVersion).where(
        WikiFileVersion.node_id == uuid.UUID(file_copy["id"])))).all()
    assert [(v.storage_key, v.preview_key, v.preview_status) for v in file_versions] == [
        ("files/spec-v2", "previews/spec-v2.pdf", "ready")]
    deep_copy = (await _tree(client, s["owner"], space, sub_copy))[0]
    assert (await _node_row(db, deep_copy["id"])).path == [
        uuid.UUID(dest["id"]), uuid.UUID(copy["id"]), uuid.UUID(sub_copy["id"])]


async def test_copy_above_the_cap_is_rejected(client, db, monkeypatch):
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["owner"], space, "Big")
    for i in range(3):
        await _create(client, s["owner"], space, f"C{i}", kind="page", parent=folder)
    monkeypatch.setattr(tree, "COPY_LIMIT", 3)
    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["owner"],
                             json={"parent_id": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "too_many"
    assert _titles(await _tree(client, s["owner"], space)).count("Big") == 1


async def test_view_only_copy_takes_only_what_the_caller_can_see(client, db):
    s = await _setup(client, db)
    space = s["space"]
    dest = await _space(client, s["viewer"], default_access="private", name="Mine")
    folder = await _create(client, s["owner"], space, "Shared")
    pub = await _create(client, s["owner"], space, "Pub", kind="page", parent=folder)
    published = {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "published"}]}]}
    await publish_via_db(db, pub["id"], published)
    row = await db.get(WikiPage, uuid.UUID(pub["id"]))
    row.draft_json = {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "secret draft"}]}]}
    await db.commit()
    await _create(client, s["owner"], space, "Unpublished", kind="page", parent=folder)
    hidden = await _create(client, s["owner"], space, "Hidden", parent=folder)
    await _break_inheritance(db, hidden["id"], person_id=s["owner_id"])

    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["viewer"],
                             json={"parent_id": None, "space_id": dest["id"]})
    assert resp.status_code == 201, resp.text
    children = await _tree(client, s["viewer"], dest, resp.json())
    assert _titles(children) == ["Pub"]
    db.expire_all()
    copied = await db.get(WikiPage, uuid.UUID(children[0]["id"]))
    assert copied.draft_json == published

    # no edit on the destination
    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["viewer"],
                             json={"parent_id": None})
    assert resp.status_code == 403


async def test_view_only_copy_takes_only_the_published_contents_assets(client, db):
    s = await _setup(client, db)
    space = s["space"]
    dest = await _space(client, s["viewer"], default_access="private", name="Mine")
    page = await _create(client, s["owner"], space, "Pictures", kind="page")
    page_id = uuid.UUID(page["id"])
    shown = WikiPageAsset(node_id=page_id, storage_key="assets/shown.png",
                          filename="shown.png", content_type="image/png", size_bytes=5)
    secret = WikiPageAsset(node_id=page_id, storage_key="assets/secret.png",
                           filename="secret.png", content_type="image/png", size_bytes=5)
    db.add_all([shown, secret])
    await db.flush()
    shown_image = {"type": "wikiImage", "attrs": {"assetId": str(shown.id)}}
    await publish_via_db(db, page_id, {"type": "doc", "content": [shown_image]})
    row = await db.get(WikiPage, page_id)
    row.draft_json = {"type": "doc", "content": [
        shown_image,
        {"type": "fileEmbed", "attrs": {"assetId": str(secret.id), "filename": "s"}}]}
    await db.commit()

    resp = await client.post(f"/wiki/nodes/{page['id']}/copy", headers=s["viewer"],
                             json={"parent_id": None, "space_id": dest["id"]})
    assert resp.status_code == 201, resp.text
    copy_id = uuid.UUID(resp.json()["id"])
    db.expire_all()
    assets = (await db.scalars(select(WikiPageAsset).where(
        WikiPageAsset.node_id == copy_id))).all()
    assert [a.storage_key for a in assets] == ["assets/shown.png"]
    copied = await db.get(WikiPage, copy_id)
    assert copied.draft_json == {"type": "doc", "content": [
        {"type": "wikiImage", "attrs": {"assetId": str(assets[0].id)}}]}


# ── delete ──────────────────────────────────────────────────────────


async def test_delete_marks_the_live_subtree_with_one_batch(client, db):
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["editor"], space, "Old stuff")
    child = await _create(client, s["editor"], space, "Child", kind="page", parent=folder)
    grandchild = await _create(client, s["editor"], space, "Grandchild", parent=child)
    earlier = await _create(client, s["editor"], space, "Earlier", parent=folder)
    first = await client.delete(f"/wiki/nodes/{earlier['id']}", headers=s["editor"])
    assert first.status_code == 200 and first.json()["count"] == 1

    resp = await client.delete(f"/wiki/nodes/{folder['id']}", headers=s["viewer"])
    assert resp.status_code == 403

    resp = await client.delete(f"/wiki/nodes/{folder['id']}", headers=s["editor"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["count"] == 3
    batch = uuid.UUID(body["batch_id"])
    for node in (folder, child, grandchild):
        row = await _node_row(db, node["id"])
        assert row.deleted_batch == batch
        assert row.deleted_by == s["editor_id"]
        assert row.deleted_at is not None
    assert (await _node_row(db, earlier["id"])).deleted_batch == uuid.UUID(
        first.json()["batch_id"])

    assert "Old stuff" not in _titles(await _tree(client, s["editor"], space))
    assert (await client.get(f"/wiki/nodes/{child['id']}",
                             headers=s["editor"])).status_code == 404

    resp = await client.delete(f"/wiki/nodes/{space['home_node_id']}", headers=s["owner"])
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "is_home"
    assert resp.json()["detail"]["message"] == "The library's home page can't be deleted."

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.entity_id == folder["id"],
        AuditLog.action == "delete"))).all()
    assert len(audit) == 1


# ── favorites / recent / drafts ─────────────────────────────────────


async def test_favorites_are_idempotent(client, db):
    s = await _setup(client, db)
    space = s["space"]
    page = await _create(client, s["owner"], space, "Fav", kind="page")
    await publish_via_db(db, page["id"])
    folder = await _create(client, s["owner"], space, "Fav folder")

    for _ in range(2):
        resp = await client.put(f"/wiki/nodes/{page['id']}/favorite", headers=s["viewer"])
        assert resp.status_code == 204
    assert (await client.put(f"/wiki/nodes/{folder['id']}/favorite",
                             headers=s["viewer"])).status_code == 204

    favs = (await client.get("/wiki/favorites", headers=s["viewer"])).json()
    assert sorted(_titles(favs)) == ["Fav", "Fav folder"]
    assert all(f["is_favorite"] for f in favs)
    assert (await client.get(f"/wiki/nodes/{page['id']}",
                             headers=s["viewer"])).json()["is_favorite"] is True
    assert (await client.get("/wiki/favorites", headers=s["editor"])).json() == []

    for _ in range(2):
        resp = await client.delete(f"/wiki/nodes/{page['id']}/favorite",
                                   headers=s["viewer"])
        assert resp.status_code == 204
    assert _titles((await client.get("/wiki/favorites",
                                      headers=s["viewer"])).json()) == ["Fav folder"]

    # a node the caller can't view can't be favorited
    hidden = await _create(client, s["owner"], space, "Hidden")
    await _break_inheritance(db, hidden["id"], person_id=s["owner_id"])
    resp = await client.put(f"/wiki/nodes/{hidden['id']}/favorite", headers=s["viewer"])
    assert resp.status_code == 404


async def test_recent_lists_viewable_pages_and_files_newest_first(client, db):
    s = await _setup(client, db)
    space = s["space"]
    other = await _space(client, s["owner"], name="Other")
    old = await _create(client, s["owner"], space, "Old page", kind="page")
    new = await _create(client, s["owner"], space, "New page", kind="page")
    unpublished = await _create(client, s["owner"], space, "Unpublished", kind="page")
    await _create(client, s["owner"], space, "A folder")
    elsewhere = await _create(client, s["owner"], other, "Elsewhere", kind="page")
    for n in (old, new, elsewhere):
        await publish_via_db(db, n["id"])
    now = datetime.now(UTC)
    homes = ({"id": space["home_node_id"]}, {"id": other["home_node_id"]})
    for node, age in ((old, 30), (new, 1), (unpublished, 0), (elsewhere, 5),
                      *((home, 60) for home in homes)):
        row = await _node_row(db, node["id"])
        row.updated_at = now - timedelta(minutes=age)
    await db.commit()

    resp = await client.get("/wiki/recent", headers=s["viewer"],
                            params={"space": space["key"]})
    assert resp.status_code == 200, resp.text
    titles = _titles(resp.json())
    assert titles == ["New page", "Old page", "Tree Space"]
    assert "Unpublished" not in titles and "A folder" not in titles
    assert "Elsewhere" not in titles

    editor_titles = _titles((await client.get(
        "/wiki/recent", headers=s["editor"], params={"space": space["key"]})).json())
    assert editor_titles[0] == "Unpublished"

    mine = {space["id"], other["id"]}
    everywhere = [n for n in (await client.get(
        "/wiki/recent", headers=s["owner"], params={"limit": 50})).json()
        if n["space_id"] in mine]
    assert _titles(everywhere)[:3] == ["Unpublished", "New page", "Elsewhere"]

    limited = (await client.get("/wiki/recent", headers=s["owner"],
                                params={"space": space["key"], "limit": 1})).json()
    assert _titles(limited) == ["Unpublished"]
    assert (await client.get("/wiki/recent", headers=s["owner"],
                             params={"limit": 51})).status_code == 422


async def test_drafts_lists_my_pages_with_unpublished_changes(client, db):
    s = await _setup(client, db)
    space = s["space"]
    mine = await _create(client, s["editor"], space, "My draft", kind="page")
    theirs = await _create(client, s["owner"], space, "Their draft", kind="page")
    clean = await _create(client, s["editor"], space, "Clean", kind="page")
    for node, who, dirty in ((mine, s["editor_id"], True),
                             (theirs, s["owner_id"], True),
                             (clean, s["editor_id"], False)):
        page = await db.get(WikiPage, uuid.UUID(node["id"]))
        page.has_unpublished_changes = dirty
        page.draft_updated_by = who
        page.draft_updated_at = datetime.now(UTC)
    await db.commit()

    drafts = (await client.get("/wiki/drafts", headers=s["editor"])).json()
    assert _titles(drafts) == ["My draft"]
    assert drafts[0]["page"]["has_unpublished_changes"] is True
    assert _titles((await client.get("/wiki/drafts",
                                     headers=s["owner"])).json()) == ["Their draft"]

    # losing edit hides the draft
    await _put_grants(client, s["owner"], space, [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "internal", "level": "view"},
    ])
    assert (await client.get("/wiki/drafts", headers=s["editor"])).json() == []


@pytest.mark.parametrize("path", ["/wiki/favorites", "/wiki/recent", "/wiki/drafts"])
async def test_lists_need_wiki_view(client, db, path):
    resp = await client.get(path)
    assert resp.status_code == 401


async def test_copying_a_file_still_being_processed_queues_its_own_jobs(client, db):
    """The original's pending extract/preview jobs only update the
    original's version row — the copy's needs jobs of its own, or it
    stays "Preparing preview…" and unsearchable forever."""
    s = await _setup(client, db)
    space = s["space"]
    folder = await _create(client, s["owner"], space, "Folder")
    file_node = WikiNode(space_id=uuid.UUID(space["id"]), parent_id=uuid.UUID(folder["id"]),
                         path=[uuid.UUID(folder["id"])], kind="file", title="plan.docx",
                         position=1.0)
    db.add(file_node)
    await db.flush()
    db.add(WikiFile(node_id=file_node.id, description=""))
    version = WikiFileVersion(
        node_id=file_node.id, version_no=1, storage_key="files/plan", filename="plan.docx",
        content_type="application/octet-stream", size_bytes=10, preview_kind="pdf",
        preview_status="pending", extract_status="pending")
    db.add(version)
    await db.flush()
    (await db.get(WikiFile, file_node.id)).current_version_id = version.id
    await db.commit()

    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["owner"],
                             json={"parent_id": None})
    assert resp.status_code == 201, resp.text
    copied = (await _tree(client, s["owner"], space, resp.json()))[0]
    copied_version = await db.scalar(select(WikiFileVersion).where(
        WikiFileVersion.node_id == uuid.UUID(copied["id"])))
    jobs = (await db.scalars(select(WikiJob).where(
        WikiJob.file_version_id == copied_version.id))).all()
    assert sorted(j.kind for j in jobs) == ["file_extract", "file_preview"]
    assert all(j.node_id == uuid.UUID(copied["id"]) for j in jobs)


async def test_a_copied_page_shows_in_the_copiers_drafts(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Checklist", kind="page")
    resp = await client.post(f"/wiki/nodes/{page['id']}/copy", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 201, resp.text
    drafts = await client.get("/wiki/drafts", headers=s["editor"])
    assert [n["id"] for n in drafts.json()] == [resp.json()["id"]]
