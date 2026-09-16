"""An asset's move history: which move rosters it has appeared on. Scoped by
initiative, not just by asset — an asset can sit on two clients' moves and a
client-anchored user must not learn about the other client's move through it."""

import uuid
from datetime import UTC, datetime

from serversherpa.db.models import (
    Asset, Client, Initiative, InitiativeAsset, Person, PersonRole,
)
from tests.test_assets_api import login, make_login


async def _asset(db, *, name="rack-unit", client_id=None):
    asset = Asset(name=name, client_id=client_id)
    db.add(asset)
    await db.flush()
    return asset


async def _move(db, *, name, client_id=None, start=None, status="planned"):
    init = Initiative(name=name, initiative_type="move", status=status,
                      client_id=client_id, scheduled_start=start)
    db.add(init)
    await db.flush()
    return init


async def _roster(db, init, asset, *, status="loaded_in_system"):
    row = InitiativeAsset(initiative_id=init.id, asset_id=asset.id, status=status)
    db.add(row)
    await db.flush()
    return row


async def test_returns_every_move_newest_scheduled_first(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)
    older = await _move(db, name="Older move",
                        start=datetime(2026, 1, 1, tzinfo=UTC))
    newer = await _move(db, name="Newer move", status="in_progress",
                        start=datetime(2026, 6, 1, tzinfo=UTC))
    row_old = await _roster(db, older, asset)
    row_new = await _roster(db, newer, asset, status="staged")
    await db.commit()

    resp = await client.get(f"/assets/{asset.id}/moves", headers=hdrs)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["initiative_name"] for r in body] == ["Newer move", "Older move"]
    assert body[0]["row_id"] == str(row_new.id)
    assert body[0]["initiative_id"] == str(newer.id)
    assert body[0]["initiative_status"] == "in_progress"
    assert body[0]["initiative_status_label"]      # resolved from the vocabulary
    assert body[0]["asset_status"] == "staged"
    assert body[0]["asset_status_label"]
    assert body[0]["scheduled_start"] is not None
    assert body[1]["row_id"] == str(row_old.id)


async def test_asset_with_no_moves_returns_empty(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db, name="never-moved")
    await db.commit()
    resp = await client.get(f"/assets/{asset.id}/moves", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_unscheduled_move_still_returned(client, db, seeded_user):
    hdrs = await login(client)
    asset = await _asset(db)
    init = await _move(db, name="Unscheduled", start=None)
    await _roster(db, init, asset)
    await db.commit()

    body = (await client.get(f"/assets/{asset.id}/moves", headers=hdrs)).json()

    assert len(body) == 1
    assert body[0]["scheduled_start"] is None
    assert body[0]["scheduled_end"] is None
    assert body[0]["added_at"] is not None


async def test_unknown_asset_is_404(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get(f"/assets/{uuid.uuid4()}/moves", headers=hdrs)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "asset_not_found"


async def test_client_contact_sees_only_their_own_clients_moves(client, db, seeded_user):
    """The security case: one asset, two clients' moves. The contact of client
    A must see A's move and must NOT learn B's move exists."""
    org_a = Client(name="Alpha Corp")
    org_b = Client(name="Beta Corp")
    db.add_all([org_a, org_b])
    await db.flush()

    asset = await _asset(db, name="shared-unit", client_id=org_a.id)
    move_a = await _move(db, name="Alpha move", client_id=org_a.id,
                         start=datetime(2026, 3, 1, tzinfo=UTC))
    move_b = await _move(db, name="Beta move", client_id=org_b.id,
                         start=datetime(2026, 4, 1, tzinfo=UTC))
    await _roster(db, move_a, asset)
    await _roster(db, move_b, asset)

    contact = Person(first_name="Ann", last_name="Alpha")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org_a.id))
    await db.commit()
    hdrs = await make_login(db, client, contact, "ann@alpha.test.example.com")

    body = (await client.get(f"/assets/{asset.id}/moves", headers=hdrs)).json()

    names = [r["initiative_name"] for r in body]
    assert names == ["Alpha move"]
    assert "Beta move" not in names

    # the unscoped admin still sees both, so the filter is scope, not a bug
    admin = await login(client)
    all_names = [r["initiative_name"] for r in
                 (await client.get(f"/assets/{asset.id}/moves", headers=admin)).json()]
    assert set(all_names) == {"Alpha move", "Beta move"}
