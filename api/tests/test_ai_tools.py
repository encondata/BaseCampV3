"""Tool registry: schema shape, navigate validation, executors + gating."""

from types import SimpleNamespace

import pytest

from serversherpa.ai import tools
from serversherpa.ai.prompts import SYSTEM_PROMPT
from serversherpa.db.models import Client, Initiative, Person, PersonRole


def _user(allow: bool = True):
    return SimpleNamespace(access=SimpleNamespace(
        can=lambda resource, action: allow))


def test_schemas_are_wellformed():
    names = [t["function"]["name"] for t in tools.TOOLS]
    assert sorted(names) == sorted([
        "navigate", "find_moves", "find_assets", "find_people",
        "find_sites", "find_stakeholders", "count_records",
        "move_summary"])
    for t in tools.TOOLS:
        assert t["type"] == "function"
        params = t["function"]["parameters"]
        assert params["type"] == "object"
        assert params["additionalProperties"] is False
        assert t["function"]["description"]


def test_system_prompt_budget():
    assert 500 < len(SYSTEM_PROMPT) < 12000  # ~3K tokens ceiling
    assert "read-only" in SYSTEM_PROMPT.lower()


def test_validate_navigate():
    out = tools.validate_navigate({"page": "assets"})
    assert out == {"page": "assets", "id": None}
    out = tools.validate_navigate(
        {"page": "initiative_detail",
         "id": "0b6ef88e-9d2b-4a7f-8b57-6d38f65d3c21"})
    assert out["page"] == "initiative_detail"
    with pytest.raises(ValueError):
        tools.validate_navigate({"page": "nope"})
    with pytest.raises(ValueError):
        tools.validate_navigate({"page": "initiative_detail"})  # id required
    with pytest.raises(ValueError):
        tools.validate_navigate({"page": "asset_detail", "id": "not-a-uuid"})


async def test_find_moves_filters_and_shape(db):
    db.add(Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="in_progress"))
    db.add(Initiative(name="Broadcom Decommission", initiative_type="move",
                      status="planned"))
    db.add(Initiative(name="Not A Move", initiative_type="project",
                      status="planned"))
    await db.commit()
    out = await tools.run_tool("find_moves", {}, db, _user())
    names = {m["name"] for m in out["moves"]}
    assert names == {"NAP11 Hall Migration", "Broadcom Decommission"}
    out = await tools.run_tool(
        "find_moves", {"status": "in_progress"}, db, _user())
    assert [m["name"] for m in out["moves"]] == ["NAP11 Hall Migration"]
    out = await tools.run_tool("find_moves", {"query": "nap"}, db, _user())
    assert [m["name"] for m in out["moves"]] == ["NAP11 Hall Migration"]
    move = out["moves"][0]
    assert set(move) == {"id", "name", "status"}


async def test_permission_denied_shape(db):
    out = await tools.run_tool("find_moves", {}, db, _user(allow=False))
    assert out == {"error": "permission_denied"}


async def test_count_records_assets_by_client(db):
    c = Client(name="Broadcom")
    db.add(c)
    await db.flush()
    from serversherpa.db.models import Asset
    db.add(Asset(name="a1", client_id=c.id, status="in_storage"))
    db.add(Asset(name="a2", client_id=c.id, status="active"))
    db.add(Asset(name="a3", status="in_storage"))
    await db.commit()
    out = await tools.run_tool("count_records", {
        "entity": "assets",
        "filters": {"client": "Broadcom", "status": "in_storage"}},
        db, _user())
    assert out == {"count": 1}


async def test_find_people_matches_name(db):
    p = Person(first_name="Grace", last_name="Huizing")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="worker"))
    await db.commit()
    out = await tools.run_tool("find_people", {"query": "huiz"}, db, _user())
    assert out["people"][0]["name"] == "Grace Huizing"


async def test_unknown_tool_is_error(db):
    out = await tools.run_tool("explode", {}, db, _user())
    assert "error" in out


async def test_count_records_rejects_unsupported_filters(db):
    """Workers don't support site filter; scans don't support client filter."""
    out = await tools.run_tool(
        "count_records",
        {"entity": "workers", "filters": {"site": "NAP11"}},
        db, _user())
    assert "error" in out
    assert "site" in out["error"]
    assert "workers" in out["error"]

    out = await tools.run_tool(
        "count_records",
        {"entity": "scans", "filters": {"client": "Broadcom"}},
        db, _user())
    assert "error" in out
    assert "client" in out["error"]
    assert "scans" in out["error"]


async def test_count_records_unknown_entity_error(db):
    """Unknown entity should return unknown entity error, not permission_denied."""
    out = await tools.run_tool(
        "count_records",
        {"entity": "trucks"},
        db, _user())
    assert out == {"error": "unknown entity: 'trucks'"}


async def _seed_move_with_assets(db):
    from serversherpa.db.models import Asset, AssetModel, InitiativeAsset
    move = Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="in_progress")
    db.add(move)
    r740 = AssetModel(make="Dell", model="R740", category="server")
    nexus = AssetModel(make="Cisco", model="Nexus 9336C-FX2",
                       category="network")
    db.add_all([r740, nexus])
    await db.flush()
    assets = [Asset(name=f"a{i}", model_id=r740.id) for i in range(3)]
    assets.append(Asset(name="sw1", model_id=nexus.id))
    assets.append(Asset(name="mystery"))          # no catalog model
    db.add_all(assets)
    await db.flush()
    db.add_all([InitiativeAsset(initiative_id=move.id, asset_id=a.id)
                for a in assets])
    await db.commit()
    return move


async def test_move_summary_counts_by_category_and_model(db):
    move = await _seed_move_with_assets(db)
    out = await tools.run_tool("move_summary", {"query": "nap11"}, db, _user())
    assert out["move"]["id"] == str(move.id)
    assert out["move"]["name"] == "NAP11 Hall Migration"
    assert out["asset_count"] == 5
    assert {"category": "server", "count": 3} in out["by_category"]
    assert {"category": "network", "count": 1} in out["by_category"]
    assert {"category": None, "count": 1} in out["by_category"]
    assert out["by_model"][0] == {"model": "Dell R740", "count": 3}


async def test_move_summary_multiple_matches_lists_candidates(db):
    db.add(Initiative(name="NAP11 Hall Migration", initiative_type="move",
                      status="in_progress"))
    db.add(Initiative(name="NAP11 Decommission", initiative_type="move",
                      status="planned"))
    await db.commit()
    out = await tools.run_tool("move_summary", {"query": "nap11"}, db, _user())
    assert "moves" in out and len(out["moves"]) == 2
    assert "asset_count" not in out


async def test_move_summary_no_match(db):
    out = await tools.run_tool("move_summary", {"query": "dallas"}, db,
                               _user())
    assert out == {"moves": []}


async def test_move_summary_permission_denied(db):
    out = await tools.run_tool("move_summary", {"query": "x"}, db,
                               _user(allow=False))
    assert out == {"error": "permission_denied"}
