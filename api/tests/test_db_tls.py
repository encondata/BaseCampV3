"""TLS to a managed PostgreSQL (a DigitalOcean droplet's environment):
SS_DATABASE_CA_B64 holds the cluster's own CA (base64 PEM, one .env line).
With it, every path to the database verifies the server's certificate and
name against that CA alone: the async engine (asyncpg), Alembic and the
log handler (psycopg, sslmode=verify-full + sslrootcert), the pg_dump/psql
subprocesses (PGSSLMODE/PGSSLROOTCERT) and the DB-testing raw connection.
Without it nothing changes: LAN environments behave exactly as before."""

import base64
import os
import ssl
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from pydantic import SecretStr

from serversherpa.config import Settings
from serversherpa.db import engine, tls
from serversherpa.services import db_backup

API_DIR = Path(__file__).resolve().parents[1]


def _ca_pem(cn: str = "ss-uat9-db cluster CA") -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.now(UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=30))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM).decode()


CA_PEM = _ca_pem()
CA_B64 = base64.b64encode(CA_PEM.encode()).decode()


def _settings(ca: str | None = None, ssl_mode: str = "require"):
    return SimpleNamespace(database_ssl=ssl_mode,
                           database_ca_b64=None if ca is None else SecretStr(ca))


def _tls_args(settings) -> dict:
    """connect_args without the application_name every connection also carries."""
    args = dict(engine.connect_args(settings))
    assert args.pop("server_settings") == {"application_name": engine._application_name}
    return args


def test_the_setting_exists_and_is_off_by_default():
    field = Settings.model_fields["database_ca_b64"]
    assert field.default is None and not field.is_required()


@pytest.mark.parametrize("ca", [None, "", "  "])
def test_without_a_ca_nothing_changes(ca):
    assert _tls_args(_settings(ca, "require")) == {"ssl": True}
    assert _tls_args(_settings(ca, "disable")) == {}
    assert tls.libpq_params(_settings(ca)) == {}
    assert tls.libpq_env(_settings(ca)) == {}
    assert tls.asyncpg_kwargs(_settings(ca)) == {}


def test_asyncpg_verifies_against_the_cluster_ca_only():
    for mode in ("require", "disable"):
        ctx = engine.connect_args(_settings(CA_B64, mode))["ssl"]
        assert isinstance(ctx, ssl.SSLContext)
        assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True
        cas = ctx.get_ca_certs()
        assert len(cas) == 1
        assert ((("commonName", "ss-uat9-db cluster CA"),),) == cas[0]["subject"]
    assert tls.asyncpg_kwargs(_settings(CA_B64))["ssl"].check_hostname is True


def test_libpq_gets_verify_full_and_a_private_ca_file():
    params = tls.libpq_params(_settings(CA_B64))
    assert params["sslmode"] == "verify-full"
    path = Path(params["sslrootcert"])
    assert path.read_text() == CA_PEM
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    # one file per CA, not one per call
    assert tls.libpq_params(_settings(CA_B64)) == params
    assert tls.libpq_env(_settings(CA_B64)) == {"PGSSLMODE": "verify-full",
                                                 "PGSSLROOTCERT": str(path)}
    other = tls.libpq_params(_settings(base64.b64encode(_ca_pem("other").encode()).decode()))
    assert other["sslrootcert"] != str(path)


@pytest.mark.parametrize("value", ["not base64 at all!",
                                   base64.b64encode(b"hello, not a certificate").decode()])
def test_a_bad_ca_is_named_never_shown(value):
    with pytest.raises(ValueError) as err:
        tls.asyncpg_kwargs(_settings(value))
    assert "SS_DATABASE_CA_B64" in str(err.value) and value not in str(err.value)


def test_pg_dump_and_psql_verify_too(monkeypatch):
    monkeypatch.setattr(db_backup, "_resolve_pg_dump", lambda: "/usr/bin/pg_dump")
    url = "postgresql+asyncpg://serversherpa:pw@db.internal:25060/serversherpa"
    monkeypatch.setattr(db_backup, "get_settings", lambda: _settings(CA_B64))
    _, env = db_backup._dump_argv(url)
    assert env["PGSSLMODE"] == "verify-full"
    assert Path(env["PGSSLROOTCERT"]).read_text() == CA_PEM
    monkeypatch.setattr(db_backup, "get_settings", lambda: _settings(None, "disable"))
    monkeypatch.delenv("PGSSLMODE", raising=False)
    _, env = db_backup._dump_argv(url)
    assert "PGSSLMODE" not in env and "PGSSLROOTCERT" not in env


def test_every_sync_engine_takes_the_libpq_params():
    """Alembic and the database log handler build their own psycopg engines."""
    for path in (API_DIR / "migrations" / "env.py",
                 API_DIR / "src" / "serversherpa" / "system" / "db_logging.py",
                 API_DIR / "src" / "serversherpa" / "devtools" / "testing" / "runner.py"):
        text = path.read_text()
        assert "tls." in text, path


def test_the_ca_files_can_be_removed():
    """tls registers remove_files with atexit."""
    tls.libpq_params(_settings(CA_B64))
    paths = list(tls._files.values())
    tls.remove_files()
    assert paths and not any(os.path.exists(p) for p in paths)
    assert tls._files == {}


# ---- the sync engines really get the params, and survive a lost CA file ----

class _Stop(Exception):
    pass


def _record_connects(sync_engine) -> list[dict]:
    """Every connect's libpq params, without touching a network: a listener
    added after tls's records them and stops the connect."""
    from sqlalchemy import event

    seen: list[dict] = []

    @event.listens_for(sync_engine, "do_connect")
    def _capture(dialect, conn_rec, cargs, cparams):
        seen.append(dict(cparams))
        raise _Stop()

    return seen


def _connect(sync_engine) -> None:
    with pytest.raises(_Stop):
        sync_engine.connect()


def test_the_log_handlers_engine_verifies_and_rewrites_a_lost_ca(monkeypatch):
    import serversherpa.config
    from serversherpa.system.db_logging import DbLogHandler

    settings = SimpleNamespace(sync_database_url="postgresql+psycopg://u:p@db.internal:1/x",
                               **vars(_settings(CA_B64)))
    monkeypatch.setattr(serversherpa.config, "get_settings", lambda: settings)
    handler = DbLogHandler.__new__(DbLogHandler)
    handler._engine = None
    sync_engine = handler._get_engine()
    seen = _record_connects(sync_engine)
    _connect(sync_engine)
    assert seen[-1]["sslmode"] == "verify-full"
    first = Path(seen[-1]["sslrootcert"])
    assert first.read_text() == CA_PEM
    first.unlink()                       # e.g. a tmp cleaner took it
    _connect(sync_engine)
    again = Path(seen[-1]["sslrootcert"])
    assert again.exists() and again.read_text() == CA_PEM


def test_a_sync_engine_without_a_ca_gets_nothing_added():
    sync_engine = tls.create_sync_engine("postgresql+psycopg://u:p@db.internal:1/x",
                                         _settings(None))
    seen = _record_connects(sync_engine)
    _connect(sync_engine)
    assert "sslmode" not in seen[-1] and "sslrootcert" not in seen[-1]


def test_alembic_builds_its_engine_through_tls():
    text = (API_DIR / "migrations" / "env.py").read_text()
    assert "tls.create_sync_engine(" in text and "create_engine(" not in text.replace(
        "tls.create_sync_engine(", "")


async def test_psql_restore_verifies_too(monkeypatch):
    seen = {}

    async def fake_exec(*argv, env, **kw):
        seen.update(env)
        raise _Stop()

    monkeypatch.setattr(db_backup, "_resolve_psql", lambda: "/usr/bin/psql")
    monkeypatch.setattr(db_backup.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(db_backup, "get_settings", lambda: _settings(CA_B64))
    with pytest.raises(_Stop):
        await db_backup.run_psql_restore(
            "postgresql+asyncpg://serversherpa:pw@db.internal:25060/serversherpa", b"SELECT 1;")
    assert seen["PGSSLMODE"] == "verify-full" and seen["PGPASSWORD"] == "pw"
    assert Path(seen["PGSSLROOTCERT"]).read_text() == CA_PEM


# ---- a real handshake: Postgres's SSLRequest, then TLS with a test CA ----

def _issue(ca_key, ca_cert, san: x509.GeneralName):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(UTC)
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "db")]))
            .issuer_name(ca_cert.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=30))
            .add_extension(x509.SubjectAlternativeName([san]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    return key, cert


@pytest.fixture
def tls_postgres(tmp_path):
    """A listener that answers Postgres's SSLRequest with 'S' and then does
    the TLS handshake with a server certificate from a fresh test CA.
    Yields (start(san) -> port, ca_b64, results)."""
    import ipaddress
    import socket
    import threading

    ca_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test cluster CA")])
    now = datetime.now(UTC)
    ca_cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
               .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - timedelta(days=1))
               .not_valid_after(now + timedelta(days=30))
               .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
               .sign(ca_key, hashes.SHA256()))
    ca_b64 = base64.b64encode(ca_cert.public_bytes(serialization.Encoding.PEM)).decode()
    results: list[str] = []
    servers = []

    def start(san_host: str) -> int:
        san = (x509.IPAddress(ipaddress.ip_address(san_host)) if san_host[0].isdigit()
               else x509.DNSName(san_host))
        key, cert = _issue(ca_key, ca_cert, san)
        (tmp_path / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (tmp_path / "key.pem").write_bytes(key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(4)
        sock.settimeout(10)
        servers.append(sock)

        def serve():
            while True:
                try:
                    conn, _ = sock.accept()
                except OSError:
                    return
                with conn:
                    conn.settimeout(10)
                    try:
                        if len(conn.recv(8)) != 8:
                            continue
                        conn.sendall(b"S")
                        with ctx.wrap_socket(conn, server_side=True):
                            results.append("handshake ok")
                    except (ssl.SSLError, OSError):
                        results.append("handshake failed")

        threading.Thread(target=serve, daemon=True).start()
        return sock.getsockname()[1]

    yield start, ca_b64, results
    for sock in servers:
        sock.close()


async def _asyncpg_try(port: int, settings) -> BaseException | None:
    import asyncpg

    try:
        await asyncpg.connect(host="127.0.0.1", port=port, user="u", password="p",
                              database="d", timeout=10, **tls.asyncpg_kwargs(settings))
    except BaseException as exc:      # noqa: BLE001 - the test inspects it
        return exc
    return None


def _psycopg_try(port: int, settings) -> BaseException | None:
    import psycopg

    try:
        psycopg.connect(host="127.0.0.1", port=port, user="u", password="p", dbname="d",
                        connect_timeout=10, **tls.libpq_params(settings)).close()
    except BaseException as exc:      # noqa: BLE001 - the test inspects it
        return exc
    return None


def _cert_rejected(exc: BaseException | None) -> bool:
    chain = []
    while exc is not None:
        chain.append(exc)
        exc = exc.__cause__ or exc.__context__
    text = " ".join(f"{type(e).__name__}: {e}" for e in chain).lower()
    return any(isinstance(e, ssl.SSLCertVerificationError) for e in chain) or \
        "certificate" in text or "host name" in text or "hostname" in text


async def test_a_certificate_for_another_name_is_refused(tls_postgres):
    start, ca_b64, results = tls_postgres
    port = start("wrong.example")
    settings = _settings(ca_b64)
    asyncpg_error = await _asyncpg_try(port, settings)
    psycopg_error = _psycopg_try(port, settings)
    assert _cert_rejected(asyncpg_error) and _cert_rejected(psycopg_error)
    # rejected for the name, not for the chain
    assert "mismatch" in str(asyncpg_error).lower(), asyncpg_error
    assert "does not match host name" in str(psycopg_error), psycopg_error
    # (libpq checks the name after the handshake, so the server may see one finish)


async def test_the_right_name_from_the_cluster_ca_passes_the_handshake(tls_postgres):
    start, ca_b64, results = tls_postgres
    port = start("127.0.0.1")
    settings = _settings(ca_b64)
    asyncpg_error = await _asyncpg_try(port, settings)   # the server hangs up after TLS
    psycopg_error = _psycopg_try(port, settings)
    assert not _cert_rejected(asyncpg_error) and not _cert_rejected(psycopg_error)
    assert results.count("handshake ok") == 2


async def test_a_certificate_from_another_ca_is_refused(tls_postgres):
    start, _, results = tls_postgres
    port = start("127.0.0.1")
    other = _settings(CA_B64)                 # trusts a different CA
    assert _cert_rejected(await _asyncpg_try(port, other))
    assert _cert_rejected(_psycopg_try(port, other))
    assert "handshake ok" not in results
