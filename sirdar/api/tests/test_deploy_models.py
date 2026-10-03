import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from sirdar_api.db.models import (
    Deployment,
    DeploymentStep,
    Environment,
    EnvironmentSecret,
    EnvironmentService,
)

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
