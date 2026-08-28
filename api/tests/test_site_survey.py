from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.api.routes.sites import _upsert_survey_entry
from serversherpa.db.models import PersonRole, Site, SiteSurveyEntry
from serversherpa.sites.survey import (
    FIELDS_BY_KEY, SURVEY_GROUPS, SurveyError, survey_schema, validate_survey,
)

from .test_assets_api import login


def test_registry_covers_the_legacy_groups():
    assert [g for g, _ in SURVEY_GROUPS] == ["contact", "facility", "dock", "notes"]
    assert "contact_name" in FIELDS_BY_KEY
    assert FIELDS_BY_KEY["dock_available"].kind == "bool"
    assert FIELDS_BY_KEY["floor"].kind == "int"


def test_valid_partial_survey_passes():
    out = validate_survey({"contact_name": " Dana ", "dock_available": True,
                           "floor": 3})
    assert out == {"contact_name": "Dana", "dock_available": True, "floor": 3}


def test_empty_values_dropped():
    assert validate_survey({"contact_name": "   ", "dock_hours": None}) == {}


def test_unknown_field_rejected():
    with pytest.raises(SurveyError) as exc:
        validate_survey({"nope": "x"})
    assert exc.value.code == "unknown_survey_field"
    assert exc.value.field == "nope"


def test_wrong_type_rejected():
    with pytest.raises(SurveyError) as exc:
        validate_survey({"dock_available": "yes"})
    assert exc.value.code == "invalid_survey_value"
    assert exc.value.field == "dock_available"
    with pytest.raises(SurveyError):
        validate_survey({"floor": "three"})


def test_select_option_enforced():
    assert validate_survey({"floor_covering_required": "carpet"})
    with pytest.raises(SurveyError):
        validate_survey({"floor_covering_required": "shag"})


def test_schema_is_json_ready():
    schema = survey_schema()
    assert [g["key"] for g in schema["groups"]] == ["contact", "facility",
                                                    "dock", "notes"]
    dock = next(g for g in schema["groups"] if g["key"] == "dock")
    keys = [f["key"] for f in dock["fields"]]
    assert "dock_available" in keys and "dock_hours" in keys


# ── concurrent-save race guard ─────────────────────────────────────


async def test_survey_upsert_conflict_recovers_via_savepoint(
        client, db, seeded_user):
    """Exercises the real seam: `_upsert_survey_entry` is called with
    `existing=None` (as if the caller's select had missed) against a site
    that already has a committed curated row for that field — a genuine
    UNIQUE(site_id, field_key) violation on flush, not a mocked exception.
    The savepoint must recover: expunge the failed insert, re-select the
    concurrent winner, apply the update, and leave the session usable."""
    site = Site(name="Race Site")
    db.add(site)
    await db.flush()
    site_id = site.id

    # the "concurrent winner" — already committed by the time our call runs
    db.add(SiteSurveyEntry(site_id=site_id, field_key="floor", value=2,
                           updated_by=seeded_user.id))
    await db.commit()

    entry, before = await _upsert_survey_entry(
        db, site_id, "floor", 9, None, seeded_user.id, datetime.now(UTC), None)
    await db.commit()

    assert before == 2
    assert entry.value == 9

    # a single curated row remains, and the session isn't poisoned
    rows = list(await db.scalars(select(SiteSurveyEntry).where(
        SiteSurveyEntry.site_id == site_id,
        SiteSurveyEntry.field_key == "floor")))
    assert len(rows) == 1
    assert rows[0].value == 9

    hdrs = await login(client)
    resp = await client.get(f"/sites/{site_id}/survey", headers=hdrs)
    assert resp.status_code == 200
    floor = next(r for r in resp.json() if r["field_key"] == "floor")
    assert floor["value"] == 9


async def test_survey_put_noop_skips_raw_and_audit(client, db, seeded_user):
    """An idempotent PUT (same value twice) must not append a raw entry or
    an audit row the second time, but a real change still must."""
    hdrs = await login(client)
    site = Site(name="Noop Site")
    db.add(site)
    await db.commit()

    resp = await client.put(f"/sites/{site.id}/survey/floor",
                            headers=hdrs, json={"value": 3})
    assert resp.status_code == 200
    first_row = resp.json()
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 1

    # same value again — no-op: identical payload, raw trail unchanged
    resp = await client.put(f"/sites/{site.id}/survey/floor",
                            headers=hdrs, json={"value": 3})
    assert resp.status_code == 200
    assert resp.json() == first_row
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 1

    db.add(PersonRole(person_id=seeded_user.id, role="admin"))
    await db.commit()
    audit_rows = [r for r in (await client.get(
        f"/audit?entity_type=site&entity_id={site.id}", headers=hdrs)).json()
        if r["action"] == "survey.update"]
    assert len(audit_rows) == 1

    # a changed value still appends raw + audit — no over-skipping
    resp = await client.put(f"/sites/{site.id}/survey/floor",
                            headers=hdrs, json={"value": 4})
    assert resp.status_code == 200
    assert resp.json()["value"] == 4
    raws = (await client.get(f"/sites/{site.id}/survey/raw",
                             headers=hdrs)).json()
    assert len(raws) == 2
    audit_rows = [r for r in (await client.get(
        f"/audit?entity_type=site&entity_id={site.id}", headers=hdrs)).json()
        if r["action"] == "survey.update"]
    assert len(audit_rows) == 2
