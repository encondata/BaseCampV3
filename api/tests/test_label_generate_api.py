"""Generate Labels API: run create/list/get/cancel, preview, the
generated-labels list, and generation_rules validation on the template
CRUD. Complements test_label_generate_runner.py (worker/runner
internals, unaffected here) and test_labels_templates_api.py (the rest
of template CRUD) — this file is the surface the portal (Task 3) calls."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AuditLog, Client, Container, GeneratedLabel, Initiative, InitiativeAsset,
    LabelGenerationRun, LabelTemplate, LabelTemplateSite, LabelVocab, PermissionOverride,
    Person, Site,
)

from tests.test_initiatives_client_scope import client_login
from tests.test_sites_api import login
from tests.test_status_values_write import _make

# ── seeding helpers ──────────────────────────────────────────────────


async def _initiative(db, *, name=None, origin=None, destination=None, client=None,
                      status="planned", scheduled_start=None, archived=False):
    ini = Initiative(
        name=name or f"Move {uuid.uuid4().hex[:6]}", initiative_type="move", status=status,
        origin_site_id=origin.id if origin else None,
        destination_site_id=destination.id if destination else None,
        client_id=client.id if client else None, scheduled_start=scheduled_start,
        archived_at=datetime.now(UTC) if archived else None)
    db.add(ini)
    await db.commit()
    return ini


async def _asset_on(db, initiative, *, legacy_id, name="asset", serial="SN"):
    asset = Asset(legacy_id=legacy_id, name=name, serial_number=serial)
    db.add(asset)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=initiative.id, asset_id=asset.id))
    await db.commit()
    return asset


async def _template(db, label_type="top", *, site=None, code="{asset_id}"):
    tpl = LabelTemplate(name=f"tpl-{uuid.uuid4()}", label_type=label_type,
                        size_key="4x2", dpi_key="203", language_key="zpl",
                        kind="code", code=code)
    db.add(tpl)
    await db.flush()
    if site is not None:
        db.add(LabelTemplateSite(template_id=tpl.id, site_id=site.id))
    await db.commit()
    return tpl


def _run_payload(initiative, label_types, **over):
    body = {"initiative_id": str(initiative.id), "label_types": list(label_types)}
    body.update(over)
    return body


def _template_body(name="gr-tpl", **over):
    base = {"name": name, "label_type": "top", "size_key": "4x2", "dpi_key": "203",
            "language_key": "zpl", "kind": "code", "code": "{asset_id}"}
    base.update(over)
    return base


# ── create ───────────────────────────────────────────────────────────

async def test_create_run_202_shape(client, db, seeded_user):
    ini = await _initiative(db)
    await _asset_on(db, ini, legacy_id=1001)
    await _asset_on(db, ini, legacy_id=1002)
    # alice (the default `login(client)` persona) is `staff` — labels:view
    # only, no longer enough to create a run — so this and every other
    # create/cancel test below uses an `admin` persona instead.
    hdrs = await _make(db, client, "admin", "adm-shape@test.example.com")

    resp = await client.post("/labels/generate/runs", headers=hdrs,
                             json=_run_payload(ini, ["top"], notify=True))
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["status"] == "queued"
    assert body["initiative_id"] == str(ini.id)
    assert body["initiative_name"] == ini.name
    assert body["label_types"] == ["top"]
    assert body["notify"] is True
    assert body["regenerate_existing"] is False
    assert body["progress_pct"] == 0
    assert body["total"] == 0 and body["processed"] == 0
    assert body["requested_by_name"] == "R X"
    assert body["cancel_requested"] is False
    assert body["finished_at"] is None
    assert body["template_overrides"] == {}

    run = await db.get(LabelGenerationRun, uuid.UUID(body["id"]))
    assert run is not None and run.status == "queued"

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "label_generation_run", AuditLog.entity_id == body["id"],
        AuditLog.action == "create"))
    assert audit_row is not None
    assert audit_row.changes["label_types"] == {"from": [], "to": ["top"]}


async def test_create_run_422_empty_label_types(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-empty@test.example.com")

    resp = await client.post("/labels/generate/runs", headers=hdrs,
                             json=_run_payload(ini, []))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_label_types"
    assert resp.json()["detail"]["problems"] == []


async def test_create_run_404_unknown_or_archived_initiative(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm-404.ini@test.example.com")

    resp = await client.post("/labels/generate/runs", headers=hdrs,
                             json={"initiative_id": str(uuid.uuid4()), "label_types": ["top"]})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    archived = await _initiative(db, archived=True)
    resp = await client.post("/labels/generate/runs", headers=hdrs,
                             json=_run_payload(archived, ["top"]))
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "initiative_not_found"


async def test_create_run_422_unknown_label_types(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-unknown-type@test.example.com")

    resp = await client.post("/labels/generate/runs", headers=hdrs,
                             json=_run_payload(ini, ["not_a_type"]))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_label_types"
    assert resp.json()["detail"]["problems"] == ["not_a_type"]


async def test_create_run_409_when_one_already_active(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-active@test.example.com")

    first = await client.post("/labels/generate/runs", headers=hdrs,
                              json=_run_payload(ini, ["top"]))
    assert first.status_code == 202

    second = await client.post("/labels/generate/runs", headers=hdrs,
                               json=_run_payload(ini, ["front"]))
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "run_active"
    assert second.json()["detail"]["run_id"] == first.json()["id"]


# ── create with template overrides ───────────────────────────────────

async def test_create_run_with_template_override_201(client, db, seeded_user):
    ini = await _initiative(db)
    tpl = await _template(db, "top")
    hdrs = await _make(db, client, "admin", "adm-tpl-override@test.example.com")

    resp = await client.post("/labels/generate/runs", headers=hdrs,
                             json=_run_payload(ini, ["top"], templates={"top": str(tpl.id)}))
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["template_overrides"] == {"top": str(tpl.id)}

    run = await db.get(LabelGenerationRun, uuid.UUID(body["id"]))
    assert run.template_overrides == {"top": str(tpl.id)}


async def test_create_run_422_invalid_templates_key_not_in_label_types(client, db, seeded_user):
    ini = await _initiative(db)
    tpl = await _template(db, "top")
    hdrs = await _make(db, client, "admin", "adm-tpl-key@test.example.com")

    resp = await client.post(
        "/labels/generate/runs", headers=hdrs,
        json=_run_payload(ini, ["top"], templates={"rail": str(tpl.id)}))
    assert resp.status_code == 422
    body = resp.json()["detail"]
    assert body["code"] == "invalid_templates"
    assert body["problems"] == ["rail: not one of the run's label types"]


async def test_create_run_422_invalid_templates_wrong_type(client, db, seeded_user):
    ini = await _initiative(db)
    front_tpl = await _template(db, "front")
    hdrs = await _make(db, client, "admin", "adm-tpl-wrong-type@test.example.com")

    resp = await client.post(
        "/labels/generate/runs", headers=hdrs,
        json=_run_payload(ini, ["top"], templates={"top": str(front_tpl.id)}))
    assert resp.status_code == 422
    body = resp.json()["detail"]
    assert body["code"] == "invalid_templates"
    assert body["problems"] == ["top: template is a 'front' template"]


async def test_create_run_422_invalid_templates_inactive(client, db, seeded_user):
    ini = await _initiative(db)
    tpl = await _template(db, "top")
    tpl.is_active = False
    await db.commit()
    hdrs = await _make(db, client, "admin", "adm-tpl-inactive@test.example.com")

    resp = await client.post(
        "/labels/generate/runs", headers=hdrs,
        json=_run_payload(ini, ["top"], templates={"top": str(tpl.id)}))
    assert resp.status_code == 422
    body = resp.json()["detail"]
    assert body["code"] == "invalid_templates"
    assert body["problems"] == [f"top: template {tpl.id} is not active"]


# ── permission gate ──────────────────────────────────────────────────

async def test_generate_routes_require_labels_permissions(client, db, seeded_user):
    """`worker` holds no `labels` grant at all, so every generate-labels
    route (view-gated list/get/preview/generated, and the stricter
    add/change-gated create/cancel) is 403 for them."""
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-gl-setup@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=hdrs,
                                 json=_run_payload(ini, ["top"]))).json()

    worker = await _make(db, client, "worker", "w-gl@test.example.com")
    assert (await client.get("/labels/generate/runs", headers=worker)).status_code == 403
    assert (await client.get(f"/labels/generate/runs/{created['id']}",
                             headers=worker)).status_code == 403
    assert (await client.post("/labels/generate/runs", headers=worker,
                              json=_run_payload(ini, ["top"]))).status_code == 403
    assert (await client.post(f"/labels/generate/runs/{created['id']}/cancel",
                              headers=worker)).status_code == 403
    assert (await client.get(f"/labels/generate/preview?initiative_id={ini.id}",
                             headers=worker)).status_code == 403
    assert (await client.get("/labels/generated", headers=worker)).status_code == 403


async def test_create_run_403_for_labels_view_only(client, db, seeded_user):
    """`staff` holds `labels:view` only (defaults.py) — that used to be
    enough to create a run; it must now 403."""
    ini = await _initiative(db)
    staff = await _make(db, client, "staff", "staff-cr@test.example.com")
    resp = await client.post("/labels/generate/runs", headers=staff,
                             json=_run_payload(ini, ["top"]))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_create_run_202_for_labels_add(client, db, seeded_user):
    ini = await _initiative(db)
    admin = await _make(db, client, "admin", "adm-cr@test.example.com")
    resp = await client.post("/labels/generate/runs", headers=admin,
                             json=_run_payload(ini, ["top"]))
    assert resp.status_code == 202, resp.text


async def test_create_run_regenerate_existing_403_without_change(client, db, seeded_user):
    """A persona with `labels:add` but not `labels:change` — no seeded
    role combines the two that way, so build one from `staff` (view
    only) plus a permission override — may create a plain run but not
    one with `regenerate_existing`, which needs `labels:change`."""
    ini = await _initiative(db)
    add_only = await _make(db, client, "staff", "staff-add-only@test.example.com")
    person = await db.scalar(
        select(Person).where(Person.email == "staff-add-only@test.example.com"))
    db.add(PermissionOverride(person_id=person.id, resource="labels", action="add",
                              allow=True))
    await db.commit()

    resp = await client.post("/labels/generate/runs", headers=add_only,
                             json=_run_payload(ini, ["top"], regenerate_existing=True))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"

    resp = await client.post("/labels/generate/runs", headers=add_only,
                             json=_run_payload(ini, ["top"]))
    assert resp.status_code == 202, resp.text
    assert resp.json()["regenerate_existing"] is False


async def test_cancel_run_403_for_labels_view_only(client, db, seeded_user):
    ini = await _initiative(db)
    admin = await _make(db, client, "admin", "adm-cancel-view@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=admin,
                                 json=_run_payload(ini, ["top"]))).json()

    staff = await _make(db, client, "staff", "staff-cancel@test.example.com")
    resp = await client.post(f"/labels/generate/runs/{created['id']}/cancel", headers=staff)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_cancel_run_200_for_labels_change(client, db, seeded_user):
    ini = await _initiative(db)
    admin = await _make(db, client, "admin", "adm-cancel-change@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=admin,
                                 json=_run_payload(ini, ["top"]))).json()
    resp = await client.post(f"/labels/generate/runs/{created['id']}/cancel", headers=admin)
    assert resp.status_code == 200, resp.text


async def test_cancel_labels_change_is_unreachable_for_a_scoped_actor(client, db, seeded_user):
    """`_runs_query`'s scope leg (used by cancel and by list/get) only
    narrows for a non-global actor — but `labels` is hard-gated
    `visible_to={"global"}` (access/resources.py), a check the resolver
    applies BEFORE per-person overrides. So even a client-anchored actor
    handed a `labels:change` override stays 403, never reaching the
    scope-narrowed 404: no seeded or overridden role can produce the
    "same 404 for out-of-scope as for unknown" case the query defends
    against today. This pins that invariant — see the report for why a
    genuine out-of-scope 404 test isn't constructible with the current
    access model, matching `_runs_query`'s own "unreachable" comment."""
    client_row = Client(name="Own Co")
    db.add(client_row)
    await db.flush()
    ini = await _initiative(db, client=client_row)

    admin = await _make(db, client, "admin", "adm-cancel-hardgate@test.example.com")
    run = (await client.post("/labels/generate/runs", headers=admin,
                             json=_run_payload(ini, ["top"]))).json()

    hdrs = await client_login(db, client, client_row.id, role="client_owner",
                              email="co-cancel-hardgate@test.example.com")
    person = await db.scalar(
        select(Person).where(Person.email == "co-cancel-hardgate@test.example.com"))
    db.add(PermissionOverride(person_id=person.id, resource="labels", action="change",
                              allow=True))
    await db.commit()

    resp = await client.post(f"/labels/generate/runs/{run['id']}/cancel", headers=hdrs)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


# ── list / get ───────────────────────────────────────────────────────

async def test_list_and_get_run(client, db, seeded_user):
    ini = await _initiative(db)
    other = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-list-get@test.example.com")

    first = (await client.post("/labels/generate/runs", headers=hdrs,
                               json=_run_payload(ini, ["top"]))).json()
    # Backdate the first run's created_at so the two runs have an
    # unambiguous order — same-transaction timestamps can otherwise tie.
    run = await db.get(LabelGenerationRun, uuid.UUID(first["id"]))
    run.created_at = datetime.now(UTC) - timedelta(minutes=5)
    await db.commit()

    second = (await client.post("/labels/generate/runs", headers=hdrs,
                                json=_run_payload(other, ["top"]))).json()

    rows = (await client.get(f"/labels/generate/runs?initiative_id={ini.id}",
                             headers=hdrs)).json()
    assert [r["id"] for r in rows] == [first["id"]]

    rows = (await client.get("/labels/generate/runs", headers=hdrs)).json()
    assert [r["id"] for r in rows] == [second["id"], first["id"]]   # newest first

    got = await client.get(f"/labels/generate/runs/{first['id']}", headers=hdrs)
    assert got.status_code == 200 and got.json()["id"] == first["id"]

    resp = await client.get(f"/labels/generate/runs/{uuid.uuid4()}", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "run_not_found"


# ── cancel ───────────────────────────────────────────────────────────

async def test_cancel_queued_run_is_immediate(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-cancel-queued@test.example.com")
    run = (await client.post("/labels/generate/runs", headers=hdrs,
                             json=_run_payload(ini, ["top"]))).json()

    resp = await client.post(f"/labels/generate/runs/{run['id']}/cancel", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "canceled"
    assert body["finished_at"] is not None

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "label_generation_run", AuditLog.entity_id == run["id"],
        AuditLog.action == "cancel"))
    assert audit_row is not None
    assert audit_row.changes["status"] == {"from": "queued", "to": "canceled"}
    assert audit_row.changes["cancel_requested"] == {"from": False, "to": True}


async def test_cancel_running_run_sets_cancel_requested(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-cancel-running@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=hdrs,
                                 json=_run_payload(ini, ["top"]))).json()
    run = await db.get(LabelGenerationRun, uuid.UUID(created["id"]))
    run.status = "running"
    run.started_at = datetime.now(UTC)
    await db.commit()

    resp = await client.post(f"/labels/generate/runs/{run.id}/cancel", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "running"          # worker still owns the transition to canceled
    assert body["cancel_requested"] is True

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "label_generation_run", AuditLog.entity_id == str(run.id),
        AuditLog.action == "cancel"))
    assert audit_row is not None
    assert "status" not in audit_row.changes     # status never changed on this path
    assert audit_row.changes["cancel_requested"] == {"from": False, "to": True}


async def test_cancel_running_run_already_requested_is_a_no_op(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-cancel-noop@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=hdrs,
                                 json=_run_payload(ini, ["top"]))).json()
    run = await db.get(LabelGenerationRun, uuid.UUID(created["id"]))
    run.status = "running"
    run.started_at = datetime.now(UTC)
    await db.commit()

    first = await client.post(f"/labels/generate/runs/{run.id}/cancel", headers=hdrs)
    assert first.status_code == 200

    second = await client.post(f"/labels/generate/runs/{run.id}/cancel", headers=hdrs)
    assert second.status_code == 200
    body = second.json()
    assert body["status"] == "running" and body["cancel_requested"] is True

    # The second cancel changed nothing (cancel_requested was already True)
    # — it must not write a fresh audit row claiming another False->True
    # transition that never happened.
    audit_rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "label_generation_run", AuditLog.entity_id == str(run.id),
        AuditLog.action == "cancel"))).all()
    assert len(audit_rows) == 1


async def test_cancel_finished_run_is_409(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-cancel-409@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=hdrs,
                                 json=_run_payload(ini, ["top"]))).json()
    run = await db.get(LabelGenerationRun, uuid.UUID(created["id"]))
    run.status = "completed"
    run.finished_at = datetime.now(UTC)
    await db.commit()

    resp = await client.post(f"/labels/generate/runs/{run.id}/cancel", headers=hdrs)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "run_not_cancelable"

    resp = await client.post(f"/labels/generate/runs/{uuid.uuid4()}/cancel", headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "run_not_found"


# ── preview ──────────────────────────────────────────────────────────

async def test_preview_shape_with_site_and_global_templates(client, db, seeded_user):
    origin = Site(name="NAP7")
    destination = Site(name="NAP11")
    client_row = Client(name="Acme Co")
    db.add_all([origin, destination, client_row])
    await db.flush()
    ini = await _initiative(db, origin=origin, destination=destination, client=client_row,
                            scheduled_start=datetime(2026, 10, 1, tzinfo=UTC))
    a1 = await _asset_on(db, ini, legacy_id=2001)
    a2 = await _asset_on(db, ini, legacy_id=2002)

    top_tpl = await _template(db, "top", site=destination)      # site-scoped
    front_tpl = await _template(db, "front")                    # global
    assert front_tpl.label_type == "front"

    # a1: current (matches top_tpl exactly); a2: stale (version mismatch —
    # simulates a template edit that happened since a2's label generated).
    db.add(GeneratedLabel(entity_type="asset", entity_id=a1.id, initiative_id=ini.id,
                          label_type="top", template_id=top_tpl.id,
                          template_version=top_tpl.version, language_key="zpl",
                          dpi_key="203", size_key="4x2", code="X"))
    db.add(GeneratedLabel(entity_type="asset", entity_id=a2.id, initiative_id=ini.id,
                          label_type="top", template_id=top_tpl.id,
                          template_version=top_tpl.version + 1, language_key="zpl",
                          dpi_key="203", size_key="4x2", code="Y"))
    await db.commit()

    hdrs = await login(client)
    resp = await client.get(f"/labels/generate/preview?initiative_id={ini.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["initiative"]["id"] == str(ini.id)
    assert body["initiative"]["client_name"] == "Acme Co"
    assert body["initiative"]["source_name"] == "NAP7"
    assert body["initiative"]["destination_name"] == "NAP11"
    assert body["initiative"]["asset_count"] == 2
    assert body["initiative"]["status"] == "planned"
    assert body["active_run_id"] is None

    types = {t["key"]: t for t in body["types"]}
    # Phase two: the container types are active vocab like any other, so the
    # preview offers them alongside the asset/device types.
    assert set(types) == {"top", "front", "rail", "container", "container_info"}
    assert types["top"]["template"]["id"] == str(top_tpl.id)
    assert types["top"]["template"]["scope"] == "site"
    assert types["top"]["current"] == 1
    assert types["top"]["stale"] == 1
    assert [c["id"] for c in types["top"]["candidates"]] == [str(top_tpl.id)]
    assert types["top"]["candidates"][0]["scope"] == "site"
    assert types["top"]["candidates"][0]["site_names"] == []
    assert types["front"]["template"]["id"] == str(front_tpl.id)
    assert types["front"]["template"]["scope"] == "global"
    assert types["front"]["current"] == 0 and types["front"]["stale"] == 0
    assert [c["id"] for c in types["front"]["candidates"]] == [str(front_tpl.id)]
    assert types["front"]["candidates"][0]["scope"] == "global"
    assert types["rail"]["template"] is None
    assert types["rail"]["current"] == 0 and types["rail"]["stale"] == 0
    assert types["rail"]["candidates"] == []


async def test_preview_other_only_type_has_candidates_but_no_auto_match(client, db, seeded_user):
    """A type whose only active template is linked to a site OTHER than
    the initiative's origin/destination has candidates (so the portal
    can still offer a picker) but no auto-match — template: null."""
    destination = Site(name="NAP11")
    other_site = Site(name="NAP-Other")
    db.add_all([destination, other_site])
    await db.flush()
    ini = await _initiative(db, destination=destination)
    other_tpl = await _template(db, "rail", site=other_site)

    hdrs = await login(client)
    resp = await client.get(f"/labels/generate/preview?initiative_id={ini.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    types = {t["key"]: t for t in resp.json()["types"]}

    assert types["rail"]["template"] is None
    candidates = types["rail"]["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["id"] == str(other_tpl.id)
    assert candidates[0]["scope"] == "other"
    assert candidates[0]["site_names"] == ["NAP-Other"]


async def test_the_generate_preview_offers_the_container_types(client, db, seeded_user):
    """Phase two: the runner walks containers, so the gate is open — the
    preview offers EVERY active container type, not just the Avery
    `container` one. Migration 0066 seeds an active `container_info` type
    too, and both must show up here for the portal's type picker."""
    ini = await _initiative(db)
    for key, label in (("container", "Container Label"),
                       ("container_info", "Container Info Label")):
        if await db.get(LabelVocab, ("type", key)) is None:
            db.add(LabelVocab(kind="type", key=key, label=label, is_active=True))
    await db.commit()

    hdrs = await login(client)
    resp = await client.get(f"/labels/generate/preview?initiative_id={ini.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    keys = {t["key"] for t in resp.json()["types"]}
    assert {"container", "container_info"} <= keys, keys


async def test_the_preview_counts_containers_for_a_container_type(client, db, seeded_user):
    """A container type's current/stale counts must come from container
    labels, not from the asset count — before phase two this route
    hardcoded `entity_type == "asset"` for every type's count, so a
    container type's numbers were always zero."""
    ini = await _initiative(db)
    top_tpl = await _template(db, "top")
    container_tpl = await _template(db, "container")

    a1 = await _asset_on(db, ini, legacy_id=4001)
    a2 = await _asset_on(db, ini, legacy_id=4002)
    a3 = await _asset_on(db, ini, legacy_id=4003)
    for asset in (a1, a2, a3):
        db.add(GeneratedLabel(entity_type="asset", entity_id=asset.id, initiative_id=ini.id,
                              label_type="top", template_id=top_tpl.id,
                              template_version=top_tpl.version, language_key="zpl",
                              dpi_key="203", size_key="4x2", code="X"))

    c1 = Container(name="crate-1", initiative_id=ini.id, label_tag="priority")
    c2 = Container(name="crate-2", initiative_id=ini.id, label_tag="priority")
    db.add_all([c1, c2])
    await db.flush()
    for container in (c1, c2):
        db.add(GeneratedLabel(entity_type="container", entity_id=container.id,
                              initiative_id=ini.id, label_type="container",
                              template_id=container_tpl.id,
                              template_version=container_tpl.version, language_key="zpl",
                              dpi_key="203", size_key="4x2", code="Y"))
    await db.commit()

    hdrs = await login(client)
    resp = await client.get(f"/labels/generate/preview?initiative_id={ini.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    by_key = {t["key"]: t for t in resp.json()["types"]}
    assert by_key["container"]["current"] == 2      # two containers labeled
    assert by_key["top"]["current"] == 3            # three assets labeled


async def test_preview_404_unknown_initiative(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get(f"/labels/generate/preview?initiative_id={uuid.uuid4()}",
                            headers=hdrs)
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"


async def test_preview_reports_active_run_id(client, db, seeded_user):
    ini = await _initiative(db)
    hdrs = await _make(db, client, "admin", "adm-preview-active@test.example.com")
    created = (await client.post("/labels/generate/runs", headers=hdrs,
                                 json=_run_payload(ini, ["top"]))).json()

    resp = await client.get(f"/labels/generate/preview?initiative_id={ini.id}", headers=hdrs)
    assert resp.json()["active_run_id"] == created["id"]


# ── generated labels list ────────────────────────────────────────────

async def test_generated_list_filters(client, db, seeded_user):
    ini = await _initiative(db)
    other_ini = await _initiative(db)
    a1 = await _asset_on(db, ini, legacy_id=3001, name="core-sw-1", serial="SN-1")
    tpl = await _template(db, "top")

    db.add(GeneratedLabel(entity_type="asset", entity_id=a1.id, initiative_id=ini.id,
                          label_type="top", template_id=tpl.id, template_version=tpl.version,
                          language_key="zpl", dpi_key="203", size_key="4x2", code="^XA^XZ"))
    db.add(GeneratedLabel(entity_type="asset", entity_id=a1.id, initiative_id=other_ini.id,
                          label_type="top", template_id=tpl.id, template_version=tpl.version,
                          language_key="zpl", dpi_key="203", size_key="4x2", code="^XA2^XZ"))
    await db.commit()

    hdrs = await login(client)
    rows = (await client.get(f"/labels/generated?initiative_id={ini.id}", headers=hdrs)).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["asset_id"] == 3001
    assert row["serial_number"] == "SN-1"
    assert row["name"] == "core-sw-1"
    assert row["entity_type"] == "asset" and row["entity_id"] == str(a1.id)
    assert row["label_type"] == "top"
    assert row["template_name"] == tpl.name
    assert row["template_version"] == tpl.version
    assert row["code"] == "^XA^XZ"
    assert row["stale"] is False

    rows = (await client.get(f"/labels/generated?initiative_id={ini.id}&label_type=front",
                             headers=hdrs)).json()
    assert rows == []

    rows = (await client.get(f"/labels/generated?entity_id={a1.id}", headers=hdrs)).json()
    assert len(rows) == 2


# ── generation_rules validation (template create/PATCH) ─────────────

async def test_generation_rules_validation_on_create(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm-gr@test.example.com")

    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_template_body(generation_rules={
                                 "destination": {"0": "bad_pos"},
                                 "source": {"1": "Bad-Token!"},
                                 "length_limits": {"asset_name": -5},
                                 "unexpected": {}}))
    assert resp.status_code == 422
    body = resp.json()["detail"]
    assert body["code"] == "bad_generation_rules"
    problems = body["problems"]
    # Four independent violations bundled into one payload — pins each
    # individual rule AND that problems accumulate rather than stopping
    # at the first hit (a validator that returns early on the first
    # problem would leave the other three assertions failing here).
    assert any("unknown keys" in p and "unexpected" in p for p in problems), problems
    assert any("destination position" in p and "'0'" in p for p in problems), problems
    assert any("token" in p and "Bad-Token!" in p for p in problems), problems
    assert any("length_limits.asset_name" in p and "positive integer" in p
              for p in problems), problems
    assert len(problems) == 4

    good = {"destination": {"1": "nap", "2": "row"}, "source": {"1": "dc"},
            "length_limits": {"asset_name": 20}}
    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_template_body("gr-tpl-2", generation_rules=good))
    assert resp.status_code == 201, resp.text
    assert resp.json()["generation_rules"] == good


async def test_generation_rules_validation_rejects_a_bad_token_alone(client, db, seeded_user):
    """Isolates the token-shape check from the other three rules — a
    single violation must produce exactly one problem, and a validator
    that stopped checking tokens entirely (e.g. the regex weakened to
    `isinstance(name, str)`) would let this payload through as 201."""
    hdrs = await _make(db, client, "admin", "adm-gr-token@test.example.com")

    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_template_body(
                                 "gr-tpl-token", generation_rules={"source": {"1": "Bad Token"}}))
    assert resp.status_code == 422
    problems = resp.json()["detail"]["problems"]
    assert len(problems) == 1
    assert "token" in problems[0] and "Bad Token" in problems[0]


async def test_generation_rules_default_is_empty_dict(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm-gr3@test.example.com")
    resp = await client.post("/labels/templates", headers=hdrs, json=_template_body("gr-tpl-4"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["generation_rules"] == {}


async def test_generation_rules_validation_on_patch(client, db, seeded_user):
    hdrs = await _make(db, client, "admin", "adm-gr2@test.example.com")
    tid = (await client.post("/labels/templates", headers=hdrs,
                             json=_template_body("gr-tpl-5"))).json()["id"]

    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"generation_rules": {"length_limits": {"x": "not-an-int"}}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_generation_rules"

    good = {"source": {"1": "dc", "2": "row"}}
    resp = await client.patch(f"/labels/templates/{tid}", headers=hdrs,
                              json={"generation_rules": good})
    assert resp.status_code == 200, resp.text
    assert resp.json()["generation_rules"] == good
    assert resp.json()["version"] == 2


async def test_generation_rules_null_side_is_rejected(client, db, seeded_user):
    """A JSON `null` for a side/length_limits is a present-but-malformed
    value, not "not provided" — it must 422, not silently store as a
    JSON null (which values.py would tolerate at generation time but the
    portal's editor never sends)."""
    hdrs = await _make(db, client, "admin", "adm-gr-null@test.example.com")

    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_template_body("gr-tpl-null-dest",
                                                  generation_rules={"destination": None}))
    assert resp.status_code == 422
    problems = resp.json()["detail"]["problems"]
    assert any(p == "destination must be an object" for p in problems), problems

    resp = await client.post("/labels/templates", headers=hdrs,
                             json=_template_body("gr-tpl-null-limits",
                                                  generation_rules={"length_limits": None}))
    assert resp.status_code == 422
    problems = resp.json()["detail"]["problems"]
    assert any(p == "length_limits must be an object" for p in problems), problems
