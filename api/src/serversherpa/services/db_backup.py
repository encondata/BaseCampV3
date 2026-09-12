"""Encrypted database backups: an OpenSSL-compatible AES-256-CBC envelope
around a pg_dump, keyed by the requesting user's own account password.

The envelope format is intentionally byte-compatible with stock OpenSSL so
an operator can decrypt a downloaded backup with nothing but the CLI:

    openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -in <file> -out backup.sql

That means matching OpenSSL's on-disk layout exactly: an 8-byte magic
header (b"Salted__"), an 8-byte random salt, then the AES-CBC ciphertext.
Key material is derived with PBKDF2-HMAC-SHA256 over (password, salt),
10000 iterations (OpenSSL's own `-pbkdf2` default — matching it means no
`-iter` flag is needed on the decrypt side), producing 48 bytes: the first
32 are the AES-256 key, the last 16 are the CBC IV.
"""

import asyncio
import os
import shutil
from urllib.parse import quote

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlalchemy.engine import make_url

_MAGIC = b"Salted__"
_SALT_LEN = 8
_PBKDF2_ITERATIONS = 10000
_KEY_LEN = 32
_IV_LEN = 16

# Resolution order for the pg_dump binary: PATH first, then the well-known
# locations for hosts where PATH doesn't carry it (Homebrew's libpq is
# keg-only and never symlinked onto PATH; the others cover common Linux
# distro layouts).
_FALLBACK_PG_DUMP_PATHS = [
    "/opt/homebrew/opt/libpq/bin/pg_dump",
    "/usr/local/bin/pg_dump",
    "/usr/bin/pg_dump",
]


class PgDumpUnavailable(Exception):
    """No pg_dump binary could be found on this host."""


class PgDumpFailed(Exception):
    """pg_dump ran but exited non-zero."""

    def __init__(self, stderr: bytes):
        self.stderr = stderr
        super().__init__(stderr.decode("utf-8", errors="replace"))


class PsqlUnavailable(Exception):
    """No psql binary could be found next to pg_dump on this host."""


class PsqlFailed(Exception):
    """psql ran but exited non-zero. ON_ERROR_STOP aborts the restore on
    the first bad statement, and `--single-transaction` means everything
    fed to this call — including a schema drop/recreate a caller prepends
    ahead of the dump — rolls back together, so a failed restore leaves
    the database exactly as it was before the attempt. That guarantee
    depends on the caller never running the drop as a separate, already-
    committed statement outside this call."""

    def __init__(self, stderr: bytes):
        self.stderr = stderr
        super().__init__(stderr.decode("utf-8", errors="replace"))


def _derive_key_iv(password: str, salt: bytes) -> tuple[bytes, bytes]:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=_KEY_LEN + _IV_LEN,
        salt=salt,
        iterations=_PBKDF2_ITERATIONS,
    )
    material = kdf.derive(password.encode("utf-8"))
    return material[:_KEY_LEN], material[_KEY_LEN:]


def encrypt_openssl(data: bytes, password: str) -> bytes:
    """Encrypt `data` into an OpenSSL `Salted__` envelope decryptable via
    `openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -pass pass:<password>`."""
    salt = os.urandom(_SALT_LEN)
    key, iv = _derive_key_iv(password, salt)

    padder = padding.PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(data) + padder.finalize()

    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()

    return _MAGIC + salt + ciphertext


def decrypt_openssl(blob: bytes, password: str) -> bytes:
    """Inverse of encrypt_openssl. Raises ValueError("bad_password_or_corrupt")
    for a wrong password, a corrupt envelope, or anything else that keeps the
    plaintext from coming back out cleanly (bad padding, misaligned
    ciphertext, missing/short header) — deliberately one error for every
    such case, since none of them are distinguishable from each other
    without the correct password."""
    if not blob.startswith(_MAGIC) or len(blob) < len(_MAGIC) + _SALT_LEN:
        raise ValueError("bad_password_or_corrupt")

    salt = blob[len(_MAGIC):len(_MAGIC) + _SALT_LEN]
    ciphertext = blob[len(_MAGIC) + _SALT_LEN:]
    key, iv = _derive_key_iv(password, salt)

    try:
        decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        padded = decryptor.update(ciphertext) + decryptor.finalize()
        unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
        return unpadder.update(padded) + unpadder.finalize()
    except Exception as exc:  # noqa: BLE001 - collapse every failure mode
        raise ValueError("bad_password_or_corrupt") from exc


def _resolve_pg_dump() -> str:
    found = shutil.which("pg_dump")
    if found:
        return found
    for candidate in _FALLBACK_PG_DUMP_PATHS:
        if os.path.exists(candidate):
            return candidate
    raise PgDumpUnavailable()


def _conninfo_without_password(url) -> str:
    """A libpq URI for `url` with the password component dropped entirely
    — not masked, not blanked, just absent from the string.

    NB: `url.set(password=None)` does NOT clear the password — SQLAlchemy
    treats None on `.set()` as "leave this field unchanged" for every
    field, so that call is a no-op and the real password stays in the
    rendered string. Building the URI from the individual components here
    sidesteps that trap without reaching for the underscore-prefixed
    `_replace()` internals."""
    userinfo = quote(url.username, safe="") if url.username else None
    hostinfo = url.host or ""
    if url.port:
        hostinfo = f"{hostinfo}:{url.port}"
    database = url.database or ""
    netloc = f"{userinfo}@{hostinfo}" if userinfo else hostinfo
    return f"postgresql://{netloc}/{database}"


def _dump_argv(database_url: str) -> tuple[list[str], dict[str, str]]:
    """Build the pg_dump argv and subprocess environment for `database_url`.

    Split out from run_pg_dump so the security property that matters here —
    the password lives ONLY in the returned env's PGPASSWORD, never in
    argv (argv is visible to every other process on the host via `ps`; the
    environment of a subprocess we spawn ourselves is not) — is directly
    unit-testable without spawning a real pg_dump."""
    binary = _resolve_pg_dump()
    # SQLAlchemy's asyncpg driver URL isn't a libpq URI; strip the driver
    # suffix before parsing.
    url = make_url(database_url.replace("+asyncpg", ""))
    env = {**os.environ, "PGPASSWORD": url.password or ""}
    conninfo = _conninfo_without_password(url)
    argv = [binary, "--no-owner", "--no-privileges", "-d", conninfo]
    return argv, env


async def run_pg_dump(database_url: str) -> bytes:
    """Run `pg_dump --no-owner --no-privileges` (plain-format SQL) against
    `database_url` and return the dump bytes."""
    argv, env = _dump_argv(database_url)

    proc = await asyncio.create_subprocess_exec(
        *argv, env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise PgDumpFailed(stderr)
    return stdout


def _resolve_psql() -> str:
    """psql lives next to pg_dump in every layout this host resolution
    covers (the same libpq/postgresql-client package installs both) — so
    resolving pg_dump first and looking beside it is more reliable than a
    separate PATH/fallback search that could disagree with which pg_dump
    we're actually restoring against."""
    pg_dump = _resolve_pg_dump()
    candidate = os.path.join(os.path.dirname(pg_dump), "psql")
    if os.path.exists(candidate):
        return candidate
    raise PsqlUnavailable()


# pg_dump 18+ emits this line unconditionally near the top of every dump
# (always `= 0`, the wire default) — `transaction_timeout` is a PG 17+
# GUC, so a dump taken with an 18.x client toolchain against an older
# (e.g. 16.x) server fails immediately under `-v ON_ERROR_STOP=1` with
# "unrecognized configuration parameter". Dropping the line is harmless
# on any server new enough to understand it in the first place — it is
# only ever restated at its own default.
_UNSUPPORTED_GUC_PREFIX = b"SET transaction_timeout = "


def _strip_unsupported_gucs(sql: bytes) -> bytes:
    lines = sql.split(b"\n")
    kept = [line for line in lines if not line.startswith(_UNSUPPORTED_GUC_PREFIX)]
    return b"\n".join(kept)


async def run_psql_restore(database_url: str, sql: bytes) -> None:
    """Feed `sql` (a plain-SQL dump, as produced by run_pg_dump, optionally
    with DDL a caller prepended ahead of it) into `database_url` via psql.
    `-v ON_ERROR_STOP=1 --single-transaction` means the very first failing
    statement aborts the WHOLE restore inside one transaction — nothing
    fed to this call, prepended DDL included, ever survives a partial
    failure; see PsqlFailed. GUCs pg_dump's client tools emit that the
    target server predates (see `_strip_unsupported_gucs`) are stripped
    before anything is sent."""
    binary = _resolve_psql()
    url = make_url(database_url.replace("+asyncpg", ""))
    env = {**os.environ, "PGPASSWORD": url.password or ""}
    conninfo = _conninfo_without_password(url)
    argv = [binary, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", conninfo]

    proc = await asyncio.create_subprocess_exec(
        *argv, env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await proc.communicate(input=_strip_unsupported_gucs(sql))
    if proc.returncode != 0:
        raise PsqlFailed(stderr)
