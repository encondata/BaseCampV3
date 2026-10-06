"""At most one live production, under races: the production check runs
under a transaction-level advisory lock (create and un-retire), and a lost
race that reaches the environments_one_production index answers 409
production_exists, not 500. Plus the non-DigitalOcean create's error order."""

import pytest
from sqlalchemy import text

from sirdar_api.config import get_settings
from sirdar_api.db.engine import get_sessionmaker
from sirdar_api.deploy import do_envs, environments
from sirdar_api.deploy.environments import EnvError

from .api_helpers import auth_headers
from .deploy_factories import secrets_key  # noqa: F401
from .do_helpers import make_do_environment

pytestmark = pytest.mark.usefixtures("secrets_key")
URL = "/api/deploy/environments"


def _skip_check(monkeypatch):
    """Lose the race on purpose: the check sees no production, so the
    database's partial unique index is what refuses."""
    async def never(db, **kw):
        return False
    monkeypatch.setattr(do_envs, "production_exists", never)


async def test_create_race_answers_production_exists(client, db, monkeypatch):
    await make_do_environment(db, name="prod", type_="production", account="production")
    h = await auth_headers(client, db)
    _skip_check(monkeypatch)
    resp = await client.post(URL, headers=h, json={
        "mode": "new", "name": "prod2", "type": "production", "target": "digitalocean",
        "do": {"account": "production"}})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "production_exists"}})


async def test_unretire_race_answers_production_exists(client, db, monkeypatch):
    env = await make_do_environment(db, name="prod", type_="production", account="production")
    env.retiring = True
    await db.commit()
    await make_do_environment(db, name="prod2", type_="production", account="production")
    h = await auth_headers(client, db)
    _skip_check(monkeypatch)
    resp = await client.patch(f"{URL}/prod", headers=h,
                              json={"retiring": False, "confirm_name": "prod"})
    assert (resp.status_code, resp.json()) == (409, {"detail": {"code": "production_exists"}})


async def _lock_is_free() -> bool:
    async with get_sessionmaker()() as other:
        free = await other.scalar(text("SELECT pg_try_advisory_xact_lock(:k)"),
                                  {"k": environments.PRODUCTION_LOCK})
        await other.rollback()
        return free


async def test_production_create_holds_the_lock(db):
    env = await make_do_environment(db, name="prod", type_="production", account="production")
    assert await _lock_is_free()                      # released at commit
    env.retiring = True
    await db.commit()
    # A production create that is still in its transaction holds it.
    await environments.create_new(db, get_settings(), name="prod2", type_="production",
                                  target_id="digitalocean", do={"account": "production"})
    assert not await _lock_is_free()
    await db.rollback()
    assert await _lock_is_free()


async def test_unretire_holds_the_lock(db):
    env = await make_do_environment(db, name="prod", type_="production", account="production")
    env.retiring = True
    await db.commit()
    await environments.update(db, get_settings(), env, {"retiring": False})
    assert not await _lock_is_free()
    await db.rollback()


async def test_non_do_create_checks_the_proxy_before_the_ports(db):
    settings = get_settings()
    base = dict(name="qa", type_="custom", target_id="proxmox")
    for kw, code in (({"ports": {"db": 1}}, "proxy_ip_required"),
                     ({"proxy_ip": "nope", "ports": {"db": 1}}, "proxy_ip_invalid"),
                     ({"proxy_ip": "10.0.0.5", "bind_ip": "x", "ports": {"api": 0}},
                      "bind_ip_invalid")):
        with pytest.raises(EnvError) as e:
            await environments.create_new(db, settings, **base, **kw)
        assert e.value.code == code
