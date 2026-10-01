from .api_helpers import auth_headers
from .factories import PASSWORD, make_user
from .source_helpers import add_portal_person, add_role


async def test_list_and_detail(client, db):
    h = await auth_headers(client, db)
    other = await make_user(db, email="admin@test.example.com", roles=("admin",))
    rows = (await client.get("/api/users", headers=h)).json()
    assert {r["email"] for r in rows} == {"boss@test.example.com", "admin@test.example.com"}
    detail = (await client.get(f"/api/users/{other.person_id}", headers=h)).json()
    assert detail["user"]["roles"] == ["admin"]
    assert detail["cells"]["users"]["view"] == {"value": True, "source": "role"}
    assert detail["cells"]["devtools"]["view"]["source"] == "hard_gate"
    assert detail["can_manage"] is True


async def test_admin_cannot_import(client, db):
    h = await auth_headers(client, db, roles=("admin",))
    resp = await client.post("/api/users/import", headers=h)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"


async def test_import_endpoint_and_runs(client, db, source):
    # a local actor: an import disables portal users absent from the source
    h = await auth_headers(client, db, source="local")
    add_role(source, "admin", 60)
    add_portal_person(source, email="pat@test.example.com")
    assert (await client.get("/api/users/import/source", headers=h)).json() == {
        "configured": True}
    run = (await client.post("/api/users/import", headers=h)).json()
    assert run["status"] == "ok" and run["added"] == 1
    assert run["rows"][0]["email"] == "pat@test.example.com"
    assert run["actor_name"] == "Boss User"
    runs = (await client.get("/api/users/import/runs", headers=h)).json()
    assert runs[0]["id"] == run["id"] and runs[0]["rows"] == []
    one = (await client.get(f"/api/users/import/runs/{run['id']}", headers=h)).json()
    assert len(one["rows"]) == 1


async def test_revoke_sessions_respects_rank(client, db):
    h_admin = await auth_headers(client, db, email="a@test.example.com", roles=("super_admin",))
    dev = await make_user(db, email="dev@test.example.com", roles=("developer",))
    await client.post("/api/auth/login", json={"email": dev.email, "password": PASSWORD})
    # super_admin (80) may change users but not a developer (100)
    resp = await client.post(f"/api/users/{dev.person_id}/sessions/revoke", headers=h_admin)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"
    h_dev = await auth_headers(client, db, email="root@test.example.com", roles=("developer",))
    ok = await client.post(f"/api/users/{dev.person_id}/sessions/revoke", headers=h_dev)
    assert ok.status_code == 200 and ok.json()["revoked"] == 1


async def test_unknown_person(client, db):
    h = await auth_headers(client, db)
    resp = await client.get("/api/users/00000000-0000-0000-0000-000000000000", headers=h)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "person_not_found"
