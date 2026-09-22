"""GET /asset-models/review (imported + likely duplicates) and dismiss/restore."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Site, StockLine,
)
from tests.test_assets_api import login


async def _model(db, make, model, *, knowledge="", aliases=(), assets=0):
    m = AssetModel(make=make, model=model, knowledge=knowledge)
    db.add(m)
    await db.flush()
    for a in aliases:
        db.add(AssetModelAlias(model_id=m.id, alias=a))
    for i in range(assets):
        db.add(Asset(serial_number=f"{make}-{model}-{i}".lower(), model_id=m.id))
    await db.commit()
    return m


async def test_review_lists_imported_and_duplicate_groups(client, db, seeded_user):
    hdrs = await login(client)
    forced = await _model(db, "Dell", "R740 (Node)",
                          knowledge="FORCED: make model creation for move F-T", assets=1)
    a = await _model(db, "Dell", "PowerEdge R740", assets=3)
    b = await _model(db, "Dell", "PowerEdge_R740", assets=1)          # underscore -> same key
    c = await _model(db, "HPE", "DL380", aliases=("Dell PowerEdge R740 2U",))  # alias key joins the group
    lone = await _model(db, "Cisco", "C9300")
    resp = await client.get("/asset-models/review", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [m["id"] for m in body["imported"]] == [str(forced.id)]
    assert body["imported"][0]["reason"] == "imported"
    assert body["imported"][0]["asset_count"] == 1
    assert len(body["duplicates"]) == 1
    group = body["duplicates"][0]
    assert [m["id"] for m in group] == [str(a.id), str(b.id), str(c.id)]   # 3 assets first, then name
    assert group[0]["group_key"] == "dell poweredge r740"
    assert all(m["reason"] == "duplicate" for m in group)
    assert str(lone.id) not in {m["id"] for g in body["duplicates"] for m in g}
    assert body["dismissed_count"] == 0


async def test_dismiss_hides_restore_shows_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    forced = await _model(db, "Dell", "R740 (Node)", knowledge="forced: hybrid")
    resp = await client.post(f"/asset-models/{forced.id}/review", headers=hdrs,
                             json={"dismissed": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["review_dismissed_at"] is not None
    body = (await client.get("/asset-models/review", headers=hdrs)).json()
    assert body["imported"] == [] and body["dismissed_count"] == 1
    body = (await client.get("/asset-models/review?include_dismissed=true",
                             headers=hdrs)).json()
    assert [m["id"] for m in body["imported"]] == [str(forced.id)]
    assert body["imported"][0]["review_dismissed_at"] is not None
    # no-op dismiss writes no second audit row
    await client.post(f"/asset-models/{forced.id}/review", headers=hdrs,
                      json={"dismissed": True})
    resp = await client.post(f"/asset-models/{forced.id}/review", headers=hdrs,
                             json={"dismissed": False})
    assert resp.json()["review_dismissed_at"] is None
    actions = [r.action for r in await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.entity_id == str(forced.id)))]
    assert actions == ["review.dismiss", "review.restore"]


async def test_dismissed_model_leaves_its_duplicate_group(client, db, seeded_user):
    hdrs = await login(client)
    a = await _model(db, "Dell", "R640")
    b = await _model(db, "Dell", "R640 2U")
    await client.post(f"/asset-models/{b.id}/review", headers=hdrs, json={"dismissed": True})
    body = (await client.get("/asset-models/review", headers=hdrs)).json()
    assert body["duplicates"] == []       # a group of one is not a group
    assert str(a.id) not in {m["id"] for g in body["duplicates"] for m in g}


async def test_review_guards(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post(f"/asset-models/{uuid.uuid4()}/review", headers=hdrs,
                             json={"dismissed": True})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "asset_model_not_found"
