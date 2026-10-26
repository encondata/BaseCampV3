"""The learning assignment engine: which documents a person must sign for
an initiative (the spec's "due" and "valid" rules), the add/remove hooks on
both people paths (single + bulk), the dry run and manual assignment."""
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import Initiative, InitiativePerson, Person
from serversherpa.learning import assign
from serversherpa.learning.models import (
    LearningAssignment,
    LearningCode,
    LearningDocument,
    LearningDocumentVersion,
    LearningInviteSchedule,
    LearningPacket,
    LearningPacketItem,
    LearningRule,
    LearningSignoff,
)
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_team_bulk_service import commit as bulk_commit
from tests.test_team_bulk_service import mk_worker

TODAY = datetime.now(UTC).date()


# ── helpers ──────────────────────────────────────────────────────────


def _midnight(day: date) -> datetime:
    """Date-only initiative fields are stored as midnight UTC."""
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


async def _manager(db, client):
    return await _make(db, client, "admin", f"as-{uuid.uuid4().hex[:8]}@test.example.com")


async def _doc(db, title, *, validity_days=None, resign_rule="expired_or_new_version"):
    doc = LearningDocument(title=title, validity_days=validity_days, resign_rule=resign_rule)
    db.add(doc)
    await db.flush()
    await _publish(db, doc)
    return doc


async def _publish(db, doc):
    number = (await db.scalar(select(func.max(LearningDocumentVersion.version_no)).where(
        LearningDocumentVersion.document_id == doc.id)) or 0) + 1
    version = LearningDocumentVersion(document_id=doc.id, version_no=number, title=doc.title,
                                      content_json={}, content_html="<p>x</p>")
    db.add(version)
    await db.flush()
    doc.current_version_id = version.id
    await db.commit()
    return version


async def _packet(db, docs, *, conditions=(("everyone", []),), name="Standard onboarding",
                  due_offset_days=None, position=1.0):
    packet = LearningPacket(name=name, due_offset_days=due_offset_days)
    db.add(packet)
    await db.flush()
    for i, doc in enumerate(docs):
        db.add(LearningPacketItem(packet_id=packet.id, document_id=doc.id, position=i))
    rule = LearningRule(name=name, packet_id=packet.id, position=position,
                        conditions=[{"field": f, "values": v} for f, v in conditions])
    db.add(rule)
    await db.commit()
    return packet, rule


async def _initiative(db, name="Move", *, start=None, end=None):
    start = start or TODAY + timedelta(days=14)
    move = Initiative(name=name, initiative_type="move", scheduled_start=_midnight(start),
                      scheduled_end=_midnight(end) if end else None)
    db.add(move)
    await db.commit()
    return move


async def _worker(db, first="Wanda", last="Worker", email="wanda@test.example.com"):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.commit()
    return person


async def _signoff(db, person, doc, version, *, initiative=None, days_ago=0):
    db.add(LearningSignoff(
        person_id=person.id, document_id=doc.id, version_id=version_id_of(version),
        initiative_id=initiative.id if initiative else None, language="en",
        typed_name="W W", read_seconds=60, scrolled_to_end=True,
        signed_at=datetime.now(UTC) - timedelta(days=days_ago)))
    await db.commit()


def version_id_of(version):
    return version if isinstance(version, uuid.UUID) else version.id


async def _assignments(db, person_id=None, **where):
    stmt = (select(LearningAssignment).order_by(LearningAssignment.created_at)
            .execution_options(populate_existing=True))
    if person_id is not None:
        stmt = stmt.where(LearningAssignment.person_id == person_id)
    for key, value in where.items():
        stmt = stmt.where(getattr(LearningAssignment, key) == value)
    return list(await db.scalars(stmt))


def _by(items):
    return {i.document_id: i for i in items}


# ── due / valid ──────────────────────────────────────────────────────


async def test_new_worker_gets_everyone_packet(client, db, seeded_user):
    hdrs = await _manager(db, client)
    safety, dress, photo = (await _doc(db, "Site safety"), await _doc(db, "Dress code"),
                            await _doc(db, "Photo policy"))
    everyone, rule1 = await _packet(db, [safety, dress])
    # a second matching rule repeats a document: the first rule by position keeps it
    leads, rule2 = await _packet(db, [dress, photo], conditions=(("worker_role", ["lead"]),),
                                 name="Leads", due_offset_days=1, position=2.0)
    move = await _initiative(db)
    db.add(LearningInviteSchedule(initiative_id=move.id, due_offset_days=4))
    await db.commit()
    worker = await _worker(db)

    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(worker.id), "work_type": "lead"})
    assert resp.status_code == 201, resp.text

    rows = _by(await _assignments(db, worker.id))
    assert set(rows) == {safety.id, dress.id, photo.id}
    start = TODAY + timedelta(days=14)
    for doc in (safety, dress):
        row = rows[doc.id]
        assert (row.packet_id, row.rule_id) == (everyone.id, rule1.id)
        assert row.source == "rule" and row.status == "assigned"
        assert row.initiative_id == move.id
        assert row.version_id == doc.current_version_id
        assert row.due_on == start - timedelta(days=4)        # the schedule's offset
    assert (rows[photo.id].packet_id, rows[photo.id].rule_id) == (leads.id, rule2.id)
    assert rows[photo.id].due_on == start - timedelta(days=1)  # the packet's own offset

    # without a schedule the settings' due offset (2) applies
    other = await _initiative(db, "Second")
    newbie = await _worker(db, "Nina", "New", "nina@test.example.com")
    resp = await client.post(f"/initiatives/{other.id}/people", headers=hdrs,
                             json={"person_id": str(newbie.id)})
    assert resp.status_code == 201, resp.text
    rows = _by(await _assignments(db, newbie.id))
    assert set(rows) == {safety.id, dress.id}
    assert rows[safety.id].due_on == start - timedelta(days=2)


async def test_valid_signoff_skips_expired_or_new_version_doc(db, seeded_user):
    fresh = await _doc(db, "Fresh", validity_days=365)
    stale = await _doc(db, "Stale", validity_days=30)
    revised = await _doc(db, "Revised")
    never = await _doc(db, "Never")
    endless = await _doc(db, "Endless")
    await _packet(db, [fresh, stale, revised, never, endless])
    move = await _initiative(db)
    worker = await _worker(db)
    elsewhere = await _initiative(db, "Earlier move")
    await _signoff(db, worker, fresh, fresh.current_version_id, initiative=elsewhere,
                   days_ago=10)
    await _signoff(db, worker, stale, stale.current_version_id, days_ago=60)
    await _signoff(db, worker, revised, revised.current_version_id, days_ago=5)
    await _publish(db, revised)
    await _signoff(db, worker, endless, endless.current_version_id, days_ago=900)

    plan = _by(await assign.plan_for(db, worker.id, move.id))
    until = (datetime.now(UTC) - timedelta(days=10)).date() + timedelta(days=365)
    assert (plan[fresh.id].action, plan[fresh.id].reason) == ("skip", f"valid_until:{until}")
    assert (plan[stale.id].action, plan[stale.id].reason) == ("assign", "expired")
    assert (plan[revised.id].action, plan[revised.id].reason) == ("assign", "new_version")
    assert plan[revised.id].version_id == revised.current_version_id
    assert (plan[never.id].action, plan[never.id].reason) == ("assign", "never_signed")
    assert (plan[endless.id].action, plan[endless.id].reason) == ("skip", "valid_until:never")

    # the check date decides: on the expiry day it's still valid, the day after it isn't
    assert await assign.signoff_valid(db, worker.id, fresh, initiative_id=None, on=until) == (
        True, f"valid_until:{until}")
    assert await assign.signoff_valid(
        db, worker.id, fresh, initiative_id=None, on=until + timedelta(days=1)) == (
        False, "expired")

    created = await assign.apply_plan(db, worker.id, move.id, list(plan.values()),
                                      actor_id=None)
    await db.commit()
    assert {a.document_id for a in created} == {stale.id, revised.id, never.id}


async def test_every_initiative_doc_always_assigned(db, seeded_user):
    briefing = await _doc(db, "Site briefing", resign_rule="every_initiative")
    await _packet(db, [briefing])
    worker = await _worker(db)
    last_week = await _initiative(db, "Last week")
    await _signoff(db, worker, briefing, briefing.current_version_id,
                   initiative=last_week, days_ago=1)
    move = await _initiative(db)

    assert await assign.signoff_valid(db, worker.id, briefing, initiative_id=move.id,
                                      on=TODAY) == (False, "every_initiative")
    plan = await assign.plan_for(db, worker.id, move.id)
    assert [(i.document_id, i.action, i.reason) for i in plan] == [
        (briefing.id, "assign", "every_initiative")]
    # outside an initiative (the general set) the sign-off still counts
    assert await assign.signoff_valid(db, worker.id, briefing, initiative_id=None,
                                      on=TODAY) == (True, "valid_until:never")


async def test_signed_for_same_initiative_stays_valid_past_expiry(db, seeded_user):
    doc = await _doc(db, "Badge rules", validity_days=30)
    worker = await _worker(db)
    end = TODAY + timedelta(days=10)
    long_move = await _initiative(db, "Long move", start=TODAY - timedelta(days=90), end=end)
    await _signoff(db, worker, doc, doc.current_version_id, initiative=long_move,
                   days_ago=60)
    next_move = await _initiative(db, "Next move")

    assert await assign.signoff_valid(db, worker.id, doc, initiative_id=long_move.id,
                                      on=TODAY) == (True, f"valid_until:{end}")
    assert await assign.signoff_valid(db, worker.id, doc, initiative_id=long_move.id,
                                      on=end) == (True, f"valid_until:{end}")
    assert await assign.signoff_valid(db, worker.id, doc, initiative_id=long_move.id,
                                      on=end + timedelta(days=1)) == (False, "expired")
    assert await assign.signoff_valid(db, worker.id, doc, initiative_id=next_move.id,
                                      on=TODAY) == (False, "expired")


async def test_new_version_requires_resign_at_next_initiative(db, seeded_user):
    doc = await _doc(db, "Tool policy")
    await _packet(db, [doc])
    worker = await _worker(db)
    current = await _initiative(db, "Current", start=TODAY - timedelta(days=3),
                                end=TODAY + timedelta(days=20))
    await _signoff(db, worker, doc, doc.current_version_id, initiative=current, days_ago=2)
    v2 = await _publish(db, doc)
    upcoming = await _initiative(db, "Upcoming")

    # mid-initiative, the new version doesn't reopen the sign-off
    plan = await assign.plan_for(db, worker.id, current.id)
    assert [(i.action, i.reason) for i in plan] == [
        ("skip", f"valid_until:{TODAY + timedelta(days=20)}")]
    # the next initiative requires the new version
    plan = await assign.plan_for(db, worker.id, upcoming.id)
    assert [(i.action, i.reason, i.version_id) for i in plan] == [
        ("assign", "new_version", v2.id)]


# ── the add / remove hooks ───────────────────────────────────────────


async def test_single_add_creates_assignments_in_same_transaction(
        client, db, seeded_user, monkeypatch):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    await _packet(db, [doc])
    move = await _initiative(db)
    worker = await _worker(db)

    # the engine failing takes the add down with it
    async def broken(*args, **kwargs):
        raise RuntimeError("engine down")

    monkeypatch.setattr(assign, "apply_plan", broken)
    try:
        resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                                 json={"person_id": str(worker.id)})
        assert resp.status_code >= 500
    except RuntimeError:
        pass
    assert await db.scalar(select(func.count()).select_from(InitiativePerson)) == 0
    assert await _assignments(db) == []
    monkeypatch.undo()

    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(worker.id)})
    assert resp.status_code == 201, resp.text
    assert [r["person_id"] for r in resp.json()] == [str(worker.id)]
    rows = await _assignments(db, worker.id)
    assert [(a.document_id, a.initiative_id) for a in rows] == [(doc.id, move.id)]


async def test_bulk_add_creates_assignments(db, seeded_user):
    doc_a, doc_b = await _doc(db, "Site safety"), await _doc(db, "Dress code")
    await _packet(db, [doc_a, doc_b])
    leads_doc = await _doc(db, "Lead duties")
    await _packet(db, [leads_doc], conditions=(("worker_role", ["lead"]),), name="Leads",
                  position=2.0)
    move = await _initiative(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Brown")

    out = await bulk_commit(db, seeded_user, move,
                            [{"worker": "Ana Lopez", "role": "lead"}, {"worker": "Ben Brown"}])
    assert out["created"] == 2

    ana_rows = await _assignments(db, ana.id, initiative_id=move.id)
    assert {a.document_id for a in ana_rows} == {doc_a.id, doc_b.id, leads_doc.id}
    ben_rows = await _assignments(db, ben.id, initiative_id=move.id)
    assert {a.document_id for a in ben_rows} == {doc_a.id, doc_b.id}
    assert all(a.created_by == seeded_user.id for a in ana_rows + ben_rows)


async def test_add_twice_bulk_then_single_no_duplicates(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc_a, doc_b = await _doc(db, "Site safety"), await _doc(db, "Dress code")
    await _packet(db, [doc_a, doc_b])
    move = await _initiative(db)
    ana = await mk_worker(db, "Ana", "Lopez")

    await bulk_commit(db, seeded_user, move, [{"worker": "Ana Lopez"}])
    assert len(await _assignments(db, ana.id)) == 2

    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(ana.id)})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "duplicate_person"
    assert len(await _assignments(db, ana.id)) == 2

    # the hook itself is idempotent: running it again adds nothing
    await assign.assign_on_add(db, move.id, ana.id, seeded_user.id)
    await db.commit()
    assert len(await _assignments(db, ana.id)) == 2
    plan = await assign.plan_for(db, ana.id, move.id)
    assert {(i.action, i.reason) for i in plan} == {("skip", "already_assigned")}
    # and apply_plan skips an open row even when handed an "assign" item
    forced = [assign.PlannedItem(document_id=i.document_id, version_id=i.version_id,
                                 packet_id=i.packet_id, rule_id=i.rule_id,
                                 action="assign", reason="never_signed") for i in plan]
    assert await assign.apply_plan(db, ana.id, move.id, forced, actor_id=None) == []


async def test_remove_cancels_and_readd_reassigns(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc_a, doc_b = await _doc(db, "Site safety"), await _doc(db, "Dress code")
    await _packet(db, [doc_a, doc_b])
    move = await _initiative(db)
    other = await _initiative(db, "Other move")
    worker = await _worker(db)

    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(worker.id)})
    assoc_id = resp.json()[0]["id"]
    resp = await client.post(f"/initiatives/{other.id}/people", headers=hdrs,
                             json={"person_id": str(worker.id)})
    assert resp.status_code == 201
    code = LearningCode(person_id=worker.id, initiative_id=move.id, fingerprint=b"fp-1",
                        link_token_hash="hash-1")
    other_code = LearningCode(person_id=worker.id, initiative_id=other.id,
                              fingerprint=b"fp-2", link_token_hash="hash-2")
    db.add_all([code, other_code])
    await db.commit()

    resp = await client.delete(f"/initiatives/people/{assoc_id}", headers=hdrs)
    assert resp.status_code == 204, resp.text
    rows = await _assignments(db, worker.id, initiative_id=move.id)
    assert [a.status for a in rows] == ["cancelled", "cancelled"]
    # the other initiative is untouched
    assert {a.status for a in await _assignments(db, worker.id, initiative_id=other.id)} == {
        "assigned"}
    await db.refresh(code)
    await db.refresh(other_code)
    assert code.revoked_at is not None and other_code.revoked_at is None

    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(worker.id)})
    assert resp.status_code == 201, resp.text
    rows = await _assignments(db, worker.id, initiative_id=move.id)
    assert sorted(a.status for a in rows) == ["assigned", "assigned", "cancelled", "cancelled"]
    assert {a.document_id for a in rows if a.status == "assigned"} == {doc_a.id, doc_b.id}


# ── dry run ──────────────────────────────────────────────────────────


async def _dry_run_setup(db):
    safety = await _doc(db, "Site safety", validity_days=365)
    dress = await _doc(db, "Dress code")
    await _packet(db, [safety, dress])
    move = await _initiative(db)
    wanda = await _worker(db)
    nomail = await _worker(db, "Ned", "Nomail", None)
    await _signoff(db, wanda, safety, safety.current_version_id, days_ago=1)
    # added straight to the table, so no hook has run yet
    db.add_all([InitiativePerson(initiative_id=move.id, person_id=wanda.id),
                InitiativePerson(initiative_id=move.id, person_id=nomail.id)])
    await db.commit()
    return move, wanda, nomail


async def test_dry_run_does_not_write(client, db, seeded_user):
    hdrs = await _manager(db, client)
    move, wanda, nomail = await _dry_run_setup(db)

    resp = await client.post(f"/learning/initiatives/{move.id}/dry-run", headers=hdrs,
                             json={"apply": False})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    rows = {r["person_id"]: r for r in out["rows"]}
    until = TODAY - timedelta(days=1) + timedelta(days=365)
    assert rows[str(wanda.id)] == {
        "person_id": str(wanda.id), "name": "Wanda Worker", "will_get": ["Dress code"],
        "why": ["never_signed"],
        "skipped": [{"title": "Site safety", "reason": f"valid_until:{until}"}],
        "no_email": False}
    assert rows[str(nomail.id)]["will_get"] == ["Site safety", "Dress code"]
    assert rows[str(nomail.id)]["no_email"] is True
    assert out["totals"] == {"checked": 2, "to_assign": 3, "skipped": 1, "no_email": 1}
    assert await _assignments(db) == []

    # staff hold learning:view — they may look, not apply; a worker may not look
    staff = await login(client)
    resp = await client.post(f"/learning/initiatives/{move.id}/dry-run", headers=staff,
                             json={"apply": False})
    assert resp.status_code == 200
    resp = await client.post(f"/learning/initiatives/{move.id}/dry-run", headers=staff,
                             json={"apply": True})
    assert resp.status_code == 403
    assert await _assignments(db) == []
    worker = await _make(db, client, "worker", "as-worker@test.example.com")
    resp = await client.post(f"/learning/initiatives/{move.id}/dry-run", headers=worker,
                             json={"apply": False})
    assert resp.status_code == 403
    resp = await client.post(f"/learning/initiatives/{uuid.uuid4()}/dry-run", headers=hdrs,
                             json={"apply": False})
    assert resp.status_code == 404


async def test_dry_run_apply_writes(client, db, seeded_user):
    hdrs = await _manager(db, client)
    move, wanda, nomail = await _dry_run_setup(db)

    resp = await client.post(f"/learning/initiatives/{move.id}/dry-run", headers=hdrs,
                             json={"apply": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["totals"]["to_assign"] == 3
    assert len(await _assignments(db, wanda.id)) == 1
    assert len(await _assignments(db, nomail.id)) == 2

    # applying again is a no-op that says why
    resp = await client.post(f"/learning/initiatives/{move.id}/dry-run", headers=hdrs,
                             json={"apply": True})
    out = resp.json()
    assert out["totals"]["to_assign"] == 0 and out["totals"]["skipped"] == 4
    nomail_row = next(r for r in out["rows"] if r["person_id"] == str(nomail.id))
    assert {s["reason"] for s in nomail_row["skipped"]} == {"already_assigned"}
    assert len(await _assignments(db)) == 3


# ── manual assignment and pushed versions ────────────────────────────


async def test_manual_assign_general(client, db, seeded_user):
    hdrs = await _manager(db, client)
    extra = await _doc(db, "Forklift safety")
    p1, p2 = await _doc(db, "Packet one"), await _doc(db, "Packet two")
    packet, _ = await _packet(db, [p1, p2], name="On-site day",
                              conditions=(("person", [str(uuid.uuid4())]),))
    worker = await _worker(db)

    resp = await client.post("/learning/assign", headers=hdrs, json={
        "person_ids": [str(worker.id)], "initiative_id": None,
        "packet_id": str(packet.id), "document_ids": [str(extra.id), str(p1.id)]})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["totals"] == {"checked": 1, "to_assign": 3, "skipped": 0, "no_email": 0}
    assert out["rows"][0]["will_get"] == ["Packet one", "Packet two", "Forklift safety"]
    rows = _by(await _assignments(db, worker.id))
    assert set(rows) == {extra.id, p1.id, p2.id}
    assert all(a.initiative_id is None and a.source == "manual" and a.due_on is None
               for a in rows.values())
    assert rows[p1.id].packet_id == packet.id and rows[extra.id].packet_id is None

    # again: nothing new
    resp = await client.post("/learning/assign", headers=hdrs, json={
        "person_ids": [str(worker.id)], "initiative_id": None,
        "document_ids": [str(extra.id)]})
    assert resp.json()["totals"]["to_assign"] == 0
    assert resp.json()["rows"][0]["skipped"] == [
        {"title": "Forklift safety", "reason": "already_assigned"}]
    assert len(await _assignments(db, worker.id)) == 3

    # nothing to assign, an unknown person, a stranger
    resp = await client.post("/learning/assign", headers=hdrs, json={
        "person_ids": [str(worker.id)], "initiative_id": None})
    assert resp.status_code == 422
    resp = await client.post("/learning/assign", headers=hdrs, json={
        "person_ids": [str(uuid.uuid4())], "document_ids": [str(extra.id)]})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "bad_person"
    staff = await login(client)
    resp = await client.post("/learning/assign", headers=staff, json={
        "person_ids": [str(worker.id)], "document_ids": [str(extra.id)]})
    assert resp.status_code == 403


async def test_manual_assign_on_initiative_needs_membership(client, db, seeded_user):
    hdrs = await _manager(db, client)
    extra = await _doc(db, "Forklift safety")
    move = await _initiative(db)
    member, outsider = await _worker(db), await _worker(db, "Otto", "Out", "otto@x.example")
    db.add(InitiativePerson(initiative_id=move.id, person_id=member.id))
    await db.commit()

    resp = await client.post("/learning/assign", headers=hdrs, json={
        "person_ids": [str(member.id), str(outsider.id)], "initiative_id": str(move.id),
        "document_ids": [str(extra.id)]})
    assert resp.status_code == 200, resp.text
    rows = {r["person_id"]: r for r in resp.json()["rows"]}
    assert rows[str(member.id)]["will_get"] == ["Forklift safety"]
    assert rows[str(outsider.id)]["skipped"] == [
        {"title": "Forklift safety", "reason": "not_on_initiative"}]
    [row] = await _assignments(db)
    assert (row.person_id, row.initiative_id, row.source) == (member.id, move.id, "manual")
    assert row.due_on == TODAY + timedelta(days=14) - timedelta(days=2)


async def test_push_version_outside_an_initiative(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Tool policy")
    signed_old, signed_new, fresh = (await _worker(db), await _worker(db, "B", "B", "b@x.example"),
                                     await _worker(db, "C", "C", "c@x.example"))
    move = await _initiative(db)
    await _signoff(db, signed_old, doc, doc.current_version_id, initiative=move)
    v2 = await _publish(db, doc)
    await _signoff(db, signed_new, doc, v2.id, initiative=move)

    resp = await client.post(f"/learning/documents/{doc.id}/push-version", headers=hdrs,
                             json={"person_ids": [str(signed_old.id), str(signed_new.id),
                                                  str(fresh.id)]})
    assert resp.status_code == 200, resp.text
    rows = {r["person_id"]: r for r in resp.json()["rows"]}
    assert rows[str(signed_new.id)]["skipped"] == [
        {"title": "Tool policy", "reason": "already_signed"}]
    made = await _assignments(db)
    assert {a.person_id for a in made} == {signed_old.id, fresh.id}
    assert all(a.source == "new_version" and a.initiative_id is None and a.version_id == v2.id
               for a in made)

    draft = LearningDocument(title="Unpublished")
    db.add(draft)
    await db.commit()
    resp = await client.post(f"/learning/documents/{draft.id}/push-version", headers=hdrs,
                             json={"person_ids": [str(fresh.id)]})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_published"
