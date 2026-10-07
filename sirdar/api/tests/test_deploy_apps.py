"""deploy/apps.py: which optional apps run, where mail goes, and the .env
keys both render to."""

import pytest
from types import SimpleNamespace

from sirdar_api.deploy import apps, envfile


def test_check_apps():
    assert apps.check_apps(None) == ["wiki", "kiosk", "status", "mailpit"]
    assert apps.check_apps(["mailpit", "wiki"]) == ["wiki", "mailpit"]      # canonical order
    assert apps.check_apps([]) == []
    for bad in (["api"], "wiki", [1], ["wiki", "nope"]):
        with pytest.raises(apps.AppsError) as e:
            apps.check_apps(bad)
        assert e.value.code == "apps_invalid"


def test_mailpit_mail_needs_mailpit():
    assert apps.check_mail(None, ["mailpit"])["smtp_host"] is None
    with pytest.raises(apps.AppsError) as e:
        apps.check_mail({"mode": "mailpit"}, ["wiki"])
    assert e.value.code == "mailpit_required"


SMTP = {"mode": "smtp", "host": "smtp.example.com", "port": 587, "username": "mailer",
        "password": "Mail-Secret-1", "from_address": "ops@example.com", "starttls": True}


def test_smtp_mail():
    assert apps.check_mail(SMTP, []) == {
        "smtp_host": "smtp.example.com", "smtp_port": 587, "smtp_username": "mailer",
        "smtp_from": "ops@example.com", "smtp_starttls": True, "smtp_password": "Mail-Secret-1"}
    plain = apps.check_mail({**SMTP, "username": None, "password": None, "port": None}, [])
    assert (plain["smtp_port"], plain["smtp_username"], plain["smtp_password"]) == (
        apps.DEFAULT_SMTP_PORT, None, None)


@pytest.mark.parametrize("change, code", [
    ({"mode": "fax"}, "mail_invalid"),
    ({"host": ""}, "smtp_host_invalid"),
    ({"host": "smtp example.com"}, "smtp_host_invalid"),
    ({"port": 0}, "smtp_port_invalid"),
    ({"port": True}, "smtp_port_invalid"),
    ({"username": "has space"}, "smtp_username_invalid"),
    ({"password": "has space"}, "smtp_password_invalid"),
    ({"password": "dollar$sign"}, "smtp_password_invalid"),
    ({"from_address": "nope"}, "smtp_from_invalid"),
    ({"from_address": "ops$x@example.com"}, "smtp_from_invalid"),
    ({"from_address": "o\"ps@example.com"}, "smtp_from_invalid"),
    ({"from_address": "o'ps@example.com"}, "smtp_from_invalid"),
    ({"from_address": "o`ps@example.com"}, "smtp_from_invalid"),
    ({"from_address": "o#ps@example.com"}, "smtp_from_invalid"),
    ({"from_address": "o\\ps@example.com"}, "smtp_from_invalid"),
    ({"from_address": "ops@exa mple.com"}, "smtp_from_invalid"),
    ({"from_address": "ops@example.com\x00"}, "smtp_from_invalid"),
    ({"from_address": "o\x7fps@example.com"}, "smtp_from_invalid"),
    ({"from_address": "ops@example\u2028.com"}, "smtp_from_invalid"),
    ({"starttls": "yes"}, "mail_invalid"),
])
def test_smtp_refusals(change, code):
    with pytest.raises(apps.AppsError) as e:
        apps.check_mail({**SMTP, **change}, [])
    assert e.value.code == code
    assert "Mail-Secret-1" not in str(e.value)


def test_public_services_follow_the_apps():
    assert apps.public_services(["wiki", "kiosk", "status", "mailpit"]) == envfile.PUBLIC_SERVICES
    assert apps.public_services([]) == ("api", "portal", "spaces")
    assert apps.public_services(["status"], base=("api", "portal", "kiosk", "wiki", "status")) == (
        "api", "portal", "status")


def test_env_extra():
    env = SimpleNamespace(apps=["kiosk"], smtp_host=None, smtp_port=None, smtp_username=None,
                          smtp_from=None, smtp_starttls=True)
    assert apps.env_extra(env) == {"STACK_APPS": "kiosk"}
    env = SimpleNamespace(apps=[], smtp_host="smtp.example.com", smtp_port=587,
                          smtp_username=None, smtp_from="ops@example.com", smtp_starttls=False)
    assert apps.env_extra(env) == {
        "STACK_APPS": "none", "SS_SMTP_HOST": "smtp.example.com", "SS_SMTP_PORT": "587",
        "SS_SMTP_USERNAME": "", "SS_SMTP_STARTTLS": "false", "SS_SMTP_FROM": "ops@example.com"}
    assert set(apps.env_extra(env)) <= set(envfile.EXTRA_KEYS)


def test_is_public():
    env = SimpleNamespace(apps=["kiosk", "mailpit"])
    assert [s for s in envfile.PUBLIC_SERVICES if apps.is_public(env, s)] == [
        "api", "portal", "kiosk", "spaces"]
    assert apps.is_public(SimpleNamespace(apps=list(apps.OPTIONAL_APPS)), "wiki")


def test_an_environment_with_nothing_chosen_runs_every_app_on_mailpit():
    """Existing environments (migration 0013's defaults): every app, Mailpit,
    and no SS_SMTP_* keys (compose keeps its Mailpit defaults)."""
    env = SimpleNamespace(apps=list(apps.OPTIONAL_APPS), smtp_host=None, smtp_port=None,
                          smtp_username=None, smtp_from=None, smtp_starttls=True)
    assert apps.env_extra(env) == {"STACK_APPS": "wiki,kiosk,status,mailpit"}
    assert apps.public(env, password_set=False) == {
        "mode": "mailpit", "host": None, "port": None, "username": None,
        "from_address": None, "starttls": True, "password_set": False}


def test_smtp_writes_port_and_starttls_with_the_host():
    """compose's defaults (1025, false) are Mailpit's: with a host, both are
    always written, even at ServerSherpa's own defaults (587, true)."""
    env = SimpleNamespace(apps=["mailpit"], smtp_host="smtp.example.com", smtp_port=587,
                          smtp_username="mailer", smtp_from="ops@example.com",
                          smtp_starttls=True)
    out = apps.env_extra(env)
    assert (out["SS_SMTP_PORT"], out["SS_SMTP_STARTTLS"]) == ("587", "true")


def test_mail_errors_never_carry_the_password():
    for change in ({"host": None}, {"port": "x"}, {"from_address": None}):
        with pytest.raises(apps.AppsError) as e:
            apps.check_mail({**SMTP, **change}, [])
        assert "Mail-Secret-1" not in repr(e.value) + str(e.value.extra)
