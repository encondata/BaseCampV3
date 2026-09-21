"""POST /initiatives/{id}/assets/recheck-placement: runs the placement
rule over the roster, restates the three placement statuses, audits
once. 403 without initiatives:change, 404 out of scope, 422 on a
non-move."""

from decimal import Decimal

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AuditLog, Initiative, InitiativeAsset,
)

from .test_assets_api import login
from .test_initiative_assets_api import _move, _project, _view_only_headers


async def _seed_rack(db, initiative_id):
    big = AssetModel(make="Big", model="4U", ru_size=4)
    db.add(big)
    await db.flush()
    a = Asset(serial_number="A", name="a", model_id=big.id)
    b = Asset(serial_number="B", name="b")
    n = Asset(serial_number="N", name="n")
    db.add_all([a, b, n])
    await db.flush()
    db.add_all([
        InitiativeAsset(initiative_id=initiative_id, asset_id=a.id,
                        destination_rack="R1", destination_ru=Decimal("10")),
        InitiativeAsset(initiative_id=initiative_id, asset_id=b.id,
                        destination_rack="R1", destination_ru=Decimal("12")),
        InitiativeAsset(initiative_id=initiative_id, asset_id=n.id,
                        destination_rack="R1", destination_ru=Decimal("20.1")),
    ])
    await db.commit()


async def test_recheck_flags_and_audits(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    await _seed_rack(db, iid)

    resp = await client.post(f"/initiatives/{iid}/assets/recheck-placement",
                             headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"checked": 3, "collisions": 2, "orphans": 1, "cleared": 0}

    rows = (await client.get(f"/initiatives/{iid}/assets", headers=headers)).json()
    by_serial = {r["asset"]["serial_number"]: r for r in rows}
    assert by_serial["A"]["status"] == "location_collision"
    assert by_serial["B"]["status"] == "location_collision"
    assert by_serial["N"]["status"] == "orphan_node"
    assert by_serial["N"]["status_label"] == "Orphan node"

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.entity_id == iid,
        AuditLog.action == "placement_recheck"))).all()
    assert len(audits) == 1
    assert audits[0].changes == {"checked": 3, "collisions": 2, "orphans": 1, "cleared": 0}

    # second run: nothing changes, nothing cleared, still one audit per run
    resp = await client.post(f"/initiatives/{iid}/assets/recheck-placement",
                             headers=headers)
    assert resp.json() == {"checked": 3, "collisions": 2, "orphans": 1, "cleared": 0}


async def test_recheck_requires_change_permission(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    viewer = await _view_only_headers(db, client)
    resp = await client.post(f"/initiatives/{iid}/assets/recheck-placement",
                             headers=viewer)
    assert resp.status_code == 403


async def test_recheck_rejects_a_non_move(client, db, seeded_user):
    headers = await login(client)
    pid = await _project(client, headers)
    resp = await client.post(f"/initiatives/{pid}/assets/recheck-placement",
                             headers=headers)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_a_move"


async def test_recheck_unknown_initiative_is_404(client, db, seeded_user):
    headers = await login(client)
    resp = await client.post(
        "/initiatives/00000000-0000-0000-0000-000000000000/assets/recheck-placement",
        headers=headers)
    assert resp.status_code == 404
