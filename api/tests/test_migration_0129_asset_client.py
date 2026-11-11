"""Migration 0129: assets with no client get the client of their newest
roster row on a client move (the asset_owner_current "newest row" rule)."""

import importlib.util
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import text

from serversherpa.db.models import Asset, Client, Initiative, InitiativeAsset

MIGRATION_PATH = (Path(__file__).resolve().parents[1] / "migrations" / "versions"
                  / "0129_asset_client_backfill.py")


def _load():
    spec = importlib.util.spec_from_file_location("_migration_0129_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _backfill(db):
    m = _load()
    await db.run_sync(lambda s: m.backfill_asset_clients(s.connection()))
    await db.commit()


async def _move(db, owner, name):
    ini = Initiative(name=name, initiative_type="move", status="planned",
                     client_id=owner.id if owner is not None else None)
    db.add(ini)
    await db.flush()
    return ini


async def _on(db, move, asset, when=None):
    row = InitiativeAsset(initiative_id=move.id, asset_id=asset.id)
    if when is not None:
        row.created_at = when
    db.add(row)
    await db.flush()


async def _asset(db, serial, owner=None):
    a = Asset(name=serial, serial_number=serial,
              client_id=owner.id if owner is not None else None)
    db.add(a)
    await db.flush()
    return a


async def _client_of(db, asset):
    return await db.scalar(text("SELECT client_id FROM assets WHERE id = :i"), {"i": asset.id})


async def test_backfill_sets_client_from_move(db):
    acme = Client(name="Acme")
    db.add(acme)
    await db.flush()
    move = await _move(db, acme, "Acme move")
    asset = await _asset(db, "sn-1")
    await _on(db, move, asset)
    await db.commit()
    await _backfill(db)
    assert await _client_of(db, asset) == acme.id


async def test_backfill_newest_client_wins(db):
    acme, bravo = Client(name="Acme"), Client(name="Bravo")
    db.add_all([acme, bravo])
    await db.flush()
    old, new, plain = (await _move(db, acme, "Old"), await _move(db, bravo, "New"),
                       await _move(db, None, "No client"))
    now = datetime.now(UTC)
    asset = await _asset(db, "sn-2")
    await _on(db, old, asset, now - timedelta(days=30))
    await _on(db, new, asset, now - timedelta(days=1))
    await _on(db, plain, asset, now)          # newest overall, but no client
    # the order of insertion must not matter: newest by created_at wins
    flipped = await _asset(db, "sn-3")
    await _on(db, new, flipped, now - timedelta(days=30))
    await _on(db, old, flipped, now - timedelta(days=1))
    await db.commit()
    await _backfill(db)
    assert await _client_of(db, asset) == bravo.id
    assert await _client_of(db, flipped) == acme.id


async def test_backfill_leaves_existing_clients(db):
    acme, charlie = Client(name="Acme"), Client(name="Charlie")
    db.add_all([acme, charlie])
    await db.flush()
    move = await _move(db, acme, "Acme move")
    plain = await _move(db, None, "No client")
    kept = await _asset(db, "sn-kept", charlie)
    await _on(db, move, kept)
    loose = await _asset(db, "sn-loose")             # on a client-less move only
    await _on(db, plain, loose)
    nowhere = await _asset(db, "sn-nowhere")         # on no move at all
    await db.commit()
    await _backfill(db)
    assert await _client_of(db, kept) == charlie.id
    assert await _client_of(db, loose) is None
    assert await _client_of(db, nowhere) is None
    await _backfill(db)                              # re-running changes nothing
    assert await _client_of(db, kept) == charlie.id
