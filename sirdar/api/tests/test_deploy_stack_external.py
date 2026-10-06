"""deploy/stack for DigitalOcean droplets: ss-stack's external-data mode
(no db/storage stacks except mailpit, a fixed network subnet, the managed
database through one-off postgres containers whose password never reaches
argv), the Caddy proxy stack, and the compose files' nested defaults.

ss-stack runs against a fake `docker` on PATH that logs its argv (and the
PGPASSWORD it was given, separately). The compose and Caddy checks need a
real Docker and skip without one; the Caddy run also needs SS_STACK_E2E=1."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
STACK = REPO / "deploy" / "stack"
SS_STACK = STACK / "ss-stack"
PASSWORD = "a1b2" * 16

FAKE_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ -n ${PGPASSWORD:-} ]]; then printf '%s\\n' "$PGPASSWORD" >> "$DOCKER_LOG.pw"; fi
case "$1 $2" in
  "network inspect") [[ -f "$DOCKER_LOG.net" ]] && { echo 172.30.0.0/24; exit 0; }; exit 1 ;;
  "network create") touch "$DOCKER_LOG.net" ;;
esac
case "$*" in *pg_dump*) printf 'PGDMP' ;; *"SELECT version_num"*) echo 0089 ;; esac
exit 0
"""


def _env_dir(tmp_path: Path, external: bool) -> Path:
    env_dir = tmp_path / "env"
    env_dir.mkdir()
    lines = [
        "STACK_ENV=uat9",
        "STACK_DOMAIN=uat9.serversherpa.com",
        "STACK_IMAGE_TAG=abc12345",
        "STACK_REPO_DIR=/opt/serversherpa/uat9/repo",
        "STACK_PROXY_IP=172.30.0.2",
        "STACK_BIND_IP=127.0.0.1",
        "STACK_KEEP_DUMPS=5",
        f"POSTGRES_PASSWORD={PASSWORD}",
        "SPACES_SECRET_KEY=x",
        "SS_JWT_SECRET=x",
        "SS_TOTP_ENCRYPTION_KEY=x",
        "SS_PASSWORD_PEPPER=x",
        "SS_WIKI_SERVICE_TOKEN=x",
    ]
    if external:
        lines += [
            "STACK_EXTERNAL_DATA=1",
            "STACK_CADDY=1",
            "STACK_NETWORK_SUBNET=172.30.0.0/24",
            "STACK_DB_HOST=private-ss-uat9-db.db.ondigitalocean.com",
            "STACK_DB_PORT=25060",
            "STACK_DB_NAME=serversherpa",
            "STACK_DB_USER=serversherpa",
        ]
    (env_dir / ".env").write_text("\n".join(lines) + "\n")
    return env_dir


def _run(tmp_path: Path, *args, stdin: bytes | None = None) -> tuple[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "DOCKER_LOG": str(log)}
    subprocess.run([str(SS_STACK), *args], env=env, check=True, input=stdin, capture_output=True)
    pw = Path(f"{log}.pw")
    return log.read_text(), pw.read_text() if pw.exists() else ""


def test_ss_stack_parses_and_documents_the_new_commands():
    subprocess.run(["bash", "-n", str(SS_STACK)], check=True)
    text = SS_STACK.read_text()
    assert "ss-stack pgdump" in text and "ss-stack revision" in text


def test_up_external_skips_local_data_and_starts_caddy(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=True)))
    assert "db/compose.yml" not in log
    assert re.search(r"storage/compose.yml up -d .* mailpit", log)
    assert "network create --subnet 172.30.0.0/24 ss-uat9" in log
    assert log.index("api/compose.yml run --rm migrate") < log.index("proxy/compose.yml up -d")


def test_up_local_is_unchanged(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=False)))
    assert "db/compose.yml up -d" in log and "proxy/compose.yml" not in log
    assert "network create ss-uat9" in log


def test_dump_external_uses_a_one_off_client_and_keeps_the_password_off_argv(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    log, pw = _run(tmp_path, "dump", str(env_dir))
    assert "run --rm -i --network ss-uat9" in log and "postgres:16-alpine pg_dump" in log
    assert "-e PGSSLMODE=require" in log
    assert PASSWORD not in log and PASSWORD in pw
    dumps = list((env_dir / "backups").glob("*.dump"))
    assert len(dumps) == 1 and dumps[0].read_bytes() == b"PGDMP"


def test_restore_external(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    dump = tmp_path / "db.dump"
    dump.write_bytes(b"PGDMP")
    log, _ = _run(tmp_path, "restore", str(env_dir), str(dump), "--clear-sessions")
    assert "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" in log
    assert re.search(r"pg_restore --exit-on-error --no-owner --no-acl -d serversherpa", log)
    assert "DELETE FROM auth_sessions" in log
    assert "db/compose.yml" not in log


def test_pgdump_and_revision(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    out = tmp_path / "snap.dump"
    log, _ = _run(tmp_path, "pgdump", str(env_dir), str(out))
    assert out.read_bytes() == b"PGDMP" and "--no-owner --no-acl" in log
    _run(tmp_path, "revision", str(env_dir))


def test_caddyfile_routes_in_order():
    text = (STACK / "proxy" / "Caddyfile").read_text()
    assert "auto_https off" in text and "admin off" in text
    assert "trusted_proxies static {$STACK_TRUSTED_PROXIES}" in text
    order = [
        "respond @self",
        "reverse_proxy @lbhealth api:8000",
        "reverse_proxy /.well-known/acme-challenge/* cert-worker:8089",
        "redir @plain https://{host}{uri} 308",
        "reverse_proxy @api api:8000",
        "reverse_proxy @portal portal:8080",
        "reverse_proxy @kiosk kiosk:8080",
        "reverse_proxy @wiki wiki:8080",
        "reverse_proxy @status status:8080",
        "respond 404",
    ]
    found = [text.index(line) for line in order]
    assert found == sorted(found)


def test_caddy_image_is_pinned_by_digest():
    compose = (STACK / "proxy" / "compose.yml").read_text()
    assert re.search(r"image: caddy:2\.[0-9.]+-alpine@sha256:[0-9a-f]{64}\n", compose)
    assert "ipv4_address: ${STACK_PROXY_IP:?set STACK_PROXY_IP}" in compose


needs_docker = pytest.mark.skipif(shutil.which("docker") is None, reason="needs docker")


@needs_docker
@pytest.mark.parametrize("external", [False, True])
def test_compose_nested_defaults(tmp_path, external):
    env_dir = _env_dir(tmp_path, external=external)
    if external:
        with (env_dir / ".env").open("a") as f:
            f.write(
                "SS_DATABASE_URL=postgresql+asyncpg://serversherpa:pw@db.example:25060/"
                "serversherpa\nSS_DATABASE_SSL=require\nSTACK_HOSTS_IP=203.0.113.50\n"
                "SS_SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com\n"
                "SS_SPACES_SECRET_KEY=do-secret\n"
            )
    out = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(env_dir / ".env"),
            "-f",
            str(STACK / "api" / "compose.yml"),
            "config",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if external:
        assert "db.example:25060" in out and "SS_DATABASE_SSL: require" in out
        assert "nyc3.digitaloceanspaces.com" in out and "203.0.113.50" in out
        assert "do-secret" in out
    else:
        assert "@postgres:5432/serversherpa" in out and "SS_DATABASE_SSL: disable" in out
        assert "https://spaces.uat9.serversherpa.com" in out and "172.30.0.2" in out


@needs_docker
@pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1")
def test_caddy_routes_in_a_container(tmp_path):
    """Caddy with the real Caddyfile in front of a busybox 'api' and
    'portal': health, host routing, the HTTPS redirect and the 404."""
    net = "ss-sirdar-caddy-e2e"
    subprocess.run(
        ["docker", "network", "create", "--subnet", "172.30.9.0/24", net],
        check=True,
        capture_output=True,
    )
    names = []
    try:
        # fixed addresses away from .2, which Caddy takes (an automatic one
        # would hand .2 to the first busybox)
        for octet, name in ((10, "api"), (11, "portal")):
            names.append(f"{net}-{name}")
            subprocess.run(
                [
                    "docker",
                    "run",
                    "-d",
                    "--rm",
                    "--name",
                    f"{net}-{name}",
                    "--network",
                    net,
                    "--ip",
                    f"172.30.9.{octet}",
                    "--network-alias",
                    name,
                    "busybox:1.36",
                    "sh",
                    "-c",
                    (
                        f"mkdir -p /www && echo {name} > /www/index.html && "
                        f"echo ok > /www/healthz && httpd -f -p "
                        f"{8000 if name == 'api' else 8080} -h /www"
                    ),
                ],
                check=True,
                capture_output=True,
            )
        image = re.search(r"image: (\S+)", (STACK / "proxy" / "compose.yml").read_text()).group(1)
        names.append(f"{net}-caddy")
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                f"{net}-caddy",
                "--network",
                net,
                "--ip",
                "172.30.9.2",
                "-e",
                "STACK_DOMAIN=uat9.serversherpa.com",
                "-e",
                "STACK_TRUSTED_PROXIES=10.116.0.0/20",
                "-v",
                f"{STACK / 'proxy' / 'Caddyfile'}:/etc/caddy/Caddyfile:ro",
                image,
            ],
            check=True,
            capture_output=True,
        )

        def curl(*args) -> str:
            return subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    net,
                    "curlimages/curl:8.10.1",
                    "-s",
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code} %{redirect_url}",
                    *args,
                ],
                capture_output=True,
                text=True,
                check=False,
            ).stdout

        assert curl("http://172.30.9.2/healthz").startswith("200")
        assert curl("-H", "Host: portal.uat9.serversherpa.com", "http://172.30.9.2/").startswith(
            "200"
        )
        assert (
            curl(
                "-H",
                "Host: portal.uat9.serversherpa.com",
                "-H",
                "X-Forwarded-Proto: http",
                "http://172.30.9.2/x",
            )
            == "308 https://portal.uat9.serversherpa.com/x"
        )
        assert curl("-H", "Host: other.example", "http://172.30.9.2/").startswith("404")
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        subprocess.run(["docker", "network", "rm", net], capture_output=True, check=False)
