"""In-app notification inbox: notify() rows, list + unread count, read,
read-all, the own-rows-only rule, and the paged / category-filtered list the
full /notifications page uses."""

import base64
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import event, select

from serversherpa.api.routes.notifications import _decode_inbox_cursor, _encode_inbox_cursor
from serversherpa.db.engine import get_engine
from serversherpa.db.models import Notification, Person
from serversherpa.notifications.inbox import notify

from tests.test_sites_api import login
from tests.test_status_values_write import _make

BASE = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


def _row(person_id, title, *, at, kind="report_ready", read=False, hidden=False):
    """An inbox row with an exact created_at, so a test controls ordering ties."""
    return Notification(person_id=person_id, kind=kind, title=title, created_at=at,
                        read_at=at if read else None,
                        dismissed_at=at if hidden else None)


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


async def _walk(client, hdrs, **params):
    """Every page of the inbox, following next_cursor from the first call."""
    pages, cursor = [], None
    while True:
        query = {**params, **({"cursor": cursor} if cursor else {})}
        resp = await client.get("/notifications/inbox", params=query, headers=hdrs)
        assert resp.status_code == 200, resp.text
        pages.append(resp.json())
        cursor = pages[-1]["next_cursor"]
        if cursor is None:
            return pages
        assert len(pages) < 50, "the cursor never ran out"


async def test_notify_adds_row_without_committing(db, seeded_user):
    n = await notify(db, seeded_user.id, "report_ready", "Move Report is ready",
                     body="NAP11", link="/reports?tab=history&run=abc",
                     payload={"run_id": "abc"})
    assert n.read_at is None
    await db.commit()
    row = await db.scalar(select(Notification).where(Notification.person_id == seeded_user.id))
    assert row.kind == "report_ready"
    assert row.payload == {"run_id": "abc"}
    assert row.body == "NAP11"


async def test_inbox_lists_newest_first_with_unread_count(client, db, seeded_user):
    hdrs = await login(client)
    await notify(db, seeded_user.id, "report_ready", "First")
    await notify(db, seeded_user.id, "report_failed", "Second", body="boom")
    await db.commit()
    resp = await client.get("/notifications/inbox", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["unread_count"] == 2
    assert [i["title"] for i in body["items"]] == ["Second", "First"]
    assert body["items"][0]["read_at"] is None
    assert body["items"][0]["link"] is None


async def test_inbox_is_per_person(client, db, seeded_user):
    other = await _make(db, client, "staff", "bob@test.example.com")
    await notify(db, seeded_user.id, "report_ready", "Alice only")
    await db.commit()
    resp = await client.get("/notifications/inbox", headers=other)
    assert resp.json() == {"unread_count": 0, "items": [], "next_cursor": None, "total": 0}


async def test_mark_read_and_read_all(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await notify(db, seeded_user.id, "report_ready", "B")
    await db.commit()
    resp = await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)
    assert resp.status_code == 204
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert body["unread_count"] == 1
    assert (await client.get("/notifications/inbox?unread_only=true",
                             headers=hdrs)).json()["items"][0]["title"] == "B"
    assert (await client.post("/notifications/inbox/read-all", headers=hdrs)).status_code == 204
    assert (await client.get("/notifications/inbox", headers=hdrs)).json()["unread_count"] == 0


async def test_mark_read_rejects_other_persons_row(client, db, seeded_user):
    other = await _make(db, client, "staff", "bob@test.example.com")
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await db.commit()
    assert (await client.post(f"/notifications/inbox/{a.id}/read", headers=other)).status_code == 404
    assert (await client.post(f"/notifications/inbox/{uuid4()}/read", headers=other)).status_code == 404


async def test_mark_unread_restores_the_row(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await db.commit()
    await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)
    assert (await client.get("/notifications/inbox", headers=hdrs)).json()["unread_count"] == 0
    resp = await client.post(f"/notifications/inbox/{a.id}/unread", headers=hdrs)
    assert resp.status_code == 204
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert body["unread_count"] == 1 and body["items"][0]["read_at"] is None


async def test_hide_is_soft_and_excluded_from_list_and_count(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    b = await notify(db, seeded_user.id, "report_ready", "B")
    await db.commit()
    resp = await client.delete(f"/notifications/inbox/{a.id}", headers=hdrs)
    assert resp.status_code == 204
    assert (await client.delete(f"/notifications/inbox/{a.id}", headers=hdrs)).status_code == 204  # idempotent
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert [i["id"] for i in body["items"]] == [str(b.id)]
    assert body["unread_count"] == 1
    await db.refresh(a)
    assert a.dismissed_at is not None                      # row kept
    assert (await client.post(f"/notifications/inbox/{a.id}/unread", headers=hdrs)).status_code == 404
    assert (await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)).status_code == 404


async def test_hide_and_unread_are_own_rows_only(client, db, seeded_user):
    other = await _make(db, client, "staff", "bob@test.example.com")
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await db.commit()
    assert (await client.delete(f"/notifications/inbox/{a.id}", headers=other)).status_code == 404
    assert (await client.post(f"/notifications/inbox/{a.id}/unread", headers=other)).status_code == 404
    assert (await client.delete(f"/notifications/inbox/{uuid4()}", headers=other)).status_code == 404


async def test_clear_read_hides_only_read_rows(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await notify(db, seeded_user.id, "report_ready", "B")
    await db.commit()
    await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)
    assert (await client.post("/notifications/inbox/clear-read", headers=hdrs)).status_code == 204
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert [i["title"] for i in body["items"]] == ["B"] and body["unread_count"] == 1
    assert (await client.post("/notifications/inbox/clear-read", headers=hdrs)).status_code == 204  # nothing left: fine


async def test_notify_returns_none_when_the_category_is_off(db, seeded_user):
    from serversherpa.db.models import UserAccount

    account = await db.get(UserAccount, seeded_user.id)
    account.ui_prefs = {"notif": {"categories": {"reports": "off"}}}
    await db.commit()
    assert await notify(db, seeded_user.id, "report_ready", "Hidden") is None
    # other categories and unregistered kinds still land
    assert await notify(db, seeded_user.id, "wiki_comment", "Shown") is not None
    assert await notify(db, seeded_user.id, "mystery_kind", "Shown too") is not None
    await db.commit()
    titles = list(await db.scalars(select(Notification.title).where(
        Notification.person_id == seeded_user.id)))
    assert sorted(titles) == ["Shown", "Shown too"]


# ── paging, categories, total ────────────────────────────────────────

async def test_inbox_pages_without_gaps_or_repeats(client, db, seeded_user):
    hdrs = await login(client)
    top = _row(seeded_user.id, "top", at=BASE + timedelta(hours=3))
    tied = [_row(seeded_user.id, f"tied {i}", at=BASE + timedelta(hours=2)) for i in range(3)]
    old = _row(seeded_user.id, "old", at=BASE + timedelta(hours=1))
    db.add_all([old, *tied, top])        # inserted out of order on purpose
    await db.commit()
    # newest first; rows that share a created_at break the tie on id, descending
    expected = [top.id, *sorted((r.id for r in tied), reverse=True), old.id]

    pages = await _walk(client, hdrs, limit=2)

    assert [len(p["items"]) for p in pages] == [2, 2, 1]
    assert [i["id"] for p in pages for i in p["items"]] == [str(i) for i in expected]
    assert all(p["total"] == 5 for p in pages)         # total ignores the cursor
    assert pages[-1]["next_cursor"] is None
    # exactly one full page: no cursor pointing at a page that would be empty
    whole = (await client.get("/notifications/inbox?limit=5", headers=hdrs)).json()
    assert len(whole["items"]) == 5 and whole["next_cursor"] is None


async def test_inbox_paging_respects_the_filters(client, db, seeded_user):
    hdrs = await login(client)
    db.add_all([
        _row(seeded_user.id, "wiki 1", kind="wiki_comment", at=BASE + timedelta(minutes=1)),
        _row(seeded_user.id, "report 1", kind="report_ready", at=BASE + timedelta(minutes=2)),
        _row(seeded_user.id, "wiki 2", kind="wiki_mention", at=BASE + timedelta(minutes=3),
             read=True),
        _row(seeded_user.id, "report 2", kind="report_failed", at=BASE + timedelta(minutes=4)),
        _row(seeded_user.id, "wiki 3", kind="wiki_update", at=BASE + timedelta(minutes=5)),
    ])
    await db.commit()

    wiki = await _walk(client, hdrs, category="wiki", limit=2)
    assert [[i["title"] for i in p["items"]] for p in wiki] == [["wiki 3", "wiki 2"], ["wiki 1"]]

    unread_wiki = await _walk(client, hdrs, category="wiki", unread_only="true", limit=1)
    assert [i["title"] for p in unread_wiki for i in p["items"]] == ["wiki 3", "wiki 1"]
    assert all(p["total"] == 2 for p in unread_wiki)


async def test_inbox_category_filter_and_item_category(client, db, seeded_user):
    hdrs = await login(client)
    db.add_all([
        _row(seeded_user.id, "Comment", kind="wiki_comment", at=BASE + timedelta(minutes=3)),
        _row(seeded_user.id, "Report", kind="report_ready", at=BASE + timedelta(minutes=2)),
        _row(seeded_user.id, "Mystery", kind="mystery_kind", at=BASE + timedelta(minutes=1)),
    ])
    await db.commit()

    everything = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert {i["title"]: i["category"] for i in everything["items"]} == {
        "Comment": "wiki", "Report": "reports", "Mystery": None}    # unregistered: no category

    wiki = (await client.get("/notifications/inbox?category=wiki", headers=hdrs)).json()
    assert [(i["title"], i["category"]) for i in wiki["items"]] == [("Comment", "wiki")]
    empty = (await client.get("/notifications/inbox?category=learning", headers=hdrs)).json()
    assert empty["items"] == [] and empty["total"] == 0


async def test_inbox_total_counts_the_filter(client, db, seeded_user):
    hdrs = await login(client)
    await _make(db, client, "staff", "bob@test.example.com")
    bob = await db.scalar(select(Person).where(Person.email == "bob@test.example.com"))
    db.add_all([
        _row(seeded_user.id, "wiki unread", kind="wiki_comment", at=BASE + timedelta(minutes=1)),
        _row(seeded_user.id, "wiki read", kind="wiki_comment", at=BASE + timedelta(minutes=2),
             read=True),
        _row(seeded_user.id, "report unread", kind="report_ready", at=BASE + timedelta(minutes=3)),
        _row(seeded_user.id, "wiki hidden", kind="wiki_comment", at=BASE + timedelta(minutes=4),
             hidden=True),
        _row(bob.id, "Bob's", kind="wiki_comment", at=BASE + timedelta(minutes=5)),
    ])
    await db.commit()

    async def ask(**params):
        return (await client.get("/notifications/inbox", params=params, headers=hdrs)).json()

    assert (await ask())["total"] == 3                    # live rows, mine only
    assert (await ask(category="wiki"))["total"] == 2
    assert (await ask(unread_only="true"))["total"] == 2
    assert (await ask(category="wiki", unread_only="true"))["total"] == 1
    one = await ask(limit=1)
    assert one["total"] == 3 and len(one["items"]) == 1   # total is not the page size
    # unread_count stays the person's overall unread count, whatever the filter
    for params in ({}, {"category": "wiki"}, {"category": "wiki", "unread_only": "true"}):
        assert (await ask(**params))["unread_count"] == 2


async def test_inbox_rejects_bad_category_and_cursor(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/notifications/inbox?category=nonsense", headers=hdrs)
    assert resp.status_code == 422 and resp.json()["detail"] == {"code": "invalid_category"}

    unaware = BASE.replace(tzinfo=None).isoformat()
    for cursor in ("not-a-cursor",
                   _b64("no separator at all"),
                   _b64(f"{BASE.isoformat()}|not-a-uuid"),
                   _b64(f"yesterday|{uuid4()}"),
                   _b64(f"{unaware}|{uuid4()}"),            # no UTC offset: not one of ours
                   _b64(f"0001-01-01T00:00:00+05:00|{uuid4()}")):   # overflows going to UTC
        resp = await client.get("/notifications/inbox", params={"cursor": cursor}, headers=hdrs)
        assert resp.status_code == 422, cursor
        assert resp.json()["detail"] == {"code": "invalid_cursor"}, cursor

    ok = await client.get("/notifications/inbox",
                          params={"cursor": _b64(f"{BASE.isoformat()}|{uuid4()}")}, headers=hdrs)
    assert ok.status_code == 200


async def test_inbox_default_call_unchanged(client, db, seeded_user):
    """The bell's call (no params): the 50 newest live rows, newest first, and
    the person's overall unread count, not just this page's."""
    hdrs = await login(client)
    db.add_all([_row(seeded_user.id, f"n{n:02d}", at=BASE + timedelta(minutes=n),
                     read=(n == 57), hidden=(n == 60)) for n in range(61)])
    await db.commit()

    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert [i["title"] for i in body["items"]] == [f"n{n:02d}" for n in range(59, 9, -1)]
    assert body["unread_count"] == 59                  # 60 live rows, one of them read
    assert body["total"] == 60 and body["next_cursor"] is not None

    unread = (await client.get("/notifications/inbox?unread_only=true", headers=hdrs)).json()
    assert [i["title"] for i in unread["items"]] == [
        f"n{n:02d}" for n in range(59, 8, -1) if n != 57]
    assert unread["unread_count"] == 59 and unread["total"] == 59


async def test_inbox_bell_poll_counts_in_one_query(client, db, seeded_user):
    """The bell's 30 s poll (no params): `total` is the person's live rows and
    `unread_count` the unread ones among them, both from one statement, so
    the call reads the inbox twice (the counts, the page), not three times."""
    hdrs = await login(client)
    await _make(db, client, "staff", "bob@test.example.com")
    bob = await db.scalar(select(Person).where(Person.email == "bob@test.example.com"))
    db.add_all([
        _row(seeded_user.id, "unread 1", at=BASE + timedelta(minutes=1)),
        _row(seeded_user.id, "unread 2", at=BASE + timedelta(minutes=2)),
        _row(seeded_user.id, "read", at=BASE + timedelta(minutes=3), read=True),
        _row(seeded_user.id, "hidden unread", at=BASE + timedelta(minutes=4), hidden=True),
        _row(seeded_user.id, "hidden read", at=BASE + timedelta(minutes=5), read=True,
             hidden=True),
        _row(bob.id, "Bob's", at=BASE + timedelta(minutes=6)),
    ])
    await db.commit()

    statements: list[str] = []

    def remember(conn, cursor, statement, parameters, context, executemany):
        statements.append(" ".join(statement.split()))

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", remember)
    try:
        body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    finally:
        event.remove(engine, "before_cursor_execute", remember)

    assert (body["total"], body["unread_count"]) == (3, 2)
    assert [i["title"] for i in body["items"]] == ["read", "unread 2", "unread 1"]
    inbox_reads = [s for s in statements if "FROM notifications" in s]
    assert len(inbox_reads) == 2, inbox_reads


async def test_inbox_limit_is_clamped_to_1_through_100(client, db, seeded_user):
    hdrs = await login(client)
    db.add_all([_row(seeded_user.id, f"n{n:03d}", at=BASE + timedelta(minutes=n))
                for n in range(105)])
    await db.commit()

    async def size(**params):
        resp = await client.get("/notifications/inbox", params=params, headers=hdrs)
        assert resp.status_code == 200, resp.text
        return len(resp.json()["items"])

    assert await size() == 50
    assert [await size(limit=n) for n in (0, -4, 1, 100, 101, 5000)] == [1, 1, 1, 100, 100, 100]


async def test_inbox_cursor_round_trips_with_microseconds():
    ident = uuid4()
    for at in (datetime(2026, 10, 1, 12, 0, 0, 123456, tzinfo=UTC),
               datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC)):
        cursor = _encode_inbox_cursor(at, ident)
        assert cursor.replace("-", "").replace("_", "").isalnum()      # base64url, unpadded
        assert _decode_inbox_cursor(cursor) == (at, ident)
