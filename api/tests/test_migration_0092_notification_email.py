"""Migration 0092: notification_groups.categories and the email_outbox
kind / notification_id tracing columns."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError


async def _group(db, categories=None):
    if categories is None:
        return await db.scalar(text(
            "INSERT INTO notification_groups (name) VALUES (:n) RETURNING id"),
            {"n": f"g-{uuid.uuid4()}"})
    return await db.scalar(text(
        "INSERT INTO notification_groups (name, categories) VALUES (:n, :c) RETURNING id"),
        {"n": f"g-{uuid.uuid4()}", "c": categories})


async def test_categories_default_to_empty(db):
    gid = await _group(db)
    assert await db.scalar(text(
        "SELECT categories FROM notification_groups WHERE id=:i"), {"i": gid}) == []


async def test_categories_accept_the_four_and_reject_others(db):
    gid = await _group(db, ["approvals", "reports", "wiki", "security"])
    assert await db.scalar(text(
        "SELECT cardinality(categories) FROM notification_groups WHERE id=:i"), {"i": gid}) == 4
    with pytest.raises(DBAPIError):
        await _group(db, ["bogus"])
    await db.rollback()


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
