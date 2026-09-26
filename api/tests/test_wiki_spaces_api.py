"""HTTP tests for /wiki/me, /wiki/spaces (+ grants), and /wiki/principals —
Task 3 of the wiki API: spaces, grants, and principal search."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Client, Person, WikiGrant, WikiNode, WikiPage, WikiPageVersion,
)
from serversherpa.wiki.content import EMPTY_DOC
from tests.wiki_helpers import login_as


async def _create_space(client, headers, key="ops-guides", name="Ops Guides",
                        default_access="private", **extra):
    return await client.post(
        "/wiki/spaces", headers=headers,
        json={"key": key, "name": name, "default_access": default_access, **extra})


# ── me ───────────────────────────────────────────────────────────────


async def test_me_reports_admin_and_create_flags(client, db):
    staff_headers, staff_id = await login_as(client, db, roles=("staff",))
    staff_me = (await client.get("/wiki/me", headers=staff_headers)).json()
    assert staff_me["person"]["id"] == str(staff_id)
    assert staff_me["is_admin"] is False
    assert staff_me["can_create_spaces"] is True

    admin_headers, _ = await login_as(client, db, roles=("admin",))
    admin_me = (await client.get("/wiki/me", headers=admin_headers)).json()
    assert admin_me["is_admin"] is True
    assert admin_me["can_create_spaces"] is True


# ── create ───────────────────────────────────────────────────────────


async def test_staff_creates_space_with_published_home_and_grants(client, db):
    headers, staff_id = await login_as(client, db, roles=("staff",))

    resp = await _create_space(
        client, headers, key="ops-guides", name="Ops Guides",
        default_access="internal", description="Runbooks and how-tos.")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["key"] == "ops-guides"
    assert body["name"] == "Ops Guides"
    assert body["my_level"] == "manage"
    assert body["archived_at"] is None
    assert body["settings"] == {}
    home_node_id = uuid.UUID(body["home_node_id"])

    node = await db.get(WikiNode, home_node_id)
    assert node is not None
    assert node.kind == "page"
    assert node.parent_id is None
    assert node.title == "Ops Guides"
    assert node.owner_id == staff_id

    page = await db.get(WikiPage, home_node_id)
    assert page is not None
    assert page.has_unpublished_changes is False
    assert page.published_version_id is not None

    version = await db.get(WikiPageVersion, page.published_version_id)
    assert version.kind == "published"
    assert version.version_no == 1
    assert version.content_json == EMPTY_DOC

    grants = (await db.scalars(
        select(WikiGrant).where(WikiGrant.space_id == uuid.UUID(body["id"]))
    )).all()
    by_type = {(g.principal_type, g.principal_id): g.level for g in grants}
    assert by_type == {
        ("person", str(staff_id)): "manage",
        ("internal", None): "view",
    }


async def test_client_viewer_cannot_create_space(client, db):
    client_row = Client(name="Acme")
    db.add(client_row)
    await db.flush()
    await db.commit()
    headers, _ = await login_as(
        client, db, roles=("client_viewer",), client_id=client_row.id)

    resp = await _create_space(client, headers, key="secret-space")
    assert resp.status_code == 403


async def test_duplicate_key_conflicts(client, db):
    headers, _ = await login_as(client, db, roles=("staff",))
    assert (await _create_space(client, headers, key="dup-key",
                                default_access="private")).status_code == 201
    resp = await _create_space(client, headers, key="dup-key",
                               default_access="private")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "key_taken"


async def test_bad_key_is_rejected(client, db):
    headers, _ = await login_as(client, db, roles=("staff",))
    resp = await _create_space(client, headers, key="a", default_access="private")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_key"


async def test_space_name_is_capped_like_a_page_title(client, db):
    """The home page takes the space's name as its title (1-200 characters),
    so create and rename refuse a name the title couldn't hold."""
    headers, _ = await login_as(client, db, roles=("staff",))
    assert (await _create_space(client, headers, key="too-long", name="x" * 201)).status_code == 422
    assert (await _create_space(client, headers, key="blank-name", name="   ")).status_code == 422
    assert (await db.scalar(select(WikiNode).where(WikiNode.title == "x" * 201))) is None

    created = await _create_space(client, headers, key="just-fits", name="y" * 200)
    assert created.status_code == 201, created.text
    home = await db.get(WikiNode, uuid.UUID(created.json()["home_node_id"]))
    assert home.title == "y" * 200

    too_long = await client.patch("/wiki/spaces/just-fits", headers=headers, json={"name": "z" * 201})
    assert too_long.status_code == 422
    renamed = await client.patch("/wiki/spaces/just-fits", headers=headers, json={"name": "  Trimmed  "})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Trimmed"


# ── visibility by default_access ────────────────────────────────────


async def test_internal_default_hides_space_from_client_viewer(client, db):
    client_row = Client(name="Acme")
    db.add(client_row)
    await db.flush()
    await db.commit()

    staff_headers, _ = await login_as(client, db, roles=("staff",))
    created = await _create_space(
        client, staff_headers, key="internal-only", default_access="internal")
    assert created.status_code == 201

    viewer_headers, _ = await login_as(
        client, db, roles=("client_viewer",), client_id=client_row.id)

    listing = await client.get("/wiki/spaces", headers=viewer_headers)
    assert listing.status_code == 200
    assert "internal-only" not in {s["key"] for s in listing.json()}

    get_resp = await client.get("/wiki/spaces/internal-only", headers=viewer_headers)
    assert get_resp.status_code == 404


async def test_everyone_default_gives_client_viewer_view_level(client, db):
    client_row = Client(name="Acme")
    db.add(client_row)
    await db.flush()
    await db.commit()

    staff_headers, _ = await login_as(client, db, roles=("staff",))
    created = await _create_space(
        client, staff_headers, key="open-space", default_access="everyone")
    assert created.status_code == 201

    viewer_headers, _ = await login_as(
        client, db, roles=("client_viewer",), client_id=client_row.id)

    resp = await client.get("/wiki/spaces/open-space", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json()["my_level"] == "view"


# ── patch ────────────────────────────────────────────────────────────


async def test_patch_requires_manage_level(client, db):
    client_row = Client(name="Acme")
    db.add(client_row)
    await db.flush()
    await db.commit()

    staff_headers, _ = await login_as(client, db, roles=("staff",))
    assert (await _create_space(
        client, staff_headers, key="patchable", default_access="everyone")).status_code == 201

    viewer_headers, _ = await login_as(
        client, db, roles=("client_viewer",), client_id=client_row.id)
    viewer_resp = await client.patch(
        "/wiki/spaces/patchable", headers=viewer_headers, json={"name": "Nope"})
    assert viewer_resp.status_code == 403

    manager_resp = await client.patch(
        "/wiki/spaces/patchable", headers=staff_headers, json={"name": "Renamed"})
    assert manager_resp.status_code == 200
    assert manager_resp.json()["name"] == "Renamed"


async def test_patch_settings_rejects_unknown_keys_phase1(client, db):
    headers, _ = await login_as(client, db, roles=("staff",))
    assert (await _create_space(
        client, headers, key="settings-space", default_access="private")).status_code == 201

    resp = await client.patch(
        "/wiki/spaces/settings-space", headers=headers,
        json={"settings": {"readers_can_comment": True}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_setting"


# ── grants ───────────────────────────────────────────────────────────


async def test_put_grants_replaces_and_guards_last_manager(client, db):
    staff_headers, staff_id = await login_as(client, db, roles=("staff",))
    created = await _create_space(
        client, staff_headers, key="grants-space", default_access="internal")
    assert created.status_code == 201

    get_resp = await client.get("/wiki/spaces/grants-space/grants", headers=staff_headers)
    assert get_resp.status_code == 200
    grants = get_resp.json()["grants"]
    assert {(g["principal_type"], g["level"]) for g in grants} == {
        ("person", "manage"), ("internal", "view")}

    # a non-admin manager can't leave the space without a manager
    no_manager_resp = await client.put(
        "/wiki/spaces/grants-space/grants", headers=staff_headers,
        json={"grants": [{"principal_type": "internal", "level": "view"}]})
    assert no_manager_resp.status_code == 422
    assert no_manager_resp.json()["detail"]["code"] == "no_manager"

    # a wiki admin is exempt from that guard
    admin_headers, _ = await login_as(client, db, roles=("admin",))
    admin_resp = await client.put(
        "/wiki/spaces/grants-space/grants", headers=admin_headers,
        json={"grants": [{"principal_type": "everyone", "level": "view"}]})
    assert admin_resp.status_code == 200
    replaced = admin_resp.json()["grants"]
    assert len(replaced) == 1
    assert replaced[0]["principal_type"] == "everyone"
    assert replaced[0]["level"] == "view"

    remaining = (await db.scalars(
        select(WikiGrant).where(WikiGrant.space_id == created.json()["id"])
    )).all()
    assert len(remaining) == 1


async def test_put_grants_rejects_unknown_principal(client, db):
    headers, _ = await login_as(client, db, roles=("staff",))
    created = await _create_space(
        client, headers, key="bad-principal-space", default_access="internal")
    assert created.status_code == 201

    resp = await client.put(
        "/wiki/spaces/bad-principal-space/grants", headers=headers,
        json={"grants": [
            {"principal_type": "person", "principal_id": str(uuid.uuid4()),
             "level": "manage"},
        ]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_principal"


# ── archive / unarchive ──────────────────────────────────────────────


async def test_archive_clamps_member_to_view_and_unarchive_is_admin_only(client, db):
    staff_headers, _ = await login_as(client, db, roles=("staff",))
    created = await _create_space(
        client, staff_headers, key="archivable", default_access="internal")
    assert created.status_code == 201

    archive_resp = await client.post(
        "/wiki/spaces/archivable/archive", headers=staff_headers)
    assert archive_resp.status_code == 200
    assert archive_resp.json()["archived_at"] is not None
    assert archive_resp.json()["my_level"] == "view"

    get_resp = await client.get("/wiki/spaces/archivable", headers=staff_headers)
    assert get_resp.json()["my_level"] == "view"

    non_admin_unarchive = await client.post(
        "/wiki/spaces/archivable/unarchive", headers=staff_headers)
    assert non_admin_unarchive.status_code == 403

    admin_headers, _ = await login_as(client, db, roles=("admin",))
    admin_unarchive = await client.post(
        "/wiki/spaces/archivable/unarchive", headers=admin_headers)
    assert admin_unarchive.status_code == 200
    assert admin_unarchive.json()["archived_at"] is None


# ── principals ───────────────────────────────────────────────────────


async def test_principals_gated_and_returns_labels(client, db):
    client_row = Client(name="Acme")
    db.add(client_row)
    await db.flush()
    await db.commit()

    staff_headers, staff_id = await login_as(
        client, db, roles=("staff",), email="manager@test.example.com")
    assert (await _create_space(
        client, staff_headers, key="principal-space",
        default_access="private")).status_code == 201

    viewer_headers, _ = await login_as(
        client, db, roles=("client_viewer",), client_id=client_row.id)
    gated = await client.get(
        "/wiki/principals", headers=viewer_headers, params={"type": "person", "q": ""})
    assert gated.status_code == 403

    staff = await db.get(Person, staff_id)
    person_resp = await client.get(
        "/wiki/principals", headers=staff_headers,
        params={"type": "person", "q": staff.last_name})
    assert person_resp.status_code == 200
    labels = {p["label"] for p in person_resp.json()}
    assert staff.display_name in labels

    role_resp = await client.get(
        "/wiki/principals", headers=staff_headers,
        params={"type": "role", "q": "staff"})
    assert role_resp.status_code == 200
    assert any(p["id"] == "staff" for p in role_resp.json())


# ── audit ────────────────────────────────────────────────────────────


async def test_writes_are_audited(client, db):
    headers, staff_id = await login_as(client, db, roles=("staff",))
    created = await _create_space(
        client, headers, key="audited-space", default_access="internal")
    assert created.status_code == 201
    space_id = created.json()["id"]

    patch_resp = await client.patch(
        "/wiki/spaces/audited-space", headers=headers, json={"name": "Audited"})
    assert patch_resp.status_code == 200

    put_resp = await client.put(
        "/wiki/spaces/audited-space/grants", headers=headers,
        json={"grants": [{"principal_type": "person", "principal_id": str(staff_id),
                          "level": "manage"}]})
    assert put_resp.status_code == 200

    rows = (await db.scalars(
        select(AuditLog).where(AuditLog.entity_id == space_id)
        .order_by(AuditLog.at)
    )).all()
    actions_by_entity = {(r.entity_type, r.action) for r in rows}
    assert ("wiki_space", "create") in actions_by_entity
    assert ("wiki_space", "update") in actions_by_entity
    assert ("wiki_grant", "replace") in actions_by_entity


async def test_list_spaces_statement_count_does_not_grow_with_spaces(client, db):
    from sqlalchemy import event

    from serversherpa.db.engine import get_engine

    headers, _ = await login_as(client, db, roles=("staff",))

    async def _statements_for_list() -> int:
        statements: list[str] = []

        def _count(conn, cursor, statement, *args):
            statements.append(statement)

        engine = get_engine().sync_engine
        event.listen(engine, "before_cursor_execute", _count)
        try:
            resp = await client.get("/wiki/spaces", headers=headers)
        finally:
            event.remove(engine, "before_cursor_execute", _count)
        assert resp.status_code == 200
        return len(statements)

    await _create_space(client, headers, key=f"n1-{uuid.uuid4().hex[:8]}")
    before = await _statements_for_list()
    for _ in range(5):
        await _create_space(client, headers, key=f"n1-{uuid.uuid4().hex[:8]}",
                            default_access="internal")
    after = await _statements_for_list()
    assert after == before
