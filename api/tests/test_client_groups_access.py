"""Client groups: per-client tiers, group chips and the group-aware scope."""
from sqlalchemy import select

from serversherpa.access.resolver import resolve_access, resolve_access_many
from serversherpa.access.scope import (
    is_restricted_at, roster_row_condition, scope_conditions,
)
from serversherpa.clientgroups import service as cg
from serversherpa.db.models import (
    Asset, ClientContactGroup, InitiativeAsset, Person, PersonRole,
)

from tests.client_groups_fixtures import client_user, seed_grouped_client


async def _seeded(db):
    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    return s


async def _person(db, roles, chips=()):
    """A person with `roles` [(role, client_id)] and `chips` [(client_id, group_id)]."""
    p = Person(first_name="Cli", last_name="Ent")
    db.add(p)
    await db.flush()
    for role, cid in roles:
        db.add(PersonRole(person_id=p.id, role=role, client_id=cid))
    for cid, gid in chips:
        db.add(ClientContactGroup(person_id=p.id, client_id=cid, group_id=gid))
    await db.commit()
    return p


async def _visible_assets(db, pid):
    info = await resolve_access(db, pid)
    cond = scope_conditions("assets", info, pid)
    assert cond is not None
    return set(await db.scalars(select(Asset.id).where(cond)))


async def _visible_rows(db, pid, move):
    info = await resolve_access(db, pid)
    cond = roster_row_condition(info)
    q = select(InitiativeAsset.asset_id).where(InitiativeAsset.initiative_id == move.id)
    if cond is not None:
        q = q.where(cond)
    return set(await db.scalars(q))


def _ids(s, *idx):
    return {s.assets[i].id for i in idx}


async def test_owner_admin_unchipped_viewer_see_all_four(db):
    s = await _seeded(db)
    for role in ("client_owner", "client_admin", "client_viewer"):
        p = await _person(db, [(role, s.client.id)])
        assert await _visible_assets(db, p.id) == _ids(s, 0, 1, 2, 3), role
        info = await resolve_access(db, p.id)
        assert info.client_tiers == {s.client.id: role.removeprefix("client_")}
        assert info.restricted_clients() == {}
        assert roster_row_condition(info) is None
        assert not is_restricted_at(info, s.client.id)


async def test_viewer_with_platform_sees_platform_and_blank(db):
    s = await _seeded(db)
    plat = s.groups["Platform"].id
    p = await _person(db, [("client_viewer", s.client.id)], [(s.client.id, plat)])
    assert await _visible_assets(db, p.id) == _ids(s, 0, 2)
    info = await resolve_access(db, p.id)
    assert info.client_group_ids == {s.client.id: frozenset({plat})}
    assert info.restricted_clients() == {s.client.id: ("viewer", frozenset({plat}))}
    assert is_restricted_at(info, s.client.id)
    assert not is_restricted_at(info, s.other_client.id)
    assert not is_restricted_at(info, None)


async def test_individual_without_chips_sees_none(db):
    s = await _seeded(db)
    p = await _person(db, [("client_individual", s.client.id)])
    assert await _visible_assets(db, p.id) == set()
    info = await resolve_access(db, p.id)
    assert info.client_tiers == {s.client.id: "individual"}
    assert info.restricted_clients() == {s.client.id: ("individual", frozenset())}


async def test_individual_with_storage_sees_only_storage(db):
    s = await _seeded(db)
    p = await _person(db, [("client_individual", s.client.id)],
                      [(s.client.id, s.groups["Storage"].id)])
    assert await _visible_assets(db, p.id) == _ids(s, 1)


async def test_owner_chips_ignored(db):
    s = await _seeded(db)
    p = await _person(db, [("client_owner", s.client.id)],
                      [(s.client.id, s.groups["Storage"].id)])
    assert await _visible_assets(db, p.id) == _ids(s, 0, 1, 2, 3)
    assert (await resolve_access(db, p.id)).restricted_clients() == {}


async def test_asset_on_no_move_counts_as_blank(db):
    s = await _seeded(db)
    loose = Asset(name="loose", serial_number="sn-loose", client_id=s.client.id)
    db.add(loose)
    await db.commit()
    viewer = await _person(db, [("client_viewer", s.client.id)],
                           [(s.client.id, s.groups["Platform"].id)])
    assert loose.id in await _visible_assets(db, viewer.id)
    ind = await _person(db, [("client_individual", s.client.id)],
                        [(s.client.id, s.groups["Platform"].id)])
    assert loose.id not in await _visible_assets(db, ind.id)


async def test_two_clients_rules_independent(db):
    s = await _seeded(db)
    p = await _person(db, [("client_viewer", s.client.id),
                           ("client_owner", s.other_client.id)],
                      [(s.client.id, s.groups["Platform"].id)])
    assert await _visible_assets(db, p.id) == (
        _ids(s, 0, 2) | {a.id for a in s.other_assets})
    assert await _visible_rows(db, p.id, s.other_move) == {a.id for a in s.other_assets}


async def test_two_rows_same_client_keep_highest_rank(db):
    s = await _seeded(db)
    p = await _person(db, [("client_individual", s.client.id),
                           ("client_admin", s.client.id)])
    info = await resolve_access(db, p.id)
    assert info.client_tiers == {s.client.id: "admin"}
    assert info.restricted_clients() == {}


async def test_roster_row_condition_matches_asset_rule(db):
    s = await _seeded(db)
    plat, stor = s.groups["Platform"].id, s.groups["Storage"].id
    cases = [
        ([("client_owner", s.client.id)], [(s.client.id, stor)], _ids(s, 0, 1, 2, 3)),
        ([("client_viewer", s.client.id)], [], _ids(s, 0, 1, 2, 3)),
        ([("client_viewer", s.client.id)], [(s.client.id, plat)], _ids(s, 0, 2)),
        ([("client_individual", s.client.id)], [], set()),
        ([("client_individual", s.client.id)], [(s.client.id, stor)], _ids(s, 1)),
    ]
    for roles, chips, expected in cases:
        p = await _person(db, roles, chips)
        assert await _visible_rows(db, p.id, s.move) == expected, (roles, chips)
        assert await _visible_assets(db, p.id) == expected, (roles, chips)


async def test_resolve_access_many_matches_single(db):
    s = await _seeded(db)
    a = await _person(db, [("client_viewer", s.client.id)],
                      [(s.client.id, s.groups["Platform"].id)])
    b = await _person(db, [("client_individual", s.client.id),
                           ("client_owner", s.other_client.id)])
    many = await resolve_access_many(db, [a.id, b.id])
    for pid in (a.id, b.id):
        one = await resolve_access(db, pid)
        assert many[pid].client_tiers == one.client_tiers
        assert many[pid].client_group_ids == one.client_group_ids
        assert many[pid].restricted_clients() == one.restricted_clients()


async def test_global_unrestricted(db):
    s = await _seeded(db)
    p = Person(first_name="A", last_name="Admin")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="admin"))
    # chips on a global actor never restrict them
    db.add(ClientContactGroup(person_id=p.id, client_id=s.client.id,
                              group_id=s.groups["Platform"].id))
    await db.commit()
    info = await resolve_access(db, p.id)
    assert scope_conditions("assets", info, p.id) is None
    assert roster_row_condition(info) is None
    assert info.restricted_clients() == {}
    assert not is_restricted_at(info, s.client.id)


async def test_me_scope_lists_restricted_clients(db, client):
    s = await _seeded(db)
    viewer = await client_user(db, client, s.client.id, "client_viewer",
                               [s.groups["Platform"].id], email="cg-viewer@test.example.com")
    resp = await client.get("/auth/me", headers=viewer)
    assert resp.status_code == 200, resp.text
    assert resp.json()["scope"]["restricted_client_ids"] == [str(s.client.id)]
    owner = await client_user(db, client, s.client.id, "client_owner",
                              email="cg-owner@test.example.com")
    resp = await client.get("/auth/me", headers=owner)
    assert resp.status_code == 200, resp.text
    assert resp.json()["scope"]["restricted_client_ids"] == []


async def test_newest_roster_row_decides_asset_group(db):
    from datetime import UTC, datetime, timedelta

    from serversherpa.db.models import Initiative

    s = await _seeded(db)
    newer = Initiative(name="Acme move 2", initiative_type="move", sub_type="migration",
                       client_id=s.client.id)
    db.add(newer)
    await db.flush()
    old_row = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == s.assets[0].id))
    old_row.created_at = datetime.now(UTC) - timedelta(days=1)
    db.add(InitiativeAsset(initiative_id=newer.id, asset_id=s.assets[0].id,
                           owner="Storage", created_at=datetime.now(UTC)))
    await db.commit()
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    p = await _person(db, [("client_viewer", s.client.id)],
                      [(s.client.id, s.groups["Platform"].id)])
    # the asset's group is now Storage (newest row), so it leaves the viewer's list
    assert await _visible_assets(db, p.id) == _ids(s, 2)
    # but on the first move its own Platform row still decides
    assert await _visible_rows(db, p.id, s.move) == _ids(s, 0, 2)
