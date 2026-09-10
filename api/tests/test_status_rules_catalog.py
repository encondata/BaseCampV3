"""Catalog semantics: operator truth table, dotted context lookup,
structural validation, and every typed action's apply() including the
missing-context skip path."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Asset, Container, Initiative, InitiativeAsset, Person, ProcessedScan, Site,
)
from serversherpa.status_rules.catalog import (
    ACTIONS, CONDITION_FIELDS, OPERATORS, evaluate_condition,
    validate_action, validate_condition,
)
from serversherpa.status_rules.context import Context


def test_operator_truth_table():
    assert evaluate_condition("Dock-1", "equals", "dock-1") is True
    assert evaluate_condition(None, "equals", "x") is False
    assert evaluate_condition("a", "not_equals", "b") is True
    assert evaluate_condition(None, "not_equals", "x") is False
    assert evaluate_condition("warehouse-7", "contains", "HOUSE") is True
    assert evaluate_condition(None, "is_null", None) is True
    assert evaluate_condition("", "is_null", None) is True
    assert evaluate_condition("x", "is_not_null", None) is True
    assert evaluate_condition("5", "greater_than", "3") is True
    assert evaluate_condition("abc", "greater_than", "3") is False
    assert evaluate_condition("3", "less_or_equal", "3") is True


def test_context_get_missing_entity_is_none():
    ctx = Context(scan=None)
    assert ctx.get("asset.status") is None


def test_validate_condition_rejects_unknown_field_and_operator():
    assert validate_condition("nope.nope", "equals", "x") == "unknown_field"
    assert validate_condition("scan.device_id", "regex", "x") == "unknown_operator"
    assert validate_condition("scan.device_id", "equals", "x") is None


def test_validate_action_rejects_bad_params():
    assert validate_action("no_such_action", {}) == "unknown_action"
    assert validate_action("set_asset_status", {}) == "missing_param"
    assert validate_action("set_initiative_asset_verified",
                           {"side": "sideways", "value": True}) == "bad_param"
    assert validate_action("set_asset_status",
                           {"status": "rfid_4_into_cage"}) is None


async def _scan(db, *, asset=None, container=None, person=None,
                site_id=None, location_detail="", status="rfid_4_into_cage",
                raw_scan_id=None):
    match_type = ("asset" if asset else
                  "container" if container else "person")
    s = ProcessedScan(
        scanned_value="V", scan_type="rfid", status=status,
        scanned_at=datetime.now(UTC), processed_at=datetime.now(UTC),
        site_id=site_id, location_detail=location_detail,
        raw_scan_id=raw_scan_id,
        match_type=match_type,
        asset_id=asset.id if asset else None,
        container_id=container.id if container else None,
        person_id=person.id if person else None)
    db.add(s)
    await db.flush()
    return s


async def test_set_asset_status_applies(db):
    a = Asset(status="unknown")
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a)
    out = await ACTIONS["set_asset_status"].apply(
        db, ctx, {"status": "rfid_4_into_cage"})
    assert out.applied is True
    assert a.status == "rfid_4_into_cage"


async def test_initiative_action_skips_without_context(db):
    a = Asset()
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a)          # no active initiative
    out = await ACTIONS["set_initiative_asset_status"].apply(
        db, ctx, {"status": "rfid_4_into_cage"})
    assert out.applied is False
    assert out.reason == "no_active_initiative"


async def test_set_asset_location_from_initiative_composes_rack_ru(db):
    a = Asset()
    db.add(a)
    init = Initiative(name="Move", initiative_type="move",
                      status="in_progress")
    db.add(init)
    await db.flush()
    ia = InitiativeAsset(initiative_id=init.id, asset_id=a.id,
                         destination_rack="R12",
                         destination_ru=Decimal("42.0"))
    db.add(ia)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a, initiative_asset=ia, initiative=init)
    out = await ACTIONS["set_asset_location_from_initiative"].apply(
        db, ctx, {"side": "destination"})
    assert out.applied is True
    assert a.location_detail == "R12 RU42"


async def test_touch_container_audit(db):
    c = Container(name="Crate")
    p = Person(first_name="Op", last_name="Erator")
    db.add_all([c, p])
    await db.flush()
    scan = await _scan(db, container=c, raw_scan_id=1)
    scan.operator_id = p.id
    ctx = Context(scan=scan, container=c)
    out = await ACTIONS["touch_container_audit"].apply(db, ctx, {})
    assert out.applied is True
    assert c.last_audit_at == scan.scanned_at
    assert c.audit_by == p.id


async def test_touch_container_audit_skips_non_presence_read(db):
    """A manual keyboard edit (raw_scan_id None) is not a physical
    presence event — it must not stamp a container audit."""
    c = Container(name="Crate")
    db.add(c)
    await db.flush()
    scan = await _scan(db, container=c, raw_scan_id=None)
    ctx = Context(scan=scan, container=c)
    out = await ACTIONS["touch_container_audit"].apply(db, ctx, {})
    assert out.applied is False
    assert out.reason == "not_a_presence_read"
    assert c.last_audit_at is None
    assert c.audit_by is None


async def test_clear_actions(db):
    site = Site(name="NAP 11")
    db.add(site)
    await db.flush()
    a = Asset(location_detail="R4 RU10", site_id=site.id)
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a)
    out = await ACTIONS["clear_asset_location"].apply(db, ctx, {})
    assert out.applied is True
    assert a.location_detail == ""
    out = await ACTIONS["clear_asset_site"].apply(db, ctx, {})
    assert out.applied is True
    assert a.site_id is None


async def test_set_asset_location_from_container(db):
    a = Asset()
    c = Container(name="scan-verify-crate")
    db.add_all([a, c])
    await db.flush()
    scan = await _scan(db, asset=a)
    ctx = Context(scan=scan, asset=a, container=c)
    out = await ACTIONS["set_asset_location_from_container"].apply(db, ctx, {})
    assert out.applied is True
    assert a.location_detail == "scan-verify-crate"

    bare = Context(scan=scan, asset=a)          # not in any container
    out = await ACTIONS["set_asset_location_from_container"].apply(db, bare, {})
    assert out.applied is False
    assert out.reason == "not_in_container"


async def test_location_from_scan_fields_param(db):
    site = Site(name="NAP 11")
    db.add(site)
    await db.flush()
    a = Asset(location_detail="R4 RU10", site_id=None)
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a, site_id=site.id, location_detail="")
    ctx = Context(scan=scan, asset=a)

    out = await ACTIONS["set_asset_location_from_scan"].apply(
        db, ctx, {"fields": "site"})
    assert out.applied is True
    assert a.site_id == site.id
    assert a.location_detail == "R4 RU10"       # untouched — the V2 fidelity point


async def test_location_from_scan_manual_edit_touches_nothing(db):
    """A manual keyboard edit's scan carries no site/location at all
    (scans/manual.py: site_id=None, location_detail=""). The action must
    leave a pre-set asset location/site completely intact and report
    that it had nothing to copy."""
    site = Site(name="NAP 11")
    db.add(site)
    await db.flush()
    a = Asset(location_detail="R4 RU10", site_id=site.id)
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a, site_id=None, location_detail="",
                       raw_scan_id=None)
    ctx = Context(scan=scan, asset=a)

    out = await ACTIONS["set_asset_location_from_scan"].apply(
        db, ctx, {"fields": "both"})
    assert out.applied is False
    assert out.reason == "no_scan_location"
    assert a.site_id == site.id
    assert a.location_detail == "R4 RU10"


async def test_location_from_scan_copies_only_carried_field(db):
    """A scan carrying only location_detail (no site) with fields="both"
    sets the location and leaves the existing site untouched."""
    site = Site(name="NAP 11")
    db.add(site)
    await db.flush()
    a = Asset(location_detail="Old", site_id=site.id)
    db.add(a)
    await db.flush()
    scan = await _scan(db, asset=a, site_id=None, location_detail="R9 RU3")
    ctx = Context(scan=scan, asset=a)

    out = await ACTIONS["set_asset_location_from_scan"].apply(
        db, ctx, {"fields": "both"})
    assert out.applied is True
    assert a.location_detail == "R9 RU3"
    assert a.site_id == site.id                 # untouched — scan carried no site


def test_validate_new_actions():
    assert validate_action("clear_asset_location", {}) is None
    assert validate_action("clear_asset_site", {}) is None
    assert validate_action("set_asset_location_from_container", {}) is None
    assert validate_action("set_asset_location_from_scan",
                           {"fields": "site"}) is None
    assert validate_action("set_asset_location_from_scan",
                           {"fields": "sideways"}) == "bad_param"
    assert validate_action("set_asset_location_from_scan", {}) == "missing_param"
