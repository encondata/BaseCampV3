"""Tree mutations are serialized per space (final-review I6): every
operation that changes the tree's shape — create, upload a new file,
move, copy, delete, restore, delete forever — takes the space's tree
lock (`tree.lock_space_trees`) before it re-reads what it validates.

Each test holds that lock from a second session, as a concurrent tree
operation would, and checks the request waits for it and then acts on
what the other transaction committed — so two opposite moves can't make
a cycle, and nothing lands under a folder that was just trashed."""
import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import WikiNode, WikiSpace
from serversherpa.services import storage
from serversherpa.wiki import tree
from tests.wiki_helpers import _create, _setup

# long enough that an unblocked request has certainly finished
BLOCK_WINDOW = 0.5


async def _node(db, node_id) -> WikiNode | None:
    return await db.scalar(
        select(WikiNode).where(WikiNode.id == uuid.UUID(str(node_id)))
        .execution_options(populate_existing=True))


async def _blocked_until_released(space_id, request, during=None):
    """Run `request` (a coroutine) while another session holds the
    space's tree lock; assert it waits, run `during(session)` inside that
    other transaction, commit, and return the request's response."""
    async with get_sessionmaker()() as other:
        await tree.lock_space_trees(other, uuid.UUID(str(space_id)))
        task = asyncio.create_task(request)
        await asyncio.sleep(BLOCK_WINDOW)
        assert not task.done(), "the request didn't wait for the space's tree lock"
        if during is not None:
            await during(other)
        await other.commit()
    return await asyncio.wait_for(task, timeout=10)


async def test_opposite_moves_never_make_a_cycle(client, db):
    s = await _setup(client, db)
    a = await _create(client, s["owner"], s["space"], "A")
    b = await _create(client, s["owner"], s["space"], "B")

    async def move_b_into_a(other):
        b_row = await other.get(WikiNode, uuid.UUID(b["id"]))
        a_row = await other.get(WikiNode, uuid.UUID(a["id"]))
        space = await other.get(WikiSpace, uuid.UUID(s["space"]["id"]))
        await tree.move_node(other, b_row, new_parent=a_row, new_space=space)

    resp = await _blocked_until_released(
        s["space"]["id"],
        client.post(f"/wiki/nodes/{a['id']}/move", headers=s["owner"],
                    json={"parent_id": b["id"]}),
        during=move_b_into_a)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_parent"
    assert (await _node(db, a["id"])).parent_id is None
    assert (await _node(db, b["id"])).parent_id == uuid.UUID(a["id"])


async def _trash_in(other, node_id):
    await other.execute(
        update(WikiNode).where(WikiNode.id == uuid.UUID(str(node_id)))
        .values(deleted_at=datetime.now(UTC), deleted_batch=uuid.uuid4()))


async def test_nothing_is_created_under_a_folder_trashed_meanwhile(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Doomed")
    resp = await _blocked_until_released(
        s["space"]["id"],
        client.post("/wiki/nodes", headers=s["owner"], json={
            "space_id": s["space"]["id"], "parent_id": folder["id"],
            "kind": "page", "title": "Orphan"}),
        during=lambda other: _trash_in(other, folder["id"]))
    assert resp.status_code in (404, 422), resp.text
    children = (await db.scalars(select(WikiNode).where(
        WikiNode.parent_id == uuid.UUID(folder["id"])))).all()
    assert children == []


async def test_nothing_is_moved_under_a_folder_trashed_meanwhile(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Doomed")
    page = await _create(client, s["owner"], s["space"], "Mover", kind="page")
    resp = await _blocked_until_released(
        s["space"]["id"],
        client.post(f"/wiki/nodes/{page['id']}/move", headers=s["owner"],
                    json={"parent_id": folder["id"]}),
        during=lambda other: _trash_in(other, folder["id"]))
    assert resp.status_code in (404, 422), resp.text
    assert (await _node(db, page["id"])).parent_id is None


async def test_copy_and_delete_wait_for_the_tree_lock(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _create(client, s["owner"], s["space"], "Page", kind="page")

    resp = await _blocked_until_released(
        s["space"]["id"],
        client.post(f"/wiki/nodes/{page['id']}/copy", headers=s["owner"],
                    json={"parent_id": folder["id"]}))
    assert resp.status_code == 201, resp.text

    resp = await _blocked_until_released(
        s["space"]["id"], client.delete(f"/wiki/nodes/{folder['id']}", headers=s["owner"]))
    assert resp.status_code == 200, resp.text


async def test_restore_and_delete_forever_wait_for_the_tree_lock(client, db):
    s = await _setup(client, db)
    kept = await _create(client, s["owner"], s["space"], "Kept")
    gone = await _create(client, s["owner"], s["space"], "Gone")
    batches = {}
    for node in (kept, gone):
        resp = await client.delete(f"/wiki/nodes/{node['id']}", headers=s["owner"])
        batches[node["id"]] = resp.json()["batch_id"]

    resp = await _blocked_until_released(
        s["space"]["id"],
        client.post(f"/wiki/trash/{batches[kept['id']]}/restore", headers=s["owner"]))
    assert resp.status_code == 200, resp.text

    resp = await _blocked_until_released(
        s["space"]["id"],
        client.delete(f"/wiki/trash/{batches[gone['id']]}", headers=s["owner"]))
    assert resp.status_code == 204, resp.text


async def test_a_new_file_waits_for_the_tree_lock(client, db, monkeypatch):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Uploads")
    resp = await client.post("/wiki/uploads", headers=s["editor"], json={
        "target": "node", "space_id": s["space"]["id"], "parent_id": folder["id"],
        "filename": "notes.txt", "content_type": "text/plain", "size": 5})
    assert resp.status_code == 200, resp.text

    async def _head(key):
        return {"size": 5, "content_type": "text/plain"}
    monkeypatch.setattr(storage, "head_object", _head)

    resp = await _blocked_until_released(
        s["space"]["id"],
        client.post("/wiki/uploads/complete", headers=s["editor"],
                    json={"upload_id": resp.json()["upload_id"]}),
        during=lambda other: _trash_in(other, folder["id"]))
    assert resp.status_code in (404, 422), resp.text
    children = (await db.scalars(select(WikiNode).where(
        WikiNode.parent_id == uuid.UUID(folder["id"])))).all()
    assert children == []


@pytest.mark.parametrize("cross_space", [False, True])
async def test_the_lock_is_per_space(client, db, cross_space):
    """A lock held on an unrelated space doesn't hold anyone up — unless
    the move reaches into it."""
    s = await _setup(client, db)
    other_space = await client.post("/wiki/spaces", headers=s["owner"], json={
        "key": f"lk-{uuid.uuid4().hex[:8]}", "name": "Elsewhere",
        "default_access": "internal"})
    other_space = other_space.json()
    page = await _create(client, s["owner"], s["space"], "Page", kind="page")
    body = {"parent_id": None, **({"space_id": other_space["id"]} if cross_space else {})}

    async with get_sessionmaker()() as other:
        await tree.lock_space_trees(other, uuid.UUID(other_space["id"]))
        task = asyncio.create_task(client.post(
            f"/wiki/nodes/{page['id']}/move", headers=s["owner"], json=body))
        await asyncio.sleep(BLOCK_WINDOW)
        assert task.done() is (not cross_space)
        await other.commit()
    resp = await asyncio.wait_for(task, timeout=10)
    assert resp.status_code == 200, resp.text
