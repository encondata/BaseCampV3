"""Wiki Phase 2 schema (migration 0075) — comments, templates, watches,
and reviews exist with the right constraints; the four builtin templates
seed correctly; and the widened `wiki_page_versions.kind`/`wiki_jobs.kind`
checks accept 'submitted'/'reminders'.

`wiki_templates` is truncated by `clean_db` before every test (see
conftest.py), so the migration's own seed rows never survive to a test on
their own — this file re-runs migration 0075's `seed(conn)` in an autouse
fixture, the same convention `test_container_zpl_templates.py` uses for
migration 0066's rows."""
import importlib.util
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Person,
    WikiComment,
    WikiJob,
    WikiNode,
    WikiPageVersion,
    WikiReview,
    WikiSpace,
    WikiTemplate,
    WikiWatch,
)
from tests.wiki_helpers import seed_builtin_templates

API_DIR = Path(__file__).resolve().parents[1]
MIGRATION_PATH = API_DIR / "migrations" / "versions" / "0075_wiki_collab.py"

WIKI_PHASE2_TABLES = ("wiki_comments", "wiki_templates", "wiki_watches", "wiki_reviews")
BUILTIN_TEMPLATE_NAMES = ("SOP", "How-to guide", "Troubleshooting", "Meeting notes")


def _load_migration_0075():
    spec = importlib.util.spec_from_file_location("_migration_0075_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
async def _seed_builtin_templates(clean_db, db):
    """Re-run migration 0075's seed() against the (freshly truncated) test
    database before every test in this file, so builtin templates exist
    even though wiki_templates is truncated between tests."""
    await seed_builtin_templates(db)


async def _space(db, key="phase2-space"):
    space = WikiSpace(key=key, name="Phase 2 Space")
    db.add(space)
    await db.flush()
    return space


async def _node(db, space, title="A Page"):
    node = WikiNode(space_id=space.id, kind="page", title=title)
    db.add(node)
    await db.flush()
    return node


# ── tables exist ─────────────────────────────────────────────────────


async def test_phase2_tables_exist(db):
    for table in WIKI_PHASE2_TABLES:
        row = await db.scalar(text(f"SELECT to_regclass('{table}')"))
        assert row is not None, f"{table} missing"


async def test_wiki_nodes_gains_review_columns(db):
    space = await _space(db)
    node = await _node(db, space)
    node.review_interval_months = 12
    await db.commit()
    await db.refresh(node)
    assert node.review_interval_months == 12
    assert node.next_review_at is None
    assert node.last_reviewed_at is None
    assert node.last_reviewed_by is None
    assert node.review_notified_for is None


# ── builtin templates ────────────────────────────────────────────────


async def test_builtin_templates_are_seeded(db):
    rows = (await db.scalars(
        select(WikiTemplate).where(WikiTemplate.is_builtin.is_(True))
    )).all()
    names = {t.name for t in rows}
    assert names == set(BUILTIN_TEMPLATE_NAMES)
    for t in rows:
        assert t.space_id is None
        assert t.content_json["type"] == "doc"
        assert t.content_json["content"], f"{t.name} has an empty doc"
        assert t.description != ""
        assert t.icon != ""


async def test_seeding_builtin_templates_twice_is_a_no_op(db):
    migration = _load_migration_0075()
    await db.run_sync(lambda session: migration.seed(session.connection()))
    await db.commit()

    rows = (await db.scalars(
        select(WikiTemplate).where(WikiTemplate.is_builtin.is_(True))
    )).all()
    assert len(rows) == len(BUILTIN_TEMPLATE_NAMES)


async def test_builtin_template_icons_are_glyphs_not_words(db):
    """0077 rewrites 0075's icon names ('clipboard-list', …) to emoji."""
    icons = dict((await db.execute(
        select(WikiTemplate.name, WikiTemplate.icon).where(WikiTemplate.is_builtin.is_(True))
    )).all())
    assert icons == {"SOP": "📋", "How-to guide": "🧭",
                     "Troubleshooting": "🔧", "Meeting notes": "👥"}


async def test_phase2_supporting_indexes_exist(db):
    for name in ("wiki_watches_node_idx", "wiki_watches_space_idx",
                 "wiki_reviews_version_idx", "wiki_reviews_node_idx"):
        assert await db.scalar(text(f"SELECT to_regclass('{name}')")) is not None, name


async def test_template_name_length_check(db):
    db.add(WikiTemplate(space_id=None, name="", content_json={"type": "doc", "content": []}))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_template_name_unique_per_space_case_insensitively(db):
    space = await _space(db, key="templates-space")

    db.add(WikiTemplate(
        space_id=space.id, name="Runbook", content_json={"type": "doc", "content": []}))
    await db.commit()

    db.add(WikiTemplate(
        space_id=space.id, name="RUNBOOK", content_json={"type": "doc", "content": []}))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # a different space may reuse the same name
    other_space = await _space(db, key="templates-space-2")
    db.add(WikiTemplate(
        space_id=other_space.id, name="Runbook", content_json={"type": "doc", "content": []}))
    await db.commit()


# ── watches ──────────────────────────────────────────────────────────


async def test_watch_requires_exactly_one_target(db):
    space = await _space(db)
    node = await _node(db, space)

    person = Person(first_name="Watch", last_name="Er", email=f"{uuid.uuid4().hex}@test.example.com")
    db.add(person)
    await db.flush()
    # captured before any rollback below expires them (Session.rollback()
    # expires every object in the session, not just the failed insert) —
    # same convention as test_devices_api.py's DHCP lease test.
    space_id, node_id, person_id = space.id, node.id, person.id
    await db.commit()

    # neither space_id nor node_id
    db.add(WikiWatch(person_id=person_id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # both
    db.add(WikiWatch(person_id=person_id, space_id=space_id, node_id=node_id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # exactly one of each is fine, and a person may watch both a space and a node
    db.add(WikiWatch(person_id=person_id, space_id=space_id))
    db.add(WikiWatch(person_id=person_id, node_id=node_id))
    await db.commit()


async def test_watch_is_unique_per_person_and_target(db):
    space = await _space(db)

    person = Person(first_name="Watch", last_name="Er2", email=f"{uuid.uuid4().hex}@test.example.com")
    db.add(person)
    await db.flush()
    space_id, person_id = space.id, person.id

    db.add(WikiWatch(person_id=person_id, space_id=space_id))
    await db.commit()

    db.add(WikiWatch(person_id=person_id, space_id=space_id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


# ── reviews ──────────────────────────────────────────────────────────


async def _submitted_version(db, node):
    version = WikiPageVersion(
        node_id=node.id, version_no=1, title=node.title,
        content_json={"type": "doc", "content": [{"type": "paragraph"}]},
        kind="submitted")
    db.add(version)
    await db.flush()
    return version


async def test_only_one_pending_review_per_node(db):
    space = await _space(db)
    node = await _node(db, space)
    version = await _submitted_version(db, node)
    # captured before the rollback below expires node/version (Session.
    # rollback() expires every object in the session) — same convention as
    # test_devices_api.py's DHCP lease test.
    node_id, version_id = node.id, version.id

    db.add(WikiReview(node_id=node_id, version_id=version_id, status="pending"))
    await db.commit()

    db.add(WikiReview(node_id=node_id, version_id=version_id, status="pending"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # once the first is decided, a new pending review is fine
    first = (await db.scalars(select(WikiReview).where(WikiReview.node_id == node_id))).one()
    first.status = "approved"
    await db.commit()

    db.add(WikiReview(node_id=node_id, version_id=version_id, status="pending"))
    await db.commit()


async def test_review_status_check(db):
    space = await _space(db)
    node = await _node(db, space)
    version = await _submitted_version(db, node)

    db.add(WikiReview(node_id=node.id, version_id=version.id, status="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


# ── enum widenings ───────────────────────────────────────────────────


async def test_page_version_kind_allows_submitted(db):
    space = await _space(db)
    node = await _node(db, space)
    db.add(WikiPageVersion(
        node_id=node.id, version_no=1, title="T",
        content_json={"type": "doc", "content": []}, kind="submitted"))
    await db.commit()


async def test_job_kind_allows_reminders(db):
    db.add(WikiJob(kind="reminders"))
    await db.commit()


# ── comments ─────────────────────────────────────────────────────────


async def test_comment_thread_is_self_referencing_and_indexed(db):
    """`thread_id` is not server-generated: the API pre-generates the root
    comment's id so it can set `thread_id` to that same value on insert —
    thread_id is NOT NULL with no default, so it must be known up front."""
    space = await _space(db)
    node = await _node(db, space)

    root_id = uuid.uuid4()
    comment = WikiComment(
        id=root_id, node_id=node.id, thread_id=root_id,
        body={"text": "First!", "mentions": []})
    db.add(comment)
    await db.commit()
    assert comment.thread_id == root_id
    assert comment.anchor is False

    reply = WikiComment(
        node_id=node.id, thread_id=root_id, parent_id=root_id,
        body={"text": "Reply", "mentions": []})
    db.add(reply)
    await db.commit()

    thread_ids = (await db.scalars(
        select(WikiComment.id)
        .where(WikiComment.node_id == node.id, WikiComment.thread_id == root_id)
        .order_by(WikiComment.created_at)
    )).all()
    assert thread_ids == [root_id, reply.id]
