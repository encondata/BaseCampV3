"""The worker side of the learn site: my training (grouped by initiative,
with order locks), reading an assignment (current version, translation or
English fallback, opened once), the quiz (no answers out, exact-set
grading, the lock after the last attempt) and signing with every server-
side check. Every route acts on the caller's own rows only."""
import base64
import io
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image
from sqlalchemy import select

from serversherpa.db.models import EmailOutbox, Notification, Person
from serversherpa.learning import sessions, worker
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningQuizAttempt,
    LearningQuizQuestion,
    LearningSignoff,
    LearningTranslation,
)
from tests.test_learning_assign import _doc, _initiative, _manager, _publish, _today

# ── helpers ──────────────────────────────────────────────────────────


async def _learner(db, first="Wanda", last="Worker", email=None):
    person = Person(first_name=first, last_name=last,
                    email=email or f"{uuid.uuid4().hex[:8]}@test.example.com")
    db.add(person)
    await db.flush()
    token = await sessions.start(db, code=None, person_id=person.id, ip=None, user_agent=None)
    await db.commit()
    return person, {"Authorization": f"Learn {token}"}


async def _assign(db, person, doc, *, initiative=None, packet=None, due_on=None,
                  opened_ago=None):
    row = LearningAssignment(
        person_id=person.id, initiative_id=initiative.id if initiative else None,
        document_id=doc.id, version_id=doc.current_version_id,
        packet_id=packet.id if packet else None, source="manual", due_on=due_on)
    if opened_ago is not None:
        row.status = "opened"
        row.opened_at = datetime.now(UTC) - timedelta(seconds=opened_ago)
    db.add(row)
    await db.commit()
    return row


async def _plain_doc(db, title="Site safety", **settings):
    doc = await _doc(db, title)
    for key, value in {"require_scroll": False, "sign_style": "checkbox", **settings}.items():
        setattr(doc, key, value)
    await db.commit()
    return doc


async def _question(db, doc, prompt, choices, correct, *, translations=None, position=0):
    q = LearningQuizQuestion(
        document_id=doc.id, prompt=prompt,
        choices=[{"id": cid, "text": text} for cid, text in choices],
        correct_choice_ids=correct, translations=translations or {}, position=position)
    db.add(q)
    await db.commit()
    return q


def _png_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), "white").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


SIGN = {"agreed": True, "language": "en", "scrolled_to_end": True}


async def _fresh(db, row):
    return await db.scalar(select(LearningAssignment).where(LearningAssignment.id == row.id)
                           .execution_options(populate_existing=True))


# ── my training ──────────────────────────────────────────────────────


async def test_training_lists_only_own_assignments(client, db, seeded_user):
    move = await _initiative(db, "Acme DFW move", start=_today() + timedelta(days=5),
                             end=_today() + timedelta(days=20))
    safety = await _plain_doc(db, "Site safety")
    nda = await _plain_doc(db, "Acme NDA", quiz_enabled=True, quiz_pass_percent=100)
    await _question(db, nda, "Share photos?", [("a", "Yes"), ("b", "No")], ["b"])
    extra = await _plain_doc(db, "Forklift basics")
    wanda, hdrs = await _learner(db)
    other, _ = await _learner(db, "Otto", "Other")
    due = _today() + timedelta(days=3)
    a1 = await _assign(db, wanda, safety, initiative=move, due_on=due)
    await _assign(db, wanda, nda, initiative=move, due_on=due + timedelta(days=1))
    await _assign(db, wanda, extra)
    await _assign(db, other, safety, initiative=move)

    r = await client.get("/learn/training", headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["complete"] is False and body["badge_uid"] is None
    by_initiative = {(g["initiative"] or {}).get("id"): g for g in body["groups"]}
    assert set(by_initiative) == {str(move.id), None}
    group = by_initiative[str(move.id)]
    assert group["initiative"] == {"id": str(move.id), "name": "Acme DFW move",
                                   "start": (_today() + timedelta(days=5)).isoformat()}
    assert group["due_on"] == due.isoformat()
    items = {i["title"]: i for i in group["items"]}
    assert set(items) == {"Site safety", "Acme NDA"}
    assert items["Site safety"]["assignment_id"] == str(a1.id)
    assert items["Site safety"]["status"] == "assigned"
    assert items["Site safety"]["locked"] is False
    assert items["Site safety"]["signed_at"] is None
    assert items["Site safety"]["minutes"] >= 1
    assert items["Acme NDA"]["has_quiz"] is True and items["Site safety"]["has_quiz"] is False
    assert [i["title"] for i in by_initiative[None]["items"]] == ["Forklift basics"]

    # everything signed: complete, with the time clock code
    for row in await db.scalars(select(LearningAssignment).where(
            LearningAssignment.person_id == wanda.id)):
        row.status = "signed"
        row.signed_at = datetime.now(UTC)
    await db.commit()
    body = (await client.get("/learn/training", headers=hdrs)).json()
    assert body["complete"] is True
    assert body["badge_uid"] == str(wanda.badge_uid)
    signed = [i for g in body["groups"] for i in g["items"]]
    assert all(i["status"] == "signed" and i["signed_at"] for i in signed)

    # no learn session, no list
    assert (await client.get("/learn/training")).status_code == 401


async def test_other_persons_assignment_404(client, db, seeded_user):
    doc = await _plain_doc(db)
    await _question(db, doc, "Q?", [("a", "A"), ("b", "B")], ["a"])
    doc.quiz_enabled, doc.quiz_pass_percent = True, 100
    await db.commit()
    _, hdrs = await _learner(db)
    other, _ = await _learner(db, "Otto", "Other")
    theirs = await _assign(db, other, doc, opened_ago=600)
    base = f"/learn/assignments/{theirs.id}"
    for r in (await client.get(base, headers=hdrs),
              await client.get(f"{base}/quiz", headers=hdrs),
              await client.post(f"{base}/quiz", headers=hdrs, json={"answers": {}}),
              await client.post(f"{base}/sign", headers=hdrs, json=SIGN),
              await client.get(f"/learn/assignments/{uuid.uuid4()}", headers=hdrs)):
        assert r.status_code == 404, r.text
    row = await _fresh(db, theirs)
    assert row.status == "opened" and row.signoff_id is None
    assert await db.scalar(select(LearningQuizAttempt.id)) is None


# ── reading ──────────────────────────────────────────────────────────


async def test_translation_used_or_fallback(client, db, seeded_user):
    doc = await _plain_doc(db, "Dress code")
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    # a newer version after the assignment: that's the one read
    v2 = await _publish(db, doc)
    v2.content_html, v2.change_note = "<p>English v2</p>", "Boots required"
    db.add_all([
        LearningTranslation(version_id=v2.id, language="ja", status="published",
                            title="服装規定", content_html="<p>日本語</p>"),
        LearningTranslation(version_id=v2.id, language="ko", status="draft",
                            title="복장", content_html="<p>한국어</p>"),
    ])
    await db.commit()

    ja = (await client.get(f"/learn/assignments/{row.id}?lang=ja", headers=hdrs)).json()
    assert (ja["title"], ja["html"], ja["language"], ja["fallback"]) == (
        "服装規定", "<p>日本語</p>", "ja", False)
    assert ja["version_no"] == 2 and ja["change_note"] == "Boots required"
    assert (ja["sign_style"], ja["require_scroll"], ja["min_read_seconds"]) == (
        "checkbox", False, None)
    assert ja["has_quiz"] is False and ja["quiz_passed"] is False

    ko = (await client.get(f"/learn/assignments/{row.id}?lang=ko", headers=hdrs)).json()
    assert (ko["title"], ko["html"], ko["language"], ko["fallback"]) == (
        "Dress code", "<p>English v2</p>", "en", True)
    en = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert (en["language"], en["fallback"]) == ("en", False)

    # the sign-off records the version shown and the language read; a
    # language with no published translation is recorded as English
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "language": "ko"})
    assert r.status_code == 200, r.text
    signoff = await db.scalar(select(LearningSignoff))
    assert signoff.version_id == v2.id and signoff.language == "en"


async def test_open_sets_opened_at_once(client, db, seeded_user):
    doc = await _plain_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    assert (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).status_code == 200
    first = await _fresh(db, row)
    assert first.status == "opened" and first.opened_at is not None
    opened_at = first.opened_at
    assert (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).status_code == 200
    again = await _fresh(db, row)
    assert again.opened_at == opened_at and again.status == "opened"


# ── signing ──────────────────────────────────────────────────────────


SIGN_CASES = {
    "must_agree": ({}, {"agreed": False}),
    "name_required": ({"sign_style": "typed_name"}, {"typed_name": "   "}),
    "signature_required": ({"sign_style": "drawn_signature"}, {}),
    "signature_invalid": ({"sign_style": "drawn_signature"},
                          {"signature_png_b64": base64.b64encode(b"GIF89a....").decode()}),
    "scroll_required": ({"require_scroll": True}, {"scrolled_to_end": False}),
    "quiz_required": ({"quiz_enabled": True, "quiz_pass_percent": 100}, {}),
    "read_time": ({"min_read_seconds": 3600}, {}),
}


@pytest.mark.parametrize("code", list(SIGN_CASES))
async def test_sign_validations(client, db, seeded_user, code):
    settings, body = SIGN_CASES[code]
    doc = await _plain_doc(db, **settings)
    if settings.get("quiz_enabled"):
        await _question(db, doc, "Q?", [("a", "A"), ("b", "B")], ["a"])
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, **body})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == code
    assert (await _fresh(db, row)).status == "opened"
    assert await db.scalar(select(LearningSignoff.id)) is None


async def test_sign_styles_store_name_and_signature(client, db, seeded_user):
    typed = await _plain_doc(db, "Typed", sign_style="typed_name")
    drawn = await _plain_doc(db, "Drawn", sign_style="drawn_signature")
    wanda, hdrs = await _learner(db)
    t = await _assign(db, wanda, typed, opened_ago=30)
    d = await _assign(db, wanda, drawn, opened_ago=30)
    r = await client.post(f"/learn/assignments/{t.id}/sign", headers=hdrs,
                          json={**SIGN, "typed_name": "  Wanda Worker "})
    assert r.status_code == 200, r.text
    png = _png_b64()
    r = await client.post(f"/learn/assignments/{d.id}/sign", headers=hdrs,
                          json={**SIGN, "signature_png_b64": f"data:image/png;base64,{png}"})
    assert r.status_code == 200, r.text
    by_doc = {s.document_id: s for s in await db.scalars(select(LearningSignoff))}
    assert by_doc[typed.id].typed_name == "Wanda Worker"
    assert by_doc[drawn.id].signature_png == base64.b64decode(png)
    row = await _fresh(db, t)
    assert row.status == "signed" and row.signoff_id == by_doc[typed.id].id
    assert row.signed_at is not None
    # signed once: a second sign is refused
    again = await client.post(f"/learn/assignments/{t.id}/sign", headers=hdrs,
                              json={**SIGN, "typed_name": "Wanda Worker"})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "already_signed"


async def test_sign_refuses_a_version_published_after_it_was_shown(client, db, seeded_user):
    doc = await _plain_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=30)
    shown = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert shown["version_no"] == 1
    await _publish(db, doc)                       # v2 goes live while Wanda reads v1
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "version_no": 1})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "version_changed"
    assert await db.scalar(select(LearningSignoff.id)) is None
    assert (await _fresh(db, row)).status == "opened"
    # signing the version now shown records that one
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "version_no": 2})
    assert r.status_code == 200, r.text
    signoff = await db.scalar(select(LearningSignoff))
    assert signoff.version_id == doc.current_version_id


async def test_min_read_time_enforced_server_side(client, db, seeded_user):
    doc = await _plain_doc(db, min_read_seconds=120)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    # opening now starts the clock; signing straight away is refused even
    # though the client claims it scrolled
    await client.get(f"/learn/assignments/{row.id}", headers=hdrs)
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "read_time"
    assert 0 < r.json()["detail"]["seconds_left"] <= 120
    # never opened at all: the same refusal
    unopened = await _assign(db, wanda, await _plain_doc(db, "Other", min_read_seconds=5))
    r = await client.post(f"/learn/assignments/{unopened.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "read_time"

    fresh = await _fresh(db, row)
    fresh.opened_at = datetime.now(UTC) - timedelta(seconds=125)
    await db.commit()
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 200, r.text
    signoff = await db.scalar(select(LearningSignoff))
    assert 125 <= signoff.read_seconds < 140


# ── quiz ─────────────────────────────────────────────────────────────


async def _quiz_doc(db, **settings):
    doc = await _plain_doc(db, "Acme NDA", quiz_enabled=True, quiz_pass_percent=100,
                           **settings)
    q1 = await _question(db, doc, "Can you post photos?", [("a", "Yes"), ("b", "No")], ["b"],
                         translations={"ja": {"prompt": "写真?", "choices": {"a": "はい",
                                                                             "b": "いいえ"}}})
    q2 = await _question(db, doc, "Which are PPE?",
                         [("a", "Boots"), ("b", "Gloves"), ("c", "Phone")], ["a", "b"],
                         position=1)
    archived = await _question(db, doc, "Old question", [("a", "A")], ["a"], position=2)
    archived.archived_at = datetime.now(UTC)
    await db.commit()
    return doc, q1, q2


async def test_quiz_answers_never_returned(client, db, seeded_user):
    doc, q1, q2 = await _quiz_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=10)
    r = await client.get(f"/learn/assignments/{row.id}/quiz", headers=hdrs)
    assert r.status_code == 200, r.text
    assert "correct" not in r.text
    questions = {q["id"]: q for q in r.json()}
    assert set(questions) == {str(q1.id), str(q2.id)}           # archived left out
    assert set(questions[str(q1.id)]) == {"id", "prompt", "choices", "multiple"}
    assert questions[str(q1.id)]["multiple"] is False
    assert questions[str(q2.id)]["multiple"] is True
    for q in questions.values():
        for choice in q["choices"]:
            assert set(choice) == {"id", "text"}
    # shuffled per request: the same questions and choices, in some order
    orders = set()
    for _ in range(12):
        body = (await client.get(f"/learn/assignments/{row.id}/quiz", headers=hdrs)).json()
        orders.add(tuple(q["id"] for q in body) + tuple(
            c["id"] for q in body for c in q["choices"]))
    assert len(orders) > 1
    # the question's own translation when there is one
    ja = (await client.get(f"/learn/assignments/{row.id}/quiz?lang=ja", headers=hdrs)).json()
    q = next(x for x in ja if x["id"] == str(q1.id))
    assert q["prompt"] == "写真?"
    assert {c["id"]: c["text"] for c in q["choices"]} == {"a": "はい", "b": "いいえ"}
    q = next(x for x in ja if x["id"] == str(q2.id))
    assert q["prompt"] == "Which are PPE?"


async def test_quiz_grading_and_lock(client, db, seeded_user):
    hdrs_manager = await _manager(db, client)
    assert hdrs_manager
    doc, q1, q2 = await _quiz_doc(db, quiz_fail_action="lock", quiz_max_attempts=2)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=10)
    url = f"/learn/assignments/{row.id}/quiz"

    # half right (the multiple-choice one is only a subset): 50 %, not passed
    r = await client.post(url, headers=hdrs, json={"answers": {
        str(q1.id): ["b"], str(q2.id): ["a"]}})
    assert r.status_code == 200, r.text
    assert r.json() == {"score_percent": 50, "passed": False, "attempts_left": 1,
                        "locked": False}
    # the last attempt fails: locked, managers told (inbox only)
    r = await client.post(url, headers=hdrs, json={"answers": {
        str(q1.id): ["b"], str(q2.id): ["a", "b", "c"]}})
    assert r.json() == {"score_percent": 50, "passed": False, "attempts_left": 0,
                        "locked": True}
    assert (await _fresh(db, row)).quiz_locked_at is not None
    [note] = await db.scalars(select(Notification).where(
        Notification.kind == "learning_quiz_locked"))
    assert note.person_id != wanda.id and "Acme NDA" in note.title
    assert await db.scalar(select(EmailOutbox.id).where(
        EmailOutbox.person_id == note.person_id)) is None
    # locked: no more attempts, no sign-off
    again = await client.post(url, headers=hdrs, json={"answers": {
        str(q1.id): ["b"], str(q2.id): ["a", "b"]}})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "locked"
    sign = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
    assert sign.status_code == 409 and sign.json()["detail"]["code"] == "locked"
    assert len(list(await db.scalars(select(LearningQuizAttempt)))) == 2

    # an exact match on every question passes, and then signing works
    other = await _assign(db, wanda, (await _quiz_doc(db))[0], opened_ago=10)
    questions = (await client.get(f"/learn/assignments/{other.id}/quiz", headers=hdrs)).json()
    rows = {q.id: q for q in await db.scalars(select(LearningQuizQuestion))}
    answers = {q["id"]: list(rows[uuid.UUID(q["id"])].correct_choice_ids) for q in questions}
    r = await client.post(f"/learn/assignments/{other.id}/quiz", headers=hdrs,
                          json={"answers": answers})
    assert r.json() == {"score_percent": 100, "passed": True, "attempts_left": None,
                        "locked": False}
    reading = (await client.get(f"/learn/assignments/{other.id}", headers=hdrs)).json()
    assert reading["has_quiz"] is True and reading["quiz_passed"] is True
    r = await client.post(f"/learn/assignments/{other.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 200, r.text
    signoff = await db.scalar(select(LearningSignoff).where(
        LearningSignoff.assignment_id == other.id))
    assert signoff.quiz_score == 100


# ── order ────────────────────────────────────────────────────────────


async def test_enforce_order_locks_later_items(client, db, seeded_user):
    first, second = await _plain_doc(db, "First"), await _plain_doc(db, "Second")
    packet = LearningPacket(name="Ordered", enforce_order=True)
    db.add(packet)
    await db.flush()
    db.add_all([LearningPacketItem(packet_id=packet.id, document_id=first.id, position=0),
                LearningPacketItem(packet_id=packet.id, document_id=second.id, position=1)])
    await db.commit()
    move = await _initiative(db)
    wanda, hdrs = await _learner(db)
    # created in either order; the packet's order decides
    b = await _assign(db, wanda, second, initiative=move, packet=packet)
    a = await _assign(db, wanda, first, initiative=move, packet=packet)

    [group] = (await client.get("/learn/training", headers=hdrs)).json()["groups"]
    assert [(i["title"], i["locked"]) for i in group["items"]] == [
        ("First", False), ("Second", True)]
    for r in (await client.get(f"/learn/assignments/{b.id}", headers=hdrs),
              await client.post(f"/learn/assignments/{b.id}/sign", headers=hdrs, json=SIGN)):
        assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"
    assert (await _fresh(db, b)).opened_at is None

    await client.get(f"/learn/assignments/{a.id}", headers=hdrs)
    assert (await client.post(f"/learn/assignments/{a.id}/sign", headers=hdrs,
                              json=SIGN)).status_code == 200
    [group] = (await client.get("/learn/training", headers=hdrs)).json()["groups"]
    assert [(i["title"], i["locked"]) for i in group["items"]] == [
        ("First", False), ("Second", False)]
    await client.get(f"/learn/assignments/{b.id}", headers=hdrs)
    assert (await client.post(f"/learn/assignments/{b.id}/sign", headers=hdrs,
                              json=SIGN)).status_code == 200


# ── history ──────────────────────────────────────────────────────────


async def _sign(client, hdrs, row):
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 200, r.text
    return r.json()


async def test_history_lists_own_signoffs_newest_first(client, db, seeded_user):
    safety, nda, open_doc = (await _plain_doc(db, "Site safety"), await _plain_doc(db, "Acme NDA"),
                             await _plain_doc(db, "Still open"))
    move = await _initiative(db, "Acme move")
    wanda, hdrs = await _learner(db)
    otto, otto_hdrs = await _learner(db, "Otto", "Other")
    first = await _assign(db, wanda, safety)
    second = await _assign(db, wanda, nda, initiative=move)
    await _assign(db, wanda, open_doc)
    other = await _assign(db, otto, safety)
    for who, row in ((hdrs, first), (hdrs, second), (otto_hdrs, other)):
        await _sign(client, who, row)

    r = await client.get("/learn/history", headers=hdrs)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [x["title"] for x in rows] == ["Acme NDA", "Site safety"]
    nda_row, safety_row = rows
    assert nda_row["initiative"] == {"id": str(move.id), "name": "Acme move"}
    assert safety_row["initiative"] is None
    assert nda_row["assignment_id"] == str(second.id)
    assert safety_row["assignment_id"] == str(first.id)
    for x in rows:
        assert (x["version_no"], x["language"], x["newer_version"]) == (1, "en", False)
        assert x["signed_at"]
    assert (await client.get("/learn/history")).status_code == 401


async def test_history_keeps_old_version_and_ended_moves(client, db, seeded_user):
    doc = await _plain_doc(db, "Site safety")
    gone = await _plain_doc(db, "Withdrawn")
    ended = await _initiative(db, "Old move", start=_today() - timedelta(days=20),
                              end=_today() - timedelta(days=5))
    wanda, hdrs = await _learner(db)
    signed = await _assign(db, wanda, doc, initiative=ended)
    cancelled = await _assign(db, wanda, gone)
    await _sign(client, hdrs, signed)
    await _sign(client, hdrs, cancelled)
    (await _fresh(db, cancelled)).status = "cancelled"
    await db.commit()

    doc.title = "Site safety v2"
    await _publish(db, doc)
    await _assign(db, wanda, doc)                 # the v2 assignment, general training

    groups = (await client.get("/learn/training", headers=hdrs)).json()["groups"]
    assert [g["initiative"] for g in groups] == [None]

    [row] = (await client.get("/learn/history", headers=hdrs)).json()
    assert row["assignment_id"] == str(signed.id)
    assert (row["title"], row["version_no"], row["newer_version"]) == ("Site safety", 1, True)
    assert row["initiative"]["name"] == "Old move"


async def test_read_signed_assignment_reports_signed_at(client, db, seeded_user):
    doc = await _plain_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    before = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert before["signed_at"] is None

    signed = await _sign(client, hdrs, row)
    await _publish(db, doc)
    after = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert after["signed_at"] == signed["signed_at"]
    assert after["version_no"] == 1


# ── slides ───────────────────────────────────────────────────────────


async def _set_html(db, doc, html):
    version = await db.get(LearningDocumentVersion, doc.current_version_id)
    version.content_html = html
    await db.commit()


async def test_read_slides_document_returns_slides(client, db, seeded_user):
    doc = await _plain_doc(db, reading_style="slides")
    await _set_html(db, doc, "<p>Intro</p><h2>A</h2><p>a</p>")
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    body = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert body["reading_style"] == "slides"
    assert body["slides"] == ["<p>Intro</p>", "<h2>A</h2><p>a</p>"]
    assert body["slide_count"] == 2 and body["slide_reached"] is None


async def test_read_slides_reports_reached_for_the_served_version_and_language(
        client, db, seeded_user):
    doc = await _plain_doc(db, reading_style="slides")
    await _set_html(db, doc, "<h2>A</h2><p>a</p><h2>B</h2><p>b</p>")
    version_id = doc.current_version_id
    db.add(LearningTranslation(version_id=version_id, language="ja", status="published",
                               title="ja", content_html="<h2>あ</h2><h2>い</h2><h2>う</h2>"))
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    row.slide_reached, row.slide_version_id, row.slide_language = 1, version_id, "en"
    await db.commit()

    en = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert en["slide_count"] == 2 and en["slide_reached"] == 1
    # progress was made in English: the Japanese read starts over, with its own slides
    ja = (await client.get(f"/learn/assignments/{row.id}?lang=ja", headers=hdrs)).json()
    assert ja["slide_count"] == 3 and ja["slide_reached"] is None
    assert ja["slides"] == ["<h2>あ</h2>", "<h2>い</h2>", "<h2>う</h2>"]
    # an unpublished language falls back to English, and so does the progress
    ko = (await client.get(f"/learn/assignments/{row.id}?lang=ko", headers=hdrs)).json()
    assert ko["language"] == "en" and ko["slide_reached"] == 1


async def test_read_document_style_has_no_slides(client, db, seeded_user):
    doc = await _plain_doc(db)
    await _set_html(db, doc, "<p>Intro</p><h2>A</h2><p>a</p>")
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    body = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert body["reading_style"] == "document" and body["slides"] is None
    assert body["slide_count"] is None and body["slide_reached"] is None


async def test_served_html_and_effective_reached(db, seeded_user):
    doc = await _plain_doc(db)
    await _set_html(db, doc, "<p>English</p>")
    version = await db.get(LearningDocumentVersion, doc.current_version_id)
    db.add(LearningTranslation(version_id=version.id, language="ja", status="published",
                               title="ja", content_html="<p>日本語</p>"))
    db.add(LearningTranslation(version_id=version.id, language="ko", status="draft",
                               title="ko", content_html="<p>한국어</p>"))
    await db.commit()
    assert await worker.served_html(db, version, "ja") == ("<p>日本語</p>", "ja")
    assert await worker.served_html(db, version, "ko") == ("<p>English</p>", "en")
    assert await worker.served_html(db, version, None) == ("<p>English</p>", "en")

    wanda, _ = await _learner(db)
    row = await _assign(db, wanda, doc)
    assert worker.effective_reached(row, version.id, "en", 5) == -1
    row.slide_reached, row.slide_version_id, row.slide_language = 3, version.id, "en"
    assert worker.effective_reached(row, version.id, "en", 5) == 3
    assert worker.effective_reached(row, version.id, "ja", 5) == -1
    assert worker.effective_reached(row, uuid.uuid4(), "en", 5) == -1
    # a deck that no longer has the slide reached starts over
    assert worker.effective_reached(row, version.id, "en", 3) == -1
    assert worker.effective_reached(row, version.id, "en", 4) == 3


# ── slide progress and the sign gate ─────────────────────────────────

SLIDES_HTML = "<p>Intro</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>"


async def _slides_doc(db, html=SLIDES_HTML, **settings):
    doc = await _plain_doc(db, reading_style="slides", **settings)
    await _set_html(db, doc, html)
    return doc


async def _reach(client, hdrs, row, n, *, version_no=1, language="en"):
    return await client.post(f"/learn/assignments/{row.id}/slides/{n}", headers=hdrs,
                             json={"version_no": version_no, "language": language})


async def test_slides_reach_one_at_a_time(client, db, seeded_user):
    doc = await _slides_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc)
    v = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()["version_no"]
    url = f"/learn/assignments/{row.id}/slides"
    body = {"version_no": v, "language": "en"}

    skip = await client.post(f"{url}/1", headers=hdrs, json=body)
    assert skip.status_code == 422 and skip.json()["detail"]["code"] == "slide_not_reached"
    first = await client.post(f"{url}/0", headers=hdrs, json=body)
    assert first.json() == {"slide_reached": 0, "slide_count": 3}
    assert (await client.post(f"{url}/1", headers=hdrs, json=body)).json()["slide_reached"] == 1
    # going back keeps the furthest; asking for a reached slide again is harmless
    assert (await client.post(f"{url}/0", headers=hdrs, json=body)).json()["slide_reached"] == 1
    assert (await client.post(f"{url}/1", headers=hdrs, json=body)).json()["slide_reached"] == 1
    out = await client.post(f"{url}/3", headers=hdrs, json=body)
    assert out.status_code == 422 and out.json()["detail"]["code"] == "slide_out_of_range"
    assert (await client.post(f"{url}/-1", headers=hdrs, json=body)).status_code == 422
    assert (await client.get(f"/learn/assignments/{row.id}",
                             headers=hdrs)).json()["slide_reached"] == 1
    # the first slide opens the assignment like a read does
    assert (await _fresh(db, row)).status == "opened"


async def test_slides_reach_refusals(client, db, seeded_user):
    doc = await _slides_doc(db)
    wanda, hdrs = await _learner(db)
    _, otto_hdrs = await _learner(db, "Otto", "Other")
    row = await _assign(db, wanda, doc)
    assert (await _reach(client, otto_hdrs, row, 0)).status_code == 404
    assert (await _reach(client, hdrs, row, 0, version_no=7)).json()["detail"]["code"] \
        == "version_changed"
    assert (await _reach(client, hdrs, row, 0, language="xx-")).status_code == 422
    for n in range(3):
        assert (await _reach(client, hdrs, row, n)).status_code == 200
    row = await _fresh(db, row)
    row.opened_at = datetime.now(UTC) - timedelta(seconds=600)
    await db.commit()
    await _sign(client, hdrs, row)
    done = await _reach(client, hdrs, row, 0)
    assert done.status_code == 409 and done.json()["detail"]["code"] == "already_signed"


async def test_slides_reach_refused_while_locked(client, db, seeded_user):
    first, second = await _plain_doc(db, "First"), await _slides_doc(db)
    packet = LearningPacket(name="Ordered", enforce_order=True)
    db.add(packet)
    await db.flush()
    db.add_all([LearningPacketItem(packet_id=packet.id, document_id=first.id, position=0),
                LearningPacketItem(packet_id=packet.id, document_id=second.id, position=1)])
    await db.commit()
    move = await _initiative(db)
    wanda, hdrs = await _learner(db)
    await _assign(db, wanda, first, initiative=move, packet=packet)
    later = await _assign(db, wanda, second, initiative=move, packet=packet)
    r = await _reach(client, hdrs, later, 0)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"
    later = await _fresh(db, later)
    assert later.opened_at is None and later.slide_reached is None


async def test_sign_slides_requires_last_slide(client, db, seeded_user):
    doc = await _slides_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    for n in (0, 1):
        assert (await _reach(client, hdrs, row, n)).status_code == 200
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "slides_required"
    assert await db.scalar(select(LearningSignoff.id)) is None
    assert (await _reach(client, hdrs, row, 2)).status_code == 200
    # the slides stand in for the scroll: scrolled_to_end stays False and it signs
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 200, r.text
    assert (await db.scalar(select(LearningSignoff))).slides_viewed == 3


async def test_slides_ignore_require_scroll(client, db, seeded_user):
    doc = await _slides_doc(db, require_scroll=True)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    for n in range(3):
        await _reach(client, hdrs, row, n)
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 200, r.text


async def test_slide_progress_restarts_on_new_version(client, db, seeded_user):
    doc = await _slides_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    for n in range(3):
        assert (await _reach(client, hdrs, row, n)).status_code == 200
    version = await _publish(db, doc)
    version.content_html = SLIDES_HTML
    await db.commit()
    shown = (await client.get(f"/learn/assignments/{row.id}", headers=hdrs)).json()
    assert shown["version_no"] == 2 and shown["slide_reached"] is None
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False, "version_no": 2})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "slides_required"
    old = await _reach(client, hdrs, row, 0, version_no=1)
    assert old.status_code == 409 and old.json()["detail"]["code"] == "version_changed"
    assert (await _reach(client, hdrs, row, 0, version_no=2)).json()["slide_reached"] == 0


async def test_slide_progress_is_per_language(client, db, seeded_user):
    doc = await _slides_doc(db)
    db.add(LearningTranslation(version_id=doc.current_version_id, language="ja",
                               status="published", title="ja",
                               content_html="<h2>あ</h2><h2>い</h2>"))
    await db.commit()
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    for n in range(3):
        assert (await _reach(client, hdrs, row, n)).status_code == 200
    ja = (await client.get(f"/learn/assignments/{row.id}?lang=ja", headers=hdrs)).json()
    assert ja["slide_reached"] is None and ja["slide_count"] == 2
    sign = {**SIGN, "scrolled_to_end": False, "language": "ja"}
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=sign)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "slides_required"
    # the English slide 2 doesn't exist in Japanese
    far = await _reach(client, hdrs, row, 2, language="ja")
    assert far.status_code == 422 and far.json()["detail"]["code"] == "slide_out_of_range"
    for n in range(2):
        assert (await _reach(client, hdrs, row, n, language="ja")).status_code == 200
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=sign)
    assert r.status_code == 200, r.text
    signoff = await db.scalar(select(LearningSignoff))
    assert signoff.language == "ja" and signoff.slides_viewed == 2


async def test_slide_progress_resets_when_a_translation_shrinks(client, db, seeded_user):
    doc = await _slides_doc(db)
    ja = LearningTranslation(version_id=doc.current_version_id, language="ja",
                             status="published", title="ja",
                             content_html="<h2>あ</h2><h2>い</h2><h2>う</h2>")
    db.add(ja)
    await db.commit()
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    for n in range(3):
        assert (await _reach(client, hdrs, row, n, language="ja")).status_code == 200
    # the translation is edited and republished in place, one slide shorter
    ja.content_html = "<h2>あ</h2><h2>い</h2>"
    await db.commit()
    shown = (await client.get(f"/learn/assignments/{row.id}?lang=ja", headers=hdrs)).json()
    assert shown["slide_count"] == 2 and shown["slide_reached"] is None
    sign = {**SIGN, "scrolled_to_end": False, "language": "ja"}
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=sign)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "slides_required"
    assert (await _reach(client, hdrs, row, 0, language="ja")).json() == {
        "slide_reached": 0, "slide_count": 2}
    assert (await _reach(client, hdrs, row, 1, language="ja")).json()["slide_reached"] == 1
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=sign)
    assert r.status_code == 200, r.text
    assert (await db.scalar(select(LearningSignoff))).slides_viewed == 2


async def test_unpublished_language_reaches_and_signs_in_english(client, db, seeded_user):
    doc = await _slides_doc(db)
    db.add(LearningTranslation(version_id=doc.current_version_id, language="ko",
                               status="draft", title="ko", content_html="<h2>가</h2>"))
    await db.commit()
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    for n in range(3):
        assert (await _reach(client, hdrs, row, n, language="ko")).json()["slide_count"] == 3
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False, "language": "ko"})
    assert r.status_code == 200, r.text
    signoff = await db.scalar(select(LearningSignoff))
    assert signoff.language == "en" and signoff.slides_viewed == 3


async def test_document_style_ignores_slides(client, db, seeded_user):
    doc = await _slides_doc(db)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    doc.reading_style, doc.require_scroll = "document", True
    await db.commit()
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "scroll_required"
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 200, r.text
    assert (await db.scalar(select(LearningSignoff))).slides_viewed is None
    other = await _plain_doc(db, "Plain")
    plain = await _assign(db, wanda, other)
    no = await _reach(client, hdrs, plain, 0)
    assert no.status_code == 409 and no.json()["detail"]["code"] == "not_slides"


async def test_one_slide_document_signs_after_slide_zero(client, db, seeded_user):
    doc = await _slides_doc(db, html="<p>Just this</p>")
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=600)
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "slides_required"
    assert (await _reach(client, hdrs, row, 0)).json() == {"slide_reached": 0, "slide_count": 1}
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs,
                          json={**SIGN, "scrolled_to_end": False})
    assert r.status_code == 200, r.text
