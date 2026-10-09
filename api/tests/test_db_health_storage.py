"""Database health (Dev -> Database -> Health): file storage usage by
top-level folder. The storage listing is faked; nothing here touches S3."""

from datetime import UTC, datetime, timedelta

import pytest
from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError

from serversherpa.db.models import Person, PersonRole
from serversherpa.services import storage
from tests.test_assets_api import make_login
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

SECRET = "https://spaces.secret-endpoint.example.com/secret-bucket"


async def _developer(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await devtools_login(client)


def _fake_listing(monkeypatch, objects):
    calls = []

    async def fake(prefix: str = ""):
        calls.append(prefix)
        return objects

    monkeypatch.setattr(storage, "list_objects", fake)
    return calls


async def test_groups_by_first_segment_sorted_by_bytes(client, db, seeded_user, monkeypatch):
    calls = _fake_listing(monkeypatch, [
        ("wiki/exports/a/one.pdf", 1000),
        ("wiki/exports/b/two.pdf", 2000),
        ("reports/r1.xlsx", 5000),
        ("labels/x.pdf", 10),
        ("labels/y.pdf", 20),
        ("readme.txt", 7),
        ("empty-folder/", 0),
    ])
    hdrs = await _developer(db, client, seeded_user)
    before = datetime.now(UTC)
    resp = await client.get("/devtools/health/storage", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert calls == [""]
    assert body["folders"] == [
        {"name": "reports", "objects": 1, "bytes": 5000},
        {"name": "wiki", "objects": 2, "bytes": 3000},
        {"name": "labels", "objects": 2, "bytes": 30},
        {"name": "(root)", "objects": 1, "bytes": 7},
        {"name": "empty-folder", "objects": 1, "bytes": 0},
    ]
    assert body["total_objects"] == 7
    assert body["total_bytes"] == 8037
    measured = datetime.fromisoformat(body["measured_at"])
    assert measured.tzinfo is not None
    assert before - timedelta(seconds=1) <= measured <= datetime.now(UTC) + timedelta(seconds=1)


async def test_equal_bytes_break_ties_by_natural_name(client, db, seeded_user, monkeypatch):
    _fake_listing(monkeypatch, [("f10/a", 5), ("f2/a", 5), ("f1/a", 5)])
    hdrs = await _developer(db, client, seeded_user)
    body = (await client.get("/devtools/health/storage", headers=hdrs)).json()
    assert [f["name"] for f in body["folders"]] == ["f1", "f2", "f10"]


async def test_empty_bucket(client, db, seeded_user, monkeypatch):
    _fake_listing(monkeypatch, [])
    hdrs = await _developer(db, client, seeded_user)
    body = (await client.get("/devtools/health/storage", headers=hdrs)).json()
    assert body["folders"] == []
    assert body["total_objects"] == 0
    assert body["total_bytes"] == 0


@pytest.mark.parametrize("error", [
    ClientError({"Error": {"Code": "AccessDenied", "Message": SECRET}}, "ListObjectsV2"),
    EndpointConnectionError(endpoint_url=SECRET),
    BotoCoreError(),
    OSError(f"cannot reach {SECRET}"),
], ids=["client", "endpoint", "botocore", "oserror"])
async def test_storage_error_is_502_without_leaking(client, db, seeded_user, monkeypatch, error):
    async def boom(prefix: str = ""):
        raise error

    monkeypatch.setattr(storage, "list_objects", boom)
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/health/storage", headers=hdrs)
    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert detail["code"] == "storage_unavailable"
    assert detail["message"]
    assert "secret" not in resp.text.lower()


async def test_list_objects_pages_and_returns_sizes(monkeypatch):
    pages = [
        {"Contents": [{"Key": "a/1", "Size": 3}, {"Key": "b", "Size": 4}]},
        {},     # a page with no Contents key
        {"Contents": [{"Key": "a/2", "Size": 5}]},
    ]
    seen = {}

    class Paginator:
        def paginate(self, **kwargs):
            seen.update(kwargs)
            return iter(pages)

    class Client:
        def get_paginator(self, name):
            seen["op"] = name
            return Paginator()

    monkeypatch.setattr(storage, "_client", lambda: Client())
    assert await storage.list_objects("a/") == [("a/1", 3), ("b", 4), ("a/2", 5)]
    assert seen["op"] == "list_objects_v2"
    assert seen["Prefix"] == "a/"


async def test_non_developers_get_403(client, db, seeded_user, monkeypatch):
    _fake_listing(monkeypatch, [("a/b", 1)])
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-storage@test.example.com")
    assert (await client.get("/devtools/health/storage", headers=hdrs)).status_code == 403


async def test_unauthenticated_is_401(client):
    assert (await client.get("/devtools/health/storage")).status_code == 401
