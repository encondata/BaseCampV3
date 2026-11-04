"""Company notification settings: GET/PUT /notifications/settings (the switches
a person follows until they change their own, and the notification types an
admin marked critical) and the pure rules in notifications/company.py.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (sections 2 and 5)"""

import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from serversherpa.access.resolver import AccessInfo
from serversherpa.api.deps import AuthContext
from serversherpa.db.models import AuditLog, PermissionOverride, Role, SystemConfig
from serversherpa.notifications.kinds import KINDS
from tests.test_sites_api import login
from tests.test_status_values_write import _make

SETTINGS = "/notifications/settings"
CONFIGURABLE = ("approvals", "reports", "wiki", "learning", "initiatives", "plans", "trucks",
                "devices", "status_rules", "bulk_actions")
ON_ON = {"inbox": True, "email": True}


def _code(resp):
    """The error's `code`; the raw detail for an answer that has none (a 404)."""
    detail = resp.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else detail


def _by_kind(body):
    return {k["kind"]: k for k in body["kinds"]}


async def _admin(db, client):
    """A global admin (rank 60): the lowest rank the Defaults tab accepts."""
    return await _make(db, client, "admin", "admin@test.example.com")


async def _put(client, hdrs, **body):
    return await client.put(SETTINGS, headers=hdrs, json=body)


async def _get(client, hdrs):
    resp = await client.get(SETTINGS, headers=hdrs)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _audits(db):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.action == "notifications_config_update"))).all()


# ── GET ─────────────────────────────────────────────────────────────

async def test_settings_out_of_the_box(client, seeded_user):
    hdrs = await login(client)
    body = await _get(client, hdrs)

    assert body["defaults"] == {category: ON_ON for category in CONFIGURABLE}
    assert body["critical_kinds"] == []

    # every registered kind, in registry order, with the registry's flags
    assert [k["kind"] for k in body["kinds"]] == list(KINDS)
    for entry in body["kinds"]:
        info = KINDS[entry["kind"]]
        assert (entry["label"], entry["category"], entry["email"], entry["owner_always"],
                entry["locked"]) == (info.label, info.category, info.email,
                                     info.owner_always, info.category == "security")
        assert (entry["watchable"], entry["everywhere"], entry["reaches"]) == (
            info.watchable, info.everywhere, list(info.reaches))
    kinds = _by_kind(body)
    # what a watch can follow: the two status changes, Device offline and Status rule
    # matched, on the things they reach (a rule's notice never everywhere)
    flags = {kind: (entry["watchable"], entry["everywhere"], entry["reaches"])
             for kind, entry in kinds.items()}
    assert flags["truck_status_changed"] == (True, True, ["truck", "initiative", "site"])
    assert flags["initiative_status_changed"] == (True, True, ["initiative", "site"])
    assert flags["device_offline"] == (True, True, ["device", "site", "initiative"])
    assert flags["status_rule_matched"] == (True, False, ["initiative", "site"])
    assert kinds["status_rule_matched"]["category"] == "status_rules"
    assert [kind for kind, (watchable, _, _) in flags.items() if watchable] == [
        "initiative_status_changed", "truck_status_changed", "device_offline",
        "status_rule_matched"]
    assert flags["report_ready"] == (False, False, [])
    # the bulk action notices go to whoever started the job: nobody watches for them
    assert flags["bulk_action_finished"] == (False, False, [])
    assert flags["bulk_action_failed"] == (False, False, [])
    assert (kinds["bulk_action_finished"]["category"], kinds["bulk_action_failed"]["category"]) \
        == ("bulk_actions", "bulk_actions")
    assert (kinds["password_expiring"]["critical"], kinds["password_expiring"]["locked"]) \
        == (True, True)
    assert (kinds["report_ready"]["critical"], kinds["report_ready"]["locked"]) \
        == (False, False)
    assert (kinds["password_reset_request"]["email"],
            kinds["password_reset_request"]["critical"]) == (False, False)


async def test_settings_need_a_signed_in_user(client):
    assert (await client.get(SETTINGS)).status_code == 401
    assert (await client.put(SETTINGS, json={})).status_code == 401


# ── PUT: who may change it ──────────────────────────────────────────

async def test_put_requires_global_admin(client, db, seeded_user):
    staff = await login(client)
    body = {"defaults": {"wiki": {"inbox": True, "email": False}}}

    # staff (rank 40) holds no notifications permission at all
    assert (await client.put(SETTINGS, headers=staff, json=body)).status_code == 403

    # handed notifications:change directly, staff passes the permission check
    # (the requests list is gated by it) and is still refused on rank
    db.add(PermissionOverride(person_id=seeded_user.id, resource="notifications",
                              action="change", allow=True))
    await db.commit()
    assert (await client.get("/notifications/requests", headers=staff)).status_code == 200
    resp = await client.put(SETTINGS, headers=staff, json=body)
    assert (resp.status_code, resp.json()["detail"]) == (403, {"code": "forbidden"})

    # an admin role anchored to a client is refused (today the notifications
    # resource is hidden from client anchors altogether, so the permission
    # check answers first; test_ensure_admin_* pins the helper's own scope rule)
    db.add(Role(name="client_rank_admin", description="test-only", rank=60,
                scope_anchor="client"))
    await db.commit()
    scoped = await _make(db, client, "client_rank_admin", "client-admin@test.example.com")
    resp = await client.put(SETTINGS, headers=scoped, json=body)
    assert (resp.status_code, resp.json()["detail"]) == (403, {"code": "forbidden"})

    # a global admin may
    admin = await _admin(db, client)
    resp = await client.put(SETTINGS, headers=admin, json=body)
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize("is_global,max_rank,allowed", [
    (True, 60, True), (True, 80, True), (True, 100, True), (True, 59, False),
    (False, 60, False), (False, 100, False),
])
def test_ensure_admin_needs_global_access_and_rank_60(is_global, max_rank, allowed):
    from serversherpa.api.deps import ensure_admin

    actor = AuthContext(person=None, account=None, roles=[], session=None,
                        access=AccessInfo(max_rank=max_rank, is_global=is_global))
    if allowed:
        ensure_admin(actor)
        return
    with pytest.raises(HTTPException) as caught:
        ensure_admin(actor)
    assert (caught.value.status_code, caught.value.detail) == (403, {"code": "forbidden"})


async def test_put_blocked_in_read_only_mode(client, db, seeded_user):
    super_admin = await _make(db, client, "super_admin", "sa@test.example.com")
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=super_admin,
                             json={"read_only": True})).status_code == 200

    resp = await _put(client, admin, defaults={"wiki": {"inbox": True, "email": False}})
    assert resp.status_code == 423, resp.text
    assert _code(resp) == "read_only_mode"
    # nothing was saved; reading is not frozen
    assert (await _get(client, admin))["defaults"]["wiki"] == ON_ON
    assert await _audits(db) == []


# ── PUT: defaults ───────────────────────────────────────────────────

async def test_put_merges_defaults_per_category(client, db, seeded_user):
    admin = await _admin(db, client)

    resp = await _put(client, admin, defaults={"wiki": {"inbox": True, "email": False}})
    assert resp.status_code == 200, resp.text
    expected = {**{c: ON_ON for c in CONFIGURABLE}, "wiki": {"inbox": True, "email": False}}
    assert resp.json()["defaults"] == expected         # the PUT answers with the whole settings
    assert (await _get(client, admin))["defaults"] == expected

    # the stored section holds every category, and one audit row says what changed
    stored = (await db.get(SystemConfig, "notifications")).data
    assert stored == {"defaults": expected, "critical_kinds": []}
    (row,) = await _audits(db)
    assert (row.entity_type, row.entity_id) == ("system", "notifications")
    assert row.changes == {"defaults": {"from": {c: ON_ON for c in CONFIGURABLE},
                                        "to": expected}}

    # a later PUT for another category keeps the first change
    resp = await _put(client, admin, defaults={"approvals": {"inbox": False, "email": False}})
    assert resp.status_code == 200, resp.text
    assert (await _get(client, admin))["defaults"] == {
        **expected, "approvals": {"inbox": False, "email": False}}
    assert len(await _audits(db)) == 2

    # saving what is already stored changes nothing and is not audited
    assert (await _put(client, admin, defaults={"wiki": {"inbox": True, "email": False}})
            ).status_code == 200
    assert len(await _audits(db)) == 2


async def test_put_sets_defaults_for_initiatives_trucks_and_devices(client, db, seeded_user):
    """The two status categories and Devices are configurable like the rest."""
    admin = await _admin(db, client)
    resp = await _put(client, admin, defaults={"initiatives": {"inbox": True, "email": False},
                                               "trucks": {"inbox": False, "email": False},
                                               "devices": {"inbox": True, "email": False}})
    assert resp.status_code == 200, resp.text
    expected = {**{c: ON_ON for c in CONFIGURABLE}, "initiatives": {"inbox": True, "email": False},
                "trucks": {"inbox": False, "email": False},
                "devices": {"inbox": True, "email": False}}
    assert resp.json()["defaults"] == expected
    assert (await _get(client, admin))["defaults"] == expected
    assert (await db.get(SystemConfig, "notifications")).data["defaults"] == expected


async def test_put_sets_the_bulk_actions_default(client, db, seeded_user):
    """Bulk actions is configurable like the rest: on and on until an admin says otherwise."""
    admin = await _admin(db, client)
    assert (await _get(client, admin))["defaults"]["bulk_actions"] == ON_ON
    resp = await _put(client, admin, defaults={"bulk_actions": {"inbox": True, "email": False}})
    assert resp.status_code == 200, resp.text
    expected = {**{c: ON_ON for c in CONFIGURABLE}, "bulk_actions": {"inbox": True, "email": False}}
    assert resp.json()["defaults"] == expected
    assert (await db.get(SystemConfig, "notifications")).data["defaults"] == expected


async def test_put_sets_the_status_rules_default(client, db, seeded_user):
    """Status rules is configurable like the rest: on and on until an admin says otherwise."""
    admin = await _admin(db, client)
    assert (await _get(client, admin))["defaults"]["status_rules"] == ON_ON
    resp = await _put(client, admin, defaults={"status_rules": {"inbox": True, "email": False}})
    assert resp.status_code == 200, resp.text
    expected = {**{c: ON_ON for c in CONFIGURABLE}, "status_rules": {"inbox": True, "email": False}}
    assert resp.json()["defaults"] == expected
    assert (await db.get(SystemConfig, "notifications")).data["defaults"] == expected


async def test_put_waits_for_a_concurrent_save_and_keeps_both(client, db, seeded_user):
    """A partial save is read-merge-write. While another save holds the row (it
    has read it and not yet written) a second one waits, then merges onto what
    the first wrote: both categories survive."""
    admin = await _admin(db, client)
    assert (await _put(client, admin)).status_code == 200      # the row exists now

    row = await db.get(SystemConfig, "notifications", with_for_update=True,
                       populate_existing=True)                  # the other save, mid-flight
    task = asyncio.create_task(
        _put(client, admin, defaults={"reports": {"inbox": False, "email": False}}))
    await asyncio.sleep(0.5)
    assert not task.done()                                      # waiting on the row lock
    row.data = {**row.data, "defaults": {**row.data["defaults"],
                                         "wiki": {"inbox": True, "email": False}}}
    await db.commit()                                           # the other save lands
    resp = await asyncio.wait_for(task, 10)

    assert resp.status_code == 200, resp.text
    assert resp.json()["defaults"] == {
        "approvals": ON_ON, "reports": {"inbox": False, "email": False},
        "wiki": {"inbox": True, "email": False}, "learning": ON_ON,
        "initiatives": ON_ON, "plans": ON_ON, "trucks": ON_ON, "devices": ON_ON,
        "status_rules": ON_ON, "bulk_actions": ON_ON}


async def test_put_rejects_bad_categories(client, db, seeded_user):
    admin = await _admin(db, client)
    for category in ("security", "nope"):
        resp = await _put(client, admin, defaults={category: {"inbox": False, "email": False}})
        assert (resp.status_code, _code(resp)) == (422, "invalid_category"), category

    # one bad key sinks the whole request: the good one beside it is not applied
    resp = await _put(client, admin, defaults={"wiki": {"inbox": False, "email": False},
                                               "nope": ON_ON})
    assert (resp.status_code, _code(resp)) == (422, "invalid_category")
    assert (await _get(client, admin))["defaults"]["wiki"] == ON_ON
    assert await _audits(db) == []


async def test_put_rejects_unknown_keys_and_half_a_pair(client, db, seeded_user):
    admin = await _admin(db, client)
    assert (await _put(client, admin, mystery=True)).status_code == 422
    assert (await _put(client, admin, defaults={"wiki": {"email": False}})).status_code == 422
    assert await _audits(db) == []


# ── PUT: critical kinds ─────────────────────────────────────────────

async def test_put_critical_kinds(client, db, seeded_user):
    admin = await _admin(db, client)

    resp = await _put(client, admin, critical_kinds=["report_failed", "report_failed"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["critical_kinds"] == ["report_failed"]
    body = await _get(client, admin)
    assert body["critical_kinds"] == ["report_failed"]
    assert _by_kind(body)["report_failed"]["critical"] is True
    assert _by_kind(body)["report_ready"]["critical"] is False
    (row,) = await _audits(db)
    assert row.changes == {"critical_kinds": {"from": [], "to": ["report_failed"]}}

    # the list is replaced, kept in registry order, and the defaults are untouched
    await _put(client, admin, defaults={"wiki": {"inbox": True, "email": False}})
    resp = await _put(client, admin, critical_kinds=["wiki_comment", "report_ready",
                                                     "report_failed"])
    assert resp.json()["critical_kinds"] == ["report_ready", "report_failed", "wiki_comment"]
    assert resp.json()["defaults"]["wiki"] == {"inbox": True, "email": False}
    resp = await _put(client, admin, critical_kinds=[])
    assert resp.json()["critical_kinds"] == []
    assert _by_kind(await _get(client, admin))["wiki_comment"]["critical"] is False

    # the security kinds stay critical whatever is stored
    assert _by_kind(await _get(client, admin))["totp_enrolled"]["critical"] is True


@pytest.mark.parametrize("kinds", [
    ["password_expiring"],          # account security: always critical, never stored
    ["password_reset_request"],     # never emailed
    ["nope"],                       # not registered
    ["report_failed", "nope"],      # one bad kind sinks the request
])
async def test_put_rejects_kinds_that_cannot_be_critical(client, db, seeded_user, kinds):
    admin = await _admin(db, client)
    resp = await _put(client, admin, critical_kinds=kinds)
    assert (resp.status_code, _code(resp)) == (422, "invalid_kind")
    assert (await _get(client, admin))["critical_kinds"] == []
    assert await _audits(db) == []


# ── notifications/company.py ────────────────────────────────────────

def test_is_critical_rules():
    from serversherpa.notifications.company import CompanySettings, is_critical

    nothing = CompanySettings({}, frozenset())
    marked = CompanySettings({}, frozenset({"report_failed"}))
    # account security is always critical
    assert is_critical("totp_enrolled", nothing) is True
    assert is_critical("password_expiring", nothing) is True
    # anything else only when an admin marked it
    assert is_critical("report_failed", marked) is True
    assert is_critical("report_failed", nothing) is False
    assert is_critical("report_ready", marked) is False
    # a marked kind that can never be critical (never emailed, or unregistered) is not
    for kind in ("password_reset_request", "learning_quiz_locked", "nope"):
        assert is_critical(kind, CompanySettings({}, frozenset({kind}))) is False


def test_critical_eligible_is_registered_emailed_and_not_security():
    from serversherpa.notifications.company import critical_eligible

    assert {kind: critical_eligible(kind) for kind in KINDS} == {
        kind: info.email and info.category != "security" for kind, info in KINDS.items()}
    assert critical_eligible("nope") is False
    assert critical_eligible("report_failed") is True
    assert critical_eligible("password_expiring") is False
    assert critical_eligible("password_reset_request") is False


async def test_load_company_settings_out_of_the_box(db):
    from serversherpa.notifications.company import (
        CONFIGURABLE_CATEGORIES, Switches, load_company_settings,
    )
    from serversherpa.system.config_store import DEFAULTS

    company = await load_company_settings(db)
    assert CONFIGURABLE_CATEGORIES == CONFIGURABLE
    # config_store cannot import company (a cycle), so it spells the eight out too
    assert tuple(DEFAULTS["notifications"]["defaults"]) == CONFIGURABLE_CATEGORIES
    assert DEFAULTS["notifications"]["critical_kinds"] == []
    assert dict(company.defaults) == {c: Switches(True, True) for c in CONFIGURABLE}
    assert company.critical_kinds == frozenset()


async def test_load_company_settings_ignores_what_it_does_not_know(db):
    """A missing or malformed category is on/on; unknown categories and kinds
    (and kinds that can never be critical) are dropped. Nothing here can have
    come from the PUT, which refuses them; a hand-edited row must not break
    notify()."""
    from serversherpa.notifications.company import Switches, load_company_settings

    db.add(SystemConfig(section="notifications", data={
        "defaults": {
            "approvals": {"inbox": False, "email": False},   # a real choice
            "reports": "garbage",                            # not a pair
            "wiki": {"inbox": False},                        # half a pair
            "security": {"inbox": False, "email": False},    # not configurable
            "bogus": {"inbox": False, "email": False},       # unknown
            # learning: missing
        },
        "critical_kinds": ["report_failed", "nope", "password_reset_request",
                           "totp_enrolled", 7, ["wiki_update"], "report_failed"],
    }))
    await db.commit()

    company = await load_company_settings(db)
    assert dict(company.defaults) == {
        "approvals": Switches(False, False), "reports": Switches(True, True),
        "wiki": Switches(True, True), "learning": Switches(True, True),
        "initiatives": Switches(True, True), "plans": Switches(True, True),
        "trucks": Switches(True, True),
        "devices": Switches(True, True), "status_rules": Switches(True, True),
        "bulk_actions": Switches(True, True)}
    assert company.critical_kinds == frozenset({"report_failed"})


async def test_load_company_settings_survives_a_wrong_shaped_section(db):
    from serversherpa.notifications.company import Switches, load_company_settings

    db.add(SystemConfig(section="notifications",
                        data={"defaults": ["not", "a", "dict"], "critical_kinds": "report_failed"}))
    await db.commit()

    company = await load_company_settings(db)
    assert dict(company.defaults) == {c: Switches(True, True) for c in CONFIGURABLE}
    assert company.critical_kinds == frozenset()
