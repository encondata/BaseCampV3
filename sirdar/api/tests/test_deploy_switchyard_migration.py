"""Migration 0018: environments.proxy (LAN backfilled to npm, DigitalOcean
none), the switchyard integration kind and the switchyard_host record kind."""

import psycopg
import pytest

from .conftest import TEST_DB, _psycopg_url
from .test_deploy_models import _alembic


def _sql(query: str, *args):
    with psycopg.connect(_psycopg_url(TEST_DB), autocommit=True) as conn:
        cur = conn.execute(query, args)
        return cur.fetchall() if cur.description else None


def _env(name: str, target: str) -> str:
    return _sql("INSERT INTO environments (name, type, target_id, base_domain, proxy_ip) "
                "VALUES (%s, 'dev', %s, %s, '10.0.0.2') RETURNING id::text",
                name, target, f"{name}.serversherpa.com")[0][0]


async def test_0018_backfills_lan_as_npm_and_round_trips():
    from sirdar_api.db.engine import dispose_engine
    await dispose_engine()
    try:
        _alembic("downgrade", "0017")
        _env("lan1", "ssh")
        _env("vm1", "esxi")
        _sql("INSERT INTO environments (name, type, target_id, base_domain, proxy_ip, slots) "
             "VALUES ('do1', 'dev', 'digitalocean', 'do1.serversherpa.com', '172.30.0.2', "
             "'{orange}')")
        _alembic("upgrade", "head")
        assert dict(_sql("SELECT name, proxy FROM environments ORDER BY name")) == {
            "do1": None, "lan1": "npm", "vm1": "npm"}
        with pytest.raises(psycopg.errors.CheckViolation):
            _sql("UPDATE environments SET proxy = 'switchyard' WHERE name = 'do1'")
        with pytest.raises(psycopg.errors.CheckViolation):
            _sql("UPDATE environments SET proxy = 'caddy' WHERE name = 'lan1'")
        _sql("INSERT INTO integrations (kind) VALUES ('switchyard')")
        lan = _sql("SELECT id FROM environments WHERE name = 'lan1'")[0][0]
        _sql("INSERT INTO managed_records (environment_id, service, kind, external_id, name, "
             "origin) VALUES (%s, 'api', 'switchyard_host', '1', 'api.lan1', 'created')", lan)
        # Refused while Sirdar manages Switchyard hosts.
        with pytest.raises(Exception) as e:
            _alembic("downgrade", "0017")
        assert b"Can't downgrade below 0018" in e.value.stderr
        _sql("DELETE FROM managed_records")
        _alembic("downgrade", "0017")
        assert _sql("SELECT count(*) FROM integrations WHERE kind = 'switchyard'") == [(0,)]
        assert _sql("SELECT count(*) FROM information_schema.columns WHERE "
                    "table_name = 'environments' AND column_name = 'proxy'") == [(0,)]
    finally:
        _alembic("upgrade", "head")
        _sql("DELETE FROM managed_records")
        _sql("DELETE FROM integrations")
        _sql("DELETE FROM environments")
