"""`serversherpa learning-seed`: the wiki Learning space with sample policy
pages, their learning documents (published as v1), the packets and the
Everyone rule. Idempotent: the space is found by key, folders and pages by
parent + title, documents by their page, packets and the rule by name, so
a second run adds nothing and never overwrites a page someone has edited.

It publishes each page in the wiki and snapshots it as the document's v1,
which needs the wiki render server (the snapshot's HTML is rendered once,
`render.py`); `check_render_server` finds out before anything is written.
The Acme and forklift packets get no rule: client ids differ per install,
so those rules are added in the portal.

Nothing here commits; the CLI does."""
import uuid
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import WikiGrant, WikiNode, WikiPage, WikiSpace
from serversherpa.learning import LEARNING_SPACE_KEY, library, packets, quiz, rules
from serversherpa.learning.models import (
    LearningDocument,
    LearningPacket,
    LearningQuizQuestion,
    LearningRule,
)
from serversherpa.learning.render import render_version_html
from serversherpa.learning.seed_content import (
    DOC_TYPE,
    DOCUMENTS,
    EVERYONE_RULE,
    FOLDERS,
    PACKETS,
    SPACE,
    SeedDoc,
    empty_text_nodes,
)
from serversherpa.wiki import pages, tree
from serversherpa.wiki.content import EMPTY_DOC
from serversherpa.wiki.spaces import create_space

# learning admins author the pages, so they manage the space
ADMIN_ROLE = "learning_admin"


@dataclass
class SeedResult:
    """What a run added; empty everywhere on a second run."""
    created: dict[str, int] = field(default_factory=dict)

    def add(self, kind: str) -> None:
        self.created[kind] = self.created.get(kind, 0) + 1

    @property
    def total(self) -> int:
        return sum(self.created.values())


async def check_render_server() -> None:
    """Raises LearningRenderUnavailable / LearningRenderRejected when the
    wiki render server can't render a page."""
    await render_version_html(EMPTY_DOC)


async def _space(db: AsyncSession, actor_id: uuid.UUID | None, result: SeedResult) -> WikiSpace:
    space = await db.scalar(select(WikiSpace).where(WikiSpace.key == LEARNING_SPACE_KEY))
    if space is None:
        space = await create_space(db, actor_id=actor_id, **SPACE)
        result.add("space")
    has_grant = await db.scalar(select(WikiGrant.id).where(
        WikiGrant.space_id == space.id, WikiGrant.node_id.is_(None),
        WikiGrant.principal_type == "role", WikiGrant.principal_id == ADMIN_ROLE))
    if has_grant is None:
        db.add(WikiGrant(space_id=space.id, principal_type="role", principal_id=ADMIN_ROLE,
                         level="manage", created_by=actor_id))
        await db.flush()
        result.add("space grant")
    return space


async def _child(db: AsyncSession, space: WikiSpace, parent: WikiNode | None, kind: str,
                 title: str) -> WikiNode | None:
    under = WikiNode.parent_id.is_(None) if parent is None else WikiNode.parent_id == parent.id
    return await db.scalar(select(WikiNode).where(
        WikiNode.space_id == space.id, WikiNode.kind == kind, WikiNode.title == title,
        under, WikiNode.deleted_at.is_(None)))


async def _folders(db: AsyncSession, space: WikiSpace, actor_id: uuid.UUID | None,
                   result: SeedResult) -> dict[str, WikiNode]:
    folders = {}
    for title in FOLDERS:
        node = await _child(db, space, None, "folder", title)
        if node is None:
            node = await tree.create_node(db, space=space, parent=None, kind="folder",
                                          title=title, actor_id=actor_id)
            result.add("folder")
        folders[title] = node
    return folders


async def _page(db: AsyncSession, space: WikiSpace, folder: WikiNode, seed: SeedDoc,
                actor_id: uuid.UUID | None, result: SeedResult) -> WikiNode:
    """The published page, created if missing. An existing page is left
    as it is unless it was never published (then its draft, or the sample
    text, is published)."""
    node = await _child(db, space, folder, "page", seed.title)
    if node is None:
        node = await tree.create_node(db, space=space, parent=folder, kind="page",
                                      title=seed.title, actor_id=actor_id)
        result.add("page")
    page = await db.get(WikiPage, node.id)
    if page.published_version_id is None:
        if page.draft_json is None:
            content = pages.check_doc(seed.content)
            assert empty_text_nodes(content) == 0, seed.title
            page.draft_json = content
            page.draft_text = pages.doc_text(content)
            page.draft_updated_by = actor_id
            page.draft_updated_at = pages.utcnow()
        if page.doc_type is None:
            page.doc_type = DOC_TYPE
        await db.flush()
        await pages.publish(db, node, page, actor_id=actor_id, note=seed.change_note)
    return node


async def _document(db: AsyncSession, node: WikiNode, seed: SeedDoc,
                    actor_id: uuid.UUID | None, result: SeedResult) -> LearningDocument:
    document = await db.scalar(select(LearningDocument).where(
        LearningDocument.wiki_node_id == node.id, LearningDocument.archived_at.is_(None)))
    if document is None:
        document = await library.create_document(
            db, actor_id=actor_id, title=seed.title, wiki_node_id=node.id,
            summary=seed.summary, **seed.settings)
        result.add("document")
    if document.current_version_id is None:
        await library.publish_version(db, document, actor_id=actor_id,
                                      change_note=seed.change_note)
        result.add("version")
    if seed.questions:
        asked = await db.scalar(select(func.count()).select_from(LearningQuizQuestion)
                                .where(LearningQuizQuestion.document_id == document.id))
        if not asked:
            for question in seed.questions:
                await _question(db, document, question, actor_id)
                result.add("quiz question")
    return document


async def _question(db: AsyncSession, document: LearningDocument, question,
                    actor_id: uuid.UUID | None) -> None:
    """A question whose correct choice is named by position: choice ids
    are generated, so the correct one is found after they are."""
    ids = [uuid.uuid4().hex[:8] for _ in question.choices]
    await quiz.create_question(
        db, document.id, prompt=question.prompt,
        choices=[{"id": cid, "text": text} for cid, text in zip(ids, question.choices)],
        correct_choice_ids=[ids[question.correct]], translations={}, languages=[],
        actor_id=actor_id)


async def _packets(db: AsyncSession, documents: dict[str, LearningDocument],
                   actor_id: uuid.UUID | None, result: SeedResult) -> dict[str, LearningPacket]:
    out = {}
    for name, description, titles in PACKETS:
        packet = await db.scalar(select(LearningPacket).where(
            LearningPacket.name == name, LearningPacket.archived_at.is_(None)))
        if packet is None:
            packet = await packets.create_packet(
                db, actor_id=actor_id, name=name, description=description,
                items=[documents[t].id for t in titles])
            result.add("packet")
        out[name] = packet
    return out


async def _rule(db: AsyncSession, packet_by_name: dict[str, LearningPacket],
                actor_id: uuid.UUID | None, result: SeedResult) -> None:
    name, packet_name = EVERYONE_RULE
    if await db.scalar(select(LearningRule.id).where(LearningRule.name == name)) is None:
        await rules.create_rule(
            db, actor_id=actor_id, name=name, packet_id=packet_by_name[packet_name].id,
            conditions=[{"field": "everyone", "values": []}])
        result.add("rule")


async def seed(db: AsyncSession, *, actor_id: uuid.UUID | None) -> SeedResult:
    """Create whatever of the sample Learning space is missing. Raises
    LearningRenderUnavailable / LearningRenderRejected when a page can't
    be rendered (the caller rolls back)."""
    result = SeedResult()
    space = await _space(db, actor_id, result)
    folders = await _folders(db, space, actor_id, result)
    documents: dict[str, LearningDocument] = {}
    for seed_doc in DOCUMENTS:
        node = await _page(db, space, folders[seed_doc.folder], seed_doc, actor_id, result)
        documents[seed_doc.title] = await _document(db, node, seed_doc, actor_id, result)
    packet_by_name = await _packets(db, documents, actor_id, result)
    await _rule(db, packet_by_name, actor_id, result)
    return result
