"""Client groups: one person never holds a client tier and the worker role at
once (the worker role's kiosk:view would bypass group limits through the
kiosk sync routes). Every grant path refuses with 409
`client_worker_conflict`; a bulk import fails that row with the reason.
Combinations that already exist are never revoked.

Spec: docs/superpowers/specs/2026-11-10-client-groups-design.md (Answers to
the open questions, item 4)"""
import pytest
from sqlalchemy import select

from serversherpa.access.role_mix import (
    CONFLICT_ROW_ERROR,
    RoleMixError,
    assert_no_client_worker_mix,
)
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import Client, Partner, Person, PersonRole, UserAccount
from serversherpa.people import assign_bulk as ab
from serversherpa.people import bulk_import as bi
from tests.test_access_roles_api import login_admin
from tests.test_account_mgmt import _mk_user

CODE = "client_worker_conflict"


async def _client(db, name="Acme") -> Client:
    c = Client(name=name)
    db.add(c)
    await db.commit()
    return c


async def _contact(db, client, *, tier="client_viewer", worker=False, account=False,
                   email="cc@test.example.com") -> Person:
    """A client contact at `tier`, also holding `worker` when asked (an
    existing combination, written straight to the table)."""
    p = Person(first_name="Cleo", last_name="Contact", email=email)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=tier, client_id=client.id))
    if worker:
        db.add(PersonRole(person_id=p.id, role="worker"))
    if account:
        db.add(UserAccount(person_id=p.id, email=email, password_hash="x"))
    await db.commit()
    return p


async def _active(db, person_id) -> list[str]:
    """The person's active roles, as a new session sees them (committed)."""
    async with get_sessionmaker()() as s:
        return sorted(await s.scalars(select(PersonRole.role).where(
            PersonRole.person_id == person_id, PersonRole.revoked_at.is_(None))))


def _code(resp) -> str | None:
    return resp.json().get("detail", {}).get("code")


# ── the rule itself ──────────────────────────────────────────────────

async def test_assert_no_client_worker_mix(db):
    acme = await _client(db)
    contact = await _contact(db, acme)
    worker = Person(first_name="Wes", last_name="Worker")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    for tier in ("client_owner", "client_admin", "client_viewer", "client_individual"):
        try:
            await assert_no_client_worker_mix(db, worker.id, tier)
        except RoleMixError as exc:
            assert exc.code == CODE
        else:
            raise AssertionError(tier)
    try:
        await assert_no_client_worker_mix(db, contact.id, "worker")
    except RoleMixError:
        pass
    else:
        raise AssertionError("worker to a client contact")
    # partner tiers and other roles pass
    await assert_no_client_worker_mix(db, worker.id, "vendor_viewer")
    await assert_no_client_worker_mix(db, contact.id, "staff")
    # a revoked worker role is history, not a conflict
    from datetime import UTC, datetime
    row = await db.scalar(select(PersonRole).where(PersonRole.person_id == worker.id))
    row.revoked_at = datetime.now(UTC)
    await db.commit()
    await assert_no_client_worker_mix(db, worker.id, "client_viewer")


# ── API grant paths ──────────────────────────────────────────────────

async def test_add_worker_to_client_contact_409(client, seeded_user, db):
    """ManageRolesModal (PUT /users/{id}/roles) and demote both grant
    `worker`: refused for a client contact, and nothing is written."""
    acme = await _client(db)
    user = await _mk_user(db, first="Cara", last="Contact", email="cara@test.example.com",
                          roles=("staff",))
    db.add(PersonRole(person_id=user.id, role="client_viewer", client_id=acme.id))
    await db.commit()
    admin = await login_admin(client, db, seeded_user)

    r = await client.put(f"/users/{user.id}/roles", headers=admin,
                         json={"roles": ["staff", "worker"]})
    assert r.status_code == 409, r.text
    assert _code(r) == CODE
    assert await _active(db, user.id) == ["client_viewer", "staff"]

    r = await client.post(f"/users/{user.id}/demote", headers=admin)
    assert r.status_code == 409, r.text
    assert _code(r) == CODE
    assert await _active(db, user.id) == ["client_viewer", "staff"]
    async with get_sessionmaker()() as fresh:
        assert await fresh.get(UserAccount, user.id) is not None



async def test_access_copy_reports_client_worker_conflict(client, seeded_user, db):
    """POST /access/copy from a worker: a client-contact target is skipped
    with reason `client_worker_conflict`, in the dry run's plan and on
    apply, as the endpoint's other skips are; other targets copy as usual."""
    acme = await _client(db)
    contact = await _mk_user(db, first="Cara", last="Contact", email="cara@test.example.com",
                             roles=("staff",))
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=acme.id))
    plain = await _mk_user(db, first="Pia", last="Plain", email="pia@test.example.com",
                           roles=("staff",))
    src = await _mk_user(db, first="Wyn", last="Worker", email="wyn@test.example.com",
                         roles=("worker",))
    await db.commit()
    contact_id, plain_id, src_id = contact.id, plain.id, src.id
    admin = await login_admin(client, db, seeded_user)

    for dry_run in (True, False):
        r = await client.post("/access/copy", headers=admin, json={
            "source_id": str(src_id), "target_ids": [str(contact_id), str(plain_id)],
            "parts": ["roles"], "mode": "replace", "dry_run": dry_run})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["applied"] is (not dry_run)
        by_id = {t["person_id"]: t for t in body["targets"]}
        assert (by_id[str(contact_id)]["status"], by_id[str(contact_id)]["reason"]) == (
            "skipped", CODE), dry_run
        assert by_id[str(contact_id)]["roles"] is None
        assert by_id[str(plain_id)]["status"] == "ok", dry_run
    assert await _active(db, contact_id) == ["client_viewer", "staff"]
    assert await _active(db, plain_id) == ["worker"]


async def test_add_client_contact_to_worker_409(client, seeded_user, db):
    """Adding a worker as a client contact, at any tier, is refused; a
    partner contact still may be a worker."""
    acme = await _client(db)
    w = Person(first_name="Wes", last_name="Worker")
    db.add(w)
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    vendor = Partner(name="Haulers")
    db.add(vendor)
    await db.commit()
    admin = await login_admin(client, db, seeded_user)
    for tier in ("owner", "admin", "viewer", "individual"):
        r = await client.post(f"/clients/{acme.id}/contacts", headers=admin,
                              json={"person_id": str(w.id), "tier": tier})
        assert r.status_code == 409, (tier, r.text)
        assert _code(r) == CODE, tier
    assert await _active(db, w.id) == ["worker"]
    r = await client.post(f"/partners/{vendor.id}/contacts", headers=admin,
                          json={"person_id": str(w.id), "tier": "viewer"})
    assert r.status_code == 201, r.text


async def test_tier_change_on_existing_mix_409(client, seeded_user, db):
    """A tier change is a new grant: refused for someone who already holds
    both (the old combination is kept, not revoked)."""
    acme = await _client(db)
    both = await _contact(db, acme, worker=True)
    admin = await login_admin(client, db, seeded_user)
    r = await client.patch(f"/clients/{acme.id}/contacts/{both.id}", headers=admin,
                           json={"tier": "admin"})
    assert r.status_code == 409, r.text
    assert _code(r) == CODE
    assert await _active(db, both.id) == ["client_viewer", "worker"]


async def test_existing_mix_not_revoked(client, seeded_user, db):
    """Someone who held both before the rule keeps both: metadata edits and
    re-saving roles that keep `worker` work, and the workers import treats
    them as the worker they already are."""
    actor_id = seeded_user.id
    acme = await _client(db)
    both = await _contact(db, acme, worker=True, account=True, email="both@test.example.com")
    both_id = both.id
    admin = await login_admin(client, db, seeded_user)
    r = await client.patch(f"/clients/{acme.id}/contacts/{both_id}", headers=admin,
                           json={"org_title": "Ops lead"})
    assert r.status_code == 200, r.text
    r = await client.put(f"/users/{both_id}/roles", headers=admin,
                         json={"roles": ["worker"]})
    assert r.status_code == 200, r.text
    assert await _active(db, both_id) == ["client_viewer", "worker"]

    out = await bi.preview_rows(db, bi.number_json_rows([
        {"first_name": "Cleo", "last_name": "Contact", "email": "both@test.example.com",
         "trade": "Cable"}]), actor_id=actor_id, actor_rank=60)
    [row] = out["rows"]
    assert row["errors"] == [] and row["action"] == "update", row
    assert "worker_role" not in row["diff"]


# ── bulk importers ───────────────────────────────────────────────────

async def test_bulk_workers_row_fails_on_client_person(db, seeded_user):
    """The workers import would grant `worker` to a matched client contact:
    that row fails with the reason, the rest preview as usual, and the
    commit refuses (the importer's all-or-nothing rule)."""
    acme = await _client(db)
    await _contact(db, acme, email="cc@test.example.com")
    rows = [{"first_name": "Cleo", "last_name": "Contact", "email": "cc@test.example.com"},
            {"first_name": "Nora", "last_name": "New", "email": "nora@test.example.com"}]
    out = await bi.preview_rows(db, bi.number_json_rows(rows), actor_id=seeded_user.id,
                                actor_rank=60)
    first, second = out["rows"]
    assert first["action"] == "error"
    assert first["errors"] == [CONFLICT_ROW_ERROR]
    assert CODE in CONFLICT_ROW_ERROR
    assert second["action"] == "create" and second["errors"] == []
    assert out["can_commit"] is False


async def test_assign_template_row_fails_on_client_person(db, seeded_user):
    """Assign workers from a template: a matched partner contact who is
    also a client contact can't become a worker; that row fails with the
    reason, and a plain partner contact still can."""
    from tests.test_assign_bulk_service import (
        cells,
        mk_job,
        mk_partner,
        mk_partner_contact,
        mk_site,
    )

    acme = await _client(db)
    job = await mk_job(db)
    partner = await mk_partner(db, "Vend Picked")
    site = await mk_site(db, "DC East")
    mixed = await mk_partner_contact(db, "Casey", "Contact", partner, email="casey@example.com")
    db.add(PersonRole(person_id=mixed.id, role="client_viewer", client_id=acme.id))
    await db.commit()
    plain = await mk_partner_contact(db, "Pat", "Plain", partner, email="pat@example.com")
    out = await ab.preview_rows(
        db, job.id, partner.id, site.id,
        [(2, cells("Casey", "Contact", email="casey@example.com")),
         (3, cells("Pat", "Plain", email="pat@example.com"))],
        actor_id=seeded_user.id, actor_rank=60)
    first, second = out["rows"]
    assert first["person_id"] == str(mixed.id)
    assert first["action"] == "error" and first["errors"] == [CONFLICT_ROW_ERROR]
    assert first["becomes_worker"] is False
    assert second["person_id"] == str(plain.id)
    assert second["action"] == "assign" and second["becomes_worker"] is True
    assert out["can_commit"] is False


# ── chips beside a worker role; the kiosk backstop ───────────────────

async def test_chips_refused_for_legacy_viewer_worker(client, seeded_user, db):
    """A viewer who also holds `worker` from before the rule can't be given
    chips (the kiosk would ignore them): 409, nothing written. Clearing
    chips (an empty set) still works."""
    from serversherpa.db.models import ClientContactGroup, ClientGroup

    acme = await _client(db)
    both = await _contact(db, acme, worker=True)
    g = ClientGroup(client_id=acme.id, name="Platform", name_key="platform")
    db.add(g)
    await db.commit()
    both_id, g_id, acme_id = both.id, g.id, acme.id
    admin = await login_admin(client, db, seeded_user)
    r = await client.patch(f"/clients/{acme_id}/contacts/{both_id}", headers=admin,
                           json={"group_ids": [str(g_id)]})
    assert r.status_code == 409, r.text
    assert _code(r) == CODE
    async with get_sessionmaker()() as s:
        assert list(await s.scalars(select(ClientContactGroup.group_id).where(
            ClientContactGroup.person_id == both_id))) == []
    r = await client.patch(f"/clients/{acme_id}/contacts/{both_id}", headers=admin,
                           json={"group_ids": []})
    assert r.status_code == 200, r.text
    assert await _active(db, both_id) == ["client_viewer", "worker"]


def _kiosk_calls(move_id, asset_id, other_id):
    """Every person-session kiosk route that hands out or touches roster,
    asset, container or truck data (or a key/password that would)."""
    m = str(move_id)
    a = str(asset_id)
    o = str(other_id)
    return [
        ("GET", f"/kiosk/sync/assets?initiative_id={m}", None),
        ("GET", f"/kiosk/sync/client-assets?initiative_id={m}", None),
        ("GET", f"/kiosk/sync/containers?initiative_id={m}", None),
        ("GET", f"/kiosk/sync/trucks?initiative_id={m}", None),
        ("GET", f"/kiosk/sync/label-templates?initiative_id={m}", None),
        ("GET", "/kiosk/setup-options", None),
        ("GET", "/kiosk/setup?serial=K-1", None),
        ("POST", "/kiosk/setup", {}),
        ("POST", "/kiosk/station-key", {}),
        ("GET", "/kiosk/edge/move-passwords?serial=K-1", None),
        ("GET", "/kiosk/assets/lookup?serial=K-1&q=sn", None),
        ("GET", f"/kiosk/assets/{a}?serial=K-1", None),
        ("GET", f"/kiosk/assets/{a}/scans?serial=K-1", None),
        ("POST", f"/kiosk/assets/{a}/rfid", {}),
        ("POST", "/kiosk/scans", {}),
        ("POST", f"/kiosk/containers/{o}/assets", {}),
        ("POST", f"/kiosk/trucks/{o}/containers", {}),
        ("GET", f"/kiosk/labels/bundle?initiative_id={m}&label_type=front", None),
    ]


async def _call(api, headers, method, url, body):
    if method == "GET":
        return await api.get(url, headers=headers)
    return await api.post(url, headers=headers, json=body)


async def _restricted_kiosk_person(db, api, s, how: str) -> dict:
    """A viewer limited to Platform who reaches kiosk:view `how`: the worker
    role written straight to the table (bypassing the guard), or a cloned
    role with kiosk:view that the role-mix rule doesn't know by name."""
    from serversherpa.db.models import Role, RolePermission
    from tests.client_groups_fixtures import client_user

    headers = await client_user(db, api, s.client.id, "client_viewer",
                                group_ids=[s.groups["Platform"].id],
                                email=f"rk-{how}@test.example.com")
    person_id = await db.scalar(select(Person.id).where(
        Person.email == f"rk-{how}@test.example.com"))
    if how == "worker":
        db.add(PersonRole(person_id=person_id, role="worker"))
    else:
        db.add(Role(name="field_hand", description="clone of worker", rank=10,
                    scope_anchor="self", is_system=False, label="Field hand",
                    color="c-green"))
        await db.flush()
        db.add(RolePermission(role="field_hand", resource="kiosk", action="view"))
        db.add(PersonRole(person_id=person_id, role="field_hand"))
    await db.commit()
    return headers


@pytest.mark.parametrize("how", ["worker", "cloned_role"])
async def test_restricted_person_with_kiosk_view_gets_403(client, seeded_user, db, how):
    """The backstop: a person with group limits who holds kiosk:view anyway
    (a legacy worker role, a cloned role) gets 403 `forbidden` from every
    kiosk route that would hand them roster or asset data."""
    from serversherpa.clientgroups import service as cg
    from tests.client_groups_fixtures import seed_grouped_client

    s = await seed_grouped_client(db)
    await cg.rematch_client(db, s.client.id)
    await db.commit()
    headers = await _restricted_kiosk_person(db, client, s, how)
    me = await client.get("/auth/me", headers=headers)
    assert me.json()["perms"]["kiosk"]["view"] is True, how
    import uuid as _uuid
    for method, url, body in _kiosk_calls(s.move.id, s.assets[0].id, _uuid.uuid4()):
        r = await _call(client, headers, method, url, body)
        assert r.status_code == 403, (how, method, url, r.text)
        assert _code(r) == "forbidden", (how, method, url, r.text)


async def test_unrestricted_kiosk_people_unchanged(client, seeded_user, db):
    """A legacy client+worker person with no limits (viewer, no chips) and a
    plain worker still sync the move."""
    from tests.client_groups_fixtures import client_user, seed_grouped_client
    from tests.test_status_values_write import _make

    s = await seed_grouped_client(db)
    legacy = await client_user(db, client, s.client.id, "client_viewer",
                               email="legacy@test.example.com")
    legacy_id = await db.scalar(select(Person.id).where(
        Person.email == "legacy@test.example.com"))
    db.add(PersonRole(person_id=legacy_id, role="worker"))
    await db.commit()
    worker = await _make(db, client, "worker", "plain-w@test.example.com")
    for headers in (legacy, worker):
        r = await client.get(f"/kiosk/sync/assets?initiative_id={s.move.id}", headers=headers)
        assert r.status_code == 200, r.text
        assert len(r.json()["assets"]) == 4
        r = await client.get("/kiosk/setup-options", headers=headers)
        assert r.status_code == 200, r.text
