"""System › Learning: policy settings, gated on the learning manager helper."""

from sqlalchemy import select

from serversherpa.db.models import AuditLog, PermissionOverride, UserAccount
from serversherpa.learning.languages import CODES
from serversherpa.learning.settings import LearningSettings, load_settings
from tests.test_sites_api import login  # noqa: F401
from tests.test_status_values_write import _make

DEFAULTS = {
    "code_max_failures": 10, "code_lockout_seconds": 900,
    "ip_limit": 30, "ip_window_seconds": 300, "global_limit": 300,
    "general_code_days": None,
    "default_validity_days": None,
    "invite_offset_days": 7, "invite_time": "08:00",
    "reminder_offsets": [5, 3], "due_offset_days": 2,
    "retention_days": None,
    "brand_line": "",
    "email_text": {},
    "languages": ["en"],
    "available_languages": list(CODES),
}


async def _admin(db, client):
    return await _make(db, client, "admin", "learn-admin@test.example.com")


async def test_defaults_returned(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.get("/system/learning", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json() == DEFAULTS
    loaded = await load_settings(db)
    assert isinstance(loaded, LearningSettings)
    assert loaded.code_max_failures == 10 and loaded.general_code_days is None
    assert loaded.languages == ["en"]


async def test_put_validates_and_audits(client, db, seeded_user):
    hdrs = await _admin(db, client)
    text = {"invite": {"en": {"subject": "Hello", "intro": "Please read."}}}
    resp = await client.put("/system/learning", headers=hdrs, json={
        "code_max_failures": 5, "general_code_days": 30, "invite_time": "09:30",
        "reminder_offsets": [7, 0], "languages": ["en", "ja", "ms", "zh-Hans"],
        "email_text": text})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {**DEFAULTS, "code_max_failures": 5, "general_code_days": 30,
                    "invite_time": "09:30", "reminder_offsets": [7, 0],
                    "languages": ["en", "ja", "ms", "zh-Hans"], "email_text": text}
    assert (await client.get("/system/learning", headers=hdrs)).json() == body
    # an explicit null clears a "rule off" number back to unset
    resp = await client.put("/system/learning", headers=hdrs,
                            json={"general_code_days": None})
    assert resp.status_code == 200 and resp.json()["general_code_days"] is None
    loaded = await load_settings(db)
    assert loaded.invite_time == "09:30" and loaded.general_code_days is None

    for bad in (
        {"code_max_failures": 0}, {"ip_limit": -1}, {"retention_days": 0},
        {"code_max_failures": None}, {"invite_time": "9:30"},
        {"invite_time": "24:00"}, {"reminder_offsets": [3, 3]},
        {"reminder_offsets": [366]}, {"reminder_offsets": [-1]},
        {"languages": ["ja"]}, {"languages": ["en", "xx"]}, {"languages": ["en", "zh"]},
        {"languages": ["en", "en"]},
        {"email_text": {"invite": {"xx": {"subject": "a", "intro": "b"}}}},
        {"email_text": {"invite": {"en": {"subject": "a"}}}},
        {"email_text": {"due": {"en": {"subject": "a", "intro": "b"}}}},
        {"email_text": {"invite": {"en": {"subject": "x" * 201, "intro": "b"}}}},
    ):
        resp = await client.put("/system/learning", headers=hdrs, json=bad)
        assert resp.status_code == 422, (bad, resp.text)

    rows = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "system", AuditLog.entity_id == "learning")
        .order_by(AuditLog.at)))
    assert [r.action for r in rows] == ["learning_config_update"] * 2
    assert rows[0].changes["code_max_failures"] == {"from": 10, "to": 5}
    assert rows[0].changes["general_code_days"] == {"from": None, "to": 30}
    assert rows[1].changes == {"general_code_days": {"from": 30, "to": None}}


async def test_put_rejects_unknown_key(client, db, seeded_user):
    hdrs = await _admin(db, client)
    resp = await client.put("/system/learning", headers=hdrs, json={"bogus": 1})
    assert resp.status_code == 422
    assert (await client.get("/system/learning", headers=hdrs)).json() == DEFAULTS


async def test_worker_forbidden(client, db, seeded_user):
    worker = await _make(db, client, "worker", "learn-worker@test.example.com")
    assert (await client.get("/system/learning", headers=worker)).status_code == 403
    resp = await client.put("/system/learning", headers=worker,
                            json={"code_max_failures": 3})
    assert resp.status_code == 403
    # a read-only manager (learning:view, not change) can read but not write
    staff = await _make(db, client, "staff", "learn-staff@test.example.com")
    assert (await client.get("/system/learning", headers=staff)).status_code == 200
    assert (await client.put("/system/learning", headers=staff,
                             json={"code_max_failures": 3})).status_code == 403


async def test_wiki_admin_allowed(client, db, seeded_user):
    # staff holds learning:view only; a global wiki:delete on top makes them
    # a manager for change too (the wiki-administrator fallback)
    hdrs = await _make(db, client, "staff", "learn-wiki@test.example.com")
    body = {"brand_line": "Cumulus"}
    assert (await client.put("/system/learning", headers=hdrs, json=body)).status_code == 403
    person_id = await db.scalar(select(UserAccount.person_id).where(
        UserAccount.email == "learn-wiki@test.example.com"))
    db.add(PermissionOverride(person_id=person_id, resource="wiki",
                              action="delete", allow=True))
    await db.commit()
    resp = await client.put("/system/learning", headers=hdrs, json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json()["brand_line"] == "Cumulus"
    assert (await client.get("/system/learning", headers=hdrs)).status_code == 200


async def test_learn_site_lists_the_offered_languages(client, db, seeded_user):
    # public: the sign-in page shows the picker before anyone signs in
    resp = await client.get("/learn/languages")
    assert resp.status_code == 200, resp.text
    assert resp.json() == [{"code": "en", "rtl": False}]

    hdrs = await _admin(db, client)
    resp = await client.put("/system/learning", headers=hdrs,
                            json={"languages": ["ms", "en", "he", "zh-Hans"]})
    assert resp.status_code == 200, resp.text
    # catalog order, English first, right to left flagged
    assert (await client.get("/learn/languages")).json() == [
        {"code": "en", "rtl": False}, {"code": "zh-Hans", "rtl": False},
        {"code": "he", "rtl": True}, {"code": "ms", "rtl": False}]
