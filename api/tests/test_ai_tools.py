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
        "find_sites", "find_stakeholders", "count_records"])
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
