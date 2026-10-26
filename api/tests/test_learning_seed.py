"""`serversherpa learning-seed`: the Learning space, sample pages,
documents (published v1), packets and the Everyone rule — created once,
idempotent on a second run. The render server is the library tests'
httpx MockTransport stand-in."""
import asyncio

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from typer.testing import CliRunner

from serversherpa.cli import app
from serversherpa.config import get_settings
from serversherpa.db.models import WikiGrant, WikiNode, WikiPage, WikiSpace
from serversherpa.learning.models import (
    LearningDocument,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningQuizQuestion,
    LearningRule,
)
from serversherpa.learning.seed import seed
from serversherpa.learning.seed_content import DOCUMENTS, SAMPLE_NOTICE, empty_text_nodes
from tests.test_learning_library import renderer, service_token  # noqa: F401

runner = CliRunner()


@pytest.fixture
def cli_db(monkeypatch):
    """The CLI runs its own event loop, so it gets its own unpooled engine
    instead of the one the async fixtures built on the test's loop."""
    url = get_settings().database_url.get_secret_value()

    def sessionmaker():
        return async_sessionmaker(create_async_engine(url, poolclass=NullPool),
                                  expire_on_commit=False)
    monkeypatch.setattr("serversherpa.cli.get_sessionmaker", sessionmaker)
    return sessionmaker


async def _counts(db):
    return {name: await db.scalar(select(func.count()).select_from(model))
            for name, model in [
                ("spaces", WikiSpace), ("nodes", WikiNode), ("grants", WikiGrant),
                ("documents", LearningDocument), ("versions", LearningDocumentVersion),
                ("questions", LearningQuizQuestion), ("packets", LearningPacket),
                ("items", LearningPacketItem), ("rules", LearningRule)]}


async def test_seed_creates_space_pages_documents_packets_rule(db, renderer):  # noqa: F811
    result = await seed(db, actor_id=None)
    await db.commit()
    assert result.total > 0

    space = await db.scalar(select(WikiSpace).where(WikiSpace.key == "learning"))
    assert (space.name, space.description) == (
        "Learning", "Training documents workers review and sign before working on site.")
    grants = {(g.principal_type, g.principal_id, g.level) for g in await db.scalars(
        select(WikiGrant).where(WikiGrant.space_id == space.id))}
    assert ("internal", None, "view") in grants
    assert ("role", "learning_admin", "manage") in grants

    folders = {n.title: n for n in await db.scalars(select(WikiNode).where(
        WikiNode.space_id == space.id, WikiNode.kind == "folder"))}
    assert set(folders) == {"Standard onboarding", "Client site rules", "Extras"}
    parents = {n.title: n.parent_id for n in await db.scalars(select(WikiNode).where(
        WikiNode.space_id == space.id, WikiNode.kind == "page", WikiNode.title != "Learning"))}
    assert parents == {
        "Dress code": folders["Standard onboarding"].id,
        "Confidentiality": folders["Standard onboarding"].id,
        "Work expectations": folders["Standard onboarding"].id,
        "Acme site rules (sample)": folders["Client site rules"].id,
        "Acme NDA (sample)": folders["Client site rules"].id,
        "Forklift safety (sample)": folders["Extras"].id}

    documents = {d.title: d for d in await db.scalars(select(LearningDocument))}
    assert set(documents) == set(parents)
    for seeded in DOCUMENTS:
        document = documents[seeded.title]
        node = await db.scalar(select(WikiNode).where(WikiNode.id == document.wiki_node_id))
        page = await db.get(WikiPage, node.id)
        assert page.doc_type == "Policy" and page.published_version_id is not None
        assert empty_text_nodes(page.draft_json) == 0
        first = page.draft_json["content"][0]
        assert first["type"] == "callout"
        assert first["content"][0]["content"][0]["text"] == SAMPLE_NOTICE
        assert 3 <= sum(1 for n in page.draft_json["content"] if n["type"] == "heading") <= 5
        version = await db.get(LearningDocumentVersion, document.current_version_id)
        assert (version.version_no, version.title) == (1, seeded.title)
        assert version.content_html

    dress = documents["Dress code"]
    assert (dress.validity_days, dress.resign_rule, dress.sign_style, dress.require_scroll,
            dress.min_read_seconds, dress.quiz_enabled) == (
        365, "expired_or_new_version", "typed_name", True, 60, False)
    dress_headings = [n["content"][0]["text"] for n in (await db.get(
        WikiPage, dress.wiki_node_id)).draft_json["content"] if n["type"] == "heading"]
    assert dress_headings[:3] == ["Every day on site", "Data hall floor",
                                  "Client-specific rules"]
    for title in ("Confidentiality", "Work expectations"):
        assert (documents[title].validity_days, documents[title].resign_rule) == (
            365, "expired_or_new_version")
    for title in ("Acme site rules (sample)", "Acme NDA (sample)"):
        assert documents[title].resign_rule == "every_initiative"
    assert documents["Forklift safety (sample)"].validity_days == 365

    nda = documents["Acme NDA (sample)"]
    assert (nda.quiz_enabled, nda.quiz_pass_percent, nda.quiz_max_attempts,
            nda.quiz_fail_action) == (True, 75, 3, "retry")
    questions = list(await db.scalars(select(LearningQuizQuestion).where(
        LearningQuizQuestion.document_id == nda.id).order_by(LearningQuizQuestion.position)))
    assert len(questions) == 4
    friend = questions[1]
    assert friend.prompt == ("A friend asks which company's equipment you're moving this "
                             "week. What can you say?")
    by_id = {c["id"]: c["text"] for c in friend.choices}
    assert sorted(by_id.values()) == sorted([
        "The client's name, but nothing else",
        "Only that you're working on a data center move",
        "Anything, as long as it's not posted online"])
    assert [by_id[c] for c in friend.correct_choice_ids] == [
        "Only that you're working on a data center move"]
    for question in questions:
        assert len(question.correct_choice_ids) == 1
        assert set(question.correct_choice_ids) <= {c["id"] for c in question.choices}

    packets = {p.name: p for p in await db.scalars(select(LearningPacket))}
    assert set(packets) == {"Standard onboarding", "Acme site rules", "Forklift safety"}
    for name, titles in {
            "Standard onboarding": ["Dress code", "Confidentiality", "Work expectations"],
            "Acme site rules": ["Acme site rules (sample)", "Acme NDA (sample)"],
            "Forklift safety": ["Forklift safety (sample)"]}.items():
        items = list(await db.scalars(select(LearningPacketItem.document_id).where(
            LearningPacketItem.packet_id == packets[name].id)
            .order_by(LearningPacketItem.position)))
        assert items == [documents[t].id for t in titles]

    rule = (await db.scalars(select(LearningRule))).one()
    assert rule.enabled and rule.packet_id == packets["Standard onboarding"].id
    assert rule.conditions == [{"field": "everyone", "values": []}]


async def test_seed_is_idempotent(db, renderer):  # noqa: F811
    await seed(db, actor_id=None)
    await db.commit()
    before = await _counts(db)
    assert before["documents"] == 6 and before["versions"] == 6

    again = await seed(db, actor_id=None)
    await db.commit()
    assert again.total == 0
    assert await _counts(db) == before


async def test_seed_leaves_edited_pages_and_a_new_wiki_version_alone(db, renderer):  # noqa: F811
    await seed(db, actor_id=None)
    await db.commit()
    page = await db.get(WikiPage, (await db.scalar(select(LearningDocument.wiki_node_id).where(
        LearningDocument.title == "Dress code"))))
    page.draft_json = {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Our own policy."}]}]}
    await db.commit()

    await seed(db, actor_id=None)
    await db.commit()
    await db.refresh(page)
    assert page.draft_json["content"][0]["content"][0]["text"] == "Our own policy."


def test_render_server_down_exits_1_and_writes_nothing(renderer, cli_db):  # noqa: F811
    renderer.unreachable = True
    result = runner.invoke(app, ["learning-seed"])
    assert result.exit_code == 1
    assert "render server" in result.output
    assert "Nothing was changed" in result.output

    async def spaces():
        async with cli_db()() as db:
            return await db.scalar(select(func.count()).select_from(WikiSpace).where(
                WikiSpace.key == "learning"))
    assert asyncio.run(spaces()) == 0


def test_cli_seeds_and_a_second_run_adds_nothing(renderer, cli_db):  # noqa: F811
    first = runner.invoke(app, ["learning-seed"])
    assert first.exit_code == 0, first.output
    assert "Added:" in first.output and "6 document" in first.output
    second = runner.invoke(app, ["learning-seed"])
    assert second.exit_code == 0, second.output
    assert "Nothing to add" in second.output


def test_cli_refuses_an_unknown_actor_email(renderer, cli_db):  # noqa: F811
    result = runner.invoke(app, ["learning-seed", "--actor-email", "nobody@test.example.com"])
    assert result.exit_code == 2
    assert "No account" in result.output
