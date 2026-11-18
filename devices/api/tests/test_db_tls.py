"""A managed database's certificate is checked against its CA
(DEVICES_DATABASE_CA_B64, from the stack's SS_DATABASE_CA_B64) on both paths
to it: asyncpg (the service) and psycopg (Alembic). Without the CA, or with
TLS off, nothing changes. No real TLS server: the connect arguments and the
migration URL are checked, and Alembic is shown to ask for verify-full."""

import base64
import datetime as dt
import os
import ssl
import subprocess

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from .conftest import API_DIR


def _ca_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "devices-fixture-ca")])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM).decode()


PEM = _ca_pem()
CA_B64 = base64.b64encode(PEM.encode()).decode()


def _settings(**update):
    from serversherpa_devices.config import get_settings
    return get_settings().model_copy(update=update)


def test_the_ca_setting_is_empty_by_default():
    from serversherpa_devices.config import Settings
    assert Settings.model_fields["database_ca_b64"].default == ""


@pytest.mark.parametrize("ssl_mode, ca, expected", [
    ("disable", "", {}),
    ("require", "", {"ssl": True}),
    # TLS off (a LAN data VM): the CA isn't used
    ("disable", CA_B64, {}),
])
def test_connect_args_without_a_ca_are_unchanged(ssl_mode, ca, expected):
    from serversherpa_devices.db.tls import connect_args
    assert connect_args(_settings(database_ssl=ssl_mode, database_ca_b64=ca)) == expected


def test_connect_args_with_a_ca_verify_the_server_and_its_name():
    from serversherpa_devices.db.tls import connect_args
    args = connect_args(_settings(database_ssl="require", database_ca_b64=CA_B64))
    ctx = args["ssl"]
    assert isinstance(ctx, ssl.SSLContext)
    assert ctx.check_hostname is True and ctx.verify_mode == ssl.CERT_REQUIRED
    # the cluster's CA alone
    assert [dict(n[0] for n in c["subject"])["commonName"] for c in ctx.get_ca_certs()] \
        == ["devices-fixture-ca"]


def test_the_engine_uses_the_connect_args(monkeypatch):
    from serversherpa_devices.db import engine as engine_module
    seen = {}

    def fake_create(url, **kwargs):
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(engine_module, "create_async_engine", fake_create)
    monkeypatch.setattr(engine_module, "get_settings",
                        lambda: _settings(database_ssl="require", database_ca_b64=CA_B64))
    monkeypatch.setattr(engine_module, "_engine", None)
    monkeypatch.setattr(engine_module, "_sessionmaker", None)
    monkeypatch.setattr(engine_module, "async_sessionmaker", lambda *a, **k: object())
    engine_module.get_engine()
    assert isinstance(seen["connect_args"]["ssl"], ssl.SSLContext)


@pytest.mark.parametrize("ssl_mode, ca", [("disable", ""), ("require", ""), ("disable", CA_B64)])
def test_the_migration_url_without_a_ca_is_unchanged(ssl_mode, ca):
    from serversherpa_devices.db.tls import migration_url
    settings = _settings(database_ssl=ssl_mode, database_ca_b64=ca)
    url = migration_url(settings)
    assert url.render_as_string(hide_password=False) == settings.sync_database_url
    assert "sslmode" not in url.query


def test_the_migration_url_with_a_ca_is_verify_full_with_a_private_ca_file():
    from serversherpa_devices.db.tls import migration_url
    settings = _settings(database_ssl="require", database_ca_b64=CA_B64)
    url = migration_url(settings)
    assert url.drivername == "postgresql+psycopg"
    assert url.query["sslmode"] == "verify-full"
    path = url.query["sslrootcert"]
    with open(path) as f:
        assert f.read() == PEM
    assert os.stat(path).st_mode & 0o777 == 0o600
    # one file per CA, not one per call
    assert migration_url(settings).query["sslrootcert"] == path


@pytest.mark.parametrize("bad", ["not base64!", base64.b64encode(b"hello").decode()])
def test_a_bad_ca_names_the_setting_never_its_value(bad):
    from serversherpa_devices.db.tls import connect_args, migration_url
    settings = _settings(database_ssl="require", database_ca_b64=bad)
    for build in (connect_args, migration_url):
        with pytest.raises(ValueError) as err:
            build(settings)
        assert "DEVICES_DATABASE_CA_B64" in str(err.value) and bad not in str(err.value)


def test_alembic_asks_for_verify_full_and_removes_its_ca_file(tmp_path):
    """The test database doesn't verify as the fixture CA's server (it has no
    TLS, or another certificate), so Alembic must fail on TLS, where without
    the CA it would connect. Its CA file is gone once it exits."""
    tmp = tmp_path / "tmp"
    tmp.mkdir()
    out = subprocess.run(
        [str(API_DIR / ".venv/bin/alembic"), "current"], cwd=API_DIR,
        env={**os.environ, "DEVICES_DATABASE_SSL": "require", "DEVICES_DATABASE_CA_B64": CA_B64,
             "TMPDIR": str(tmp)},
        capture_output=True, text=True, timeout=120, check=False)
    assert out.returncode != 0
    assert "SSL" in out.stderr
    assert list(tmp.iterdir()) == []
