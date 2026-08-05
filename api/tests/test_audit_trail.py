"""Audit retrofit: auth events, self-service, attachments."""

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog


async def test_login_success_and_failure_audited(client, db, seeded_user):
    await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "wrong-password"})
    await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    rows = list(await db.scalars(select(AuditLog).order_by(AuditLog.at)))
    actions = [r.action for r in rows]
    assert "login_failed" in actions and "login" in actions
    failed = next(r for r in rows if r.action == "login_failed")
    assert failed.actor_person_id is None
    assert failed.entity_id == "alice@test.example.com"
    ok = next(r for r in rows if r.action == "login")
    assert ok.actor_person_id == seeded_user.id


async def test_password_change_audited_and_redacted(client, db, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    resp = await client.post("/auth/me/password", headers=hdrs, json={
        "current_password": "CorrectHorse9!",
        "new_password": "EvenBetterHorse10!"})
    assert resp.status_code == 204
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "password.change"))
    assert row is not None
    assert "password" not in str(row.changes) or "[redacted]" in str(row.changes)


async def test_profile_update_audited_with_diff(client, db, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    await client.patch("/auth/me/profile", headers=hdrs, json={"phone": "555-0100"})
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "update",
                                                 AuditLog.entity_type == "person"))
    assert row.changes["phone"]["to"] == "555-0100"


async def test_noop_profile_update_writes_no_audit_row(client, db, seeded_user):
    """A PATCH that changes nothing (values equal to what's already stored)
    is a pure update with an empty diff — no audit noise."""
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    resp = await client.patch("/auth/me/profile", headers=hdrs,
                              json={"first_name": "Alice"})
    assert resp.status_code == 200
    row = await db.scalar(select(AuditLog).where(AuditLog.action == "update",
                                                 AuditLog.entity_type == "person"))
    assert row is None


async def test_ui_preferences_save_audited(client, db, seeded_user):
    resp = await client.post("/auth/login", json={
        "email": "alice@test.example.com", "password": "CorrectHorse9!"})
    hdrs = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    prefs = {
        "accent": "aqua", "theme": "dark", "density": "compact", "motion": False,
        "notif": {"critical": True, "email": False, "maint": True, "digest": True},
    }
    resp = await client.put("/auth/me/preferences", headers=hdrs, json=prefs)
    assert resp.status_code == 200
    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "preferences.update",
        AuditLog.entity_type == "user_account"))
    assert row is not None
    assert row.actor_person_id == seeded_user.id
    assert row.changes["accent"] == {"from": None, "to": "aqua"}
