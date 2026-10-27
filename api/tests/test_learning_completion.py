"""Completion: signing the last open assignment for an initiative (or the
general set) writes the learning certification, tells every learning
manager and queues the worker's completion email, once."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import EmailOutbox, Notification, WorkerCertification
from serversherpa.learning import completion
from tests.test_learn_training import SIGN, _assign, _learner, _plain_doc
from tests.test_learning_assign import TODAY, _initiative, _manager


async def _certs(db, person_id):
    return list(await db.scalars(
        select(WorkerCertification).where(WorkerCertification.person_id == person_id)
        .order_by(WorkerCertification.created_at)
        .execution_options(populate_existing=True)))


async def _notes(db, kind="learning_complete"):
    return list(await db.scalars(select(Notification).where(Notification.kind == kind)))


async def test_last_sign_writes_cert_notifies_and_queues_email(client, db, seeded_user):
    await _manager(db, client)
    move = await _initiative(db, "Acme DFW move")
    long_doc = await _plain_doc(db, "Site safety", validity_days=30)
    short_doc = await _plain_doc(db, "Acme NDA", validity_days=10)
    forever = await _plain_doc(db, "Dress code")
    wanda, hdrs = await _learner(db, email="wanda@test.example.com")
    rows = [await _assign(db, wanda, d, initiative=move, opened_ago=30)
            for d in (long_doc, short_doc, forever)]

    for row in rows[:2]:
        r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
        assert r.status_code == 200, r.text
        assert r.json()["complete"] is False
    assert await _certs(db, wanda.id) == []
    assert await _notes(db) == []

    r = await client.post(f"/learn/assignments/{rows[2].id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 200, r.text
    assert r.json()["complete"] is True

    [cert] = await _certs(db, wanda.id)
    assert (cert.name, cert.source, cert.learning_initiative_id) == (
        "Onboarding: Acme DFW move", "learning", move.id)
    assert cert.issued_on == TODAY
    # the earliest expiry among the signed documents; "never" doesn't count
    assert cert.expires_on == TODAY + timedelta(days=10)

    [note] = await _notes(db)
    assert note.person_id not in (wanda.id, seeded_user.id)
    assert note.title == "Wanda Worker finished learning for Acme DFW move"
    assert note.link == f"/initiatives/{move.id}?tab=learning"

    [mail] = list(await db.scalars(select(EmailOutbox).where(
        EmailOutbox.template == "learning_complete")))
    assert mail.person_id == wanda.id and mail.to_address == "wanda@test.example.com"


async def test_completion_idempotent(client, db, seeded_user):
    await _manager(db, client)
    move = await _initiative(db, "Move")
    doc = await _plain_doc(db)
    wanda, _ = await _learner(db)
    row = await _assign(db, wanda, doc, initiative=move)

    # something still open: nothing happens
    assert await completion.check(db, wanda.id, move.id) is False
    row.status, row.signed_at = "signed", datetime.now(UTC)
    await db.commit()

    assert await completion.check(db, wanda.id, move.id) is True
    await db.commit()
    assert await completion.check(db, wanda.id, move.id) is False
    await db.commit()
    assert len(await _certs(db, wanda.id)) == 1
    assert len(await _notes(db)) == 1
    assert await db.scalar(select(func.count()).select_from(EmailOutbox).where(
        EmailOutbox.template == "learning_complete")) == 1

    # nobody with nothing assigned is "complete"
    nobody, _ = await _learner(db, "Ned", "Nothing")
    assert await completion.check(db, nobody.id, move.id) is False


async def test_general_completion_name_and_link(client, db, seeded_user):
    await _manager(db, client)
    doc = await _plain_doc(db, "Forklift basics", validity_days=365)
    wanda, hdrs = await _learner(db)
    row = await _assign(db, wanda, doc, opened_ago=30)
    r = await client.post(f"/learn/assignments/{row.id}/sign", headers=hdrs, json=SIGN)
    assert r.status_code == 200 and r.json()["complete"] is True

    [cert] = await _certs(db, wanda.id)
    assert (cert.name, cert.learning_initiative_id) == ("Learning: general", None)
    assert cert.expires_on == TODAY + timedelta(days=365)
    [note] = await _notes(db)
    assert note.title == "Wanda Worker finished their assigned learning"
    assert note.link == f"/people/workers/{wanda.id}"
    # a repeat check finds the cert and stays quiet
    assert await completion.check(db, wanda.id, None) is False

    # a later general assignment, signed, completes the general set again
    later = await _assign(db, wanda, await _plain_doc(db, "Ladder safety"), opened_ago=30)
    r = await client.post(f"/learn/assignments/{later.id}/sign", headers=hdrs, json=SIGN)
    assert r.json()["complete"] is True
    certs = await _certs(db, wanda.id)
    assert len(certs) == 2 and certs[1].expires_on is None
