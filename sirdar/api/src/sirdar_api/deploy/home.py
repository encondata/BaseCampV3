"""The bare environment name (demo.serversherpa.com): every environment
that isn't production answers on its base domain with a 302 to its portal,
same path and query. 302, not 301: browsers keep a 301 forever, and
environment names get reused.

It is a pseudo-service row in environment_services (`home`): hostname =
the base domain, host and port the portal's, never proxied by Cloudflare.
It has no container, port or .env key, so it is not in envfile.SERVICES."""

from sirdar_api.deploy import envfile

HOME = "home"
# The services' display and publish order: home right after portal.
SERVICE_ORDER = tuple(name for service in envfile.SERVICES
                      for name in ((service, HOME) if service == "portal" else (service,)))


def wants_home(env) -> bool:
    return env.type != "production"


def home_hostname(env) -> str:
    return env.base_domain


def redirect_target(base_domain: str) -> str:
    """Where the bare name sends a browser (the request URI is appended)."""
    return f"https://portal.{base_domain}"


def nginx_redirect(base_domain: str) -> str:
    """Nginx Proxy Manager's advanced config for the home proxy host. The
    if spares Let's Encrypt's HTTP-01 requests: a bare server-level return
    would answer before NPM's challenge location, and renewals would fail."""
    return ('if ($request_uri !~ "^/\\.well-known/acme-challenge/") {\n'
            f"    return 302 {redirect_target(base_domain)}$request_uri;\n"
            "}")
