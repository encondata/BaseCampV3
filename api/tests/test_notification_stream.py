"""The live inbox stream (SS-500): /notifications/inbox/stream authenticates
like the log tail (token in the subprotocol list only), refuses kiosk and
password-owed sessions, signals only the signed-in person's own inbox
changes, pings and re-checks the session, and survives the app (and so the
hub) being started twice in one process."""

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import create_engine, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from serversherpa.api.app import create_app
from serversherpa.api.routes import notifications as notification_routes
from serversherpa.config import get_settings
from serversherpa.db.engine import connect_args, dispose_engine
from serversherpa.db.models import Person, UserAccount
from serversherpa.notifications.inbox import notify
from tests.test_assets_api import login, make_login

STREAM = "/notifications/inbox/stream"


def _token(headers: dict) -> str:
    return headers["Authorization"].removeprefix("Bearer ")


async def _hand_db_to_the_app(db) -> None:
    """TestClient runs the app in its own thread and event loop, and asyncpg
    connections are loop-bound, so the engine pooled in pytest's loop is
    dropped first (as the log-tail tests do)."""
    await db.close()
    await dispose_engine()


def _commit_notify(person_id) -> None:
    """notify() + commit from a separate session on a separate loop, the way
    another API request or a worker would write it."""
    async def go():
        settings = get_settings()
        engine = create_async_engine(settings.database_url.get_secret_value(),
                                     connect_args=connect_args(settings))
        try:
            async with async_sessionmaker(engine)() as session:
                assert await notify(session, person_id, "report_ready", "Ready") is not None
                await session.commit()
        finally:
            await engine.dispose()

    with ThreadPoolExecutor(1) as pool:
        pool.submit(asyncio.run, go()).result()


def _receive_inbox(ws, within: float = 2.0) -> None:
    """Read past pings until an inbox signal arrives, failing after `within` s."""
    deadline = time.monotonic() + within
    while True:
        msg = ws.receive_json()
        if msg == {"inbox": True}:
            return
        assert msg == {"ping": True}
        assert time.monotonic() < deadline, "no inbox signal in time"


def _close_code(tc, **kwargs) -> int:
    with pytest.raises(WebSocketDisconnect) as exc:
        with tc.websocket_connect(STREAM, **kwargs) as ws:
            ws.receive_json()
    return exc.value.code


async def _second_person(db, client):
    person = Person(first_name="Quinn", last_name="Other", email="quinn@test.example.com")
    db.add(person)
    await db.flush()
    return person, await make_login(db, client, person, "quinn@test.example.com")


@pytest.fixture
def fast_ping(monkeypatch):
    monkeypatch.setattr(notification_routes, "INBOX_STREAM_PING_SECONDS", 0.5)


async def test_stream_requires_token(client, db, seeded_user):
    token = _token(await login(client))
    await _hand_db_to_the_app(db)

    with TestClient(create_app()) as tc:
        assert _close_code(tc) == 4401
        assert _close_code(tc, subprotocols=["ss-bearer", "junk"]) == 4401
        assert _close_code(tc, subprotocols=["other", token]) == 4401
        # a valid token in the query string only is refused like a missing one
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(f"{STREAM}?token={token}") as ws:
                ws.receive_json()
        assert exc.value.code == 4401


async def test_stream_refuses_kiosk_and_password_owed(client, db, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!",
        "client": "kiosk"})
    assert resp.status_code == 200, resp.text
    kiosk_token = resp.json()["access_token"]

    _person, q_headers = await _second_person(db, client)
    await db.execute(update(UserAccount)
                     .where(UserAccount.email == "quinn@test.example.com")
                     .values(must_change_password=True))
    await db.commit()
    await _hand_db_to_the_app(db)

    with TestClient(create_app()) as tc:
        assert _close_code(tc, subprotocols=["ss-bearer", kiosk_token]) == 4403
        assert _close_code(tc, subprotocols=["ss-bearer", _token(q_headers)]) == 4403


async def test_stream_signals_own_notifications_only(client, db, seeded_user, fast_ping):
    p_token = _token(await login(client))
    _quinn, q_headers = await _second_person(db, client)
    p_id = seeded_user.id
    await _hand_db_to_the_app(db)

    with TestClient(create_app()) as tc:
        with tc.websocket_connect(STREAM, subprotocols=["ss-bearer", p_token]) as p_ws, \
             tc.websocket_connect(STREAM, subprotocols=["ss-bearer", _token(q_headers)]) as q_ws:
            assert p_ws.accepted_subprotocol == "ss-bearer"
            assert q_ws.accepted_subprotocol == "ss-bearer"
            _commit_notify(p_id)
            _receive_inbox(p_ws)
            # Q hears only pings: a stray signal would be its next message.
            for _ in range(3):
                assert q_ws.receive_json() == {"ping": True}


async def test_stream_closes_when_session_revoked(client, db, seeded_user, fast_ping):
    token = _token(await login(client))
    await _hand_db_to_the_app(db)
    sync = create_engine(get_settings().sync_database_url)
    try:
        with TestClient(create_app()) as tc:
            with pytest.raises(WebSocketDisconnect) as exc:
                with tc.websocket_connect(STREAM, subprotocols=["ss-bearer", token]) as ws:
                    assert ws.receive_json() == {"ping": True}
                    with sync.begin() as conn:
                        conn.execute(text(
                            "UPDATE auth_sessions SET revoked_at = now(), "
                            "revoke_reason = 'admin'"))
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        ws.receive_json()        # the next check must close 4401
            assert exc.value.code == 4401
    finally:
        sync.dispose()


async def test_stream_works_across_two_app_starts(client, db, seeded_user, fast_ping):
    token = _token(await login(client))
    p_id = seeded_user.id
    await _hand_db_to_the_app(db)

    for _ in range(2):
        with TestClient(create_app()) as tc:
            with tc.websocket_connect(STREAM, subprotocols=["ss-bearer", token]) as ws:
                _commit_notify(p_id)
                _receive_inbox(ws)
