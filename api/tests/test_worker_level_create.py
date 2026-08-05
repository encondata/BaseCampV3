"""A new level is created by position, not by rank number. The shift is the
part that can silently corrupt the scale, so it is what these tests pin."""

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount, WorkerLevel
from serversherpa.security.passwords import hash_password
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _dev(db, client, email="dev@test.example.com"):
    p = Person(first_name="D", last_name="Ev", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="developer"))
    await db.commit()
    return await login(client, email=email)


async def _scale(db) -> list[tuple[str, int]]:
    return [(r.level, r.rank) for r in await db.scalars(
        select(WorkerLevel).order_by(WorkerLevel.rank))]


async def test_insert_after_a_middle_level_shifts_the_rest(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L2B", "after": "L2", "title": "Tech I+",
        "description": "Between.", "expected_skills": [], "color": "#4dd0ff"})
    assert resp.status_code == 201
    assert resp.json()["rank"] == 3

    # the WHOLE scale, not just the new row — a broken shift leaves a gap or a
    # duplicate that asserting one rank would miss entirely
    assert await _scale(db) == [
        ("L1", 1), ("L2", 2), ("L2B", 3), ("L3", 4),
        ("L4", 5), ("L5", 6), ("L6", 7)]


async def test_insert_first_shifts_everything(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L0", "after": None, "title": "Trainee",
        "description": "", "expected_skills": [], "color": "#8a93a6"})
    assert resp.status_code == 201
    assert resp.json()["rank"] == 1
    assert await _scale(db) == [
        ("L0", 1), ("L1", 2), ("L2", 3), ("L3", 4),
        ("L4", 5), ("L5", 6), ("L6", 7)]


async def test_insert_after_the_last_level_appends(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L7", "after": "L6", "title": "Principal",
        "description": "", "expected_skills": [], "color": "#ffb84d"})
    assert resp.status_code == 201
    assert resp.json()["rank"] == 7
    assert await _scale(db) == [
        ("L1", 1), ("L2", 2), ("L3", 3), ("L4", 4),
        ("L5", 5), ("L6", 6), ("L7", 7)]


async def test_unknown_after_is_422(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "LX", "after": "nope", "title": "X",
        "description": "", "expected_skills": [], "color": "#178a4c"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_level"


async def test_duplicate_level_key_is_409(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "L3", "after": "L1", "title": "Dupe",
        "description": "", "expected_skills": [], "color": "#178a4c"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "worker_level_exists"


async def test_created_level_is_assignable_to_a_worker(client, db, seeded_user):
    """A level that can't be assigned is a level that doesn't exist."""
    hdrs = await _dev(db, client)
    await client.post("/worker-levels", headers=hdrs, json={
        "level": "L7", "after": "L6", "title": "Principal",
        "description": "", "expected_skills": [], "color": "#ffb84d"})
    staff = await login(client)
    person = Person(first_name="W", last_name="Kr")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="worker"))
    await db.commit()
    resp = await client.put(f"/workers/{person.id}/profile", headers=staff,
                            json={"level": "L7", "status": "active"})
    assert resp.status_code in (200, 204)


async def test_admin_cannot_create_a_level(client, db, seeded_user):
    p = Person(first_name="A", last_name="Admin", email="ada@test.example.com")
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email="ada@test.example.com",
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="admin"))
    await db.commit()
    hdrs = await login(client, email="ada@test.example.com")
    resp = await client.post("/worker-levels", headers=hdrs, json={
        "level": "LX", "after": "L6", "title": "X",
        "description": "", "expected_skills": [], "color": "#178a4c"})
    assert resp.status_code == 403
