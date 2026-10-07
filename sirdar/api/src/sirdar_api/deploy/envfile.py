"""One environment's .env on its target: rendered from Sirdar's record
(pure functions, no I/O) and parsed back when adopting a hand-built
environment. Keys and their order follow deploy/stack/env.example.

Values are written raw (KEY=value, no quotes), exactly as ss-stack and
docker compose read them. Errors name keys, never values."""

import re
import unicodedata
from dataclasses import dataclass, field

ENV_ROOT = "/opt/serversherpa"

SERVICES = ("api", "portal", "kiosk", "wiki", "spaces", "status", "mailpit")
PUBLIC_SERVICES = ("api", "portal", "kiosk", "wiki", "spaces", "status")
DEFAULT_PORTS = {"api": 8000, "portal": 8091, "kiosk": 8090, "wiki": 8096,
                 "spaces": 9000, "status": 8095, "mailpit": 8025}
PORT_KEYS = {s: f"STACK_{s.upper()}_PORT" for s in SERVICES}

REQUIRED_SECRETS = ("POSTGRES_PASSWORD", "SPACES_SECRET_KEY", "SS_JWT_SECRET",
                    "SS_TOTP_ENCRYPTION_KEY", "SS_PASSWORD_PEPPER", "SS_WIKI_SERVICE_TOKEN")
OPTIONAL_SECRETS = ("SS_ANTHROPIC_API_KEY", "SS_DB_TESTING_PASSWORD")
SECRET_KEYS = REQUIRED_SECRETS + OPTIONAL_SECRETS
FERNET_SECRETS = ("SS_TOTP_ENCRYPTION_KEY",)
HEX_SECRETS = tuple(k for k in REQUIRED_SECRETS if k not in FERNET_SECRETS)

LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
DEFAULT_SPACES_BUCKET = "serversherpa"
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_KEEP_DUMPS = 5
PLACEHOLDER = "CHANGEME"

# Extra keys a DigitalOcean droplet's .env carries (deploy phase 7), in the
# order they are written. deploy/stack reads them with defaults, so a .env
# without them still means "local data, NPM on the LAN".
EXTRA_KEYS = (
    "STACK_EXTERNAL_DATA", "STACK_CADDY", "STACK_NETWORK_SUBNET", "STACK_HOSTS_IP",
    "STACK_TRUSTED_PROXIES", "STACK_DB_HOST", "STACK_DB_PORT", "STACK_DB_NAME", "STACK_DB_USER",
    # disable: an app VM's database is a LAN Blue/Green data VM (phase 8b), no TLS
    "STACK_DB_SSLMODE",
    "SS_DATABASE_URL", "SS_DATABASE_SSL", "SS_DATABASE_CA_B64", "SS_SPACES_ENDPOINT",
    "SS_SPACES_REGION", "SS_SPACES_ACCESS_KEY", "SS_SPACES_SECRET_KEY", "SS_SPACES_USE_PATH_STYLE",
    "STACK_DROPLET_ID",
    # the cert-worker (deploy/stack/api/compose.yml, profile certs) reads only these
    "SS_CERT_DO_TOKEN", "SS_CERT_LB_ID", "SS_CERT_NAMES", "SS_CERT_ACME_DIRECTORY",
    "SS_CERT_ACME_KEY",
)

KNOWN_KEYS = (
    "STACK_ENV", "STACK_DOMAIN", "STACK_IMAGE_TAG", "STACK_REPO_DIR", "STACK_PROXY_IP",
    "STACK_BIND_IP", *(PORT_KEYS[s] for s in SERVICES), "STACK_KEEP_DUMPS",
    *REQUIRED_SECRETS, "SS_SPACES_BUCKET", "SS_LOG_LEVEL", *OPTIONAL_SECRETS, *EXTRA_KEYS,
)

_KEY_RE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
# Control characters and the Unicode line/paragraph separators: any of them
# in a value could end the line and inject another key.
_BAD_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})


def env_dir(name: str) -> str:
    return f"{ENV_ROOT}/{name}"


def image_tag(sha: str) -> str:
    """STACK_IMAGE_TAG for a commit: its first 8 hex digits."""
    return sha[:8]


def unsafe_value(value: str) -> bool:
    return any(unicodedata.category(ch) in _BAD_CATEGORIES for ch in value)


class RenderError(Exception):
    """The record can't become a .env. `reason` names keys, never values."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class EnvConfig:
    name: str
    domain: str
    image_tag: str
    proxy_ip: str
    bind_ip: str
    ports: dict[str, int]
    keep_dumps: int
    spaces_bucket: str
    log_level: str
    secrets: dict[str, str] = field(repr=False)
    # EXTRA_KEYS only, written after the optional secrets in this order
    extra: dict[str, str] = field(default_factory=dict, repr=False)


def render_env(cfg: EnvConfig) -> str:
    missing = [k for k in REQUIRED_SECRETS if not cfg.secrets.get(k)]
    if missing:
        raise RenderError(f"missing secrets: {', '.join(missing)}")
    values = {
        "STACK_ENV": cfg.name,
        "STACK_DOMAIN": cfg.domain,
        "STACK_IMAGE_TAG": cfg.image_tag,
        "STACK_REPO_DIR": f"{env_dir(cfg.name)}/repo",
        "STACK_PROXY_IP": cfg.proxy_ip,
        "STACK_BIND_IP": cfg.bind_ip,
        **{PORT_KEYS[s]: str(cfg.ports[s]) for s in SERVICES},
        "STACK_KEEP_DUMPS": str(cfg.keep_dumps),
        **{k: cfg.secrets[k] for k in REQUIRED_SECRETS},
        "SS_SPACES_BUCKET": cfg.spaces_bucket,
        "SS_LOG_LEVEL": cfg.log_level,
        **{k: cfg.secrets.get(k, "") for k in OPTIONAL_SECRETS},
    }
    for key, value in cfg.extra.items():
        if key not in EXTRA_KEYS:
            raise RenderError(f"unknown key {key}")
        values[key] = value
    for key, value in values.items():
        if unsafe_value(value):
            raise RenderError(f"{key} contains a control or line-break character")
        if value == PLACEHOLDER:
            raise RenderError(f"{key} is still {PLACEHOLDER}")
    lines = ["# Written by Sirdar: edits here are replaced on the next deploy.",
             f"# Environment: {cfg.name}",
             *(f"{k}={v}" for k, v in values.items())]
    return "\n".join(lines) + "\n"


# A LAN Blue/Green data VM's .env (deploy phase 8b): the data stacks only, so
# only the database and storage secrets (no JWT secret, pepper, TOTP key or
# wiki token), and the app VMs allowed to reach Postgres.
DATA_KEYS = ("STACK_ENV", "STACK_DOMAIN", "STACK_IMAGE_TAG", "STACK_BIND_IP",
             "STACK_SPACES_PORT", "STACK_MAILPIT_PORT", "STACK_KEEP_DUMPS",
             "POSTGRES_PASSWORD", "SPACES_SECRET_KEY", "SS_SPACES_BUCKET",
             "STACK_DB_PUBLISH", "STACK_DB_PORT", "STACK_DB_ALLOW")
DATA_SECRETS = ("POSTGRES_PASSWORD", "SPACES_SECRET_KEY")
_OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
_IPV4_RE = re.compile(rf"{_OCTET}(\.{_OCTET}){{3}}")


@dataclass(frozen=True)
class DataEnvConfig:
    name: str
    domain: str
    bind_ip: str
    spaces_port: int
    mailpit_port: int
    keep_dumps: int
    spaces_bucket: str
    db_port: int
    allow: tuple[str, ...]
    secrets: dict[str, str] = field(repr=False)


def render_data_env(cfg: DataEnvConfig) -> str:
    missing = [k for k in DATA_SECRETS if not cfg.secrets.get(k)]
    if missing:
        raise RenderError(f"missing secrets: {', '.join(missing)}")
    if not cfg.allow or not all(_IPV4_RE.fullmatch(ip) for ip in cfg.allow):
        raise RenderError("STACK_DB_ALLOW must be IPv4 addresses")
    for key, port in (("STACK_SPACES_PORT", cfg.spaces_port),
                      ("STACK_MAILPIT_PORT", cfg.mailpit_port), ("STACK_DB_PORT", cfg.db_port)):
        if type(port) is not int or not 1 <= port <= 65535:
            raise RenderError(f"{key} must be a port number, 1-65535")
    values = {
        "STACK_ENV": cfg.name, "STACK_DOMAIN": cfg.domain, "STACK_IMAGE_TAG": "data",
        "STACK_BIND_IP": cfg.bind_ip, "STACK_SPACES_PORT": str(cfg.spaces_port),
        "STACK_MAILPIT_PORT": str(cfg.mailpit_port), "STACK_KEEP_DUMPS": str(cfg.keep_dumps),
        **{k: cfg.secrets[k] for k in DATA_SECRETS},
        "SS_SPACES_BUCKET": cfg.spaces_bucket, "STACK_DB_PUBLISH": "1",
        "STACK_DB_PORT": str(cfg.db_port), "STACK_DB_ALLOW": ",".join(cfg.allow),
    }
    for key, value in values.items():
        if unsafe_value(value):
            raise RenderError(f"{key} contains a control or line-break character")
        if value == PLACEHOLDER:
            raise RenderError(f"{key} is still {PLACEHOLDER}")
    lines = ["# Written by Sirdar: edits here are replaced on the next deploy.",
             f"# Environment: {cfg.name} (data VM)", *(f"{k}={v}" for k, v in values.items())]
    return "\n".join(lines) + "\n"


def parse_env(text: str) -> dict[str, str]:
    """KEY=value lines (KEY uppercase, at the start of the line); the last
    assignment wins and one pair of surrounding quotes is dropped, as
    ss-stack's env_value does. Comments, blanks and other lines are ignored."""
    values: dict[str, str] = {}
    for line in text.split("\n"):
        m = _KEY_RE.match(line.removesuffix("\r"))
        if not m:
            continue
        value = m.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[m.group(1)] = value
    return values
