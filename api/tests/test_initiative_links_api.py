"""Initiative links — cross-type nesting, self/duplicate/circular guards."""

import uuid

from .test_assets_api import login


async def _initiative(client, headers, name, itype):
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": name, "initiative_type": itype})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def test_links_roundtrip_and_guards(client, db, seeded_user):
    headers = await login(client)
    a = await _initiative(client, headers, "Alpha", "project")
    b = await _initiative(client, headers, "Bravo", "move")
    c = await _initiative(client, headers, "Charlie", "event")

    # cross-type link: project contains move
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": b, "role": "primary move"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["links_children"][0]["other_name"] == "Bravo"
    assert body["links_children"][0]["other_type"] == "move"
    link_id = body["links_children"][0]["id"]

    # self link
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": a})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "self_link"

    # duplicate
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": b})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_link"

    # chain A→B→C, then C→A must be rejected (any-type cycle guard —
    # V2 only guarded project→project)
    assert (await client.post(f"/initiatives/{b}/links", headers=headers,
                              json={"child_id": c})).status_code == 201
    resp = await client.post(f"/initiatives/{c}/links", headers=headers,
                             json={"child_id": a})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "circular_link"

    # the child sees the link from its side
    resp = await client.get(f"/initiatives/{b}", headers=headers)
    assert resp.json()["links_parents"][0]["other_name"] == "Alpha"
    assert resp.json()["links_count"] == 2

    # update + delete
    resp = await client.patch(f"/initiatives/links/{link_id}",
                              headers=headers, json={"role": "phase 1"})
    assert resp.status_code == 200
    assert resp.json()["role"] == "phase 1"
    assert (await client.delete(f"/initiatives/links/{link_id}",
                                headers=headers)).status_code == 204


async def test_link_add_race_loser_gets_409(client, db, seeded_user,
                                            monkeypatch):
    """The loser of a concurrent duplicate add misses the pre-check and
    hits initiative_links_uniq — that must surface as the same 409, not
    an unhandled IntegrityError."""
    from serversherpa.api.routes import initiatives as initiatives_routes

    headers = await login(client)
    a = await _initiative(client, headers, "Alpha", "project")
    b = await _initiative(client, headers, "Bravo", "move")
    assert (await client.post(f"/initiatives/{a}/links", headers=headers,
                              json={"child_id": b})).status_code == 201

    async def _races_past_check(db, parent_id, child_id):
        return False

    monkeypatch.setattr(initiatives_routes, "_link_exists", _races_past_check)
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": b})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_link"


async def test_link_cycle_race_is_serialized(client, db, seeded_user):
    """Concurrent A→B and B→A: the second add must wait on the link-graph
    lock, then see the committed rival edge — 422, not a stored cycle."""
    import asyncio

    from sqlalchemy import text

    from serversherpa.api.routes.initiatives import LINK_GRAPH_LOCK_KEY
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.db.models import InitiativeLink

    headers = await login(client)
    a = await _initiative(client, headers, "Alpha", "project")
    b = await _initiative(client, headers, "Bravo", "move")

    # a rival transaction holds the graph lock with an uncommitted B→A edge
    async with get_sessionmaker()() as rival:
        await rival.execute(text("SELECT pg_advisory_xact_lock(:key)"),
                            {"key": LINK_GRAPH_LOCK_KEY})
        rival.add(InitiativeLink(parent_id=uuid.UUID(b),
                                 child_id=uuid.UUID(a)))
        await rival.flush()
        task = asyncio.ensure_future(client.post(
            f"/initiatives/{a}/links", headers=headers, json={"child_id": b}))
        await asyncio.sleep(0.2)  # let the request reach its cycle check
        await rival.commit()  # releases the lock

    resp = await task
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "circular_link"


async def test_link_target_404(client, db, seeded_user):
    headers = await login(client)
    a = await _initiative(client, headers, "Alpha", "project")
    resp = await client.post(f"/initiatives/{a}/links", headers=headers,
                             json={"child_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "initiative_not_found"
