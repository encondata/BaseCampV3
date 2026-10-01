from .api_helpers import auth_headers
from .factories import make_user


def _admin_matrix(view_users=True, add_users=False):
    return {"dashboard": {"view": True}, "users": {"view": view_users, "add": add_users},
            "access": {"view": True}, "audit": {"view": True}, "settings": {"view": True}}


async def test_summary(client, db):
    h = await auth_headers(client, db)
    body = (await client.get("/api/access/summary", headers=h)).json()
    assert [r["id"] for r in body["resources"]] == [
        "dashboard", "users", "access", "audit", "settings", "devtools"]
    assert [r["name"] for r in body["roles"]] == ["developer", "founder", "super_admin", "admin"]
    admin = body["roles"][-1]
    assert admin["matrix"]["users"] == {"view": True, "add": False, "change": False,
                                        "delete": False}
    assert body["roles"][0]["member_count"] == 1


async def test_matrix_update_and_rules(client, db):
    h = await auth_headers(client, db)                       # developer, rank 100
    ok = await client.put("/api/access/roles/admin/matrix", headers=h,
                          json={"matrix": _admin_matrix(add_users=True)})
    assert ok.status_code == 200 and ok.json()["grants"] == 6
    bad_dev = await client.put("/api/access/roles/admin/matrix", headers=h,
                               json={"matrix": {**_admin_matrix(), "devtools": {"view": True}}})
    assert bad_dev.status_code == 422
    assert bad_dev.json()["detail"]["code"] == "developer_only_resource"
    locked = await client.put("/api/access/roles/admin/matrix", headers=h,
                              json={"matrix": {**_admin_matrix(), "access": {"view": False}}})
    assert locked.status_code == 422
    assert locked.json()["detail"]["code"] == "access_view_locked"
    unknown = await client.put("/api/access/roles/admin/matrix", headers=h,
                               json={"matrix": {**_admin_matrix(), "nope": {"view": True}}})
    assert unknown.status_code == 422 and unknown.json()["detail"]["code"] == "unknown_resource"


async def test_super_admin_cannot_grant_beyond_own(client, db):
    h = await auth_headers(client, db, roles=("super_admin",))
    # super_admin lacks access.add — granting it to admin exceeds their own
    resp = await client.put("/api/access/roles/admin/matrix", headers=h,
                            json={"matrix": {**_admin_matrix(), "access": {"view": True,
                                                                           "add": True}}})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "grant_exceeds_own"
    peer = await client.put("/api/access/roles/super_admin/matrix", headers=h,
                            json={"matrix": _admin_matrix()})
    assert peer.status_code == 403
    assert peer.json()["detail"]["code"] == "cannot_edit_own_role"


def _dev_matrix(*, drop=()):
    """The developer role's full grants, minus any 'resource:action' in drop."""
    full = {res: {a: True for a in ("view", "add", "change", "delete")}
            for res in ("users", "access", "settings", "devtools")}
    full |= {"dashboard": {"view": True}, "audit": {"view": True}}
    for cell in drop:
        res, a = cell.split(":")
        full[res][a] = False
    return full


async def test_developer_can_edit_the_developer_role(client, db):
    h = await auth_headers(client, db)                       # developer
    ok = await client.put("/api/access/roles/developer/matrix", headers=h,
                          json={"matrix": _dev_matrix(drop=["users:delete"])})
    assert ok.status_code == 200, ok.json()


async def test_founder_cannot_edit_developer_role(client, db):
    h = await auth_headers(client, db, roles=("founder",))
    resp = await client.put("/api/access/roles/developer/matrix", headers=h,
                            json={"matrix": _dev_matrix()})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "developer_role_locked"


async def test_developer_role_core_grants_cannot_be_removed(client, db):
    h = await auth_headers(client, db)
    for cell in ("devtools:view", "devtools:add", "devtools:change", "devtools:delete",
                 "access:change", "access:view"):
        resp = await client.put("/api/access/roles/developer/matrix", headers=h,
                                json={"matrix": _dev_matrix(drop=[cell])})
        assert resp.status_code == 422, cell
        assert resp.json()["detail"]["code"] == "developer_role_core", cell


async def test_overrides_roundtrip_and_rules(client, db):
    h = await auth_headers(client, db)
    target = await make_user(db, email="admin@test.example.com", roles=("admin",))
    url = f"/api/access/overrides/{target.person_id}"
    put = await client.put(url, headers=h,
                           json={"overrides": {"users": {"change": True, "view": None}}})
    assert put.status_code == 200 and put.json()["overrides"] == 1
    got = (await client.get(url, headers=h)).json()
    assert got["overrides"] == {"users": {"change": True}}
    dev = await client.put(url, headers=h, json={"overrides": {"devtools": {"view": True}}})
    assert dev.status_code == 422
    assert dev.json()["detail"]["code"] == "developer_only_resource"
    me = (await client.get("/api/auth/me", headers=h)).json()["person"]["id"]
    self_edit = await client.put(f"/api/access/overrides/{me}", headers=h,
                                 json={"overrides": {}})
    assert self_edit.status_code == 403
    assert self_edit.json()["detail"]["code"] == "cannot_target_self"


async def test_admin_cannot_edit_matrix(client, db):
    h = await auth_headers(client, db, roles=("admin",))
    resp = await client.put("/api/access/roles/admin/matrix", headers=h,
                            json={"matrix": _admin_matrix()})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"


async def test_matrix_rank_too_low(client, db):
    h = await auth_headers(client, db, roles=("super_admin",))
    resp = await client.put("/api/access/roles/founder/matrix", headers=h,
                            json={"matrix": _admin_matrix()})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"


async def test_matrix_role_not_found_and_unknown_action(client, db):
    h = await auth_headers(client, db)
    missing = await client.put("/api/access/roles/nope/matrix", headers=h,
                               json={"matrix": _admin_matrix()})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "role_not_found"
    bad = await client.put("/api/access/roles/admin/matrix", headers=h,
                           json={"matrix": {**_admin_matrix(), "users": {"explode": True}}})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "unknown_action"


async def test_overrides_rank_too_low(client, db):
    h = await auth_headers(client, db, roles=("super_admin",))
    target = await make_user(db, email="dev2@test.example.com", roles=("developer",))
    resp = await client.put(f"/api/access/overrides/{target.person_id}", headers=h,
                            json={"overrides": {"users": {"view": True}}})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "rank_too_low"


async def test_overrides_grant_exceeds_own(client, db):
    h = await auth_headers(client, db, roles=("super_admin",))
    target = await make_user(db, email="admin@test.example.com", roles=("admin",))
    resp = await client.put(f"/api/access/overrides/{target.person_id}", headers=h,
                            json={"overrides": {"access": {"add": True}}})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "grant_exceeds_own"


async def test_overrides_person_not_found(client, db):
    import uuid
    h = await auth_headers(client, db)
    resp = await client.put(f"/api/access/overrides/{uuid.uuid4()}", headers=h,
                            json={"overrides": {}})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "person_not_found"


async def test_access_changes_write_audit_rows(client, db):
    h = await auth_headers(client, db)
    ok = await client.put("/api/access/roles/admin/matrix", headers=h,
                          json={"matrix": _admin_matrix(add_users=True)})
    assert ok.status_code == 200, ok.json()
    rows = (await client.get("/api/audit?action=matrix.update", headers=h)).json()
    assert len(rows) == 1
    assert rows[0]["entity_type"] == "role" and rows[0]["entity_id"] == "admin"
    assert "users:add" in rows[0]["changes"]["granted"]

    target = await make_user(db, email="admin2@test.example.com", roles=("admin",))
    put = await client.put(f"/api/access/overrides/{target.person_id}", headers=h,
                           json={"overrides": {"users": {"change": True}}})
    assert put.status_code == 200
    rows = (await client.get("/api/audit?action=override.set", headers=h)).json()
    assert len(rows) == 1
    assert rows[0]["entity_type"] == "user" and rows[0]["entity_id"] == str(target.person_id)


async def test_overrides_resave_keeps_existing_allow_the_actor_lacks(client, db):
    from sirdar_api.db.models import PermissionOverride
    h = await auth_headers(client, db, roles=("super_admin",))
    target = await make_user(db, email="admin@test.example.com", roles=("admin",))
    db.add(PermissionOverride(person_id=target.person_id, resource="access", action="add",
                              allow=True, set_by=target.person_id))
    await db.commit()
    url = f"/api/access/overrides/{target.person_id}"
    ok = await client.put(url, headers=h, json={"overrides": {
        "access": {"add": True}, "users": {"view": True}}})
    assert ok.status_code == 200, ok.text
    new = await client.put(url, headers=h, json={"overrides": {
        "access": {"add": True, "delete": True}}})
    assert new.status_code == 403 and new.json()["detail"]["code"] == "grant_exceeds_own"
