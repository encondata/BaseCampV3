"""Cross-cutting guards over EVERY /wiki route, enumerated from the app
itself — so a route added later (Phase 2 comments, templates, watches;
Phase 3 share links) is held to the same rules without anyone
remembering to write its test:

- every user-facing route answers 403 to a signed-in user without
  `wiki:view`;
- every mutating user-facing route answers 423 in read-only maintenance
  mode — except the reads made through POST listed in READ_ONLY_READS;
- every `/wiki/internal` route answers 401 without the service token.
"""
import os
import re
import uuid

import pytest

from sqlalchemy import delete

from serversherpa.api.app import create_app
from serversherpa.config import get_settings
from serversherpa.db.models import RolePermission
from tests.wiki_helpers import login_as

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
# reads made through POST that stay open during a maintenance freeze
READ_ONLY_READS = {("POST", "/wiki/assets/urls")}


def _wiki_routes() -> list[tuple[str, str]]:
    """(method, path) for every /wiki route the app serves — read from
    its OpenAPI schema, which lists every included route (FastAPI no
    longer flattens included routers into `app.routes`); no wiki route
    opts out of the schema."""
    paths = create_app().openapi()["paths"]
    return sorted((method.upper(), path) for path, ops in paths.items()
                  if path.startswith("/wiki/") for method in ops)


ROUTES = _wiki_routes()
USER_ROUTES = [r for r in ROUTES if not r[1].startswith("/wiki/internal/")]
INTERNAL_ROUTES = [r for r in ROUTES if r[1].startswith("/wiki/internal/")]


def _url(path: str) -> str:
    """The path with every `{param}` filled in: a random uuid (or a key
    for `{key}`) — the guards answer before the target is looked up."""
    return re.sub(r"\{(\w+)\}",
                  lambda m: "no-such-space" if m.group(1) == "key" else str(uuid.uuid4()),
                  path)


def test_the_sweep_sees_the_wiki_api():
    # a guard over nothing guards nothing
    assert len(USER_ROUTES) >= 30
    assert INTERNAL_ROUTES


@pytest.fixture
async def no_wiki_user(client, db):
    """Signed in, with a role that carries no wiki access at all."""
    headers, _ = await login_as(client, db, roles=("external",))
    await db.execute(delete(RolePermission).where(RolePermission.role == "external",
                                                  RolePermission.resource == "wiki"))
    await db.commit()
    return headers


async def test_every_wiki_route_needs_wiki_view(client, no_wiki_user):
    wrong = []
    for method, path in USER_ROUTES:
        resp = await client.request(method, _url(path), headers=no_wiki_user,
                                    json={} if method in MUTATING else None)
        if resp.status_code != 403:
            wrong.append((method, path, resp.status_code))
    assert wrong == []


async def test_every_wiki_write_is_frozen_in_read_only_mode(client, db, monkeypatch):
    headers, _ = await login_as(client, db, roles=("staff",))

    async def _read_only(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}
    monkeypatch.setattr("serversherpa.system.admin_config.read_admin_config", _read_only)

    wrong = []
    for method, path in USER_ROUTES:
        if method not in MUTATING:
            continue
        resp = await client.request(method, _url(path), headers=headers, json={})
        frozen = resp.status_code == 423
        if frozen == ((method, path) in READ_ONLY_READS):
            wrong.append((method, path, resp.status_code))
    assert wrong == []


async def test_every_internal_route_needs_the_service_token(client):
    env = "SS_WIKI_SERVICE_TOKEN"
    before = os.environ.get(env)
    os.environ[env] = "route-guard-token"
    get_settings.cache_clear()
    try:
        wrong = []
        for method, path in INTERNAL_ROUTES:
            for headers in ({}, {"X-Wiki-Service-Token": "wrong"}):
                resp = await client.request(method, _url(path), headers=headers,
                                            json={} if method in MUTATING else None)
                if resp.status_code != 401:
                    wrong.append((method, path, headers, resp.status_code))
        assert wrong == []
    finally:
        if before is None:
            os.environ.pop(env, None)
        else:
            os.environ[env] = before
        get_settings.cache_clear()
