"""The learning dashboard (funnel, overrides, initiatives at risk, expirations,
translation issues, hard questions), the per-initiative compliance grid, a
person's learning history and the sign-off certificate PDF."""
import base64
import io
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import select

from serversherpa.db.models import (
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    WorkerProfile,
)
from serversherpa.learning import assign, certificate, stats
from serversherpa.learning.models import (
    LearningAssignment,
    LearningEmailLog,
    LearningOverride,
    LearningQuizAttempt,
    LearningQuizQuestion,
    LearningSignoff,
    LearningTranslation,
)
from serversherpa.reports import learning_compliance
from tests.test_learning_assign import (
    TODAY,
    _doc,
    _initiative,
    _manager,
    _packet,
    _publish,
    _worker,
)
from tests.test_learning_translations import offer_languages
from tests.test_sites_api import make_login

NOW = datetime.now(UTC)


# ── helpers ──────────────────────────────────────────────────────────


async def _person(db, first, last, email=None):
    person = Person(first_name=first, last_name=last, email=email)
    db.add(person)
    await db.commit()
    return person


async def _people(db, *names):
    """Workers named `names` with their own email addresses."""
    return [await _person(db, n, "W", f"{n.lower()}@test.example.com") for n in names]


async def _on(db, initiative, *people):
    for person in people:
        db.add(InitiativePerson(initiative_id=initiative.id, person_id=person.id))
    await db.commit()


async def _assignment(db, person, doc, initiative=None, *, status="assigned", opened=None,
                      signed=None, created=None, source="rule"):
    row = LearningAssignment(
        person_id=person.id, initiative_id=initiative.id if initiative else None,
        document_id=doc.id, version_id=doc.current_version_id, source=source, status=status,
        opened_at=opened, signed_at=signed)
    if created is not None:
        row.created_at = created
    db.add(row)
    await db.commit()
    return row


async def _sign(db, person, doc, *, initiative=None, days_ago=0, quiz_score=None,
                signature=None, language="en", version_id=None, read_seconds=75, signed_at=None):
    row = LearningSignoff(
        person_id=person.id, document_id=doc.id, version_id=version_id or doc.current_version_id,
        initiative_id=initiative.id if initiative else None, language=language,
        typed_name=None if signature else f"{person.first_name} {person.last_name}",
        signature_png=signature, read_seconds=read_seconds, scrolled_to_end=True,
        quiz_score=quiz_score, signed_at=signed_at or NOW - timedelta(days=days_ago))
    db.add(row)
    await db.commit()
    return row


async def _override(db, person, admin, *, initiative=None, days_ago=0, reason="signed_on_paper"):
    db.add(LearningOverride(
        person_id=person.id, initiative_id=initiative.id if initiative else None,
        admin_person_id=admin.id, reason=reason, scope="punch",
        local_day=(NOW - timedelta(days=days_ago)).date(), outstanding=[],
        created_at=NOW - timedelta(days=days_ago)))
    await db.commit()


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGBA", (40, 12), (10, 20, 30, 255)).save(out, "PNG")
    return out.getvalue()


# ── dashboard ────────────────────────────────────────────────────────


async def test_dashboard_funnel_counts(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    move = await _initiative(db, "Acme move")
    ann, bob, cy, old = await _people(db, "Ann", "Bob", "Cy", "Old")
    opened = NOW - timedelta(hours=30)
    await _assignment(db, ann, doc, move, status="signed", opened=opened,
                      signed=opened + timedelta(minutes=22))
    await _assignment(db, bob, doc, move, status="opened", opened=opened)
    await _assignment(db, cy, doc, move)
    # assigned before the window: not in a 30-day funnel
    await _assignment(db, old, doc, move, created=NOW - timedelta(days=40))
    # the invite went out 6 hours before Ann opened
    db.add(LearningEmailLog(person_id=ann.id, initiative_id=move.id, kind="invite",
                            created_at=opened - timedelta(hours=6)))
    await db.commit()
    admin_a, admin_b = await _person(db, "Ada", "Admin"), await _person(db, "Bea", "Boss")
    await _override(db, ann, admin_a)
    await _override(db, bob, admin_a)
    await _override(db, cy, admin_b, days_ago=2)
    await _override(db, cy, admin_b, days_ago=45)

    resp = await client.get("/learning/dashboard", headers=hdrs, params={"days": 30})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["funnel"] == {"assigned": 3, "opened": 2, "complete": 1,
                              "median_open_hours": 6.0, "median_finish_minutes": 22.0}
    assert body["overrides"] == {"count": 3, "admins": 2}
    for key in ("expiring", "translation_issues", "hard_questions"):
        assert body[key] == []

    wide = (await client.get("/learning/dashboard", headers=hdrs, params={"days": 90})).json()
    assert wide["funnel"]["assigned"] == 4
    assert wide["overrides"]["count"] == 4

    default = await client.get("/learning/dashboard", headers=hdrs)
    assert default.status_code == 200 and default.json()["funnel"]["assigned"] == 3
    assert (await client.get("/learning/dashboard", headers=hdrs,
                             params={"days": 5})).status_code == 422


async def test_dashboard_is_manager_only(client, db, seeded_user):
    worker = await _person(db, "Wes", "Worker", "wes@test.example.com")
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, worker, "wes@test.example.com")
    assert (await client.get("/learning/dashboard", headers=hdrs)).status_code == 403
    move = await _initiative(db, "Move")
    assert (await client.get(f"/learning/initiatives/{move.id}/grid",
                             headers=hdrs)).status_code == 403


async def test_at_risk_sorting(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    two = await _doc(db, "Dress code")
    soon = await _initiative(db, "Soon", start=TODAY + timedelta(days=3))
    later = await _initiative(db, "Later", start=TODAY + timedelta(days=10))
    far = await _initiative(db, "Far away", start=TODAY + timedelta(days=40))
    done = await _initiative(db, "All signed", start=TODAY + timedelta(days=5))
    over = await _initiative(db, "Completed", start=TODAY + timedelta(days=6))
    over.status = "completed"
    shelved = await _initiative(db, "Archived", start=TODAY + timedelta(days=6))
    shelved.archived_at = NOW
    await db.commit()
    a, b, c = (await _person(db, "Ann", "A", "a@test.example.com"),
               await _person(db, "Bob", "B", None),
               await _person(db, "Cy", "C", "c@test.example.com"))
    # Soon: 1 of 4 signed (25%); Bob has no email and nothing signed
    await _assignment(db, a, doc, soon, status="signed", signed=NOW)
    await _assignment(db, a, two, soon)
    await _assignment(db, b, doc, soon)
    await _assignment(db, c, doc, soon)
    # Later: 1 of 2 signed (50%)
    await _assignment(db, a, doc, later, status="signed", signed=NOW)
    await _assignment(db, c, doc, later, status="opened", opened=NOW)
    # out of scope: too far away, nothing open, completed, archived
    await _assignment(db, a, doc, far)
    await _assignment(db, a, doc, done, status="signed", signed=NOW)
    await _assignment(db, a, doc, over)
    await _assignment(db, a, doc, shelved)

    body = (await client.get("/learning/dashboard", headers=hdrs)).json()
    assert [r["name"] for r in body["at_risk"]] == ["Soon", "Later"]
    first, second = body["at_risk"]
    assert first == {"initiative_id": str(soon.id), "name": "Soon", "starts_in_days": 3,
                     "percent": 25, "not_finished": 3, "no_email": 1}
    assert second["percent"] == 50 and second["not_finished"] == 1
    assert second["no_email"] == 0 and second["starts_in_days"] == 10


async def test_dashboard_expiring_translations_and_hard_questions(client, db, seeded_user):
    await offer_languages(db, "ja", "ko", "he")
    hdrs = await _manager(db, client)
    fork = await _doc(db, "Forklift safety", validity_days=365)
    never = await _doc(db, "Dress code")
    a, b, c = await _people(db, "Ann", "Bob", "Cy")
    await _sign(db, a, fork, days_ago=365 - 10)            # expires in 10 days
    await _sign(db, b, fork, days_ago=365 - 20)            # expires in 20 days
    await _sign(db, c, fork, days_ago=365 - 60)            # not within 30 days
    await _sign(db, a, never)                              # never expires
    # an older sign-off that a newer one replaced doesn't count
    await _sign(db, c, fork, days_ago=365 - 5)
    await _sign(db, c, fork, days_ago=1)

    # Hebrew translation of version 1 only; version 2 is current
    v1 = never.current_version_id
    db.add(LearningTranslation(version_id=v1, language="he", status="published",
                               title="x", content_html="<p>x</p>"))
    await db.commit()
    await _publish(db, never)

    # one question 5 of 10 attempts miss, and one 3 of 10 miss
    doc = await _doc(db, "Acme NDA")
    q_hard = LearningQuizQuestion(document_id=doc.id, prompt="Hard?", position=1,
                                  choices=[{"id": "a", "text": "A"}, {"id": "b", "text": "B"}],
                                  correct_choice_ids=["a"])
    q_ok = LearningQuizQuestion(document_id=doc.id, prompt="Fine?", position=2,
                                choices=[{"id": "a", "text": "A"}, {"id": "b", "text": "B"}],
                                correct_choice_ids=["a"])
    db.add_all([q_hard, q_ok])
    await db.commit()
    assignment = await _assignment(db, a, doc)
    for i in range(10):
        db.add(LearningQuizAttempt(
            assignment_id=assignment.id, score_percent=50, passed=False,
            answers={str(q_hard.id): ["b"] if i < 5 else ["a"],
                     str(q_ok.id): ["b"] if i < 3 else ["a"]}))
    await db.commit()

    body = (await client.get("/learning/dashboard", headers=hdrs)).json()
    assert body["expiring"] == [{
        "document_id": str(fork.id), "title": "Forklift safety", "people": 2,
        "first_date": (TODAY + timedelta(days=10)).isoformat()}]
    assert body["translation_issues"] == [{
        "document_id": str(never.id), "title": "Dress code", "language": "he"}]
    assert body["hard_questions"] == [{
        "question_id": str(q_hard.id), "document_title": "Acme NDA", "miss_percent": 50}]


# ── grid ─────────────────────────────────────────────────────────────


async def test_grid_states_including_expires_during(client, db, seeded_user):
    hdrs = await _manager(db, client)
    dress = await _doc(db, "Dress code", validity_days=365)
    forklift = await _doc(db, "Forklift safety", validity_days=365)
    site_rules = await _doc(db, "Site rules", resign_rule="every_initiative")
    move = await _initiative(db, "Acme move", start=TODAY + timedelta(days=5),
                             end=TODAY + timedelta(days=60))
    await _packet(db, [dress, site_rules])
    valid, expiring, missing, signed_here = (
        await _person(db, "Val", "Valid", "v@test.example.com"),
        await _person(db, "Exp", "Expiring", "e@test.example.com"),
        await _person(db, "Mia", "Missing", "m@test.example.com"),
        await _person(db, "Sig", "Signed", "s@test.example.com"))
    await _on(db, move, valid, expiring, missing, signed_here)
    await _sign(db, valid, dress, days_ago=10)
    await _sign(db, expiring, dress, days_ago=350)          # good until TODAY+15
    await _sign(db, signed_here, dress, days_ago=10)
    await _sign(db, signed_here, site_rules, initiative=move, days_ago=1)
    await _sign(db, valid, site_rules, days_ago=30)         # another move's: not this one's
    # Forklift is a manual extra for Mia only
    await _assignment(db, missing, forklift, move, source="manual")

    body = (await client.get(f"/learning/initiatives/{move.id}/grid", headers=hdrs)).json()
    assert [d["title"] for d in body["documents"]] == [
        "Dress code", "Forklift safety", "Site rules"]
    ids = {d["title"]: d["id"] for d in body["documents"]}
    cells = {row["name"]: {t: row["cells"][i] for t, i in ids.items()} for row in body["rows"]}
    assert [row["name"] for row in body["rows"]] == [
        "Exp Expiring", "Mia Missing", "Sig Signed", "Val Valid"]

    assert cells["Val Valid"]["Dress code"]["state"] == "valid"
    assert cells["Val Valid"]["Forklift safety"]["state"] == "not_required"
    assert cells["Val Valid"]["Site rules"]["state"] == "missing"     # re-sign every initiative
    assert cells["Exp Expiring"]["Dress code"]["state"] == "expires_during"
    assert (TODAY + timedelta(days=15)).strftime("%b") in cells[
        "Exp Expiring"]["Dress code"]["label"]
    assert cells["Mia Missing"]["Dress code"]["state"] == "missing"
    assert cells["Mia Missing"]["Forklift safety"]["state"] == "missing"
    assert cells["Sig Signed"]["Site rules"]["state"] == "valid"
    assert cells["Sig Signed"]["Dress code"]["state"] == "valid"
    for row in cells.values():
        for cell in row.values():
            assert cell["label"]


async def test_grid_open_ended_initiative_never_expires_during(client, db, seeded_user):
    hdrs = await _manager(db, client)
    dress = await _doc(db, "Dress code", validity_days=365)
    move = await _initiative(db, "Open ended", start=TODAY + timedelta(days=5))
    await _packet(db, [dress])
    worker = await _person(db, "Exp", "Expiring", "e@test.example.com")
    await _on(db, move, worker)
    await _sign(db, worker, dress, days_ago=350)
    body = (await client.get(f"/learning/initiatives/{move.id}/grid", headers=hdrs)).json()
    assert body["rows"][0]["cells"][body["documents"][0]["id"]]["state"] == "valid"
    assert (await client.get(f"/learning/initiatives/{uuid.uuid4()}/grid",
                             headers=hdrs)).status_code == 404


# ── history ──────────────────────────────────────────────────────────


async def _worker_of(db, partner, first="Hal", email="hal@test.example.com"):
    person = Person(first_name=first, last_name="History", email=email)
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="worker"))
    db.add(WorkerProfile(person_id=person.id, status="active", partner_id=partner.id))
    await db.commit()
    return person


async def test_history_scoped(client, db, seeded_user):
    hdrs = await _manager(db, client)
    mine, other = Partner(name="Northwind"), Partner(name="Other Co")
    db.add_all([mine, other])
    await db.commit()
    worker = await _worker_of(db, mine)
    stranger = await _worker_of(db, other, "Sam", "sam@test.example.com")
    doc = await _doc(db, "Acme NDA", validity_days=365)
    move = await _initiative(db, "Acme move")
    admin = await _person(db, "Ada", "Admin")
    await _sign(db, worker, doc, initiative=move, quiz_score=88, read_seconds=140,
                signature=_png())
    assignment = await _assignment(db, worker, doc, move, status="signed", signed=NOW)
    db.add(LearningQuizAttempt(assignment_id=assignment.id, score_percent=60, passed=False,
                               answers={}, created_at=NOW - timedelta(hours=1)))
    db.add(LearningQuizAttempt(assignment_id=assignment.id, score_percent=88, passed=True,
                               answers={}, created_at=NOW))
    await db.commit()
    other_doc = await _doc(db, "Forklift safety")
    await _assignment(db, worker, other_doc, move)
    await _override(db, worker, admin, initiative=move)

    body = (await client.get(f"/learning/people/{worker.id}/history", headers=hdrs)).json()
    assert body["person"]["name"] == "Hal History"
    assert len(body["signoffs"]) == 1
    signoff = body["signoffs"][0]
    assert signoff["document"] == "Acme NDA" and signoff["version"] == 1
    assert signoff["language"] == "en" and signoff["read_seconds"] == 140
    assert signoff["quiz_score"] == 88 and signoff["signed_at"]
    assert "signature_png" not in signoff
    assert [a["score_percent"] for a in body["quiz_attempts"]] == [88, 60]
    assert body["quiz_attempts"][0]["document"] == "Acme NDA"
    assert [o["reason"] for o in body["overrides"]] == ["signed_on_paper"]
    assert body["overrides"][0]["admin"] == "Ada Admin"
    assert [a["document"] for a in body["open_assignments"]] == ["Forklift safety"]
    assert body["open_assignments"][0]["initiative"] == "Acme move"

    # a partner's own admin sees their worker, not someone else's (404, no probing)
    contact = await _person(db, "Vic", "Vendor", "vic@test.example.com")
    db.add(PersonRole(person_id=contact.id, role="vendor_admin", partner_id=mine.id))
    await db.commit()
    vendor = await make_login(db, client, contact, "vic@test.example.com")
    seen = await client.get(f"/learning/people/{worker.id}/history", headers=vendor)
    assert seen.status_code == 200
    # a partner contact can't see initiatives: ids stay, names don't
    assert seen.json()["signoffs"][0]["initiative_id"] == str(move.id)
    for key in ("signoffs", "overrides", "open_assignments"):
        rows = seen.json()[key]
        assert rows and all(r["initiative"] is None and r["initiative_id"] for r in rows)
    assert body["signoffs"][0]["initiative"] == "Acme move"
    # the certificate (typed names, signatures) is for learning managers only
    forbidden = await client.get(f"/learning/people/{worker.id}/certificate.pdf",
                                 headers=vendor)
    assert forbidden.status_code == 403
    assert (await client.get(f"/learning/people/{stranger.id}/history",
                             headers=vendor)).status_code == 404
    # someone with neither learning nor workers view is refused
    viewer = await _person(db, "Cat", "Client", "cat@test.example.com")
    db.add(PersonRole(person_id=viewer.id, role="external"))
    await db.commit()
    nobody = await make_login(db, client, viewer, "cat@test.example.com")
    assert (await client.get(f"/learning/people/{worker.id}/history",
                             headers=nobody)).status_code == 403
    assert (await client.get(f"/learning/people/{worker.id}/certificate.pdf",
                             headers=nobody)).status_code == 403
    # a worker with an account reads their own history
    own = await make_login(db, client, worker, "hal@test.example.com")
    assert (await client.get(f"/learning/people/{worker.id}/history",
                             headers=own)).status_code == 200
    # managers get a 404 for a person who doesn't exist
    assert (await client.get(f"/learning/people/{uuid.uuid4()}/history",
                             headers=hdrs)).status_code == 404


# ── certificate ──────────────────────────────────────────────────────


async def test_certificate_pdf(client, db, seeded_user):
    hdrs = await _manager(db, client)
    worker = await _worker(db, "Cora", "Certified", "cora@test.example.com")
    dress = await _doc(db, "Dress code")
    nda = await _doc(db, "Acme NDA")
    move = await _initiative(db, "Acme DFW move")
    elsewhere = await _initiative(db, "Other move")
    await _publish(db, nda)                              # version 2 is current
    await _sign(db, worker, dress, initiative=move, days_ago=3)
    await _sign(db, worker, nda, initiative=move, days_ago=2, signature=_png(),
                language="es", quiz_score=92)
    await _sign(db, worker, dress, initiative=elsewhere, days_ago=9)

    resp = await client.get(f"/learning/people/{worker.id}/certificate.pdf", headers=hdrs,
                            params={"initiative_id": str(move.id)})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")
    assert "attachment" in resp.headers["content-disposition"]
    everything = await client.get(f"/learning/people/{worker.id}/certificate.pdf",
                                  headers=hdrs)
    assert everything.status_code == 200 and everything.content.startswith(b"%PDF")

    html = await certificate.certificate_html(db, worker.id, initiative_id=move.id)
    assert "Cora Certified" in html and "Acme DFW move" in html
    assert "Dress code" in html and "Acme NDA" in html
    assert "Version 2" in html or "v2" in html
    assert "data:image/png;base64," in html             # the drawn signature
    assert html.count("Dress code") == 1                # the other move's sign-off is out
    whole = await certificate.certificate_html(db, worker.id, initiative_id=None)
    assert whole.count("Dress code") == 2
    assert base64.b64encode(_png()).decode() in whole

    assert (await client.get(f"/learning/people/{uuid.uuid4()}/certificate.pdf",
                             headers=hdrs)).status_code == 404


async def test_certificate_initiative_must_be_on_the_persons_record(client, db, seeded_user):
    hdrs = await _manager(db, client)
    worker = await _worker(db, "Cora", "Certified", "cora@test.example.com")
    dress = await _doc(db, "Dress code")
    mine = await _initiative(db, "Mine")
    assigned = await _initiative(db, "Only assigned")
    secret = await _initiative(db, "Someone else's secret move")
    await _sign(db, worker, dress, initiative=mine)
    await _assignment(db, worker, dress, assigned)
    path = f"/learning/people/{worker.id}/certificate.pdf"
    for ok in (mine, assigned):
        resp = await client.get(path, headers=hdrs, params={"initiative_id": str(ok.id)})
        assert resp.status_code == 200, resp.text
    for bad in (secret.id, uuid.uuid4()):
        resp = await client.get(path, headers=hdrs, params={"initiative_id": str(bad)})
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "initiative_not_found"
    with pytest.raises(HTTPException):
        await certificate.certificate_html(db, worker.id, initiative_id=secret.id)


async def test_certificate_without_signoffs_still_renders(client, db, seeded_user):
    hdrs = await _manager(db, client)
    worker = await _worker(db, "Nia", "Nothing", "nia@test.example.com")
    resp = await client.get(f"/learning/people/{worker.id}/certificate.pdf", headers=hdrs)
    assert resp.status_code == 200 and resp.content.startswith(b"%PDF")


# ── lean queries ─────────────────────────────────────────────────────


async def _roster_of(db, count, prefix):
    dress = await _doc(db, f"{prefix} dress", validity_days=365)
    nda = await _doc(db, f"{prefix} NDA")
    partner = Partner(name=f"{prefix} partner")
    db.add(partner)
    await db.commit()
    move = await _initiative(db, f"{prefix} move", start=TODAY + timedelta(days=5),
                             end=TODAY + timedelta(days=60))
    await _packet(db, [dress, nda], name=f"{prefix} packet")
    for i in range(count):
        person = await _person(db, f"{prefix}{i}", "Roster", f"{prefix}{i}@test.example.com")
        db.add(WorkerProfile(person_id=person.id, status="active", partner_id=partner.id))
        db.add(InitiativePerson(initiative_id=move.id, person_id=person.id,
                                work_type="lead" if i % 2 else "tech"))
        await db.commit()
        if i % 2:
            await _sign(db, person, dress, days_ago=10, signature=_png())
    return move


async def _statements(db, work):
    from sqlalchemy import event
    seen: list[str] = []

    def count(conn, cursor, statement, *args):
        seen.append(statement)

    engine = db.bind.sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        await work()
    finally:
        event.remove(engine, "before_cursor_execute", count)
    return seen


async def test_grid_query_count_does_not_grow_with_the_roster(db, seeded_user):
    small = await _roster_of(db, 3, "S")
    large = await _roster_of(db, 10, "L")
    first = await _statements(db, lambda: stats.grid(db, small))
    second = await _statements(db, lambda: stats.grid(db, large))
    assert len(first) == len(second)
    # and the signature image is never read
    assert not any("signature_png" in q for q in first + second)
    assert len((await stats.grid(db, large))["rows"]) == 10


async def test_dashboard_and_history_never_read_signature_images(db, seeded_user):
    move = await _roster_of(db, 4, "D")
    person = await db.scalar(select(Person).where(Person.first_name == "D1"))

    async def work():
        await stats.dashboard(db, 30)
        await stats.history(db, person)
        await learning_compliance.gather.gather(db, move.id)
        await learning_compliance.gather.gather(db, None)

    statements = await _statements(db, work)
    assert statements and not any("signature_png" in q for q in statements)


async def test_plan_many_matches_plan_for(db, seeded_user):
    move = await _roster_of(db, 5, "P")
    ids = list(await db.scalars(select(InitiativePerson.person_id).where(
        InitiativePerson.initiative_id == move.id)))
    many = await assign.plan_many(db, ids, move.id)
    for pid in ids:
        assert many[pid] == await assign.plan_for(db, pid, move.id)
    assert any(item.action == "skip" for items in many.values() for item in items)
    assert any(item.action == "assign" for items in many.values() for item in items)


# ── windows ──────────────────────────────────────────────────────────


async def test_at_risk_window_edges(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    worker = await _person(db, "Ann", "A", "a@test.example.com")
    names = {}
    for label, offset in (("Yesterday", -1), ("Today", 0), ("Day 30", 30), ("Day 31", 31)):
        move = await _initiative(db, label, start=TODAY + timedelta(days=offset))
        names[label] = move
        await _assignment(db, worker, doc, move)
    body = (await client.get("/learning/dashboard", headers=hdrs)).json()
    assert sorted(r["name"] for r in body["at_risk"]) == ["Day 30", "Today"]
    assert {r["name"]: r["starts_in_days"] for r in body["at_risk"]} == {
        "Today": 0, "Day 30": 30}


async def test_hard_questions_only_count_attempts_in_the_window(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Acme NDA")
    question = LearningQuizQuestion(
        document_id=doc.id, prompt="Hard?", position=1, correct_choice_ids=["a"],
        choices=[{"id": "a", "text": "A"}, {"id": "b", "text": "B"}])
    db.add(question)
    await db.commit()
    worker = await _person(db, "Ann", "A", "a@test.example.com")
    assignment = await _assignment(db, worker, doc)
    for i in range(12):
        db.add(LearningQuizAttempt(
            assignment_id=assignment.id, score_percent=0, passed=False,
            answers={str(question.id): ["b"]}, created_at=NOW - timedelta(days=20 + i * 5)))
    await db.commit()
    # 12 misses overall; only the first 2 fall inside 30 days, the first 5 inside 60
    def hard(days):
        return client.get("/learning/dashboard", headers=hdrs, params={"days": days})

    assert (await hard(30)).json()["hard_questions"] == []
    assert (await hard(90)).json()["hard_questions"][0]["miss_percent"] == 100
