"""recheck_placement: applies the placement rule to a roster and moves
rows between loaded_in_system / location_collision / orphan_node without
ever touching a row that has progressed past those three."""

from decimal import Decimal

from sqlalchemy import select

from serversherpa.db.models import Asset, AssetModel, Initiative, InitiativeAsset
from serversherpa.racks.recheck import recheck_placement


async def _roster(db, *specs):
    """specs: (serial, status, rack, ru, ru_size_or_None)"""
    ini = Initiative(name="Move R", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    out = {}
    for serial, status, rack, ru, size in specs:
        model = None
        if size is not None:
            model = AssetModel(make="M", model=f"{serial}-model", ru_size=size)
            db.add(model)
            await db.flush()
        asset = Asset(serial_number=serial, name=serial,
                      model_id=model.id if model else None)
        db.add(asset)
        await db.flush()
        ia = InitiativeAsset(initiative_id=ini.id, asset_id=asset.id, status=status,
                             destination_rack=rack,
                             destination_ru=Decimal(str(ru)) if ru is not None else None)
        db.add(ia)
        out[serial] = ia
    await db.commit()
    return ini, out


async def _statuses(db, ini):
    rows = (await db.execute(
        select(Asset.serial_number, InitiativeAsset.status)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .where(InitiativeAsset.initiative_id == ini.id))).all()
    return dict(rows)


async def test_flags_collisions_and_orphans_and_reports_counts(db):
    ini, _ = await _roster(
        db,
        ("big", "loaded_in_system", "R1", 10, 4),
        ("hit", "loaded_in_system", "R1", 12, None),
        ("node", "loaded_in_system", "R1", 20.1, None),
        ("free", "loaded_in_system", "R1", 30, None),
        ("nowhere", "loaded_in_system", None, None, None),
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result == {"checked": 4, "collisions": 2, "orphans": 1, "cleared": 0}
    assert await _statuses(db, ini) == {
        "big": "location_collision", "hit": "location_collision",
        "node": "orphan_node", "free": "loaded_in_system",
        "nowhere": "loaded_in_system"}


async def test_a_progressed_row_is_never_dragged_back(db):
    ini, _ = await _roster(
        db,
        ("racked", "racked", "R1", 10, 4),
        ("hit", "loaded_in_system", "R1", 12, None),
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    # the racked row IS in a collision but keeps its status and is not counted
    assert result["collisions"] == 1
    assert await _statuses(db, ini) == {"racked": "racked", "hit": "location_collision"}


async def test_clears_stale_flags_when_the_condition_is_gone(db):
    ini, rows = await _roster(
        db,
        ("a", "location_collision", "R1", 10, None),
        ("b", "location_collision", "R1", 30, None),
        ("n", "orphan_node", "R1", 10.1, None),          # now contained by "a"
        ("moved", "location_collision", None, None, None),   # no placement any more
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result == {"checked": 3, "collisions": 0, "orphans": 0, "cleared": 4}
    assert set((await _statuses(db, ini)).values()) == {"loaded_in_system"}


async def test_collision_wins_over_orphan_for_the_same_row(db):
    ini, _ = await _roster(
        db,
        ("srv", "loaded_in_system", "R1", 32, 2),
        ("node", "loaded_in_system", "R1", 33.1, None),
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result["collisions"] == 2 and result["orphans"] == 0
    assert (await _statuses(db, ini))["node"] == "location_collision"


async def test_form_factor_mismatch_is_an_orphan(db):
    ini = Initiative(name="Move F", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    chassis_m = AssetModel(make="Dell", model="H5600 chassis", ru_size=4, form_factor="chassis")
    node_m = AssetModel(make="Dell", model="H5600 node", form_factor="node")
    plain_m = AssetModel(make="Dell", model="R740", ru_size=1, form_factor="standalone")
    db.add_all([chassis_m, node_m, plain_m])
    await db.flush()
    specs = [("ch", chassis_m, "33"), ("n1", node_m, "33.1"),
             ("loose", node_m, "40"), ("srv", plain_m, "33.2")]
    for serial, model, ru in specs:
        a = Asset(serial_number=serial, name=serial, model_id=model.id)
        db.add(a)
        await db.flush()
        db.add(InitiativeAsset(initiative_id=ini.id, asset_id=a.id,
                               destination_rack="R1", destination_ru=Decimal(ru)))
    await db.commit()
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result == {"checked": 4, "collisions": 0, "orphans": 2, "cleared": 0}
    st = await _statuses(db, ini)
    assert st == {"ch": "loaded_in_system", "n1": "loaded_in_system",
                  "loose": "orphan_node", "srv": "orphan_node"}
