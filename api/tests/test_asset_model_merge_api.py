"""POST /asset-models/{target}/merge — dry run, apply, fills, aliases, guards."""
import uuid
from decimal import Decimal

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Site, StockLine,
)
from tests.test_asset_model_review_api import _model
from tests.test_assets_api import login


async def _stock(db, model_id):
    site = Site(name="WH", site_type="warehouse")
    db.add(site)
    await db.flush()
    db.add(StockLine(site_id=site.id, description="spare", quantity=2, model_id=model_id))
    await db.commit()


async def test_dry_run_plans_moves_fills_and_alias_without_writing(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "PowerEdge R740", aliases=("R740",), assets=2)
    # "dell poweredge r740" collides case-insensitively with the TARGET's
    # own name ("Dell PowerEdge R740"), not with an existing alias row —
    # asset_model_aliases.alias is CITEXT-unique across the whole table,
    # so no two models can ever hold case-variant duplicate alias rows.
    source = await _model(db, "Dell", "PowerEdge_R740",
                          aliases=("dell poweredge r740", "Dell R740 2U"),
                          knowledge="FORCED: make model creation for move F-T", assets=3)
    source.ru_size = 2
    source.weight_lbs, source.weight_kg = Decimal("50.00"), Decimal("22.68")
    source.rail_type = "B7"
    await db.commit()
    await _stock(db, source.id)

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": True})
    assert resp.status_code == 200, resp.text
    plan = resp.json()
    assert plan["applied"] is False and plan["can_merge"] is True
    assert plan["moves"] == {"assets": 3, "stock_lines": 1, "aliases": 1}   # "dell poweredge r740" dropped (== target's name)
    assert plan["fills"] == {"ru_size": 2, "weight_lbs": 50.0, "weight_kg": 22.68, "rail_type": "B7"}
    assert plan["alias_added"] == "Dell PowerEdge_R740"
    assert sorted(plan["aliases_after"]) == sorted(["R740", "Dell R740 2U", "Dell PowerEdge_R740"])
    assert plan["conflicts"] == []
    assert plan["source"]["asset_count"] == 3 and plan["target"]["asset_count"] == 2
    # nothing written
    assert await db.get(AssetModel, source.id) is not None
    assert await db.scalar(select(AuditLog).where(AuditLog.action == "merge")) is None


async def test_merge_applies_everything_and_audits(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "PowerEdge R740", knowledge="Slide latches stick.", assets=1)
    target.length_in, target.width_in, target.height_in = Decimal("30"), Decimal("17"), Decimal("3.5")
    target.length_cm, target.width_cm, target.height_cm = Decimal("76.2"), Decimal("43.18"), Decimal("8.89")
    source = await _model(db, "Dell", "PowerEdge_R740", aliases=("Dell R740 2U",),
                          knowledge="FORCED: hybrid", assets=2)
    source.category = "server"
    source.length_in = Decimal("31")       # target's dims are set -> no fill
    await db.commit()
    await _stock(db, source.id)

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] is True
    await db.refresh(target)
    # not db.get(): source is still resident in this session's identity map
    # from _model()'s commit above, and get() returns an identity-mapped
    # instance without requerying — it can't see a delete made through the
    # app's own (separate) request-scoped session. select() always hits the DB.
    assert await db.scalar(select(AssetModel).where(AssetModel.id == source.id)) is None
    assets = list(await db.scalars(select(Asset.id).where(Asset.model_id == target.id)))
    assert len(assets) == 3
    assert await db.scalar(select(StockLine.model_id).limit(1)) == target.id
    aliases = set(await db.scalars(select(AssetModelAlias.alias).where(
        AssetModelAlias.model_id == target.id)))
    assert aliases == {"Dell R740 2U", "Dell PowerEdge_R740"}
    assert target.category == "server"
    assert target.length_in == Decimal("30.00")        # untouched
    assert target.knowledge.startswith("Slide latches stick.\n\nMerged from Dell PowerEdge_R740 on ")
    assert target.knowledge.endswith("\nFORCED: hybrid")
    rows = {r.action: r for r in await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.action.in_(("merge", "merged_into"))))}
    assert rows["merge"].entity_id == str(target.id)
    assert rows["merge"].changes["moves"] == {"assets": 2, "stock_lines": 1, "aliases": 1}
    assert rows["merge"].changes["fills"] == {"category": "server"}
    assert rows["merged_into"].entity_id == str(source.id)
    assert rows["merged_into"].changes["target_id"] == str(target.id)


async def test_notes_when_target_has_none(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "HPE", "DL380")
    source = await _model(db, "HPE", "DL 380")
    await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                      json={"source_id": str(source.id), "dry_run": False})
    await db.refresh(target)
    assert target.knowledge.startswith("Merged from HPE DL 380 on ")


async def test_alias_conflict_blocks_real_run(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "R640")
    source = await _model(db, "Dell", "R-640", aliases=("R640 rack",))
    third = await _model(db, "Dell", "R650", aliases=("Dell R-640",))    # owns the source's NAME as alias
    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": True})
    plan = resp.json()
    assert plan["can_merge"] is False
    assert plan["conflicts"] == [{"alias": "Dell R-640", "model_id": str(third.id),
                                  "make": "Dell", "model": "R650"}]
    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "alias_conflict"
    assert await db.get(AssetModel, source.id) is not None


async def test_merge_guards(client, db, seeded_user):
    hdrs = await login(client)
    a = await _model(db, "Dell", "R740")
    resp = await client.post(f"/asset-models/{a.id}/merge", headers=hdrs,
                             json={"source_id": str(a.id), "dry_run": True})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "cannot_merge_self"
    resp = await client.post(f"/asset-models/{a.id}/merge", headers=hdrs,
                             json={"source_id": str(uuid.uuid4()), "dry_run": True})
    assert resp.status_code == 404
    resp = await client.post(f"/asset-models/{uuid.uuid4()}/merge", headers=hdrs,
                             json={"source_id": str(a.id), "dry_run": True})
    assert resp.status_code == 404
