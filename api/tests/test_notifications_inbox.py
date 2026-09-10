"""In-app notification inbox: notify() rows, list + unread count, read,
read-all, and the own-rows-only rule."""

from uuid import uuid4

from sqlalchemy import select

from serversherpa.db.models import Notification
from serversherpa.notifications.inbox import notify

from tests.test_sites_api import login
from tests.test_status_values_write import _make


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
    assert resp.json() == {"unread_count": 0, "items": []}


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
