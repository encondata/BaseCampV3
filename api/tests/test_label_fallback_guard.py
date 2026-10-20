"""The fallback guard (labels/templates_tree.py `fallback_dpis_lost`): the
Generic Rack and RU family is what every move without its own Top template
prints from, so the delete and deactivate summaries say at which DPIs a
delete or deactivate would leave no active fallback at all."""

from sqlalchemy import select

from serversherpa.db.models import LabelTemplate, PermissionOverride, UserAccount
from serversherpa.labels import templates_tree as tree
from tests.test_label_template_tree_api import URL, _child, _create, _legacy, _node, _super
from tests.test_sites_api import login
from tests.test_status_values_write import _make

GENERIC = "Generic Rack and RU"


async def _rows(db, *rows):
    db.add_all(rows)
    await db.commit()
    return rows


# ── the helper ──────────────────────────────────────────────────────

async def test_the_last_active_fallback_at_a_dpi_is_lost(client, db, seeded_user):
    g203, g300 = await _rows(db, _legacy(f"{GENERIC} - 203DPI", "203"),
                             _legacy(f"{GENERIC} - 300DPI", "300"))
    assert await tree.fallback_dpis_lost(db, [g203]) == ["203"]
    assert await tree.fallback_dpis_lost(db, [g300]) == ["300"]
    # natural order, whatever order the rows come in
    assert await tree.fallback_dpis_lost(db, [g300, g203]) == ["203", "300"]
    assert await tree.fallback_dpis_lost(db, []) == []


async def test_another_active_fallback_at_that_dpi_keeps_it(client, db, seeded_user):
    # rows from before the one-active rule: two active fallbacks at 203
    # (the family compares case-insensitively, the DPI marker aside)
    g203, other = await _rows(db, _legacy(f"{GENERIC} - 203DPI", "203"),
                              _legacy("GENERIC RACK AND RU 203 dpi", "203"))
    assert await tree.fallback_dpis_lost(db, [g203]) == []
    assert await tree.fallback_dpis_lost(db, [g203, other]) == ["203"]


async def test_a_parent_counts_its_active_children(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, name=GENERIC)
    node = await _node(client, hdrs, GENERIC)
    p = await db.get(LabelTemplate, parent["id"])
    kids = [await db.get(LabelTemplate, c["id"]) for c in node["children"]]
    assert await tree.fallback_dpis_lost(db, [p, *kids]) == ["203", "300", "600"]
    # a parent never prints; its children go with it all the same
    assert await tree.fallback_dpis_lost(db, [p]) == ["203", "300", "600"]
    c300 = await db.get(LabelTemplate, _child(node, "300")["id"])
    assert await tree.fallback_dpis_lost(db, [c300]) == ["300"]
    # an active older row of the family still covers 600 once it's on
    db.add(_legacy(f"{GENERIC} - 600DPI", "600", label_type="top"))
    await db.commit()
    assert await tree.fallback_dpis_lost(db, [p]) == ["203", "300"]


async def test_a_non_fallback_template_loses_nothing(client, db, seeded_user):
    vegas, _g = await _rows(db, _legacy("Vegas Destination - 203DPI", "203"),
                            _legacy(f"{GENERIC} - 203DPI", "203"))
    assert await tree.fallback_dpis_lost(db, [vegas]) == []
    # nor does a Front template of the fallback family: the fallback is Top
    (front,) = await _rows(db, _legacy(f"{GENERIC} (300DPI)", "300", label_type="front"))
    assert await tree.fallback_dpis_lost(db, [front]) == []


async def test_inactive_rows_are_ignored(client, db, seeded_user):
    off203, g300 = await _rows(db, _legacy(f"{GENERIC} - 203DPI", "203", is_active=False),
                               _legacy(f"{GENERIC} - 300DPI", "300"))
    # nothing prints at 203 now, so nothing is lost there
    assert await tree.fallback_dpis_lost(db, [off203]) == []
    # an inactive row at 300 doesn't keep the fallback there
    db.add(_legacy(f"{GENERIC} 300 dpi Old", "300", is_active=False))
    await db.commit()
    assert await tree.fallback_dpis_lost(db, [g300]) == ["300"]


# ── the delete summary ──────────────────────────────────────────────

async def test_delete_summary_names_the_fallback_dpis_lost(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, name=GENERIC)
    vegas = await _create(client, hdrs)
    node = await _node(client, hdrs, GENERIC)
    r = await client.get(f"{URL}/{parent['id']}/delete-summary", headers=hdrs)
    assert r.status_code == 200, r.text
    assert r.json()["fallback_dpis_lost"] == ["203", "300", "600"]
    r = await client.get(f"{URL}/{_child(node, '203')['id']}/delete-summary", headers=hdrs)
    assert r.json() == {"children": [], "generated_labels": 0, "fallback_dpis_lost": ["203"]}
    r = await client.get(f"{URL}/{vegas['id']}/delete-summary", headers=hdrs)
    assert r.json()["fallback_dpis_lost"] == []
    # an inactive parent loses nothing
    r = await client.post(f"{URL}/{parent['id']}/deactivate", headers=hdrs)
    assert r.status_code == 204, r.text
    r = await client.get(f"{URL}/{parent['id']}/delete-summary", headers=hdrs)
    assert r.json()["fallback_dpis_lost"] == []


async def test_a_typed_name_mismatch_carries_the_summary(client, db, seeded_user):
    hdrs = await _super(db, client)
    (g203,) = await _rows(db, _legacy(f"{GENERIC} - 203DPI", "203"))
    r = await client.request("DELETE", f"{URL}/{g203.id}", headers=hdrs, json={"typed_name": "x"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "name_mismatch", "children": [], "generated_labels": 0,
                                  "fallback_dpis_lost": ["203"]}


# ── the deactivate summary ──────────────────────────────────────────

async def test_deactivate_summary_lists_what_goes_off(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, name=GENERIC)
    r = await client.get(f"{URL}/{parent['id']}/deactivate-summary", headers=hdrs)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "rows": [GENERIC, f"{GENERIC} · 203", f"{GENERIC} · 300", f"{GENERIC} · 600"],
        "fallback_dpis_lost": ["203", "300", "600"]}
    # the summary changes nothing
    node = await _node(client, hdrs, GENERIC)
    assert node["is_active"] and all(c["is_active"] for c in node["children"])

    # a non-fallback legacy row, then an inactive one
    vegas, off = await _rows(db, _legacy("Vegas Destination - 203DPI", "203"),
                             _legacy("Amsterdam - 203DPI", "203", is_active=False))
    r = await client.get(f"{URL}/{vegas.id}/deactivate-summary", headers=hdrs)
    assert r.json() == {"rows": ["Vegas Destination - 203DPI"], "fallback_dpis_lost": []}
    r = await client.get(f"{URL}/{off.id}/deactivate-summary", headers=hdrs)
    assert r.json() == {"rows": [], "fallback_dpis_lost": []}


async def test_deactivate_summary_skips_a_kept_old_child(client, db, seeded_user):
    hdrs = await _super(db, client)
    parent = await _create(client, hdrs, name=GENERIC)
    p = await db.get(LabelTemplate, parent["id"])
    c300 = await db.get(LabelTemplate, _child(await _node(client, hdrs, GENERIC), "300")["id"])
    c300.customized = True
    await db.commit()
    r = await client.post(f"{URL}/{c300.id}/update-from-parent", headers=hdrs)
    assert r.status_code == 201, r.text
    r = await client.get(f"{URL}/{p.id}/deactivate-summary", headers=hdrs)
    assert r.json()["rows"] == [GENERIC, f"{GENERIC} · 203", f"{GENERIC} · 300",
                                f"{GENERIC} · 600"]


async def test_deactivate_summary_on_a_child_is_a_409(client, db, seeded_user):
    hdrs = await _super(db, client)
    await _create(client, hdrs, name=GENERIC)
    c203 = _child(await _node(client, hdrs, GENERIC), "203")
    r = await client.get(f"{URL}/{c203['id']}/deactivate-summary", headers=hdrs)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "child_follows_parent"
    r = await client.get(f"{URL}/00000000-0000-0000-0000-000000000000/deactivate-summary",
                         headers=hdrs)
    assert r.status_code == 404


async def test_deactivate_summary_is_gated_like_deactivate(client, db, seeded_user):
    sa = await _super(db, client)
    parent = await _create(client, sa, name=GENERIC)
    url = f"{URL}/{parent['id']}/deactivate-summary"
    # rank 80, like POST …/deactivate
    admin = await _make(db, client, "admin", "adm@test.example.com")
    r = await client.get(url, headers=admin)
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "forbidden", "min_rank": 80}
    # labels:view alone isn't enough
    staff = await login(client)
    assert (await client.get(url, headers=staff)).status_code == 403
    # and labels:change is needed as well as the rank
    no_change = await _make(db, client, "super_admin", "nochange@test.example.com")
    person_id = await db.scalar(select(UserAccount.person_id).where(
        UserAccount.email == "nochange@test.example.com"))
    db.add(PermissionOverride(person_id=person_id, resource="labels", action="change",
                              allow=False))
    await db.commit()
    r = await client.get(url, headers=no_change)
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "forbidden"}
    assert (await client.get(url, headers=sa)).status_code == 200
