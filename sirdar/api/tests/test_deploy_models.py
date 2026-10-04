import os
import subprocess

import psycopg
import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
    Snapshot,
)

from .conftest import API_DIR, TEST_DB, _psycopg_url

SHA = "a" * 40


async def _env(db, name="uat") -> Environment:
    env = Environment(name=name, type="dev", target_id="ssh",
                      base_domain=f"{name}.serversherpa.com", proxy_ip="10.0.0.2",
                      git_ref="main", status="new", bind_ip="0.0.0.0", keep_dumps=5,
                      spaces_bucket="serversherpa", log_level="INFO")
    db.add(env)
    await db.commit()
    return env


def _dep(env, status="running") -> Deployment:
    return Deployment(environment_id=env.id, mode="update", git_ref="main", sha=SHA,
                      status=status, start_step=1)


async def test_tables_exist(db):
    names = set(await db.scalars(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")))
    assert {"environments", "environment_services", "environment_secrets", "deployments",
            "deployment_steps"} <= names


async def test_server_defaults_are_loaded(db):
    env = await _env(db)
    dep = _dep(env)
    db.add(dep)
    await db.commit()
    assert env.created_at is not None and env.updated_at is not None
    assert dep.created_at is not None and dep.started_at is not None
    assert dep.finished_at is None


async def test_one_running_deployment_per_environment(db):
    env = await _env(db)
    other = await _env(db, "qa")
    db.add(_dep(env))
    await db.commit()
    db.add(_dep(other))
    db.add(_dep(env, "succeeded"))
    await db.commit()
    db.add(_dep(env))
    with pytest.raises(IntegrityError) as exc:
        await db.commit()
    assert "deployments_one_running" in str(exc.value.orig)
    await db.rollback()


async def test_check_constraints_and_unique_names(db):
    env = await _env(db)
    db.add(_dep(env, "bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(Environment(name="uat", type="dev", target_id="ssh", base_domain="x.example.com",
                       proxy_ip="10.0.0.2", git_ref="main", status="new", bind_ip="0.0.0.0",
                       keep_dumps=5, spaces_bucket="serversherpa", log_level="INFO"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_deleting_an_environment_cascades(db):
    env = await _env(db)
    db.add(EnvironmentService(environment_id=env.id, service="api", host_ip="10.0.0.5",
                              port=8000, hostname="api.uat.serversherpa.com", proxied=False))
    db.add(EnvironmentSecret(environment_id=env.id, key="POSTGRES_PASSWORD", value_enc=b"x"))
    dep = _dep(env)
    db.add(dep)
    await db.flush()
    db.add(DeploymentStep(deployment_id=dep.id, number=1, key="preflight", name="Preflight",
                          status="pending"))
    await db.commit()
    await db.execute(delete(Environment).where(Environment.id == env.id))
    await db.commit()
    for model in (EnvironmentService, EnvironmentSecret, Deployment, DeploymentStep):
        assert await db.scalar(select(func.count()).select_from(model)) == 0


def _snapshot(name="dev-2026-10-04", status="ready", **over) -> Snapshot:
    kw = dict(name=name, origin="upload", source="mac-dev", status=status,
              alembic_revision="0089", size_bytes=10, checksum="0" * 64,
              bundle_file=f"{name}.tar.gz")
    kw.update(over)
    return Snapshot(**kw)


async def test_snapshots_and_the_columns_that_point_at_them(db):
    snap = _snapshot()
    db.add(snap)
    env = await _env(db)
    env.seed_snapshot_id = snap.id
    dep = Deployment(environment_id=env.id, mode="snapshot", git_ref="main", sha=SHA,
                     status="succeeded", start_step=1, snapshot_id=snap.id,
                     restore_dump="20261004T010203Z.dump")
    db.add(dep)
    await db.commit()
    await db.refresh(snap)
    assert (snap.notes, snap.object_count) == ("", None)
    assert snap.created_at is not None
    await db.execute(delete(Snapshot).where(Snapshot.id == snap.id))
    await db.commit()
    await db.refresh(env)
    await db.refresh(dep)
    assert (env.seed_snapshot_id, dep.snapshot_id) == (None, None)
    assert dep.restore_dump == "20261004T010203Z.dump"


@pytest.mark.parametrize("mode", ["update", "reset", "adopt", "snapshot", "restore_dump",
                                  "rollback"])
async def test_deployment_modes(db, mode):
    env = await _env(db)
    db.add(Deployment(environment_id=env.id, mode=mode, git_ref="main", sha=SHA,
                      status="succeeded", start_step=1))
    await db.commit()


async def test_snapshot_constraints(db):
    db.add(_snapshot(name="pending-one", status="pending", bundle_file=None,
                     alembic_revision=None, size_bytes=None, checksum=None))
    await db.commit()
    for bad in (_snapshot(name="x", bundle_file=None), _snapshot(name="y", status="bogus"),
                _snapshot(name="z", origin="email"), _snapshot(name="pending-one")):
        db.add(bad)
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
    env = await _env(db)
    db.add(Deployment(environment_id=env.id, mode="bogus", git_ref="main", sha=SHA,
                      status="running", start_step=1))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


def _alembic(*args: str) -> None:
    subprocess.run([str(API_DIR / ".venv/bin/alembic"), *args], cwd=API_DIR,
                   env={**os.environ}, check=True, capture_output=True)


async def test_migration_0005_moves_start_services_to_step_10():
    """Deployments recorded before phase 3 keep a consistent plan: "up" was
    step 8 and is step 10 now, and so are failed_step and start_step."""
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    _alembic("downgrade", "0004")
    try:
        with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
            env_id = conn.execute(
                "INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
                "VALUES ('old', 'dev', 'ssh', 'old.example.com', '10.0.0.2') RETURNING id"
            ).fetchone()[0]
            dep_id = conn.execute(
                "INSERT INTO deployments (environment_id, mode, git_ref, sha, status, "
                "start_step, failed_step) VALUES (%s, 'update', 'main', %s, 'failed', 8, 8) "
                "RETURNING id", (env_id, SHA)).fetchone()[0]
            for number, key in ((6, "dump"), (8, "up")):
                conn.execute("INSERT INTO deployment_steps (deployment_id, number, key, name) "
                             "VALUES (%s, %s, %s, %s)", (dep_id, number, key, key))
    finally:
        _alembic("upgrade", "head")
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        steps = conn.execute("SELECT key, number FROM deployment_steps WHERE deployment_id = %s "
                             "ORDER BY number", (dep_id,)).fetchall()
        dep = conn.execute("SELECT start_step, failed_step FROM deployments WHERE id = %s",
                           (dep_id,)).fetchone()
    assert steps == [("dump", 6), ("up", 10)]
    assert dep == (10, 10)
