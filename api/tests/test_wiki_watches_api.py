"""HTTP tests for the wiki watches API (Phase 2 Task 2): `GET /wiki/watches`,
`PUT /wiki/watches`, `DELETE /wiki/watches/{id}` and
`GET /wiki/nodes/{id}/watch`."""
import uuid

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Client, WikiWatch
from tests.wiki_helpers import _create, _put_grants, _setup, login_as, publish_via_db


async def _put(client, headers, expect=200, **body):
    resp = await client.put("/wiki/watches", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _list(client, headers):
    resp = await client.get("/wiki/watches", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _state(client, headers, node_id, expect=200):
    resp = await client.get(f"/wiki/nodes/{node_id}/watch", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _outsider(client, db):
    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    db.add(acme)
    await db.flush()
    headers, _ = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    return headers


async def test_watch_a_node_and_a_space_then_list_them(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")

    node_watch = await _put(client, s["viewer"], node_id=folder["id"])
    assert node_watch["node"] == {"id": folder["id"], "title": "Guides", "kind": "folder"}
    assert node_watch["space"] == {"key": s["space"]["key"], "name": s["space"]["name"]}
    space_watch = await _put(client, s["viewer"], space_id=s["space"]["id"])
    assert space_watch["node"] is None
    assert space_watch["space"] == {"key": s["space"]["key"], "name": s["space"]["name"]}

    # idempotent: the same watch comes back
    again = await _put(client, s["viewer"], node_id=folder["id"])
    assert again["id"] == node_watch["id"]

    listed = await _list(client, s["viewer"])
    assert [w["id"] for w in listed] == [space_watch["id"], node_watch["id"]]
    assert set(listed[0]) == {"id", "node", "space", "created_at"}

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "wiki_watch",
        AuditLog.actor_person_id == s["viewer_id"]))).all()
    assert sorted(a.action for a in audits) == ["watch", "watch"]


async def test_put_needs_exactly_one_target(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _put(client, s["viewer"], expect=422)
    await _put(client, s["viewer"], expect=422, node_id=folder["id"],
               space_id=s["space"]["id"])


async def test_put_is_404_for_what_the_caller_cant_see(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    draft = await _create(client, s["owner"], s["space"], "Draft", kind="page")
    outsider = await _outsider(client, db)

    await _put(client, outsider, expect=404, node_id=folder["id"])
    await _put(client, outsider, expect=404, space_id=s["space"]["id"])
    await _put(client, s["viewer"], expect=404, node_id=str(uuid.uuid4()))
    await _put(client, s["viewer"], expect=404, space_id=str(uuid.uuid4()))
    # a reader can't see a never-published page
    await _put(client, s["viewer"], expect=404, node_id=draft["id"])
    await publish_via_db(db, draft["id"])
    await _put(client, s["viewer"], node_id=draft["id"])


async def test_delete_only_removes_your_own_watch(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    watch = await _put(client, s["viewer"], node_id=folder["id"])

    resp = await client.delete(f"/wiki/watches/{watch['id']}", headers=s["editor"])
    assert resp.status_code == 404
    resp = await client.delete(f"/wiki/watches/{uuid.uuid4()}", headers=s["viewer"])
    assert resp.status_code == 404

    resp = await client.delete(f"/wiki/watches/{watch['id']}", headers=s["viewer"])
    assert resp.status_code == 204
    assert await _list(client, s["viewer"]) == []
    count = await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.entity_type == "wiki_watch", AuditLog.entity_id == watch["id"],
        AuditLog.action == "unwatch"))
    assert count == 1


async def test_list_hides_watches_the_caller_can_no_longer_see(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _put(client, s["viewer"], node_id=folder["id"])
    await _put(client, s["viewer"], space_id=s["space"]["id"])
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
    ])
    assert await _list(client, s["viewer"]) == []
    # the rows stay: access may come back
    count = await db.scalar(select(func.count()).select_from(WikiWatch).where(
        WikiWatch.person_id == s["viewer_id"]))
    assert count == 2


async def test_list_hides_watches_on_trashed_nodes(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    await _put(client, s["viewer"], node_id=folder["id"])
    resp = await client.delete(f"/wiki/nodes/{folder['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert await _list(client, s["viewer"]) == []


async def test_watch_state_reports_how_a_node_is_watched(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Guides")
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page",
                         parent=folder)
    await publish_via_db(db, page["id"])

    assert await _state(client, s["viewer"], page["id"]) == {
        "watching": False, "via": None, "watch_id": None}
    space_watch = await _put(client, s["viewer"], space_id=s["space"]["id"])
    assert await _state(client, s["viewer"], page["id"]) == {
        "watching": True, "via": "space", "watch_id": space_watch["id"]}
    folder_watch = await _put(client, s["viewer"], node_id=folder["id"])
    assert await _state(client, s["viewer"], page["id"]) == {
        "watching": True, "via": "ancestor", "watch_id": folder_watch["id"]}
    page_watch = await _put(client, s["viewer"], node_id=page["id"])
    assert await _state(client, s["viewer"], page["id"]) == {
        "watching": True, "via": "node", "watch_id": page_watch["id"]}

    # the owner auto-watched what they created
    state = await _state(client, s["owner"], page["id"])
    assert state["via"] == "node"

    outsider = await _outsider(client, db)
    await _state(client, outsider, page["id"], expect=404)
