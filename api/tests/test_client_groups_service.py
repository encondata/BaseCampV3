"""Client group service: Owner matching, aliases, merge, review, hooks."""
import pytest
from sqlalchemy import select

from serversherpa.clientgroups import service as cg
from serversherpa.db.models import (
    ClientContactGroup, ClientGroup, ClientGroupAlias, InitiativeAsset, Person,
)
from serversherpa.imports.move_assets import parse_row, run_import
from serversherpa.imports.parsing import CANONICAL

from tests.client_groups_fixtures import seed_grouped_client
from tests.test_assets_api import login


async def _group_of(db, asset):
    row = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == asset.id))
    await db.refresh(row)
    return row.owner_group_id


async def _seeded(db):
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    return s


async def test_match_ignores_case_and_spacing(db):
    s = await _seeded(db)
    assert await _group_of(db, s.assets[0]) == s.groups["Platform"].id
    assert await _group_of(db, s.assets[1]) == s.groups["Storage"].id
    assert await _group_of(db, s.assets[2]) is None
    assert await _group_of(db, s.assets[3]) is None


async def test_rename_keeps_old_alias(db):
    s = await _seeded(db)
    g = s.groups["Platform"]
    await cg.rename_group(db, g, "Platform Eng", None)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    assert await _group_of(db, s.assets[0]) == g.id
    aliases = list(await db.scalars(select(ClientGroupAlias.alias_key)
                                    .where(ClientGroupAlias.group_id == g.id)))
    assert "platform" in aliases
    assert g.name == "Platform Eng"


async def test_name_and_alias_collide(db):
    s = await _seeded(db)
    with pytest.raises(cg.GroupError) as e:
        await cg.create_group(db, s.client.id, "Storage", None)
    assert (e.value.code, e.value.status) == ("group_name_taken", 409)
    with pytest.raises(cg.GroupError) as e:
        await cg.set_aliases(db, s.groups["Platform"], ["storage"])
    assert (e.value.code, e.value.status) == ("alias_in_use", 409)


async def test_review_lists_unmatched_not_blank(db):
    s = await _seeded(db)
    vals = await cg.review_values(db, s.client.id, include_dismissed=False)
    assert [(v.value, v.asset_count, v.dismissed) for v in vals] == [("Platfrom", 1, False)]
    assert vals[0].move_ids == [s.move.id] and vals[0].move_names == ["Acme move"]


async def test_match_value_adds_alias_and_rematches(db):
    s = await _seeded(db)
    await cg.match_value(db, s.client.id, "Platfrom", s.groups["Platform"].id)
    await db.commit()
    assert await _group_of(db, s.assets[3]) == s.groups["Platform"].id
    assert await cg.review_values(db, s.client.id, include_dismissed=True) == []


async def test_dismiss_hides_from_review(db):
    s = await _seeded(db)
    await cg.set_dismissed(db, s.client.id, "Platfrom", True, None)
    assert await cg.review_values(db, s.client.id, include_dismissed=False) == []
    vals = await cg.review_values(db, s.client.id, include_dismissed=True)
    assert len(vals) == 1 and vals[0].dismissed is True
    await cg.set_dismissed(db, s.client.id, " platfrom", False, None)
    assert len(await cg.review_values(db, s.client.id, include_dismissed=False)) == 1


async def _person(db, email):
    p = Person(first_name="P", last_name=email, email=email)
    db.add(p)
    await db.flush()
    return p


async def test_merge_dry_run_then_apply(db):
    s = await _seeded(db)
    target, source = s.groups["Platform"], s.groups["Storage"]
    both = await _person(db, "both@test.example.com")
    only = await _person(db, "only@test.example.com")
    for p, g in ((both, target), (both, source), (only, source)):
        db.add(ClientContactGroup(person_id=p.id, client_id=s.client.id, group_id=g.id))
    await db.commit()

    plan = await cg.merge_groups(db, target, source, dry_run=True)
    assert plan.rows_moved == 1 and plan.people_moved == 1
    assert plan.aliases_added == ["Storage"] and plan.conflicts == []
    assert await db.scalar(select(ClientGroup.id).where(ClientGroup.id == source.id))
    assert await _group_of(db, s.assets[1]) == source.id

    plan = await cg.merge_groups(db, target, source, dry_run=False)
    await db.commit()
    assert plan.rows_moved == 1 and plan.people_moved == 1
    assert await db.scalar(select(ClientGroup.id).where(ClientGroup.id == source.id)) is None
    assert await _group_of(db, s.assets[1]) == target.id
    assert "storage" in set(await db.scalars(select(ClientGroupAlias.alias_key)
                                             .where(ClientGroupAlias.group_id == target.id)))
    chips = set(await db.execute(select(ClientContactGroup.person_id, ClientContactGroup.group_id)))
    assert chips == {(both.id, target.id), (only.id, target.id)}


async def test_delete_unmatches_rows(db):
    s = await _seeded(db)
    g = s.groups["Platform"]
    await cg.delete_group(db, g)
    await db.commit()
    assert await _group_of(db, s.assets[0]) is None
    vals = await cg.review_values(db, s.client.id, include_dismissed=False)
    assert {v.value for v in vals} == {"Platform", "Platfrom"}


async def test_delete_refused_while_chips_held(db):
    s = await _seeded(db)
    g = s.groups["Platform"]
    p = await _person(db, "chip@test.example.com")
    db.add(ClientContactGroup(person_id=p.id, client_id=s.client.id, group_id=g.id))
    await db.commit()
    with pytest.raises(cg.GroupError) as exc:
        await cg.delete_group(db, g)
    assert exc.value.code == "group_in_use" and exc.value.status == 409
    assert await _group_of(db, s.assets[0]) == g.id


async def test_groups_never_cross_clients(db):
    s = await _seeded(db)
    assert await _group_of(db, s.other_assets[0]) is None
    await cg.rematch_client(db, s.other_client.id)
    assert await _group_of(db, s.other_assets[0]) is None


async def test_move_without_client_never_matches(db):
    s = await _seeded(db)
    s.move.client_id = None
    await db.commit()
    await cg.rematch_initiative(db, s.move.id)
    await db.commit()
    assert await _group_of(db, s.assets[0]) is None


async def test_reimport_rematches_owner(db):
    s = await _seeded(db)
    canonical = {c: "" for c in CANONICAL}
    canonical.update(serial_number="sn-0", owner="Storage")
    row = parse_row(2, canonical, dict(canonical), generate_serials=False)
    result = await run_import(db, initiative_id=s.move.id, added_by=None,
                              rows=[row], make_model_mode="hybrid", write=True)
    assert result["summary"]["updated"] == 1, result
    assert await _group_of(db, s.assets[0]) == s.groups["Storage"].id


async def test_roster_patch_rematches(client, db, seeded_user):
    s = await _seeded(db)
    hdrs = await login(client)
    row = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == s.assets[3].id))
    resp = await client.patch(f"/initiatives/assets/{row.id}", headers=hdrs,
                              json={"owner": "STORAGE"})
    assert resp.status_code == 200, resp.text
    assert await _group_of(db, s.assets[3]) == s.groups["Storage"].id


async def test_initiative_client_change_rematches(client, db, seeded_user):
    s = await _seeded(db)
    hdrs = await login(client)
    resp = await client.patch(f"/initiatives/{s.other_move.id}", headers=hdrs,
                              json={"client_id": str(s.client.id)})
    assert resp.status_code == 200, resp.text
    assert await _group_of(db, s.other_assets[0]) == s.groups["Platform"].id


async def test_reimport_rematches_inside_each_batch(db, monkeypatch):
    """A committed batch is never left with stale owner groups."""
    from serversherpa.imports import move_assets
    s = await _seeded(db)
    monkeypatch.setattr(move_assets, "BATCH_SIZE", 1)
    seen = []

    async def progress(processed, *_):
        # runs right before the batch commit; nothing re-matches after it
        if processed == 1:
            seen.append(await _group_of(db, s.assets[0]))

    rows = []
    for serial in ("sn-0", "sn-1"):
        canonical = {c: "" for c in CANONICAL}
        canonical.update(serial_number=serial, owner="Storage")
        rows.append(parse_row(2, canonical, dict(canonical), generate_serials=False))
    await run_import(db, initiative_id=s.move.id, added_by=None, rows=rows,
                     make_model_mode="hybrid", write=True, progress=progress)
    assert seen == [s.groups["Storage"].id]


# ── delete is DB-enforced; mutations serialize per client ─────────────

async def test_chip_fk_blocks_group_delete(db):
    """client_contact_groups.group_id is ON DELETE NO ACTION (client_id
    stays CASCADE): the database itself refuses to drop a held group."""
    from sqlalchemy import text
    rows = dict((await db.execute(text(
        "SELECT a.attname::text, c.confdeltype::text FROM pg_constraint c "
        "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] "
        "WHERE c.conrelid = 'client_contact_groups'::regclass AND c.contype = 'f'"))).all())
    assert rows == {"person_id": "c", "client_id": "c", "group_id": "a"}
    fk = next(iter(ClientContactGroup.__table__.c.group_id.foreign_keys))
    assert fk.ondelete is None or fk.ondelete.upper() == "NO ACTION"


async def test_delete_race_maps_fk_to_group_in_use(db, monkeypatch):
    """A chip that lands after the in-use check (the race the lock and the FK
    close) still gives 409 group_in_use, and the group stays."""
    s = await _seeded(db)
    g = s.groups["Platform"]
    gid = g.id
    p = await _person(db, "late@test.example.com")
    db.add(ClientContactGroup(person_id=p.id, client_id=s.client.id, group_id=gid))
    await db.commit()

    async def no_chips(*_a, **_k):
        return 0
    monkeypatch.setattr(cg, "_chips_held", no_chips)
    with pytest.raises(cg.GroupError) as exc:
        await cg.delete_group(db, g)
    assert exc.value.code == "group_in_use" and exc.value.status == 409
    await db.rollback()
    assert await db.scalar(select(ClientGroup.id).where(ClientGroup.id == gid)) == gid


async def test_client_delete_still_cascades_chips(db):
    """Deleting a client takes its groups and their chips in one statement."""
    from serversherpa.db.models import Client
    s = await _seeded(db)
    p = await _person(db, "gone@test.example.com")
    db.add(ClientContactGroup(person_id=p.id, client_id=s.client.id,
                              group_id=s.groups["Platform"].id))
    await db.commit()
    cid = s.client.id
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(InitiativeAsset))
    from serversherpa.db.models import Asset, Initiative
    await db.execute(sa_delete(Initiative).where(Initiative.client_id == cid))
    await db.execute(sa_delete(Asset).where(Asset.client_id == cid))
    await db.execute(sa_delete(Client).where(Client.id == cid))
    await db.commit()
    assert await db.scalar(select(ClientContactGroup.person_id)) is None
    assert await db.scalar(select(ClientGroup.id).where(ClientGroup.client_id == cid)) is None


async def _client_locks(db) -> set[int]:
    """The advisory lock keys this session's transaction holds."""
    from sqlalchemy import text
    return set(await db.scalars(text(
        "SELECT (classid::bigint << 32) | objid::bigint FROM pg_locks "
        "WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted")))


async def _lock_key(db, client_id) -> int:
    from sqlalchemy import text
    return await db.scalar(text("SELECT hashtext('client_groups:' || :cid)::bigint"),
                           {"cid": str(client_id)})


async def test_group_mutations_take_the_client_lock(db):
    """Every group mutation and every rematch takes the per-client
    transaction advisory lock (released at commit)."""
    s = await _seeded(db)
    cid, other = s.client.id, s.other_client.id
    key = await _lock_key(db, cid)
    platform, storage = s.groups["Platform"], s.groups["Storage"]
    row_ids = list(await db.scalars(select(InitiativeAsset.id)))

    async def run(op):
        await db.commit()
        assert key not in await _client_locks(db)
        await op()
        assert key in await _client_locks(db), op.__name__
        await db.commit()
        assert key not in await _client_locks(db)

    async def create():
        await cg.create_group(db, cid, "Compute", None)

    async def rename():
        await cg.rename_group(db, platform, "Platforms", None)

    async def aliases():
        await cg.set_aliases(db, storage, ["Stor"])

    async def match():
        await cg.match_value(db, cid, "Platfrom", platform.id)

    async def dismiss():
        await cg.set_dismissed(db, cid, "Whatever", True, None)

    async def rematch():
        await cg.rematch_client(db, cid)

    async def rows():
        await cg.rematch_rows(db, row_ids)

    async def initiative():
        await cg.rematch_initiative(db, s.move.id)

    async def merge():
        await cg.merge_groups(db, platform, storage, dry_run=False)

    async def remove():
        compute = await db.scalar(select(ClientGroup).where(ClientGroup.name == "Compute"))
        await cg.delete_group(db, compute)

    for op in (create, rename, aliases, match, dismiss, rematch, rows, initiative,
               merge, remove):
        await run(op)
    # rows spanning two clients lock both
    await db.commit()
    await cg.rematch_rows(db, row_ids)
    assert {key, await _lock_key(db, other)} <= await _client_locks(db)
    await db.commit()
