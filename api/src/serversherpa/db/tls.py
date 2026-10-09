"""TLS to a managed PostgreSQL whose certificate is signed by the cluster's
own CA (a DigitalOcean droplet's environment).

SS_DATABASE_CA_B64 holds that CA as base64 PEM (one .env line). With it,
every path to the database verifies the server's certificate and name
against that CA alone:

- asyncpg (the engine, DB testing's raw connection): an SSLContext built
  from the CA, hostname checking on;
- libpq (psycopg for Alembic and the log handler, pg_dump/psql):
  sslmode=verify-full with sslrootcert, a private temp file written once
  per CA and removed at exit.

Without it every function here answers "nothing to add", so environments
without the setting (the LAN stacks, development) behave as before.
Errors name the setting, never its value."""

import atexit
import base64
import binascii
import hashlib
import os
import ssl
import tempfile
import threading

_SETTING = "SS_DATABASE_CA_B64"
_files: dict[str, str] = {}          # sha256 of the PEM -> its temp file
_lock = threading.Lock()


def ca_pem(settings) -> str | None:
    """The CA's PEM, or None when the setting is absent or blank."""
    raw = getattr(settings, "database_ca_b64", None)
    value = (raw.get_secret_value() if raw is not None else "").strip()
    if not value:
        return None
    try:
        pem = base64.b64decode(value, validate=True).decode("ascii")
    except (binascii.Error, ValueError):
        raise ValueError(f"{_SETTING} isn't a base64 PEM certificate") from None
    if "-----BEGIN CERTIFICATE-----" not in pem:
        raise ValueError(f"{_SETTING} isn't a base64 PEM certificate")
    return pem


def ssl_context(pem: str) -> ssl.SSLContext:
    """Trusts only `pem`; checks the certificate and the host name."""
    try:
        ctx = ssl.create_default_context(cadata=pem)
    except ssl.SSLError:
        raise ValueError(f"{_SETTING} isn't a base64 PEM certificate") from None
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    # Python 3.13's default adds RFC 5280 strictness (e.g. an Authority Key
    # Identifier on the server certificate) that libpq doesn't ask for; a
    # cluster CA libpq accepts must work here too. Trust and the host name
    # are still checked.
    ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
    return ctx


def asyncpg_kwargs(settings) -> dict:
    """{"ssl": <context>} with the CA, else {} (the caller's default)."""
    pem = ca_pem(settings)
    return {"ssl": ssl_context(pem)} if pem else {}


def ca_file(settings) -> str | None:
    """A private (0600) file holding the CA, for libpq; None without one."""
    pem = ca_pem(settings)
    if pem is None:
        return None
    key = hashlib.sha256(pem.encode()).hexdigest()
    with _lock:
        path = _files.get(key)
        if path is None or not os.path.exists(path):
            fd, path = tempfile.mkstemp(prefix="ss-db-ca-", suffix=".pem")
            with os.fdopen(fd, "w") as f:       # mkstemp creates it 0600
                f.write(pem)
            _files[key] = path
        return path


def libpq_params(settings) -> dict[str, str]:
    """psycopg connect_args: verify-full against the CA, else {}."""
    path = ca_file(settings)
    return {"sslmode": "verify-full", "sslrootcert": path} if path else {}


def libpq_env(settings) -> dict[str, str]:
    """Environment for pg_dump/psql: verify-full against the CA, else {}."""
    path = ca_file(settings)
    return {"PGSSLMODE": "verify-full", "PGSSLROOTCERT": path} if path else {}


def create_sync_engine(url: str, settings, *, application_name: str | None = None, **kwargs):
    """A psycopg engine that adds libpq_params on every connect, so a CA
    file removed under a long-lived process (a tmp cleaner) is written
    again rather than failing every later connection. application_name
    names its connections in pg_stat_activity."""
    from sqlalchemy import create_engine, event

    engine = create_engine(url, **kwargs)

    @event.listens_for(engine, "do_connect")
    def _verify(dialect, conn_rec, cargs, cparams):
        cparams.update(libpq_params(settings))
        if application_name:
            cparams["application_name"] = application_name

    return engine


def remove_files() -> None:
    with _lock:
        for path in _files.values():
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        _files.clear()


atexit.register(remove_files)
