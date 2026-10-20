"""The label template tree (spec §3.4, §4.1, §4.9): a v2 parent with one DPI
child per entry of its `dpis`, saves that regenerate uncustomized
children, versions, clone, Replace…, typed-name delete, and the rank-80
gate on every mutation."""

import copy
import uuid

from sqlalchemy import func, select

from serversherpa.db.models import (
    AuditLog, GeneratedLabel, LabelTemplate, LabelTemplateSite, LabelTemplateVersion, Site,
)
from tests.test_sites_api import login
from tests.test_status_values_write import _make

URL = "/labels/templates"
SWISS = {"family": "swiss721-cond-bold", "weight": "regular"}


def _field(eid, key, **over):
    el = {"id": eid, "type": "field", "field": key, "x": 0.1, "y": 0.1, "w": 1.5,
          "h": 0.3, "rotation": 0, "display": "text", "font": SWISS, "sizePt": 24,
          "baselineIn": 0.24, "align": "left"}
    el.update(over)
    return el


DESIGN = {"schema": 2, "size": {"w": 4, "h": 2}, "elements": [
    _field("f1", "asset_id", expectedLength=6),
    {"id": "t1", "type": "text", "x": 2.0, "y": 0.1, "w": 1.5, "h": 0.3, "rotation": 0,
     "content": "RU", "font": SWISS, "sizePt": 18, "baselineIn": 0.2, "align": "left"},
]}


def _moved(design, dx=0.1):
    d = copy.deepcopy(design)
    d["elements"][0]["x"] = round(d["elements"][0]["x"] + dx, 4)
    return d


def _added(design):
    d = copy.deepcopy(design)
    d["elements"].append(_field("f9", "serial_number", y=1.0))
    return d


def _body(name="Vegas Destination", **over):
    base = {"name": name, "label_type": "top", "size_key": "4x2", "language_key": "zpl",
            "kind": "design", "design": DESIGN, "samples": {"asset_id": "10482"}}
    base.update(over)
    return base


async def _super(db, client):
    return await _make(db, client, "super_admin", "sa@test.example.com")


async def _create(client, hdrs, **over):
    r = await client.post(URL, headers=hdrs, json=_body(**over))
    assert r.status_code == 201, r.text
    return r.json()


async def _tree(client, hdrs):
    r = await client.get(f"{URL}/tree", headers=hdrs)
    assert r.status_code == 200, r.text
    return r.json()


async def _node(client, hdrs, name):
    return next(p for p in await _tree(client, hdrs) if p["name"] == name)


def _child(parent_node, dpi, *, old=False):
    return next(c for c in parent_node["children"]
                if c["dpi_key"] == dpi and c["is_old"] is old)


def _legacy(name, dpi_key, **over):
    base = {"name": name, "label_type": "top", "size_key": "4x2", "dpi_key": dpi_key,
            "language_key": "zpl", "kind": "code", "code": "^XA^FD{asset_id}^FS^XZ"}
    base.update(over)
    return LabelTemplate(**base)


# ── create ──────────────────────────────────────────────────────────

async def test_create_parent_makes_three_children_named_by_dpi(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    assert (parent["schema_version"], parent["dpi_key"], parent["version"]) == (2, "300", 1)
    assert parent["dpis"] == ["203", "300", "600"]
    assert parent["samples"] == {"asset_id": "10482"}
    assert parent["parent_id"] is None and parent["is_active"] is True

    (node,) = await _tree(client, hdrs)
    assert node["id"] == parent["id"] and node["family"] == "Vegas Destination"
    assert [c["name"] for c in node["children"]] == [
        "Vegas Destination · 203", "Vegas Destination · 300", "Vegas Destination · 600"]
    for child, dpi in zip(node["children"], ("203", "300", "600"), strict=True):
        assert child["parent_id"] == parent["id"] and child["dpi_key"] == dpi
        assert child["dpis"] == [dpi]
        assert child["design"] == DESIGN and child["samples"] == {}
        assert (child["generated_from_version"], child["child_edits"]) == (1, 0)
        assert (child["customized"], child["out_of_date"], child["is_old"]) == (
            False, False, False)
        assert child["is_active"] is True and child["schema_version"] == 2
        assert (child["label_type"], child["size_key"], child["language_key"]) == (
            "top", "4x2", "zpl")

    # every template starts with its first version
    versions = (await client.get(f"{URL}/{parent['id']}/versions", headers=hdrs)).json()
    assert [(v["version"], v["child_edits"], v["label"]) for v in versions] == [(1, 0, "v1")]
    # a code body still creates one plain row, as before
    r = await client.post(URL, headers=hdrs, json={
        "name": "Raw", "label_type": "top", "size_key": "4x2", "dpi_key": "203",
        "language_key": "zpl", "kind": "code", "code": "^XA^XZ"})
    assert r.status_code == 201, r.text
    assert (r.json()["schema_version"], r.json()["dpi_key"], r.json()["dpis"]) == (
        1, "203", ["203"])


async def test_create_rejects_a_taken_child_name_and_a_bad_design(client, db, seeded_user):
    hdrs = await _super(db, client)
    db.add(_legacy("Vegas Destination · 300", "300", is_active=False))
    await db.commit()
    r = await client.post(URL, headers=hdrs, json=_body())
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "label_template_exists"
    bad = copy.deepcopy(DESIGN)
    bad["elements"][0]["display"] = "sparkles"
    r = await client.post(URL, headers=hdrs, json=_body("Other", design=bad))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_design"
    assert await db.scalar(select(func.count()).select_from(LabelTemplate)) == 1


async def test_a_create_or_add_dpi_race_is_a_409(client, db, seeded_user, monkeypatch):
    """api-tree-6: the name and DPI checks read before they insert, so a
    concurrent create or Add DPI (forced here by hiding the rows the checks
    would see) trips a unique index: the same 409 as the check, not a 500."""
    from serversherpa.labels import templates_tree

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)

    async def nothing_taken(db, name):
        return False

    async def no_current_dpis(db, parent):
        return set()

    monkeypatch.setattr(templates_tree, "name_taken", nothing_taken)
    r = await client.post(URL, headers=hdrs, json=_body())
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "label_template_exists"
    r = await client.post(URL, headers=hdrs, json={
        "name": "Vegas Destination", "label_type": "top", "size_key": "4x2", "dpi_key": "203",
        "language_key": "zpl", "kind": "code", "code": "^XA^XZ"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "label_template_exists"
    monkeypatch.setattr(templates_tree, "current_dpis", no_current_dpis)
    r = await client.post(f"{URL}/{parent['id']}/dpis", headers=hdrs, json={"dpi": "600"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == {"code": "dpi_exists", "dpi": "600"}
    assert await db.scalar(select(func.count()).select_from(LabelTemplate)) == 4


# ── save ────────────────────────────────────────────────────────────

async def test_parent_save_regenerates_uncustomized_children_and_flags_customized(
        client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")

    own = _added(DESIGN)
    r = await client.patch(f"{URL}/{c300['id']}", headers=hdrs, json={"design": own})
    assert r.status_code == 200, r.text
    assert (r.json()["customized"], r.json()["child_edits"]) == (True, 1)
    assert r.json()["out_of_date"] == []

    new = _moved(DESIGN)
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"design": new, "samples": {"asset_id": "7"}})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2 and r.json()["samples"] == {"asset_id": "7"}
    assert r.json()["out_of_date"] == [c300["id"]]

    node = await _node(client, hdrs, "Vegas Destination")
    for dpi in ("203", "600"):
        c = _child(node, dpi)
        assert c["design"] == new and c["generated_from_version"] == 2
        assert (c["customized"], c["out_of_date"]) == (False, False)
    kept = _child(node, "300")
    # Review Focus 3: the customized child is kept and flagged, never overwritten
    assert kept["design"] == own and kept["generated_from_version"] == 1
    assert (kept["customized"], kept["out_of_date"], kept["child_edits"]) == (True, True, 1)

    # a no-op save writes no version
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"design": new})
    assert r.json()["version"] == 2
    # a child takes only its design (and activation): the rest is the parent's
    r = await client.patch(f"{URL}/{kept['id']}", headers=hdrs, json={"name": "Mine"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_field"
    # v1 designs never reach a tree row
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"design": {"size": {"w": 4, "h": 2}, "elements": []}})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_design"


async def test_parent_metadata_flows_to_children(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, is_active=False)  # Rename… needs it off
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"name": "Vegas Dest", "language_key": "zpl",
                                 "description": "Renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2  # the rename's version ("Renamed from …")
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"description": "Again"})
    assert r.json()["version"] == 2  # other metadata is not a version
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"size_key": "2x1"})
    assert r.status_code == 200, r.text
    node = await _node(client, hdrs, "Vegas Dest")
    assert [c["name"] for c in node["children"]] == [
        "Vegas Dest · 203", "Vegas Dest · 300", "Vegas Dest · 600"]
    assert {c["size_key"] for c in node["children"]} == {"2x1"}
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"dpi_key": "203"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_field"


async def test_stored_samples_are_capped_like_the_compile(client, db, seeded_user):
    """M3: create and PATCH hold samples to the compile route's caps."""
    hdrs = await _super(db, client)
    many = {f"ft:col {i}": "x" for i in range(201)}
    long_one = {"asset_id": "9" * 501}
    for samples, message in ((many, "at most 200 sample values"),
                             (long_one, "a sample value is at most 500 characters")):
        r = await client.post(URL, headers=hdrs, json=_body(samples=samples))
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {"code": "bad_field", "field": "samples",
                                      "message": message}
    assert await db.scalar(select(func.count()).select_from(LabelTemplate)) == 0
    parent = await _create(client, hdrs)
    for samples, message in ((many, "at most 200 sample values"),
                             (long_one, "a sample value is at most 500 characters")):
        r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                               json={"samples": samples})
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {"code": "bad_field", "field": "samples",
                                      "message": message}
    edge = {**{f"ft:col {i}": "x" for i in range(199)}, "asset_id": "9" * 500}
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"samples": edge})
    assert r.status_code == 200, r.text


async def test_a_samples_only_save_leaves_the_children_alone(client, db, seeded_user):
    """M2: a parent save that changes only the sample values records a
    parent version and nothing else: no child is regenerated, bumped or
    put out of date, and a kiosk's sync doesn't change."""
    from tests.test_kiosk_label_templates_sync import _get, _move

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    r = await client.patch(f"{URL}/{c300['id']}", headers=hdrs, json={"design": _added(DESIGN)})
    assert r.status_code == 200, r.text
    move, *_ = await _move(db)
    await db.commit()
    staff = await login(client)
    sync_before = (await _get(client, staff, move.id)).json()["templates"]
    assert len(sync_before) == 3
    before = (await _node(client, hdrs, "Vegas Destination"))["children"]

    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"samples": {"asset_id": "7"}})
    assert r.status_code == 200, r.text
    assert (r.json()["version"], r.json()["samples"], r.json()["out_of_date"]) == (
        2, {"asset_id": "7"}, [])
    versions = (await client.get(f"{URL}/{parent['id']}/versions", headers=hdrs)).json()
    assert [(v["label"], v["summary"]) for v in versions] == [
        ("v2", "Changed sample values"), ("v1", "Created")]
    assert (await _node(client, hdrs, "Vegas Destination"))["children"] == before
    assert all(c["out_of_date"] is False for c in before)
    for child in before:
        r = await client.get(f"{URL}/{child['id']}/versions", headers=hdrs)
        assert len(r.json()) == (2 if child["id"] == c300["id"] else 1)
    assert (await _get(client, staff, move.id)).json()["templates"] == sync_before

    # a later design save still regenerates and flags as before
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"design": _moved(DESIGN)})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 3 and r.json()["out_of_date"] == [c300["id"]]
    node = await _node(client, hdrs, "Vegas Destination")
    assert _child(node, "203")["generated_from_version"] == 3
    # and a samples-only save after it doesn't clear what is out of date
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"samples": {"asset_id": "8"}})
    assert r.json()["version"] == 4 and r.json()["out_of_date"] == [c300["id"]]
    assert _child(await _node(client, hdrs, "Vegas Destination"), "203")[
        "generated_from_version"] == 3


async def test_a_size_change_rewrites_the_design_size(client, db, seeded_user):
    """contracts-3: a parent's size_key change puts the size into the design
    of the parent and its uncustomized children (a version on each); a
    customized child keeps its own and is out of date."""
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    r = await client.patch(f"{URL}/{c300['id']}", headers=hdrs, json={"design": _added(DESIGN)})
    assert r.status_code == 200, r.text

    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"size_key": "2x1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["size_key"], body["version"], body["design"]["size"]) == (
        "2x1", 2, {"w": 2, "h": 1})
    assert body["design"]["elements"] == DESIGN["elements"]
    assert body["out_of_date"] == [c300["id"]]
    versions = (await client.get(f"{URL}/{parent['id']}/versions", headers=hdrs)).json()
    assert versions[0]["summary"] == "Size changed to 2x1"
    node = await _node(client, hdrs, "Vegas Destination")
    for dpi in ("203", "600"):
        c = _child(node, dpi)
        assert (c["size_key"], c["design"]["size"], c["generated_from_version"]) == (
            "2x1", {"w": 2, "h": 1}, 2)
        newest = (await client.get(f"{URL}/{c['id']}/versions", headers=hdrs)).json()[0]
        assert (newest["label"], newest["summary"]) == ("v2", "Size changed to 2x1")
    kept = _child(node, "300")
    assert kept["size_key"] == "2x1" and kept["design"]["size"] == {"w": 4, "h": 2}
    assert kept["out_of_date"] is True
    # with a design in the same PATCH the size still comes from the list
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"size_key": "4x2", "design": _moved(body["design"])})
    assert r.status_code == 200, r.text
    assert r.json()["design"]["size"] == {"w": 4, "h": 2}
    versions = (await client.get(f"{URL}/{parent['id']}/versions", headers=hdrs)).json()
    assert versions[0]["summary"] == "Moved 1 element, changed the size"


async def test_parent_save_never_overwrites_a_child_customized_meanwhile(
        client, db, seeded_user):
    """api-tree-3: the parent save decides from the children it has locked,
    not from what its session read earlier, so a hand edit committed in
    between is kept (and reported out of date), never overwritten."""
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    async with get_sessionmaker()() as s:
        mine = await s.get(LabelTemplate, uuid.UUID(parent["id"]))
        read = await templates_tree.children_of(s, mine)  # held: the session keeps them
        assert not any(c.customized for c in read)
        # another designer's hand edit commits meanwhile
        r = await client.patch(f"{URL}/{c300['id']}", headers=hdrs,
                               json={"design": _added(DESIGN)})
        assert r.status_code == 200, r.text
        result = await templates_tree.save_parent(s, mine, design=_moved(DESIGN), samples={},
                                                  summary=None, actor_id=None)
        await s.commit()
    assert result["out_of_date"] == [uuid.UUID(c300["id"])]
    kept = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    assert (kept["design"], kept["customized"], kept["out_of_date"]) == (
        _added(DESIGN), True, True)


async def test_a_child_save_waits_for_a_parent_save_in_flight(client, db, seeded_user):
    """api-tree-3, the other way round: a hand edit started from a child read
    before a parent save regenerated it lands on top of that save (its
    version counts on from it), not on the stale read."""
    import asyncio

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    child_id = uuid.UUID(_child(await _node(client, hdrs, "Vegas Destination"), "300")["id"])
    saved = asyncio.Event()

    async def parent_save():
        async with get_sessionmaker()() as s:
            mine = await s.get(LabelTemplate, uuid.UUID(parent["id"]))
            await templates_tree.save_parent(s, mine, design=_moved(DESIGN), samples={},
                                             summary=None, actor_id=None)
            await s.flush()
            saved.set()
            await asyncio.sleep(0.3)  # the child save runs meanwhile
            await s.commit()

    async def child_save():
        async with get_sessionmaker()() as s:
            child = await s.get(LabelTemplate, child_id)  # v1, before the parent save
            await saved.wait()
            await templates_tree.save_child(s, child, design=_added(_moved(DESIGN)),
                                            summary=None, actor_id=None)
            await s.commit()

    await asyncio.gather(parent_save(), child_save())
    row = await db.get(LabelTemplate, child_id)
    await db.refresh(row)
    assert (row.generated_from_version, row.child_edits, row.version, row.customized) == (
        2, 1, 3, True)
    assert row.design == _added(_moved(DESIGN))
    keys = (await db.execute(select(LabelTemplateVersion.version, LabelTemplateVersion.child_edits)
                             .where(LabelTemplateVersion.template_id == child_id))).all()
    assert sorted(keys) == [(1, 0), (2, 0), (2, 1)]


async def test_update_from_parent_reads_the_parent_after_its_lock(client, db, seeded_user):
    """api-tree-4: a parent save in flight when Update from parent starts
    is the design the fresh child is generated from."""
    import asyncio

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    saved_v2 = await _customize_and_save(client, hdrs, parent["id"], c300["id"], 0.1)
    newer = _moved(saved_v2["design"], 0.2)
    saved, loaded = asyncio.Event(), asyncio.Event()

    async def parent_save():
        async with get_sessionmaker()() as s:
            await loaded.wait()
            mine = await s.get(LabelTemplate, uuid.UUID(parent["id"]))
            await templates_tree.save_parent(s, mine, design=newer, samples={},
                                             summary=None, actor_id=None)
            await s.flush()
            saved.set()
            await asyncio.sleep(0.3)  # Update from parent runs meanwhile
            await s.commit()

    async def update():
        async with get_sessionmaker()() as s:
            child = await s.get(LabelTemplate, uuid.UUID(c300["id"]))
            await templates_tree.parent_of(s, child)  # v2, read before the save
            loaded.set()
            await saved.wait()
            fresh, created = await templates_tree.update_from_parent(s, child, None)
            await s.commit()
            return fresh.design, fresh.generated_from_version, created

    _, (design, version, created) = await asyncio.gather(parent_save(), update())
    assert (design, version, created) == (newer, 3, True)


# ── update from parent ──────────────────────────────────────────────

async def _customize_and_save(client, hdrs, parent_id, child_id, dx):
    r = await client.patch(f"{URL}/{child_id}", headers=hdrs, json={"design": _added(DESIGN)})
    assert r.status_code == 200, r.text
    parent = (await client.get(f"{URL}/{parent_id}", headers=hdrs)).json()
    r = await client.patch(f"{URL}/{parent_id}", headers=hdrs,
                           json={"design": _moved(parent["design"], dx)})
    assert r.status_code == 200, r.text
    assert child_id in r.json()["out_of_date"]
    return r.json()


async def test_update_from_parent_keeps_old_child_nested_and_inactive(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    first = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    # a child still following its parent has nothing to update from
    r = await client.post(f"{URL}/{first['id']}/update-from-parent", headers=hdrs)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_customized"

    saved = await _customize_and_save(client, hdrs, parent["id"], first["id"], 0.1)
    r = await client.post(f"{URL}/{first['id']}/update-from-parent", headers=hdrs)
    assert r.status_code == 201, r.text
    fresh = r.json()
    assert fresh["id"] != first["id"] and fresh["name"] == "Vegas Destination · 300"
    assert fresh["design"] == saved["design"] and fresh["customized"] is False
    assert fresh["generated_from_version"] == saved["version"] and fresh["is_active"] is True

    node = await _node(client, hdrs, "Vegas Destination")
    old = _child(node, "300", old=True)
    assert old["id"] == first["id"] and old["name"] == "Vegas Destination · 300 Old"
    assert (old["is_active"], old["customized"], old["out_of_date"]) == (False, True, False)
    assert node["dpis"] == ["203", "300", "600"] and len(node["children"]) == 4

    await _customize_and_save(client, hdrs, parent["id"], fresh["id"], 0.2)
    r = await client.post(f"{URL}/{fresh['id']}/update-from-parent", headers=hdrs)
    assert r.status_code == 201, r.text
    node = await _node(client, hdrs, "Vegas Destination")
    assert [c["name"] for c in node["children"] if c["is_old"]] == [
        "Vegas Destination · 300 Old", "Vegas Destination · 300 Old 2"]
    assert sum(1 for c in node["children"] if c["dpi_key"] == "300" and c["is_active"]) == 1
    # deleting a kept Old child leaves the DPI set alone
    r = await client.delete(f"{URL}/{first['id']}", headers=hdrs)
    assert r.status_code == 204, r.text
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["dpis"] == ["203", "300", "600"]
    assert [c["name"] for c in node["children"] if c["is_old"]] == [
        "Vegas Destination · 300 Old 2"]


# ── delete ──────────────────────────────────────────────────────────

async def test_delete_parent_requires_typed_name_and_cascades(client, db, seeded_user):
    hdrs = await _super(db, client)
    site = Site(name="Vegas")
    db.add(site)
    await db.commit()
    parent = await _create(client, hdrs, site_ids=[str(site.id)])
    c203 = _child(await _node(client, hdrs, "Vegas Destination"), "203")
    db.add(GeneratedLabel(entity_type="asset", entity_id=uuid.uuid4(), label_type="top",
                          template_id=uuid.UUID(c203["id"]), template_version=1,
                          language_key="zpl", dpi_key="203", size_key="4x2", code="^XA^XZ"))
    await db.commit()

    r = await client.get(f"{URL}/{parent['id']}/delete-summary", headers=hdrs)
    assert r.status_code == 200, r.text
    summary = {"children": ["Vegas Destination · 203", "Vegas Destination · 300",
                            "Vegas Destination · 600"], "generated_labels": 1,
               "fallback_dpis_lost": []}
    assert r.json() == summary

    for body in ({"typed_name": "vegas destination"}, {"typed_name": ""}, None):
        r = await client.request("DELETE", f"{URL}/{parent['id']}", headers=hdrs, json=body)
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {"code": "name_mismatch", **summary}
    assert await db.scalar(select(func.count()).select_from(LabelTemplate)) == 4

    r = await client.request("DELETE", f"{URL}/{parent['id']}", headers=hdrs,
                             json={"typed_name": "Vegas Destination"})
    assert r.status_code == 204, r.text
    for model in (LabelTemplate, GeneratedLabel, LabelTemplateVersion, LabelTemplateSite):
        assert await db.scalar(select(func.count()).select_from(model)) == 0, model
    row = await db.scalar(select(AuditLog).where(AuditLog.entity_type == "label_template",
                                                 AuditLog.action == "delete"))
    assert row.changes["generated_labels"] == 1
    assert row.changes["children"] == summary["children"]


async def test_delete_child_removes_dpi_and_add_dpi_restores_it(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c600 = _child(await _node(client, hdrs, "Vegas Destination"), "600")
    r = await client.delete(f"{URL}/{c600['id']}", headers=hdrs)
    assert r.status_code == 204, r.text
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["dpis"] == ["203", "300"]
    assert [c["dpi_key"] for c in node["children"]] == ["203", "300"]

    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"design": _moved(DESIGN)})
    assert r.status_code == 200
    r = await client.post(f"{URL}/{parent['id']}/dpis", headers=hdrs, json={"dpi": "600"})
    assert r.status_code == 201, r.text
    back = r.json()
    assert back["name"] == "Vegas Destination · 600" and back["dpi_key"] == "600"
    assert back["design"] == _moved(DESIGN) and back["generated_from_version"] == 2
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["dpis"] == ["203", "300", "600"] and len(node["children"]) == 3

    r = await client.post(f"{URL}/{parent['id']}/dpis", headers=hdrs, json={"dpi": "600"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "dpi_exists"
    r = await client.post(f"{URL}/{parent['id']}/dpis", headers=hdrs, json={"dpi": "150"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_dpi"
    r = await client.post(f"{URL}/{back['id']}/dpis", headers=hdrs, json={"dpi": "203"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_a_parent"


# ── clone ───────────────────────────────────────────────────────────

async def test_clone_copies_parent_and_children(client, db, seeded_user):
    hdrs = await _super(db, client)
    site = Site(name="Vegas")
    db.add(site)
    await db.commit()
    parent = await _create(client, hdrs, site_ids=[str(site.id)])
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    await client.patch(f"{URL}/{c300['id']}", headers=hdrs, json={"design": _added(DESIGN)})

    r = await client.post(f"{URL}/{parent['id']}/clone", headers=hdrs,
                          json={"name": "Amsterdam Destination"})
    assert r.status_code == 201, r.text
    clone = r.json()
    assert clone["id"] != parent["id"] and clone["name"] == "Amsterdam Destination"
    assert (clone["version"], clone["is_active"], clone["schema_version"]) == (1, False, 2)
    assert clone["design"] == DESIGN and clone["samples"] == {"asset_id": "10482"}
    assert clone["site_ids"] == [str(site.id)] and clone["dpis"] == ["203", "300", "600"]

    node = await _node(client, hdrs, "Amsterdam Destination")
    assert [c["name"] for c in node["children"]] == [
        "Amsterdam Destination · 203", "Amsterdam Destination · 300",
        "Amsterdam Destination · 600"]
    assert all(c["is_active"] is False for c in node["children"])
    assert _child(node, "300")["design"] == _added(DESIGN)
    assert _child(node, "300")["customized"] is True
    assert _child(node, "203")["design"] == DESIGN
    # the source is untouched
    src = await _node(client, hdrs, "Vegas Destination")
    assert len(src["children"]) == 3 and src["is_active"] is True

    r = await client.post(f"{URL}/{parent['id']}/clone", headers=hdrs,
                          json={"name": "amsterdam destination"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "label_template_exists"


# ── versions ────────────────────────────────────────────────────────

async def test_versions_list_and_restore_bumps_version(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    pid = parent["id"]
    await client.patch(f"{URL}/{pid}", headers=hdrs, json={"design": _moved(DESIGN)})
    await client.patch(f"{URL}/{pid}", headers=hdrs,
                       json={"design": _added(_moved(DESIGN)), "summary": "Added the serial"})

    r = await client.get(f"{URL}/{pid}/versions", headers=hdrs)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [v["label"] for v in rows] == ["v3", "v2", "v1"]
    assert rows[0]["summary"] == "Added the serial"
    assert rows[1]["summary"] == "Moved 1 element"  # generated from the design diff
    assert rows[0]["created_by_name"] and "design" not in rows[0]

    one = (await client.get(f"{URL}/{pid}/versions/1/0", headers=hdrs)).json()
    assert one["design"] == DESIGN and one["samples"] == {"asset_id": "10482"}
    r = await client.get(f"{URL}/{pid}/versions/9/0", headers=hdrs)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "unknown_version"

    r = await client.patch(f"{URL}/{pid}/versions/2/0", headers=hdrs,
                           json={"note": "Nudged for the ZD421"})
    assert r.status_code == 200 and r.json()["note"] == "Nudged for the ZD421"

    r = await client.post(f"{URL}/{pid}/versions/1/0/restore", headers=hdrs)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 4 and r.json()["design"] == DESIGN
    rows = (await client.get(f"{URL}/{pid}/versions", headers=hdrs)).json()
    assert [v["label"] for v in rows] == ["v4", "v3", "v2", "v1"]
    assert rows[0]["summary"] == "Restored v1"
    node = await _node(client, hdrs, "Vegas Destination")
    assert all(c["design"] == DESIGN and c["generated_from_version"] == 4
               for c in node["children"])

    # a child's versions count under its parent's: each regeneration, then
    # its own edits on top (v4.1, v4.2)
    c203 = _child(node, "203")
    await client.patch(f"{URL}/{c203['id']}", headers=hdrs, json={"design": _added(DESIGN)})
    rows = (await client.get(f"{URL}/{c203['id']}/versions", headers=hdrs)).json()
    assert [v["label"] for v in rows] == ["v4.1", "v4", "v3", "v2", "v1"]
    r = await client.post(f"{URL}/{c203['id']}/versions/4/0/restore", headers=hdrs)
    assert r.status_code == 200, r.text
    assert (r.json()["child_edits"], r.json()["design"]) == (2, DESIGN)
    rows = (await client.get(f"{URL}/{c203['id']}/versions", headers=hdrs)).json()
    assert [v["label"] for v in rows] == ["v4.2", "v4.1", "v4", "v3", "v2", "v1"]
    assert rows[0]["summary"] == "Restored v4"


# ── one active template per family, type and DPI ───────────────────

async def test_replace_swaps_atomically_and_refuses_a_second_active(client, db, seeded_user):
    hdrs = await _super(db, client)
    old203 = _legacy("Vegas Destination - 203DPI", "203")
    old300 = _legacy("Vegas Destination - 300DPI", "300")
    db.add_all([old203, old300])
    await db.commit()

    r = await client.post(URL, headers=hdrs, json=_body())
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "active_conflict", "names": [
        "Vegas Destination - 203DPI", "Vegas Destination - 300DPI"]}
    assert await db.scalar(select(func.count()).select_from(LabelTemplate)) == 2

    parent = await _create(client, hdrs, is_active=False)
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["is_active"] is False
    assert all(c["is_active"] is False for c in node["children"])
    r = await client.post(f"{URL}/{parent['id']}/activate", headers=hdrs)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "active_conflict"

    # replacing only the 203 row leaves the 300 one in the way: nothing changes
    r = await client.post(f"{URL}/{parent['id']}/replace", headers=hdrs,
                          json={"old_template_ids": [str(old203.id)]})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["names"] == ["Vegas Destination - 300DPI"]
    await db.refresh(old203)
    assert old203.is_active is True
    assert (await _node(client, hdrs, "Vegas Destination"))["is_active"] is False

    r = await client.post(f"{URL}/{parent['id']}/replace", headers=hdrs,
                          json={"old_template_ids": [str(old203.id), str(old300.id)]})
    assert r.status_code == 200, r.text
    assert r.json()["is_active"] is True
    node = await _node(client, hdrs, "Vegas Destination")
    assert all(c["is_active"] for c in node["children"])
    for row in (old203, old300):
        await db.refresh(row)
        assert row.is_active is False

    # Review Focus 5: the old row can't come back alongside the new one
    for call in (client.post(f"{URL}/{old203.id}/activate", headers=hdrs),
                 client.patch(f"{URL}/{old203.id}", headers=hdrs, json={"is_active": True})):
        r = await call
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {"code": "active_conflict",
                                      "names": ["Vegas Destination · 203"]}
    # deactivate (the old DELETE behavior) takes the parent and its children
    r = await client.post(f"{URL}/{parent['id']}/deactivate", headers=hdrs)
    assert r.status_code == 204, r.text
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["is_active"] is False and not any(c["is_active"] for c in node["children"])
    r = await client.post(f"{URL}/{old203.id}/activate", headers=hdrs)
    assert r.status_code == 200 and r.json()["is_active"] is True


async def test_concurrent_activations_cannot_both_win(client, db, seeded_user):
    """Review Focus 5: two transactions each activating a template of one
    family, type and DPI. The activation lock makes the second wait for the
    first to commit, so its check sees the first and refuses."""
    import asyncio

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    a, b = _legacy("Rack Tag - 203DPI", "203", is_active=False), _legacy(
        "Rack Tag 203dpi", "203", is_active=False)
    db.add_all([a, b])
    await db.commit()
    first_checked = asyncio.Event()

    async def first():
        async with get_sessionmaker()() as s:
            await templates_tree.activate(s, await s.get(LabelTemplate, a.id))
            first_checked.set()
            await asyncio.sleep(0.3)  # the second runs its check meanwhile
            await s.commit()

    async def second():
        await first_checked.wait()
        async with get_sessionmaker()() as s:
            try:
                await templates_tree.activate(s, await s.get(LabelTemplate, b.id))
            except templates_tree.ActiveConflict as exc:
                return exc.names
            await s.commit()
            return []

    _, refused = await asyncio.gather(first(), second())
    assert refused == ["Rack Tag - 203DPI"]
    for row in (a, b):
        await db.refresh(row)
    assert (a.is_active, b.is_active) == (True, False)


async def test_child_activation_follows_its_parent(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    for call in (client.post(f"{URL}/{c300['id']}/activate", headers=hdrs),
                 client.post(f"{URL}/{c300['id']}/deactivate", headers=hdrs),
                 client.patch(f"{URL}/{c300['id']}", headers=hdrs, json={"is_active": False}),
                 client.patch(f"{URL}/{c300['id']}", headers=hdrs, json={"is_active": True})):
        r = await call
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["code"] == "child_follows_parent"
    # a customized child kept as Old stays off whatever the parent does
    await _customize_and_save(client, hdrs, parent["id"], c300["id"], 0.1)
    r = await client.post(f"{URL}/{c300['id']}/update-from-parent", headers=hdrs)
    assert r.status_code == 201, r.text

    r = await client.post(f"{URL}/{parent['id']}/deactivate", headers=hdrs)
    assert r.status_code == 204
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["is_active"] is False and not any(c["is_active"] for c in node["children"])
    r = await client.post(f"{URL}/{parent['id']}/activate", headers=hdrs)
    assert r.status_code == 200, r.text
    node = await _node(client, hdrs, "Vegas Destination")
    assert node["is_active"] is True
    assert {c["name"]: c["is_active"] for c in node["children"]} == {
        "Vegas Destination · 203": True, "Vegas Destination · 300": True,
        "Vegas Destination · 300 Old": False, "Vegas Destination · 600": True}
    # and through PATCH on the parent
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"is_active": False})
    assert r.status_code == 200, r.text
    node = await _node(client, hdrs, "Vegas Destination")
    assert not any(c["is_active"] for c in node["children"])
    # an old id naming a child is refused: Replace… swaps top-level templates
    await _create(client, hdrs, name="Other Tag", is_active=False)
    other_child = _child(await _node(client, hdrs, "Other Tag"), "203")
    r = await client.post(f"{URL}/{parent['id']}/replace", headers=hdrs,
                          json={"old_template_ids": [other_child["id"]]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "child_follows_parent"


async def test_renaming_an_inactive_parent_checks_its_active_children(client, db, seeded_user):
    """An active child under an inactive parent (written directly: the API
    keeps them in step) still blocks a rename into an active family."""
    from sqlalchemy import update

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, name="Alpha", is_active=False)
    await db.execute(update(LabelTemplate).where(
        LabelTemplate.parent_id == uuid.UUID(parent["id"]),
        LabelTemplate.dpi_key == "203").values(is_active=True))
    db.add(_legacy("Beta - 203DPI", "203"))
    await db.commit()
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"name": "Beta"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "active_conflict", "names": ["Beta - 203DPI"]}
    assert (await client.get(f"{URL}/{parent['id']}", headers=hdrs)).json()["name"] == "Alpha"


async def test_concurrent_update_from_parent_returns_the_same_fresh_child(
        client, db, seeded_user):
    """A second Update from parent (a double click) waits on the first and
    gets the fresh child the first made, not an error or a second Old."""
    import asyncio

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    await _customize_and_save(client, hdrs, parent["id"], c300["id"], 0.1)
    child_id = uuid.UUID(c300["id"])
    second_loaded, first_done = asyncio.Event(), asyncio.Event()

    async def first():
        async with get_sessionmaker()() as s:
            await second_loaded.wait()
            fresh, created = await templates_tree.update_from_parent(
                s, await s.get(LabelTemplate, child_id), None)
            first_done.set()
            await asyncio.sleep(0.3)  # the second is waiting on the row lock
            await s.commit()
            return fresh.id, created

    async def second():
        async with get_sessionmaker()() as s:
            child = await s.get(LabelTemplate, child_id)  # still customized, not Old
            second_loaded.set()
            await first_done.wait()
            fresh, created = await templates_tree.update_from_parent(s, child, None)
            await s.commit()
            return fresh.id, created

    (one, made_one), (two, made_two) = await asyncio.gather(first(), second())
    assert (one == two, made_one, made_two) == (True, True, False)
    node = await _node(client, hdrs, "Vegas Destination")
    assert [c["name"] for c in node["children"] if c["is_old"]] == [
        "Vegas Destination · 300 Old"]
    r = await client.post(f"{URL}/{c300['id']}/update-from-parent", headers=hdrs)
    assert r.status_code == 201 and r.json()["id"] == str(one)  # idempotent over HTTP too


# ── access ──────────────────────────────────────────────────────────

async def test_mutations_need_rank_80(client, db, seeded_user):
    sa = await _super(db, client)
    parent = await _create(client, sa)
    child = _child(await _node(client, sa, "Vegas Destination"), "300")
    legacy = _legacy("Legacy", "203")
    db.add(legacy)
    await db.commit()
    admin = await _make(db, client, "admin", "adm@test.example.com")  # labels:* at rank 60
    pid, cid = parent["id"], child["id"]
    calls = [
        ("POST", URL, _body("Another")),
        ("POST", URL, {"name": "Raw", "label_type": "top", "size_key": "4x2",
                       "dpi_key": "203", "language_key": "zpl", "kind": "code",
                       "code": "^XA^XZ"}),
        ("PATCH", f"{URL}/{pid}", {"description": "x"}),
        ("PATCH", f"{URL}/{cid}", {"design": _added(DESIGN)}),
        ("PATCH", f"{URL}/{legacy.id}", {"description": "x"}),
        ("DELETE", f"{URL}/{cid}", None),
        ("DELETE", f"{URL}/{pid}", {"typed_name": "Vegas Destination"}),
        ("POST", f"{URL}/{pid}/deactivate", None),
        ("POST", f"{URL}/{pid}/activate", None),
        ("POST", f"{URL}/{pid}/clone", {"name": "Copy"}),
        ("POST", f"{URL}/{pid}/dpis", {"dpi": "600"}),
        ("POST", f"{URL}/{cid}/update-from-parent", None),
        ("POST", f"{URL}/{pid}/replace", {"old_template_ids": [str(legacy.id)]}),
        ("GET", f"{URL}/{pid}/versions", None),
        ("GET", f"{URL}/{pid}/versions/1/0", None),
        ("PATCH", f"{URL}/{pid}/versions/1/0", {"note": "x"}),
        ("POST", f"{URL}/{pid}/versions/1/0/restore", None),
        ("GET", f"{URL}/{pid}/delete-summary", None),
        ("GET", f"{URL}/{pid}/deactivate-summary", None),
        ("POST", f"{URL}/{legacy.id}/convert-to-code", None),
    ]
    for method, url, body in calls:
        r = await client.request(method, url, headers=admin, json=body)
        assert r.status_code == 403, (method, url, r.status_code, r.text)
        # the rank gate refused, not a missing labels:* permission
        assert r.json()["detail"] == {"code": "forbidden", "min_rank": 80}, (method, url)
    assert (await client.get(f"{URL}/tree", headers=admin)).status_code == 200
    assert await db.scalar(select(func.count()).select_from(LabelTemplate)) == 5


async def test_a_version_note_needs_labels_change_as_well_as_rank_80(client, db, seeded_user):
    """ledger B8: rank 80 alone doesn't let a designer write a version note;
    labels:change is needed too (an override can take it away)."""
    from serversherpa.db.models import PermissionOverride, UserAccount

    sa = await _super(db, client)
    parent = await _create(client, sa)
    url = f"{URL}/{parent['id']}/versions/1/0"
    no_change = await _make(db, client, "super_admin", "nochange@test.example.com")
    person_id = await db.scalar(select(UserAccount.person_id).where(
        UserAccount.email == "nochange@test.example.com"))
    db.add(PermissionOverride(person_id=person_id, resource="labels", action="change",
                              allow=False))
    await db.commit()
    r = await client.patch(url, headers=no_change, json={"note": "mine"})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "forbidden"}
    assert (await client.get(url, headers=sa)).json()["note"] == ""
    r = await client.patch(url, headers=sa, json={"note": "checked on the ZD421"})
    assert r.status_code == 200 and r.json()["note"] == "checked on the ZD421"


async def test_tree_readable_with_labels_view(client, db, seeded_user):
    sa = await _super(db, client)
    await _create(client, sa)
    db.add(_legacy("Generic Rack and RU - 203DPI", "203"))
    await db.commit()
    staff = await login(client)  # labels:view only
    tree = await _tree(client, staff)
    assert [p["name"] for p in tree] == ["Generic Rack and RU - 203DPI", "Vegas Destination"]
    legacy, parent = tree
    assert legacy["children"] == [] and legacy["schema_version"] == 1
    assert legacy["family"] == "Generic Rack and RU"
    # F5: stored sample values are the builder's (rank 80), like the
    # sample-values route they come from; below it they read as empty
    assert len(parent["children"]) == 3 and parent["samples"] == {}
    listed = (await client.get(URL, headers=staff)).json()
    assert [t["samples"] for t in listed if t["id"] == parent["id"]] == [{}]
    one = (await client.get(f"{URL}/{parent['id']}", headers=staff)).json()
    assert one["samples"] == {}
    admin = await _make(db, client, "admin", "adm@test.example.com")  # rank 60
    assert (await _node(client, admin, "Vegas Destination"))["samples"] == {}
    # rank 80 reads them on all three routes
    assert (await _node(client, sa, "Vegas Destination"))["samples"] == {"asset_id": "10482"}
    listed = (await client.get(URL, headers=sa)).json()
    assert [t["samples"] for t in listed if t["id"] == parent["id"]] == [{"asset_id": "10482"}]
    one = (await client.get(f"{URL}/{parent['id']}", headers=sa)).json()
    assert one["samples"] == {"asset_id": "10482"}
    r = await client.post(URL, headers=staff, json=_body("Mine"))
    assert r.status_code == 403


async def test_a_designer_can_change_a_pending_custom_size(client, db, seeded_user):
    """ledger B7: New template › Custom… posts an unlisted size before the
    create; when that create fails and the size is changed, the designer
    rewrites the same pending row (inactive, no template on it) instead of
    leaving it behind. A listed or used size stays devtools-only."""
    hdrs = await _super(db, client)
    r = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "size", "key": "3x1_25", "label": '3" x 1.25"', "is_active": False,
        "meta": {"width_in": 3, "height_in": 1.25, "has_tab": False}})
    assert r.status_code == 201, r.text
    r = await client.patch("/labels/vocab/size/3x1_25", headers=hdrs, json={
        "label": '3.5" x 1.25"', "meta": {"width_in": 3.5, "height_in": 1.25, "has_tab": False}})
    assert r.status_code == 200, r.text
    assert (r.json()["label"], r.json()["meta"]["width_in"], r.json()["is_active"]) == (
        '3.5" x 1.25"', 3.5, False)
    parent = await _create(client, hdrs, name="Odd size", size_key="3x1_25")
    assert parent["size_key"] == "3x1_25"
    # now a template uses it: no longer pending
    r = await client.patch("/labels/vocab/size/3x1_25", headers=hdrs, json={"label": "x"})
    assert r.status_code == 403, r.text
    # a listed size, and anything that isn't a size, stay devtools-only
    r = await client.patch("/labels/vocab/size/4x2", headers=hdrs, json={"label": "x"})
    assert r.status_code == 403, r.text
    r = await client.patch("/labels/vocab/dpi/203", headers=hdrs, json={"label": "x"})
    assert r.status_code == 403, r.text
    # below rank 80, nothing
    r = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "size", "key": "5x5", "label": '5" x 5"', "is_active": False,
        "meta": {"width_in": 5, "height_in": 5, "has_tab": False}})
    assert r.status_code == 201, r.text
    admin = await _make(db, client, "admin", "adm@test.example.com")
    r = await client.patch("/labels/vocab/size/5x5", headers=admin, json={"label": "x"})
    assert r.status_code == 403, r.text


async def test_a_parent_can_use_an_unlisted_custom_size(client, db, seeded_user):
    """A custom size not saved to the list is an inactive size row: the
    template it was made for may use it while nothing else does yet, and a
    second template may not pick it."""
    hdrs = await _super(db, client)
    r = await client.post("/labels/vocab", headers=hdrs, json={
        "kind": "size", "key": "3x1_25", "label": '3" x 1.25"', "is_active": False,
        "meta": {"width_in": 3, "height_in": 1.25, "has_tab": False}})
    assert r.status_code == 201, r.text
    parent = await _create(client, hdrs, name="Odd size", size_key="3x1_25")
    assert parent["size_key"] == "3x1_25"
    r = await client.post(URL, headers=hdrs, json=_body(name="Second", size_key="3x1_25"))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unknown_vocab"
