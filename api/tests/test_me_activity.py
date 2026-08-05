"""/auth/me: password_updated_at on the profile + the /activity history —
own actions, actions done TO the account by others, and failed logins
against the account's email. Other people's unrelated activity must not leak."""
from serversherpa.db.models import AuditLog, Person
from tests.test_sites_api import login


async def test_profile_includes_password_reset_date(client, seeded_user):
    hdrs = await login(client)
    body = (await client.get("/auth/me/profile", headers=hdrs)).json()
    assert body["password_updated_at"] is not None


async def test_activity_lists_own_and_about_me_only(client, db, seeded_user):
    other = Person(first_name="Olga", last_name="Other",
                   email="olga@test.example.com")
    admin = Person(first_name="Ada", last_name="Admin",
                   email="ada@test.example.com")
    db.add_all([other, admin])
    await db.flush()

    db.add(AuditLog(actor_person_id=seeded_user.id, entity_type="site",
                    entity_id="some-site", action="update",
                    changes={"city": {"from": "Reno", "to": "Vegas"}}))
    db.add(AuditLog(actor_person_id=None, entity_type="auth",
                    entity_id="alice@test.example.com",
                    action="login_failed", changes={}))
    db.add(AuditLog(actor_person_id=admin.id, entity_type="person",
                    entity_id=str(seeded_user.id), action="update", changes={}))
    # unrelated: another actor touching another entity — must NOT appear
    db.add(AuditLog(actor_person_id=other.id, entity_type="person",
                    entity_id=str(other.id), action="update", changes={}))
    await db.commit()

    hdrs = await login(client)   # the login itself audits a by-me auth row
    rows = (await client.get("/auth/me/activity", headers=hdrs)).json()

    keys = {(r["entity_type"], r["action"], r["by_me"]) for r in rows}
    assert ("site", "update", True) in keys
    assert ("auth", "login_failed", False) in keys
    assert ("person", "update", False) in keys
    assert ("auth", "login", True) in keys

    admin_row = next(r for r in rows
                     if r["entity_type"] == "person" and r["by_me"] is False)
    assert admin_row["actor_name"] == "Ada Admin"

    site_row = next(r for r in rows if r["entity_type"] == "site")
    assert site_row["changes"] == {"city": {"from": "Reno", "to": "Vegas"}}
    assert site_row["id"]

    assert not any(r["entity_id"] == str(other.id) for r in rows)

    ats = [r["at"] for r in rows]
    assert ats == sorted(ats, reverse=True)     # newest first
