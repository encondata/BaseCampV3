import pytest
from sqlalchemy import text

from serversherpa.db.models import PermissionOverride, Person, PersonRole


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    d = resp.json()
    return {"Authorization": f"Bearer {d['access_token']}"}, d


async def test_summary_readable_by_staff(client, seeded_user):
    hdrs, _ = await login(client)
    resp = await client.get("/access/summary", headers=hdrs)
    assert resp.status_code == 200
    body = resp.json()
    role_names = {r["name"] for r in body["roles"]}
    assert {"developer", "founder", "admin", "staff"} <= role_names
    staff = next(r for r in body["roles"] if r["name"] == "staff")
    assert staff["matrix"]["workers"]["delete"] is True
    assert staff["member_count"] == 1


async def test_effective_self_allowed_others_blocked_for_staff(client, db, seeded_user):
    hdrs, data = await login(client)
    me_id = data["person"]["id"]
    resp = await client.get(f"/access/effective/{me_id}", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["cells"]["workers"]["view"]["value"] is True

    other = Person(first_name="O", last_name="Ther")
    db.add(other)
    await db.flush()
    db.add(PersonRole(person_id=other.id, role="staff"))
    await db.commit()
    resp = await client.get(f"/access/effective/{other.id}", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "not_your_record"


async def test_effective_marks_override_source(client, db, seeded_user):
    hdrs, data = await login(client)
    me_id = data["person"]["id"]
    db.add(PermissionOverride(person_id=seeded_user.id, resource="workers",
                              action="delete", allow=False))
    await db.commit()
    body = (await client.get(f"/access/effective/{me_id}", headers=hdrs)).json()
    cell = body["cells"]["workers"]["delete"]
    assert cell == {"value": False, "source": "override"}
    assert body["cells"]["workers"]["view"]["source"] == "role"


async def test_effective_floor_beats_discarded_override(client, db, seeded_user):
    """always_viewable floors view=True AFTER overrides (resolver), so a deny
    override on such a cell is discarded — the source must say floor, not
    override, because the floor is what decided the final value."""
    hdrs, data = await login(client)
    me_id = data["person"]["id"]
    db.add(PermissionOverride(person_id=seeded_user.id, resource="access",
                              action="view", allow=False))
    await db.commit()
    body = (await client.get(f"/access/effective/{me_id}", headers=hdrs)).json()
    assert body["cells"]["access"]["view"] == {"value": True, "source": "floor"}
