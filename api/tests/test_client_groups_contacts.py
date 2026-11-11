"""Client groups: Individual tier, per-client chips, restricted-contact guards."""
from sqlalchemy import select

from serversherpa.clientgroups.keys import group_key
from serversherpa.db.models import ClientContactGroup, ClientGroup, Partner
from tests.client_groups_fixtures import client_user, seed_grouped_client
from tests.test_stakeholders import _headers, _mk_person


async def _add(api, h, cid, pid, tier):
    return await api.post(f"/clients/{cid}/contacts", headers=h,
                          json={"person_id": str(pid), "tier": tier})


async def _chips(db, pid):
    return set((await db.scalars(select(ClientContactGroup.group_id).where(
        ClientContactGroup.person_id == pid))).all())


async def test_staff_add_individual_and_set_chips(client, seeded_user, db):
    s = await seed_grouped_client(db)
    h = await _headers(client)
    p = await _mk_person(db)
    assert (await _add(client, h, s.client.id, p.id, "individual")).status_code == 201
    plat = s.groups["Platform"].id
    r = await client.patch(f"/clients/{s.client.id}/contacts/{p.id}", headers=h,
                           json={"group_ids": [str(plat)]})
    assert r.status_code == 200, r.text
    assert await _chips(db, p.id) == {plat}
    rows = (await client.get(f"/clients/{s.client.id}/contacts", headers=h)).json()
    assert rows[0]["tier"] == "individual"


async def test_chip_from_other_client_rejected(client, seeded_user, db):
    s = await seed_grouped_client(db)
    h = await _headers(client)
    p = await _mk_person(db)
    await _add(client, h, s.client.id, p.id, "viewer")
    g = ClientGroup(client_id=s.other_client.id, name="Foreign",
                    name_key=group_key("Foreign"))
    db.add(g)
    await db.commit()
    r = await client.patch(f"/clients/{s.client.id}/contacts/{p.id}", headers=h,
                           json={"group_ids": [str(g.id)]})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "group_not_in_client"


async def test_client_admin_cannot_set_chips(client, seeded_user, db):
    s = await seed_grouped_client(db)
    ch = await client_user(db, client, s.client.id, "client_admin")
    p = await _mk_person(db)
    staff = await _headers(client)
    await _add(client, staff, s.client.id, p.id, "viewer")
    r = await client.patch(f"/clients/{s.client.id}/contacts/{p.id}", headers=ch,
                           json={"group_ids": [str(s.groups["Platform"].id)]})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"


async def test_client_admin_cannot_add_individual(client, seeded_user, db):
    s = await seed_grouped_client(db)
    ch = await client_user(db, client, s.client.id, "client_admin")
    p = await _mk_person(db)
    r = await _add(client, ch, s.client.id, p.id, "individual")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "individual_is_staff_only"
    staff = await _headers(client)
    await _add(client, staff, s.client.id, p.id, "viewer")
    r = await client.patch(f"/clients/{s.client.id}/contacts/{p.id}", headers=ch,
                           json={"tier": "individual"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "individual_is_staff_only"


async def test_client_admin_cannot_retier_or_remove_restricted(client, seeded_user, db):
    s = await seed_grouped_client(db)
    cid = s.client.id
    ch = await client_user(db, client, cid, "client_owner")
    staff = await _headers(client)
    ind = await _mk_person(db, "Ina", "Ind")
    chipped = await _mk_person(db, "Chip", "Ped")
    plain = await _mk_person(db, "Pla", "In")
    ind_id, chipped_id, plain_id = ind.id, chipped.id, plain.id
    for pid, t in ((ind_id, "individual"), (chipped_id, "viewer"),
                   (plain_id, "viewer")):
        await _add(client, staff, cid, pid, t)
    await client.patch(f"/clients/{cid}/contacts/{chipped_id}", headers=staff,
                       json={"group_ids": [str(s.groups["Storage"].id)]})
    for pid in (ind_id, chipped_id):
        r = await client.patch(f"/clients/{cid}/contacts/{pid}", headers=ch,
                               json={"tier": "viewer"})
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["code"] == "restricted_contact"
        r = await client.delete(f"/clients/{cid}/contacts/{pid}", headers=ch)
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "restricted_contact"
    r = await client.patch(f"/clients/{cid}/contacts/{plain_id}", headers=ch,
                           json={"tier": "admin"})
    assert r.status_code == 200, r.text
    assert (await client.delete(f"/clients/{cid}/contacts/{plain_id}",
                                headers=ch)).status_code == 204


async def test_staff_remove_deletes_chips(client, seeded_user, db):
    s = await seed_grouped_client(db)
    h = await _headers(client)
    pid = (await _mk_person(db)).id
    cid = s.client.id
    await _add(client, h, cid, pid, "individual")
    await client.patch(f"/clients/{cid}/contacts/{pid}", headers=h,
                       json={"group_ids": [str(s.groups["Platform"].id)]})
    assert (await client.delete(f"/clients/{cid}/contacts/{pid}",
                                headers=h)).status_code == 204
    assert await _chips(db, pid) == set()


async def test_partner_individual_rejected(client, seeded_user, db):
    h = await _headers(client)
    partner = Partner(name="Vend")
    db.add(partner)
    p = await _mk_person(db)
    await db.commit()
    r = await client.post(f"/partners/{partner.id}/contacts", headers=h,
                          json={"person_id": str(p.id), "tier": "individual"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "tier_not_for_partners"


async def test_contact_list_returns_group_ids(client, seeded_user, db):
    s = await seed_grouped_client(db)
    h = await _headers(client)
    p = await _mk_person(db)
    q = await _mk_person(db, "Zed", "Zzz")
    await _add(client, h, s.client.id, p.id, "viewer")
    await _add(client, h, s.client.id, q.id, "viewer")
    plat = s.groups["Platform"].id
    await client.patch(f"/clients/{s.client.id}/contacts/{p.id}", headers=h,
                       json={"group_ids": [str(plat)]})
    rows = {r["person_id"]: r for r in
            (await client.get(f"/clients/{s.client.id}/contacts", headers=h)).json()}
    assert rows[str(p.id)]["group_ids"] == [str(plat)]
    assert rows[str(q.id)]["group_ids"] == []
