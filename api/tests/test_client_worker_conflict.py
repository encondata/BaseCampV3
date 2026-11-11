"""Client groups: one person never holds a client tier and the worker role at
once (the worker role's kiosk:view would bypass group limits through the
kiosk sync routes). Every grant path refuses with 409
`client_worker_conflict`; a bulk import fails that row with the reason.
Combinations that already exist are never revoked.

Spec: docs/superpowers/specs/2026-11-10-client-groups-design.md (Answers to
the open questions, item 4)"""
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
