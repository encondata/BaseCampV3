from .factories import PASSWORD, make_user


async def auth_headers(client, db, *, email: str = "boss@test.example.com",
                       roles: tuple[str, ...] = ("developer",),
                       source: str = "portal") -> dict:
    await make_user(db, email=email, roles=roles, source=source, first_name="Boss", last_name="User")
    resp = await client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}
