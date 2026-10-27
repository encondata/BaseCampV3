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
from serversherpa.learning import sessions
from serversherpa.learning.models import (
    LearningAssignment,
    LearningPacket,
    LearningPacketItem,
    LearningQuizAttempt,
    LearningQuizQuestion,
    LearningSignoff,
    LearningTranslation,
)
from tests.test_learning_assign import TODAY, _doc, _initiative, _manager, _publish

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
    move = await _initiative(db, "Acme DFW move", start=TODAY + timedelta(days=5),
                             end=TODAY + timedelta(days=20))
    safety = await _plain_doc(db, "Site safety")
    nda = await _plain_doc(db, "Acme NDA", quiz_enabled=True, quiz_pass_percent=100)
    await _question(db, nda, "Share photos?", [("a", "Yes"), ("b", "No")], ["b"])
    extra = await _plain_doc(db, "Forklift basics")
    wanda, hdrs = await _learner(db)
    other, _ = await _learner(db, "Otto", "Other")
    due = TODAY + timedelta(days=3)
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
                                   "start": (TODAY + timedelta(days=5)).isoformat()}
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
