"""Client-anchored initiative visibility: scoped list, 404 probes,
global actors unchanged."""

import uuid

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Client, Initiative, Person, PersonRole, UserAccount,
)
from serversherpa.security.passwords import hash_password

from tests.test_sites_api import login
from tests.test_status_values_write import _make

PW = "CorrectHorse9!"


async def client_login(db, client_api, client_id, role="client_viewer",
                       email="cl@test.example.com"):
    """A ready-to-use client-anchored login for the given client."""
    p = Person(first_name="Cli", last_name="Ent", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role, client_id=client_id))
    await db.commit()
    return await login(client_api, email=email)


async def _two_clients_with_initiatives(db):
    a, b = Client(name="Acme"), Client(name="Bravo")
    db.add(a)
    db.add(b)
    await db.flush()
    ia = Initiative(name="Acme move", initiative_type="move",
                    sub_type="migration", client_id=a.id)
    ib = Initiative(name="Bravo move", initiative_type="move",
                    sub_type="migration", client_id=b.id)
    inone = Initiative(name="Unattributed", initiative_type="move",
                       sub_type="migration")
    db.add(ia)
    db.add(ib)
    db.add(inone)
    await db.commit()
    return a, b, ia, ib, inone


async def test_client_actor_sees_only_their_initiatives(client, db,
                                                        seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.get("/initiatives", headers=hdrs)
    assert resp.status_code == 200, resp.text
    names = [i["name"] for i in resp.json()]
    assert names == ["Acme move"]
    # own initiative readable; foreign + unattributed are 404 (not 403)
    assert (await client.get(f"/initiatives/{ia.id}",
                             headers=hdrs)).status_code == 200
    assert (await client.get(f"/initiatives/{ib.id}",
                             headers=hdrs)).status_code == 404
    # roster read of a foreign initiative is 404 too
    assert (await client.get(f"/initiatives/{ib.id}/assets",
                             headers=hdrs)).status_code == 404
    assert (await client.get(f"/initiatives/{ia.id}/assets",
                             headers=hdrs)).status_code == 200


async def test_client_actor_cannot_write_initiatives(client, db,
                                                     seeded_user):
    a, *_ = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.post("/initiatives", headers=hdrs, json={
        "name": "nope", "initiative_type": "move", "sub_type": "migration"})
    assert resp.status_code == 403


async def test_global_actor_unchanged(client, db, seeded_user):
    _a, _b, ia, ib, inone = await _two_clients_with_initiatives(db)
    hdrs = await _make(db, client, "admin", "adm@test.example.com")
    resp = await client.get("/initiatives", headers=hdrs)
    names = {i["name"] for i in resp.json()}
    assert {"Acme move", "Bravo move", "Unattributed"} <= names
    assert (await client.get(f"/initiatives/{inone.id}",
                             headers=hdrs)).status_code == 200


async def test_time_summary_scope_probe(client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    ok = await client.get(f"/time/summary?initiative_id={ia.id}",
                          headers=hdrs)
    assert ok.status_code == 200
    foreign = await client.get(f"/time/summary?initiative_id={ib.id}",
                               headers=hdrs)
    assert foreign.status_code == 404
    ghost = await client.get(f"/time/summary?initiative_id={uuid.uuid4()}",
                             headers=hdrs)
    assert ghost.status_code == 404
