"""Wiki Phase 1 schema — tables exist, key checks and constraints hold,
and the `wiki` resource's default role grants match the spec (view to
every role; add to internal staff+; delete to admin+)."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from serversherpa.access.resolver import resolve_access
from serversherpa.db.models import Client, Person, PersonRole, WikiNode, WikiSpace

WIKI_TABLES = (
    "wiki_spaces", "wiki_nodes", "wiki_pages", "wiki_page_versions",
    "wiki_files", "wiki_file_versions", "wiki_page_assets", "wiki_grants",
    "wiki_favorites", "wiki_jobs",
)

ALL_ROLES = {
    "developer", "founder", "super_admin", "admin", "staff",
    "client_owner", "client_admin", "client_viewer",
    "vendor_owner", "vendor_admin", "vendor_viewer", "worker", "external",
}


async def test_wiki_tables_exist(db):
    for table in WIKI_TABLES:
        row = await db.scalar(text(f"SELECT to_regclass('{table}')"))
        assert row is not None, f"{table} missing"


async def test_space_key_check(db):
    db.add(WikiSpace(key="Bad Key", name="Bad"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(WikiSpace(key="ops-guides", name="Ops Guides"))
    await db.commit()


async def test_node_title_length_check(db):
    space = WikiSpace(key="docs", name="Docs")
    db.add(space)
    await db.flush()
    db.add(WikiNode(space_id=space.id, kind="folder", title=""))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_wiki_view_granted_to_every_role(db):
    view_roles = set((await db.scalars(text(
        "SELECT role FROM role_permissions WHERE resource='wiki' AND action='view'"
    ))).all())
    assert view_roles == ALL_ROLES

    add_roles = set((await db.scalars(text(
        "SELECT role FROM role_permissions WHERE resource='wiki' AND action='add'"
    ))).all())
    assert add_roles == {"developer", "founder", "super_admin", "admin", "staff"}
    assert add_roles.isdisjoint({
        "client_owner", "client_admin", "client_viewer",
        "vendor_owner", "vendor_admin", "vendor_viewer", "worker", "external"})

    delete_roles = set((await db.scalars(text(
        "SELECT role FROM role_permissions WHERE resource='wiki' AND action='delete'"
    ))).all())
    assert delete_roles == {"developer", "founder", "super_admin", "admin"}


async def test_client_viewer_can_view_wiki(db):
    """A client-scoped viewer with a login (headers). person_roles_client_scope_check
    requires a client_id, so the role is built directly here."""
    org = Client(name="Org for wiki viewer")
    db.add(org)
    await db.flush()
    contact = Person(first_name="C", last_name="Viewer", email="cv-wiki@test.example.com")
    db.add(contact)
    await db.flush()
    db.add(PersonRole(person_id=contact.id, role="client_viewer", client_id=org.id))
    await db.commit()

    access = await resolve_access(db, contact.id)
    assert access.can("wiki", "view") is True
