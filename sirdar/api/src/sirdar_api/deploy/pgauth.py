"""PostgreSQL role setup for DigitalOcean environments (deploy phase 7):
the SCRAM-SHA-256 verifier of a password (what PostgreSQL stores; sending
it instead of the password keeps the plaintext out of the server and its
logs) and the idempotent SQL step 0 runs as doadmin. Pure functions."""

import base64
import hashlib
import hmac
import os
import re

_IDENT_RE = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_VERIFIER_RE = re.compile(r"SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:"
                          r"[A-Za-z0-9+/=]+")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def scram_sha256(password: str, *, salt: bytes | None = None, iterations: int = 4096) -> str:
    salt = salt if salt is not None else os.urandom(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    return f"SCRAM-SHA-256${iterations}:{_b64(salt)}${_b64(stored_key)}:{_b64(server_key)}"


def setup_sql(*, role: str, database: str, verifier: str) -> str:
    """Run as doadmin in defaultdb: the role (created by doadmin, so PG 16
    gives doadmin ADMIN OPTION on it), its password, doadmin's membership
    (needed to hand it a database) and the database it owns. Idempotent."""
    if not _IDENT_RE.fullmatch(role) or not _IDENT_RE.fullmatch(database):
        raise ValueError("identifier")
    if not _VERIFIER_RE.fullmatch(verifier):
        raise ValueError("verifier")
    return "\n".join([
        "DO $$ BEGIN",
        f"  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{role}') THEN",
        f"    CREATE ROLE {role} LOGIN;",
        "  END IF;",
        "END $$;",
        f"ALTER ROLE {role} WITH LOGIN PASSWORD '{verifier}';",
        f"GRANT {role} TO doadmin;",
        f"SELECT 'CREATE DATABASE {database} OWNER {role}'",
        f"  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{database}')\\gexec",
        f"ALTER DATABASE {database} OWNER TO {role};",
        "",
    ])
