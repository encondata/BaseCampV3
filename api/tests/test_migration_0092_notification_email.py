"""Migration 0092: the email_outbox kind / notification_id tracing columns.

The migration's other half, `notification_groups.categories` and its CHECK, is gone at
head (migration 0113 dropped it); test_migration_0113_watches_events.py covers the
column and the CHECK coming back on a rollback."""

from sqlalchemy import text


async def test_outbox_columns_exist_and_are_nullable(db):
    rows = (await db.execute(text(
        "SELECT column_name, is_nullable FROM information_schema.columns "
        "WHERE table_name='email_outbox' AND column_name IN ('kind','notification_id')"
    ))).all()
    assert {r[0]: r[1] for r in rows} == {"kind": "YES", "notification_id": "YES"}


async def test_deleting_a_notification_nulls_the_outbox_link(db, seeded_user):
    nid = await db.scalar(text(
        "INSERT INTO notifications (person_id, kind, title) "
        "VALUES (:p, 'report_ready', 't') RETURNING id"), {"p": seeded_user.id})
    oid = await db.scalar(text(
        "INSERT INTO email_outbox (template, to_address, subject, html_body, text_body, "
        "kind, notification_id) VALUES ('notification', 'a@b.example.com', 's', 'h', 't', "
        "'report_ready', :n) RETURNING id"), {"n": nid})
    await db.commit()
    await db.execute(text("DELETE FROM notifications WHERE id=:i"), {"i": nid})
    await db.commit()
    row = (await db.execute(text(
        "SELECT kind, notification_id FROM email_outbox WHERE id=:i"), {"i": oid})).one()
    assert row == ("report_ready", None)
