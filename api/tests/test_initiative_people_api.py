"""Initiative people — add/update/remove, duplicate + validation codes."""

import uuid

from serversherpa.db.models import Person

from .test_assets_api import login


async def _initiative(client, headers, name="Team test"):
    resp = await client.post("/initiatives", headers=headers,
                             json={"name": name, "initiative_type": "project"})
    return resp.json()["id"]


async def _person(db, first="Terry", last="Tech"):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.commit()
    return p


async def test_people_roundtrip(client, db, seeded_user):
    headers = await login(client)
    iid = await _initiative(client, headers)
    p = await _person(db)

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id),
                                   "work_type": "tech", "rating": 4})
    assert resp.status_code == 201, resp.text
    rows = resp.json()
    assert rows[0]["person_name"] == "Terry Tech"
    assert rows[0]["work_type_label"] == "Tech"
    assert rows[0]["rating"] == 4
    assoc_id = rows[0]["id"]

    resp = await client.patch(f"/initiatives/people/{assoc_id}",
                              headers=headers, json={"rating": 5})
    assert resp.status_code == 200
    assert resp.json()["rating"] == 5

    # the initiative list denormalizes the count
    resp = await client.get("/initiatives", headers=headers)
    assert resp.json()[0]["people_count"] == 1

    resp = await client.delete(f"/initiatives/people/{assoc_id}",
                               headers=headers)
    assert resp.status_code == 204
    resp = await client.get(f"/initiatives/{iid}", headers=headers)
    assert resp.json()["people"] == []


async def test_people_validation(client, db, seeded_user):
    headers = await login(client)
    iid = await _initiative(client, headers)
    p = await _person(db)

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(uuid.uuid4())})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "person_not_found"

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id),
                                   "work_type": "bogus"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_work_type"

    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id), "rating": 9})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rating_out_of_range"

    assert (await client.post(
        f"/initiatives/{iid}/people", headers=headers,
        json={"person_id": str(p.id)})).status_code == 201
    resp = await client.post(f"/initiatives/{iid}/people", headers=headers,
                             json={"person_id": str(p.id)})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "duplicate_person"


async def test_people_assoc_404(client, db, seeded_user):
    headers = await login(client)
    resp = await client.patch(f"/initiatives/people/{uuid.uuid4()}",
                              headers=headers, json={"rating": 3})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "assignment_not_found"
