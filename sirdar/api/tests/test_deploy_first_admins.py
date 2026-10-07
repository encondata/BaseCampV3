"""deploy/first_admins.py: the first super admin a fresh environment gets
on its first deploy. A typed password is vault-encrypted until step 11 has
used it; an invite has none."""

import pytest
from sqlalchemy import select

from sirdar_api.config import get_settings
from sirdar_api.db.models import EnvironmentFirstAdmin
from sirdar_api.deploy import first_admins, vault
from sirdar_api.services import portal_policy

from .deploy_factories import make_environment, secrets_key  # noqa: F401

TYPED = "Correct-Horse-Battery-9"
GOOD = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example.com",
        "password_mode": "typed", "password": TYPED}


def test_check_accepts_typed_and_invite():
    assert first_admins.check(GOOD) == GOOD
    invite = {**GOOD, "password_mode": "invite", "password": None}
    assert first_admins.check(invite) == invite
    assert first_admins.check({**GOOD, "first_name": "  Ada "})["first_name"] == "Ada"


@pytest.mark.parametrize("change, code", [
    ({"first_name": ""}, "first_admin_name_invalid"),
    ({"last_name": "x" * 101}, "first_admin_name_invalid"),
    ({"first_name": "A\nB"}, "first_admin_name_invalid"),
    ({"email": "not-an-email"}, "first_admin_email_invalid"),
    ({"email": "a@b"}, "first_admin_email_invalid"),
    # The portal's login (pydantic EmailStr) refuses special-use domains, so
    # an account created with one could never sign in.
    ({"email": "admin@corp.local"}, "first_admin_email_invalid"),
    ({"email": "admin@lab.test"}, "first_admin_email_invalid"),
    ({"email": "admin@localhost"}, "first_admin_email_invalid"),
    ({"password": "x" * (portal_policy.PASSWORD_MIN_LENGTH - 1)},
     "first_admin_password_too_short"),
    ({"password": None}, "first_admin_password_too_short"),
    ({"password": "Long-enough\npassword"}, "first_admin_password_invalid"),
    ({"password": " " * (portal_policy.PASSWORD_MIN_LENGTH + 4)},
     "first_admin_password_too_short"),
    ({"password": "\t" * portal_policy.PASSWORD_MIN_LENGTH}, "first_admin_password_too_short"),
    ({"password_mode": "invite"}, "first_admin_password_not_allowed"),
    ({"password_mode": "sms"}, "first_admin_invalid"),
])
def test_check_refusals(change, code):
    with pytest.raises(first_admins.FirstAdminError) as e:
        first_admins.check({**GOOD, **change})
    assert e.value.code == code
    if code == "first_admin_password_too_short":
        assert e.value.extra == {"min_length": portal_policy.PASSWORD_MIN_LENGTH}
    assert TYPED not in str(e.value) and TYPED not in repr(e.value)


async def test_put_encrypts_and_public_hides_the_password(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    row = await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    assert TYPED.encode() not in bytes(row.password_enc)
    assert vault.decrypt(get_settings(), row.password_enc) == TYPED
    assert first_admins.public(row) == {"first_name": "Ada", "last_name": "Lovelace",
                                        "email": "ada@test.example.com",
                                        "password_mode": "typed", "done": False}
    # Nothing that leaves the module carries the password; the stored
    # ciphertext is what step_vars decrypts.
    assert TYPED not in repr(first_admins.public(row))
    stored = await db.scalar(select(EnvironmentFirstAdmin.password_enc).where(
        EnvironmentFirstAdmin.environment_id == env.id))
    assert bytes(stored) == bytes(row.password_enc)
    values, redact = await first_admins.step_vars(db, get_settings(), env.id)
    assert values["admin_password"] == vault.decrypt(get_settings(), stored) == TYPED
    assert redact == [TYPED]
    assert await first_admins.pending(db, env.id) is True


async def test_step_vars_and_mark_done(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    values, redact = await first_admins.step_vars(db, get_settings(), env.id)
    assert values == {"admin_email": "ada@test.example.com", "admin_first_name": "Ada",
                      "admin_last_name": "Lovelace", "admin_role": "super_admin",
                      "admin_invite": False, "admin_password": TYPED,
                      "admin_link_minutes": 240}
    assert redact == [TYPED]
    await first_admins.mark_done(db, env.id)
    await db.commit()
    row = await db.get(EnvironmentFirstAdmin, env.id, populate_existing=True)
    assert row.password_enc is None and row.done_at is not None
    assert await first_admins.pending(db, env.id) is False
    assert first_admins.public(row)["done"] is True


async def test_an_invite_has_no_password_var(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(
        {**GOOD, "password_mode": "invite", "password": None}))
    await db.commit()
    values, redact = await first_admins.step_vars(db, get_settings(), env.id)
    assert values["admin_invite"] is True and values["admin_password"] == ""
    assert redact == []


async def test_the_row_goes_with_its_environment(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    await db.delete(env)
    await db.commit()
    assert await db.scalar(select(EnvironmentFirstAdmin)) is None


def test_exit_codes_and_copy():
    assert first_admins.exit_code({"first_admin_rc": "3"}) == 3
    assert first_admins.exit_code({}) == -1
    assert first_admins.exit_code({"first_admin_rc": "x"}) == -1
    assert "password policy" in first_admins.refusal(3)
    assert "exit 2" in first_admins.refusal(2) and "newer one" in first_admins.refusal(2)
    assert "email address" in first_admins.refusal(8) \
        and "step 11" in first_admins.refusal(8)
    assert "SMTP" in first_admins.refusal(5)
    assert "super_admin" in first_admins.refusal(4)
    assert "exit 9" in first_admins.refusal(9)


async def test_put_replaces_a_pending_row(db, secrets_key):
    """PUT …/first-admin before step 11 ran: the row is replaced in place."""
    env = await make_environment(db, name="fresh", secrets={})
    first = await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await db.commit()
    old_enc = bytes(first.password_enc)
    new_password = "Another-Long-Password-4"
    await first_admins.put(db, get_settings(), env.id, first_admins.check(
        {**GOOD, "first_name": "Grace", "password": new_password}))
    await db.commit()
    rows = (await db.scalars(select(EnvironmentFirstAdmin))).all()
    assert len(rows) == 1
    assert rows[0].first_name == "Grace" and bytes(rows[0].password_enc) != old_enc
    assert vault.decrypt(get_settings(), rows[0].password_enc) == new_password
    # Switching to an invite drops the stored password.
    await first_admins.put(db, get_settings(), env.id, first_admins.check(
        {**GOOD, "password_mode": "invite", "password": None}))
    await db.commit()
    row = await first_admins.get(db, env.id)
    assert row.password_mode == "invite" and row.password_enc is None
    assert await first_admins.pending(db, env.id) is True


async def test_put_refuses_once_done(db, secrets_key):
    """After step 11 a new password would be stored with nothing to use or
    clear it, so put refuses and leaves the row as it is."""
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await first_admins.mark_done(db, env.id)
    await db.commit()
    with pytest.raises(first_admins.FirstAdminError) as e:
        await first_admins.put(db, get_settings(), env.id, first_admins.check(
            {**GOOD, "password": "Another-Long-Password-4"}))
    assert e.value.code == "first_admin_done"
    env_id = env.id
    await db.rollback()
    enc, done_at = (await db.execute(select(
        EnvironmentFirstAdmin.password_enc, EnvironmentFirstAdmin.done_at).where(
        EnvironmentFirstAdmin.environment_id == env_id))).one()
    assert enc is None and done_at is not None


async def test_step_vars_after_done_is_empty(db, secrets_key):
    env = await make_environment(db, name="fresh", secrets={})
    await first_admins.put(db, get_settings(), env.id, first_admins.check(GOOD))
    await first_admins.mark_done(db, env.id)
    await db.commit()
    assert await first_admins.step_vars(db, get_settings(), env.id) == ({}, [])
    assert await first_admins.step_vars(db, get_settings(), env.id) == ({}, [])


@pytest.mark.parametrize("email", ["admin@corp.lan", "admin@example.com",
                                   "first.last+ops@mail.example.org"])
def test_check_accepts_what_the_portal_login_accepts(email):
    assert first_admins.check({**GOOD, "email": email})["email"] == email


def test_check_matches_the_portals_email_type():
    """The same verdict as pydantic's EmailStr, which the portal's LoginIn uses."""
    from pydantic import EmailStr, TypeAdapter, ValidationError
    adapter = TypeAdapter(EmailStr)
    for email in ["admin@corp.local", "admin@lab.test", "admin@corp.lan", "a@b.co",
                  "admin@example.invalid", "x@[127.0.0.1]"]:
        try:
            adapter.validate_python(email)
            portal_ok = True
        except ValidationError:
            portal_ok = False
        try:
            first_admins.check({**GOOD, "email": email})
            ours = True
        except first_admins.FirstAdminError:
            ours = False
        assert ours == portal_ok, email
