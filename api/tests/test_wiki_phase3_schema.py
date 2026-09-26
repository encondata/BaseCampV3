"""Wiki Phase 3 schema (migration 0076) — public share links, help links,
and analytics tables (page views, feedback, search log) exist with the
right constraints, and `wiki_jobs.kind` accepts 'export'/'retention'.
Also covers the new `allow_public_links` space setting."""
import uuid
from datetime import date

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Person,
    WikiFeedback,
    WikiHelpLink,
    WikiJob,
    WikiNode,
    WikiPageView,
    WikiSearchLog,
    WikiShareLink,
    WikiSpace,
)
from serversherpa.wiki import space_settings

WIKI_PHASE3_TABLES = (
    "wiki_share_links", "wiki_help_links", "wiki_page_views",
    "wiki_feedback", "wiki_search_log",
)


async def _space(db, key="phase3-space"):
    space = WikiSpace(key=key, name="Phase 3 Space")
    db.add(space)
    await db.flush()
    return space


async def _node(db, space, title="A Page"):
    node = WikiNode(space_id=space.id, kind="page", title=title)
    db.add(node)
    await db.flush()
    return node


async def _person(db, first="Reader"):
    person = Person(first_name=first, last_name="Er",
                    email=f"{uuid.uuid4().hex}@test.example.com")
    db.add(person)
    await db.flush()
    return person


# ── tables exist ─────────────────────────────────────────────────────


async def test_phase3_tables_exist(db):
    for table in WIKI_PHASE3_TABLES:
        row = await db.scalar(text(f"SELECT to_regclass('{table}')"))
        assert row is not None, f"{table} missing"


# ── wiki_share_links ─────────────────────────────────────────────────


async def test_share_link_token_hash_is_unique(db):
    space = await _space(db)
    node = await _node(db, space)

    db.add(WikiShareLink(node_id=node.id, token_hash="abc123"))
    await db.commit()

    db.add(WikiShareLink(node_id=node.id, token_hash="abc123"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_share_link_defaults(db):
    space = await _space(db)
    node = await _node(db, space)

    link = WikiShareLink(node_id=node.id, token_hash="def456")
    db.add(link)
    await db.commit()
    await db.refresh(link)

    assert link.view_count == 0
    assert link.expires_at is None
    assert link.revoked_at is None
    assert link.last_viewed_at is None
    assert link.created_at is not None


async def test_share_link_cascades_with_node(db):
    space = await _space(db)
    node = await _node(db, space)
    db.add(WikiShareLink(node_id=node.id, token_hash="ghi789"))
    await db.commit()

    await db.delete(node)
    await db.commit()

    remaining = (await db.scalars(select(WikiShareLink))).all()
    assert remaining == []


# ── wiki_help_links ──────────────────────────────────────────────────


async def test_help_link_context_is_unique(db):
    space = await _space(db)
    node = await _node(db, space)

    db.add(WikiHelpLink(context="portal:/bulk/time", node_id=node.id))
    await db.commit()

    db.add(WikiHelpLink(context="portal:/bulk/time", node_id=node.id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_help_link_context_length_check(db):
    space = await _space(db)
    node = await _node(db, space)
    # captured before any rollback below expires them (Session.rollback()
    # expires every object in the session, not just the failed insert) —
    # same convention as test_wiki_phase2_schema.py's watch/review tests.
    node_id = node.id
    await db.commit()

    db.add(WikiHelpLink(context="", node_id=node_id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(WikiHelpLink(context="x" * 301, node_id=node_id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(WikiHelpLink(context="kiosk:/enroll", node_id=node_id))
    await db.commit()


# ── wiki_page_views ──────────────────────────────────────────────────


async def test_page_view_composite_primary_key(db):
    space = await _space(db)
    node = await _node(db, space)
    person = await _person(db)
    node_id, person_id = node.id, person.id

    db.add(WikiPageView(node_id=node_id, person_id=person_id,
                        viewed_on=date(2026, 9, 26), count=1))
    await db.commit()

    # same (node, person, day) again is a duplicate key, not an upsert —
    # the API layer is responsible for the ON CONFLICT upsert.
    db.add(WikiPageView(node_id=node_id, person_id=person_id,
                        viewed_on=date(2026, 9, 26), count=1))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # a different day for the same (node, person) is a distinct row
    db.add(WikiPageView(node_id=node_id, person_id=person_id,
                        viewed_on=date(2026, 9, 27), count=1))
    await db.commit()


async def test_page_view_cascades_with_person(db):
    space = await _space(db)
    node = await _node(db, space)
    person = await _person(db)
    db.add(WikiPageView(node_id=node.id, person_id=person.id,
                        viewed_on=date(2026, 9, 26), count=3))
    await db.commit()

    await db.delete(person)
    await db.commit()

    remaining = (await db.scalars(select(WikiPageView))).all()
    assert remaining == []


# ── wiki_feedback ────────────────────────────────────────────────────


async def test_feedback_composite_primary_key(db):
    space = await _space(db)
    node = await _node(db, space)
    person = await _person(db)
    node_id, person_id = node.id, person.id

    db.add(WikiFeedback(node_id=node_id, person_id=person_id, helpful=True))
    await db.commit()

    db.add(WikiFeedback(node_id=node_id, person_id=person_id, helpful=False))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_feedback_comment_length_check(db):
    space = await _space(db)
    node = await _node(db, space)
    person = await _person(db)
    # captured before any rollback below expires them (Session.rollback()
    # expires every object in the session, not just the failed insert).
    node_id, person_id = node.id, person.id
    await db.commit()

    db.add(WikiFeedback(node_id=node_id, person_id=person_id,
                        helpful=False, comment="x" * 2001))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # comment is optional, and exactly the max length is fine
    db.add(WikiFeedback(node_id=node_id, person_id=person_id,
                        helpful=False, comment="x" * 2000))
    await db.commit()


async def test_feedback_comment_may_be_null(db):
    space = await _space(db)
    node = await _node(db, space)
    person = await _person(db)

    db.add(WikiFeedback(node_id=node.id, person_id=person.id, helpful=True))
    await db.commit()


# ── wiki_search_log ──────────────────────────────────────────────────


async def test_search_log_person_id_set_null_on_delete(db):
    person = await _person(db)
    person_id = person.id

    log = WikiSearchLog(person_id=person_id, query="how to enroll", result_count=0)
    db.add(log)
    await db.commit()
    log_id = log.id

    await db.delete(person)
    await db.commit()

    # `log` is still in the session's identity map from the insert above,
    # so a plain get() would return the stale in-memory value — refresh it
    # to see what the DB's ON DELETE SET NULL actually did.
    await db.refresh(log)
    assert log.person_id is None
    assert log.id == log_id


async def test_search_log_person_id_may_be_absent(db):
    # an unauthenticated (public) search has no person_id at all
    db.add(WikiSearchLog(query="anonymous search", result_count=2))
    await db.commit()


# ── enum widening ────────────────────────────────────────────────────


async def test_job_kind_allows_export_and_retention(db):
    db.add(WikiJob(kind="export"))
    db.add(WikiJob(kind="retention"))
    await db.commit()


async def test_job_kind_still_rejects_unknown_values(db):
    db.add(WikiJob(kind="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


# ── allow_public_links space setting ────────────────────────────────


def test_allow_public_links_is_allowed_and_defaults_false():
    assert space_settings.ALLOWED["allow_public_links"] is bool
    assert space_settings.DEFAULTS["allow_public_links"] is False


def test_allow_public_links_validate():
    assert space_settings.validate("allow_public_links", True) is True
    assert space_settings.validate("allow_public_links", False) is True
    assert space_settings.validate("allow_public_links", "yes") is False
    assert space_settings.validate("allow_public_links", 1) is False
    assert space_settings.validate("allow_public_links", None) is False


async def test_allow_public_links_effective_default(db):
    space = await _space(db)
    assert space_settings.space_setting(space, "allow_public_links") is False

    space.settings = {"allow_public_links": True}
    await db.commit()
    await db.refresh(space)
    assert space_settings.space_setting(space, "allow_public_links") is True
