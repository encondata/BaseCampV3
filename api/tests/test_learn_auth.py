"""Worker sign-in on the learn site: a learning code + last name, or the
one-click link, mints a learn session (`Authorization: Learn <token>`) that
only /learn routes accept. Failures lock the code and count against per-IP
and global caps (the move-login pattern)."""
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Initiative, Person, SystemConfig
from serversherpa.learning import codes
from serversherpa.learning.models import LearningCode, LearningSession
from serversherpa.services.password_reset import hash_token
from tests.test_sites_api import login

CODE = "K7QM2X"


def _midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


async def _setup(db, monkeypatch, *, last="Núñez", end_in_days=30):
    person = Person(first_name="Wanda", last_name=last,
                    email=f"{uuid.uuid4().hex[:8]}@test.example.com")
    today = datetime.now(UTC).date()
    move = Initiative(name="Move", initiative_type="move",
                      scheduled_start=_midnight(today),
                      scheduled_end=_midnight(today + timedelta(days=end_in_days)))
    db.add_all([person, move])
    await db.commit()
    monkeypatch.setattr(codes, "generate", lambda: CODE)
    row, code, link = await codes.issue(db, person.id, move.id, actor_id=None)
    await db.commit()
    return person, row, code, link


async def _settings(db, **data):
    db.add(SystemConfig(section="learning", data=data))
    await db.commit()


async def _code_login(client, code=CODE, last_name="nunez", ip=None):
    headers = {"X-Forwarded-For": ip} if ip else {}
    return await client.post("/learn/auth/code", json={"code": code, "last_name": last_name},
                             headers=headers)


def _learn(token):
    return {"Authorization": f"Learn {token}"}


async def _failures(db):
    return await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "learning_code_failed")) or 0


async def test_code_login_success_case_space_insensitive(client, db, monkeypatch):
    person, row, _, _ = await _setup(db, monkeypatch)
    r = await _code_login(client, "k7q m2x", "  NÚÑEZ ")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["person"] == {"first_name": "Wanda"}
    assert datetime.fromisoformat(body["expires_at"]) <= datetime.now(UTC) + timedelta(days=1)
    session = await db.scalar(select(LearningSession).where(
        LearningSession.token_hash == hash_token(body["token"])))
    assert session is not None and session.person_id == person.id and session.code_id == row.id
    me = await client.get("/learn/auth/me", headers=_learn(body["token"]))
    assert me.status_code == 200, me.text
    assert me.json() == {"person_id": str(person.id), "first_name": "Wanda", "via": "code"}
    await db.refresh(row)
    assert row.last_used_at is not None and row.failed_count == 0


async def test_session_expiry_is_capped_at_code_expiry(client, db, monkeypatch):
    _, row, _, _ = await _setup(db, monkeypatch)
    row.expires_at = datetime.now(UTC) + timedelta(hours=2)
    await db.commit()
    body = (await _code_login(client)).json()
    assert datetime.fromisoformat(body["expires_at"]) == row.expires_at


async def test_wrong_last_name_counts_failure(client, db, monkeypatch):
    _, row, _, _ = await _setup(db, monkeypatch)
    wrong_name = await _code_login(client, last_name="Smith")
    wrong_code = await _code_login(client, code="ZZZZZZ")
    # the same answer whichever half was wrong
    for r in (wrong_name, wrong_code):
        assert r.status_code == 401
        assert r.json()["detail"] == {"code": "learn_code_invalid"}
    await db.refresh(row)
    assert row.failed_count == 1 and row.locked_until is None
    assert await _failures(db) == 2


async def test_lockout_after_max_failures_refuses_correct_name(client, db, monkeypatch):
    await _settings(db, code_max_failures=3, code_lockout_seconds=900)
    _, row, _, _ = await _setup(db, monkeypatch)
    for _ in range(3):
        assert (await _code_login(client, last_name="Smith")).status_code == 401
    await db.refresh(row)
    assert row.locked_until is not None
    assert row.locked_until > datetime.now(UTC) + timedelta(seconds=890)
    # locked: the right name gets the same 423 as a wrong one (no name oracle)
    for name in ("nunez", "Smith"):
        r = await _code_login(client, last_name=name)
        assert r.status_code == 423 and r.json()["detail"]["code"] == "learn_code_locked"
    assert await db.scalar(select(func.count()).select_from(LearningSession)) == 0
    # once the lock lapses, the right name works again
    row.locked_until = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    assert (await _code_login(client)).status_code == 200


async def test_ip_cap_429(client, db, monkeypatch):
    await _settings(db, ip_limit=3)
    await _setup(db, monkeypatch)
    for _ in range(3):
        assert (await _code_login(client, code="ZZZZZZ", ip="203.0.113.5")).status_code == 401
    r = await _code_login(client, ip="203.0.113.5")       # even the right code waits
    assert r.status_code == 429 and r.json()["detail"]["code"] == "rate_limited"
    # another address is unaffected
    assert (await _code_login(client, ip="198.51.100.4")).status_code == 200


async def test_global_cap_429(client, db, monkeypatch):
    await _settings(db, global_limit=4)
    await _setup(db, monkeypatch)
    for n in range(4):
        r = await _code_login(client, code="ZZZZZZ", ip=f"203.0.113.{n + 1}")
        assert r.status_code == 401
    # a fresh address with the right code: the global ceiling holds for everyone
    r = await _code_login(client, ip="198.51.100.9")
    assert r.status_code == 429 and r.json()["detail"]["code"] == "rate_limited"
    # failures older than the window no longer count
    await db.execute(AuditLog.__table__.update().where(
        AuditLog.action == "learning_code_failed").values(
        at=datetime.now(UTC) - timedelta(seconds=301)))
    await db.commit()
    assert (await _code_login(client, ip="198.51.100.9")).status_code == 200


async def test_link_login(client, db, monkeypatch):
    person, _, _, link = await _setup(db, monkeypatch)
    for _ in range(2):                                    # reusable until expiry or revoke
        r = await client.post("/learn/auth/link", json={"token": link})
        assert r.status_code == 200, r.text
        assert r.json()["person"] == {"first_name": "Wanda"}
        me = await client.get("/learn/auth/me", headers=_learn(r.json()["token"]))
        assert me.json()["person_id"] == str(person.id)
    bad = await client.post("/learn/auth/link", json={"token": link + "x"})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "learn_code_invalid"


async def test_revoked_or_expired_code_rejected(client, db, monkeypatch):
    _, row, _, link = await _setup(db, monkeypatch)
    token = (await _code_login(client)).json()["token"]
    # expired: neither the code nor the link signs in
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db.commit()
    for r in (await _code_login(client),
              await client.post("/learn/auth/link", json={"token": link})):
        assert r.status_code == 401 and r.json()["detail"]["code"] == "learn_code_invalid"
    # revoked: the code, the link and every session it minted stop working
    row.expires_at = datetime.now(UTC) + timedelta(days=1)
    await db.commit()
    assert (await client.get("/learn/auth/me", headers=_learn(token))).status_code == 200
    await codes.revoke(db, row.id, actor_id=None)
    await db.commit()
    for r in (await _code_login(client),
              await client.post("/learn/auth/link", json={"token": link})):
        assert r.status_code == 401 and r.json()["detail"]["code"] == "learn_code_invalid"
    me = await client.get("/learn/auth/me", headers=_learn(token))
    assert me.status_code == 401 and me.json()["detail"]["code"] == "learn_auth_required"


async def test_expired_or_logged_out_session_rejected(client, db, monkeypatch):
    await _setup(db, monkeypatch)
    token = (await _code_login(client)).json()["token"]
    assert (await client.post("/learn/auth/logout", headers=_learn(token))).status_code == 204
    me = await client.get("/learn/auth/me", headers=_learn(token))
    assert me.status_code == 401 and me.json()["detail"]["code"] == "learn_auth_required"
    token = (await _code_login(client)).json()["token"]
    session = await db.scalar(select(LearningSession).where(
        LearningSession.token_hash == hash_token(token)))
    session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    assert (await client.get("/learn/auth/me", headers=_learn(token))).status_code == 401
    for headers in ({}, _learn("nope"), {"Authorization": "Learn"}):
        r = await client.get("/learn/auth/me", headers=headers)
        assert r.status_code == 401 and r.json()["detail"]["code"] == "learn_auth_required"


async def test_learn_token_cannot_call_portal_routes(client, db, monkeypatch, seeded_user):
    await _setup(db, monkeypatch)
    token = (await _code_login(client)).json()["token"]
    r = await client.get("/people", headers=_learn(token))
    assert r.status_code == 401
    # nor as a bearer: it is not an access token
    r = await client.get("/people", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_account_bearer_accepted_by_learn_me(client, db, seeded_user):
    hdrs = await login(client)
    r = await client.get("/learn/auth/me", headers=hdrs)
    assert r.status_code == 200, r.text
    assert r.json() == {"person_id": str(seeded_user.id), "first_name": "Alice",
                        "via": "account"}
    # logout with an account bearer leaves the portal session alone
    assert (await client.post("/learn/auth/logout", headers=hdrs)).status_code == 204
    assert (await client.get("/learn/auth/me", headers=hdrs)).status_code == 200


async def test_archived_person_cannot_sign_in(client, db, monkeypatch):
    person, _, _, link = await _setup(db, monkeypatch)
    token = (await _code_login(client)).json()["token"]
    person.archived_at = datetime.now(UTC)
    await db.commit()
    assert (await _code_login(client)).status_code == 401
    assert (await client.post("/learn/auth/link", json={"token": link})).status_code == 401
    assert (await client.get("/learn/auth/me", headers=_learn(token))).status_code == 401


async def test_locked_code_counts_against_the_ip_cap(client, db, monkeypatch):
    await _settings(db, code_max_failures=2, ip_limit=4)
    _, row, _, _ = await _setup(db, monkeypatch)
    for _ in range(2):
        await _code_login(client, last_name="Smith", ip="203.0.113.7")
    for _ in range(2):
        assert (await _code_login(client, ip="203.0.113.7")).status_code == 423
    assert (await _code_login(client, ip="203.0.113.7")).status_code == 429
    stored = await db.get(LearningCode, row.id)
    await db.refresh(stored)
    assert stored.failed_count == 0           # reset when the lock was set; locked tries don't add
