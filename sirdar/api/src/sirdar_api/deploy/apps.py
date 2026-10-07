"""Which apps an environment runs and where its mail goes (deploy phase 8c).
API and portal always run; wiki, kiosk, status and mailpit can be turned off
when the environment is created. Mail goes to the environment's own Mailpit
(nothing leaves the host) or to an SMTP server: ServerSherpa reads SMTP only
from its environment (SS_SMTP_* in api/src/serversherpa/config.py), so Sirdar
writes it into the .env. The SMTP password is the optional secret
SS_SMTP_PASSWORD, vault-encrypted like the others and never returned."""

import re

from sirdar_api.deploy import envfile

OPTIONAL_APPS = ("wiki", "kiosk", "status", "mailpit")
ALWAYS = ("api", "portal")
_PUBLIC_APPS = ("wiki", "kiosk", "status")          # their public names go when they're off
DEFAULT_SMTP_PORT = 587                             # ServerSherpa's smtp_port default
_HOST_RE = re.compile(r"(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}")
_USER_RE = re.compile(r"[^\s\"'$#`\\]{1,254}")


class AppsError(Exception):
    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def check_apps(value) -> list[str]:
    if value is None:
        return list(OPTIONAL_APPS)
    if (not isinstance(value, list) or not all(isinstance(a, str) for a in value)
            or set(value) - set(OPTIONAL_APPS)):
        raise AppsError("apps_invalid")
    return [a for a in OPTIONAL_APPS if a in value]


def check_mail(value, apps_on: list[str]) -> dict:
    """The mail settings create stores: all None (and STARTTLS on) for Mailpit."""
    value = value or {}
    if not isinstance(value, dict):
        raise AppsError("mail_invalid")
    mode = value.get("mode", "mailpit")
    if mode == "mailpit":
        if "mailpit" not in apps_on:
            raise AppsError("mailpit_required")
        return {"smtp_host": None, "smtp_port": None, "smtp_username": None, "smtp_from": None,
                "smtp_starttls": True, "smtp_password": None}
    if mode != "smtp":
        raise AppsError("mail_invalid")
    host = value.get("host")
    if not isinstance(host, str) or not _HOST_RE.fullmatch(host.strip()):
        raise AppsError("smtp_host_invalid")
    port = value.get("port")
    port = DEFAULT_SMTP_PORT if port is None else port
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise AppsError("smtp_port_invalid")
    username = value.get("username") or None
    if username is not None and (not isinstance(username, str) or not _USER_RE.fullmatch(username)):
        raise AppsError("smtp_username_invalid")
    password = value.get("password") or None
    if password is not None and (not isinstance(password, str)
                                 or not envfile.SECRET_VALUE_RE.fullmatch(password)):
        raise AppsError("smtp_password_invalid")
    sender = value.get("from_address")
    if not isinstance(sender, str) or not _EMAIL_RE.fullmatch(sender.strip()):
        raise AppsError("smtp_from_invalid")
    starttls = value.get("starttls", True)
    if not isinstance(starttls, bool):
        raise AppsError("mail_invalid")
    return {"smtp_host": host.strip(), "smtp_port": port, "smtp_username": username,
            "smtp_from": sender.strip(), "smtp_starttls": starttls, "smtp_password": password}


def public_services(apps_on: list[str], base: tuple[str, ...] = envfile.PUBLIC_SERVICES
                    ) -> tuple[str, ...]:
    return tuple(s for s in base if s not in _PUBLIC_APPS or s in apps_on)


def is_public(env, service: str) -> bool:
    return service not in _PUBLIC_APPS or service in (env.apps or ())


def env_extra(env) -> dict[str, str]:
    out = {"STACK_APPS": ",".join(env.apps) if env.apps else "none"}
    if env.smtp_host:
        out |= {"SS_SMTP_HOST": env.smtp_host, "SS_SMTP_PORT": str(env.smtp_port),
                "SS_SMTP_USERNAME": env.smtp_username or "",
                "SS_SMTP_STARTTLS": "true" if env.smtp_starttls else "false",
                "SS_SMTP_FROM": env.smtp_from}
    return out


def public(env, *, password_set: bool) -> dict:
    if not env.smtp_host:
        return {"mode": "mailpit", "host": None, "port": None, "username": None,
                "from_address": None, "starttls": True, "password_set": False}
    return {"mode": "smtp", "host": env.smtp_host, "port": env.smtp_port,
            "username": env.smtp_username, "from_address": env.smtp_from,
            "starttls": env.smtp_starttls, "password_set": password_set}
