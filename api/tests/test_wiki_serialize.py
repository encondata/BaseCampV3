"""`nodes_out` — the batch NodeOut serializer every node listing uses.
Direct DB fixtures, no HTTP."""
import uuid

from sqlalchemy import event

from serversherpa.api.routes.wiki.deps import WikiCtx
from serversherpa.api.routes.wiki.serialize import node_out, nodes_out
from serversherpa.db.engine import get_engine
from serversherpa.db.models import (
    Person, WikiFavorite, WikiFile, WikiFileVersion, WikiNode, WikiPage,
    WikiPageVersion, WikiSpace,
)
from serversherpa.wiki.permissions import AccessIndex, Principal


def _principal(person_id) -> Principal:
    return Principal(
        person_id=person_id, roles=frozenset({"staff"}), group_ids=frozenset(),
        client_ids=frozenset(), partner_ids=frozenset(), is_internal=True,
        is_admin=False, can_view_wiki=True)


def _ctx(db, person_id) -> WikiCtx:
    principal = _principal(person_id)
    return WikiCtx(db=db, user=None, principal=principal,
                   ix=AccessIndex(db, principal))


async def _build_tree(db, n_children: int):
    """A space with a folder holding `n_children` children cycling
    folder / published page / unpublished page / file; each child folder
    has a child of its own. Returns (space, folder, children, people)."""
    owner = Person(first_name="Olive", last_name="Owner")
    editor = Person(first_name="Ed", last_name="Itor", preferred_name="Eddie")
    db.add_all([owner, editor])
    await db.flush()

    space = WikiSpace(key=f"ser-{uuid.uuid4().hex[:8]}", name="Serialize")
    db.add(space)
    await db.flush()
    folder = WikiNode(space_id=space.id, path=[], kind="folder", title="Root",
                      owner_id=owner.id, updated_by=editor.id)
    db.add(folder)
    await db.flush()

    children = []
    for i in range(n_children):
        kind = ("folder", "page", "page", "file")[i % 4]
        node = WikiNode(space_id=space.id, parent_id=folder.id, path=[folder.id],
                        kind=kind, title=f"Child {i}", position=float(i),
                        owner_id=owner.id, updated_by=editor.id)
        db.add(node)
        await db.flush()
        children.append(node)
        if kind == "folder":
            db.add(WikiNode(space_id=space.id, parent_id=node.id,
                            path=[folder.id, node.id], kind="page", title="Grandchild"))
        elif kind == "page":
            page = WikiPage(node_id=node.id, has_unpublished_changes=(i % 4 == 2))
            db.add(page)
            await db.flush()
            if i % 4 == 1:
                version = WikiPageVersion(node_id=node.id, version_no=1, title=node.title,
                                          content_json={}, kind="published")
                db.add(version)
                await db.flush()
                page.published_version_id = version.id
        else:
            db.add(WikiFile(node_id=node.id, description=f"File {i}"))
            await db.flush()
            version = WikiFileVersion(
                node_id=node.id, version_no=1, storage_key=f"k/{node.id}",
                filename=f"f{i}.pdf", content_type="application/pdf",
                size_bytes=10, preview_kind="none", uploaded_by=editor.id)
            db.add(version)
            await db.flush()
            (await db.get(WikiFile, node.id)).current_version_id = version.id
    await db.flush()
    return space, folder, children, (owner, editor)


async def _count_statements(coro_fn):
    statements: list[str] = []

    def _count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", _count)
    try:
        result = await coro_fn()
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    return result, statements


async def test_nodes_out_serializes_every_shape(db):
    space, folder, children, (owner, editor) = await _build_tree(db, 4)
    db.add(WikiFavorite(person_id=owner.id, node_id=children[1].id))
    await db.commit()
    ctx = _ctx(db, owner.id)

    levels = {c.id: "edit" for c in children}
    out = await nodes_out(ctx, children, levels)
    by_id = {o.id: o for o in out}
    assert [o.id for o in out] == [c.id for c in children]

    sub_folder, published, draft_only, file_node = children
    assert by_id[sub_folder.id].has_children is True
    assert by_id[sub_folder.id].page is None and by_id[sub_folder.id].file is None
    assert by_id[sub_folder.id].owner.name == "Olive Owner"
    assert by_id[sub_folder.id].updated_by.name == "Eddie Itor"
    assert by_id[sub_folder.id].space_key == space.key
    assert by_id[sub_folder.id].my_level == "edit"

    pub = by_id[published.id]
    assert pub.is_favorite is True
    assert pub.page.published_version_id is not None
    assert pub.page.published_at is not None
    assert pub.page.is_home is False
    assert by_id[draft_only.id].page.published_version_id is None
    assert by_id[draft_only.id].page.published_at is None
    assert by_id[draft_only.id].page.has_unpublished_changes is True
    assert by_id[draft_only.id].is_favorite is False

    f = by_id[file_node.id].file
    assert f.description == "File 3"
    assert f.current_version.filename == "f3.pdf"
    assert f.current_version.uploaded_by.name == "Eddie Itor"


async def test_has_children_hides_unpublished_pages_from_view_only(db):
    space, folder, children, (owner, _) = await _build_tree(db, 1)
    # the only grandchild is a page without a published version
    await db.commit()
    ctx = _ctx(db, owner.id)
    sub_folder = children[0]
    assert (await node_out(ctx, sub_folder, "view")).has_children is False
    assert (await node_out(ctx, sub_folder, "edit")).has_children is True
    assert (await node_out(ctx, folder, "view")).has_children is True


async def test_nodes_out_uses_a_fixed_number_of_statements(db):
    _, _, small, (owner, _) = await _build_tree(db, 4)
    _, _, large, _ = await _build_tree(db, 32)
    await db.commit()
    ctx = _ctx(db, owner.id)

    small_out, small_stmts = await _count_statements(
        lambda: nodes_out(ctx, small, {n.id: "edit" for n in small}))
    large_out, large_stmts = await _count_statements(
        lambda: nodes_out(ctx, large, {n.id: "edit" for n in large}))

    assert len(small_out) == 4 and len(large_out) == 32
    # spaces, pages, files, people, favorites, child counts
    assert len(small_stmts) == len(large_stmts) == 6, large_stmts


async def test_nodes_out_empty_is_free(db):
    person = Person(first_name="No", last_name="Body")
    db.add(person)
    await db.flush()
    out, stmts = await _count_statements(lambda: nodes_out(_ctx(db, person.id), [], {}))
    assert out == [] and stmts == []
