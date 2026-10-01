from .api_helpers import auth_headers


async def test_audit_lists_logins_with_actor_names(client, db):
    h = await auth_headers(client, db)
    rows = (await client.get("/api/audit", headers=h)).json()
    login = next(r for r in rows if r["action"] == "login")
    assert login["actor_name"] == "Boss User" and login["entity_type"] == "auth"
    facets = (await client.get("/api/audit/facets", headers=h)).json()
    assert "login" in facets["actions"] and "auth" in facets["entity_types"]
    only = (await client.get("/api/audit?action=login&limit=1", headers=h)).json()
    assert len(only) == 1


async def test_settings(client, db):
    h = await auth_headers(client, db, roles=("admin",))
    body = (await client.get("/api/settings", headers=h)).json()
    assert body["source_configured"] is True and body["max_failed_logins"] == 10
