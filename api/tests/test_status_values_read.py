"""Reads follow the owning entity's view permission; the unfiltered listing
is developer-only because it spans every record type."""

from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password
from serversherpa.config import get_settings
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _make(db, client, role, email):
    p = Person(first_name="R", last_name=role.title(), email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(
        person_id=p.id, email=email,
        password_hash=hash_password(
            PW, pepper=get_settings().password_pepper.get_secret_value())))
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return await login(client, email=email)


async def test_staff_reads_site_statuses_by_record_type(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/status-values?record_type=site", headers=hdrs)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["key"] for r in rows] == [
        "active", "planned", "inactive", "decommissioned"]
    assert rows[0]["usage_count"] is None      # counts are devtools-only


async def test_entity_scoped_read_omits_inactive(client, db, seeded_user):
    dev = await _make(db, client, "developer", "dev1@test.example.com")
    await client.patch("/status-values/site/planned", headers=dev,
                       json={"is_active": False})
    hdrs = await login(client)
    rows = (await client.get("/status-values?record_type=site",
                             headers=hdrs)).json()
    assert [r["key"] for r in rows] == ["active", "inactive", "decommissioned"]


async def test_actor_without_the_entity_view_permission_is_refused(
        client, db, seeded_user):
    """The entity-scoped read is gated on the record type's OWN resource.
    A worker holds no `sites` grant at all (defaults.py: worker gets only
    dashboard/workers), so it must not reach the site vocabulary — delete
    the `can(rt.resource, "view")` check and this turns 200. Mirrors
    test_sites_api.test_worker_has_no_sites_access for /sites."""
    hdrs = await _make(db, client, "worker", "wrk1@test.example.com")
    resp = await client.get("/status-values?record_type=site", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_gate_resolves_per_record_type_not_hardcoded_to_sites(
        client, db, seeded_user):
    """Same actor as the test above — refused on ?record_type=site, allowed
    on ?record_type=worker, because `worker` grants workers:view. One actor
    across both directions pins the gate to rt.resource: a check hardcoded
    to any single resource cannot satisfy both halves."""
    hdrs = await _make(db, client, "worker", "wrk2@test.example.com")
    resp = await client.get("/status-values?record_type=worker", headers=hdrs)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["key"] for r in rows] == ["active", "standby", "blacklist"]
    assert rows[0]["usage_count"] is None      # counts stay devtools-only

    assert (await client.get("/status-values?record_type=site",
                             headers=hdrs)).status_code == 403


async def test_staff_refused_the_unfiltered_listing(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/status-values", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_developer_reads_everything_with_counts(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev2@test.example.com")
    resp = await client.get("/status-values", headers=hdrs)
    assert resp.status_code == 200
    rows = resp.json()
    assert {r["record_type"] for r in rows} == {
        "site", "worker", "asset", "container", "container_type",
        "initiative", "initiative_type", "initiative_sub_type",
        "initiative_work_type", "shipping_type", "partner_type",
        "scan", "processed_scan", "time_entry"}
    active_site = next(
        r for r in rows if r["record_type"] == "site" and r["key"] == "active")
    assert active_site["usage_count"] == 0


async def test_usage_count_reflects_referencing_rows(client, db, seeded_user):
    hdrs = await _make(db, client, "developer", "dev3@test.example.com")
    staff = await login(client)
    await client.post("/sites", headers=staff,
                      json={"name": "Counted Site", "status": "planned"})
    rows = (await client.get("/status-values", headers=hdrs)).json()
    planned = next(
        r for r in rows if r["record_type"] == "site" and r["key"] == "planned")
    assert planned["usage_count"] == 1


async def test_unknown_record_type_is_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/status-values?record_type=invoice", headers=hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_record_type"


async def test_every_row_includes_progress_weight(client, db, seeded_user):
    """Read schemas must carry the field on every record type — null where
    it is unset (everything but the asset workflow statuses)."""
    hdrs = await login(client)
    resp = await client.get("/status-values?record_type=site", headers=hdrs)
    assert resp.status_code == 200
    rows = resp.json()
    assert all("progress_weight" in r for r in rows)
    active = next(r for r in rows if r["key"] == "active")
    assert active["progress_weight"] is None


async def test_asset_reads_carry_seeded_weights(client, db, seeded_user):
    """Spot-checks a live weighted, a zero weight, an excluded (null)
    workflow status, and a null lifecycle status from the merged asset
    vocabulary, straight off the wire."""
    dev = await _make(db, client, "developer", "devweights@test.example.com")
    rows = (await client.get("/status-values?record_type=asset",
                             headers=dev)).json()
    by_key = {r["key"]: r["progress_weight"] for r in rows}
    assert by_key["loaded_in_system"] == 0
    assert by_key["complete"] == 100
    assert by_key["in_transit"] == 50
    assert by_key["historical"] is None
    assert by_key["active"] is None
    assert by_key["staged"] == 69
    assert by_key["location_collision"] is None


async def test_asset_usage_counts_span_assets_and_initiative_assets(
        client, db, seeded_user):
    """The merged vocabulary is referenced from assets.status AND
    initiative_assets.status — the Variables page count must be the sum,
    or delete-protection undercounts move usage."""
    from serversherpa.db.models import Asset, Initiative, InitiativeAsset

    hdrs = await _make(db, client, "developer", "devusage@test.example.com")
    a1 = Asset(serial_number="USG-1", name="usage-1", status="staged")
    a2 = Asset(serial_number="USG-2", name="usage-2")
    move = Initiative(name="Usage Move", initiative_type="move")
    db.add_all([a1, a2, move])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=move.id, asset_id=a2.id,
                           status="staged"))
    await db.commit()

    rows = (await client.get("/status-values", headers=hdrs)).json()
    staged = next(r for r in rows
                  if r["record_type"] == "asset" and r["key"] == "staged")
    assert staged["usage_count"] == 2
