"""Learning emails and invites: the invite (code + one-click link), the
learning_email_log dedupe, people without email, the completion email's
inline QR code, the settings' subject/intro overrides, and late adds after
the invites went out."""
import base64
import io
import uuid
from datetime import UTC, datetime, timedelta

from PIL import Image
from sqlalchemy import select

from serversherpa.config import learn_url
from serversherpa.db.models import EmailOutbox, Person, SystemConfig, UserAccount
from serversherpa.learning import codes, emails
from serversherpa.learning.models import (
    LearningCode,
    LearningEmailLog,
    LearningInviteSchedule,
    LearningSession,
    LearningSignoff,
)
from serversherpa.services.password_reset import hash_token
from tests.test_learning_assign import (
    TODAY,
    _assignments,
    _doc,
    _initiative,
    _manager,
    _packet,
    _worker,
)


async def _outbox(db, person_id=None):
    stmt = select(EmailOutbox).order_by(EmailOutbox.created_at)
    if person_id is not None:
        stmt = stmt.where(EmailOutbox.person_id == person_id)
    return list(await db.scalars(stmt.execution_options(populate_existing=True)))


async def _logs(db, **where):
    stmt = select(LearningEmailLog).order_by(LearningEmailLog.created_at)
    for key, value in where.items():
        stmt = stmt.where(getattr(LearningEmailLog, key) == value)
    return list(await db.scalars(stmt))


async def _on_move(db, client, hdrs, move, person):
    resp = await client.post(f"/initiatives/{move.id}/people", headers=hdrs,
                             json={"person_id": str(person.id)})
    assert resp.status_code == 201, resp.text
    return next(r["id"] for r in resp.json() if r["person_id"] == str(person.id))


def _spaced(code: str) -> str:
    return f"{code[:3]} {code[3:]}"


async def test_send_invite_renders_code_and_link_and_logs(db, seeded_user):
    move = await _initiative(db, "Acme DFW move", end=TODAY + timedelta(days=30))
    worker = await _worker(db, "Kenji", "Sato", "kenji@test.example.com")
    row, code, token = await codes.issue(db, worker.id, move.id, actor_id=None)
    due = TODAY + timedelta(days=12)

    mail = await emails.send_invite(db, worker, row, code, token, move, due)
    await db.commit()

    assert mail is not None and mail.to_address == "kenji@test.example.com"
    assert mail.template == "learning_invite" and mail.person_id == worker.id
    link = learn_url(f"/start#t={token}")
    for body in (mail.html_body, mail.text_body):
        assert _spaced(code) in body
        assert "Kenji" in body and "Acme DFW move" in body
    assert link in mail.text_body and link in mail.html_body
    assert "Acme DFW move" in mail.subject
    [log] = await _logs(db, kind="invite")
    assert (log.person_id, log.code_id, log.initiative_id, log.stage) == (
        worker.id, row.id, move.id, "")
    assert log.outbox_id == mail.id
    # the code itself is never stored: only its fingerprint and the link hash
    stored = await db.get(LearningCode, row.id)
    assert stored.fingerprint == codes.fingerprint(code)
    assert stored.link_token_hash == hash_token(token)


async def test_invite_dedup_unique(db, seeded_user):
    move = await _initiative(db)
    worker = await _worker(db)
    row, code, token = await codes.issue(db, worker.id, move.id, actor_id=None)

    first = await emails.send_invite(db, worker, row, code, token, move, None)
    second = await emails.send_invite(db, worker, row, code, token, move, None)
    await db.commit()                    # the duplicate didn't abort the transaction

    assert first is not None and second is None
    assert len(await _logs(db, kind="invite")) == 1
    assert len(await _outbox(db, worker.id)) == 1


async def test_no_email_returns_none_and_counts(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    await _packet(db, [doc])
    move = await _initiative(db)
    wanda = await _worker(db)
    ned = await _worker(db, "Ned", "Nomail", None)
    for person in (wanda, ned):
        await _on_move(db, client, hdrs, move, person)

    row, code, token = await codes.issue(db, ned.id, move.id, actor_id=None)
    assert await emails.send_invite(db, ned, row, code, token, move, None) is None
    assert await _logs(db, person_id=ned.id) == []
    await db.commit()

    # a person on the move with nothing open (signed everything) is "complete"
    done = await _worker(db, "Dana", "Done", "dana@test.example.com")
    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"sent": 1, "no_email": 1, "skipped_complete": 0,
                           "already_invited": 0}
    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs,
                             json={"person_ids": [str(wanda.id), str(done.id)]})
    assert resp.json() == {"sent": 1, "no_email": 0, "skipped_complete": 1,
                           "already_invited": 0}

    assert [m.person_id for m in await _outbox(db)] == [wanda.id, wanda.id]
    # the sends issue no code for someone the email can't reach
    assert [c.id for c in await db.scalars(select(LearningCode).where(
        LearningCode.person_id == ned.id))] == [row.id]
    schedule = await db.get(LearningInviteSchedule, move.id)
    await db.refresh(schedule)
    assert schedule.sent_at is not None


async def test_complete_email_has_qr_cid(db, seeded_user):
    move = await _initiative(db, "Acme DFW move")
    worker = await _worker(db, "Kenji", "Sato", "kenji@test.example.com")

    mail = await emails.send_complete(db, worker.id, move.id)
    again = await emails.send_complete(db, worker.id, move.id)
    await db.commit()

    assert again is None
    assert mail.template == "learning_complete"
    assert 'src="cid:qr"' in mail.html_body
    assert "share" in mail.html_body.lower() and "share" in mail.text_body.lower()
    [attachment] = mail.attachments
    assert attachment["cid"] == "qr" and attachment["content_type"] == "image/png"
    png = base64.b64decode(attachment["b64"])
    assert png == emails.qr_png(str(worker.badge_uid))
    assert png.startswith(b"\x89PNG")
    [log] = await _logs(db, kind="complete")
    assert log.person_id == worker.id and log.code_id is None


async def test_qr_png_is_a_decodable_png():
    png = emails.qr_png(str(uuid.uuid4()))
    image = Image.open(io.BytesIO(png))
    # scale 8, border 4: (modules + 8) * 8 pixels square
    assert image.size[0] == image.size[1] and image.size[0] % 8 == 0


async def test_email_text_override_used(db, seeded_user):
    move = await _initiative(db, "Acme DFW move")
    worker = await _worker(db, "Ji-woo", "Park", "jiwoo@test.example.com")
    doc = await _doc(db, "Site safety")
    db.add(LearningSignoff(person_id=worker.id, document_id=doc.id,
                           version_id=doc.current_version_id, language="ko",
                           typed_name="J P", read_seconds=60, scrolled_to_end=True))
    db.add(SystemConfig(section="learning", data={"email_text": {"invite": {
        "en": {"subject": "English subject", "intro": "English intro."},
        "ko": {"subject": "Korean\r\nBcc: evil@x.test " + "x" * 400,
               "intro": "Korean intro <b>here</b>."}}}}))
    await db.commit()

    row, code, token = await codes.issue(db, worker.id, move.id, actor_id=None)
    mail = await emails.send_invite(db, worker, row, code, token, move, None)
    # CR/LF never reach the header, and the subject is capped
    assert "\r" not in mail.subject and "\n" not in mail.subject
    assert mail.subject.startswith("Korean Bcc: evil@x.test")
    assert len(mail.subject) <= emails.SUBJECT_MAX
    assert "Korean intro &lt;b&gt;here&lt;/b&gt;." in mail.html_body
    assert "Korean intro <b>here</b>." in mail.text_body
    assert "English intro." not in mail.text_body

    # someone with no sign-off reads English; the default template is used
    # when no override exists
    other = await _worker(db, "Wanda", "Worker", "wanda@test.example.com")
    row, code, token = await codes.issue(db, other.id, move.id, actor_id=None)
    mail = await emails.send_invite(db, other, row, code, token, move, None)
    assert mail.subject == "English subject" and "English intro." in mail.text_body
    reminder_default = await emails.send_reminder(db, other, row, move, None, "r5")
    assert "English intro." not in reminder_default.text_body


async def test_late_add_after_send_auto_invites(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    await _packet(db, [doc])
    move = await _initiative(db)
    early = await _worker(db, "Erin", "Early", "erin@test.example.com")
    await _on_move(db, client, hdrs, move, early)
    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    assert resp.json()["sent"] == 1

    late = await _worker(db, "Larry", "Late", "larry@test.example.com")
    assoc_id = await _on_move(db, client, hdrs, move, late)
    [mail] = await _outbox(db, late.id)
    assert mail.template == "learning_invite"
    [first_code] = list(await db.scalars(select(LearningCode).where(
        LearningCode.person_id == late.id)))

    # removal cancels and revokes; the re-add gets a fresh code and invite
    resp = await client.delete(f"/initiatives/people/{assoc_id}", headers=hdrs)
    assert resp.status_code == 204
    await _on_move(db, client, hdrs, move, late)
    rows = list(await db.scalars(select(LearningCode).where(LearningCode.person_id == late.id)
                                 .execution_options(populate_existing=True)))
    assert len(rows) == 2
    active = [r for r in rows if r.revoked_at is None]
    assert len(active) == 1 and active[0].id != first_code.id
    assert len(await _outbox(db, late.id)) == 2
    assert {a.status for a in await _assignments(db, late.id)} == {"assigned", "cancelled"}

    # late adds off: nobody new is invited
    schedule = await db.get(LearningInviteSchedule, move.id)
    schedule.late_adds = False
    await db.commit()
    later = await _worker(db, "Lou", "Later", "lou@test.example.com")
    await _on_move(db, client, hdrs, move, later)
    assert await _outbox(db, later.id) == []


async def test_send_link_rotates_the_link_and_limits_per_minute(db, seeded_user):
    move = await _initiative(db)
    worker = await _worker(db)
    row, code, token = await codes.issue(db, worker.id, move.id, actor_id=None)
    await db.commit()

    mail = await emails.send_link(db, worker.id, move.id)
    assert mail is not None and mail.template == "learning_link"
    assert await emails.send_link(db, worker.id, move.id) is None     # same minute
    await db.commit()
    stored = await db.get(LearningCode, row.id)
    await db.refresh(stored)
    # the code still works; only the link changed
    assert stored.revoked_at is None and stored.fingerprint == codes.fingerprint(code)
    assert stored.link_token_hash != hash_token(token)
    assert "/start#t=" in mail.text_body and _spaced(code) not in mail.text_body


async def test_send_new_version_uses_a_general_code(db, seeded_user):
    worker = await _worker(db)
    doc = await _doc(db, "Site safety")
    mail = await emails.send_new_version(db, worker.id, doc)
    assert mail is not None and mail.template == "learning_new_version"
    assert "Site safety" in mail.text_body and "/start#t=" in mail.text_body
    assert await emails.send_new_version(db, worker.id, doc) is None
    general = await db.scalar(select(LearningCode).where(
        LearningCode.person_id == worker.id, LearningCode.initiative_id.is_(None)))
    assert general is not None


async def test_person_email_falls_back_to_login_email(db, seeded_user):
    alice = await db.scalar(select(Person).where(Person.id == seeded_user.id))
    alice.email = None
    await db.commit()
    move = await _initiative(db)
    row, code, token = await codes.issue(db, alice.id, move.id, actor_id=None)
    mail = await emails.send_invite(db, alice, row, code, token, move, None)
    assert mail.to_address == "alice@test.example.com"


async def test_second_send_now_only_invites_newcomers(client, db, seeded_user):
    hdrs = await _manager(db, client)
    doc = await _doc(db, "Site safety")
    await _packet(db, [doc])
    move = await _initiative(db)
    first = await _worker(db, "Fay", "First", "fay@test.example.com")
    await _on_move(db, client, hdrs, move, first)
    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    assert resp.json()["sent"] == 1
    [code] = list(await db.scalars(select(LearningCode).where(
        LearningCode.person_id == first.id)))
    session = LearningSession(code_id=code.id, person_id=first.id, token_hash="t-1",
                              expires_at=code.created_at + timedelta(days=1))
    db.add(session)
    # someone joins with late adds off, so only Send now can invite them
    schedule = await db.get(LearningInviteSchedule, move.id)
    schedule.late_adds = False
    await db.commit()
    second = await _worker(db, "Sid", "Second", "sid@test.example.com")
    await _on_move(db, client, hdrs, move, second)

    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs, json={})
    assert resp.json() == {"sent": 1, "no_email": 0, "skipped_complete": 0,
                           "already_invited": 1}
    rows = list(await db.scalars(select(LearningCode).where(
        LearningCode.person_id == first.id).execution_options(populate_existing=True)))
    assert [(r.id, r.revoked_at) for r in rows] == [(code.id, None)]
    await db.refresh(session)
    assert session.revoked_at is None
    assert [m.person_id for m in await _outbox(db)] == [first.id, second.id]

    # Resend still re-issues
    resp = await client.post(f"/learning/initiatives/{move.id}/send", headers=hdrs,
                             json={"person_ids": [str(first.id)]})
    assert resp.json()["sent"] == 1
    rows = list(await db.scalars(select(LearningCode).where(
        LearningCode.person_id == first.id).execution_options(populate_existing=True)))
    assert len(rows) == 2 and [r.id for r in rows if r.revoked_at is None] != [code.id]
    await db.refresh(session)
    assert session.revoked_at is not None


async def test_archived_or_disabled_people_get_no_email(db, seeded_user):
    move = await _initiative(db)
    archived = await _worker(db, "Art", "Archived", "art@test.example.com")
    archived.archived_at = datetime.now(UTC)
    await db.commit()
    assert await emails.address_for(db, archived.id) is None
    account = await db.get(UserAccount, seeded_user.id)
    account.disabled_at = datetime.now(UTC)
    await db.commit()
    assert await emails.address_for(db, seeded_user.id) is None
    row, code, token = await codes.issue(db, archived.id, move.id, actor_id=None)
    assert await emails.send_invite(db, archived, row, code, token, move, None) is None
