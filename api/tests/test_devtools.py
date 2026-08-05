"""God mode unlock. The endpoint reveals nothing it doesn't grant: a wrong
word, a correct word from a non-developer, and an unconfigured feature must
be indistinguishable from each other and from a route that doesn't exist."""
import pytest
from sqlalchemy import select, text

from serversherpa.db.models import AuditLog


@pytest.fixture
def god_words(monkeypatch):
    """Pin the words for the test rather than depending on the real .env."""
    from serversherpa.config import get_settings

    monkeypatch.setenv("SS_GOD_MODE_WORDS", "abracadabra,ikdfa")
    monkeypatch.setenv("SS_GOD_MODE_NAV_COLOR", "#00c853")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()      # restore real settings for other tests


@pytest.fixture
def no_god_words(monkeypatch):
    from serversherpa.config import get_settings

    monkeypatch.setenv("SS_GOD_MODE_WORDS", "")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def login(client, email="alice@test.example.com", pw="CorrectHorse9!"):
    resp = await client.post("/auth/login", json={"email": email, "password": pw})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def set_role(db, person_id, role):
    await db.execute(text("UPDATE person_roles SET role=:r WHERE person_id=:p"),
                     {"r": role, "p": person_id})
    await db.commit()


async def test_developer_with_correct_word_unlocks(client, db, seeded_user, god_words):
    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    resp = await client.post("/devtools/unlock", headers=hdrs,
                             json={"word": "abracadabra"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"nav_color": "#00c853"}

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "godmode.enable"))
    assert row is not None
    assert row.actor_person_id == seeded_user.id
    assert "abracadabra" not in str(row.changes)   # no word material stored


async def test_second_word_also_works(client, db, seeded_user, god_words):
    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    resp = await client.post("/devtools/unlock", headers=hdrs, json={"word": "ikdfa"})
    assert resp.status_code == 200


async def test_founder_with_correct_word_is_refused(client, db, seeded_user, god_words):
    """Rank 100 and still refused — devtools is hard-gated on the literal
    developer role, not on rank."""
    await set_role(db, seeded_user.id, "founder")
    hdrs = await login(client)
    resp = await client.post("/devtools/unlock", headers=hdrs,
                             json={"word": "abracadabra"})
    assert resp.status_code == 404
    assert resp.json() == {"detail": {"code": "not_found"}}


async def test_admin_with_correct_word_is_refused(client, db, seeded_user, god_words):
    await set_role(db, seeded_user.id, "admin")
    hdrs = await login(client)
    resp = await client.post("/devtools/unlock", headers=hdrs,
                             json={"word": "abracadabra"})
    assert resp.status_code == 404
    assert resp.json() == {"detail": {"code": "not_found"}}


async def test_developer_with_wrong_word_is_refused(client, db, seeded_user, god_words):
    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    resp = await client.post("/devtools/unlock", headers=hdrs, json={"word": "nope"})
    assert resp.status_code == 404
    assert resp.json() == {"detail": {"code": "not_found"}}


async def test_unconfigured_feature_refuses_everyone(client, db, seeded_user,
                                                     no_god_words):
    """No words configured = the feature cannot be activated at all."""
    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    for word in ("", "abracadabra"):
        resp = await client.post("/devtools/unlock", headers=hdrs, json={"word": word})
        assert resp.status_code == 404


async def test_all_refusals_are_byte_identical(client, db, seeded_user, god_words,
                                               monkeypatch):
    """The refusal must not vary by reason — that variance IS the leak."""
    from serversherpa.config import get_settings

    bodies = []

    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    bodies.append((await client.post("/devtools/unlock", headers=hdrs,
                                     json={"word": "wrong"})).text)

    await set_role(db, seeded_user.id, "admin")
    hdrs = await login(client)
    bodies.append((await client.post("/devtools/unlock", headers=hdrs,
                                     json={"word": "abracadabra"})).text)
    bodies.append((await client.post("/devtools/unlock", headers=hdrs,
                                     json={"word": "wrong"})).text)

    # Third refusal reason: feature unconfigured entirely (no words set).
    # Toggle it inline rather than via the no_god_words fixture, since this
    # test already depends on god_words; restore afterwards so later tests
    # see the real god_words state, mirroring the fixtures' own teardown.
    monkeypatch.setenv("SS_GOD_MODE_WORDS", "")
    get_settings.cache_clear()
    try:
        await set_role(db, seeded_user.id, "developer")
        hdrs = await login(client)
        bodies.append((await client.post("/devtools/unlock", headers=hdrs,
                                         json={"word": "abracadabra"})).text)
    finally:
        monkeypatch.setenv("SS_GOD_MODE_WORDS", "abracadabra,ikdfa")
        get_settings.cache_clear()

    assert len(set(bodies)) == 1, f"refusals differ: {bodies}"


async def test_unauthenticated_is_rejected(client, god_words):
    resp = await client.post("/devtools/unlock", json={"word": "abracadabra"})
    assert resp.status_code == 401


async def test_endpoint_is_absent_from_the_openapi_schema(client):
    """Nothing should advertise that this route exists."""
    schema = (await client.get("/openapi.json")).json()
    assert "/devtools/unlock" not in schema["paths"]


async def test_no_audit_row_on_refusal(client, db, seeded_user, god_words):
    await set_role(db, seeded_user.id, "admin")
    hdrs = await login(client)
    await client.post("/devtools/unlock", headers=hdrs, json={"word": "abracadabra"})
    assert await db.scalar(
        select(AuditLog).where(AuditLog.action == "godmode.enable")) is None


async def test_word_match_is_case_insensitive(client, db, seeded_user, god_words):
    """The words are typed by hand into the palette; case carries no
    defensive value here (guessing grants nothing either way)."""
    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    for variant in ("abracadabra", "ABRACADABRA", "AbRaCaDaBrA", "IKDFA"):
        resp = await client.post("/devtools/unlock", headers=hdrs,
                                 json={"word": variant})
        assert resp.status_code == 200, f"{variant!r} should unlock"


async def test_non_ascii_input_is_refused_not_crashed(client, db, seeded_user,
                                                      god_words):
    """secrets.compare_digest raises TypeError on non-ASCII str. Any palette
    query reaches this endpoint, so a 500 here would both error AND be
    distinguishable from the standard refusal — the leak the 404 exists to
    prevent. Comparing bytes keeps every input on the same path."""
    await set_role(db, seeded_user.id, "developer")
    hdrs = await login(client)
    for probe in ("café", "日本語", "🔑"):
        resp = await client.post("/devtools/unlock", headers=hdrs,
                                 json={"word": probe})
        assert resp.status_code == 404, f"{probe!r} should refuse, not crash"
        assert resp.json() == {"detail": {"code": "not_found"}}
