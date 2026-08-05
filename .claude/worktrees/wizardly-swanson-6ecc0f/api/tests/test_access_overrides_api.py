import pytest
from sqlalchemy import select

from serversherpa.db.models import PermissionOverride, Person, PersonRole
from tests.test_access_roles_api import login_admin


async def make_staffer(db):
    p = Person(first_name="S", last_name="Taff")
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role="staff"))
    await db.commit()
    return p


async def test_put_get_and_clear_overrides(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    target = await make_staffer(db)
    resp = await client.put(f"/access/overrides/{target.id}", headers=hdrs,
                            json={"overrides": {"workers": {"delete": False},
                                                "settings": {"change": True}}})
    assert resp.status_code == 200, resp.text
    body = (await client.get(f"/access/overrides/{target.id}",
                             headers=hdrs)).json()
    assert body["overrides"] == {"workers": {"delete": False},
                                 "settings": {"change": True}}
    # null clears back to inherit
    resp = await client.put(f"/access/overrides/{target.id}", headers=hdrs,
                            json={"overrides": {"settings": {"change": True}}})
    assert resp.status_code == 200
    rows = list(await db.scalars(select(PermissionOverride)))
    assert len(rows) == 1 and rows[0].resource == "settings"


async def test_override_guards(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    resp = await client.put(f"/access/overrides/{seeded_user.id}", headers=hdrs,
                            json={"overrides": {"workers": {"view": True}}})
    assert resp.json()["detail"]["code"] == "cannot_target_self"
    target = await make_staffer(db)
    resp = await client.put(f"/access/overrides/{target.id}", headers=hdrs,
                            json={"overrides": {"devtools": {"view": True}}})
    assert resp.json()["detail"]["code"] == "developer_only_resource"
