"""HTTP tests for the wiki trash — Task 8: listing a space's deleted
batches (`GET /spaces/{key}/trash`), restoring one (`POST
/trash/{batch_id}/restore`, back under its parent or — when that parent
is itself in the trash or gone — at the space root), and deleting one
forever (`DELETE /trash/{batch_id}`, which queues a `purge` job for the
batch's storage keys before the rows go)."""
import uuid
from datetime import timedelta

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog,
    Client,
    WikiFile,
    WikiFileVersion,
    WikiJob,
    WikiNode,
    WikiPageAsset,
    WikiSpace,
)
from serversherpa.wiki import tree
from tests.wiki_helpers import _create, _setup, login_as


async def _delete(client, headers, node):
    resp = await client.delete(f"/wiki/nodes/{node['id']}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["batch_id"]


async def _trash(client, headers, space, expect=200):
    resp = await client.get(f"/wiki/spaces/{space['key']}/trash", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _node(db, node_id) -> WikiNode:
    return await db.scalar(
        select(WikiNode).where(WikiNode.id == uuid.UUID(str(node_id)))
        .execution_options(populate_existing=True))


async def _live_siblings(db, space_id, parent_id) -> list[tuple[str, float]]:
    """(id, position) of the live children of `parent_id` (None = the
    space root), ordered by position — for checking that a restored
    root landed last, distinct from whatever else is already there."""
    conds = [WikiNode.space_id == uuid.UUID(str(space_id)), WikiNode.deleted_at.is_(None)]
    conds.append(WikiNode.parent_id.is_(None) if parent_id is None
                 else WikiNode.parent_id == uuid.UUID(str(parent_id)))
    rows = (await db.execute(
        select(WikiNode.id, WikiNode.position).where(*conds)
        .order_by(WikiNode.position))).all()
    return [(str(r.id), r.position) for r in rows]


async def _file_in(db, space, parent, *, key, preview_key=None, title="spec.docx"):
    """A file node with one version, written straight to the DB (the
    upload flow itself is Task 6's business)."""
    space_row = await db.get(WikiSpace, uuid.UUID(space["id"]))
    parent_row = await db.get(WikiNode, uuid.UUID(parent["id"])) if parent else None
    node = await tree.create_node(db, space=space_row, parent=parent_row, kind="file",
                                  title=title, actor_id=None)
    db.add(WikiFile(node_id=node.id, description=""))
    version = WikiFileVersion(
        node_id=node.id, version_no=1, storage_key=key, filename=title,
        content_type="application/octet-stream", size_bytes=10, preview_kind="pdf",
        preview_key=preview_key, preview_status="ready" if preview_key else "failed",
        extract_status="skipped")
    db.add(version)
    await db.flush()
    (await db.get(WikiFile, node.id)).current_version_id = version.id
    await db.commit()
    return node.id


# ── list ─────────────────────────────────────────────────────────────


async def test_trash_lists_each_batch_with_its_root(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    await _create(client, s["owner"], s["space"], "Failover", kind="page", parent=folder)
    loose = await _create(client, s["owner"], s["space"], "Loose note", kind="page")

    folder_batch = await _delete(client, s["owner"], folder)
    loose_batch = await _delete(client, s["editor"], loose)

    batches = await _trash(client, s["owner"], s["space"])
    assert [b["batch_id"] for b in batches] == [loose_batch, folder_batch]   # newest first

    by_id = {b["batch_id"]: b for b in batches}
    runbooks = by_id[folder_batch]
    assert runbooks["root"] == {"id": folder["id"], "title": "Runbooks", "kind": "folder"}
    assert runbooks["count"] == 2
    assert runbooks["deleted_by"]["id"] == str(s["owner_id"])
    assert by_id[loose_batch]["deleted_by"]["id"] == str(s["editor_id"])
    assert by_id[loose_batch]["count"] == 1

    from datetime import datetime
    deleted_at = datetime.fromisoformat(runbooks["deleted_at"])
    purge_at = datetime.fromisoformat(runbooks["purge_at"])
    assert purge_at - deleted_at == timedelta(days=30)


async def test_an_earlier_deleted_child_is_its_own_batch(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    child = await _create(client, s["owner"], s["space"], "Old", kind="page", parent=folder)
    child_batch = await _delete(client, s["owner"], child)
    folder_batch = await _delete(client, s["owner"], folder)

    by_id = {b["batch_id"]: b for b in await _trash(client, s["owner"], s["space"])}
    assert by_id[child_batch]["root"]["id"] == child["id"]
    assert by_id[child_batch]["count"] == 1
    assert by_id[folder_batch]["root"]["id"] == folder["id"]
    assert by_id[folder_batch]["count"] == 1


async def test_trash_list_needs_manage(client, db):
    s = await _setup(client, db)
    await _trash(client, s["editor"], s["space"], expect=403)
    await _trash(client, s["viewer"], s["space"], expect=403)
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    outsider, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    await _trash(client, outsider, s["space"], expect=404)


# ── restore ──────────────────────────────────────────────────────────


async def test_restore_puts_the_batch_back_under_its_parent(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    sub = await _create(client, s["owner"], s["space"], "Network", parent=folder)
    page = await _create(client, s["owner"], s["space"], "VLANs", kind="page", parent=sub)
    batch = await _delete(client, s["owner"], sub)
    # a new sibling takes over the slot `sub` used to occupy under
    # `folder` while `sub` sits in the trash — restoring `sub` must not
    # land it back on top of that live sibling's position
    sibling = await _create(client, s["owner"], s["space"], "Ops", kind="page", parent=folder)

    resp = await client.post(f"/wiki/trash/{batch}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == sub["id"]
    assert body["parent_id"] == folder["id"]
    assert body["my_level"] == "manage"

    for node_id in (sub["id"], page["id"]):
        row = await _node(db, node_id)
        assert row.deleted_at is None and row.deleted_by is None
        assert row.deleted_batch is None
    assert (await _node(db, page["id"])).path == [uuid.UUID(folder["id"]),
                                                   uuid.UUID(sub["id"])]
    tree_resp = await client.get(f"/wiki/spaces/{s['space']['key']}/tree",
                                 headers=s["owner"], params={"parent_id": folder["id"]})
    assert [n["id"] for n in tree_resp.json()] == [sibling["id"], sub["id"]]
    assert await _trash(client, s["owner"], s["space"]) == []

    siblings = await _live_siblings(db, s["space"]["id"], folder["id"])
    assert [node_id for node_id, _ in siblings] == [sibling["id"], sub["id"]]
    assert len({position for _, position in siblings}) == len(siblings)   # distinct

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.action == "restore",
        AuditLog.entity_id == sub["id"]))
    assert audit_row is not None
    assert audit_row.changes["batch_id"] == batch
    assert audit_row.changes["count"] == 2


async def test_restore_goes_to_the_space_root_when_the_parent_is_in_the_trash(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    sub = await _create(client, s["owner"], s["space"], "Network", parent=folder)
    page = await _create(client, s["owner"], s["space"], "VLANs", kind="page", parent=sub)
    sub_batch = await _delete(client, s["owner"], sub)
    await _delete(client, s["owner"], folder)

    resp = await client.post(f"/wiki/trash/{sub_batch}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_id"] is None

    sub_row = await _node(db, sub["id"])
    assert sub_row.parent_id is None and sub_row.path == []
    assert (await _node(db, page["id"])).path == [uuid.UUID(sub["id"])]
    assert (await _node(db, folder["id"])).deleted_at is not None   # still in the trash

    root = await client.get(f"/wiki/spaces/{s['space']['key']}/tree", headers=s["owner"])
    assert sub["id"] in [n["id"] for n in root.json()]
    # the restored subtree is reachable again
    assert (await client.get(f"/wiki/nodes/{page['id']}", headers=s["owner"])).status_code == 200


async def test_restore_goes_to_the_space_root_when_the_parent_is_gone(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    sub = await _create(client, s["owner"], s["space"], "Network", parent=folder)
    page = await _create(client, s["owner"], s["space"], "VLANs", kind="page", parent=sub)
    sub_batch = await _delete(client, s["owner"], sub)
    folder_batch = await _delete(client, s["owner"], folder)

    resp = await client.delete(f"/wiki/trash/{folder_batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    assert await _node(db, folder["id"]) is None
    # deleting the parent's batch forever didn't take the child's batch with it
    assert [b["batch_id"] for b in await _trash(client, s["owner"], s["space"])] == [sub_batch]
    # a live node already sits at the space root sub is about to land in
    root_sibling = await _create(client, s["owner"], s["space"], "Standalone")

    resp = await client.post(f"/wiki/trash/{sub_batch}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_id"] is None
    assert (await _node(db, sub["id"])).path == []
    assert (await _node(db, page["id"])).path == [uuid.UUID(sub["id"])]

    siblings = await _live_siblings(db, s["space"]["id"], None)
    assert siblings[-1][0] == sub["id"]                                # restored root lands last
    assert root_sibling["id"] in [node_id for node_id, _ in siblings]
    assert len({position for _, position in siblings}) == len(siblings)   # distinct
    assert (await _node(db, page["id"])).deleted_at is None


async def test_restore_into_an_archived_space_is_read_only(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Old", kind="page")
    batch = await _delete(client, s["owner"], page)
    admin, _ = await login_as(client, db, roles=("admin",))
    resp = await client.post(f"/wiki/spaces/{s['space']['key']}/archive", headers=admin)
    assert resp.status_code == 200, resp.text

    for headers in (admin, s["owner"]):
        resp = await client.post(f"/wiki/trash/{batch}/restore", headers=headers)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "read_only"
    assert (await _node(db, page["id"])).deleted_at is not None


async def test_trash_actions_need_manage_on_the_space(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Old", kind="page")
    batch = await _delete(client, s["owner"], page)

    for headers in (s["editor"], s["viewer"]):
        resp = await client.post(f"/wiki/trash/{batch}/restore", headers=headers)
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "not_found"
        resp = await client.delete(f"/wiki/trash/{batch}", headers=headers)
        assert resp.status_code == 404, resp.text

    unknown = uuid.uuid4()
    assert (await client.post(f"/wiki/trash/{unknown}/restore",
                              headers=s["owner"])).status_code == 404
    assert (await client.delete(f"/wiki/trash/{unknown}",
                                headers=s["owner"])).status_code == 404
    # a live node's id isn't a batch either
    assert (await client.delete(f"/wiki/trash/{s['space']['home_node_id']}",
                                headers=s["owner"])).status_code == 404
    assert (await _node(db, page["id"])).deleted_at is not None


# ── delete forever ───────────────────────────────────────────────────


async def test_delete_forever_removes_the_rows_and_queues_a_purge(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Specs")
    file_id = await _file_in(db, s["space"], folder, key="wiki/s/a/spec.docx",
                             preview_key="wiki/previews/a.pdf")
    page = await _create(client, s["owner"], s["space"], "Notes", kind="page", parent=folder)
    db.add(WikiPageAsset(node_id=uuid.UUID(page["id"]), storage_key="wiki/s/b/diagram.png",
                         filename="diagram.png", content_type="image/png", size_bytes=5))
    await db.commit()
    batch = await _delete(client, s["owner"], folder)

    resp = await client.delete(f"/wiki/trash/{batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    assert resp.content == b""

    for node_id in (folder["id"], file_id, page["id"]):
        assert await _node(db, node_id) is None
    assert await db.scalar(select(WikiFileVersion).where(
        WikiFileVersion.node_id == file_id)) is None

    jobs = (await db.scalars(select(WikiJob).where(WikiJob.kind == "purge"))).all()
    assert len(jobs) == 1
    assert jobs[0].status == "queued"
    assert sorted(jobs[0].payload["keys"]) == [
        "wiki/previews/a.pdf", "wiki/s/a/spec.docx", "wiki/s/b/diagram.png"]

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "wiki_node", AuditLog.action == "purge",
        AuditLog.entity_id == folder["id"]))
    assert audit_row is not None
    assert audit_row.actor_person_id == s["owner_id"]
    assert audit_row.changes["count"] == 3
    assert await _trash(client, s["owner"], s["space"]) == []


async def test_delete_forever_with_no_objects_queues_nothing(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Empty")
    batch = await _delete(client, s["owner"], folder)
    resp = await client.delete(f"/wiki/trash/{batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    assert (await db.scalars(select(WikiJob))).all() == []


async def test_delete_forever_repaths_what_it_detaches(client, db):
    """A descendant from an older batch is detached to the space root when
    its parent's batch goes forever — its path (and its own descendants')
    must stop naming the purged ancestors, or permissions would resolve
    against a chain that no longer exists."""
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Runbooks")
    sub = await _create(client, s["owner"], s["space"], "Network", parent=folder)
    page = await _create(client, s["owner"], s["space"], "VLANs", kind="page", parent=sub)
    await _delete(client, s["owner"], sub)
    folder_batch = await _delete(client, s["owner"], folder)

    resp = await client.delete(f"/wiki/trash/{folder_batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    sub_row = await _node(db, sub["id"])
    assert (sub_row.parent_id, sub_row.path) == (None, [])
    assert (await _node(db, page["id"])).path == [uuid.UUID(sub["id"])]
