"""notifications/delivery_log.py: the writer behind the delivery log
(`notification_log`, migration 0110). record() only adds to the caller's
session — never flushes or commits — and the table's links are ON DELETE
SET NULL, so the trail outlives the rows it describes."""

import logging
import uuid

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from serversherpa.db.models import EmailOutbox, Notification, NotificationLog, Person
from serversherpa.notifications.delivery_log import EVENTS, LOG_CHANNELS, record

LOG_NAME = "serversherpa.notifications.log"


async def _log_count(db) -> int:
    return await db.scalar(select(func.count()).select_from(NotificationLog))


async def test_record_adds_a_row(db, seeded_user):
    record(db, "inbox_written", channel="inbox", person_id=seeded_user.id,
           kind="report_ready", category="reports")
    await db.flush()
    row = (await db.scalars(select(NotificationLog))).one()
    await db.refresh(row)                      # read back what the database stored
    assert row.event == "inbox_written" and row.channel == "inbox"
    assert row.person_id == seeded_user.id
    assert row.kind == "report_ready" and row.category == "reports"
    assert row.notification_id is None and row.outbox_id is None
    assert row.reason is None
    assert row.detail == {}
    assert row.at.tzinfo is not None


async def test_record_rejects_unknown_event_and_channel(db):
    with pytest.raises(ValueError):
        record(db, "nope", channel="inbox")
    with pytest.raises(ValueError):
        record(db, "inbox_written", channel="fax")
    assert not db.new                          # a rejected call adds nothing


async def test_record_only_adds_to_the_session(db, seeded_user):
    row = record(db, "inbox_written", channel="inbox", person_id=seeded_user.id)
    assert row in db.new and row.id is None    # no flush, no commit
    await db.rollback()
    assert await _log_count(db) == 0


async def test_record_line_carries_ids_not_detail(db, seeded_user, caplog):
    notification_id, outbox_id = uuid.uuid4(), uuid.uuid4()
    with caplog.at_level(logging.DEBUG, logger=LOG_NAME):
        record(db, "email_not_queued", channel="email", person_id=seeded_user.id,
               notification_id=notification_id, outbox_id=outbox_id,
               kind="report_ready", category="reports", reason="no_email_group",
               detail={"note": "secret-body"})
    lines = [r for r in caplog.records if r.name == LOG_NAME]
    assert len(lines) == 1 and lines[0].levelno == logging.DEBUG
    message = lines[0].getMessage()
    for part in ("email_not_queued", "email", "report_ready", "no_email_group",
                 str(seeded_user.id), str(notification_id), str(outbox_id)):
        assert part in message
    assert "secret-body" not in message


async def test_record_line_stays_out_of_an_info_level_log(db, caplog):
    """The line is DEBUG: the process log's handler (Logging min level INFO by
    default) would otherwise copy every decision into log_entries too."""
    with caplog.at_level(logging.INFO, logger=LOG_NAME):
        record(db, "inbox_written", channel="inbox", kind="report_ready")
    assert [r for r in caplog.records if r.name == LOG_NAME] == []


async def test_record_stamps_the_installed_process(db, monkeypatch):
    monkeypatch.setattr("serversherpa.system.db_logging._installed", {"api": object()})
    record(db, "inbox_written", channel="inbox")
    monkeypatch.setattr("serversherpa.system.db_logging._installed", {})
    record(db, "inbox_written", channel="inbox")
    await db.flush()
    processes = (await db.scalars(
        select(NotificationLog.process).order_by(NotificationLog.id))).all()
    assert processes == ["api", None]


async def test_deleting_the_notification_keeps_the_log_row(db, seeded_user):
    note = Notification(person_id=seeded_user.id, kind="report_ready", title="Ready")
    db.add(note)
    await db.flush()
    record(db, "inbox_written", channel="inbox", person_id=seeded_user.id,
           notification_id=note.id, kind="report_ready")
    await db.commit()
    await db.delete(note)
    await db.commit()
    assert await _log_count(db) == 1
    assert await db.scalar(select(NotificationLog.notification_id)) is None


async def test_deleting_the_email_or_the_person_keeps_the_log_row(db):
    person = Person(first_name="Gone", last_name="Soon")
    db.add(person)
    await db.flush()
    outbox = EmailOutbox(template="notification", to_address="gone@test.example.com",
                         person_id=person.id, subject="s", html_body="h", text_body="t")
    db.add(outbox)
    await db.flush()
    record(db, "email_queued", channel="email", person_id=person.id,
           outbox_id=outbox.id, kind="report_ready")
    await db.commit()
    await db.execute(text("DELETE FROM email_outbox WHERE id = :i"), {"i": outbox.id})
    await db.execute(text("DELETE FROM people WHERE id = :i"), {"i": person.id})
    await db.commit()
    row = (await db.execute(select(NotificationLog.person_id,
                                   NotificationLog.outbox_id))).one()
    assert (row.person_id, row.outbox_id) == (None, None)


async def test_the_table_accepts_every_event_and_channel_the_writer_allows(db):
    for event in EVENTS:
        for channel in LOG_CHANNELS:
            record(db, event, channel=channel)
    await db.flush()
    assert await _log_count(db) == len(EVENTS) * len(LOG_CHANNELS)


@pytest.mark.parametrize("event,channel,accepted", [
    ("inbox_written", "text", True),           # room for later channels
    ("inbox_written", "push", True),
    ("inbox_written", "fax", False),
    ("nope", "inbox", False),
])
async def test_the_table_checks_event_and_channel(db, event, channel, accepted):
    insert = text("INSERT INTO notification_log (event, channel) VALUES (:e, :c)")
    if accepted:
        await db.execute(insert, {"e": event, "c": channel})
    else:
        with pytest.raises(DBAPIError):
            await db.execute(insert, {"e": event, "c": channel})
    await db.rollback()


@pytest.mark.parametrize("index,columns", [
    ("notification_log_at_idx", "(at)"),                     # retention, newest-first
    ("notification_log_person_idx", "(person_id, id)"),      # a person's trail + SET NULL
    ("notification_log_notification_idx", "(notification_id)"),
    ("notification_log_outbox_idx", "(outbox_id)"),
])
async def test_the_table_is_indexed_for_its_readers_and_set_null_links(db, index, columns):
    defs = (await db.execute(text(
        "SELECT indexdef FROM pg_indexes "
        "WHERE tablename = 'notification_log' AND indexname = :i"),
        {"i": index})).scalars().all()
    assert len(defs) == 1
    assert columns in defs[0]


async def test_the_outbox_remembers_why_a_row_was_skipped(db):
    outbox = EmailOutbox(template="notification", to_address="a@test.example.com",
                         subject="s", html_body="h", text_body="t")
    db.add(outbox)
    await db.flush()
    assert outbox.skip_reason is None
    outbox.status, outbox.skip_reason = "skipped", "read"
    await db.commit()
    stored = (await db.execute(select(EmailOutbox.status, EmailOutbox.skip_reason)
                               .where(EmailOutbox.id == outbox.id))).one()
    assert tuple(stored) == ("skipped", "read")
