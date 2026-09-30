"""Private items and printing, the final review's fixes (spec 2026-09-30):
nothing becomes someone else's by being made private or moved into a
private folder (409 `others_items`, 409 `hidden_items`), leaving a private
folder or the trash keeps an item private and unprintable, copies keep
privacy, a reorder never pins printing, and the payload's `in_private`,
`has_children` and `can_set_private`, a help link's edit and an export's
status never give away a private item."""
import uuid

from sqlalchemy import select

from serversherpa.db.models import WikiFile, WikiFileVersion, WikiGrant, WikiNode
from tests.wiki_helpers import _create, _setup, login_as, publish_via_db


def _code(resp):
    return resp.json()["detail"]["code"]


async def _get(client, headers, node_id, expect=200):
    resp = await client.get(f"/wiki/nodes/{node_id}", headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _privacy(client, headers, node_id, value=True):
    return await client.patch(f"/wiki/nodes/{node_id}/privacy", headers=headers,
                              json={"is_private": value})


async def _private(client, headers, node_id):
    resp = await _privacy(client, headers, node_id)
    assert resp.status_code == 200, resp.text


async def _printing(client, headers, node_id, value):
    resp = await client.patch(f"/wiki/nodes/{node_id}/printing", headers=headers,
                              json={"allow_printing": value})
    assert resp.status_code == 200, resp.text


async def _move(client, headers, node_id, parent_id, **anchor):
    return await client.post(f"/wiki/nodes/{node_id}/move", headers=headers,
                             json={"parent_id": parent_id, **anchor})


async def _copy(client, headers, node_id, parent_id=None):
    resp = await client.post(f"/wiki/nodes/{node_id}/copy", headers=headers,
                             json={"parent_id": parent_id})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _developer(client, db):
    return (await login_as(client, db, roles=("staff", "developer")))[0]


async def _page(client, headers, s, title, parent=None, db=None):
    page = await _create(client, headers, s["space"], title, kind="page", parent=parent)
    if db is not None:
        await publish_via_db(db, page["id"])
    return page


async def _row(db, node_id):
    return await db.scalar(select(WikiNode).where(WikiNode.id == uuid.UUID(str(node_id)))
                           .execution_options(populate_existing=True))


async def _delete(client, headers, node_id):
    resp = await client.delete(f"/wiki/nodes/{node_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["batch_id"]


async def _hide_from_all_but_the_owner(db, s, node_id):
    """Break `node_id`'s inheritance: only the space's managers (the
    owner) keep it."""
    row = await db.get(WikiNode, uuid.UUID(node_id))
    row.inherit_permissions = False
    db.add(WikiGrant(space_id=row.space_id, node_id=row.id, principal_type="person",
                     principal_id=str(s["owner_id"]), level="manage"))
    await db.commit()


# ── C1: making a folder private captures nothing ────────────────────


async def test_a_view_only_author_cannot_make_private_a_folder_holding_someone_elses_page(
        client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    theirs = await _page(client, s["owner"], s, "Theirs", parent=folder, db=db)
    # the viewer authored the folder but only has view on it
    row = await db.get(WikiNode, uuid.UUID(folder["id"]))
    row.created_by = s["viewer_id"]
    await db.commit()
    assert (await _get(client, s["viewer"], folder["id"]))["my_level"] == "view"

    resp = await _privacy(client, s["viewer"], folder["id"])
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {
        "code": "others_items",
        "message": "Everything inside must be yours to make this private."}
    assert (await _row(db, folder["id"])).is_private is False
    await _get(client, s["owner"], theirs["id"])


async def test_a_trashed_item_of_someone_elses_inside_counts_too(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["editor"], s["space"], "Folder")
    theirs = await _page(client, s["owner"], s, "Theirs", parent=folder)
    await _delete(client, s["owner"], theirs["id"])
    resp = await _privacy(client, s["editor"], folder["id"])
    assert resp.status_code == 409, resp.text
    assert _code(resp) == "others_items"


async def test_a_folder_holding_an_item_the_author_cannot_see_is_hidden_items(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["editor"], s["space"], "Folder")
    hidden = await _page(client, s["editor"], s, "Hidden", parent=folder, db=db)
    await _hide_from_all_but_the_owner(db, s, hidden["id"])
    await _get(client, s["editor"], hidden["id"], expect=404)

    resp = await _privacy(client, s["editor"], folder["id"])
    assert resp.status_code == 409, resp.text
    assert _code(resp) == "hidden_items"
    assert (await _row(db, folder["id"])).is_private is False


async def test_a_developer_can_make_a_mixed_author_folder_private(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    await _page(client, s["editor"], s, "Editor's", parent=folder, db=db)
    dev = await _developer(client, db)
    resp = await _privacy(client, dev, folder["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_private"] is True


async def test_clearing_privacy_is_never_refused_for_what_is_inside(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    await _page(client, s["editor"], s, "Editor's", parent=folder, db=db)
    dev = await _developer(client, db)
    await _private(client, dev, folder["id"])
    resp = await _privacy(client, s["owner"], folder["id"], False)
    assert resp.status_code == 200, resp.text


# ── C1: moving into a private folder captures nothing ───────────────


async def test_moving_someone_elses_page_into_my_private_folder_is_refused(client, db):
    s = await _setup(client, db)
    mine = await _create(client, s["editor"], s["space"], "Mine")
    await _private(client, s["editor"], mine["id"])
    theirs = await _page(client, s["owner"], s, "Theirs", db=db)

    resp = await _move(client, s["editor"], theirs["id"], mine["id"])
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {
        "code": "others_items",
        "message": "Only your own items can go into a private folder."}
    row = await _row(db, theirs["id"])
    assert row.parent_id is None
    await _get(client, s["owner"], theirs["id"])


async def test_moving_a_folder_with_someone_elses_page_inside_into_it_is_refused(client, db):
    s = await _setup(client, db)
    mine = await _create(client, s["editor"], s["space"], "Mine")
    await _private(client, s["editor"], mine["id"])
    carrier = await _create(client, s["editor"], s["space"], "Carrier")
    await _page(client, s["owner"], s, "Theirs", parent=carrier, db=db)
    resp = await _move(client, s["editor"], carrier["id"], mine["id"])
    assert resp.status_code == 409, resp.text
    assert _code(resp) == "others_items"


async def test_moving_my_own_page_into_my_private_folder_is_fine(client, db):
    s = await _setup(client, db)
    mine = await _create(client, s["editor"], s["space"], "Mine")
    await _private(client, s["editor"], mine["id"])
    page = await _page(client, s["editor"], s, "My page", db=db)

    resp = await _move(client, s["editor"], page["id"], mine["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["in_private"] is True
    await _get(client, s["viewer"], page["id"], expect=404)


async def test_moving_an_item_with_a_hidden_descendant_into_a_private_folder_is_refused(
        client, db):
    s = await _setup(client, db)
    mine = await _create(client, s["editor"], s["space"], "Mine")
    await _private(client, s["editor"], mine["id"])
    carrier = await _create(client, s["editor"], s["space"], "Carrier")
    hidden = await _page(client, s["editor"], s, "Hidden", parent=carrier, db=db)
    await _hide_from_all_but_the_owner(db, s, hidden["id"])
    resp = await _move(client, s["editor"], carrier["id"], mine["id"])
    assert resp.status_code == 409, resp.text
    assert _code(resp) == "hidden_items"


async def test_a_developer_moves_someone_elses_page_into_a_private_folder(client, db):
    s = await _setup(client, db)
    # a wiki administrator too, for edit on the page being moved
    dev = (await login_as(client, db, roles=("admin", "developer")))[0]
    mine = await _create(client, s["owner"], s["space"], "Owner's")
    await _private(client, s["owner"], mine["id"])
    theirs = await _page(client, s["editor"], s, "Editor's", db=db)
    resp = await _move(client, dev, theirs["id"], mine["id"])
    assert resp.status_code == 200, resp.text


# ── M5: moving out of a private folder keeps it private ─────────────


async def test_moving_a_page_out_of_a_private_folder_pins_it_private(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Private folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _private(client, s["owner"], folder["id"])

    resp = await _move(client, s["owner"], page["id"], None)
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_private"] is True
    await _get(client, s["editor"], page["id"], expect=404)
    await _get(client, s["viewer"], page["id"], expect=404)


async def test_moving_someone_elses_page_out_of_a_private_folder_is_refused(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    theirs = await _page(client, s["editor"], s, "Editor's", parent=folder, db=db)
    dev = await _developer(client, db)
    await _private(client, dev, folder["id"])

    # pinning it private would hand it to the editor, who can't see it now
    for headers in (s["owner"], dev):
        resp = await _move(client, headers, theirs["id"], None)
        assert resp.status_code == 409, resp.text
        assert _code(resp) == "others_items"
    await _get(client, s["editor"], theirs["id"], expect=404)


async def test_moving_within_private_folders_pins_nothing(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Private folder")
    sub = await _create(client, s["owner"], s["space"], "Sub", parent=folder)
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _private(client, s["owner"], folder["id"])
    resp = await _move(client, s["owner"], page["id"], sub["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_private"] is False
    assert resp.json()["in_private"] is True


# ── I3: only a move somewhere printable pins printing off ───────────


async def test_a_reorder_inside_a_printing_off_folder_pins_nothing(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    first = await _page(client, s["owner"], s, "First", parent=folder)
    second = await _page(client, s["owner"], s, "Second", parent=folder)
    await _printing(client, s["owner"], folder["id"], False)

    resp = await _move(client, s["owner"], first["id"], folder["id"], after_id=second["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["allow_printing"] is None
    assert resp.json()["can_print"] is False


async def test_a_move_between_two_printing_off_folders_pins_nothing(client, db):
    s = await _setup(client, db)
    one = await _create(client, s["owner"], s["space"], "One")
    two = await _create(client, s["owner"], s["space"], "Two")
    page = await _page(client, s["owner"], s, "Page", parent=one)
    await _printing(client, s["owner"], one["id"], False)
    await _printing(client, s["owner"], two["id"], False)

    resp = await _move(client, s["owner"], page["id"], two["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["allow_printing"] is None
    assert resp.json()["printing_from"]["node_id"] == two["id"]


async def test_a_move_where_the_library_is_off_pins_nothing(client, db):
    s = await _setup(client, db)
    resp = await client.patch(f"/wiki/spaces/{s['space']['key']}", headers=s["owner"],
                              json={"settings": {"allow_printing": False}})
    assert resp.status_code == 200, resp.text
    one = await _create(client, s["owner"], s["space"], "One")
    two = await _create(client, s["owner"], s["space"], "Two")
    page = await _page(client, s["owner"], s, "Page", parent=one)
    for parent_id in (two["id"], None):
        resp = await _move(client, s["owner"], page["id"], parent_id)
        assert resp.status_code == 200, resp.text
        assert resp.json()["allow_printing"] is None
        assert resp.json()["can_print"] is False


async def test_a_move_out_to_a_printable_place_pins_printing_off(client, db):
    s = await _setup(client, db)
    off = await _create(client, s["owner"], s["space"], "Off")
    on = await _create(client, s["owner"], s["space"], "On")
    page = await _page(client, s["owner"], s, "Page", parent=off)
    await _printing(client, s["owner"], off["id"], False)
    resp = await _move(client, s["owner"], page["id"], on["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["allow_printing"] is False
    assert resp.json()["can_print"] is False


# ── C2: out of the trash to the library root ────────────────────────


async def _batch_of(db, node_id):
    return (await _row(db, node_id)).deleted_batch


async def test_restoring_to_the_root_keeps_a_page_private(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Private folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _private(client, s["owner"], folder["id"])
    page_batch = await _delete(client, s["owner"], page["id"])
    await _delete(client, s["owner"], folder["id"])

    # its folder is in the trash, so it comes back at the root
    resp = await client.post(f"/wiki/trash/{page_batch}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["parent_id"], body["is_private"]) == (None, True)
    await _get(client, s["editor"], page["id"], expect=404)


async def test_restoring_to_the_root_keeps_printing_off(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _printing(client, s["owner"], folder["id"], False)
    page_batch = await _delete(client, s["owner"], page["id"])
    await _delete(client, s["owner"], folder["id"])

    resp = await client.post(f"/wiki/trash/{page_batch}/restore", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    assert (resp.json()["allow_printing"], resp.json()["can_print"]) == (False, False)


async def test_restoring_someone_elses_item_out_of_a_private_folder_is_refused(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    theirs = await _page(client, s["editor"], s, "Editor's", parent=folder, db=db)
    dev = await _developer(client, db)
    await _private(client, dev, folder["id"])
    theirs_batch = await _delete(client, s["owner"], theirs["id"])
    await _delete(client, s["owner"], folder["id"])

    resp = await client.post(f"/wiki/trash/{theirs_batch}/restore", headers=s["owner"])
    assert resp.status_code == 409, resp.text
    assert _code(resp) == "others_items"
    row = await _row(db, theirs["id"])
    assert row.deleted_at is not None and row.is_private is False


async def test_deleting_the_folder_forever_keeps_an_older_trashed_page_private(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Private folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _private(client, s["owner"], folder["id"])
    await _delete(client, s["owner"], page["id"])
    folder_batch = await _delete(client, s["owner"], folder["id"])

    resp = await client.delete(f"/wiki/trash/{folder_batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    row = await _row(db, page["id"])
    assert (row.path, row.parent_id, row.is_private) == ([], None, True)
    assert row.deleted_at is not None                   # still in the trash


async def test_deleting_the_folder_forever_keeps_an_older_trashed_page_unprintable(
        client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _printing(client, s["owner"], folder["id"], False)
    await _delete(client, s["owner"], page["id"])
    folder_batch = await _delete(client, s["owner"], folder["id"])

    resp = await client.delete(f"/wiki/trash/{folder_batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    row = await _row(db, page["id"])
    assert (row.path, row.allow_printing) == ([], False)


async def test_deleting_the_folder_forever_purges_someone_elses_page_it_hid(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    theirs = await _page(client, s["editor"], s, "Editor's", parent=folder, db=db)
    sub = await _page(client, s["editor"], s, "Below it", parent=theirs, db=db)
    dev = await _developer(client, db)
    await _private(client, dev, folder["id"])
    await _delete(client, s["owner"], theirs["id"])
    folder_batch = await _delete(client, s["owner"], folder["id"])

    resp = await client.delete(f"/wiki/trash/{folder_batch}", headers=s["owner"])
    assert resp.status_code == 204, resp.text
    assert await _row(db, theirs["id"]) is None
    assert await _row(db, sub["id"]) is None


# ── I1: a copy keeps privacy ────────────────────────────────────────


async def test_a_private_page_inside_a_copied_folder_stays_private(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    await _page(client, s["owner"], s, "Open", parent=folder, db=db)
    secret = await _page(client, s["owner"], s, "Secret", parent=folder, db=db)
    await _private(client, s["owner"], secret["id"])

    copy = await _copy(client, s["owner"], folder["id"])
    rows = {r.title: r for r in (await db.scalars(select(WikiNode).where(
        WikiNode.parent_id == uuid.UUID(copy["id"])).execution_options(
            populate_existing=True))).all()}
    assert {t: r.is_private for t, r in rows.items()} == {"Open": False, "Secret": True}
    assert rows["Secret"].created_by == s["owner_id"]
    await _get(client, s["editor"], rows["Secret"].id, expect=404)


async def test_copying_a_page_inside_a_private_folder_makes_a_private_copy(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Private folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder, db=db)
    await _private(client, s["owner"], folder["id"])

    copy = await _copy(client, s["owner"], page["id"])      # to the library root
    assert (copy["parent_id"], copy["is_private"]) == (None, True)
    await _get(client, s["editor"], copy["id"], expect=404)


async def test_a_copied_file_keeps_printing_off(client, db):
    s = await _setup(client, db)
    node = WikiNode(space_id=uuid.UUID(s["space"]["id"]), kind="file", title="manual.pdf",
                    created_by=s["owner_id"])
    db.add(node)
    await db.flush()
    db.add(WikiFile(node_id=node.id, description=""))
    version = WikiFileVersion(
        node_id=node.id, version_no=1, storage_key=f"wiki/test/{uuid.uuid4()}/manual.pdf",
        filename="manual.pdf", content_type="application/pdf", size_bytes=1234,
        preview_kind="native", preview_status="ready", extract_status="skipped")
    db.add(version)
    await db.flush()
    (await db.get(WikiFile, node.id)).current_version_id = version.id
    await db.commit()
    await _printing(client, s["owner"], node.id, False)

    copy = await _copy(client, s["owner"], str(node.id))
    assert (copy["kind"], copy["allow_printing"], copy["can_print"]) == ("file", False, False)
    resp = await client.get(f"/wiki/files/{copy['id']}/url", headers=s["owner"],
                            params={"disposition": "attachment"})
    assert resp.status_code == 403
    assert _code(resp) == "printing_disabled"


# ── M7 / M3 / M9: the payload ───────────────────────────────────────


async def test_in_private_is_true_for_the_private_node_and_everything_inside(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _page(client, s["owner"], s, "Inside", parent=folder)
    other = await _page(client, s["owner"], s, "Outside")
    await _private(client, s["owner"], folder["id"])
    assert (await _get(client, s["owner"], folder["id"]))["in_private"] is True
    body = await _get(client, s["owner"], page["id"])
    assert (body["is_private"], body["in_private"]) == (False, True)
    assert (await _get(client, s["owner"], other["id"]))["in_private"] is False
    listing = (await client.get(f"/wiki/spaces/{s['space']['key']}/tree",
                                headers=s["owner"], params={"parent_id": folder["id"]})).json()
    assert [(n["title"], n["in_private"]) for n in listing] == [("Inside", True)]


async def test_has_children_leaves_out_someone_elses_private_child(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    child = await _page(client, s["editor"], s, "Editor's own", parent=folder, db=db)
    assert (await _get(client, s["owner"], folder["id"]))["has_children"] is True
    await _private(client, s["editor"], child["id"])

    assert (await _get(client, s["owner"], folder["id"]))["has_children"] is False
    assert (await _get(client, s["editor"], folder["id"]))["has_children"] is True
    dev = await _developer(client, db)
    assert (await _get(client, dev, folder["id"]))["has_children"] is True


async def test_can_set_private_is_false_in_an_archived_library_but_for_admins(client, db):
    s = await _setup(client, db)
    admin, _ = await login_as(client, db, roles=("admin",))
    mine = await _page(client, s["editor"], s, "Editor's", db=db)
    admins = await _page(client, admin, s, "Admin's", db=db)
    assert (await _get(client, s["editor"], mine["id"]))["can_set_private"] is True
    resp = await client.post(f"/wiki/spaces/{s['space']['key']}/archive", headers=s["owner"])
    assert resp.status_code == 200, resp.text

    assert (await _get(client, s["editor"], mine["id"]))["can_set_private"] is False
    assert (await _get(client, admin, admins["id"]))["can_set_private"] is True


# ── M1 / M2: a help link's edit, an export's status ─────────────────


async def test_editing_a_help_link_to_a_private_item_is_404(client, db):
    s = await _setup(client, db)
    page = await _page(client, s["owner"], s, "Secret guide", db=db)
    admin, _ = await login_as(client, db, roles=("admin",))
    resp = await client.post("/wiki/help-links", headers=admin, json={
        "context": "portal:/bulk/time", "node_id": page["id"]})
    assert resp.status_code == 201, resp.text
    link_id = resp.json()["id"]
    await _private(client, s["owner"], page["id"])

    resp = await client.patch(f"/wiki/help-links/{link_id}", headers=admin,
                              json={"context": "portal:/bulk/other"})
    assert resp.status_code == 404, resp.text
    assert "Secret guide" not in resp.text
    both = (await login_as(client, db, roles=("admin", "developer")))[0]
    resp = await client.patch(f"/wiki/help-links/{link_id}", headers=both,
                              json={"context": "portal:/bulk/other"})
    assert resp.status_code == 200, resp.text


async def test_an_export_of_an_item_that_became_private_is_404(client, db):
    s = await _setup(client, db)
    page = await _page(client, s["owner"], s, "Guide", db=db)
    resp = await client.post("/wiki/exports", headers=s["editor"],
                             json={"node_id": page["id"], "format": "md"})
    assert resp.status_code == 202, resp.text
    job_id = resp.json()["job_id"]
    assert (await client.get(f"/wiki/exports/{job_id}", headers=s["editor"])).status_code == 200

    await _private(client, s["owner"], page["id"])
    resp = await client.get(f"/wiki/exports/{job_id}", headers=s["editor"])
    assert resp.status_code == 404, resp.text
