"""HTTP tests for page reviews/approvals and the periodic review cycle
(Phase 2 Task 5): the `review_required` publish gate, submit / replace /
withdraw / approve / reject, the approver fan-out, the reviews queue and
detail, `review_interval_months` on PATCH /nodes, mark-reviewed, the
space's due-reviews list, and the NodeOut `review` block."""
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    AccessGroup,
    AccessGroupMember,
    AuditLog,
    Client,
    Notification,
    Partner,
    Person,
    PersonRole,
    Role,
    WikiNode,
    WikiPage,
    WikiPageVersion,
    WikiReview,
)
from serversherpa.wiki import reviews
from tests.wiki_helpers import _create, _put_grants, _setup, login_as, publish_via_api

# ── helpers ─────────────────────────────────────────────────────────


def _doc(text, *mentions):
    content = [{"type": "text", "text": text}]
    content += [{"type": "mention", "attrs": {"personId": str(pid), "label": "Someone"}}
                for pid in mentions]
    return {"type": "doc", "content": [{"type": "paragraph", "content": content}]}


async def _set_draft(client, headers, page_id, text, *mentions):
    resp = await client.put(f"/wiki/nodes/{page_id}/draft", headers=headers,
                            json={"content_json": _doc(text, *mentions)})
    assert resp.status_code == 204, resp.text


async def _settings(client, s, **settings):
    resp = await client.patch(f"/wiki/spaces/{s['space']['key']}", headers=s["owner"],
                              json={"settings": settings})
    assert resp.status_code == 200, resp.text


async def _submit(client, headers, page_id, note=None, expect=201):
    resp = await client.post(f"/wiki/pages/{page_id}/reviews", headers=headers,
                             json={"note": note} if note is not None else {})
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _decide(client, headers, review_id, action, expect=200, **body):
    resp = await client.post(f"/wiki/reviews/{review_id}/{action}", headers=headers,
                             json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def _inbox(db, person_id, kind):
    return (await db.scalars(select(Notification).where(
        Notification.person_id == person_id, Notification.kind == kind)
        .order_by(Notification.created_at))).all()


async def _node(client, headers, node_id):
    resp = await client.get(f"/wiki/nodes/{node_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _fresh(db, model, key):
    db.expire_all()
    return await db.get(model, uuid.UUID(str(key)))


async def _audits(db, entity_type, action):
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == entity_type, AuditLog.action == action)
        .order_by(AuditLog.at))).all()


async def _page(client, s, title="Runbook", text="first"):
    page = await _create(client, s["owner"], s["space"], title, kind="page")
    await _set_draft(client, s["editor"], page["id"], text)
    return page


# ── the publish gate ─────────────────────────────────────────────────


async def test_publish_needs_review_when_the_space_requires_approval(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    await _settings(client, s, require_approval=True)

    resp = await client.post(f"/wiki/pages/{page['id']}/publish", headers=s["editor"],
                             json={})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "review_required"

    # a manager's approval is theirs to give: they publish directly
    await publish_via_api(client, s["owner"], page["id"])


async def test_publish_is_not_gated_without_require_approval(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    await publish_via_api(client, s["editor"], page["id"])


# ── submit / replace / withdraw ──────────────────────────────────────


async def test_submit_snapshots_the_draft_and_asks_the_approvers(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="please review me")

    review = await _submit(client, s["editor"], page["id"], note="Ready for a look")
    assert review["status"] == "pending"
    assert review["note"] == "Ready for a look"
    assert review["requested_by"]["id"] == str(s["editor_id"])
    assert review["node"]["id"] == page["id"]
    assert review["node"]["space_key"] == s["space"]["key"]

    version = await _fresh(db, WikiPageVersion, review["version_id"])
    assert version.kind == "submitted"
    assert version.content_json == _doc("please review me")
    # submitting publishes nothing
    assert (await _fresh(db, WikiPage, page["id"])).published_version_id is None

    requests = await _inbox(db, s["owner_id"], "wiki_review_request")
    assert len(requests) == 1 and requests[0].body == "Ready for a look"
    assert await _inbox(db, s["editor_id"], "wiki_review_request") == []
    assert await _inbox(db, s["viewer_id"], "wiki_review_request") == []
    assert len(await _audits(db, "wiki_review", "submit")) == 1

    # the versions list (edit) shows the snapshot
    resp = await client.get(f"/wiki/pages/{page['id']}/versions", headers=s["editor"])
    assert resp.status_code == 200, resp.text
    assert "submitted" in [v["kind"] for v in resp.json()]


async def test_submit_needs_edit(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    await publish_via_api(client, s["owner"], page["id"])
    await _set_draft(client, s["editor"], page["id"], "second")
    await _submit(client, s["viewer"], page["id"], expect=403)


async def test_submit_with_nothing_new_is_409(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    await publish_via_api(client, s["owner"], page["id"])
    resp = await client.post(f"/wiki/pages/{page['id']}/reviews", headers=s["editor"],
                             json={})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "nothing_to_review"


async def test_a_new_submit_replaces_the_pending_review(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    first = await _submit(client, s["editor"], page["id"])
    await _set_draft(client, s["editor"], page["id"], "second")
    second = await _submit(client, s["editor"], page["id"])

    assert (await _fresh(db, WikiReview, first["id"])).status == "withdrawn"
    assert (await _fresh(db, WikiReview, second["id"])).status == "pending"
    node = await _node(client, s["editor"], page["id"])
    assert node["review"]["pending_review_id"] == second["id"]


async def test_withdraw_is_for_the_requester_or_a_manager(client, db):
    s = await _setup(client, db)
    other_h, other_id = await login_as(client, db, roles=("staff",))
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"},
        {"principal_type": "person", "principal_id": str(other_id), "level": "edit"},
        {"principal_type": "internal", "level": "view"},
    ])
    page = await _page(client, s)
    review = await _submit(client, s["editor"], page["id"])

    await _decide(client, other_h, review["id"], "withdraw", expect=403)
    # never published: the view-only caller can't see the page at all
    await _decide(client, s["viewer"], review["id"], "withdraw", expect=404)
    out = await _decide(client, s["editor"], review["id"], "withdraw")
    assert out["status"] == "withdrawn"
    await _decide(client, s["editor"], review["id"], "withdraw", expect=409)
    assert len(await _audits(db, "wiki_review", "withdraw")) == 1

    again = await _submit(client, s["editor"], page["id"])
    out = await _decide(client, s["owner"], again["id"], "withdraw")
    assert out["status"] == "withdrawn"


async def test_a_requester_cannot_withdraw_in_an_archived_space(client, db):
    """An archived space is read-only below edit — and everyone but a wiki
    administrator is below edit there — so the requester can't withdraw;
    a wiki administrator still can."""
    s = await _setup(client, db)
    page = await _page(client, s)
    await publish_via_api(client, s["owner"], page["id"])     # readers can see it
    await _set_draft(client, s["editor"], page["id"], "second")
    review = await _submit(client, s["editor"], page["id"])
    resp = await client.post(f"/wiki/spaces/{s['space']['key']}/archive", headers=s["owner"])
    assert resp.status_code == 200, resp.text

    await _decide(client, s["editor"], review["id"], "withdraw", expect=403)
    assert (await _fresh(db, WikiReview, review["id"])).status == "pending"
    admin_h, _ = await login_as(client, db, roles=("admin",))
    assert (await _decide(client, admin_h, review["id"], "withdraw"))["status"] == "withdrawn"


# ── approve / reject ─────────────────────────────────────────────────


async def test_approve_publishes_the_snapshot_even_if_the_draft_moved_on(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="the snapshot")
    await publish_via_api(client, s["owner"], page["id"])
    await _set_draft(client, s["editor"], page["id"], "reviewed text", s["viewer_id"])
    review = await _submit(client, s["editor"], page["id"], note="Look")
    await _set_draft(client, s["editor"], page["id"], "moved on")
    # the viewer watches the page: the mention is all they get
    resp = await client.put("/wiki/watches", headers=s["viewer"], json={"node_id": page["id"]})
    assert resp.status_code == 200, resp.text

    out = await _decide(client, s["owner"], review["id"], "approve", note="Nice")
    assert out["status"] == "approved"
    assert out["decided_by"]["id"] == str(s["owner_id"])
    assert out["decision_note"] == "Nice"

    resp = await client.get(f"/wiki/pages/{page['id']}/content", headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["content_json"] == _doc("reviewed text", s["viewer_id"])
    assert resp.json()["kind"] == "published"
    stored = await _fresh(db, WikiPage, page["id"])
    assert stored.has_unpublished_changes is True
    assert stored.draft_json == _doc("moved on")

    decisions = await _inbox(db, s["editor_id"], "wiki_review_decision")
    assert len(decisions) == 1 and "approved" in decisions[0].title
    assert decisions[0].body == "Nice"
    mentions = await _inbox(db, s["viewer_id"], "wiki_mention")
    assert len(mentions) == 1
    # the requester wrote the mention; the approver only published it
    editor = (await db.get(Person, s["editor_id"])).display_name
    assert mentions[0].title == f"{editor} mentioned you in Runbook"
    assert await _inbox(db, s["viewer_id"], "wiki_update") == []
    assert len(await _audits(db, "wiki_review", "approve")) == 1


async def test_approving_the_current_draft_leaves_nothing_unpublished(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    review = await _submit(client, s["editor"], page["id"])
    await _decide(client, s["owner"], review["id"], "approve")
    assert (await _fresh(db, WikiPage, page["id"])).has_unpublished_changes is False
    node = await _node(client, s["editor"], page["id"])
    assert node["review"]["pending_review_id"] is None


async def test_approve_and_reject_need_manage_and_a_pending_review(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    review = await _submit(client, s["editor"], page["id"])
    await _decide(client, s["editor"], review["id"], "approve", expect=403)
    await _decide(client, s["editor"], review["id"], "reject", expect=403, note="no")
    await _decide(client, s["owner"], review["id"], "approve")
    await _decide(client, s["owner"], review["id"], "approve", expect=409)
    await _decide(client, s["owner"], review["id"], "reject", expect=409, note="late")
    await _decide(client, s["owner"], str(uuid.uuid4()), "approve", expect=404)


async def test_reject_needs_a_note_and_tells_the_requester(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    review = await _submit(client, s["editor"], page["id"])
    await _decide(client, s["owner"], review["id"], "reject", expect=422)
    await _decide(client, s["owner"], review["id"], "reject", expect=422, note="   ")

    out = await _decide(client, s["owner"], review["id"], "reject", note="Fix step 3")
    assert out["status"] == "rejected" and out["decision_note"] == "Fix step 3"
    assert (await _fresh(db, WikiPage, page["id"])).published_version_id is None
    decisions = await _inbox(db, s["editor_id"], "wiki_review_decision")
    assert len(decisions) == 1 and "requested changes" in decisions[0].title
    assert decisions[0].body == "Fix step 3"
    assert len(await _audits(db, "wiki_review", "reject")) == 1


# ── approvers ────────────────────────────────────────────────────────


async def test_approvers_are_the_manage_level_holders_of_the_page(client, db, caplog):
    s = await _setup(client, db)
    role = Role(name=f"wiki_rev_{uuid.uuid4().hex[:6]}", description="test-only")
    group = AccessGroup(name=f"Reviewers {uuid.uuid4().hex[:6]}")
    acme = Client(name=f"Acme {uuid.uuid4().hex[:6]}")
    vendor = Partner(name=f"Vendor {uuid.uuid4().hex[:6]}")
    db.add_all([role, group, acme, vendor])
    await db.commit()
    _, by_partner = await login_as(client, db, roles=("external",))
    db.add(PersonRole(person_id=by_partner, role="vendor_viewer", partner_id=vendor.id))
    await db.commit()
    _, by_role = await login_as(client, db, roles=("staff", role.name))
    _, by_group = await login_as(client, db, roles=("staff",))
    _, by_client = await login_as(client, db, roles=("client_viewer",), client_id=acme.id)
    _, admin_id = await login_as(client, db, roles=("admin",))
    db.add(AccessGroupMember(group_id=group.id, person_id=by_group))
    await db.commit()
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
        {"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "manage"},
        {"principal_type": "role", "principal_id": role.name, "level": "manage"},
        {"principal_type": "access_group", "principal_id": str(group.id), "level": "manage"},
        {"principal_type": "client", "principal_id": str(acme.id), "level": "manage"},
        {"principal_type": "partner", "principal_id": str(vendor.id), "level": "manage"},
        {"principal_type": "internal", "level": "manage"},
        {"principal_type": "everyone", "level": "manage"},
    ])
    page = await _page(client, s)
    node = await _fresh(db, WikiNode, page["id"])

    with caplog.at_level(logging.INFO, logger="serversherpa.wiki.reviews"):
        ids = await reviews.approver_ids(db, node, exclude=s["editor_id"])
    assert set(ids) == {s["owner_id"], by_role, by_group, by_client, by_partner}
    # internal/everyone manage grants are too broad to expand: not the viewer
    assert admin_id not in ids and s["viewer_id"] not in ids
    assert "internal" in caplog.text and "everyone" in caplog.text

    await _submit(client, s["editor"], page["id"])
    for pid in (s["owner_id"], by_role, by_group, by_client, by_partner):
        assert len(await _inbox(db, pid, "wiki_review_request")) == 1, pid
    assert await _inbox(db, s["editor_id"], "wiki_review_request") == []
    assert await _inbox(db, admin_id, "wiki_review_request") == []


async def test_approver_fan_out_is_capped(client, db, caplog, monkeypatch):
    s = await _setup(client, db)
    extra = [(await login_as(client, db))[1] for _ in range(3)]
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(pid), "level": "manage"}
        for pid in (s["owner_id"], *extra)
    ] + [{"principal_type": "person", "principal_id": str(s["editor_id"]), "level": "edit"}])
    page = await _page(client, s)
    node = await _fresh(db, WikiNode, page["id"])
    monkeypatch.setattr(reviews, "MAX_APPROVERS", 2)
    with caplog.at_level(logging.WARNING, logger="serversherpa.wiki.reviews"):
        ids = await reviews.approver_ids(db, node, exclude=s["editor_id"])
    assert len(ids) == 2
    assert "capped" in caplog.text


# ── the queue and the detail ─────────────────────────────────────────


async def test_list_reviews_as_approver_or_requester(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, title="Queued")
    review = await _submit(client, s["editor"], page["id"], note="n")

    async def listed(headers, **query):
        resp = await client.get("/wiki/reviews", headers=headers, params=query)
        assert resp.status_code == 200, resp.text
        return [r["id"] for r in resp.json()]

    assert await listed(s["owner"], mine="approver") == [review["id"]]
    assert await listed(s["editor"], mine="approver") == []
    assert await listed(s["editor"], mine="requester") == [review["id"]]
    assert await listed(s["owner"], mine="requester") == []
    assert await listed(s["viewer"]) == []
    assert await listed(s["editor"]) == [review["id"]]

    resp = await client.get("/wiki/reviews", headers=s["owner"], params={"mine": "approver"})
    row = resp.json()[0]
    assert row["node"] == {"id": page["id"], "title": "Queued",
                           "space_key": s["space"]["key"], "space_name": s["space"]["name"]}
    assert row["requested_by"]["id"] == str(s["editor_id"])

    await _decide(client, s["owner"], review["id"], "approve")
    assert await listed(s["owner"], mine="approver") == []
    assert await listed(s["owner"], mine="approver", status="approved") == [review["id"]]


async def test_review_detail_carries_the_snapshot_and_the_published_content(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="published text")
    await publish_via_api(client, s["owner"], page["id"])
    await _set_draft(client, s["editor"], page["id"], "proposed text")
    review = await _submit(client, s["editor"], page["id"])

    resp = await client.get(f"/wiki/reviews/{review['id']}", headers=s["owner"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["submitted_content"] == _doc("proposed text")
    assert body["published_content"] == _doc("published text")
    assert body["status"] == "pending"

    resp = await client.get(f"/wiki/reviews/{review['id']}", headers=s["viewer"])
    assert resp.status_code == 403, resp.text
    resp = await client.get(f"/wiki/reviews/{uuid.uuid4()}", headers=s["owner"])
    assert resp.status_code == 404, resp.text


# ── periodic review ──────────────────────────────────────────────────


def _parse(value):
    return datetime.fromisoformat(value) if value else None


async def test_publish_schedules_the_next_review_from_the_space_setting(client, db):
    s = await _setup(client, db)
    await _settings(client, s, review_interval_months=6)
    page = await _page(client, s)
    before = datetime.now(UTC)
    await publish_via_api(client, s["owner"], page["id"])

    node = await _node(client, s["viewer"], page["id"])
    assert node["review"]["interval_months"] == 6
    due = _parse(node["review"]["next_review_at"])
    assert reviews.add_months(before, 6) - timedelta(minutes=1) <= due \
        <= reviews.add_months(datetime.now(UTC), 6)
    assert node["review"]["state"] == "ok"


async def test_interval_patch_needs_manage_and_a_page(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    folder = await _create(client, s["owner"], s["space"], "Folder")

    async def patch(headers, node_id, value, expect):
        resp = await client.patch(f"/wiki/nodes/{node_id}", headers=headers,
                                  json={"review_interval_months": value})
        assert resp.status_code == expect, resp.text
        return resp.json()

    await patch(s["editor"], page["id"], 3, 403)
    await patch(s["owner"], folder["id"], 3, 422)
    await patch(s["owner"], page["id"], 0, 422)
    await patch(s["owner"], page["id"], 61, 422)

    # not yet published: the interval is kept, nothing is due
    out = await patch(s["owner"], page["id"], 3, 200)
    assert out["review"]["interval_months"] == 3
    assert out["review"]["next_review_at"] is None and out["review"]["state"] is None

    await publish_via_api(client, s["owner"], page["id"])
    node = await _fresh(db, WikiNode, page["id"])
    assert node.review_interval_months == 3 and node.next_review_at is not None

    out = await patch(s["owner"], page["id"], None, 200)
    assert out["review"]["interval_months"] is None
    assert out["review"]["next_review_at"] is None and out["review"]["state"] is None
    audits = await _audits(db, "wiki_node", "review_interval")
    assert [a.changes["review_interval_months"]["to"] for a in audits] == [3, None]


async def _published_at(db, node_id):
    page = await db.get(WikiPage, uuid.UUID(str(node_id)))
    return (await db.get(WikiPageVersion, page.published_version_id)).created_at


async def test_changing_the_space_interval_rebases_inheriting_pages(client, db):
    """A page that inherits the space's interval is re-based on
    `review_base` + the new interval when the space changes it — in the
    same request; a page with its own interval, or never published, is
    left alone, and clearing the space's interval clears their dates."""
    s = await _setup(client, db)
    await _settings(client, s, review_interval_months=12)
    inherits = await _page(client, s, "Inherits")
    own = await _page(client, s, "Own interval")
    draft_only = await _page(client, s, "Draft only")
    for page in (inherits, own):
        await publish_via_api(client, s["owner"], page["id"])
    resp = await client.patch(f"/wiki/nodes/{own['id']}", headers=s["owner"],
                              json={"review_interval_months": 6})
    assert resp.status_code == 200, resp.text
    reviewed_at = datetime.now(UTC) + timedelta(days=2)
    node = await _fresh(db, WikiNode, inherits["id"])
    node.last_reviewed_at = reviewed_at          # later than the publish
    await db.commit()
    own_due = (await _fresh(db, WikiNode, own["id"])).next_review_at

    await _settings(client, s, review_interval_months=3)
    node = await _fresh(db, WikiNode, inherits["id"])
    assert node.next_review_at == reviews.add_months(reviewed_at, 3)
    assert (await _fresh(db, WikiNode, own["id"])).next_review_at == own_due
    assert (await _fresh(db, WikiNode, draft_only["id"])).next_review_at is None

    # other settings leave the dates alone
    node.next_review_at = sentinel = datetime(2031, 1, 1, tzinfo=UTC)
    await db.commit()
    await _settings(client, s, readers_can_comment=False)
    await _settings(client, s, review_interval_months=3)
    assert (await _fresh(db, WikiNode, inherits["id"])).next_review_at == sentinel

    await _settings(client, s, review_interval_months=None)
    assert (await _fresh(db, WikiNode, inherits["id"])).next_review_at is None
    assert (await _fresh(db, WikiNode, own["id"])).next_review_at == own_due

    # and setting one again schedules from the publish
    await _settings(client, s, review_interval_months=24)
    published_at = await _published_at(db, inherits["id"])
    assert (await _fresh(db, WikiNode, inherits["id"])).next_review_at == \
        reviews.add_months(max(published_at, reviewed_at), 24)


async def test_a_big_space_leaves_the_rebase_to_the_worker(client, db, monkeypatch, caplog):
    """Past REBASE_INLINE_LIMIT inheriting pages, the request clears their
    dates instead and the reminders job's backfill schedules them."""
    s = await _setup(client, db)
    await _settings(client, s, review_interval_months=12)
    pages = [await _page(client, s, f"Page {i}") for i in range(2)]
    for page in pages:
        await publish_via_api(client, s["owner"], page["id"])
    monkeypatch.setattr(reviews, "REBASE_INLINE_LIMIT", 1)

    with caplog.at_level(logging.WARNING, logger="serversherpa.wiki.reviews"):
        await _settings(client, s, review_interval_months=3)
    assert any("backfill" in r.getMessage() for r in caplog.records)
    for page in pages:
        assert (await _fresh(db, WikiNode, page["id"])).next_review_at is None

    await reviews.backfill_due_dates(db)
    await db.commit()
    for page in pages:
        due = (await _fresh(db, WikiNode, page["id"])).next_review_at
        assert due == reviews.add_months(await _published_at(db, page["id"]), 3)


async def test_mark_reviewed_advances_the_due_date(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    resp = await client.post(f"/wiki/pages/{page['id']}/mark-reviewed", headers=s["editor"])
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "not_published"
    await publish_via_api(client, s["owner"], page["id"])
    resp = await client.patch(f"/wiki/nodes/{page['id']}", headers=s["owner"],
                              json={"review_interval_months": 12})
    assert resp.status_code == 200, resp.text
    node = await _fresh(db, WikiNode, page["id"])
    node.next_review_at = datetime.now(UTC) - timedelta(days=3)
    await db.commit()
    assert (await _node(client, s["editor"], page["id"]))["review"]["state"] == "overdue"

    resp = await client.post(f"/wiki/pages/{page['id']}/mark-reviewed", headers=s["viewer"])
    assert resp.status_code == 403, resp.text
    resp = await client.post(f"/wiki/pages/{page['id']}/mark-reviewed", headers=s["editor"])
    assert resp.status_code == 200, resp.text
    review = resp.json()["review"]
    assert review["state"] == "ok"
    assert _parse(review["last_reviewed_at"]) is not None
    assert _parse(review["next_review_at"]) > datetime.now(UTC) + timedelta(days=300)
    node = await _fresh(db, WikiNode, page["id"])
    assert node.last_reviewed_by == s["editor_id"]
    assert len(await _audits(db, "wiki_node", "mark_reviewed")) == 1


async def test_due_reviews_lists_pages_due_within_two_weeks_in_order(client, db):
    s = await _setup(client, db)
    now = datetime.now(UTC)
    pages = {}
    for title, offset in (("Later", 30), ("Soon", 10), ("Overdue", -5), ("Unscheduled", None)):
        page = await _page(client, s, title=title)
        await publish_via_api(client, s["owner"], page["id"])
        node = await _fresh(db, WikiNode, page["id"])
        if offset is not None:
            node.review_interval_months = 12
            node.next_review_at = now + timedelta(days=offset)
        await db.commit()
        pages[title] = page["id"]

    resp = await client.get(f"/wiki/spaces/{s['space']['key']}/due-reviews",
                            headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    listed = resp.json()
    assert [n["title"] for n in listed] == ["Overdue", "Soon"]
    assert [n["review"]["state"] for n in listed] == ["overdue", "due_soon"]

    later = await _node(client, s["viewer"], pages["Later"])
    assert later["review"]["state"] == "ok"
    unscheduled = await _node(client, s["viewer"], pages["Unscheduled"])
    assert unscheduled["review"] == {"interval_months": None, "own_interval_months": None,
                                     "next_review_at": None, "last_reviewed_at": None,
                                     "state": None, "pending_review_id": None}


async def test_folders_and_files_have_no_review_block(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    assert (await _node(client, s["owner"], folder["id"]))["review"] is None


async def test_viewers_do_not_see_the_pending_review_id(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    await publish_via_api(client, s["owner"], page["id"])
    await _set_draft(client, s["editor"], page["id"], "second")
    review = await _submit(client, s["editor"], page["id"])
    assert (await _node(client, s["owner"], page["id"]))["review"]["pending_review_id"] \
        == review["id"]
    assert (await _node(client, s["viewer"], page["id"]))["review"]["pending_review_id"] \
        is None


@pytest.mark.parametrize(("start", "months", "expected"), [
    (datetime(2026, 1, 31, 9, tzinfo=UTC), 1, datetime(2026, 2, 28, 9, tzinfo=UTC)),
    (datetime(2026, 11, 15, tzinfo=UTC), 3, datetime(2027, 2, 15, tzinfo=UTC)),
    (datetime(2024, 2, 29, tzinfo=UTC), 12, datetime(2025, 2, 28, tzinfo=UTC)),
])
def test_add_months_clamps_to_the_end_of_the_month(start, months, expected):
    assert reviews.add_months(start, months) == expected


# ── review follow-ups: search, stale, duplicates, limits, own interval ──


async def test_approve_refreshes_the_search_vector(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="zanzibarquokka procedure")
    review = await _submit(client, s["editor"], page["id"])
    await _decide(client, s["owner"], review["id"], "approve")
    resp = await client.get("/wiki/search", headers=s["viewer"],
                            params={"q": "zanzibarquokka"})
    assert resp.status_code == 200, resp.text
    assert [hit["node"]["id"] for hit in resp.json()] == [page["id"]]


async def test_review_detail_is_stale_once_the_page_was_published_after_submit(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="v1")
    await publish_via_api(client, s["owner"], page["id"])
    await _set_draft(client, s["editor"], page["id"], "v2")
    review = await _submit(client, s["editor"], page["id"])

    async def detail():
        resp = await client.get(f"/wiki/reviews/{review['id']}", headers=s["owner"])
        assert resp.status_code == 200, resp.text
        return resp.json()

    assert (await detail())["stale"] is False
    await _set_draft(client, s["editor"], page["id"], "v3")
    await publish_via_api(client, s["owner"], page["id"])
    assert (await detail())["stale"] is True
    # once decided it's no longer "stale": approving published it, so the
    # current version is newer than the submit by design
    await _decide(client, s["owner"], review["id"], "approve")
    assert (await detail())["stale"] is False


async def test_unpublished_page_review_is_not_stale(client, db):
    s = await _setup(client, db)
    page = await _page(client, s)
    review = await _submit(client, s["editor"], page["id"])
    resp = await client.get(f"/wiki/reviews/{review['id']}", headers=s["owner"])
    assert resp.json()["stale"] is False


async def test_approving_what_is_already_published_adds_no_version(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="same text")
    review = await _submit(client, s["editor"], page["id"])
    # a manager publishes the very same draft directly meanwhile
    await publish_via_api(client, s["owner"], page["id"])
    published_before = (await _fresh(db, WikiPage, page["id"])).published_version_id

    out = await _decide(client, s["owner"], review["id"], "approve")
    assert out["status"] == "approved"
    assert (await _fresh(db, WikiPage, page["id"])).published_version_id == published_before
    count = len((await db.scalars(select(WikiPageVersion).where(
        WikiPageVersion.node_id == uuid.UUID(page["id"]),
        WikiPageVersion.kind == "published"))).all())
    assert count == 1
    decisions = await _inbox(db, s["editor_id"], "wiki_review_decision")
    assert len(decisions) == 1 and "approved" in decisions[0].title


async def test_approve_compares_with_the_published_content_as_of_the_lock(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, text="same text")
    review = await _submit(client, s["editor"], page["id"])
    node_row = await db.get(WikiNode, uuid.UUID(page["id"]))
    page_row = await db.get(WikiPage, uuid.UUID(page["id"]))
    assert page_row.published_version_id is None
    await db.commit()
    # published by someone else after the page row was read
    await publish_via_api(client, s["owner"], page["id"])

    review_row = await reviews.lock_review(db, await db.get(WikiReview,
                                                            uuid.UUID(review["id"])))
    version, _ = await reviews.approve(db, node_row, page_row, review_row,
                                       actor_id=s["owner_id"], note=None)
    await db.commit()
    assert version is None               # no duplicate of what is already published
    count = len((await db.scalars(select(WikiPageVersion).where(
        WikiPageVersion.node_id == uuid.UUID(page["id"]),
        WikiPageVersion.kind == "published"))).all())
    assert count == 1


async def test_decided_review_lists_are_bounded_in_sql(client, db, monkeypatch):
    s = await _setup(client, db)
    hidden = await _create(client, s["owner"], s["space"], "Hidden", kind="page")
    shown = await _create(client, s["owner"], s["space"], "Shown", kind="page")
    # the editor can't see `hidden` (inheritance broken, owner only)
    resp = await client.put(f"/wiki/nodes/{hidden['id']}/permissions", headers=s["owner"],
                            json={"inherit": False, "grants": []})
    assert resp.status_code == 200, resp.text
    base = datetime.now(UTC) - timedelta(days=1)

    async def approved(node_id, minutes):
        version = WikiPageVersion(node_id=uuid.UUID(node_id), version_no=minutes + 1,
                                  title="t", content_json={"type": "doc", "content": []},
                                  kind="submitted")
        db.add(version)
        await db.flush()
        db.add(WikiReview(node_id=uuid.UUID(node_id), version_id=version.id,
                          requested_by=s["editor_id"], status="approved",
                          created_at=base + timedelta(minutes=minutes)))

    await approved(shown["id"], 0)                       # the oldest
    for minutes in range(1, 5):                          # four newer, hidden
        await approved(hidden["id"], minutes)
    await db.commit()

    from serversherpa.api.routes.wiki import reviews as review_routes
    monkeypatch.setattr(review_routes, "LIST_LIMIT", 1)
    resp = await client.get("/wiki/reviews", headers=s["editor"],
                            params={"status": "approved"})
    assert resp.status_code == 200, resp.text
    # 4 x LIST_LIMIT rows are read: all hidden, so nothing comes back
    assert resp.json() == []
    monkeypatch.setattr(review_routes, "LIST_LIMIT", 2)
    resp = await client.get("/wiki/reviews", headers=s["editor"],
                            params={"status": "approved"})
    assert [r["node"]["id"] for r in resp.json()] == [shown["id"]]


async def test_due_reviews_is_limited(client, db, monkeypatch):
    s = await _setup(client, db)
    now = datetime.now(UTC)
    for i in range(3):
        page = await _page(client, s, title=f"Due {i}")
        await publish_via_api(client, s["owner"], page["id"])
        node = await _fresh(db, WikiNode, page["id"])
        node.review_interval_months = 12
        node.next_review_at = now - timedelta(days=3 - i)
        await db.commit()
    from serversherpa.api.routes.wiki import reviews as review_routes
    monkeypatch.setattr(review_routes, "DUE_LIMIT", 2)
    resp = await client.get(f"/wiki/spaces/{s['space']['key']}/due-reviews",
                            headers=s["viewer"])
    assert resp.status_code == 200, resp.text
    assert [n["title"] for n in resp.json()] == ["Due 0", "Due 1"]


async def test_review_block_tells_own_interval_from_the_space_default(client, db):
    s = await _setup(client, db)
    await _settings(client, s, review_interval_months=6)
    page = await _page(client, s)
    node = await _node(client, s["owner"], page["id"])
    assert node["review"]["interval_months"] == 6
    assert node["review"]["own_interval_months"] is None
    resp = await client.patch(f"/wiki/nodes/{page['id']}", headers=s["owner"],
                              json={"review_interval_months": 3})
    assert resp.status_code == 200, resp.text
    assert resp.json()["review"]["interval_months"] == 3
    assert resp.json()["review"]["own_interval_months"] == 3
