"""Workers: profiles, blacklist↔login coupling, certifications, levels."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

PW = "CorrectHorse9!"


async def _headers(client, email="alice@test.example.com"):
    resp = await client.post("/auth/login", json={"email": email, "password": PW})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _mk_worker(db, *, first="Wan", last="Worker",
                     email="wan@test.example.com", account=True):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.flush()
    if account:
        db.add(UserAccount(
            person_id=person.id, email=email,
            password_hash=hash_password(
                PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=person.id, role="worker"))
    await db.commit()
    return person


async def test_list_workers_with_profile_defaults(client, seeded_user, db):
    await _mk_worker(db)
    headers = await _headers(client)
    body = (await client.get("/workers", headers=headers)).json()
    assert len(body) == 1
    w = body[0]
    assert w["display_name"] == "Wan Worker"
    assert w["status"] == "active"        # no profile row yet → defaults
    assert w["trade"] is None
    assert w["partner"] is None
    assert w["has_account"] is True


async def test_profile_upsert_with_level_and_partner(client, seeded_user, db):
    worker = await _mk_worker(db)
    headers = await _headers(client)
    partner = (await client.post("/partners", headers=headers, json={
        "name": "Northwind Staffing", "partner_types": ["staffing"]})).json()

    resp = await client.put(f"/workers/{worker.id}/profile", headers=headers, json={
        "trade": "Server tech", "level": "L4", "partner_id": partner["id"],
        "status": "standby"})
    assert resp.status_code == 204

    w = (await client.get("/workers", headers=headers)).json()[0]
    assert w["trade"] == "Server tech"
    assert w["level"] == "L4"
    assert w["status"] == "standby"
    assert w["partner"]["name"] == "Northwind Staffing"

    # bad level / partner rejected
    assert (await client.put(f"/workers/{worker.id}/profile", headers=headers,
                             json={"level": "L9"})).status_code == 422
    resp = await client.put(f"/workers/{worker.id}/profile", headers=headers,
                            json={"partner_id": str(worker.id)})
    assert resp.json()["detail"]["code"] == "partner_not_found"


async def test_blacklist_requires_note_and_kills_login(client, seeded_user, db):
    worker = await _mk_worker(db)
    headers = await _headers(client)
    worker_session = await _headers(client, email="wan@test.example.com")

    # no note → rejected
    resp = await client.put(f"/workers/{worker.id}/profile", headers=headers,
                            json={"status": "blacklist"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "blacklist_requires_note"

    # with note → blacklisted, account disabled, sessions dead
    resp = await client.put(f"/workers/{worker.id}/profile", headers=headers, json={
        "status": "blacklist", "status_note": "No-show on two moves"})
    assert resp.status_code == 204
    assert (await client.get("/auth/me", headers=worker_session)).status_code == 401
    login = await client.post("/auth/login", json={
        "email": "wan@test.example.com", "password": PW})
    assert login.status_code == 401
    assert login.json()["detail"]["code"] == "account_disabled"

    # leaving blacklist re-enables login
    resp = await client.put(f"/workers/{worker.id}/profile", headers=headers,
                            json={"status": "active"})
    assert resp.status_code == 204
    assert (await client.post("/auth/login", json={
        "email": "wan@test.example.com", "password": PW})).status_code == 200


async def test_blacklist_elevated_target_requires_rank(client, seeded_user, db):
    """Blacklisting someone who also holds an elevated role requires
    outranking them (rank rule), not just holding a particular role."""
    from sqlalchemy import text

    worker = await _mk_worker(db, first="Ed", last="Elevated",
                              email="ed@test.example.com")
    db.add(PersonRole(person_id=worker.id, role="admin"))
    await db.commit()

    # plain staff (rank 40) is outranked by the target's admin grant (rank 60)
    headers = await _headers(client)
    resp = await client.put(f"/workers/{worker.id}/profile", headers=headers, json={
        "status": "blacklist", "status_note": "Investigation pending"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "rank_too_low"

    # a super_admin (rank 80) outranks the target and may proceed
    await db.execute(text(
        "UPDATE person_roles SET role='super_admin' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    super_headers = await _headers(client)
    resp = await client.put(f"/workers/{worker.id}/profile", headers=super_headers, json={
        "status": "blacklist", "status_note": "Investigation pending"})
    assert resp.status_code == 204


async def test_certifications_crud(client, seeded_user, db):
    worker = await _mk_worker(db)
    headers = await _headers(client)

    resp = await client.post(f"/workers/{worker.id}/certifications", headers=headers,
                             json={"name": "OSHA 30", "issuer": "OSHA",
                                   "issued_on": "2024-05-01", "expires_on": "2026-05-01"})
    assert resp.status_code == 201
    cert = resp.json()
    await client.post(f"/workers/{worker.id}/certifications", headers=headers,
                      json={"name": "Background check", "expires_on": "2030-01-01"})

    listing = (await client.get(f"/workers/{worker.id}/certifications",
                                headers=headers)).json()
    assert [c["name"] for c in listing] == ["OSHA 30", "Background check"]

    # expired count surfaces in the workers list (2026-05-01 < today)
    w = (await client.get("/workers", headers=headers)).json()[0]
    assert w["cert_count"] == 2
    assert w["certs_expired"] == 1

    assert (await client.delete(
        f"/workers/{worker.id}/certifications/{cert['id']}",
        headers=headers)).status_code == 204
    listing = (await client.get(f"/workers/{worker.id}/certifications",
                                headers=headers)).json()
    assert len(listing) == 1


async def test_levels_seeded_and_admin_editable(client, seeded_user, db):
    # staff can read
    headers = await _headers(client)
    levels = (await client.get("/worker-levels", headers=headers)).json()
    assert [l["level"] for l in levels] == ["L1", "L2", "L3", "L4", "L5", "L6"]
    assert levels[0]["title"] == "Apprentice"

    # staff cannot edit
    resp = await client.patch("/worker-levels/L1", headers=headers,
                              json={"title": "Trainee"})
    assert resp.status_code == 403

    # admin can
    admin = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(admin)
    await db.flush()
    db.add(UserAccount(
        person_id=admin.id, email="ada@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=admin.id, role="admin"))
    await db.commit()
    admin_headers = await _headers(client, email="ada@test.example.com")
    resp = await client.patch("/worker-levels/L1", headers=admin_headers, json={
        "title": "Trainee", "expected_skills": ["Shadowing", "Safety basics"]})
    assert resp.status_code == 200
    assert resp.json()["title"] == "Trainee"
    assert resp.json()["expected_skills"] == ["Shadowing", "Safety basics"]


async def test_non_worker_rejected(client, seeded_user):
    headers = await _headers(client)
    me = (await client.get("/auth/me/profile", headers=headers)).json()
    resp = await client.put(f"/workers/{me['id']}/profile", headers=headers,
                            json={"trade": "X"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_a_worker"


async def test_vendor_contact_sees_only_supplied_workers(client, db, seeded_user):
    from serversherpa.config import get_settings
    from serversherpa.db.models import (Partner, Person, PersonRole,
                                        UserAccount, WorkerProfile)
    from serversherpa.security.passwords import hash_password
    from datetime import UTC, datetime

    pa, pb = Partner(name="VendA"), Partner(name="VendB")
    db.add_all([pa, pb])
    await db.flush()
    w1 = Person(first_name="Wa", last_name="One")
    w2 = Person(first_name="Wb", last_name="Two")
    contact = Person(first_name="V", last_name="Contact",
                     email="v@venda.example.com")
    db.add_all([w1, w2, contact])
    await db.flush()
    db.add_all([WorkerProfile(person_id=w1.id, partner_id=pa.id),
                WorkerProfile(person_id=w2.id, partner_id=pb.id)])
    db.add_all([PersonRole(person_id=w1.id, role="worker"),
                PersonRole(person_id=w2.id, role="worker")])
    db.add(UserAccount(person_id=contact.id, email="v@venda.example.com",
                       password_hash=hash_password(
                           "CorrectHorse9!",
                           pepper=get_settings().password_pepper.get_secret_value()),
                       password_updated_at=datetime.now(UTC)))
    db.add(PersonRole(person_id=contact.id, role="vendor_admin", partner_id=pa.id))
    await db.commit()

    resp = await client.post("/auth/login", json={
        "email": "v@venda.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    listing = (await client.get("/workers", headers=hdrs)).json()
    ids = {w["person_id"] for w in listing}
    assert ids == {str(w1.id)}
    resp = await client.put(f"/workers/{w1.id}/profile", headers=hdrs,
                            json={"trade": "racking", "level": "L2",
                                  "status": "active", "partner_id": str(pa.id)})
    assert resp.status_code == 403      # vendor has workers:view only
