"""POST /asset-models/{target}/merge — dry run, apply, fills, aliases, guards."""
import uuid
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm.exc import StaleDataError

from serversherpa.db.models import (
    Asset, AssetModel, AssetModelAlias, AuditLog, Site, StockLine,
)
from tests.test_asset_model_review_api import _model
from tests.test_assets_api import _client_contact, login


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
    body = resp.json()
    assert body["applied"] is True
    # the target summary is rebuilt AFTER the merge: 1 own + 2 moved assets,
    # and the duplicate's name now sits on it as an alias
    assert body["target"]["asset_count"] == 3
    assert "Dell PowerEdge_R740" in body["target"]["aliases"]
    assert body["source"]["asset_count"] == 2          # as it was before
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
    # the row survives the source's deletion: targetLabel() reads changes.name.to
    assert rows["merged_into"].changes["name"]["to"] == "Dell PowerEdge_R740"


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


async def test_unit_group_fill_lands_on_the_numeric_columns(client, db, seeded_user):
    """The dry run reports fills as floats — check the REAL run writes them
    back onto the Numeric columns, both halves of each unit group."""
    hdrs = await login(client)
    target = await _model(db, "Dell", "PowerEdge R740")           # all specs blank
    source = await _model(db, "Dell", "PowerEdge_R740")
    source.weight_lbs, source.weight_kg = Decimal("50.00"), Decimal("22.68")
    source.length_in, source.width_in, source.height_in = (
        Decimal("32.00"), Decimal("17.00"), Decimal("3.40"))
    source.length_cm, source.width_cm, source.height_cm = (
        Decimal("81.28"), Decimal("43.18"), Decimal("8.64"))
    await db.commit()

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 200, resp.text
    await db.refresh(target)
    assert target.weight_lbs == Decimal("50.00")
    assert target.weight_kg == Decimal("22.68")
    assert target.height_in == Decimal("3.40")
    assert target.width_cm == Decimal("43.18")


async def test_metric_only_source_fills_kg_and_leaves_lbs_null(client, db, seeded_user):
    """A unit group fills as a whole: the half the source never had stays null."""
    hdrs = await login(client)
    target = await _model(db, "HPE", "DL380")
    source = await _model(db, "HPE", "DL 380")
    source.weight_kg = Decimal("10.00")
    await db.commit()

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 200, resp.text
    await db.refresh(target)
    assert target.weight_kg == Decimal("10.00")
    assert target.weight_lbs is None


async def test_source_alias_equal_to_target_name_is_dropped_not_moved(client, db, seeded_user):
    hdrs = await login(client)
    target = await _model(db, "Dell", "R740")
    source = await _model(db, "Dell", "R-740", aliases=("dell r740", "keepme"))

    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 200, resp.text
    # "dell r740" == the target's own name, so it is deleted with the source;
    # "keepme" moves, and the source's name is added as an alias.
    aliases = set(await db.scalars(select(AssetModelAlias.alias)))
    assert aliases == {"keepme", "Dell R-740"}
    assert await db.scalar(select(AssetModel).where(AssetModel.id == source.id)) is None


async def test_concurrent_change_during_apply_is_a_clean_409(client, db, seeded_user,
                                                             monkeypatch):
    """Another request deleting or re-aliasing a model mid-merge surfaces as
    409 merge_conflict, not a 500, and leaves both models alone."""
    hdrs = await login(client)
    target = await _model(db, "Dell", "R740")
    source = await _model(db, "Dell", "R-740")

    def boom(*args, **kwargs):
        raise StaleDataError("x")

    monkeypatch.setattr("serversherpa.api.routes.asset_models.apply_plan", boom)
    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": False})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "merge_conflict"
    assert await db.scalar(select(AssetModel).where(AssetModel.id == source.id)) is not None


async def test_client_actor_cannot_merge(client, db, seeded_user):
    """The catalog is internal-only — a client-anchored actor gets 403."""
    target = await _model(db, "Dell", "R740")
    source = await _model(db, "Dell", "R-740")
    _org, hdrs = await _client_contact(db, client, "Acme M", "mm@acme.example.com")
    resp = await client.post(f"/asset-models/{target.id}/merge", headers=hdrs,
                             json={"source_id": str(source.id), "dry_run": True})
    assert resp.status_code == 403
    assert await db.scalar(select(AssetModel).where(AssetModel.id == source.id)) is not None
