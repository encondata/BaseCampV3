"""Rename… on the templates list: PATCH `name` renames a template only
while it is inactive (409 `template_active` otherwise). A builder parent's
children follow its name and the parent records a "Renamed from <old>"
version; an older row renames as it always has. A DPI child's name is
never its own. The seed renames an old row whether or not it is active:
the rule is the PATCH route's, not `rename_parent`'s."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, LabelTemplate, LabelTemplateVersion
from serversherpa.labels import builtin_templates
from tests.test_label_template_tree_api import URL, _child, _create, _legacy, _node, _super

ACTIVE = {"code": "template_active", "message": "Deactivate the template to rename it."}


async def test_rename_an_inactive_parent_and_its_children_follow(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, is_active=False)
    c300 = _child(await _node(client, hdrs, "Vegas Destination"), "300")
    # a kept Old child follows too
    row = await db.get(LabelTemplate, c300["id"])
    row.customized = True
    await db.commit()
    r = await client.post(f"{URL}/{c300['id']}/update-from-parent", headers=hdrs)
    assert r.status_code == 201, r.text

    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"name": "Vegas Dest"})
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["version"]) == ("Vegas Dest", 2)
    node = await _node(client, hdrs, "Vegas Dest")
    assert [c["name"] for c in node["children"]] == [
        "Vegas Dest · 203", "Vegas Dest · 300", "Vegas Dest · 300 Old", "Vegas Dest · 600"]
    versions = (await client.get(f"{URL}/{parent['id']}/versions", headers=hdrs)).json()
    assert [(v["label"], v["summary"]) for v in versions] == [
        ("v2", "Renamed from Vegas Destination"), ("v1", "Created")]
    # a rename is not a design change: no child is out of date
    assert not any(c["out_of_date"] for c in node["children"])
    audit = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "label_template", AuditLog.action == "update",
        AuditLog.entity_id == parent["id"]))
    assert audit.changes["name"] == {"from": "Vegas Destination", "to": "Vegas Dest"}


async def test_rename_an_inactive_older_row(client, db, seeded_user):
    hdrs = await _super(db, client)
    row = _legacy("Front tag - 203DPI", "203", is_active=False)
    db.add(row)
    await db.commit()
    r = await client.patch(f"{URL}/{row.id}", headers=hdrs, json={"name": "Front label - 203DPI"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Front label - 203DPI"
    versions = (await client.get(f"{URL}/{row.id}/versions", headers=hdrs)).json()
    assert versions[0]["summary"] == "Changed name"


async def test_an_active_template_refuses_a_rename(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs)
    legacy = _legacy("Front tag - 203DPI", "203")
    db.add(legacy)
    await db.commit()
    for tid in (parent["id"], legacy.id):
        r = await client.patch(f"{URL}/{tid}", headers=hdrs, json={"name": "Renamed"})
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == ACTIVE
        # nothing else in the request lands either
        r = await client.patch(f"{URL}/{tid}", headers=hdrs,
                               json={"name": "Renamed", "description": "x"})
        assert r.status_code == 409
    assert (await client.get(f"{URL}/{parent['id']}", headers=hdrs)).json()["description"] == ""
    node = await _node(client, hdrs, "Vegas Destination")
    assert [c["name"] for c in node["children"]] == [
        "Vegas Destination · 203", "Vegas Destination · 300", "Vegas Destination · 600"]
    # the same name again is no rename: an active template still saves
    r = await client.patch(f"{URL}/{legacy.id}", headers=hdrs,
                           json={"name": "Front tag - 203DPI", "description": "kept"})
    assert r.status_code == 200, r.text
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"name": "Vegas Destination", "description": "kept"})
    assert r.status_code == 200, r.text
    # nor does deactivating in the same request let a rename through
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs,
                           json={"name": "Renamed", "is_active": False})
    assert r.status_code == 409 and r.json()["detail"] == ACTIVE


async def test_a_child_name_stays_refused(client, db, seeded_user):
    hdrs = await _super(db, client)
    await _create(client, hdrs, is_active=False)
    c203 = _child(await _node(client, hdrs, "Vegas Destination"), "203")
    r = await client.patch(f"{URL}/{c203['id']}", headers=hdrs, json={"name": "Mine"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "bad_field", "field": "name",
                                  "message": "set on the parent template"}


async def test_a_taken_name_is_a_409(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, is_active=False)
    legacy = _legacy("Front tag - 203DPI", "203", is_active=False)
    db.add_all([legacy, _legacy("Taken", "300", is_active=False)])
    await db.commit()
    for tid in (parent["id"], legacy.id):
        r = await client.patch(f"{URL}/{tid}", headers=hdrs, json={"name": "Taken"})
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["code"] == "label_template_exists"
    # a child's new name taken counts too
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"name": "Taken · 300"})
    assert r.status_code == 200, r.text  # "Taken · 300 · 300" etc. are free
    db.add(_legacy("Other · 203", "203", is_active=False))
    await db.commit()
    r = await client.patch(f"{URL}/{parent['id']}", headers=hdrs, json={"name": "Other"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == {"code": "label_template_exists", "name": "Other · 203"}


async def test_the_seed_still_renames_an_active_old_row(client, db, seeded_user):
    """The rule is the PATCH route's: the seed's rename of an active row
    that holds a built-in's name goes ahead (Replace… swaps them later),
    while the same rename through PATCH is refused."""
    hdrs = await _super(db, client)
    old = _legacy("Switch Front Tag", "300", label_type="front")
    db.add(old)
    await db.commit()
    old_id = old.id
    report = await builtin_templates.seed(db)
    assert ("Switch Front Tag", "Switch Front Tag Old") in report.renamed
    row = await db.get(LabelTemplate, old_id, populate_existing=True)
    assert (row.name, row.is_active) == ("Switch Front Tag Old", True)
    r = await client.patch(f"{URL}/{old_id}", headers=hdrs, json={"name": "Switch Front Tag Older"})
    assert r.status_code == 409 and r.json()["detail"] == ACTIVE
    assert await db.scalar(select(LabelTemplateVersion.summary).where(
        LabelTemplateVersion.template_id == old_id, LabelTemplateVersion.version == 2)) == "Changed name"


async def test_the_inactive_check_rereads_under_the_row_lock(client, db, seeded_user):
    """A rename decides from the row as locked, not as the request first
    read it: an activation committed in between is seen, and refused."""
    from sqlalchemy import update

    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.labels import templates_tree as tree

    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, is_active=False)
    legacy = _legacy("Front tag - 203DPI", "203", is_active=False)
    db.add(legacy)
    await db.commit()
    for tid in (parent["id"], legacy.id):
        async with get_sessionmaker()() as s:
            row = await s.get(LabelTemplate, tid)
            assert row.is_active is False          # what the request read
            async with get_sessionmaker()() as other:   # an activation lands meanwhile
                await other.execute(update(LabelTemplate).where(LabelTemplate.id == row.id)
                                    .values(is_active=True))
                await other.commit()
            try:
                await tree.lock_for_rename(s, row)
            except tree.TemplateActive:
                pass
            else:
                raise AssertionError("an activation committed since the read must refuse the rename")
            await s.rollback()
    # an inactive row passes, locked
    async with get_sessionmaker()() as s:
        row = await s.get(LabelTemplate, legacy.id)
        row.is_active = False
        await s.commit()
        await tree.lock_for_rename(s, await s.get(LabelTemplate, legacy.id))
        await s.rollback()
