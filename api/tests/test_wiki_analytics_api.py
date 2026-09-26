"""Wiki analytics (Phase 3, spec §8): recording page/file views
(`POST /wiki/nodes/{id}/view`), "Was this page helpful?" feedback
(`PUT /wiki/pages/{id}/feedback`, `GET .../feedback/mine`), the search
log written by `GET /wiki/search`, and the aggregated
`GET /wiki/analytics` (wiki admins: any or every space; space managers:
one space they manage) — permissions, scoping and every section's math."""
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select, update

from serversherpa.db.models import (
    AuditLog,
    WikiFeedback,
    WikiFile,
    WikiNode,
    WikiPageView,
    WikiSearchLog,
)
from tests.wiki_helpers import _create, _put_grants, _setup, _space, login_as, publish_via_db


def _read_only(monkeypatch):
    async def _cfg(_db):
        return {"read_only": True, "read_only_message": "Down for maintenance."}
    monkeypatch.setattr("serversherpa.system.admin_config.read_admin_config", _cfg)


async def _page(client, s, db, title="Guide", publish=True):
    page = await _create(client, s["owner"], s["space"], title, kind="page")
    if publish:
        await publish_via_db(db, page["id"])
    return page


async def _file(db, s, title="manual.pdf"):
    node = WikiNode(space_id=uuid.UUID(s["space"]["id"]), kind="file", title=title)
    db.add(node)
    await db.flush()
    db.add(WikiFile(node_id=node.id, description=""))
    await db.commit()
    return node.id


async def _views(db, node_id):
    return (await db.scalars(select(WikiPageView).where(
        WikiPageView.node_id == uuid.UUID(str(node_id)))
        .execution_options(populate_existing=True))).all()


def _today() -> date:
    return datetime.now(UTC).date()


# ── POST /wiki/nodes/{id}/view ───────────────────────────────────────


async def test_a_view_upserts_todays_row(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)

    for _ in range(2):
        resp = await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["viewer"])
        assert resp.status_code == 204, resp.text

    rows = await _views(db, page["id"])
    assert [(r.person_id, r.viewed_on, r.count) for r in rows] == [
        (s["viewer_id"], _today(), 2)]


async def test_each_viewer_gets_their_own_row(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["viewer"])
    await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["editor"])
    rows = await _views(db, page["id"])
    assert sorted((r.person_id, r.count) for r in rows) == sorted(
        [(s["viewer_id"], 1), (s["editor_id"], 1)])


async def test_a_file_view_is_recorded(client, db):
    s = await _setup(client, db)
    file_id = await _file(db, s)
    resp = await client.post(f"/wiki/nodes/{file_id}/view", headers=s["viewer"])
    assert resp.status_code == 204, resp.text
    assert [r.count for r in await _views(db, file_id)] == [1]


async def test_a_never_published_page_has_no_views_for_a_reader(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db, publish=False)
    resp = await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["viewer"])
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_published"
    # an editor can see (and so view) it
    assert (await client.post(f"/wiki/nodes/{page['id']}/view",
                              headers=s["editor"])).status_code == 204
    assert [r.person_id for r in await _views(db, page["id"])] == [s["editor_id"]]


async def test_a_folder_is_not_viewed(client, db):
    s = await _setup(client, db)
    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await client.post(f"/wiki/nodes/{folder['id']}/view", headers=s["viewer"])
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_kind"


async def test_a_view_of_something_unviewable_is_a_404(client, db):
    s = await _setup(client, db)
    private = await _space(client, s["owner"], default_access="private")
    page = await _create(client, s["owner"], private, "Secret", kind="page")
    await publish_via_db(db, page["id"])
    resp = await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["viewer"])
    assert resp.status_code == 404
    resp = await client.post(f"/wiki/nodes/{uuid.uuid4()}/view", headers=s["viewer"])
    assert resp.status_code == 404
    assert await _views(db, page["id"]) == []


async def test_a_view_in_read_only_mode_is_accepted_but_not_recorded(client, db, monkeypatch):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    _read_only(monkeypatch)
    resp = await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["viewer"])
    assert resp.status_code == 204, resp.text
    assert await _views(db, page["id"]) == []


# ── feedback ─────────────────────────────────────────────────────────


async def _feedback(client, headers, page_id, expect=200, **body):
    resp = await client.put(f"/wiki/pages/{page_id}/feedback", headers=headers, json=body)
    assert resp.status_code == expect, resp.text
    return resp.json()


async def test_feedback_is_saved_read_back_and_replaced(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)

    resp = await client.get(f"/wiki/pages/{page['id']}/feedback/mine", headers=s["viewer"])
    assert resp.status_code == 404

    out = await _feedback(client, s["viewer"], page["id"], helpful=False,
                          comment="  The steps skip the login.  ")
    assert out["helpful"] is False and out["comment"] == "The steps skip the login."
    mine = (await client.get(f"/wiki/pages/{page['id']}/feedback/mine",
                             headers=s["viewer"])).json()
    assert mine["helpful"] is False and mine["comment"] == "The steps skip the login."

    # changing the answer replaces the whole response, comment included
    await _feedback(client, s["viewer"], page["id"], helpful=True)
    rows = (await db.scalars(select(WikiFeedback).execution_options(
        populate_existing=True))).all()
    assert [(r.person_id, r.helpful, r.comment) for r in rows] == [
        (s["viewer_id"], True, None)]

    # a blank comment is no comment
    out = await _feedback(client, s["viewer"], page["id"], helpful=False, comment="   ")
    assert out["comment"] is None


async def test_feedback_is_per_person(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await _feedback(client, s["viewer"], page["id"], helpful=True)
    resp = await client.get(f"/wiki/pages/{page['id']}/feedback/mine", headers=s["editor"])
    assert resp.status_code == 404


async def test_feedback_needs_a_published_page(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db, publish=False)
    resp = await client.put(f"/wiki/pages/{page['id']}/feedback", headers=s["editor"],
                            json={"helpful": True})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "not_published"
    folder = await _create(client, s["owner"], s["space"], "Folder")
    resp = await client.put(f"/wiki/pages/{folder['id']}/feedback", headers=s["viewer"],
                            json={"helpful": True})
    assert resp.status_code == 404


async def test_feedback_comment_is_validated(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    resp = await client.put(f"/wiki/pages/{page['id']}/feedback", headers=s["viewer"],
                            json={"helpful": False, "comment": "x" * 2001})
    assert resp.status_code == 422
    resp = await client.put(f"/wiki/pages/{page['id']}/feedback", headers=s["viewer"],
                            json={"helpful": False, "comment": "bad\x00byte"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_comment"
    # tab and newline are fine
    await _feedback(client, s["viewer"], page["id"], helpful=False, comment="a\tb\nc")


async def test_feedback_and_views_are_not_audited(client, db):
    s = await _setup(client, db)
    page = await _page(client, s, db)
    await client.post(f"/wiki/nodes/{page['id']}/view", headers=s["viewer"])
    await _feedback(client, s["viewer"], page["id"], helpful=True)
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == page["id"], AuditLog.actor_person_id == s["viewer_id"]))).all()
    assert rows == []


# ── the search log ───────────────────────────────────────────────────


async def _log(db):
    return (await db.scalars(select(WikiSearchLog).order_by(WikiSearchLog.id)
                             .execution_options(populate_existing=True))).all()


async def test_a_search_is_logged_with_its_result_count(client, db):
    s = await _setup(client, db)
    await _page(client, s, db, title="Forklift checklist")

    await client.get("/wiki/search", headers=s["viewer"], params={"q": "  forklift  "})
    await client.get("/wiki/search", headers=s["viewer"], params={"q": "zzqx"})
    rows = await _log(db)
    assert [(r.person_id, r.query, r.result_count) for r in rows] == [
        (s["viewer_id"], "forklift", 1), (s["viewer_id"], "zzqx", 0)]


async def test_a_refused_or_unlogged_search_is_not_logged(client, db):
    s = await _setup(client, db)
    assert (await client.get("/wiki/search", headers=s["viewer"],
                             params={"q": "   "})).status_code == 422
    # the top bar's live results ask not to be logged
    resp = await client.get("/wiki/search", headers=s["viewer"],
                            params={"q": "forklift", "log": "false"})
    assert resp.status_code == 200
    assert await _log(db) == []


async def test_no_search_is_logged_in_read_only_mode(client, db, monkeypatch):
    s = await _setup(client, db)
    _read_only(monkeypatch)
    resp = await client.get("/wiki/search", headers=s["viewer"], params={"q": "forklift"})
    assert resp.status_code == 200
    assert await _log(db) == []


# ── GET /wiki/analytics: who may ask ─────────────────────────────────


async def _admin(client, db):
    headers, _ = await login_as(client, db, roles=("admin",))
    return headers


async def _analytics(client, headers, **params):
    return await client.get("/wiki/analytics", headers=headers, params=params)


async def test_analytics_permissions(client, db):
    s = await _setup(client, db)
    other = await _space(client, s["viewer"], name="Viewer's own space")
    admin = await _admin(client, db)
    key = s["space"]["key"]

    # readers and editors: never
    assert (await _analytics(client, s["viewer"], space=key)).status_code == 403
    assert (await _analytics(client, s["editor"], space=key)).status_code == 403
    # a manager: only with a space they manage
    assert (await _analytics(client, s["owner"])).status_code == 403
    assert (await _analytics(client, s["owner"], space=other["key"])).status_code == 403
    assert (await _analytics(client, s["owner"], space="no-such-space")).status_code == 403
    resp = await _analytics(client, s["owner"], space=key)
    assert resp.status_code == 200, resp.text
    assert resp.json()["space_key"] == key
    # the viewer manages their own space
    assert (await _analytics(client, s["viewer"], space=other["key"])).status_code == 200
    # a wiki admin: any space, or all of them
    assert (await _analytics(client, admin)).status_code == 200
    assert (await _analytics(client, admin, space=key)).status_code == 200
    assert (await _analytics(client, admin, space="no-such-space")).status_code == 404


async def test_analytics_days_must_be_a_known_window(client, db):
    admin = await _admin(client, db)
    for days in (7, 30, 90, 365):
        resp = await _analytics(client, admin, days=days)
        assert resp.status_code == 200, resp.text
        assert resp.json()["days"] == days
        assert len(resp.json()["views_by_day"]) == days
    resp = await _analytics(client, admin, days=14)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_days"


# ── GET /wiki/analytics: the numbers ─────────────────────────────────


async def _add_views(db, node_id, person_id, days_ago, count):
    db.add(WikiPageView(node_id=uuid.UUID(str(node_id)), person_id=person_id,
                        viewed_on=_today() - timedelta(days=days_ago), count=count))
    await db.commit()


async def test_views_top_pages_and_trend(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    popular = await _page(client, s, db, "Popular")
    quiet = await _page(client, s, db, "Quiet")
    file_id = await _file(db, s)
    await _add_views(db, popular["id"], s["viewer_id"], 0, 3)
    await _add_views(db, popular["id"], s["editor_id"], 0, 2)
    await _add_views(db, popular["id"], s["viewer_id"], 2, 1)
    await _add_views(db, quiet["id"], s["viewer_id"], 1, 1)
    await _add_views(db, file_id, s["viewer_id"], 1, 2)
    await _add_views(db, quiet["id"], s["viewer_id"], 40, 50)      # outside 30 days

    body = (await _analytics(client, admin, space=s["space"]["key"])).json()
    top = [(t["node"]["title"], t["views"], t["viewers"]) for t in body["top_pages"]]
    assert top == [("Popular", 6, 2), ("manual.pdf", 2, 1), ("Quiet", 1, 1)]
    assert body["top_pages"][0]["node"] == {
        "id": popular["id"], "title": "Popular", "kind": "page",
        "space_key": s["space"]["key"]}

    by_day = body["views_by_day"]
    assert by_day[-1] == {"day": _today().isoformat(), "views": 5}
    assert by_day[-2] == {"day": (_today() - timedelta(days=1)).isoformat(), "views": 3}
    assert by_day[-3]["views"] == 1
    assert by_day[0]["day"] == (_today() - timedelta(days=29)).isoformat()
    assert sum(d["views"] for d in by_day) == 9

    # the wider window takes in the older views
    body = (await _analytics(client, admin, space=s["space"]["key"], days=90)).json()
    assert sum(d["views"] for d in body["views_by_day"]) == 59
    assert body["top_pages"][0]["node"]["title"] == "Quiet"


async def test_analytics_is_scoped_to_the_space_and_skips_the_trash(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    mine = await _page(client, s, db, "Mine")
    trashed = await _page(client, s, db, "Trashed")
    other_space = await _space(client, admin, name="Elsewhere")
    elsewhere = await _create(client, admin, other_space, "Elsewhere page", kind="page")
    await publish_via_db(db, elsewhere["id"])
    for node in (mine, trashed, elsewhere):
        await _add_views(db, node["id"], s["viewer_id"], 0, 1)
    await client.delete(f"/wiki/nodes/{trashed['id']}", headers=s["owner"])

    body = (await _analytics(client, s["owner"], space=s["space"]["key"])).json()
    assert [t["node"]["title"] for t in body["top_pages"]] == ["Mine"]
    assert body["views_by_day"][-1]["views"] == 1

    # all spaces, for an admin
    body = (await _analytics(client, admin)).json()
    assert sorted(t["node"]["title"] for t in body["top_pages"]) == ["Elsewhere page", "Mine"]


async def test_helpfulness_and_recent_no_comments(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    page = await _page(client, s, db, "Mixed")
    liked = await _page(client, s, db, "Liked")
    await _feedback(client, s["viewer"], page["id"], helpful=False, comment="Missing a step.")
    await _feedback(client, s["editor"], page["id"], helpful=True)
    await _feedback(client, s["owner"], page["id"], helpful=True)
    await _feedback(client, s["viewer"], liked["id"], helpful=True)
    # an old "No" falls outside the window
    await _feedback(client, s["editor"], liked["id"], helpful=False, comment="Old news.")
    await db.execute(update(WikiFeedback).where(
        WikiFeedback.node_id == uuid.UUID(liked["id"]),
        WikiFeedback.person_id == s["editor_id"]).values(
        updated_at=datetime.now(UTC) - timedelta(days=45)))
    await db.commit()

    body = (await _analytics(client, admin, space=s["space"]["key"])).json()
    helpful = {h["node"]["title"]: (h["yes"], h["no"], h["pct"]) for h in body["helpfulness"]}
    assert helpful == {"Mixed": (2, 1, 67), "Liked": (1, 0, 100)}
    assert [(c["node"]["title"], c["comment"]) for c in body["recent_no_comments"]] == [
        ("Mixed", "Missing a step.")]
    assert body["recent_no_comments"][0]["at"]

    body = (await _analytics(client, admin, space=s["space"]["key"], days=90)).json()
    helpful = {h["node"]["title"]: (h["yes"], h["no"], h["pct"]) for h in body["helpfulness"]}
    assert helpful["Liked"] == (1, 1, 50)


async def test_failed_searches_are_for_admins_only(client, db):
    s = await _setup(client, db)
    admin = await _admin(client, db)
    now = datetime.now(UTC)
    db.add_all([
        WikiSearchLog(person_id=s["viewer_id"], query="Pallet Jack", result_count=0,
                      at=now - timedelta(days=1)),
        WikiSearchLog(person_id=s["editor_id"], query="pallet jack", result_count=0, at=now),
        WikiSearchLog(person_id=s["editor_id"], query="forklift", result_count=0,
                      at=now - timedelta(days=2)),
        WikiSearchLog(person_id=s["editor_id"], query="found it", result_count=3, at=now),
        WikiSearchLog(person_id=s["editor_id"], query="ancient", result_count=0,
                      at=now - timedelta(days=60)),
    ])
    await db.commit()

    body = (await _analytics(client, admin)).json()
    failed = [(f["query"], f["count"]) for f in body["failed_searches"]]
    assert failed == [("pallet jack", 2), ("forklift", 1)]
    assert datetime.fromisoformat(body["failed_searches"][0]["last_at"]) >= now - timedelta(seconds=1)

    body = (await _analytics(client, s["owner"], space=s["space"]["key"])).json()
    assert body["failed_searches"] == []


async def test_stale_pages_and_overdue_reviews(client, db):
    s = await _setup(client, db)
    fresh = await _page(client, s, db, "Fresh")
    stale = await _page(client, s, db, "Stale")
    draft = await _page(client, s, db, "Never published", publish=False)
    overdue = await _page(client, s, db, "Overdue")
    long_ago = datetime.now(UTC) - timedelta(days=400)
    await db.execute(update(WikiNode).where(
        WikiNode.id.in_([uuid.UUID(stale["id"]), uuid.UUID(draft["id"])]))
        .values(updated_at=long_ago))
    await db.execute(update(WikiNode).where(WikiNode.id == uuid.UUID(overdue["id"])).values(
        review_interval_months=6, next_review_at=datetime.now(UTC) - timedelta(days=3)))
    await db.execute(update(WikiNode).where(WikiNode.id == uuid.UUID(fresh["id"])).values(
        review_interval_months=6, next_review_at=datetime.now(UTC) + timedelta(days=30)))
    await db.commit()

    body = (await _analytics(client, s["owner"], space=s["space"]["key"])).json()
    assert [p["node"]["title"] for p in body["stale_pages"]] == ["Stale"]
    assert datetime.fromisoformat(body["stale_pages"][0]["updated_at"]) < \
        datetime.now(UTC) - timedelta(days=365)
    assert [r["node"]["title"] for r in body["overdue_reviews"]] == ["Overdue"]
    assert body["overdue_reviews"][0]["next_review_at"]


async def test_a_manager_sees_only_nodes_they_can_view(client, db):
    """Space-level manage always survives a broken inheritance, so a
    manager sees every node in their space — but a node-level manager
    (no space grant) must not be able to ask about the space at all."""
    s = await _setup(client, db)
    page = await _page(client, s, db, "Delegated")
    delegate_h, delegate_id = await login_as(client, db, roles=("staff",))
    resp = await client.put(f"/wiki/nodes/{page['id']}/permissions", headers=s["owner"], json={
        "inherit": True,
        "grants": [{"principal_type": "person", "principal_id": str(delegate_id),
                    "level": "manage"}]})
    assert resp.status_code == 200, resp.text
    assert (await _analytics(client, delegate_h, space=s["space"]["key"])).status_code == 403
    await _put_grants(client, s["owner"], s["space"], [
        {"principal_type": "person", "principal_id": str(s["owner_id"]), "level": "manage"},
    ])
    assert (await _analytics(client, s["owner"], space=s["space"]["key"])).status_code == 200
