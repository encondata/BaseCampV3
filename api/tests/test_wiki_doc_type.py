"""HTTP tests for a page's document type (spec 2026-09-30, revision 2):
`PATCH /wiki/nodes/{id}/doc-type`, `NodeOut.page.doc_type`, the built-in SOP
template's default, copies keeping the type, and migration 0085."""
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, WikiPage
from serversherpa.wiki.doc_types import DOC_TYPES, TEMPLATE_DOC_TYPES
from tests.wiki_helpers import _create, _setup, _space, login_as, seed_builtin_templates

API_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture
async def builtins(clean_db, db):
    """`clean_db` truncates `wiki_templates`; put the built-ins back."""
    await seed_builtin_templates(db)


async def _set(client, headers, node_id, value, expect=200):
    resp = await client.patch(f"/wiki/nodes/{node_id}/doc-type", headers=headers,
                              json={"doc_type": value})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _get(client, headers, node_id):
    resp = await client.get(f"/wiki/nodes/{node_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _code(body):
    return body["detail"]["code"]


def test_the_allowed_types_are_the_five_in_the_spec():
    assert DOC_TYPES == ("Operating Procedure", "Work Instruction", "Guide", "Policy",
                         "Reference")
    assert TEMPLATE_DOC_TYPES == {"SOP": "Operating Procedure"}


async def test_an_editor_sets_and_clears_the_type_and_the_payload_reflects_it(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Page", kind="page")
    assert page["page"]["doc_type"] is None

    for value in DOC_TYPES:
        body = await _set(client, s["editor"], page["id"], value)
        assert body["page"]["doc_type"] == value
    body = await _get(client, s["owner"], page["id"])
    assert body["page"]["doc_type"] == "Reference"
    # the tree listing carries it too
    listing = (await client.get(f"/wiki/spaces/{s['space']['key']}/tree",
                                headers=s["owner"])).json()
    assert {n["title"]: n["page"]["doc_type"] for n in listing}["Page"] == "Reference"

    body = await _set(client, s["editor"], page["id"], None)
    assert body["page"]["doc_type"] is None
    assert (await _get(client, s["owner"], page["id"]))["page"]["doc_type"] is None


async def test_a_viewer_gets_403_and_someone_who_cannot_see_the_page_gets_404(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Page", kind="page")
    body = await _set(client, s["viewer"], page["id"], "Guide", expect=403)
    assert _code(body) == "forbidden"

    private = await _space(client, s["owner"], default_access="private", name="Closed")
    hidden = await _create(client, s["owner"], private, "Hidden", kind="page")
    stranger, _ = await login_as(client, db)
    await _set(client, stranger, hidden["id"], "Guide", expect=404)
    await _set(client, stranger, str(uuid.uuid4()), "Guide", expect=404)

    row = await db.get(WikiPage, uuid.UUID(page["id"]))
    await db.refresh(row)
    assert row.doc_type is None


async def test_a_folder_gets_422_not_a_page(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    body = await _set(client, s["owner"], folder["id"], "Guide", expect=422)
    assert _code(body) == "not_a_page"
    # the kind is checked before the value
    body = await _set(client, s["owner"], folder["id"], "Memo", expect=422)
    assert _code(body) == "not_a_page"


async def test_an_unknown_type_gets_422_bad_doc_type(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Page", kind="page")
    for value in ("Memo", "guide", "", " Guide"):
        body = await _set(client, s["owner"], page["id"], value, expect=422)
        assert _code(body) == "bad_doc_type"
    # a non-string and an extra field are rejected by the body schema
    for bad in ({"doc_type": 5}, {"doc_type": "Guide", "extra": 1}, {}):
        resp = await client.patch(f"/wiki/nodes/{page['id']}/doc-type",
                                  headers=s["owner"], json=bad)
        assert resp.status_code == 422, resp.text
    assert (await _get(client, s["owner"], page["id"]))["page"]["doc_type"] is None


async def test_an_audit_row_is_written_on_a_change_and_not_on_a_no_op(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Page", kind="page")

    async def rows():
        return (await db.scalars(select(AuditLog).where(
            AuditLog.entity_type == "wiki_node", AuditLog.entity_id == page["id"],
            AuditLog.action == "doc_type").order_by(AuditLog.at))).all()

    await _set(client, s["editor"], page["id"], None)          # already none
    assert await rows() == []
    await _set(client, s["editor"], page["id"], "Policy")
    await _set(client, s["editor"], page["id"], "Policy")      # no-op
    found = await rows()
    assert len(found) == 1
    assert found[0].actor_person_id == s["editor_id"]
    assert found[0].changes == {"doc_type": {"from": None, "to": "Policy"}}
    await _set(client, s["editor"], page["id"], None)
    found = await rows()
    assert [r.changes for r in found][-1] == {"doc_type": {"from": "Policy", "to": None}}
    assert len(found) == 2


async def test_a_page_from_the_builtin_sop_template_starts_as_an_operating_procedure(
        client, db, builtins):
    s = await _setup(client, db)
    templates = (await client.get("/wiki/templates", headers=s["owner"])).json()
    by_name = {t["name"]: t for t in templates if t["is_builtin"]}

    sop = await _create(client, s["owner"], s["space"], "Our SOP", kind="page",
                        template_id=by_name["SOP"]["id"])
    assert sop["page"]["doc_type"] == "Operating Procedure"
    assert (await _get(client, s["owner"], sop["id"]))["page"]["doc_type"] == \
        "Operating Procedure"

    other = await _create(client, s["owner"], s["space"], "A guide", kind="page",
                          template_id=by_name["How-to guide"]["id"])
    assert other["page"]["doc_type"] is None
    blank = await _create(client, s["owner"], s["space"], "Blank", kind="page")
    assert blank["page"]["doc_type"] is None


async def test_a_user_template_named_sop_does_not_set_a_type(client, db, builtins):
    s = await _setup(client, db)
    resp = await client.post("/wiki/templates", headers=s["owner"], json={
        "space_id": s["space"]["id"], "name": "SOP (ours)",
        "content_json": {"type": "doc", "content": [{"type": "paragraph"}]}})
    assert resp.status_code == 201, resp.text
    page = await _create(client, s["owner"], s["space"], "Mine", kind="page",
                         template_id=resp.json()["id"])
    assert page["page"]["doc_type"] is None


async def test_a_copied_page_keeps_its_type(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    page = await _create(client, s["owner"], s["space"], "Guide", kind="page",
                         parent=folder)
    plain = await _create(client, s["owner"], s["space"], "Plain", kind="page",
                          parent=folder)
    await _set(client, s["owner"], page["id"], "Work Instruction")

    # a page copied on its own, and a folder copied with its pages inside
    resp = await client.post(f"/wiki/nodes/{page['id']}/copy", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 201, resp.text
    assert resp.json()["page"]["doc_type"] == "Work Instruction"

    resp = await client.post(f"/wiki/nodes/{folder['id']}/copy", headers=s["editor"],
                             json={"parent_id": None})
    assert resp.status_code == 201, resp.text
    copy_id = uuid.UUID(resp.json()["id"])
    kids = (await client.get(f"/wiki/spaces/{s['space']['key']}/tree", headers=s["owner"],
                             params={"parent_id": str(copy_id)})).json()
    assert {k["title"]: k["page"]["doc_type"] for k in kids} == {
        "Guide": "Work Instruction", "Plain": None}
    assert plain["page"]["doc_type"] is None


def test_0085_is_in_the_single_migration_chain():
    """One head, and 0085 on the chain (not pinned as the head: a later
    migration would break a pinned test)."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini")))
    assert len(script.get_heads()) == 1
    assert script.get_revision("0085").down_revision == "0084"
