"""The bare environment name (deploy/home.py): which environments get it,
its name, where it redirects, and the order it sorts in."""

from types import SimpleNamespace

from sirdar_api.deploy import certs, envfile, home


def _env(type_: str = "dev", domain: str = "demo.serversherpa.com"):
    return SimpleNamespace(type=type_, base_domain=domain,
                           apps=["wiki", "kiosk", "status", "mailpit"])


def test_every_type_but_production_gets_the_bare_name():
    assert [t for t in ("dev", "beta", "custom", "production") if home.wants_home(_env(t))] == [
        "dev", "beta", "custom"]


def test_name_and_target():
    env = _env()
    assert home.home_hostname(env) == "demo.serversherpa.com"
    assert home.redirect_target(env.base_domain) == "https://portal.demo.serversherpa.com"


def test_home_sorts_right_after_portal_and_is_not_a_stack_service():
    assert home.SERVICE_ORDER == ("api", "portal", "home", "kiosk", "wiki", "spaces", "status",
                                  "mailpit")
    assert home.HOME not in envfile.SERVICES


def test_the_nginx_redirect_spares_acme_challenges():
    assert home.nginx_redirect("demo.serversherpa.com") == (
        'if ($request_uri !~ "^/\\.well-known/acme-challenge/") {\n'
        "    return 302 https://portal.demo.serversherpa.com$request_uri;\n"
        "}")


def test_droplet_names_end_with_the_bare_name_except_on_production():
    assert certs.public_names(_env()) == (
        "api.demo.serversherpa.com", "portal.demo.serversherpa.com",
        "kiosk.demo.serversherpa.com", "wiki.demo.serversherpa.com",
        "status.demo.serversherpa.com", "demo.serversherpa.com")
    assert certs.public_hosts(_env())[-1] == ("home", "demo.serversherpa.com")
    assert "demo.serversherpa.com" not in certs.public_names(_env("production"))
    off = SimpleNamespace(type="dev", base_domain="demo.serversherpa.com", apps=["mailpit"])
    assert certs.public_names(off) == ("api.demo.serversherpa.com",
                                       "portal.demo.serversherpa.com", "demo.serversherpa.com")
