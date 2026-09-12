"""Migration 0058 — containers.label_tag column + CHECK constraint.
See docs/superpowers/specs/2026-09-12-container-labels-design.md
Addendum 2026-09-12 — the label tag lives on the container.

API-level round trip (create/patch/clear/422/list) lives in
test_containers_api.py; the ORM-level CHECK-constraint rejection lives
in test_containers_model.py. This file covers the migration's own
schema shape and a raw-SQL INSERT that bypasses the ORM entirely."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from serversherpa.db.models import Container


async def test_containers_gained_the_label_tag_column(db):
    cols = (await db.execute(text(
        "SELECT column_name, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'containers' AND column_name = 'label_tag'"))).all()
    assert len(cols) == 1
    assert cols[0].is_nullable == "YES"


async def test_label_tag_check_constraint_exists(db):
    rows = (await db.execute(text(
        "SELECT conname FROM pg_constraint "
        "WHERE conname = 'containers_label_tag_check'"))).all()
    assert len(rows) == 1


async def test_raw_insert_with_invalid_label_tag_fails(db):
    """A raw SQL INSERT that never goes through the ORM or the API's
    Pydantic validation still hits the database-level CHECK."""
    with pytest.raises(DBAPIError):
        await db.execute(text(
            "INSERT INTO containers (name, label_tag) "
            "VALUES ('Raw Bad Tag', 'not_a_real_tag')"))
        await db.commit()
    await db.rollback()


async def test_raw_insert_with_null_label_tag_succeeds(db):
    await db.execute(text(
        "INSERT INTO containers (name, label_tag) VALUES ('Raw Untagged', NULL)"))
    await db.commit()
    container = await db.scalar(
        select(Container).where(Container.name == "Raw Untagged"))
    assert container is not None
    assert container.label_tag is None
