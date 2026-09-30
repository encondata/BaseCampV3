"""Private items and "Allow printing" in the wiki access check
(serversherpa.wiki.permissions, spec 2026-09-30 §1–§3).

Direct DB fixtures, no HTTP — the space/grant/principal builders are the
ones `test_wiki_permissions.py` already uses for the resolver."""
import uuid
from datetime import UTC, datetime

from sqlalchemy import event

from serversherpa.db.engine import get_engine
from serversherpa.wiki import space_settings
from serversherpa.wiki.permissions import (
    AccessIndex,
    can_set_private,
    is_developer,
)
from tests.test_wiki_permissions import (
    _grant,
    _level,
    _node,
    _person,
    _principal,
    _space,
    _staff,
)

# ── helpers ─────────────────────────────────────────────────────────


async def _item(db, space, parent=None, *, author=None, title="Item", kind="page",
                private=False, printing=None):
    """A node with an author, a private flag and an explicit printing value."""
    n = await _node(db, space, parent, title=title, kind=kind)
    n.created_by = author.id if author else None
    n.is_private = private
    n.allow_printing = printing
    await db.flush()
    return n


def _developer(person_id=None, **kw):
    return _principal(person_id, roles={"staff", "developer"}, is_internal=True, **kw)


async def _library(db, **settings):
    space = await _space(db, key=f"pp-{uuid.uuid4().hex[:8]}")
    if settings:
        space.settings = settings
        await db.flush()
    await _grant(db, space, "internal", None, "view")
    return space


# ── private page ────────────────────────────────────────────────────


async def test_private_page_author_manages_even_with_only_view(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    page = await _item(db, space, author=author, private=True)
    assert await _level(db, _staff(author.id), page) == "manage"


async def test_private_page_developer_manages_without_grants_beyond_view(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    page = await _item(db, space, author=author, private=True)
    assert await _level(db, _developer(), page) == "manage"


async def test_private_page_wiki_admin_gets_nothing(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    page = await _item(db, space, author=author, private=True)
    admin = _staff(is_admin=True)
    assert await _level(db, admin, page) is None
    # the rest of the library is untouched for the administrator
    other = await _item(db, space, author=author)
    assert await _level(db, admin, other) == "manage"
    assert await AccessIndex(db, admin).level_for_space(space.id) == "manage"


async def test_private_page_library_manager_gets_nothing(db):
    author = await _person(db, "Ava", "Author")
    manager = await _person(db, "Mona", "Manager")
    space = await _library(db)
    await _grant(db, space, "person", manager.id, "manage")
    page = await _item(db, space, author=author, private=True)
    assert await _level(db, _staff(manager.id), page) is None
    # a direct grant on the node doesn't help either
    await _grant(db, space, "person", manager.id, "manage", node=page)
    assert await _level(db, _staff(manager.id), page) is None


async def test_private_page_reader_gets_nothing(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    page = await _item(db, space, author=author, private=True)
    assert await _level(db, _staff(), page) is None
    # a client user with an everyone grant, too
    await _grant(db, space, "everyone", None, "edit")
    assert await _level(db, _principal(roles={"client_viewer"}), page) is None


async def test_private_page_without_an_author_is_developers_only(db):
    space = await _library(db)
    page = await _item(db, space, author=None, private=True)
    assert await _level(db, _staff(), page) is None
    assert await _level(db, _developer(), page) == "manage"


async def test_private_needs_wiki_view_even_for_the_author_and_developers(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    page = await _item(db, space, author=author, private=True)
    assert await _level(db, _staff(author.id, can_view_wiki=False), page) is None
    assert await _level(db, _developer(can_view_wiki=False), page) is None


async def test_private_in_an_archived_library_is_read_only_for_the_author(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    space.archived_at = datetime.now(UTC)
    page = await _item(db, space, author=author, private=True)
    assert await _level(db, _staff(author.id), page) == "view"
    assert await _level(db, _developer(), page) == "view"
    # a developer who is also a wiki administrator keeps manage, like any admin
    assert await _level(db, _developer(is_admin=True), page) == "manage"


async def test_trashed_private_page_stays_private(db):
    author = await _person(db, "Ava", "Author")
    manager = await _person(db, "Mona", "Manager")
    space = await _library(db)
    await _grant(db, space, "person", manager.id, "manage")
    page = await _item(db, space, author=author, private=True)
    page.deleted_at = datetime.now(UTC)
    await db.flush()
    assert await _level(db, _staff(manager.id), page) is None
    assert await _level(db, _staff(author.id), page) == "manage"


# ── private folder ──────────────────────────────────────────────────


async def test_private_folder_hides_a_child_from_its_own_author(db):
    a = await _person(db, "Ava", "Author")
    c = await _person(db, "Cy", "Contributor")
    space = await _library(db)
    await _grant(db, space, "person", c.id, "edit")
    folder = await _item(db, space, author=a, kind="folder", private=True)
    child = await _item(db, space, folder, author=c)
    grandchild = await _item(db, space, child, author=c)

    assert await _level(db, _staff(c.id), child) is None
    assert await _level(db, _staff(c.id), grandchild) is None
    assert await _level(db, _staff(a.id), folder) == "manage"
    assert await _level(db, _staff(a.id), child) == "manage"
    assert await _level(db, _staff(a.id), grandchild) == "manage"
    assert await _level(db, _developer(), grandchild) == "manage"


# ── nested private ──────────────────────────────────────────────────


async def test_nested_private_needs_every_author_or_a_developer(db):
    a = await _person(db, "Ava", "Author")
    b = await _person(db, "Bo", "Builder")
    space = await _library(db)
    folder = await _item(db, space, author=a, kind="folder", private=True)
    page = await _item(db, space, folder, author=b, private=True)

    assert await _level(db, _staff(a.id), folder) == "manage"
    assert await _level(db, _staff(a.id), page) is None
    assert await _level(db, _staff(b.id), page) is None
    assert await _level(db, _developer(), page) == "manage"
    assert await _level(db, _staff(is_admin=True), page) is None

    # someone who is both A and B: the same author on both levels
    own = await _item(db, space, folder, author=a, private=True)
    assert await _level(db, _staff(a.id), own) == "manage"


# ── helpers on Principal ────────────────────────────────────────────


async def test_is_developer_and_can_set_private(db):
    author = await _person(db, "Ava", "Author")
    space = await _library(db)
    page = await _item(db, space, author=author)
    orphan = await _item(db, space, author=None)

    assert is_developer(_developer()) is True
    assert is_developer(_staff(is_admin=True)) is False
    assert can_set_private(_staff(author.id), page) is True
    assert can_set_private(_staff(), page) is False
    assert can_set_private(_staff(is_admin=True), page) is False
    assert can_set_private(_developer(), page) is True
    assert can_set_private(_staff(), orphan) is False
    assert can_set_private(_developer(), orphan) is True


# ── batching ────────────────────────────────────────────────────────


async def test_private_and_printing_load_in_the_same_three_queries(db):
    author = await _person(db, "Ava", "Author")
    spaces, nodes = [], []
    for i in range(3):
        space = await _library(db, allow_printing=bool(i % 2))
        spaces.append(space)
        parent = None
        for j in range(12):
            parent = await _item(db, space, parent if j % 4 else None,
                                 author=author, title=f"N{j}",
                                 private=(j % 5 == 2),
                                 printing=(None if j % 3 else j % 2 == 0))
            nodes.append(parent)
    await db.commit()

    statements: list[str] = []

    def _count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    for who in (_staff(author.id), _staff(is_admin=True), _developer()):
        statements.clear()
        event.listen(engine, "before_cursor_execute", _count)
        try:
            ix = AccessIndex(db, who)
            levels = await ix.levels_for_nodes(nodes)
            for n in nodes:
                await ix.can_print(n)
                await ix.printing_source(n)
                await ix.level_for_node(n)
        finally:
            event.remove(engine, "before_cursor_execute", _count)
        assert set(levels) == {n.id for n in nodes}
        assert len(statements) == 3, statements


# ── printing inheritance ────────────────────────────────────────────


async def test_printing_defaults_to_the_library_default_true(db):
    space = await _library(db)
    folder = await _item(db, space, kind="folder")
    page = await _item(db, space, folder)
    ix = AccessIndex(db, _staff())
    assert await ix.can_print(page) is True
    assert await ix.printing_source(page) == (True, None)
    assert await ix.can_print(folder) is True


async def test_library_setting_off_turns_printing_off_everywhere(db):
    space = await _library(db, allow_printing=False)
    folder = await _item(db, space, kind="folder")
    page = await _item(db, space, folder)
    ix = AccessIndex(db, _staff(is_admin=True))
    assert await ix.can_print(folder) is False
    assert await ix.can_print(page) is False
    assert await ix.printing_source(page) == (False, None)


async def test_folder_off_turns_a_child_off_and_a_page_can_turn_it_back_on(db):
    space = await _library(db)
    folder = await _item(db, space, kind="folder", printing=False)
    child = await _item(db, space, folder)
    grandchild = await _item(db, space, child)
    allowed = await _item(db, space, folder, printing=True)
    under_allowed = await _item(db, space, allowed)
    ix = AccessIndex(db, _staff())

    assert await ix.can_print(child) is False
    assert await ix.printing_source(child) == (False, folder.id)
    assert await ix.printing_source(grandchild) == (False, folder.id)
    assert await ix.can_print(allowed) is True
    assert await ix.printing_source(allowed) == (True, allowed.id)
    assert await ix.printing_source(under_allowed) == (True, allowed.id)


async def test_a_node_allowed_under_a_library_that_is_off(db):
    space = await _library(db, allow_printing=False)
    folder = await _item(db, space, kind="folder", printing=True)
    page = await _item(db, space, folder)
    ix = AccessIndex(db, _staff())
    assert await ix.printing_source(page) == (True, folder.id)


async def test_printing_uses_the_nodes_own_current_value(db):
    """A value changed on the node after the space was loaded (a PATCH in
    the same request) is what the node's own printing reports."""
    space = await _library(db)
    page = await _item(db, space)
    ix = AccessIndex(db, _staff())
    assert await ix.can_print(page) is True
    page.allow_printing = False
    assert await ix.printing_source(page) == (False, page.id)


# ── space setting ───────────────────────────────────────────────────


def test_allow_printing_space_setting_validates_and_defaults_true():
    assert space_settings.validate("allow_printing", True) is True
    assert space_settings.validate("allow_printing", False) is True
    assert space_settings.validate("allow_printing", "yes") is False
    assert space_settings.validate("allow_printing", 1) is False
    assert space_settings.DEFAULTS["allow_printing"] is True
