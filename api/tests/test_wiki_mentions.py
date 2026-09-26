"""Tests for @mentions (Phase 2 Task 3): the `mention` node in page
content (`content.mention_ids`, `doc_text`), mention notifications on
publish (only people newly mentioned since the previous published
version), mentions in comments (people who can't view the page are
dropped; editing notifies only the newly added), and the
`mentionable` people search."""
import uuid

from sqlalchemy import func, select

from serversherpa.db.models import Client, Notification, Person, UserAccount
from serversherpa.wiki.content import doc_text, mention_ids
from tests.wiki_helpers import _create, _setup, login_as, publish_via_api, publish_via_db

# ── content ─────────────────────────────────────────────────────────


def _mention(person_id, label="Pat Doe"):
    return {"type": "mention", "attrs": {"personId": str(person_id), "label": label}}


def _doc(*inline):
    return {"type": "doc", "content": [{"type": "paragraph", "content": list(inline)}]}


def test_mention_ids_collects_valid_person_ids():
    a, b = uuid.uuid4(), uuid.uuid4()
    doc = {"type": "doc", "content": [
        {"type": "paragraph", "content": [
            {"type": "text", "text": "ask "}, _mention(a), _mention(str(a).upper())]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [
            {"type": "paragraph", "content": [_mention(b)]}]}]},
        {"type": "paragraph", "content": [
            {"type": "mention", "attrs": {"personId": "not-a-uuid"}},
            {"type": "mention", "attrs": {"personId": 7}},
            {"type": "mention"},
            {"type": "text", "text": "x", "attrs": {"personId": str(uuid.uuid4())}}]},
    ]}
    assert mention_ids(doc) == {str(a), str(b)}
    assert mention_ids(None) == set()


def test_doc_text_renders_a_mention_as_at_label():
    doc = _doc({"type": "text", "text": "ask "}, _mention(uuid.uuid4(), "Pat Doe"),
               {"type": "text", "text": " first"}, {"type": "mention", "attrs": {}})
    assert doc_text(doc) == "ask @Pat Doe first"


def test_mentions_in_table_cells_and_list_items_are_found_and_read():
    a, b = uuid.uuid4(), uuid.uuid4()

    def para(*inline):
        return {"type": "paragraph", "content": list(inline)}

    doc = {"type": "doc", "content": [
        {"type": "table", "content": [{"type": "tableRow", "content": [
            {"type": "tableHeader", "content": [para({"type": "text", "text": "Owner"})]},
            {"type": "tableCell", "content": [para(_mention(a, "Pat Doe"))]},
        ]}]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [
            para({"type": "text", "text": "ping "}, _mention(b, "Sam Roe"))]}]},
    ]}
    assert mention_ids(doc) == {str(a), str(b)}
    # each cell/item and its paragraph end a line: blank lines between
    assert doc_text(doc) == "Owner\n\n@Pat Doe\n\nping @Sam Roe"


# ── helpers ─────────────────────────────────────────────────────────


async def _inbox(db, person_id, kind=None):
    q = select(Notification).where(Notification.person_id == person_id)
    if kind is not None:
        q = q.where(Notification.kind == kind)
    return (await db.scalars(q.order_by(Notification.created_at))).all()


async def _set_draft(client, headers, page_id, doc):
    resp = await client.put(f"/wiki/nodes/{page_id}/draft", headers=headers,
                            json={"content_json": doc})
    assert resp.status_code == 204, resp.text


async def _outsider(client, db):
    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    db.add(acme)
    await db.flush()
    _, person_id = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    return person_id


async def _name(db, person_id):
    return (await db.get(Person, person_id)).display_name


async def _post(client, headers, page, text, mentions=(), expect=201):
    resp = await client.post(f"/wiki/nodes/{page['id']}/comments", headers=headers, json={
        "body": {"text": text, "mentions": [str(m) for m in mentions]}})
    assert resp.status_code == expect, resp.text
    return resp.json()


# ── publish ─────────────────────────────────────────────────────────


async def test_publish_notifies_only_people_newly_mentioned(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["editor"], s["space"], "Runbook", kind="page")
    _, other = await login_as(client, db)
    outsider = await _outsider(client, db)

    await _set_draft(client, s["editor"], page["id"],
                     _doc(_mention(s["viewer_id"]), _mention(outsider),
                          _mention(s["editor_id"])))
    await publish_via_api(client, s["editor"], page["id"])

    editor = await _name(db, s["editor_id"])
    got = await _inbox(db, s["viewer_id"], "wiki_mention")
    assert [(n.title, n.link.endswith(f"/n/{page['id']}")) for n in got] == [
        (f"{editor} mentioned you in Runbook", True)]
    assert await _inbox(db, outsider) == []                    # can't view it
    assert await _inbox(db, s["editor_id"], "wiki_mention") == []   # the actor

    # the viewer is still mentioned, `other` is new: only `other` hears
    await _set_draft(client, s["editor"], page["id"],
                     _doc(_mention(s["viewer_id"]), _mention(other)))
    await publish_via_api(client, s["editor"], page["id"])
    assert len(await _inbox(db, s["viewer_id"], "wiki_mention")) == 1
    assert len(await _inbox(db, other, "wiki_mention")) == 1


# ── comments ────────────────────────────────────────────────────────


async def test_comment_mentions_are_filtered_and_expanded(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    outsider = await _outsider(client, db)
    stranger = uuid.uuid4()

    c = await _post(client, s["editor"], page, "@Viewer and friends",
                    [s["viewer_id"], outsider, stranger, s["viewer_id"]])

    viewer = await _name(db, s["viewer_id"])
    assert c["body"]["mentions"] == [{"id": str(s["viewer_id"]), "name": viewer}]
    got = await _inbox(db, s["viewer_id"])
    assert [(n.kind, n.title) for n in got] == [
        ("wiki_mention",
         f"{await _name(db, s['editor_id'])} mentioned you in a comment on Runbook")]
    assert got[0].link.endswith(f"#comment-{c['id']}")
    assert await _inbox(db, outsider) == []

    # the expansion uses the current display name
    person = await db.get(Person, s["viewer_id"])
    person.preferred_name = "Vic"
    await db.commit()
    resp = await client.get(f"/wiki/nodes/{page['id']}/comments", headers=s["viewer"])
    [thread] = resp.json()
    assert thread["comments"][0]["body"]["mentions"][0]["name"] == f"Vic {person.last_name}"


async def test_editing_a_comment_notifies_only_newly_mentioned(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    _, other = await login_as(client, db)
    c = await _post(client, s["editor"], page, "hi", [s["viewer_id"]])

    resp = await client.patch(f"/wiki/comments/{c['id']}", headers=s["editor"], json={
        "body": {"text": "hi both", "mentions": [str(s["viewer_id"]), str(other)]}})
    assert resp.status_code == 200, resp.text
    assert [m["id"] for m in resp.json()["body"]["mentions"]] == [
        str(s["viewer_id"]), str(other)]

    assert len(await _inbox(db, s["viewer_id"], "wiki_mention")) == 1
    got = await _inbox(db, other, "wiki_mention")
    assert len(got) == 1 and got[0].link.endswith(f"#comment-{c['id']}")


# ── mentionable ─────────────────────────────────────────────────────


async def test_mentionable_lists_people_who_can_view(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    tag = uuid.uuid4().hex[:8]
    _, match = await login_as(client, db, email=f"zed-{tag}@test.example.com")
    outsider = await _outsider(client, db)
    (await db.get(Person, outsider)).email = f"zed-{tag}-out@test.example.com"
    no_account = Person(first_name="Zed", last_name=f"Nobody {tag}",
                        email=f"zed-{tag}-na@test.example.com")
    db.add(no_account)
    _, disabled = await login_as(client, db, email=f"zed-{tag}-off@test.example.com")
    account = await db.scalar(select(UserAccount).where(UserAccount.person_id == disabled))
    account.disabled_at = func.now()
    await db.commit()

    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["viewer"], params={"q": f"zed-{tag}"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == [{"id": str(match), "name": await _name(db, match)}]

    # by name, case-insensitive
    viewer = await db.get(Person, s["viewer_id"])
    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["editor"], params={"q": viewer.last_name.upper()})
    assert [p["id"] for p in resp.json()] == [str(s["viewer_id"])]


async def test_mentionable_is_capped_and_needs_view(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    tag = uuid.uuid4().hex[:8]
    for i in range(12):
        await login_as(client, db, email=f"cap-{tag}-{i:02}@test.example.com")

    # never published: a reader can't see it
    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["viewer"], params={"q": f"cap-{tag}"})
    assert resp.status_code == 404
    # and neither can the people found, until it's published
    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["editor"], params={"q": f"cap-{tag}"})
    assert resp.json() == []

    await publish_via_db(db, page["id"])
    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["editor"], params={"q": f"cap-{tag}"})
    assert len(resp.json()) == 10


async def test_mentionable_looks_past_people_who_cannot_view(client, db):
    """Dozens of matches who can't view the page sort ahead of the one
    who can, and they're still found: access is checked for up to
    MENTIONABLE_SCAN (100) candidates."""
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    tag = uuid.uuid4().hex[:8]
    for i in range(40):     # accounts without any role: no wiki access
        email = f"scan-{tag}-{i:02}@test.example.com"
        person = Person(first_name="No", last_name=f"Access {tag} {i:02}", email=email)
        db.add(person)
        await db.flush()
        db.add(UserAccount(person_id=person.id, email=email, password_hash="x"))
    await db.commit()
    _, viewer = await login_as(client, db, email=f"scan-{tag}-zz@test.example.com")

    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["editor"], params={"q": f"scan-{tag}"})
    assert resp.status_code == 200, resp.text
    assert [p["id"] for p in resp.json()] == [str(viewer)]


async def test_mentionable_leaves_out_the_caller_and_escapes_wildcards(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["owner"], s["space"], "Runbook", kind="page")
    await publish_via_db(db, page["id"])
    editor = await db.get(Person, s["editor_id"])

    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["editor"], params={"q": editor.email})
    assert resp.json() == []
    resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                            headers=s["viewer"], params={"q": editor.email})
    assert [p["id"] for p in resp.json()] == [str(s["editor_id"])]

    # % and _ are literal characters, not wildcards
    for q in ("%", "_", "\\"):
        resp = await client.get(f"/wiki/nodes/{page['id']}/mentionable",
                                headers=s["viewer"], params={"q": q})
        assert resp.status_code == 200, resp.text
        assert resp.json() == [], q


async def test_a_newly_mentioned_watcher_gets_only_the_mention_on_publish(client, db):
    s = await _setup(client, db)
    page = await _create(client, s["editor"], s["space"], "Runbook", kind="page")
    await publish_via_api(client, s["editor"], page["id"])
    resp = await client.put("/wiki/watches", headers=s["viewer"],
                            json={"space_id": s["space"]["id"]})
    assert resp.status_code == 200, resp.text

    await _set_draft(client, s["editor"], page["id"], _doc(_mention(s["viewer_id"])))
    await publish_via_api(client, s["editor"], page["id"])

    assert [n.kind for n in await _inbox(db, s["viewer_id"])] == ["wiki_mention"]
