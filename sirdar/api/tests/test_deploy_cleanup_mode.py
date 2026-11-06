"""The cleanup mode: Delete's steps, run to clear a failed first deploy,
without deleting the environment."""
import psycopg
import pytest

from sirdar_api.db.models import Deployment
from sirdar_api.deploy import pipeline, steps

from .conftest import TEST_DB, _psycopg_url
from .deploy_factories import make_environment, secrets_key  # noqa: F401
from .test_deploy_models import _alembic

SHA = "e73b99ca" + "0" * 32
TARGETS = [{}, {"vm": True}, {"cloud": True}, {"vm": True, "bluegreen": True}]


def _keys(mode, **kw):
    return [s.key for s in steps.plan_for(mode, **kw)]


@pytest.mark.parametrize("kw", TARGETS)
def test_cleanup_plan_equals_teardown(kw):
    assert _keys("cleanup", **kw) == _keys("teardown", **kw)


def test_cleanup_is_a_mode_and_a_removing_mode():
    assert "cleanup" in steps.MODES
    assert steps.REMOVING_MODES == ("teardown", "cleanup")


@pytest.mark.parametrize("kw", TARGETS)
def test_cleanup_refuses_snapshot(kw):
    with pytest.raises(ValueError):
        steps.plan_for("cleanup", snapshot=True, **kw)


async def test_migration_0016_round_trip():
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        env_id = conn.execute(
            "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
            "VALUES ('cl', 'dev', 'ssh', 'cl.serversherpa.com', '10.0.0.2') RETURNING id"
        ).fetchone()[0]

    def insert(mode):
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            conn.execute(
                "INSERT INTO deployments (environment_id, mode, git_ref, sha, status) "
                "VALUES (%s, %s, 'main', %s, 'failed')", (env_id, mode, SHA))

    try:
        insert("cleanup")                               # upgraded: accepted
        _alembic("downgrade", "0015")
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            assert conn.execute("SELECT count(*) FROM deployments WHERE mode = 'cleanup'"
                                ).fetchone()[0] == 0
        with pytest.raises(psycopg.errors.CheckViolation):
            insert("cleanup")
    finally:
        _alembic("upgrade", "head")
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            conn.execute("DELETE FROM environments WHERE id = %s", (env_id,))


async def test_cleanup_marks_env_deleting(db, secrets_key):  # noqa: F811
    env = await make_environment(db, current_sha=None)
    dep = await pipeline.create_deployment(db, env, mode="cleanup", git_ref="main", sha=SHA,
                                           actor_id=None)
    await db.commit()
    assert isinstance(dep, Deployment) and dep.mode == "cleanup"
    await db.refresh(env)
    assert env.status == "deleting"
