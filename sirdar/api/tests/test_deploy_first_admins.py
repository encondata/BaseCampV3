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
    ({"password": "x" * (portal_policy.PASSWORD_MIN_LENGTH - 1)},
     "first_admin_password_too_short"),
    ({"password": None}, "first_admin_password_too_short"),
    ({"password": "Long-enough\npassword"}, "first_admin_password_invalid"),
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
    assert TYPED not in repr(row)
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
    assert "newer commit" in first_admins.refusal(2)
    assert "SMTP" in first_admins.refusal(5)
    assert "super_admin" in first_admins.refusal(4)
    assert "exit 9" in first_admins.refusal(9)
