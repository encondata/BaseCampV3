"""Rules every rendered stack must follow (docker compose config, so
interpolation and anchors are resolved exactly as on a target)."""
from __future__ import annotations

import json
import os
import subprocess
from functools import cache
from typing import Any

import pytest

from conftest import ENV_EXAMPLE, STACK_DIR, docker_cli_ok, readme_restore_commands

pytestmark = pytest.mark.skipif(not docker_cli_ok(), reason="docker CLI not available")

STACKS = ("db", "storage", "api", "web", "devices", "status")
ENV = "uat"                      # STACK_ENV in env.example
DOMAIN = "uat.serversherpa.com"  # STACK_DOMAIN in env.example
PROXY_IP = "10.0.0.2"            # STACK_PROXY_IP in env.example
TAG = "local"                    # STACK_IMAGE_TAG in env.example
PUBLIC = ("api", "portal", "kiosk", "wiki", "learn", "spaces", "status", "devices")
WORKERS = {
    "import-worker": ["serversherpa", "import-worker"],
    "log-service": ["serversherpa", "log-service"],
    "notification-worker": ["serversherpa", "notification-worker"],
    "scan-matching-worker": ["serversherpa", "scan-matching-worker"],
    "report-worker": ["serversherpa", "report-worker"],
    "label-worker": ["serversherpa", "label-worker"],
    "spec-lookup-worker": ["serversherpa", "spec-lookup-worker"],
    "db-testing-worker": ["serversherpa", "db-testing-worker"],
    "wiki-worker": ["serversherpa", "wiki-worker", "--exclude-kinds", "export"],
    "wiki-export-worker": ["serversherpa", "wiki-worker", "--kinds", "export"],
}


@cache
def rendered(stack: str) -> dict[str, Any]:
    path = STACK_DIR / "build.yml" if stack == "build" else STACK_DIR / stack / "compose.yml"
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(ENV_EXAMPLE), "-f", str(path),
         "--profile", "jobs", "config", "--format", "json"],
        capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def published(service: dict[str, Any]) -> list[int]:
    return [int(p["published"]) for p in service.get("ports", [])]


def extra_hosts(service: dict[str, Any]) -> dict[str, str]:
    raw = service.get("extra_hosts", [])
    if isinstance(raw, dict):
        return {k: v[0] if isinstance(v, list) else v for k, v in raw.items()}
    pairs = {}
    for entry in raw:
        sep = "=" if "=" in entry else ":"
        host, ip = entry.split(sep, 1)
        pairs[host] = ip
    return pairs


@pytest.mark.parametrize("stack", STACKS)
def test_project_is_named_for_the_environment(stack: str) -> None:
    assert rendered(stack)["name"] == f"ss-{ENV}-{stack}"


@pytest.mark.parametrize("stack", STACKS)
def test_every_service_joins_the_environment_network(stack: str) -> None:
    cfg = rendered(stack)
    assert cfg["networks"]["default"]["name"] == f"ss-{ENV}"
    assert cfg["networks"]["default"]["external"] is True


@pytest.mark.parametrize("stack", STACKS)
def test_published_services_have_healthchecks(stack: str) -> None:
    for name, svc in rendered(stack)["services"].items():
        if svc.get("ports"):
            assert "healthcheck" in svc, f"{stack}/{name} publishes a port without a healthcheck"


def test_default_published_ports() -> None:
    ports = {name: published(svc)
             for stack in STACKS
             for name, svc in rendered(stack)["services"].items()
             if svc.get("ports")}
    assert ports == {"api": [8000], "portal": [8091], "kiosk": [8090], "wiki": [8096],
                     "learn": [8092], "seaweedfs": [9000], "status": [8095], "mailpit": [8025],
                     "devices": [8093]}


def test_postgres_is_16_and_unpublished() -> None:
    pg = rendered("db")["services"]["postgres"]
    assert pg["image"] == "postgres:16-alpine"
    assert not pg.get("ports")


def test_api_stack_runs_every_worker() -> None:
    services = rendered("api")["services"]
    assert set(services) == {"migrate", "api", *WORKERS}
    for name, command in WORKERS.items():
        assert services[name]["command"] == command
        assert services[name]["restart"] == "unless-stopped"


@pytest.mark.parametrize("stack,service", [("api", "migrate")])
def test_one_shot_jobs_live_in_the_jobs_profile(stack: str, service: str) -> None:
    assert rendered(stack)["services"][service]["profiles"] == ["jobs"]


def test_migrate_runs_alembic_from_the_image() -> None:
    migrate = rendered("api")["services"]["migrate"]
    assert migrate["command"] == ["alembic", "upgrade", "head"]
    assert migrate["working_dir"] == "/app/api"


def test_runtime_images_are_tagged_and_never_built() -> None:
    for stack in ("api", "web", "devices", "status"):
        for name, svc in rendered(stack)["services"].items():
            assert "build" not in svc, f"{stack}/{name} builds; only build.yml may"
            assert svc["image"].endswith(f":{TAG}"), f"{stack}/{name}: {svc['image']}"


def test_build_file_builds_exactly_the_runtime_images() -> None:
    built = {svc["image"] for svc in rendered("build")["services"].values()}
    used = {svc["image"]
            for stack in ("api", "web", "devices", "status")
            for svc in rendered(stack)["services"].values()}
    assert built == used == {f"serversherpa-{x}:{TAG}"
                             for x in ("api", "portal", "kiosk", "wiki", "learn", "status",
                                       "devices")}


@pytest.mark.parametrize("stack,service", [("api", "api"), ("api", "report-worker"),
                                           ("api", "wiki-export-worker"), ("status", "status"),
                                           ("devices", "devices"), ("devices", "devices-worker")])
def test_public_names_resolve_to_the_proxy(stack: str, service: str) -> None:
    hosts = extra_hosts(rendered(stack)["services"][service])
    assert hosts == {f"{name}.{DOMAIN}": PROXY_IP for name in PUBLIC}


def test_api_environment_covers_every_required_setting() -> None:
    from serversherpa.config import Settings
    env = rendered("api")["services"]["api"]["environment"]
    required = {f"SS_{n.upper()}" for n, f in Settings.model_fields.items() if f.is_required()}
    assert required - set(env) == set()


def test_api_environment_has_no_unknown_ss_keys() -> None:
    from serversherpa.config import Settings
    env = rendered("api")["services"]["api"]["environment"]
    known = {f"SS_{n.upper()}" for n in Settings.model_fields}
    assert {k for k in env if k.startswith("SS_")} - known == set()


def test_api_environment_points_at_the_stack() -> None:
    env = rendered("api")["services"]["api"]["environment"]
    assert env["SS_ENV"] == "staging"
    assert env["SS_API_BASE_URL"] == f"https://api.{DOMAIN}"
    assert env["SS_PORTAL_ORIGIN"] == f"https://portal.{DOMAIN}"
    assert env["SS_WIKI_ORIGIN"] == f"https://wiki.{DOMAIN}"
    assert env["SS_LEARN_ORIGIN"] == f"https://learn.{DOMAIN}"
    assert env["SS_SPACES_ENDPOINT"] == f"https://spaces.{DOMAIN}"
    assert env["SS_SPACES_USE_PATH_STYLE"] == "true"
    assert env["SS_SMTP_HOST"] == "mailpit"
    assert env["SS_DATABASE_SSL"] == "disable"
    # a droplet's .env sets the managed database's CA; a local stack has none
    assert env["SS_DATABASE_CA_B64"] == ""
    assert env["SS_DATABASE_URL"].endswith("@postgres:5432/serversherpa")
    assert env["SS_WIKI_RENDER_URL"] == "http://wiki:8080"
    assert env["SS_DEVICES_ORIGIN"] == f"https://devices.{DOMAIN}"
    assert set(env["SS_ALLOWED_ORIGINS"].split(",")) == {
        f"https://{n}.{DOMAIN}" for n in ("portal", "kiosk", "wiki", "learn", "devices")}


def test_api_trusts_forwarded_headers_only_from_the_proxy() -> None:
    # uvicorn reads FORWARDED_ALLOW_IPS when --forwarded-allow-ips is absent
    env = rendered("api")["services"]["api"]["environment"]
    assert env["FORWARDED_ALLOW_IPS"] == PROXY_IP
    assert "--forwarded-allow-ips" not in (rendered("api")["services"]["api"].get("command") or [])


def test_every_worker_shares_the_api_environment() -> None:
    services = rendered("api")["services"]
    for name in ("migrate", *WORKERS):
        assert services[name]["environment"] == services["api"]["environment"], name


def test_web_apps_point_at_the_stack() -> None:
    web = rendered("web")["services"]
    assert web["kiosk"]["environment"]["KIOSK_API_URL"] == f"https://api.{DOMAIN}"
    assert web["kiosk"]["environment"]["KIOSK_PORTAL_URL"] == f"https://portal.{DOMAIN}"
    assert web["wiki"]["environment"]["WIKI_API_URL"] == "http://api:8000"
    assert web["learn"]["environment"]["LEARN_API_URL"] == f"https://api.{DOMAIN}"
    status = rendered("status")["services"]["status"]["environment"]
    assert status["STATUS_API_URL"] == f"https://api.{DOMAIN}"
    assert status["STATUS_PUBLIC_URL"] == f"https://status.{DOMAIN}"


@pytest.mark.parametrize("given, kiosk, wiki, learn", [
    ({}, f"https://kiosk.{DOMAIN}", f"https://wiki.{DOMAIN}", f"https://learn.{DOMAIN}"),
    ({"STATUS_KIOSK_URL": "", "STATUS_WIKI_URL": "", "STATUS_LEARN_URL": ""}, "", "", ""),
])
def test_the_status_page_targets_follow_ss_stack(given: dict[str, str], kiosk: str,
                                                 wiki: str, learn: str) -> None:
    """ss-stack sets STATUS_KIOSK_URL / STATUS_WIKI_URL / STATUS_LEARN_URL
    empty for an app that is off (STACK_APPS); unset, each is the app's
    public URL."""
    env = {k: v for k, v in os.environ.items()
           if k not in ("STATUS_KIOSK_URL", "STATUS_WIKI_URL", "STATUS_LEARN_URL")}
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(ENV_EXAMPLE), "-f",
         str(STACK_DIR / "status" / "compose.yml"), "config", "--format", "json"],
        capture_output=True, text=True, env={**env, **given})
    assert out.returncode == 0, out.stderr
    status = json.loads(out.stdout)["services"]["status"]["environment"]
    assert (status["STATUS_KIOSK_URL"], status["STATUS_WIKI_URL"],
            status["STATUS_LEARN_URL"]) == (kiosk, wiki, learn)


def test_env_example_secrets_are_placeholders() -> None:
    lines = dict(line.split("=", 1) for line in ENV_EXAMPLE.read_text().splitlines()
                 if line and not line.startswith("#"))
    for key in ("POSTGRES_PASSWORD", "SPACES_SECRET_KEY", "SS_JWT_SECRET",
                "SS_TOTP_ENCRYPTION_KEY", "SS_PASSWORD_PEPPER", "SS_WIKI_SERVICE_TOKEN"):
        assert lines[key] == "CHANGEME", key


def test_env_example_leaves_the_devices_secrets_commented() -> None:
    """Needed only when the devices app runs (ss-stack checks); a .env
    without them (Sirdar's, an existing one) keeps working with it off."""
    text = ENV_EXAMPLE.read_text().splitlines()
    for key in ("SS_DEVICES_SERVICE_TOKEN", "DEVICES_SECRET_KEY", "DEVICES_IOS_OWNER_URL"):
        assert f"# {key}=" in text, key
        assert not any(line.startswith(f"{key}=") for line in text), key


def test_storage_runs_seaweedfs_and_mailpit_pinned() -> None:
    services = rendered("storage")["services"]
    assert set(services) == {"seaweedfs", "mailpit"}
    sw = services["seaweedfs"]
    assert sw["image"] == "chrislusf/seaweedfs:4.48"
    assert sw["command"] == ["mini", "-dir=/data", "-bucket=serversherpa", "-admin.ui=false"]
    assert sw["environment"]["AWS_ACCESS_KEY_ID"] == "serversherpa"
    assert [(p["target"], int(p["published"])) for p in sw["ports"]] == [(8333, 9000)]
    assert services["mailpit"]["image"] == "axllent/mailpit:v1.31.4"


def test_api_and_storage_share_the_spaces_secret() -> None:
    api_env = rendered("api")["services"]["api"]["environment"]
    sw_env = rendered("storage")["services"]["seaweedfs"]["environment"]
    assert api_env["SS_SPACES_ACCESS_KEY"] == sw_env["AWS_ACCESS_KEY_ID"] == "serversherpa"
    assert api_env["SS_SPACES_SECRET_KEY"] == sw_env["AWS_SECRET_ACCESS_KEY"] == "CHANGEME"


def test_readme_rollback_restores_into_a_clean_schema() -> None:
    # pg_restore --clean drops only what the dump holds: tables from the
    # rolled-back migration would survive and break the next migrate
    drop, restore = readme_restore_commands()
    assert "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" in drop
    assert "ON_ERROR_STOP=1" in drop
    assert "pg_restore --exit-on-error -U serversherpa -d serversherpa" in restore
    assert "--clean" not in restore


def test_the_lan_override_publishes_postgres_with_the_hba_file(tmp_path) -> None:
    hba = tmp_path / "pg_hba.conf"
    hba.write_text("local all all trust\n")
    env = ENV_EXAMPLE.read_text() + "STACK_DB_PUBLISH=1\nSTACK_DB_PORT=5432\n"
    env_file = tmp_path / ".env"
    env_file.write_text(env)
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "db/compose.yml"),
         "-f", str(STACK_DIR / "db/lan.yml"), "config", "--format", "json"],
        capture_output=True, text=True, env={**os.environ, "STACK_DB_HBA_FILE": str(hba)})
    assert out.returncode == 0, out.stderr
    pg = json.loads(out.stdout)["services"]["postgres"]
    assert published(pg) == [5432]
    assert pg["command"] == ["postgres", "-c", "listen_addresses=*", "-c",
                             "hba_file=/etc/ss/pg_hba.conf"]
    assert any(v["target"] == "/etc/ss/pg_hba.conf" and v.get("read_only") for v in pg["volumes"])


def test_the_lan_override_needs_the_hba_file(tmp_path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(ENV_EXAMPLE.read_text() + "STACK_DB_PUBLISH=1\n")
    env = {k: v for k, v in os.environ.items() if k != "STACK_DB_HBA_FILE"}
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "db/compose.yml"),
         "-f", str(STACK_DIR / "db/lan.yml"), "config", "--format", "json"],
        capture_output=True, text=True, env=env)
    assert out.returncode != 0 and "STACK_DB_HBA_FILE" in out.stderr


def test_smtp_comes_from_the_env_file_with_mailpit_by_default(tmp_path) -> None:
    env = rendered("api")["services"]["api"]["environment"]
    assert (env["SS_SMTP_HOST"], env["SS_SMTP_PORT"], env["SS_SMTP_STARTTLS"]) == (
        "mailpit", "1025", "false")
    assert (env["SS_SMTP_USERNAME"], env["SS_SMTP_PASSWORD"]) == ("", "")
    assert env["SS_SMTP_FROM"] == f"noreply@{DOMAIN}"
    env_file = tmp_path / ".env"
    env_file.write_text(ENV_EXAMPLE.read_text() + (
        "SS_SMTP_HOST=smtp.example.com\nSS_SMTP_PORT=587\nSS_SMTP_USERNAME=mailer\n"
        "SS_SMTP_PASSWORD=Mail-Secret-1\nSS_SMTP_STARTTLS=true\nSS_SMTP_FROM=ops@example.com\n"))
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "api/compose.yml"),
         "config", "--format", "json"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    smtp = json.loads(out.stdout)["services"]["api"]["environment"]
    assert (smtp["SS_SMTP_HOST"], smtp["SS_SMTP_PORT"], smtp["SS_SMTP_USERNAME"],
            smtp["SS_SMTP_PASSWORD"], smtp["SS_SMTP_STARTTLS"], smtp["SS_SMTP_FROM"]) == (
        "smtp.example.com", "587", "mailer", "Mail-Secret-1", "true", "ops@example.com")


def test_the_proxy_routes_the_learn_site() -> None:
    caddyfile = (STACK_DIR / "proxy" / "Caddyfile").read_text()
    assert "@learn host learn.{$STACK_DOMAIN}" in caddyfile
    assert "reverse_proxy @learn learn:8080 {" in caddyfile


def test_the_proxy_routes_the_devices_site_with_a_body_cap() -> None:
    caddyfile = (STACK_DIR / "proxy" / "Caddyfile").read_text()
    assert "@devices host devices.{$STACK_DOMAIN}" in caddyfile
    route = caddyfile.split("reverse_proxy @devices devices:8080 {", 1)
    assert len(route) == 2, "no reverse_proxy for @devices"
    assert route[1].split("\n\t\t}", 1)[0].split() == ["header_up", "X-Forwarded-For",
                                                       "{client_ip}"]
    # defense in depth: the app refuses bodies over 1 MiB itself
    cap = route[0].rsplit("request_body @devices {", 1)
    assert len(cap) == 2, "no request_body cap before the devices route"
    assert cap[1].split("}", 1)[0].split() == ["max_size", "2MB"]


def test_the_api_reads_the_apps_and_the_signing_digests_from_the_env_file(tmp_path) -> None:
    env = rendered("api")["services"]["api"]["environment"]
    assert (env["SS_APPS"], env["SS_KIOSK_SIGNING_DIGESTS"]) == ("", "")
    digest = "ab" * 32
    env_file = tmp_path / ".env"
    env_file.write_text(ENV_EXAMPLE.read_text() + (
        f"STACK_APPS=wiki,learn,mailpit\nSS_KIOSK_SIGNING_DIGESTS={digest}\n"))
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(STACK_DIR / "api/compose.yml"),
         "config", "--format", "json"], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    got = json.loads(out.stdout)["services"]["api"]["environment"]
    assert (got["SS_APPS"], got["SS_KIOSK_SIGNING_DIGESTS"]) == ("wiki,learn,mailpit", digest)


# ---- the devices service (devices.<domain>): one image, the API + SPA and a worker ----

DEVICES_SRC = STACK_DIR.parents[1] / "devices" / "api" / "src"


def devices_settings_fields() -> dict[str, Any]:
    import sys
    if str(DEVICES_SRC) not in sys.path:
        sys.path.insert(0, str(DEVICES_SRC))
    from serversherpa_devices.config import Settings
    return Settings.model_fields


def test_devices_stack_runs_the_service_and_its_worker_from_one_image() -> None:
    services = rendered("devices")["services"]
    assert set(services) == {"devices", "devices-worker"}
    web, worker = services["devices"], services["devices-worker"]
    assert web["image"] == worker["image"] == f"serversherpa-devices:{TAG}"
    assert worker["command"] == ["worker"]
    assert not worker.get("ports")
    assert web["environment"] == worker["environment"]
    assert web["restart"] == worker["restart"] == "unless-stopped"
    assert [(p["target"], int(p["published"])) for p in web["ports"]] == [(8080, 8093)]
    assert web["healthcheck"]["test"][:2] == ["CMD", "python"]
    assert "http://127.0.0.1:8080/healthz" in web["healthcheck"]["test"][-1]
    # the image's /healthz check is the web server's: the worker serves no HTTP
    assert worker["healthcheck"] == {"disable": True}
    # the worker starts once the service has migrated the database
    assert worker["depends_on"]["devices"]["condition"] == "service_healthy"


def test_devices_environment_points_at_the_stack() -> None:
    env = rendered("devices")["services"]["devices"]["environment"]
    assert env["DEVICES_DATABASE_URL"].startswith("postgresql+asyncpg://serversherpa:")
    assert env["DEVICES_DATABASE_URL"].endswith("@postgres:5432/serversherpa_devices")
    assert env["DEVICES_DATABASE_SSL"] == "disable"
    assert env["DEVICES_MAIN_API_URL"] == "http://api:8000"
    assert env["DEVICES_PUBLIC_URL"] == f"https://devices.{DOMAIN}"
    assert env["DEVICES_IOS_OWNER_URL"] == ""
    assert env["DEVICES_SPACES_ENDPOINT"] == f"https://spaces.{DOMAIN}"
    assert env["DEVICES_SPACES_REGION"] == "us-east-1"
    assert env["DEVICES_SPACES_BUCKET"] == "serversherpa-devices"
    assert env["DEVICES_SPACES_USE_PATH_STYLE"] == "true"
    assert env["FORWARDED_ALLOW_IPS"] == PROXY_IP


def _render_with(tmp_path, stack: str, extra: str) -> dict[str, Any]:
    env_file = tmp_path / f"{stack}.env"
    env_file.write_text(ENV_EXAMPLE.read_text() + extra)
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f",
         str(STACK_DIR / stack / "compose.yml"), "config", "--format", "json"],
        capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_devices_and_the_api_share_the_service_token_and_storage(tmp_path) -> None:
    extra = "SS_DEVICES_SERVICE_TOKEN=0123token\nDEVICES_SECRET_KEY=fernet-key\n"
    dev = _render_with(tmp_path, "devices", extra)["services"]["devices"]["environment"]
    api = _render_with(tmp_path, "api", extra)["services"]["api"]["environment"]
    sw = rendered("storage")["services"]["seaweedfs"]["environment"]
    assert dev["DEVICES_SERVICE_TOKEN"] == api["SS_DEVICES_SERVICE_TOKEN"] == "0123token"
    assert dev["DEVICES_SECRET_KEY"] == "fernet-key"
    assert dev["DEVICES_SPACES_ACCESS_KEY"] == sw["AWS_ACCESS_KEY_ID"] == "serversherpa"
    assert dev["DEVICES_SPACES_SECRET_KEY"] == sw["AWS_SECRET_ACCESS_KEY"] == "CHANGEME"


def test_devices_spaces_key_falls_back_to_the_main_one(tmp_path) -> None:
    """A droplet gives the devices bucket its own Spaces key; without one it
    uses the main key (and locally, SeaweedFS's)."""
    main = "SS_SPACES_ACCESS_KEY=main-access\nSS_SPACES_SECRET_KEY=main-secret\n"
    env = _render_with(tmp_path, "devices", main)["services"]["devices"]["environment"]
    assert (env["DEVICES_SPACES_ACCESS_KEY"], env["DEVICES_SPACES_SECRET_KEY"]) \
        == ("main-access", "main-secret")
    own = main + "DEVICES_SPACES_ACCESS_KEY=dev-access\nDEVICES_SPACES_SECRET_KEY=dev-secret\n"
    env = _render_with(tmp_path, "devices", own)["services"]["devices"]["environment"]
    assert (env["DEVICES_SPACES_ACCESS_KEY"], env["DEVICES_SPACES_SECRET_KEY"]) \
        == ("dev-access", "dev-secret")
    worker = _render_with(tmp_path, "devices", own)["services"]["devices-worker"]["environment"]
    assert worker["DEVICES_SPACES_SECRET_KEY"] == "dev-secret"


def test_devices_verifies_the_managed_database_with_its_ca(tmp_path) -> None:
    assert rendered("devices")["services"]["devices"]["environment"][
        "DEVICES_DATABASE_CA_B64"] == ""
    env = _render_with(tmp_path, "devices", "SS_DATABASE_CA_B64=Y2EtcGVt\n")
    assert env["services"]["devices"]["environment"]["DEVICES_DATABASE_CA_B64"] == "Y2EtcGVt"


def test_env_example_leaves_the_devices_spaces_key_commented() -> None:
    text = ENV_EXAMPLE.read_text().splitlines()
    for key in ("DEVICES_SPACES_ACCESS_KEY", "DEVICES_SPACES_SECRET_KEY"):
        assert any(line.startswith(f"# {key}=") for line in text), key
        assert not any(line.startswith(f"{key}=") for line in text), key


def test_devices_environment_covers_every_required_setting() -> None:
    env = rendered("devices")["services"]["devices"]["environment"]
    fields = devices_settings_fields()
    required = {f"DEVICES_{n.upper()}" for n, f in fields.items() if f.is_required()}
    assert required - set(env) == set()
    known = {f"DEVICES_{n.upper()}" for n in fields}
    assert {k for k in env if k.startswith("DEVICES_")} - known == set()


def test_devices_ios_owner_comes_from_the_env_file(tmp_path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(ENV_EXAMPLE.read_text()
                        + "DEVICES_IOS_OWNER_URL=https://devices.serversherpa.com\n")
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f",
         str(STACK_DIR / "devices/compose.yml"), "config", "--format", "json"],
        capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    env = json.loads(out.stdout)["services"]["devices"]["environment"]
    assert env["DEVICES_IOS_OWNER_URL"] == "https://devices.serversherpa.com"


def test_the_devices_secrets_may_be_absent() -> None:
    """ss-stack requires them only when the devices app runs; without them
    the main API's internal devices endpoints stay off (an empty token) and
    the devices stack still renders (to stop it)."""
    api = rendered("api")["services"]["api"]["environment"]
    dev = rendered("devices")["services"]["devices"]["environment"]
    assert api["SS_DEVICES_SERVICE_TOKEN"] == ""
    assert (dev["DEVICES_SERVICE_TOKEN"], dev["DEVICES_SECRET_KEY"]) == ("", "")


@pytest.mark.parametrize("stack, key", [("devices", "STACK_PROXY_IP")])
def test_devices_settings_are_required(tmp_path, stack: str, key: str) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("\n".join(line for line in ENV_EXAMPLE.read_text().splitlines()
                                  if not line.startswith(f"{key}=")) + "\n")
    env = {k: v for k, v in os.environ.items() if k != key}
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f",
         str(STACK_DIR / stack / "compose.yml"), "config", "--format", "json"],
        capture_output=True, text=True, env=env)
    assert out.returncode != 0 and key in out.stderr
