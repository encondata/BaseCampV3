"""`serversherpa learning-seed`: the Learning space, sample pages,
documents (published v1), packets and the Everyone rule — created once,
idempotent on a second run. The render server is the library tests'
httpx MockTransport stand-in; object storage is a dict."""
import asyncio

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from typer.testing import CliRunner

from serversherpa.cli import app
from serversherpa.config import get_settings
from serversherpa.db.models import WikiGrant, WikiNode, WikiPage, WikiPageAsset, WikiSpace
from serversherpa.learning.models import (
    LearningDocument,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningQuizQuestion,
    LearningRule,
)
from serversherpa.learning.seed import IMAGES, seed
from serversherpa.learning.seed_content import DOCUMENTS, SAMPLE_NOTICE, empty_text_nodes
from serversherpa.services import storage
from tests.test_learning_library import renderer, service_token  # noqa: F401

runner = CliRunner()

DRESS_SLIDES = ["dress-code-01.webp", "dress-code-02.webp", "dress-code-03.webp",
                "dress-code-04.webp"]
LABEL_SLIDES = [f"labels-0{n}.webp" for n in range(1, 6)]
LABEL_HEADINGS = ["How to read our labels", "Front label placement", "RFID tag placement",
                  "Top label placement", "Rail label placement"]


@pytest.fixture(autouse=True)
def stored(monkeypatch):
    """Fake object storage: key → (bytes, content type). Set `.down` to
    make every upload fail."""
    class Stored(dict):
        down = False
    objects = Stored()

    async def put_object(key, data, content_type):
        if objects.down:
            raise OSError("storage down")
        objects[key] = (data, content_type)
    monkeypatch.setattr(storage, "put_object", put_object)
    return objects


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
        "Labels": folders["Standard onboarding"].id,
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
        if seeded.title == "Dress code":     # the company's own slides, not a sample
            assert first["type"] == "paragraph"
        elif seeded.title == "Labels":       # also theirs, a heading on every slide
            assert first["type"] == "heading"
        else:
            assert first["type"] == "callout"
            assert first["content"][0]["content"][0]["text"] == SAMPLE_NOTICE
        assert 3 <= sum(1 for n in page.draft_json["content"] if n["type"] == "heading") <= 5
        version = await db.get(LearningDocumentVersion, document.current_version_id)
        assert (version.version_no, version.title) == (1, seeded.title)
        assert version.content_html

    dress = documents["Dress code"]
    assert dress.reading_style == "slides"
    for title, document in documents.items():
        if title not in ("Dress code", "Labels"):
            assert document.reading_style == "document", title
    assert (dress.validity_days, dress.resign_rule, dress.sign_style, dress.require_scroll,
            dress.min_read_seconds, dress.quiz_enabled) == (
        365, "expired_or_new_version", "typed_name", True, 60, False)
    dress_headings = [n["content"][0]["text"] for n in (await db.get(
        WikiPage, dress.wiki_node_id)).draft_json["content"] if n["type"] == "heading"]
    assert dress_headings == ["Shirt and name badge", "Pants and footwear", "Before you enter"]
    labels = documents["Labels"]
    assert (labels.reading_style, labels.validity_days, labels.resign_rule, labels.sign_style,
            labels.require_scroll, labels.min_read_seconds, labels.quiz_enabled) == (
        "slides", 365, "expired_or_new_version", "typed_name", True, 60, False)
    label_headings = [n["content"][0]["text"] for n in (await db.get(
        WikiPage, labels.wiki_node_id)).draft_json["content"] if n["type"] == "heading"]
    assert label_headings == LABEL_HEADINGS
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
            "Standard onboarding": ["Dress code", "Labels", "Confidentiality",
                                    "Work expectations"],
            "Acme site rules": ["Acme site rules (sample)", "Acme NDA (sample)"],
            "Forklift safety": ["Forklift safety (sample)"]}.items():
        items = list(await db.scalars(select(LearningPacketItem.document_id).where(
            LearningPacketItem.packet_id == packets[name].id)
            .order_by(LearningPacketItem.position)))
        assert items == [documents[t].id for t in titles]

    rule = (await db.scalars(select(LearningRule))).one()
    assert rule.enabled and rule.packet_id == packets["Standard onboarding"].id
    assert rule.conditions == [{"field": "everyone", "values": []}]


async def test_dress_code_slides_are_the_page_s_own_images(db, renderer, stored):  # noqa: F811
    await seed(db, actor_id=None)
    await db.commit()
    document = await db.scalar(select(LearningDocument).where(
        LearningDocument.title == "Dress code"))
    page = await db.get(WikiPage, document.wiki_node_id)
    images = [n["attrs"] for n in page.draft_json["content"] if n["type"] == "wikiImage"]
    assert [i["caption"] for i in images] == [
        "Datacenter dress code", "Shirt and name badge", "Pants and footwear",
        "Before you enter: your dress code checklist"]
    assets = {str(a.id): a for a in await db.scalars(select(WikiPageAsset))}
    slides = [assets[i["assetId"]] for i in images]
    assert [a.filename for a in slides] == DRESS_SLIDES
    for asset in slides:
        assert asset.node_id == page.node_id and asset.content_type == "image/webp"
        data, content_type = stored[asset.storage_key]
        assert data == (IMAGES / asset.filename).read_bytes()
        assert content_type == "image/webp" and asset.size_bytes == len(data)
    assert len(stored) == 9         # Dress code's 4 and Labels' 5; no other page has images

    version = await db.get(LearningDocumentVersion, document.current_version_id)
    assert [str(i) for i in version.image_asset_ids] == [i["assetId"] for i in images]
    assert (document.summary, version.change_note) == (
        "What to wear for every visit.", "First version.")


async def test_label_slides_are_the_page_s_own_images(db, renderer, stored):  # noqa: F811
    await seed(db, actor_id=None)
    await db.commit()
    document = await db.scalar(select(LearningDocument).where(
        LearningDocument.title == "Labels"))
    page = await db.get(WikiPage, document.wiki_node_id)
    content = page.draft_json["content"]
    # each heading is followed by its slide image
    pairs = [(n["content"][0]["text"], content[i + 1]) for i, n in enumerate(content)
             if n["type"] == "heading"]
    assert [heading for heading, _ in pairs] == LABEL_HEADINGS
    assert all(after["type"] == "wikiImage" for _, after in pairs)
    images = [after["attrs"] for _, after in pairs]
    assert [i["caption"] for i in images] == LABEL_HEADINGS
    assets = {str(a.id): a for a in await db.scalars(select(WikiPageAsset))}
    slides = [assets[i["assetId"]] for i in images]
    assert [a.filename for a in slides] == LABEL_SLIDES
    for asset in slides:
        assert asset.node_id == page.node_id and asset.content_type == "image/webp"
        data, _ = stored[asset.storage_key]
        assert data == (IMAGES / asset.filename).read_bytes()

    version = await db.get(LearningDocumentVersion, document.current_version_id)
    assert [str(i) for i in version.image_asset_ids] == [i["assetId"] for i in images]


async def test_seed_is_idempotent(db, renderer, stored):  # noqa: F811
    await seed(db, actor_id=None)
    await db.commit()
    before = await _counts(db)
    assert before["documents"] == 7 and before["versions"] == 7
    uploads = dict(stored)

    again = await seed(db, actor_id=None)
    await db.commit()
    assert again.total == 0
    assert await _counts(db) == before
    assert stored == uploads


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


def test_storage_down_exits_1_and_adds_nothing(renderer, cli_db, stored):  # noqa: F811
    stored.down = True
    result = runner.invoke(app, ["learning-seed"])
    assert result.exit_code == 1
    assert "Object storage refused a sample image (OSError)" in result.output
    assert "Nothing was added" in result.output

    async def spaces():
        async with cli_db()() as db:
            return await db.scalar(select(func.count()).select_from(WikiSpace).where(
                WikiSpace.key == "learning"))
    assert asyncio.run(spaces()) == 0


def test_cli_seeds_and_a_second_run_adds_nothing(renderer, cli_db):  # noqa: F811
    first = runner.invoke(app, ["learning-seed"])
    assert first.exit_code == 0, first.output
    assert "Added:" in first.output and "7 document" in first.output
    second = runner.invoke(app, ["learning-seed"])
    assert second.exit_code == 0, second.output
    assert "Nothing to add" in second.output


def test_cli_refuses_an_unknown_actor_email(renderer, cli_db):  # noqa: F811
    result = runner.invoke(app, ["learning-seed", "--actor-email", "nobody@test.example.com"])
    assert result.exit_code == 2
    assert "No account" in result.output
