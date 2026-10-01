import importlib.util
from pathlib import Path

from sirdar_api.access.defaults import DEFAULT_GRANTS, DEFAULT_ROLES
from sirdar_api.access.resolver import assemble, can_touch_rank, resolve_access, role_matrix
from sirdar_api.access.resources import ACTIONS, REGISTRY
from sirdar_api.db.models import PermissionOverride

from .factories import make_user


def test_defaults_only_name_known_resources_and_actions():
    for grants in DEFAULT_GRANTS.values():
        for res, actions in grants.items():
            assert res in REGISTRY
            assert set(actions) <= set(ACTIONS)
    assert [r for r, g in DEFAULT_GRANTS.items() if "devtools" in g] == ["developer"]


def _load(name, fname):
    path = Path(__file__).resolve().parents[1] / "migrations/versions" / fname
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_seed_matches_defaults():
    m1 = _load("m0001", "0001_initial.py")
    m3 = _load("m0003", "0003_deploy.py")
    assert m1.ROLES == DEFAULT_ROLES
    expected = {role: {**grants} for role, grants in m1.GRANTS.items()}
    for role, actions in m3.DEPLOY_GRANTS.items():
        expected[role]["deploy"] = actions
    assert expected == DEFAULT_GRANTS


async def test_deploy_grants_resolve(db):
    sa = await resolve_access(db, (await make_user(db, roles=("super_admin",))).person_id)
    assert sa.can("deploy", "view") and sa.can("deploy", "add") and sa.can("deploy", "change")
    assert not sa.can("deploy", "delete")
    ad = await resolve_access(db, (await make_user(db, email="b@test.example.com",
                                                   roles=("admin",))).person_id)
    assert ad.can("deploy", "view")
    assert not ad.can("deploy", "add") and not ad.can("deploy", "change")


def test_can_touch_rank():
    assert can_touch_rank(80, 60)
    assert not can_touch_rank(80, 80)
    assert not can_touch_rank(60, 80)
    assert can_touch_rank(100, 100)


def test_assemble_role_union_override_and_hard_gate():
    info = assemble([("admin", 60), ("super_admin", 80)],
                    {"users": {"view", "add"}, "devtools": {"view"}},
                    {"users": {"add": False}, "devtools": {"view": True}})
    assert info.max_rank == 80
    assert info.role_names == ["admin", "super_admin"]
    assert info.can("users", "view") and info.sources["users"]["view"] == "role"
    assert not info.can("users", "add") and info.sources["users"]["add"] == "override"
    # devtools is developer-only: neither grants nor overrides reach it
    assert not info.can("devtools", "view") and info.sources["devtools"]["view"] == "hard_gate"
    assert set(info.perms) == set(REGISTRY)


async def test_resolve_access_reads_roles_and_overrides(db):
    user = await make_user(db, roles=("admin",))
    db.add(PermissionOverride(person_id=user.person_id, resource="users", action="change",
                              allow=True))
    await db.commit()
    info = await resolve_access(db, user.person_id)
    assert info.can("users", "view") and info.can("users", "change")
    assert not info.can("users", "delete")
    assert info.max_rank == 60


async def test_developer_sees_devtools(db):
    user = await make_user(db, roles=("developer",))
    assert (await resolve_access(db, user.person_id)).can("devtools", "view")


async def test_role_matrix(db):
    matrix = await role_matrix(db)
    assert matrix["admin"]["users"] == {"view"}
    assert "devtools" in matrix["developer"]
