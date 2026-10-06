"""deploy/stack for DigitalOcean droplets: ss-stack's external-data mode
(no db/storage stacks except mailpit, a fixed network subnet, the managed
database through one-off postgres containers whose password never reaches
argv), the Caddy proxy stack, and the compose files' nested defaults.

ss-stack runs against a fake `docker` on PATH that logs its argv (and the
PGPASSWORD it was given, separately). The compose and Caddy checks need a
real Docker and skip without one; the Caddy run also needs SS_STACK_E2E=1."""

import base64
import json
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
  "network inspect")
    # an existing network answers with the subnet and ip-range in
    # $DOCKER_LOG.net, or the expected pair when that file is empty
    [[ -f "$DOCKER_LOG.net" ]] || exit 1
    if [[ -s "$DOCKER_LOG.net" ]]; then cat "$DOCKER_LOG.net"; else echo "172.30.0.0/24 172.30.0.128/25"; fi
    exit 0 ;;
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


def _run_proc(
    tmp_path: Path, *args, check: bool = True, fake: str = FAKE_DOCKER, extra_env=None
) -> tuple[subprocess.CompletedProcess, str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(fake)
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "DOCKER_LOG": str(log), **(extra_env or {})}
    proc = subprocess.run(
        [str(SS_STACK), *args], env=env, check=check, capture_output=True, text=True
    )
    pw = Path(f"{log}.pw")
    return (
        proc,
        log.read_text() if log.exists() else "",
        pw.read_text() if pw.exists() else "",
    )


def _run(tmp_path: Path, *args) -> tuple[str, str]:
    _, log, pw = _run_proc(tmp_path, *args)
    return log, pw


def test_ss_stack_parses_and_documents_the_new_commands():
    subprocess.run(["bash", "-n", str(SS_STACK)], check=True)
    text = SS_STACK.read_text()
    assert "ss-stack pgdump" in text and "ss-stack revision" in text


def test_up_external_skips_local_data_and_starts_caddy(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=True)))
    assert "db/compose.yml" not in log
    assert re.search(r"storage/compose.yml up -d .* mailpit", log)
    assert "network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 ss-uat9" in log
    assert log.index("api/compose.yml --profile certs run --rm migrate") < log.index(
        "proxy/compose.yml up -d"
    )


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
    log, pw = _run(tmp_path, "restore", str(env_dir), str(dump), "--clear-sessions")
    assert PASSWORD not in log and PASSWORD in pw
    assert "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" in log
    assert re.search(r"pg_restore --exit-on-error --no-owner --no-acl -d serversherpa", log)
    assert "DELETE FROM auth_sessions" in log
    assert "db/compose.yml" not in log


def test_pgdump_and_revision(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    out = tmp_path / "snap.dump"
    log, _ = _run(tmp_path, "pgdump", str(env_dir), str(out))
    assert out.read_bytes() == b"PGDMP" and "--no-owner --no-acl" in log
    # the one-off client needs the network: pg() makes sure it exists first
    assert log.index(
        "network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 ss-uat9"
    ) < log.index("pg_dump")
    proc, log, pw = _run_proc(tmp_path, "revision", str(env_dir))
    assert proc.stdout.strip() == "0089"
    assert "postgres:16-alpine psql -tAc SELECT version_num FROM alembic_version" in log
    assert PASSWORD not in log and PASSWORD in pw


def test_pgdump_has_the_signal_traps():
    pgdump = SS_STACK.read_text().split("  pgdump)", 1)[1].split(";;", 1)[0]
    for trap in ("trap 'exit 129' HUP", "trap 'exit 130' INT", "trap 'exit 143' TERM"):
        assert trap in pgdump


def test_restore_says_it_stops_only_this_droplets_writers():
    restore = SS_STACK.read_text().split("  restore)", 1)[1].split(";;", 1)[0]
    assert "only on this droplet" in restore and "7b" in restore


def _real_ca_pem() -> str:
    """A self-signed CA certificate (openssl x509 must accept it)."""
    from datetime import UTC, datetime, timedelta

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ss-uat9-db cluster CA")])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode()


CA_PEM = _real_ca_pem()
CA_B64 = base64.b64encode(CA_PEM.encode()).decode()
CA_MOUNT = "/run/ss-db-ca.pem"
# Like FAKE_DOCKER, and copies the CA file it was asked to mount (with its
# mode) next to the log, so the test sees what the client container got.
CA_DOCKER = FAKE_DOCKER.replace(
    'case "$*" in *pg_dump*)',
    """args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ ${args[i]} == -v && ${args[i+1]} == *:/run/ss-db-ca.pem:ro ]]; then
    src=${args[i+1]%%:*}
    cp "$src" "$DOCKER_LOG.ca"; stat -f %Lp "$src" 2>/dev/null >> "$DOCKER_LOG.mode" \\
      || stat -c %a "$src" >> "$DOCKER_LOG.mode"
    printf '%s\\n' "$src" >> "$DOCKER_LOG.src"
  fi
done
case "$*" in *pg_dump*)""",
)


def _with_ca(env_dir: Path, value: str = CA_B64) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(f"SS_DATABASE_CA_B64={value}\n")


@pytest.mark.parametrize("command", ["dump", "pgdump", "revision", "restore"])
def test_the_one_off_client_verifies_the_cluster_ca(tmp_path, command):
    env_dir = _env_dir(tmp_path, external=True)
    _with_ca(env_dir)
    args = {
        "dump": [],
        "pgdump": [str(tmp_path / "snap.dump")],
        "revision": [],
        "restore": [str(tmp_path / "db.dump"), "--clear-sessions"],
    }[command]
    (tmp_path / "db.dump").write_bytes(b"PGDMP")
    _proc, log, _ = _run_proc(
        tmp_path, command, str(env_dir), *args, fake=CA_DOCKER, extra_env={"TMPDIR": str(tmp_path)}
    )
    runs = [line for line in log.splitlines() if line.startswith("run ")]
    assert runs
    for line in runs:
        assert "-e PGSSLMODE=verify-full" in line and f"-e PGSSLROOTCERT={CA_MOUNT}" in line
        assert "PGSSLMODE=require" not in line
        assert f":{CA_MOUNT}:ro" in line
    assert CA_B64 not in log and CA_PEM.splitlines()[1] not in log
    assert (tmp_path / "docker.log.ca").read_text() == CA_PEM
    assert set((tmp_path / "docker.log.mode").read_text().split()) == {"600"}
    # one file for the whole command, gone when ss-stack exits
    sources = set((tmp_path / "docker.log.src").read_text().split())
    assert len(sources) == 1 and not Path(sources.pop()).exists()


def test_a_bad_cluster_ca_stops_before_any_client_runs(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    _with_ca(env_dir, "not base64 at all!")
    proc, log, _ = _run_proc(
        tmp_path, "revision", str(env_dir), check=False, extra_env={"TMPDIR": str(tmp_path)}
    )
    assert proc.returncode != 0 and "SS_DATABASE_CA_B64" in proc.stderr
    assert "run " not in log
    assert not list(tmp_path.glob("ss-db-ca.*"))


def test_a_failed_dump_still_removes_the_ca_and_the_partial(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    _with_ca(env_dir)
    failing = CA_DOCKER.replace("exit 0\n", "[[ $* == *pg_dump* ]] && exit 1\nexit 0\n")
    proc, _, _ = _run_proc(
        tmp_path,
        "dump",
        str(env_dir),
        check=False,
        fake=failing,
        extra_env={"TMPDIR": str(tmp_path)},
    )
    assert proc.returncode != 0
    assert not list((env_dir / "backups").glob("*.partial"))
    src = (tmp_path / "docker.log.src").read_text().split()[0]
    assert not Path(src).exists()


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


@pytest.mark.parametrize(
    "bad",
    [
        _b64("-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n"),  # no body
        _b64("-----BEGIN CERTIFICATE-----\n" + CA_PEM.splitlines()[1] + "\n"),  # no END
        _b64("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"),  # not a cert
    ],
    ids=["no-body", "no-end", "not-a-cert"],
)
def test_restore_checks_the_ca_before_stopping_anything(tmp_path, bad):
    if "AAAA" in base64.b64decode(bad).decode() and shutil.which("openssl") is None:
        pytest.skip("needs openssl to tell a certificate from a body")
    env_dir = _env_dir(tmp_path, external=True)
    _with_ca(env_dir, bad)
    (tmp_path / "db.dump").write_bytes(b"PGDMP")
    proc, log, _ = _run_proc(
        tmp_path,
        "restore",
        str(env_dir),
        str(tmp_path / "db.dump"),
        check=False,
        extra_env={"TMPDIR": str(tmp_path)},
    )
    assert proc.returncode == 1 and "SS_DATABASE_CA_B64" in proc.stderr
    assert " stop" not in log and "run " not in log  # the stack keeps running
    assert not list(tmp_path.glob("ss-db-ca.*"))


SLOW_DUMP_DOCKER = CA_DOCKER.replace(
    "case \"$*\" in *pg_dump*) printf 'PGDMP' ;;",
    'case "$*" in *pg_dump*) printf \'PGD\'; touch "$DOCKER_LOG.dumping"; sleep 2 ;;',
)


@pytest.mark.parametrize("signal_name, code", [("SIGTERM", 143), ("SIGHUP", 129), ("SIGINT", 130)])
def test_a_signal_mid_dump_removes_the_ca_and_the_partial(tmp_path, signal_name, code):
    import signal
    import time

    assert "sleep 2" in SLOW_DUMP_DOCKER
    env_dir = _env_dir(tmp_path, external=True)
    _with_ca(env_dir)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "docker").write_text(SLOW_DUMP_DOCKER)
    (bin_dir / "docker").chmod(0o755)
    log = tmp_path / "docker.log"
    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "DOCKER_LOG": str(log),
        "TMPDIR": str(tmp_path),
    }
    proc = subprocess.Popen(
        [str(SS_STACK), "dump", str(env_dir)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.monotonic() + 10
    while not Path(f"{log}.dumping").exists():
        assert time.monotonic() < deadline and proc.poll() is None
        time.sleep(0.05)
    partials = list((env_dir / "backups").glob("*.partial"))
    ca_files = list(tmp_path.glob("ss-db-ca.*"))
    assert len(partials) == 1 and len(ca_files) == 1
    proc.send_signal(getattr(signal, signal_name))
    assert proc.wait(timeout=15) == code
    assert not partials[0].exists() and not ca_files[0].exists()
    assert not list((env_dir / "backups").glob("*.dump"))


def test_local_mode_ignores_the_ca_key(tmp_path):
    env_dir = _env_dir(tmp_path, external=False)
    _with_ca(env_dir)
    log, _ = _run(tmp_path, "revision", str(env_dir))
    assert log.splitlines()[-1] == (
        "compose --env-file "
        + str(env_dir / ".env")
        + " -f "
        + str(STACK / "db/compose.yml")
        + " exec -T postgres psql "
        "-U serversherpa -d serversherpa -tAc "
        "SELECT version_num FROM alembic_version"
    )


def test_a_network_with_another_subnet_is_refused(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    env = env_dir / ".env"
    env.write_text(env.read_text().replace("172.30.0.0/24", "172.31.0.0/24"))
    (tmp_path / "docker.log.net").touch()  # the fake network exists, at 172.30.0.0/24
    proc, log, _ = _run_proc(tmp_path, "up", str(env_dir), check=False)
    assert proc.returncode == 1
    assert (
        "network ss-uat9 has subnet 172.30.0.0/24 and ip-range 172.30.0.128/25, "
        "not 172.31.0.0/24 and 172.31.0.128/25"
    ) in proc.stderr
    assert "compose" not in log


def test_a_network_without_the_ip_range_is_refused(tmp_path):
    """A network from before the ip-range (or made by hand) would hand
    Caddy's .2 to whichever container starts first."""
    env_dir = _env_dir(tmp_path, external=True)
    (tmp_path / "docker.log.net").write_text("172.30.0.0/24 \n")
    proc, log, _ = _run_proc(tmp_path, "up", str(env_dir), check=False)
    assert proc.returncode == 1
    assert (
        "network ss-uat9 has subnet 172.30.0.0/24 and ip-range (none), "
        "not 172.30.0.0/24 and 172.30.0.128/25"
    ) in proc.stderr
    assert "docker network rm ss-uat9" in proc.stderr
    assert "compose" not in log


def test_the_subnet_must_be_a_24(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    env = env_dir / ".env"
    env.write_text(env.read_text().replace("172.30.0.0/24", "172.30.0.0/16"))
    proc, log, _ = _run_proc(tmp_path, "up", str(env_dir), check=False)
    assert proc.returncode == 1
    assert "STACK_NETWORK_SUBNET must be a /24" in proc.stderr
    assert "network create" not in log


# Runs every `docker compose` call ss-stack makes as `docker compose … config -q`
# against the real Docker, so interpolation errors (a missing `:?` variable)
# fail the command; every other docker call succeeds.
COMPOSE_CHECKING_DOCKER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [[ $1 == compose ]]; then
  shift
  args=()
  while [[ $# -gt 0 ]]; do
    case $1 in --env-file|-f) args+=("$1" "$2"); shift 2 ;; *) break ;; esac
  done
  exec "$REAL_DOCKER" compose "${args[@]}" config -q
fi
case "$1 $2" in "network inspect") exit 1 ;; esac
exit 0
"""


@pytest.mark.skipif(shutil.which("docker") is None, reason="needs docker")
def test_up_external_without_spaces_secret_key(tmp_path):
    """A droplet's .env has SS_SPACES_SECRET_KEY (the bucket's key) and no
    SPACES_SECRET_KEY (SeaweedFS never runs there); every compose file
    must still interpolate."""
    env_dir = _env_dir(tmp_path, external=True)
    env = env_dir / ".env"
    text = env.read_text().replace("SPACES_SECRET_KEY=x\n", "")
    assert "\nSPACES_SECRET_KEY" not in text
    text += (
        "SS_DATABASE_URL=postgresql+asyncpg://serversherpa:pw@db.example:25060/serversherpa\n"
        "SS_DATABASE_SSL=require\nSTACK_TRUSTED_PROXIES=10.116.0.0/20\n"
        "SS_SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com\nSS_SPACES_SECRET_KEY=do\n"
    )
    env.write_text(text)
    proc, log, _ = _run_proc(
        tmp_path,
        "up",
        str(env_dir),
        check=False,
        fake=COMPOSE_CHECKING_DOCKER,
        extra_env={"REAL_DOCKER": shutil.which("docker"), "HOME": os.environ["HOME"]},
    )
    assert proc.returncode == 0, proc.stderr
    assert "proxy/compose.yml up -d" in log


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
    """Caddy with the real Caddyfile in front of busybox stand-ins for the
    api, portal and cert-worker: health, host routing, ACME, the HTTPS
    redirect (only for the domain), the 404, and client IPs that a caller
    can't spoof through X-Forwarded-For."""
    net = "ss-sirdar-caddy-e2e"
    lb_ip = "172.30.9.20"  # the stand-in load balancer: the only trusted proxy
    subprocess.run(
        ["docker", "network", "create", "--subnet", "172.30.9.0/24", net],
        check=True,
        capture_output=True,
    )
    names = []
    # the api echoes the X-Forwarded-For it receives at /cgi-bin/xff
    xff_cgi = (
        "mkdir -p /www/cgi-bin && printf '#!/bin/sh\\necho Content-Type: text/plain\\n"
        'echo\\necho "$HTTP_X_FORWARDED_FOR"\\n\' > /www/cgi-bin/xff && '
        "chmod +x /www/cgi-bin/xff && "
    )
    upstreams = (
        (10, "api", 8000, xff_cgi),
        (11, "portal", 8080, ""),
        (
            12,
            "cert-worker",
            8089,
            (
                "mkdir -p /www/.well-known/acme-challenge && "
                "echo acme-token > /www/.well-known/acme-challenge/tok && "
            ),
        ),
    )
    try:
        # fixed addresses away from .2, which Caddy takes (an automatic one
        # would hand .2 to the first busybox)
        for octet, name, port, extra in upstreams:
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
                        f"mkdir -p /www && {extra}echo {name} > /www/index.html && "
                        f"echo ok > /www/healthz && httpd -f -p {port} -h /www"
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
                f"STACK_TRUSTED_PROXIES={lb_ip}/32",
                "-v",
                f"{STACK / 'proxy' / 'Caddyfile'}:/etc/caddy/Caddyfile:ro",
                image,
            ],
            check=True,
            capture_output=True,
        )

        def curl(*args, ip: str | None = None, body: bool = False) -> str:
            fmt = [] if body else ["-o", "/dev/null", "-w", "%{http_code} %{redirect_url}"]
            return subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    net,
                    *(["--ip", ip] if ip else []),
                    "curlimages/curl:8.10.1",
                    "-s",
                    *fmt,
                    *args,
                ],
                capture_output=True,
                text=True,
                check=False,
            ).stdout

        portal = ("-H", "Host: portal.uat9.serversherpa.com")
        api = ("-H", "Host: api.uat9.serversherpa.com")
        assert curl("http://172.30.9.2/healthz").startswith("200")
        assert curl(*portal, "http://172.30.9.2/").startswith("200")
        assert curl(*portal, "http://172.30.9.2/", body=True).strip() == "portal"
        assert curl(*api, "http://172.30.9.2/", body=True).strip() == "api"
        assert curl(*portal, "-H", "X-Forwarded-Proto: http", "http://172.30.9.2/x") == (
            "308 https://portal.uat9.serversherpa.com/x"
        )
        # the redirect is only for the domain: other hosts get the 404
        assert curl(
            "-H", "Host: other.example", "-H", "X-Forwarded-Proto: http", "http://172.30.9.2/x"
        ).startswith("404")
        assert curl("-H", "Host: other.example", "http://172.30.9.2/").startswith("404")
        # ACME HTTP-01 reaches the cert-worker, before the HTTPS redirect
        assert (
            curl(
                *api,
                "-H",
                "X-Forwarded-Proto: http",
                "http://172.30.9.2/.well-known/acme-challenge/tok",
                body=True,
            ).strip()
            == "acme-token"
        )
        # Caddy's own health answers only on 127.0.0.1
        assert curl("http://172.30.9.2/caddy-health").startswith("404")
        inside = subprocess.run(
            [
                "docker",
                "exec",
                f"{net}-caddy",
                "wget",
                "-q",
                "-O",
                "-",
                "http://127.0.0.1/caddy-health",
            ],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
        assert inside.strip() == "ok"
        # client IPs: the load balancer appends the real client to whatever
        # X-Forwarded-For the client sent; only that right-most entry counts
        xff = ("http://172.30.9.2/cgi-bin/xff",)
        got = curl(
            *api, "-H", "X-Forwarded-For: 6.6.6.6, 203.0.113.7", *xff, ip=lb_ip, body=True
        ).strip()
        assert got == "203.0.113.7"
        # a caller that isn't the load balancer can't set it at all
        got = curl(
            *api, "-H", "X-Forwarded-For: 6.6.6.6", *xff, ip="172.30.9.30", body=True
        ).strip()
        assert got == "172.30.9.30"
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        subprocess.run(["docker", "network", "rm", net], capture_output=True, check=False)


def test_the_api_stack_runs_the_cert_worker_only_on_droplets(tmp_path):
    log, _ = _run(tmp_path, "up", str(_env_dir(tmp_path, external=True)))
    assert re.search(r"api/compose.yml --profile certs up -d", log)
    assert "api/compose.yml --profile certs run --rm migrate" in log
    local = tmp_path / "local"
    local.mkdir()
    log, _ = _run(local, "up", str(_env_dir(local, external=False)))
    assert "--profile certs" not in log


def test_down_on_a_droplet_stops_the_cert_worker_too(tmp_path):
    log, _ = _run(tmp_path, "down", str(_env_dir(tmp_path, external=True)))
    assert "api/compose.yml --profile certs down" in log


def test_the_acme_copies_match():
    sirdar = REPO / "sirdar" / "api" / "src" / "sirdar_api" / "deploy" / "acme.py"
    api = REPO / "api" / "src" / "serversherpa" / "certs" / "acme.py"
    assert sirdar.read_bytes() == api.read_bytes(), "change both copies of acme.py together"


@needs_docker
def test_only_the_cert_worker_gets_the_renewal_token(tmp_path):
    env_dir = _env_dir(tmp_path, external=True)
    with (env_dir / ".env").open("a") as f:
        f.write(
            "STACK_DROPLET_ID=4001\nSS_CERT_DO_TOKEN=dop_v1_renewal\nSS_CERT_LB_ID=lb-1\n"
            "SS_CERT_NAMES=api.uat9.serversherpa.com,portal.uat9.serversherpa.com\n"
            "SS_CERT_ACME_KEY=YWNtZS1rZXk=\n"
        )
    base = [
        "docker",
        "compose",
        "--env-file",
        str(env_dir / ".env"),
        "-f",
        str(STACK / "api" / "compose.yml"),
    ]
    plain = subprocess.run(
        [*base, "config", "--format", "json"], check=True, capture_output=True, text=True
    ).stdout
    assert "cert-worker" not in plain and "dop_v1_renewal" not in plain
    services = json.loads(
        subprocess.run(
            [*base, "--profile", "certs", "config", "--format", "json"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )["services"]
    cert = services["cert-worker"]
    assert cert["command"] == ["serversherpa", "cert-worker"]
    env = cert["environment"]
    assert env["SS_CERT_DO_TOKEN"] == "dop_v1_renewal" and env["SS_CERT_LB_ID"] == "lb-1"
    assert env["SS_CERT_ENV"] == "uat9" and env["SS_CERT_DROPLET_ID"] == "4001"
    assert env["SS_CERT_ACME_KEY"] == "YWNtZS1rZXk="
    assert env["SS_CERT_ACME_DIRECTORY"] == "https://acme-v02.api.letsencrypt.org/directory"
    assert "ports" not in cert
    for name, service in services.items():
        if name != "cert-worker":
            assert not any(k.startswith("SS_CERT_") for k in service.get("environment", {})), name


@needs_docker
@pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1")
def test_caddy_keeps_its_address_when_others_start_first(tmp_path):
    """`ss-stack data` makes the network and starts mailpit (an automatic
    address) before the proxy stack; another automatic container joins too.
    Caddy must still get its fixed .2, and the automatic ones must land in
    the upper half (.128/25), away from fixed addresses."""
    env_dir = _env_dir(tmp_path, external=True)
    env = env_dir / ".env"
    text = env.read_text().replace("STACK_ENV=uat9", "STACK_ENV=sirdar-iprange-e2e")
    text = text.replace("172.30.0.", "172.30.7.")
    env.write_text(text + "STACK_MAILPIT_PORT=0\n")
    net = "ss-sirdar-iprange-e2e"
    project = "ss-sirdar-iprange-e2e-storage"
    docker = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"]}

    def ip_of(name: str) -> str:
        return subprocess.run(
            [
                "docker",
                "inspect",
                "-f",
                '{{(index .NetworkSettings.Networks "' + net + '").IPAddress}}',
                name,
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    names = []
    try:
        subprocess.run(
            [str(SS_STACK), "data", str(env_dir)], env=docker, check=True, capture_output=True
        )
        mailpit = subprocess.run(
            ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        assert len(mailpit) == 1
        names.append(f"{net}-other")
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                f"{net}-other",
                "--network",
                net,
                "busybox:1.36",
                "sleep",
                "300",
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
                "172.30.7.2",
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
        assert ip_of(f"{net}-caddy") == "172.30.7.2"
        for auto in (mailpit[0], f"{net}-other"):
            last = int(ip_of(auto).rsplit(".", 1)[1])
            assert ip_of(auto).startswith("172.30.7.") and 128 <= last <= 255
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
        subprocess.run(
            ["docker", "compose", "-p", project, "down", "-v"], capture_output=True, check=False
        )
        subprocess.run(["docker", "network", "rm", net], capture_output=True, check=False)
