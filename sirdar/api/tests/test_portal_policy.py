from datetime import UTC, datetime, timedelta

from sirdar_api.services.portal_policy import password_expires_at, totp_policy


def test_totp_policy_switch_off_means_nothing():
    p = totp_policy({}, account_required=True, in_totp_group=True, has_totp_role=True)
    assert (p.enabled, p.required) == (False, False)


def test_totp_policy_required_by_any_source():
    on = {"two_factor_enabled": True}
    assert totp_policy(on, account_required=False, in_totp_group=False,
                       has_totp_role=False).required is False
    assert totp_policy({**on, "two_factor_required": True}, account_required=False,
                       in_totp_group=False, has_totp_role=False).required
    for kw in ({"account_required": True}, {"in_totp_group": True}, {"has_totp_role": True}):
        args = {"account_required": False, "in_totp_group": False, "has_totp_role": False, **kw}
        assert totp_policy(on, **args).required


def test_password_expiry():
    since = datetime(2026, 1, 1, tzinfo=UTC)
    cfg = {"password_expiry_enabled": True, "password_expiry_days": 90,
           "password_expiry_since": since.isoformat()}
    assert password_expires_at({}, "h", None) is None
    assert password_expires_at({**cfg, "password_expiry_since": None}, "h", None) is None
    assert password_expires_at(cfg, None, None) is None
    assert password_expires_at(cfg, "h", None) == since + timedelta(days=90)
    later = datetime(2026, 3, 1, tzinfo=UTC)
    assert password_expires_at(cfg, "h", later) == later + timedelta(days=90)
    earlier = datetime(2025, 6, 1, tzinfo=UTC)
    assert password_expires_at(cfg, "h", earlier) == since + timedelta(days=90)
