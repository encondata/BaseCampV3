"""TLS to a managed PostgreSQL whose certificate is signed by the cluster's
own CA (a DigitalOcean droplet's environment), as the main API does it
(api/src/serversherpa/db/tls.py).

DEVICES_DATABASE_CA_B64 holds that CA as base64 PEM (the stack passes its
SS_DATABASE_CA_B64). With it, and DEVICES_DATABASE_SSL=require, both paths
to the database verify the server's certificate and name against that CA
alone:

- asyncpg (the service): an SSLContext built from the CA, hostname
  checking on;
- psycopg (Alembic): sslmode=verify-full with sslrootcert, a private temp
  file written once per CA and removed at exit.

Without it (or with TLS off) everything is as before: asyncpg's ssl=True
for "require", and Alembic's URL as configured. Errors name the setting,
never its value."""

import atexit
import base64
import binascii
import hashlib
import os
import ssl
import tempfile
import threading

from sqlalchemy.engine import URL, make_url

_SETTING = "DEVICES_DATABASE_CA_B64"
_files: dict[str, str] = {}          # sha256 of the PEM -> its temp file
_lock = threading.Lock()


def ca_pem(settings) -> str | None:
    """The CA's PEM when TLS is on and the setting is set, else None."""
    value = settings.database_ca_b64.strip()
    if settings.database_ssl != "require" or not value:
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
    # Python 3.13's default adds RFC 5280 strictness that libpq doesn't ask
    # for; a cluster CA libpq (and the main API) accepts must work here too.
    # Trust and the host name are still checked.
    ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
    return ctx


def connect_args(settings) -> dict:
    """asyncpg's connect arguments: ssl verified against the CA when it is
    set, else ssl=True for "require" (encrypted, unverified), else none."""
    pem = ca_pem(settings)
    if pem:
        return {"ssl": ssl_context(pem)}
    return {"ssl": True} if settings.database_ssl == "require" else {}


def ca_file(pem: str) -> str:
    """A private (0600) file holding `pem`, for libpq."""
    key = hashlib.sha256(pem.encode()).hexdigest()
    with _lock:
        path = _files.get(key)
        if path is None or not os.path.exists(path):
            fd, path = tempfile.mkstemp(prefix="devices-db-ca-", suffix=".pem")
            with os.fdopen(fd, "w") as f:       # mkstemp creates it 0600
                f.write(pem)
            _files[key] = path
        return path


def migration_url(settings) -> URL:
    """Alembic's psycopg URL: verify-full against the CA when it is set."""
    url = make_url(settings.sync_database_url)
    pem = ca_pem(settings)
    if pem is None:
        return url
    return url.update_query_dict({"sslmode": "verify-full", "sslrootcert": ca_file(pem)})


def remove_files() -> None:
    with _lock:
        for path in _files.values():
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        _files.clear()


atexit.register(remove_files)
