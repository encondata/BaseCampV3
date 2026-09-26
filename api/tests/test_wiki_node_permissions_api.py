"""HTTP tests for GET/PUT /wiki/nodes/{id}/permissions — Task 7b: node
permission overrides (a gap in the original task list, alongside the
already-shipped space-level grants in test_wiki_spaces_api.py)."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Client, WikiGrant, WikiNode
from tests.wiki_helpers import _create, _setup, login_as


async def _permissions(client, headers, node_id, expect=200):
    resp = await client.get(f"/wiki/nodes/{node_id}/permissions", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _put_permissions(client, headers, node_id, *, inherit, grants=None, expect=200):
    body = {"inherit": inherit}
    if grants is not None:
        body["grants"] = grants
    resp = await client.put(
        f"/wiki/nodes/{node_id}/permissions", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


# ── GET ──────────────────────────────────────────────────────────────


async def test_get_permissions_shows_space_and_node_sourced_effective_grants(client, db):
    ctx = await _setup(client, db)
    _other_h, other_id = await login_as(client, db, roles=("staff",))

    folder = await _create(client, ctx["owner"], ctx["space"], "Folder A")
    await _put_permissions(
        client, ctx["owner"], folder["id"], inherit=True,
        grants=[{"principal_type": "person", "principal_id": str(other_id),
                "level": "edit"}])

    page = await _create(client, ctx["owner"], ctx["space"], "Page B",
                         kind="page", parent=folder)

    body = await _permissions(client, ctx["owner"], page["id"])
    assert body["inherit"] is True
    assert body["grants"] == []

    by_key = {(g["principal_type"], g["principal_id"]): g for g in body["effective"]}

    space_entry = by_key[("person", str(ctx["owner_id"]))]
    assert space_entry["level"] == "manage"
    assert space_entry["source"]["kind"] == "space"
    assert space_entry["source"]["node_id"] is None
    assert space_entry["source"]["title"] == ctx["space"]["name"]

    node_entry = by_key[("person", str(other_id))]
    assert node_entry["level"] == "edit"
    assert node_entry["source"]["kind"] == "node"
    assert node_entry["source"]["node_id"] == folder["id"]
    assert node_entry["source"]["title"] == "Folder A"


async def test_get_permissions_viewer_below_manage_is_403(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    resp = await client.get(
        f"/wiki/nodes/{folder['id']}/permissions", headers=ctx["viewer"])
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_get_permissions_unviewable_node_is_404(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    client_row = Client(name="Acme")
    db.add(client_row)
    await db.flush()
    await db.commit()
    outsider_h, _ = await login_as(
        client, db, roles=("client_viewer",), client_id=client_row.id)
    resp = await client.get(
        f"/wiki/nodes/{folder['id']}/permissions", headers=outsider_h)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_found"


# ── PUT: replace ─────────────────────────────────────────────────────


async def test_put_replaces_node_own_grants(client, db):
    ctx = await _setup(client, db)
    _other_h, other_id = await login_as(client, db, roles=("staff",))
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    body = await _put_permissions(
        client, ctx["owner"], folder["id"], inherit=True,
        grants=[{"principal_type": "person", "principal_id": str(other_id),
                "level": "edit"}])

    assert body["inherit"] is True
    assert len(body["grants"]) == 1
    grant = body["grants"][0]
    assert grant["principal_type"] == "person"
    assert grant["principal_id"] == str(other_id)
    assert grant["level"] == "edit"
    assert grant["node_id"] == folder["id"]

    node = await db.get(WikiNode, uuid.UUID(folder["id"]))
    assert node.inherit_permissions is True

    rows = (await db.scalars(
        select(WikiGrant).where(WikiGrant.node_id == node.id)
    )).all()
    assert len(rows) == 1
    assert rows[0].principal_id == str(other_id)
    assert rows[0].level == "edit"


async def test_put_bad_principal_is_422(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    resp = await client.put(
        f"/wiki/nodes/{folder['id']}/permissions", headers=ctx["owner"],
        json={"inherit": True, "grants": [
            {"principal_type": "person", "principal_id": str(uuid.uuid4()),
             "level": "view"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_principal"


# ── PUT: inherit toggle ──────────────────────────────────────────────


async def test_inherit_off_without_grants_copies_effective_set(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    # the viewer only has access via the space's "internal" grant
    node_before = await client.get(
        f"/wiki/nodes/{folder['id']}", headers=ctx["viewer"])
    assert node_before.status_code == 200
    assert node_before.json()["my_level"] == "view"

    body = await _put_permissions(client, ctx["owner"], folder["id"], inherit=False)
    assert body["inherit"] is False
    by_key = {(g["principal_type"], g["principal_id"]): g["level"] for g in body["grants"]}
    assert by_key == {
        ("person", str(ctx["owner_id"])): "manage",
        ("person", str(ctx["editor_id"])): "edit",
        ("internal", None): "view",
    }

    # nothing changed for the viewer yet
    node_after = await client.get(
        f"/wiki/nodes/{folder['id']}", headers=ctx["viewer"])
    assert node_after.status_code == 200
    assert node_after.json()["my_level"] == "view"


async def test_inherit_off_then_dropping_a_principal_removes_their_access(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    # break inheritance and explicitly drop "internal" — the viewer's only grant
    await _put_permissions(
        client, ctx["owner"], folder["id"], inherit=False,
        grants=[
            {"principal_type": "person", "principal_id": str(ctx["owner_id"]),
             "level": "manage"},
            {"principal_type": "person", "principal_id": str(ctx["editor_id"]),
             "level": "edit"},
        ])

    resp = await client.get(f"/wiki/nodes/{folder['id']}", headers=ctx["viewer"])
    assert resp.status_code == 404

    # the space manager (owner) still gets in — managers are always added back
    owner_resp = await client.get(f"/wiki/nodes/{folder['id']}", headers=ctx["owner"])
    assert owner_resp.status_code == 200
    assert owner_resp.json()["my_level"] == "manage"


async def test_inherit_back_on_keeps_own_grants_additive(client, db):
    ctx = await _setup(client, db)
    _other_h, other_id = await login_as(client, db, roles=("staff",))
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    await _put_permissions(
        client, ctx["owner"], folder["id"], inherit=False,
        grants=[{"principal_type": "person", "principal_id": str(other_id),
                "level": "view"}])
    body = await _put_permissions(client, ctx["owner"], folder["id"], inherit=True)
    assert body["inherit"] is True
    assert {(g["principal_type"], g["principal_id"]) for g in body["grants"]} == {
        ("person", str(other_id))}

    # additive: the space's own grants (e.g. editor's edit) still apply too
    resp = await client.get(f"/wiki/nodes/{folder['id']}", headers=ctx["editor"])
    assert resp.status_code == 200
    assert resp.json()["my_level"] == "edit"


# ── PUT: lock-out guard ──────────────────────────────────────────────


async def test_would_lock_out_is_rejected_and_nothing_changes(client, db):
    ctx = await _setup(client, db)
    _outsider_h, outsider_id = await login_as(client, db, roles=("staff",))
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    # give the editor a node-level manage grant that isn't backed by a
    # space-level manage grant, so they can lock themselves out of it
    await _put_permissions(
        client, ctx["owner"], folder["id"], inherit=False,
        grants=[{"principal_type": "person", "principal_id": str(ctx["editor_id"]),
                "level": "manage"}])

    resp = await client.put(
        f"/wiki/nodes/{folder['id']}/permissions", headers=ctx["editor"],
        json={"inherit": False, "grants": [
            {"principal_type": "person", "principal_id": str(outsider_id),
             "level": "view"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "would_lock_out"

    rows = (await db.scalars(
        select(WikiGrant).where(WikiGrant.node_id == uuid.UUID(folder["id"]))
    )).all()
    assert {(r.principal_id, r.level) for r in rows} == {(str(ctx["editor_id"]), "manage")}


# ── audit ────────────────────────────────────────────────────────────


async def test_put_permissions_is_audited(client, db):
    ctx = await _setup(client, db)
    folder = await _create(client, ctx["owner"], ctx["space"], "Folder")

    await _put_permissions(
        client, ctx["owner"], folder["id"], inherit=False,
        grants=[{"principal_type": "person", "principal_id": str(ctx["owner_id"]),
                "level": "manage"}])

    rows = (await db.scalars(
        select(AuditLog).where(AuditLog.entity_id == folder["id"])
        .order_by(AuditLog.at)
    )).all()
    node_rows = [r for r in rows if r.action == "node_permissions"]
    assert len(node_rows) == 1
    row = node_rows[0]
    assert row.entity_type == "wiki_grant"
    assert row.changes["inherit"] == [True, False]
    assert len(row.changes["grants"]) == 2
    before_grants, after_grants = row.changes["grants"]
    assert before_grants == []
    assert after_grants == [{"principal_type": "person",
                             "principal_id": str(ctx["owner_id"]), "level": "manage"}]


# ── tree operations never act on what the caller can't see (I9) ──────


async def _folder_with_a_hidden_page(client, ctx):
    """A folder the editor can edit, holding a page that breaks inheritance
    so only the space's manager (the owner) can see it."""
    folder = await _create(client, ctx["owner"], ctx["space"], "Plans")
    hidden = await _create(client, ctx["owner"], ctx["space"], "Q4 reductions",
                           kind="page", parent=folder)
    await _put_permissions(client, ctx["owner"], hidden["id"], inherit=False, grants=[
        {"principal_type": "person", "principal_id": str(ctx["owner_id"]), "level": "manage"}])
    return folder, hidden


async def _live(db, node_id) -> bool:
    row = await db.scalar(select(WikiNode).where(WikiNode.id == uuid.UUID(node_id))
                          .execution_options(populate_existing=True))
    return row is not None and row.deleted_at is None


async def test_deleting_a_folder_with_items_the_caller_cant_see_is_refused(client, db):
    ctx = await _setup(client, db)
    folder, hidden = await _folder_with_a_hidden_page(client, ctx)
    resp = await client.delete(f"/wiki/nodes/{folder['id']}", headers=ctx["editor"])
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "hidden_items"
    assert await _live(db, folder["id"]) and await _live(db, hidden["id"])

    # someone who can see everything in it may
    resp = await client.delete(f"/wiki/nodes/{folder['id']}", headers=ctx["owner"])
    assert resp.status_code == 200, resp.text


async def test_moving_hidden_items_to_another_space_is_refused(client, db):
    ctx = await _setup(client, db)
    folder, hidden = await _folder_with_a_hidden_page(client, ctx)
    # the editor manages the folder (not the space) and edits another space
    await _put_permissions(client, ctx["owner"], folder["id"], inherit=True, grants=[
        {"principal_type": "person", "principal_id": str(ctx["editor_id"]), "level": "manage"}])
    elsewhere = await client.post("/wiki/spaces", headers=ctx["editor"], json={
        "key": f"hid-{uuid.uuid4().hex[:8]}", "name": "Elsewhere", "default_access": "private"})
    assert elsewhere.status_code == 201, elsewhere.text
    space = elsewhere.json()

    resp = await client.post(f"/wiki/nodes/{folder['id']}/move", headers=ctx["editor"],
                             json={"space_id": space["id"], "parent_id": None})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "hidden_items"
    row = await db.get(WikiNode, uuid.UUID(hidden["id"]), populate_existing=True)
    assert str(row.space_id) == ctx["space"]["id"]

    # within the space the hidden page's own grants still decide who sees it
    other = await _create(client, ctx["owner"], ctx["space"], "Archive")
    resp = await client.post(f"/wiki/nodes/{folder['id']}/move", headers=ctx["editor"],
                             json={"parent_id": other["id"]})
    assert resp.status_code == 200, resp.text
