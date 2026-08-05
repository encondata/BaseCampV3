import pytest


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_login_payload_has_perms(client, seeded_user):
    data = await login(client)
    assert data["perms"]["workers"]["change"] is True     # staff default
    assert data["perms"]["settings"]["change"] is False
    assert data["max_rank"] == 40
    assert data["scope"]["global"] is True


async def test_me_payload_has_perms(client, seeded_user):
    data = await login(client)
    hdrs = {"Authorization": f"Bearer {data['access_token']}"}
    me = (await client.get("/auth/me", headers=hdrs)).json()
    assert me["perms"]["workers"]["view"] is True
    assert me["max_rank"] == 40


async def test_require_permission_blocks(client, db, seeded_user):
    """Staff lacks settings:change; a settings-guarded endpoint arrives in a
    later task, so exercise the guard directly via a throwaway route."""
    from serversherpa.api.deps import require_permission
    from serversherpa.api.app import create_app

    app = create_app()

    @app.get("/_test/needs-settings-change")
    async def probe(actor=require_permission("settings", "change")):
        return {"ok": True}

    from httpx import ASGITransport, AsyncClient
    data = await login(client)
    hdrs = {"Authorization": f"Bearer {data['access_token']}"}
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://testserver") as c:
        resp = await c.get("/_test/needs-settings-change", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"
