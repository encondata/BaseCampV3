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


async def test_activity_omits_note_and_file_changes_made_by_others(
        client, db, seeded_user):
    """Audit rows about a person's own record include note.* / attachment.*
    rows staff write (filenames, levels). The person must not see those for
    Internal/Admin items, so the feed drops them unless the person acted."""
    from serversherpa.config import get_settings
    from serversherpa.db.models import PersonRole, UserAccount, WorkerProfile
    from serversherpa.security.passwords import hash_password
    from tests.test_attachments import LOGIN

    wes = Person(first_name="Wes", last_name="Worker",
                 email="wes-act@test.example.com")
    db.add(wes)
    await db.flush()
    db.add(UserAccount(
        person_id=wes.id, email="wes-act@test.example.com",
        password_hash=hash_password(
            LOGIN["password"],
            pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=wes.id, role="worker"))
    db.add(WorkerProfile(person_id=wes.id))
    # a note row staff wrote about Wes, and one Wes wrote himself
    db.add(AuditLog(actor_person_id=seeded_user.id, entity_type="person",
                    entity_id=str(wes.id), action="note.add",
                    changes={"note_id": "n1", "visibility": "internal"}))
    db.add(AuditLog(actor_person_id=wes.id, entity_type="person",
                    entity_id=str(wes.id), action="note.add",
                    changes={"note_id": "n2", "visibility": "everyone"}))
    await db.commit()

    staff = await login(client)
    resp = await client.post(
        "/attachments", headers=staff,
        data={"entity_type": "person", "entity_id": str(wes.id),
              "kind": "document", "visibility": "internal"},
        files={"file": ("secret-review.pdf", b"%PDF-1.4 fake",
                        "application/pdf")})
    assert resp.status_code == 201, resp.text

    wes_hdrs = await login(client, email="wes-act@test.example.com")
    rows = (await client.get("/auth/me/activity", headers=wes_hdrs)).json()

    assert "secret-review.pdf" not in str(rows)
    assert not any(r["action"].startswith("attachment.") for r in rows)
    # staff's note row is hidden; Wes's own note row stays
    notes = [r for r in rows if r["action"] == "note.add"]
    assert [r["by_me"] for r in notes] == [True]
    # ordinary rows about him (his login) are still there
    assert any(r["action"] == "login" for r in rows)
