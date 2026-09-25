"""The wiki permission resolver (serversherpa.wiki.permissions).

Direct DB fixtures, no HTTP: build a space and a small tree, add grants,
and ask an AccessIndex what level a hand-built Principal has."""
import uuid
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from serversherpa.access.resolver import AccessInfo
from serversherpa.api.deps import AuthContext
from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    AccessGroup,
    AccessGroupMember,
    Client,
    Partner,
    Person,
    WikiGrant,
    WikiNode,
    WikiSpace,
)
from serversherpa.wiki.permissions import (
    AccessIndex,
    Principal,
    grant_matches,
    level_rank,
    max_level,
    principal_for,
    principal_labels,
    require_node_level,
    require_space_level,
)

# ── fixtures / helpers ──────────────────────────────────────────────


async def _person(db, first="Pat", last="Person", preferred=None) -> Person:
    p = Person(first_name=first, last_name=last, preferred_name=preferred)
    db.add(p)
    await db.flush()
    return p


def _principal(person_id=None, *, roles=(), group_ids=(), client_ids=(),
               partner_ids=(), is_internal=False, is_admin=False,
               can_view_wiki=True) -> Principal:
    return Principal(
        person_id=person_id or uuid.uuid4(),
        roles=frozenset(roles),
        group_ids=frozenset(group_ids),
        client_ids=frozenset(client_ids),
        partner_ids=frozenset(partner_ids),
        is_internal=is_internal,
        is_admin=is_admin,
        can_view_wiki=can_view_wiki,
    )


def _staff(person_id=None, **kw) -> Principal:
    return _principal(person_id, roles={"staff"}, is_internal=True, **kw)


async def _space(db, key="ops", name="Ops Guides") -> WikiSpace:
    s = WikiSpace(key=key, name=name)
    db.add(s)
    await db.flush()
    return s


async def _node(db, space, parent=None, title="Node", kind="folder",
                inherit=True) -> WikiNode:
    n = WikiNode(
        space_id=space.id,
        parent_id=parent.id if parent else None,
        path=(list(parent.path) + [parent.id]) if parent else [],
        kind=kind, title=title, inherit_permissions=inherit,
    )
    db.add(n)
    await db.flush()
    return n


async def _grant(db, space, principal_type, principal_id, level, node=None):
    g = WikiGrant(space_id=space.id, node_id=node.id if node else None,
                  principal_type=principal_type,
                  principal_id=None if principal_id is None else str(principal_id),
                  level=level)
    db.add(g)
    await db.flush()
    return g


async def _level(db, principal, node):
    return await AccessIndex(db, principal).level_for_node(node)


# ── level helpers ───────────────────────────────────────────────────


def test_level_rank_and_max_level():
    assert [level_rank(x) for x in (None, "view", "edit", "manage")] == [0, 1, 2, 3]
    assert max_level(None, None) is None
    assert max_level(None, "view") == "view"
    assert max_level("edit", "view") == "edit"
    assert max_level("edit", "manage") == "manage"


# ── space-level grants ──────────────────────────────────────────────


async def test_internal_view_reaches_staff_not_client_users(db):
    space = await _space(db)
    page = await _node(db, space, title="Runbook", kind="page")
    await _grant(db, space, "internal", None, "view")

    staff = _staff()
    client_user = _principal(roles={"client_viewer"}, client_ids={uuid.uuid4()})

    assert await AccessIndex(db, staff).level_for_space(space.id) == "view"
    assert await _level(db, staff, page) == "view"
    assert await AccessIndex(db, client_user).level_for_space(space.id) is None
    assert await _level(db, client_user, page) is None


async def test_everyone_view_reaches_client_users_but_not_without_wiki_view(db):
    space = await _space(db)
    page = await _node(db, space, kind="page")
    await _grant(db, space, "everyone", None, "view")

    client_user = _principal(roles={"client_viewer"})
    assert await _level(db, client_user, page) == "view"

    no_wiki = _principal(roles={"client_viewer"}, can_view_wiki=False)
    assert await _level(db, no_wiki, page) is None
    assert await AccessIndex(db, no_wiki).level_for_space(space.id) is None


# ── node-level additive grants ──────────────────────────────────────


async def test_node_grant_is_additive_to_folder_and_descendants_only(db):
    x = await _person(db)
    space = await _space(db)
    folder = await _node(db, space, title="Folder")
    child = await _node(db, space, folder, title="Child", kind="page")
    grandchild = await _node(db, space, child, title="Grandchild", kind="page")
    sibling = await _node(db, space, title="Sibling")
    await _grant(db, space, "internal", None, "view")
    await _grant(db, space, "person", x.id, "edit", node=folder)

    px = _staff(x.id)
    ix = AccessIndex(db, px)
    assert await ix.level_for_space(space.id) == "view"
    assert await ix.level_for_node(folder) == "edit"
    assert await ix.level_for_node(child) == "edit"
    assert await ix.level_for_node(grandchild) == "edit"
    assert await ix.level_for_node(sibling) == "view"
    # someone else on staff is untouched by X's grant
    assert await _level(db, _staff(), folder) == "view"


# ── broken inheritance ──────────────────────────────────────────────


async def test_break_replaces_the_set_but_space_managers_keep_manage(db):
    manager = await _person(db, "Mona", "Manager")
    space = await _space(db)
    locked = await _node(db, space, title="Locked", inherit=False)
    inside = await _node(db, space, locked, title="Inside", kind="page")
    await _grant(db, space, "everyone", None, "edit")
    await _grant(db, space, "person", manager.id, "manage")
    await _grant(db, space, "role", "staff", "view", node=locked)

    outsider = _principal(roles={"client_viewer"})
    staff = _staff()
    mgr = _staff(manager.id)

    # above the break, everyone edits
    assert await AccessIndex(db, outsider).level_for_space(space.id) == "edit"
    # below it, only the node's own grants (plus space managers) apply
    assert await _level(db, outsider, locked) is None
    assert await _level(db, outsider, inside) is None
    assert await _level(db, staff, locked) == "view"
    assert await _level(db, staff, inside) == "view"
    assert await _level(db, mgr, locked) == "manage"
    assert await _level(db, mgr, inside) == "manage"


async def test_nested_break_then_additive_grant_below_it(db):
    x = await _person(db)
    y = await _person(db, "Yuri", "Yates")
    space = await _space(db)
    outer = await _node(db, space, title="Outer", inherit=False)
    inner = await _node(db, space, outer, title="Inner", inherit=False)
    below = await _node(db, space, inner, title="Below")
    leaf = await _node(db, space, below, title="Leaf", kind="page")
    await _grant(db, space, "internal", None, "view")
    await _grant(db, space, "role", "staff", "edit", node=outer)
    await _grant(db, space, "person", x.id, "view", node=inner)
    await _grant(db, space, "person", y.id, "edit", node=below)

    px, py = _staff(x.id), _staff(y.id)
    # outer: staff edit; inner replaced by X only; below adds Y
    assert await _level(db, px, outer) == "edit"
    assert await _level(db, py, outer) == "edit"
    assert await _level(db, px, inner) == "view"
    assert await _level(db, py, inner) is None
    assert await _level(db, px, below) == "view"
    assert await _level(db, py, below) == "edit"
    assert await _level(db, px, leaf) == "view"
    assert await _level(db, py, leaf) == "edit"
    assert await _level(db, _staff(), leaf) is None


async def test_highest_matching_level_wins(db):
    x = await _person(db)
    space = await _space(db)
    folder = await _node(db, space)
    await _grant(db, space, "internal", None, "view")
    await _grant(db, space, "role", "staff", "edit")
    await _grant(db, space, "person", x.id, "view", node=folder)

    px = _staff(x.id)
    assert await AccessIndex(db, px).level_for_space(space.id) == "edit"
    assert await _level(db, px, folder) == "edit"


# ── principal matching ──────────────────────────────────────────────


async def test_each_principal_type_matches(db):
    x = await _person(db)
    group = AccessGroup(name="Night shift")
    client = Client(name="Acme")
    partner = Partner(name="Haulers Inc")
    db.add_all([group, client, partner])
    await db.flush()

    space = await _space(db)
    folders = {}
    for kind, pid in (("access_group", group.id), ("client", client.id),
                      ("partner", partner.id), ("role", "worker"),
                      ("person", x.id)):
        folders[kind] = await _node(db, space, title=kind)
        await _grant(db, space, kind, pid, "edit", node=folders[kind])

    matches = {
        "access_group": _principal(group_ids={group.id}),
        "client": _principal(client_ids={client.id}),
        "partner": _principal(partner_ids={partner.id}),
        "role": _principal(roles={"worker"}),
        "person": _principal(x.id),
    }
    for kind, principal in matches.items():
        ix = AccessIndex(db, principal)
        for other_kind, folder in folders.items():
            want = "edit" if other_kind == kind else None
            assert await ix.level_for_node(folder) == want, (kind, other_kind)


def test_grant_matches_never_raises_on_malformed_ids():
    p = _principal(uuid.uuid4(), roles={"staff"}, is_internal=True,
                   group_ids={uuid.uuid4()}, client_ids={uuid.uuid4()},
                   partner_ids={uuid.uuid4()})
    assert grant_matches(p, "everyone", None)
    assert grant_matches(p, "internal", None)
    assert not grant_matches(_principal(), "internal", None)
    for kind in ("access_group", "person", "client", "partner"):
        assert not grant_matches(p, kind, "not-a-uuid")
        assert not grant_matches(p, kind, None)
        assert not grant_matches(p, kind, "")
    assert not grant_matches(p, "role", None)
    assert not grant_matches(p, "bogus", "staff")
    assert grant_matches(p, "person", str(p.person_id).upper())


async def test_malformed_uuid_grant_in_db_matches_nobody(db):
    space = await _space(db)
    folder = await _node(db, space)
    await _grant(db, space, "person", "definitely-not-a-uuid", "manage", node=folder)
    assert await _level(db, _staff(), folder) is None


# ── archived spaces / admins ────────────────────────────────────────


async def test_archived_space_is_read_only_except_for_admins(db):
    x = await _person(db)
    space = await _space(db)
    space.archived_at = datetime.now(UTC)
    page = await _node(db, space, kind="page")
    await _grant(db, space, "person", x.id, "manage")
    await db.flush()

    px = _staff(x.id)
    assert await AccessIndex(db, px).level_for_space(space.id) == "view"
    assert await _level(db, px, page) == "view"
    admin = _staff(is_admin=True)
    assert await AccessIndex(db, admin).level_for_space(space.id) == "manage"
    assert await _level(db, admin, page) == "manage"
    # no grant stays no grant
    assert await _level(db, _staff(), page) is None


async def test_wiki_admin_manages_everything_without_grants(db):
    space = await _space(db)
    locked = await _node(db, space, inherit=False)
    page = await _node(db, space, locked, kind="page")
    admin = _principal(is_admin=True)
    ix = AccessIndex(db, admin)
    assert await ix.level_for_space(space.id) == "manage"
    assert await ix.level_for_node(locked) == "manage"
    assert await ix.level_for_node(page) == "manage"


# ── batching / memoization ──────────────────────────────────────────


async def test_levels_for_nodes_uses_a_bounded_number_of_queries(db):
    x = await _person(db)
    spaces, nodes = [], []
    for i in range(2):
        space = await _space(db, key=f"space-{i}", name=f"Space {i}")
        spaces.append(space)
        await _grant(db, space, "internal", None, "view")
        parent = None
        for j in range(25):
            # a mix of chains, breaks and node grants
            parent = await _node(db, space, parent if j % 5 else None,
                                 title=f"N{j}", inherit=(j % 7 != 3))
            nodes.append(parent)
            if j % 4 == 0:
                await _grant(db, space, "person", x.id, "edit", node=parent)
    await db.commit()

    statements: list[str] = []

    def _count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", _count)
    walks = 0
    try:
        ix = AccessIndex(db, _staff(x.id))
        real_final_set = ix._final_set

        def _counting_final_set(*args):
            nonlocal walks
            walks += 1
            return real_final_set(*args)

        ix._final_set = _counting_final_set
        levels = await ix.levels_for_nodes(nodes)
        walks_first = walks
        again = await ix.levels_for_nodes(nodes)
        await ix.level_for_node(nodes[7])
    finally:
        event.remove(engine, "before_cursor_execute", _count)

    assert len(nodes) == 50
    assert set(levels) == {n.id for n in nodes}
    assert again == levels
    # memoized: the second pass walks no chains at all
    assert walks_first == 50 and walks == walks_first
    # _load_spaces batches its 3 queries across every missing space in one
    # call, so this is 3 total regardless of len(spaces) — pinned exact
    # since it's proven stable, not just bounded.
    assert len(statements) > 0
    assert len(statements) == 3, statements
    assert all(v in ("view", "edit", None) for v in levels.values())


# ── require_* guards ────────────────────────────────────────────────


async def test_require_node_level_404s_and_403s(db):
    space = await _space(db)
    page = await _node(db, space, kind="page")
    gone = await _node(db, space, kind="page", title="Gone")
    gone.deleted_at = datetime.now(UTC)
    hidden = await _node(db, space, kind="page", title="Hidden", inherit=False)
    await _grant(db, space, "internal", None, "view")
    await db.flush()

    ix = AccessIndex(db, _staff())
    assert await require_node_level(ix, page, "view") is page

    for node in (None, gone, hidden):
        with pytest.raises(HTTPException) as err:
            await require_node_level(ix, node, "view")
        assert err.value.status_code == 404
        assert err.value.detail["code"] == "not_found"

    with pytest.raises(HTTPException) as err:
        await require_node_level(ix, page, "edit")
    assert err.value.status_code == 403
    assert err.value.detail["code"] == "forbidden"


async def test_require_space_level_404s_and_403s(db):
    space = await _space(db)
    other = await _space(db, key="other", name="Other")
    await _grant(db, space, "internal", None, "edit")

    ix = AccessIndex(db, _staff())
    assert await require_space_level(ix, space, "edit") is space
    for s in (None, other):
        with pytest.raises(HTTPException) as err:
            await require_space_level(ix, s, "view")
        assert err.value.status_code == 404
        assert err.value.detail["code"] == "not_found"
    with pytest.raises(HTTPException) as err:
        await require_space_level(ix, space, "manage")
    assert err.value.status_code == 403
    assert err.value.detail["code"] == "forbidden"


# ── effective grants + labels ───────────────────────────────────────


async def test_effective_grants_list_sources_and_labels(db):
    mona = await _person(db, "Mona", "Manager", preferred="Mo")
    x = await _person(db, "Xavier", "Xu")
    group = AccessGroup(name="Night shift")
    client = Client(name="Acme")
    partner = Partner(name="Haulers Inc")
    db.add_all([group, client, partner])
    await db.flush()

    space = await _space(db)
    folder = await _node(db, space, title="Folder")
    locked = await _node(db, space, folder, title="Locked", inherit=False)
    page = await _node(db, space, locked, title="Page", kind="page")
    await _grant(db, space, "everyone", None, "view")
    await _grant(db, space, "internal", None, "edit")
    await _grant(db, space, "person", mona.id, "manage")
    await _grant(db, space, "access_group", group.id, "edit", node=folder)
    await _grant(db, space, "role", "staff", "view", node=locked)
    await _grant(db, space, "client", client.id, "view", node=locked)
    await _grant(db, space, "partner", partner.id, "view", node=page)
    await _grant(db, space, "person", x.id, "edit", node=page)

    ix = AccessIndex(db, _staff())

    rows = await ix.effective_grants(folder, space.id)
    got = {(r.principal_type, r.principal_label, r.level, r.source_kind,
            r.source_node_id, r.source_title) for r in rows}
    assert got == {
        ("everyone", "Everyone who can sign in", "view", "space", None, "Ops Guides"),
        ("internal", "All internal staff", "edit", "space", None, "Ops Guides"),
        ("person", "Mo Manager", "manage", "space", None, "Ops Guides"),
        ("access_group", "Night shift", "edit", "node", folder.id, "Folder"),
    }

    # below the break: the node's own grants, the space manager, then additions
    rows = await ix.effective_grants(page, space.id)
    got = {(r.principal_type, r.principal_id, r.principal_label, r.level,
            r.source_kind, r.source_node_id, r.source_title) for r in rows}
    assert got == {
        ("person", str(mona.id), "Mo Manager", "manage", "space", None, "Ops Guides"),
        ("role", "staff", "Staff", "view", "node", locked.id, "Locked"),
        ("client", str(client.id), "Acme", "view", "node", locked.id, "Locked"),
        ("partner", str(partner.id), "Haulers Inc", "view", "node", page.id, "Page"),
        ("person", str(x.id), "Xavier Xu", "edit", "node", page.id, "Page"),
    }

    # the space itself: only the space-level grants
    rows = await ix.effective_grants(None, space.id)
    assert {r.principal_type for r in rows} == {"everyone", "internal", "person"}
    assert all(r.source_kind == "space" for r in rows)


async def test_principal_labels_fall_back_for_unknown_principals(db):
    space = await _space(db)
    missing = uuid.uuid4()
    grants = [
        await _grant(db, space, "person", missing, "view"),
        await _grant(db, space, "access_group", "not-a-uuid", "view"),
        await _grant(db, space, "role", "no_such_role", "view"),
    ]
    labels = await principal_labels(db, grants)
    assert labels[("person", str(missing))] == "Unknown person"
    assert labels[("access_group", "not-a-uuid")] == "Unknown access group"
    assert labels[("role", "no_such_role")] == "no_such_role"


# ── principal_for ───────────────────────────────────────────────────


async def test_principal_for_builds_from_the_auth_context(db):
    person = await _person(db)
    g1, g2 = AccessGroup(name="A"), AccessGroup(name="B")
    db.add_all([g1, g2])
    await db.flush()
    db.add(AccessGroupMember(group_id=g1.id, person_id=person.id))
    await db.flush()

    client_id, partner_id = uuid.uuid4(), uuid.uuid4()
    access = AccessInfo(
        perms={"wiki": {"view": True, "delete": False}},
        role_names=["client_admin", "staff"],
        client_ids={client_id}, partner_ids={partner_id}, is_global=True,
    )
    user = AuthContext(person=person, account=None, roles=access.role_names,
                       session=None, access=access)
    p = await principal_for(db, user)
    assert p.person_id == person.id
    assert p.roles == frozenset({"client_admin", "staff"})
    assert p.group_ids == frozenset({g1.id})
    assert p.client_ids == frozenset({client_id})
    assert p.partner_ids == frozenset({partner_id})
    assert p.is_internal is True
    assert p.is_admin is False
    assert p.can_view_wiki is True
