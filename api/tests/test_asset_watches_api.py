"""Asset watches: GET and POST /auth/me/asset-watches, GET /auth/me/asset-watches/state and
PATCH and DELETE /auth/me/asset-watches/{id}. A person watches one asset, on its own or on an
initiative it is on, for its next update or for a status. Each watch keeps a snapshot of the
asset, taken when it was set or last changed (`snapshot`), for the check to compare with. A watch
on the asset needs what the asset's page needs, and one on an initiative what the initiative's
asset list needs. Each write is audited on the person's account, as their other watches are.

Spec: docs/superpowers/specs/2026-11-05-asset-watches-design.md (What counts, Data and API,
Link)"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, event, func, select, text, update
from sqlalchemy.exc import IntegrityError

from serversherpa.db.engine import get_engine, get_sessionmaker
from serversherpa.db.models import (
    Asset,
    AssetWatch,
    AuditLog,
    Client,
    Container,
    ContainerAsset,
    Initiative,
    InitiativeAsset,
    PermissionOverride,
    Person,
    ProcessedScan,
    Site,
    StatusValue,
    Truck,
    TruckContainer,
)
from serversherpa.notifications import asset_watches
from serversherpa.notifications.asset_watches import AssetWatchError, add_asset_watch, snapshot
from tests.test_status_values_write import _make
from tests.test_watches_api import _code, _login, _staff

WATCHES = "/auth/me/asset-watches"
STATE = f"{WATCHES}/state"
NOT_WATCHING = {"watching": False, "watch": None}
T0 = datetime(2026, 11, 5, 15, 0, tzinfo=UTC)


async def _asset(db, serial="SN-1", status="active", **fields) -> Asset:
    """An asset with serial number `serial`, at `status`. Committed."""
    asset = Asset(serial_number=serial, status=status, **fields)
    db.add(asset)
    await db.commit()
    return asset


async def _move(db, name="Move A", **fields) -> Initiative:
    initiative = Initiative(name=name, initiative_type="move", **fields)
    db.add(initiative)
    await db.commit()
    return initiative


async def _row(db, initiative, asset, status="loaded_in_system") -> InitiativeAsset:
    """`asset` on `initiative`'s roster, at `status` there. Committed."""
    row = InitiativeAsset(initiative_id=initiative.id, asset_id=asset.id, status=status)
    db.add(row)
    await db.commit()
    return row


async def _post(client, who, asset_id, initiative_id=None, condition="next_update", status=None):
    body = {"asset_id": str(asset_id),
            "initiative_id": str(initiative_id) if initiative_id is not None else None,
            "condition": condition, "status": status}
    return await client.post(WATCHES, headers=who.headers, json=body)


async def _patch(client, who, watch_id, condition, status=None):
    return await client.patch(f"{WATCHES}/{watch_id}", headers=who.headers,
                              json={"condition": condition, "status": status})


async def _delete(client, who, watch_id):
    return await client.delete(f"{WATCHES}/{watch_id}", headers=who.headers)


async def _list(client, who) -> list[dict]:
    resp = await client.get(WATCHES, headers=who.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _state(client, who, asset_id, initiative_id=None) -> dict:
    params = {"asset_id": str(asset_id)}
    if initiative_id is not None:
        params["initiative_id"] = str(initiative_id)
    resp = await client.get(STATE, headers=who.headers, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _stored(db, watch_id) -> AssetWatch | None:
    """The watch as it is stored now, read afresh."""
    return await db.scalar(
        select(AssetWatch).where(AssetWatch.id == uuid.UUID(str(watch_id)))
        .execution_options(populate_existing=True))


async def _count(db) -> int:
    return await db.scalar(select(func.count()).select_from(AssetWatch))


async def _audits(db, person_id) -> list[AuditLog]:
    """The `watch.*` audit rows written on the person's account, oldest first."""
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "user_account", AuditLog.entity_id == str(person_id),
        AuditLog.action.startswith("watch.")).order_by(AuditLog.at))).all()


# ── setting one ─────────────────────────────────────────────────────

async def test_post_on_asset_returns_201_with_link_and_snapshot(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)

    resp = await _post(client, me, asset.id)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["condition"] == "next_update"
    assert body["initiative_id"] is None
    assert body["link"] == f"/assets/{asset.id}"
    assert (body["asset_id"], body["asset_name"]) == (str(asset.id), "SN-1")
    assert (body["initiative_name"], body["initiative_asset_id"]) == (None, None)
    assert (body["status"], body["status_label"]) == (None, None)
    # a watch set on the asset reads the asset's own status
    assert (body["current_status"], body["current_status_label"]) == ("active", "Active")
    assert body["created_at"]

    stored = await _stored(db, body["id"])
    assert (stored.person_id, stored.asset_id, stored.initiative_id, stored.condition,
            stored.status) == (me.id, asset.id, None, "next_update", None)
    assert set(stored.baseline) == {"asset", "rows", "container_id", "truck_id", "scans"}
    # stored as it was taken, so the check compares like with like
    assert stored.baseline == (await snapshot(db, [asset.id]))[asset.id]


async def test_post_on_initiative_links_to_move_asset_page(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db, status="active")
    move = await _move(db)
    row = await _row(db, move, asset, status="racked")

    resp = await _post(client, me, asset.id, move.id)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["link"] == f"/initiatives/{move.id}/assets/{row.id}"
    assert body["initiative_asset_id"] == str(row.id)
    assert (body["initiative_id"], body["initiative_name"]) == (str(move.id), "Move A")
    # its status on the initiative, not the asset's own
    assert (body["current_status"], body["current_status_label"]) == ("racked", "Racked")
    assert (await _stored(db, body["id"])).initiative_id == move.id


async def test_post_twice_is_already_watching(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    asset = await _asset(db)
    move = await _move(db)
    await _row(db, move, asset)

    assert (await _post(client, me, asset.id)).status_code == 201
    # one watch per asset and place, whatever it waits for
    resp = await _post(client, me, asset.id, condition="status", status="in_transit")
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    # the same asset on an initiative is a separate place
    assert (await _post(client, me, asset.id, move.id)).status_code == 201
    resp = await _post(client, me, asset.id, move.id)
    assert (resp.status_code, _code(resp)) == (409, "already_watching")
    # someone else's watch is their own
    assert (await _post(client, other, asset.id)).status_code == 201
    assert await _count(db) == 3


async def test_status_watch_needs_a_status(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)

    resp = await _post(client, me, asset.id, condition="status")
    assert (resp.status_code, _code(resp)) == (422, "status_required")
    assert await _count(db) == 0


async def test_status_watch_refuses_the_current_status(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db, status="in_transit")
    move = await _move(db)
    await _row(db, move, asset, status="racked")

    resp = await _post(client, me, asset.id, condition="status", status="in_transit")
    assert (resp.status_code, _code(resp)) == (422, "already_at_status")
    resp = await _post(client, me, asset.id, move.id, condition="status", status="racked")
    assert (resp.status_code, _code(resp)) == (422, "already_at_status")
    # each place reads its own status: the asset's status is not the one on the initiative
    resp = await _post(client, me, asset.id, move.id, condition="status", status="in_transit")
    assert resp.status_code == 201, resp.text
    assert (resp.json()["status"], resp.json()["status_label"]) == ("in_transit", "In Transit")
    resp = await _post(client, me, asset.id, condition="status", status="racked")
    assert resp.status_code == 201, resp.text


async def test_bad_status_and_status_on_next_update_are_invalid(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    retired = await db.execute(update(StatusValue)
                               .where(StatusValue.record_type == "asset",
                                      StatusValue.key == "historical")
                               .values(is_active=False))
    assert retired.rowcount == 1        # there is such a status to retire: not a made-up key
    await db.commit()

    # a key no status has, a key of another vocabulary, and an asset status retired from use
    for status in ("bogus", "planned", "historical"):
        resp = await _post(client, me, asset.id, condition="status", status=status)
        assert (resp.status_code, _code(resp)) == (422, "invalid_status"), status
    # a Next update watch names no status
    resp = await _post(client, me, asset.id, condition="next_update", status="in_transit")
    assert (resp.status_code, _code(resp)) == (422, "invalid_status")
    assert await _count(db) == 0


async def test_unknown_condition_is_invalid(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)

    for condition in ("bogus", "scan", ""):
        resp = await _post(client, me, asset.id, condition=condition, status="in_transit")
        assert (resp.status_code, _code(resp)) == (422, "invalid_condition"), condition
    assert await _count(db) == 0


async def test_asset_not_on_initiative(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    move = await _move(db)

    resp = await _post(client, me, asset.id, move.id)
    assert (resp.status_code, _code(resp)) == (422, "not_on_initiative")
    # the place is checked before what the watch waits for
    resp = await _post(client, me, asset.id, move.id, condition="bogus")
    assert (resp.status_code, _code(resp)) == (422, "not_on_initiative")
    # no such asset, or no such initiative
    for asset_id, initiative_id in ((uuid.uuid4(), move.id), (asset.id, uuid.uuid4())):
        resp = await _post(client, me, asset_id, initiative_id)
        assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert await _count(db) == 0


async def test_asset_the_person_cannot_open_is_not_found(client, db):
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    asset_a = await _asset(db, "SN-A", client_id=client_a.id)
    asset_b = await _asset(db, "SN-B", client_id=client_b.id)
    move_a = await _move(db, "Move A", client_id=client_a.id)
    move_b = await _move(db, "Move B", client_id=client_b.id)
    await _row(db, move_a, asset_b)
    person = await _login(db, client, "A", "client_viewer", client_id=client_b.id)

    resp = await _post(client, person, asset_a.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert "SN-A" not in resp.text
    # a missing id answers the same, so the two can't be told apart
    missing = await _post(client, person, uuid.uuid4())
    assert (missing.status_code, missing.json()) == (resp.status_code, resp.json())
    # nor is what the watch waits for checked first
    resp = await _post(client, person, asset_a.id, condition="bogus")
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    # another client's initiative, though their own client's asset is on it
    resp = await _post(client, person, asset_b.id, move_a.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert "Move A" not in resp.text
    # an asset that isn't on their own move: only one they can open is said to be elsewhere
    resp = await _post(client, person, asset_a.id, move_b.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    resp = await _post(client, person, asset_b.id, move_b.id)
    assert (resp.status_code, _code(resp)) == (422, "not_on_initiative")
    # their own client's asset is theirs to watch
    assert (await _post(client, person, asset_b.id)).status_code == 201
    assert await _count(db) == 1


async def test_a_watch_on_an_initiative_needs_the_asset_too(client, db):
    """A watch on an initiative needs the asset's page as well as the initiative's: the check asks
    both when it fires, so no watch can be set that it would end without a notice. Another
    client's asset on their own client's move answers as any asset they can't open does."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    theirs = await _asset(db, "SN-A", client_id=client_a.id)
    other = await _asset(db, "SN-B", client_id=client_b.id)
    move = await _move(db, "Move A", client_id=client_a.id)
    await _row(db, move, theirs)
    await _row(db, move, other)
    person = await _login(db, client, "A", "client_viewer", client_id=client_a.id)

    resp = await _post(client, person, other.id, move.id)
    assert (resp.status_code, _code(resp)) == (404, "thing_not_found")
    assert "SN-B" not in resp.text
    # the same answer as for an asset that isn't there
    missing = await _post(client, person, uuid.uuid4(), move.id)
    assert (missing.status_code, missing.json()) == (resp.status_code, resp.json())
    # their own client's asset on the same move is theirs to watch there
    assert (await _post(client, person, theirs.id, move.id)).status_code == 201
    assert await _count(db) == 1


async def test_a_watch_on_an_initiative_whose_asset_i_cannot_open_is_out_of_sight(client, db):
    """One already stored (set before the asset became another client's) stays stored, out of
    sight: not listed, no Watch state, and not to be changed."""
    client_a, client_b = Client(name="Client A"), Client(name="Client B")
    db.add_all([client_a, client_b])
    await db.commit()
    other = await _asset(db, "SN-B", client_id=client_b.id)
    move = await _move(db, "Move A", client_id=client_a.id)
    await _row(db, move, other)
    person = await _login(db, client, "A", "client_viewer", client_id=client_a.id)
    watch = AssetWatch(person_id=person.id, asset_id=other.id, initiative_id=move.id,
                       condition="next_update",
                       baseline=(await snapshot(db, [other.id]))[other.id])
    db.add(watch)
    await db.commit()

    assert await _list(client, person) == []
    assert await _state(client, person, other.id, move.id) == NOT_WATCHING
    resp = await _patch(client, person, watch.id, "status", "in_transit")
    assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    assert "SN-B" not in resp.text
    assert await _count(db) == 1


# ── changing and stopping one ───────────────────────────────────────

async def test_patch_takes_a_new_snapshot_and_time(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    posted = (await _post(client, me, asset.id)).json()
    set_at = (await _stored(db, posted["id"])).created_at

    # a change made in between
    asset.location_detail = "Cage 4, row 2"
    await db.commit()

    resp = await _patch(client, me, posted["id"], "status", "in_transit")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["id"], body["condition"], body["status"], body["status_label"]) == (
        posted["id"], "status", "in_transit", "In Transit")
    stored = await _stored(db, posted["id"])
    assert (stored.condition, stored.status) == ("status", "in_transit")
    assert stored.created_at > set_at
    assert datetime.fromisoformat(body["created_at"]) == stored.created_at
    assert stored.baseline["asset"]["location_detail"] == "Cage 4, row 2"
    assert stored.baseline == (await snapshot(db, [asset.id]))[asset.id]


async def test_patch_is_checked_as_a_new_watch_is(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    asset = await _asset(db, status="in_transit")
    move = await _move(db)
    row = await _row(db, move, asset, status="racked")
    on_asset = (await _post(client, me, asset.id)).json()["id"]
    on_move = (await _post(client, me, asset.id, move.id)).json()["id"]

    for condition, status, code in (("bogus", None, "invalid_condition"),
                                    ("status", None, "status_required"),
                                    ("next_update", "racked", "invalid_status"),
                                    ("status", "bogus", "invalid_status"),
                                    ("status", "in_transit", "already_at_status")):
        resp = await _patch(client, me, on_asset, condition, status)
        assert (resp.status_code, _code(resp)) == (422, code), code
    # on the initiative it reads the row's status
    resp = await _patch(client, me, on_move, "status", "racked")
    assert (resp.status_code, _code(resp)) == (422, "already_at_status")
    # nobody else's watch, and no watch that never was
    for who, watch_id in ((other, on_asset), (me, uuid.uuid4())):
        resp = await _patch(client, who, watch_id, "next_update")
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found")

    # once the asset has left the initiative, its watch there can't be changed
    await db.delete(row)
    await db.commit()
    resp = await _patch(client, me, on_move, "next_update")
    assert (resp.status_code, _code(resp)) == (422, "not_on_initiative")
    # a watch on what I can no longer open is out of sight
    db.add(PermissionOverride(person_id=me.id, resource="assets", action="view", allow=False))
    await db.commit()
    resp = await _patch(client, me, on_asset, "status", "racked")
    assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    assert "SN-1" not in resp.text
    # nothing was changed
    assert [((await _stored(db, watch_id)).condition) for watch_id in (on_asset, on_move)] == [
        "next_update", "next_update"]


async def test_delete_then_delete_again_is_not_found(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    asset = await _asset(db)
    mine = (await _post(client, me, asset.id)).json()["id"]
    theirs = (await _post(client, other, asset.id)).json()["id"]

    assert (await _delete(client, me, mine)).status_code == 204
    resp = await _delete(client, me, mine)
    assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    # another person's watch is not mine to stop, nor is a watch that never was
    for watch_id in (theirs, uuid.uuid4()):
        resp = await _delete(client, me, watch_id)
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    assert list(await db.scalars(select(AssetWatch.id))) == [uuid.UUID(theirs)]


async def _until_a_connection_waits_on_a_lock() -> None:
    """Wait until a connection to this database is blocked on a lock: the request under test,
    waiting on the watch's row. The limit only ends a hang."""
    async def poll():
        while True:
            async with get_sessionmaker()() as s:
                if await s.scalar(text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE datname = current_database() AND wait_event_type = 'Lock'")):
                    return
            await asyncio.sleep(0.02)

    await asyncio.wait_for(poll(), timeout=10)


async def test_a_change_racing_the_check_finds_the_watch_gone(client, db):
    """The asset-watch check claims watches FOR UPDATE SKIP LOCKED and deletes the ones that end.
    A PATCH or DELETE that comes in meanwhile waits on the watch's row, then finds it gone: 404
    `watch_not_found`, not a 500, and no audit of a change nobody made."""
    me = await _login(db, client, "A")
    asset = await _asset(db)
    for call in (lambda watch_id: _patch(client, me, watch_id, "status", "in_transit"),
                 lambda watch_id: _delete(client, me, watch_id)):
        watch_id = uuid.UUID((await _post(client, me, asset.id)).json()["id"])
        async with get_sessionmaker()() as check:          # the check, holding its claim
            await check.execute(select(AssetWatch).where(AssetWatch.id == watch_id)
                                .with_for_update())
            request = asyncio.create_task(call(watch_id))
            await _until_a_connection_waits_on_a_lock()
            await check.execute(delete(AssetWatch).where(AssetWatch.id == watch_id))
            await check.commit()
        resp = await asyncio.wait_for(request, timeout=10)
        assert (resp.status_code, _code(resp)) == (404, "watch_not_found")
    # only the two watches being set were audited
    assert [row.action for row in await _audits(db, me.id)] == ["watch.add", "watch.add"]


async def test_a_watch_i_can_no_longer_open_can_still_be_stopped(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    watch_id = (await _post(client, me, asset.id)).json()["id"]
    db.add(PermissionOverride(person_id=me.id, resource="assets", action="view", allow=False))
    await db.commit()

    assert (await _delete(client, me, watch_id)).status_code == 204
    assert await _count(db) == 0


# ── the Watch button and the list ───────────────────────────────────

async def test_state_is_per_asset_and_place(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    asset, second = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    move = await _move(db)
    await _row(db, move, asset)

    assert await _state(client, me, asset.id) == NOT_WATCHING
    on_asset = (await _post(client, me, asset.id)).json()
    assert await _state(client, me, asset.id) == {"watching": True, "watch": on_asset}
    # the same asset on the initiative, and another asset, are other places
    assert await _state(client, me, asset.id, move.id) == NOT_WATCHING
    assert await _state(client, me, second.id) == NOT_WATCHING
    on_move = (await _post(client, me, asset.id, move.id, condition="status",
                           status="racked")).json()
    assert await _state(client, me, asset.id, move.id) == {"watching": True, "watch": on_move}
    assert await _state(client, me, asset.id) == {"watching": True, "watch": on_asset}
    # another person's watch is not mine, and an asset that isn't there has none
    assert (await _post(client, other, second.id)).status_code == 201
    assert await _state(client, me, second.id) == NOT_WATCHING
    assert await _state(client, me, uuid.uuid4()) == NOT_WATCHING


async def test_list_shows_only_own_watches_the_person_can_open(client, db):
    me = await _login(db, client, "A")
    other = await _login(db, client, "B")
    asset, second = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    move = await _move(db)
    await _row(db, move, asset)
    on_asset = (await _post(client, me, asset.id)).json()
    on_move = (await _post(client, me, asset.id, move.id)).json()
    theirs = (await _post(client, other, second.id)).json()

    # mine, newest first, and nothing of theirs
    assert await _list(client, me) == [on_move, on_asset]
    assert await _list(client, other) == [theirs]

    # a watch on what I can no longer open stays stored, out of sight
    db.add(PermissionOverride(person_id=me.id, resource="initiatives", action="view",
                              allow=False))
    await db.commit()
    assert await _list(client, me) == [on_asset]
    assert await _state(client, me, asset.id, move.id) == NOT_WATCHING
    assert await _count(db) == 3

    # access comes back, and so does the watch
    await db.execute(delete(PermissionOverride))
    await db.commit()
    assert await _list(client, me) == [on_move, on_asset]


async def test_a_watch_on_an_initiative_the_asset_left_links_to_the_asset(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    move = await _move(db)
    row = await _row(db, move, asset, status="racked")
    watch_id = (await _post(client, me, asset.id, move.id)).json()["id"]
    await db.delete(row)
    await db.commit()

    (listed,) = await _list(client, me)
    assert (listed["id"], listed["link"]) == (watch_id, f"/assets/{asset.id}")
    assert (listed["initiative_id"], listed["initiative_asset_id"]) == (str(move.id), None)
    # it has no status on the initiative to read any more
    assert (listed["current_status"], listed["current_status_label"]) == (None, None)


# ── what is audited ─────────────────────────────────────────────────

async def test_writes_are_audited_on_the_account(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    move = await _move(db)
    await _row(db, move, asset)
    target = {"thing": "asset", "thing_id": str(asset.id), "initiative_id": str(move.id)}

    watch_id = (await _post(client, me, asset.id, move.id)).json()["id"]
    # a refusal writes nothing
    assert (await _post(client, me, asset.id, move.id)).status_code == 409
    assert (await _patch(client, me, watch_id, "status", "in_transit")).status_code == 200
    assert (await _delete(client, me, watch_id)).status_code == 204

    rows = await _audits(db, me.id)
    assert [row.action for row in rows] == ["watch.add", "watch.update", "watch.remove"]
    assert all(row.changes["thing"] == "asset" for row in rows)
    assert {row.actor_person_id for row in rows} == {me.id}
    assert [row.changes for row in rows] == [
        {**target, "condition": "next_update", "status": None},
        {**target, "condition": {"from": "next_update", "to": "status"},
         "status": {"from": None, "to": "in_transit"}},
        target,
    ]


async def test_choosing_the_same_again_still_starts_the_watch_over(client, db):
    me = await _login(db, client, "A")
    asset = await _asset(db)
    watch_id = (await _post(client, me, asset.id)).json()["id"]
    set_at = (await _stored(db, watch_id)).created_at

    assert (await _patch(client, me, watch_id, "next_update")).status_code == 200
    # a new snapshot and time, so it is a change, though what it waits for is the same
    assert (await _stored(db, watch_id)).created_at > set_at
    rows = await _audits(db, me.id)
    assert [(row.action, row.changes) for row in rows][1:] == [
        ("watch.update", {"thing": "asset", "thing_id": str(asset.id), "initiative_id": None})]


# ── read-only mode ──────────────────────────────────────────────────

async def test_writes_blocked_in_read_only_mode(client, db):
    super_admin = await _make(db, client, "super_admin", "sa@test.example.com")
    me = await _login(db, client, "A")
    asset, second = await _asset(db, "SN-1"), await _asset(db, "SN-2")
    watch = (await _post(client, me, asset.id)).json()
    assert (await client.put("/system/admin", headers=super_admin,
                             json={"read_only": True})).status_code == 200

    for resp in (await _post(client, me, second.id),
                 await _patch(client, me, watch["id"], "status", "in_transit"),
                 await _delete(client, me, watch["id"])):
        assert (resp.status_code, _code(resp)) == (423, "read_only_mode")
    # nothing changed; reading is not frozen
    assert await _list(client, me) == [watch]
    assert await _state(client, me, asset.id) == {"watching": True, "watch": watch}


# ── the snapshot ────────────────────────────────────────────────────

async def test_snapshot_reads_rows_container_truck_and_scans(db):
    site = Site(name="Site A")
    db.add(site)
    await db.flush()
    asset = Asset(serial_number="SN-1", status="in_container", site_id=site.id,
                  location_detail="Dock 2", last_seen_at=T0, updated_at=T0)
    bare = Asset(serial_number="SN-2", updated_at=T0)
    container = Container(name="Crate 1")
    move_a = Initiative(name="Move A", initiative_type="move")
    move_b = Initiative(name="Move B", initiative_type="move")
    earlier, later = Truck(name="Truck 1"), Truck(name="Truck 2")
    db.add_all([asset, bare, container, move_a, move_b, earlier, later])
    await db.flush()
    row_a = InitiativeAsset(initiative_id=move_a.id, asset_id=asset.id, status="racked",
                            updated_at=T0 + timedelta(minutes=1))
    row_b = InitiativeAsset(initiative_id=move_b.id, asset_id=asset.id, status="on_truck",
                            updated_at=T0 + timedelta(minutes=2))
    db.add_all([
        row_a, row_b,
        ContainerAsset(container_id=container.id, asset_id=asset.id),
        # the container is on two trucks: the latest load wins
        TruckContainer(truck_id=later.id, container_id=container.id,
                       added_at=T0 + timedelta(minutes=5)),
        TruckContainer(truck_id=earlier.id, container_id=container.id, added_at=T0),
        # every scan counts, an archived one and an off-move sighting too
        ProcessedScan(scanned_value="SN-1", scan_type="barcode", match_type="asset",
                      asset_id=asset.id, scanned_at=T0, processed_at=T0 + timedelta(minutes=1),
                      archived_at=T0 + timedelta(minutes=4)),
        ProcessedScan(scanned_value="SN-1", scan_type="rfid", match_type="asset",
                      asset_id=asset.id, scanned_at=T0, processed_at=T0 + timedelta(minutes=3),
                      off_move=True),
    ])
    await db.commit()

    got = await snapshot(db, [asset.id, bare.id, uuid.uuid4()])
    assert got == {
        asset.id: {
            "asset": {"updated_at": T0.isoformat(), "last_seen_at": T0.isoformat(),
                      "status": "in_container", "site_id": str(site.id),
                      "location_detail": "Dock 2", "archived_at": None},
            "rows": {
                str(row_a.id): {"initiative_id": str(move_a.id), "status": "racked",
                                "updated_at": (T0 + timedelta(minutes=1)).isoformat()},
                str(row_b.id): {"initiative_id": str(move_b.id), "status": "on_truck",
                                "updated_at": (T0 + timedelta(minutes=2)).isoformat()},
            },
            "container_id": str(container.id),
            "truck_id": str(later.id),
            "scans": {"count": 2, "latest": (T0 + timedelta(minutes=3)).isoformat()},
        },
        # nothing to it but its record; an id with no asset is left out
        bare.id: {
            "asset": {"updated_at": T0.isoformat(), "last_seen_at": None, "status": "unknown",
                      "site_id": None, "location_detail": "", "archived_at": None},
            "rows": {},
            "container_id": None,
            "truck_id": None,
            "scans": {"count": 0, "latest": None},
        },
    }
    assert await snapshot(db, []) == {}


async def test_snapshot_skips_archived_containers_and_trucks(db):
    asset = Asset(serial_number="SN-1")
    container = Container(name="Crate 1")
    earlier, later = Truck(name="Truck 1"), Truck(name="Truck 2", archived_at=T0)
    db.add_all([asset, container, earlier, later])
    await db.flush()
    db.add_all([
        ContainerAsset(container_id=container.id, asset_id=asset.id),
        TruckContainer(truck_id=earlier.id, container_id=container.id, added_at=T0),
        TruckContainer(truck_id=later.id, container_id=container.id,
                       added_at=T0 + timedelta(minutes=5)),
    ])
    await db.commit()

    # an archived truck is passed over for the latest load still standing
    got = (await snapshot(db, [asset.id]))[asset.id]
    assert (got["container_id"], got["truck_id"]) == (str(container.id), str(earlier.id))
    # an archived container takes its truck with it
    container.archived_at = T0
    await db.commit()
    got = (await snapshot(db, [asset.id]))[asset.id]
    assert (got["container_id"], got["truck_id"]) == (None, None)


async def test_snapshot_query_count_is_flat_as_assets_grow(db):
    engine = get_engine().sync_engine
    statements: list[str] = []

    def record(conn, cursor, statement, *rest):
        statements.append(statement)

    async def add(n, tag):
        """`n` assets, each packed, on a truck, on a move and scanned."""
        ids = []
        for i in range(n):
            asset = Asset(serial_number=f"{tag}-{i}")
            container, truck = Container(name=f"{tag}-crate-{i}"), Truck(name=f"{tag}-truck-{i}")
            move = Initiative(name=f"{tag}-move-{i}", initiative_type="move")
            db.add_all([asset, container, truck, move])
            await db.flush()
            db.add_all([
                ContainerAsset(container_id=container.id, asset_id=asset.id),
                TruckContainer(truck_id=truck.id, container_id=container.id),
                InitiativeAsset(initiative_id=move.id, asset_id=asset.id),
                ProcessedScan(scanned_value=f"{tag}-{i}", scan_type="barcode",
                              match_type="asset", asset_id=asset.id, scanned_at=T0,
                              processed_at=T0),
            ])
            ids.append(asset.id)
        await db.commit()
        return ids

    async def measure(ids):
        statements.clear()
        event.listen(engine, "before_cursor_execute", record)
        try:
            got = await snapshot(db, ids)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        return len(statements), len(got)

    one = await measure(await add(1, "s"))
    many = await measure(await add(8, "m"))
    assert (one[1], many[1]) == (1, 8)
    assert 0 < one[0] == many[0] <= 5, (one, many)


# ── the module's own rules ──────────────────────────────────────────

async def test_a_lost_race_reads_as_already_watching(db, monkeypatch):
    person, _access = await _staff(db)
    asset = await _asset(db)
    await add_asset_watch(db, person.id, asset_id=asset.id, initiative_id=None,
                          condition="next_update", status=None)
    await db.commit()

    async def nothing_yet(*args, **kwargs):
        return None

    # a second request inserted its watch after this one looked: the unique index answers
    monkeypatch.setattr(asset_watches, "_existing", nothing_yet)
    with pytest.raises(AssetWatchError) as caught:
        await add_asset_watch(db, person.id, asset_id=asset.id, initiative_id=None,
                              condition="next_update", status=None)
    assert (caught.value.status, caught.value.code) == (409, "already_watching")
    # the session still works, and the first watch is the only one
    assert await _count(db) == 1


async def test_the_table_keeps_its_rules(db):
    person = Person(first_name="Person", last_name="A")
    asset, spare = Asset(serial_number="SN-1"), Asset(serial_number="SN-2")
    move = Initiative(name="Move A", initiative_type="move")
    db.add_all([person, asset, spare, move])
    await db.commit()

    def watch(**fields) -> AssetWatch:
        return AssetWatch(**{"person_id": person.id, "asset_id": asset.id,
                             "condition": "next_update", "baseline": {}, **fields})

    async def refused(constraint, row):
        with pytest.raises(IntegrityError, match=constraint):
            async with db.begin_nested():
                db.add(row)
                await db.flush()

    await refused("ck_asset_watches_condition", watch(condition="scan"))
    await refused("ck_asset_watches_status", watch(condition="status"))
    await refused("ck_asset_watches_status", watch(status="in_transit"))
    db.add_all([watch(), watch(initiative_id=move.id), watch(asset_id=spare.id)])
    await db.commit()
    # one per person, asset and place: the index counts the null place as one place
    await refused("uq_asset_watches_target", watch(condition="status", status="in_transit"))
    await refused("uq_asset_watches_target", watch(initiative_id=move.id))

    # a watch goes with its initiative, its asset and its person
    await db.execute(delete(Initiative).where(Initiative.id == move.id))
    assert await _count(db) == 2
    await db.execute(delete(Asset).where(Asset.id == asset.id))
    assert await _count(db) == 1
    await db.execute(delete(Person).where(Person.id == person.id))
    assert await _count(db) == 0
