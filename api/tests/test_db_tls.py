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


def test_the_setting_exists_and_is_off_by_default():
    field = Settings.model_fields["database_ca_b64"]
    assert field.default is None and not field.is_required()


@pytest.mark.parametrize("ca", [None, "", "  "])
def test_without_a_ca_nothing_changes(ca):
    assert engine.connect_args(_settings(ca, "require")) == {"ssl": True}
    assert engine.connect_args(_settings(ca, "disable")) == {}
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
