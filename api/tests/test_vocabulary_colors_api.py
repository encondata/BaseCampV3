"""Colour is now free-picked hex, so the format is validated — the one thing
the status-values spec deliberately did not do, back when it was a token from
a fixed <select>."""

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
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


async def test_site_type_color_is_editable(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.patch("/site-types/datacenter", headers=hdrs,
                              json={"color": "#ff5733"})
    assert resp.status_code == 200
    assert resp.json()["color"] == "#ff5733"
    types = (await client.get("/site-types", headers=hdrs)).json()
    assert next(t for t in types if t["key"] == "datacenter")["color"] == "#ff5733"


async def test_worker_level_color_is_editable(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.patch("/worker-levels/L3", headers=hdrs,
                              json={"color": "#ff5733"})
    assert resp.status_code == 200
    assert resp.json()["color"] == "#ff5733"


async def test_uppercase_hex_is_normalised(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.patch("/site-types/office", headers=hdrs,
                              json={"color": "#AABBCC"})
    assert resp.status_code == 200
    assert resp.json()["color"] == "#aabbcc"


async def test_a_token_is_no_longer_a_valid_colour(client, db, seeded_user):
    """The old format must be rejected, or a stale client silently writes junk
    into a CSS custom property."""
    hdrs = await _dev(db, client)
    for body in ({"color": "c-green"}, {"color": "#ggg"}, {"color": "red"},
                 {"color": "#12345"}):
        resp = await client.patch("/site-types/office", headers=hdrs, json=body)
        assert resp.status_code == 422, body


async def test_status_value_colour_validates_too(client, db, seeded_user):
    hdrs = await _dev(db, client)
    assert (await client.patch("/status-values/site/active", headers=hdrs,
                               json={"color": "c-green"})).status_code == 422
    assert (await client.patch("/status-values/site/active", headers=hdrs,
                               json={"color": "#123abc"})).status_code == 200


async def test_developer_creates_a_site_type(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/site-types", headers=hdrs, json={
        "key": "hospital", "label": "Hospital", "description": "Clinical site.",
        "sort_order": 7, "icon": "cross", "color": "#c03540",
    })
    assert resp.status_code == 201
    assert resp.json()["key"] == "hospital"

    types = (await client.get("/site-types", headers=hdrs)).json()
    assert any(t["key"] == "hospital" for t in types)


async def test_created_site_type_is_usable_on_a_site(client, db, seeded_user):
    """A type that can't be assigned is a type that doesn't exist."""
    hdrs = await _dev(db, client)
    await client.post("/site-types", headers=hdrs, json={
        "key": "hospital", "label": "Hospital", "color": "#c03540"})
    staff = await login(client)
    resp = await client.post("/sites", headers=staff, json={
        "name": "Mercy General", "site_type": "hospital"})
    assert resp.status_code == 201


async def test_duplicate_site_type_key_is_409(client, db, seeded_user):
    hdrs = await _dev(db, client)
    resp = await client.post("/site-types", headers=hdrs, json={
        "key": "datacenter", "label": "Dupe", "color": "#178a4c"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "site_type_exists"


async def test_admin_cannot_create_a_site_type(client, db, seeded_user):
    """Vocabulary is developer-only — the rule the whole design turns on."""
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
    resp = await client.post("/site-types", headers=hdrs, json={
        "key": "sneaky", "label": "Sneaky", "color": "#178a4c"})
    assert resp.status_code == 403
