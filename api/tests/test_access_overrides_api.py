import pytest
from sqlalchemy import select, text

from serversherpa.db.models import PermissionOverride, Person, PersonRole
from tests.test_access_roles_api import login_admin
from tests.test_sites_api import login


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


async def test_overrides_read_is_rank_gated(client, db, seeded_user):
    """Security-fixes task 5 finding (d): GET /access/overrides/{person_id}
    had no guard at all, unlike GET /access/effective/{person_id} — any
    holder of access:view could read anyone's overrides. Copy effective's
    guard: below GATE_BYPASS_RANK (60), only your own record is readable."""
    founder = Person(first_name="F", last_name="Ounder")
    db.add(founder)
    await db.flush()
    db.add(PersonRole(person_id=founder.id, role="founder"))
    await db.commit()

    staff_hdrs = await login(client)   # seeded_user (alice) is "staff", rank 40
    resp = await client.get(f"/access/overrides/{founder.id}", headers=staff_hdrs)
    assert resp.status_code == 403

    resp = await client.get(f"/access/overrides/{seeded_user.id}", headers=staff_hdrs)
    assert resp.status_code == 200

    await db.execute(text(
        "UPDATE person_roles SET role='super_admin' WHERE person_id=:p"),
        {"p": seeded_user.id})
    await db.commit()
    super_hdrs = await login(client)
    resp = await client.get(f"/access/overrides/{founder.id}", headers=super_hdrs)
    assert resp.status_code == 200
