"""Client-anchored initiative visibility: scoped list, 404 probes,
global actors unchanged."""

import uuid

from serversherpa.config import get_settings
from serversherpa.db.models import (
    Asset, Client, ImportJob, Initiative, InitiativeAsset, InitiativeLink,
    InitiativePerson, Partner, PermissionOverride, Person, PersonRole,
    UserAccount, WorkerProfile,
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


async def partner_login(db, client_api, partner_id, role="vendor_viewer",
                        email="pa@test.example.com"):
    """A ready-to-use partner-anchored login for the given partner."""
    p = Person(first_name="Ven", last_name="Dor", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role, partner_id=partner_id))
    await db.commit()
    return await login(client_api, email=email)


async def _two_partners_with_workers(db):
    a, b = Partner(name="Alpha Crew"), Partner(name="Beta Crew")
    db.add(a)
    db.add(b)
    await db.flush()
    wa = Person(first_name="Alph", last_name="Worker",
                email="wa@test.example.com")
    wb = Person(first_name="Beta", last_name="Worker",
                email="wb@test.example.com")
    db.add(wa)
    db.add(wb)
    await db.flush()
    db.add(PersonRole(person_id=wa.id, role="worker"))
    db.add(PersonRole(person_id=wb.id, role="worker"))
    db.add(WorkerProfile(person_id=wa.id, partner_id=a.id))
    db.add(WorkerProfile(person_id=wb.id, partner_id=b.id))
    await db.commit()
    return a, b, wa, wb


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
    """`time` is visible_to={"global"} in the resource registry (a hard
    gate an override can't bypass — see the `sites`/`time` comments in
    access/resources.py), so no client-anchored role can ever reach
    time_summary's initiative-scope check at all: it now 403s outright.
    (Previously this route gated on initiatives:view, which client_viewer
    does hold, so this test used to assert 200/404/404 through the scope
    check — that was the bug; see
    test_summary_requires_time_view_not_initiatives_view in
    test_time_api.py for the full before/after coverage, including a
    global actor still getting a 200.)"""
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.get(f"/time/summary?initiative_id={ia.id}",
                            headers=hdrs)
    assert resp.status_code == 403


async def test_search_is_client_scoped(client, db, seeded_user):
    a, _b, _ia, _ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.get("/search?q=move", headers=hdrs)
    assert resp.status_code == 200
    text = resp.text
    assert "Acme move" in text
    assert "Bravo move" not in text
    # searching the other client's NAME surfaces nothing of theirs
    resp = await client.get("/search?q=Bravo", headers=hdrs)
    assert "Bravo move" not in resp.text


async def test_link_rows_hide_foreign_initiatives(client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    # link Acme's initiative to Bravo's (staff action, direct insert)
    db.add(InitiativeLink(parent_id=ia.id, child_id=ib.id))
    await db.commit()
    hdrs = await client_login(db, client, a.id)
    detail = (await client.get(f"/initiatives/{ia.id}", headers=hdrs)).json()
    joined = str(detail)
    assert "Bravo move" not in joined


async def test_people_ratings_hidden_from_clients(client, db, seeded_user):
    a, _b, ia, _ib, _n = await _two_clients_with_initiatives(db)
    worker = Person(first_name="Wor", last_name="Ker",
                    email="worker@test.example.com")
    db.add(worker)
    await db.flush()
    db.add(InitiativePerson(initiative_id=ia.id, person_id=worker.id,
                            rating=4))
    await db.commit()
    hdrs = await client_login(db, client, a.id)
    rows = (await client.get(f"/initiatives/{ia.id}/people",
                             headers=hdrs)).json()
    assert all(r["rating"] is None for r in rows)
    adm = await _make(db, client, "admin", "adm2@test.example.com")
    rows = (await client.get(f"/initiatives/{ia.id}/people",
                             headers=adm)).json()
    assert any(r["rating"] == 4 for r in rows)


async def test_initiative_notes_internal_only(client, db, seeded_user):
    a, _b, ia, *_ = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    resp = await client.get(
        f"/notes?entity_type=initiative&entity_id={ia.id}", headers=hdrs)
    assert resp.status_code == 403


async def test_provenance_scoped(client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_login(db, client, a.id)
    ok = await client.get(
        f"/status/provenance?entity_type=initiative&entity_id={ia.id}"
        f"&status=planned",
        headers=hdrs)
    assert ok.status_code in (200, 404)  # 404 acceptable when no history
    foreign = await client.get(
        f"/status/provenance?entity_type=initiative&entity_id={ib.id}"
        f"&status=planned",
        headers=hdrs)
    assert foreign.status_code == 404


async def test_provenance_partner_scoped(client, db, seeded_user):
    a, b, _wa, _wb = await _two_partners_with_workers(db)
    hdrs = await partner_login(db, client, a.id)
    ok = await client.get(
        f"/status/provenance?entity_type=partner&entity_id={a.id}"
        f"&status=active",
        headers=hdrs)
    assert ok.status_code in (200, 404)  # 404 acceptable when no history
    foreign = await client.get(
        f"/status/provenance?entity_type=partner&entity_id={b.id}"
        f"&status=active",
        headers=hdrs)
    assert foreign.status_code == 404
    ghost = await client.get(
        f"/status/provenance?entity_type=partner&entity_id={uuid.uuid4()}"
        f"&status=active",
        headers=hdrs)
    assert ghost.status_code == 404


async def test_provenance_worker_scoped(client, db, seeded_user):
    a, _b, wa, wb = await _two_partners_with_workers(db)
    hdrs = await partner_login(db, client, a.id, role="vendor_admin")
    ok = await client.get(
        f"/status/provenance?entity_type=worker&entity_id={wa.id}"
        f"&status=active",
        headers=hdrs)
    assert ok.status_code in (200, 404)  # 404 acceptable when no history
    foreign = await client.get(
        f"/status/provenance?entity_type=worker&entity_id={wb.id}"
        f"&status=active",
        headers=hdrs)
    assert foreign.status_code == 404


async def test_provenance_global_actor_sees_partner_and_worker(
        client, db, seeded_user):
    _a, b, _wa, wb = await _two_partners_with_workers(db)
    adm = await _make(db, client, "admin", "adm3@test.example.com")
    for qs in (f"entity_type=partner&entity_id={b.id}",
               f"entity_type=worker&entity_id={wb.id}"):
        resp = await client.get(
            f"/status/provenance?{qs}&status=active", headers=adm)
        assert resp.status_code == 200, resp.text


# ── a client-anchored actor who was ALSO granted initiatives:change ──
# Access control lets an admin flip a single override cell; that must not
# turn a client contact into an initiative author, and must not open the
# child routes (people / links / move assets / import jobs) — those take a
# child id and used to load it without ever looking at the parent.


async def client_writer_login(db, client_api, client_id,
                              email="cw@test.example.com"):
    """Client-anchored login holding initiatives view/add/change/delete."""
    p = Person(first_name="Cli", last_name="Writer", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role="client_admin",
                      client_id=client_id))
    for action in ("view", "add", "change", "delete"):
        db.add(PermissionOverride(person_id=p.id, resource="initiatives",
                                  action=action, allow=True))
    await db.commit()
    return await login(client_api, email=email)


async def test_client_writer_cannot_create_or_change_initiatives(
        client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_writer_login(db, client, a.id)

    resp = await client.post("/initiatives", headers=hdrs, json={
        "name": "sneaky", "initiative_type": "move",
        "client_id": str(a.id)})
    assert resp.status_code == 403, resp.text
    # their OWN initiative is visible, so the refusal is the 403 global gate
    assert (await client.patch(f"/initiatives/{ia.id}", headers=hdrs,
                               json={"name": "renamed"})).status_code == 403
    assert (await client.post(f"/initiatives/{ia.id}/archive",
                              headers=hdrs)).status_code == 403
    assert (await client.post(f"/initiatives/{ia.id}/unarchive",
                              headers=hdrs)).status_code == 403
    # a foreign initiative stays invisible: 404, never 403
    assert (await client.patch(f"/initiatives/{ib.id}", headers=hdrs,
                               json={"name": "renamed"})).status_code == 404


async def test_client_writer_cannot_add_children(client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await client_writer_login(db, client, a.id)
    worker = Person(first_name="W", last_name="K",
                    email="wk-cw@test.example.com")
    asset = Asset(name="box", client_id=a.id)
    own_other = Initiative(name="Acme second", initiative_type="project",
                           client_id=a.id)
    db.add(worker)
    db.add(asset)
    db.add(own_other)
    await db.commit()

    assert (await client.post(
        f"/initiatives/{ia.id}/people", headers=hdrs,
        json={"person_id": str(worker.id)})).status_code == 403
    assert (await client.post(
        f"/initiatives/{ia.id}/assets", headers=hdrs,
        json={"asset_ids": [str(asset.id)]})).status_code == 403
    assert (await client.post(
        f"/initiatives/{ia.id}/links", headers=hdrs,
        json={"child_id": str(own_other.id)})).status_code == 403
    # A foreign child id never confirms it exists: it comes back as the
    # route's existing 422 `initiative_not_found` — byte-identical to the
    # answer for a child id that was never real (test_link_target_404 in
    # test_initiative_links_api.py pins that shape for global actors).
    foreign = await client.post(f"/initiatives/{ia.id}/links", headers=hdrs,
                                json={"child_id": str(ib.id)})
    ghost = await client.post(f"/initiatives/{ia.id}/links", headers=hdrs,
                              json={"child_id": str(uuid.uuid4())})
    assert foreign.status_code == 422
    assert foreign.json() == ghost.json()
    assert foreign.json()["detail"]["code"] == "initiative_not_found"


async def test_client_writer_cannot_touch_foreign_children(
        client, db, seeded_user):
    """The child routes take a child id only — they must resolve the
    PARENT through the scoping loader (404), then require a global anchor."""
    a, b, ia, ib, _n = await _two_clients_with_initiatives(db)
    foreign_child = Initiative(name="Bravo second", initiative_type="project",
                               client_id=b.id)
    worker = Person(first_name="W", last_name="F",
                    email="wf-cw@test.example.com")
    mine_worker = Person(first_name="W", last_name="M",
                         email="wm-cw@test.example.com")
    asset = Asset(name="theirs", client_id=b.id)
    my_asset = Asset(name="mine", client_id=a.id)
    for row in (foreign_child, worker, mine_worker, asset, my_asset):
        db.add(row)
    await db.flush()
    foreign = {
        "people": InitiativePerson(initiative_id=ib.id, person_id=worker.id),
        "assets": InitiativeAsset(initiative_id=ib.id, asset_id=asset.id),
        "links": InitiativeLink(parent_id=ib.id, child_id=foreign_child.id),
    }
    mine = {
        "people": InitiativePerson(initiative_id=ia.id,
                                   person_id=mine_worker.id),
        "assets": InitiativeAsset(initiative_id=ia.id, asset_id=my_asset.id),
    }
    for row in (*foreign.values(), *mine.values()):
        db.add(row)
    await db.commit()
    hdrs = await client_writer_login(db, client, a.id)

    for kind, row in foreign.items():
        assert (await client.patch(
            f"/initiatives/{kind}/{row.id}", headers=hdrs,
            json={})).status_code == 404, kind
        assert (await client.delete(
            f"/initiatives/{kind}/{row.id}",
            headers=hdrs)).status_code == 404, kind
    # in-scope children are refused by the global-anchor gate instead
    for kind, row in mine.items():
        assert (await client.patch(
            f"/initiatives/{kind}/{row.id}", headers=hdrs,
            json={})).status_code == 403, kind
        assert (await client.delete(
            f"/initiatives/{kind}/{row.id}",
            headers=hdrs)).status_code == 403, kind


async def test_client_writer_cannot_reach_foreign_import_jobs(
        client, db, seeded_user):
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    theirs = ImportJob(kind="move_assets", initiative_id=ib.id,
                       filename="theirs.csv", file_key="k1")
    mine = ImportJob(kind="move_assets", initiative_id=ia.id,
                     filename="mine.csv", file_key="k2")
    db.add(theirs)
    db.add(mine)
    await db.commit()
    hdrs = await client_writer_login(db, client, a.id)

    base = "/initiatives/assets/import-jobs"
    assert (await client.get(f"{base}/{theirs.id}",
                             headers=hdrs)).status_code == 404
    for action in ("commit", "cancel", "reprocess"):
        assert (await client.post(f"{base}/{theirs.id}/{action}",
                                  headers=hdrs)).status_code == 404, action
    # their own initiative's job is readable but not drivable
    assert (await client.get(f"{base}/{mine.id}",
                             headers=hdrs)).status_code == 200
    for action in ("commit", "cancel", "reprocess"):
        assert (await client.post(f"{base}/{mine.id}/{action}",
                                  headers=hdrs)).status_code == 403, action


async def test_links_count_is_client_scoped(client, db, seeded_user):
    """`links_count` must use the same predicate `_link_rows` does, or the
    list view leaks the cardinality of another client's link graph."""
    a, _b, ia, ib, _n = await _two_clients_with_initiatives(db)
    db.add(InitiativeLink(parent_id=ia.id, child_id=ib.id))
    await db.commit()
    hdrs = await client_login(db, client, a.id)
    rows = (await client.get("/initiatives", headers=hdrs)).json()
    assert [r["links_count"] for r in rows] == [0]
    detail = (await client.get(f"/initiatives/{ia.id}", headers=hdrs)).json()
    assert detail["links_count"] == 0
    adm = await _make(db, client, "admin", "adm-lc@test.example.com")
    detail = (await client.get(f"/initiatives/{ia.id}", headers=adm)).json()
    assert detail["links_count"] == 1


async def test_global_staff_writes_unaffected(client, db, seeded_user):
    a, _b, ia, _ib, _n = await _two_clients_with_initiatives(db)
    hdrs = await _make(db, client, "admin", "adm-w@test.example.com")
    resp = await client.post("/initiatives", headers=hdrs, json={
        "name": "Staff made", "initiative_type": "move",
        "client_id": str(a.id)})
    assert resp.status_code == 201, resp.text
    made = resp.json()["id"]
    assert (await client.patch(
        f"/initiatives/{made}", headers=hdrs,
        json={"name": "Staff renamed"})).status_code == 200
    assert (await client.post(
        f"/initiatives/{made}/links", headers=hdrs,
        json={"child_id": str(ia.id)})).status_code == 201
    assert (await client.post(f"/initiatives/{made}/archive",
                              headers=hdrs)).status_code == 204
    assert (await client.post(f"/initiatives/{made}/unarchive",
                              headers=hdrs)).status_code == 204
