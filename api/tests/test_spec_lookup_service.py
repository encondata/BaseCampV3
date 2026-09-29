"""Spec lookup service: eligibility, enqueue, record (verify + supersede +
auto-apply), approve / reject / undo."""
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.models import AssetModel, AuditLog, SpecLookupJob, SpecSuggestion
from serversherpa.spec_lookup import service
from serversherpa.spec_lookup.provider import Finding, LookupResult

CFG = {"background_enabled": True, "auto_apply": False, "fields_specs": True,
       "fields_mounting": False, "fields_knowledge": False, "retry_after_days": 90}
URL = "https://www.hpe.com/a"


async def _m(db, **kw):
    m = AssetModel(make=kw.pop("make", "HPE"), model=kw.pop("model", "DL320"), **kw)
    db.add(m)
    await db.commit()
    return m


def _result(*findings):
    return LookupResult(findings=list(findings), seen_urls={URL},
                        input_tokens=1000, output_tokens=100, search_count=2)


async def test_eligibility_rules(db):
    now = datetime.now(UTC)
    blank = await _m(db, model="blank")
    full = await _m(db, model="full", ru_size=1, weight_lbs=1, weight_kg=0.45,
                    length_in=1, length_cm=2.54, width_in=1, width_cm=2.54,
                    height_in=1, height_cm=2.54)
    private = await _m(db, model="private", private=True)
    skipped = await _m(db, model="skipped", spec_lookup_skip=True)
    recent = await _m(db, model="recent", specs_looked_up_at=now - timedelta(days=5))
    old = await _m(db, model="old", specs_looked_up_at=now - timedelta(days=100))
    queued = await _m(db, model="queued")
    db.add(SpecLookupJob(model_id=queued.id))
    await db.commit()
    ids = set(await service.eligible_model_ids(db, CFG, now=now))
    assert ids == {blank.id, old.id}
    assert full.id not in ids and private.id not in ids and skipped.id not in ids
    ids = set(await service.eligible_model_ids(db, CFG, respect_retry=False, now=now))
    assert recent.id in ids
    ids = set(await service.eligible_model_ids(db, {**CFG, "retry_after_days": 0}, now=now))
    assert old.id not in ids


async def test_eligibility_respects_failed_cooldown(db):
    now = datetime.now(UTC)
    recent_fail = await _m(db, model="recent-fail")
    db.add(SpecLookupJob(model_id=recent_fail.id, status="failed",
                         finished_at=now - timedelta(hours=1)))
    old_fail = await _m(db, model="old-fail")
    db.add(SpecLookupJob(model_id=old_fail.id, status="failed",
                         finished_at=now - timedelta(days=2)))
    await db.commit()
    ids = set(await service.eligible_model_ids(db, CFG, now=now))
    assert recent_fail.id not in ids and old_fail.id in ids
    ids = set(await service.eligible_model_ids(db, CFG, respect_retry=False, now=now))
    assert recent_fail.id in ids


async def test_eligibility_follows_field_groups(db):
    m = await _m(db, ru_size=1, weight_lbs=1, weight_kg=0.45, length_in=1, length_cm=2.54,
                 width_in=1, width_cm=2.54, height_in=1, height_cm=2.54)
    assert await service.eligible_model_ids(db, CFG) == []
    assert await service.eligible_model_ids(db, {**CFG, "fields_mounting": True}) == [m.id]


async def test_enqueue_dedupes_and_bumps_priority(db):
    m = await _m(db)
    assert await service.enqueue(db, [m.id], service.PRIORITY_SWEEP, None) == 1
    await db.commit()
    assert await service.enqueue(db, [m.id], service.PRIORITY_MODEL, None) == 0
    await db.commit()
    jobs = (await db.scalars(select(SpecLookupJob))).all()
    assert len(jobs) == 1 and jobs[0].priority == service.PRIORITY_MODEL


async def test_record_verifies_and_sets_looked_up(db):
    m = await _m(db)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("ru_size", "1", None, "1U rack", URL),
        Finding("weight", "30", "lbs", "weighs 13.6 kg", URL),          # not in quote
        Finding("height", "1.7", "in", "1.7 in", "https://elsewhere.example/x"),  # unseen
    ), CFG)
    await db.commit()
    assert [(r.field, r.value, r.status) for r in rows] == [("ru_size", "1", "pending")]
    assert m.specs_looked_up_at is not None and m.ru_size is None
    assert (job.input_tokens, job.output_tokens, job.search_count) == (1000, 100, 2)


async def test_record_supersedes_older_pending(db):
    m = await _m(db)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    first = (await service.record_result(db, job, m, _result(
        Finding("ru_size", "2", None, "2U", URL)), CFG))[0]
    await service.record_result(db, job, m, _result(Finding("ru_size", "1", None, "1U", URL)), CFG)
    await db.commit()
    assert (await db.get(SpecSuggestion, first.id)).status == "rejected"


async def test_auto_apply_fills_blank_only_with_unit_pair_and_audit(db):
    m = await _m(db, ru_size=2)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("ru_size", "1", None, "1U", URL),
        Finding("weight", "13.6", "kg", "13.6 kg", URL),
    ), {**CFG, "auto_apply": True})
    await db.commit()
    by = {r.field: r for r in rows}
    assert by["ru_size"].status == "pending" and m.ru_size == 2      # not blank -> not applied
    assert by["weight"].status == "applied"
    assert float(m.weight_kg) == 13.6 and float(m.weight_lbs) == 29.98
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "spec_lookup.apply"))
    assert row.actor_person_id is None and "weight_kg" in row.changes


async def test_implausible_height_dropped_for_known_ru(db):
    m = await _m(db, ru_size=1)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("height", "42.8", "cm", "42.8 cm", URL),           # implausible for 1U
        Finding("width", "43.46", "cm", "43.46 cm", URL),
        Finding("length", "70.7", "cm", "70.7 cm", URL),
    ), CFG)
    await db.commit()
    assert [r.field for r in rows] == ["width", "length"]
    assert m.height_cm is None


async def test_implausible_height_uses_ru_from_same_result_when_model_blank(db):
    m = await _m(db)                                              # ru_size blank
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("ru_size", "1", None, "1U", URL),
        Finding("height", "42.8", "cm", "42.8 cm", URL),
    ), CFG)
    await db.commit()
    assert [r.field for r in rows] == ["ru_size"]


async def test_height_kept_when_ru_unknown(db):
    m = await _m(db)                                              # ru_size blank, no ru finding
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("height", "42.8", "cm", "42.8 cm", URL)), CFG)
    await db.commit()
    assert [r.field for r in rows] == ["height"]


async def test_heavy_weight_stays_pending_even_with_auto_apply(db):
    m = await _m(db, ru_size=1)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("weight", "29.6", "kg", "29.6 kg", URL)),
        {**CFG, "auto_apply": True})
    await db.commit()
    assert rows[0].status == "pending" and m.weight_kg is None


async def test_non_heavy_weight_still_auto_applies(db):
    m = await _m(db, ru_size=2)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("weight", "16", "kg", "16 kg", URL)),
        {**CFG, "auto_apply": True})
    await db.commit()
    assert rows[0].status == "applied" and float(m.weight_kg) == 16


async def test_knowledge_never_auto_applies(db):
    m = await _m(db)
    job = SpecLookupJob(model_id=m.id)
    db.add(job)
    await db.flush()
    rows = await service.record_result(db, job, m, _result(
        Finding("knowledge", "A 1U server.", None, "The DL320 is a 1U server", URL)),
        {**CFG, "auto_apply": True, "fields_knowledge": True})
    assert rows[0].status == "pending" and m.knowledge == ""


async def test_approve_reject_undo(db, seeded_user):
    m = await _m(db)
    s = SpecSuggestion(model_id=m.id, field="height", value="1.7", unit="in",
                       quote="1.7 in", source_url=URL, previous_value=None)
    db.add(s)
    await db.commit()
    await service.approve(db, s, seeded_user.id)
    await db.commit()
    assert s.status == "approved" and float(m.height_in) == 1.7 and float(m.height_cm) == 4.32
    await service.undo(db, s, seeded_user.id)
    await db.commit()
    assert s.status == "reverted" and m.height_in is None and m.height_cm is None
    with pytest.raises(service.BadState):
        await service.reject(db, s, seeded_user.id)


async def test_approve_refuses_when_field_changed(db, seeded_user):
    m = await _m(db)
    s = SpecSuggestion(model_id=m.id, field="ru_size", value="1", quote="1U",
                       source_url=URL, previous_value=None)
    db.add(s)
    m.ru_size = 4
    await db.commit()
    with pytest.raises(service.FieldChanged):
        await service.approve(db, s, seeded_user.id)


async def test_undo_refuses_when_field_edited_after_apply(db, seeded_user):
    m = await _m(db)
    s = SpecSuggestion(model_id=m.id, field="ru_size", value="1", quote="1U",
                       source_url=URL, previous_value=None)
    db.add(s)
    await db.commit()
    await service.approve(db, s, seeded_user.id)
    m.ru_size = 3
    await db.commit()
    with pytest.raises(service.FieldChanged):
        await service.undo(db, s, seeded_user.id)


async def test_approve_refuses_over_half_filled_unit_pair(db, seeded_user):
    m = await _m(db, weight_kg=13.6)
    s = SpecSuggestion(model_id=m.id, field="weight", value="30", unit="lbs",
                       quote="30 lbs", source_url=URL, previous_value=None)
    db.add(s)
    await db.commit()
    with pytest.raises(service.FieldChanged) as exc:
        await service.approve(db, s, seeded_user.id)
    assert exc.value.args[0] == "13.6 kg"
    await db.rollback()
    m = await db.scalar(select(AssetModel).where(AssetModel.id == m.id)
                        .execution_options(populate_existing=True))
    assert m.weight_lbs is None and float(m.weight_kg) == 13.6
    assert (await db.get(SpecSuggestion, s.id)).status == "pending"
