"""SCRAM-SHA-256 verifiers (so the role's password never reaches
PostgreSQL in plaintext) and the setup SQL."""

import base64
import hashlib
import hmac
import re

import pytest

from sirdar_api.deploy import pgauth


def test_the_rfc7677_exchange_verifies_against_our_verifier():
    """RFC 7677 §3 (user "user", password "pencil"): the server signature
    computed from our StoredKey/ServerKey must match the RFC's. If this fails,
    compare the strings with RFC 7677 before touching the code."""
    salt = base64.b64decode("W22ZaJ0SNY7soEsUEjb6gQ==")
    verifier = pgauth.scram_sha256("pencil", salt=salt, iterations=4096)
    m = re.fullmatch(r"SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)", verifier)
    assert m and base64.b64decode(m.group(1)) == salt
    server_key = base64.b64decode(m.group(3))
    auth = ("n=user,r=rOprNGfwEbeRWgbNEkqO,"
            "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,"
            "i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0")
    signature = hmac.new(server_key, auth.encode(), hashlib.sha256).digest()
    assert base64.b64encode(signature).decode() == "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="


def test_salts_are_random_and_the_password_never_shows():
    a, b = pgauth.scram_sha256("hex-secret"), pgauth.scram_sha256("hex-secret")
    assert a != b and "hex-secret" not in a


def test_setup_sql():
    sql = pgauth.setup_sql(role="serversherpa", database="serversherpa",
                           verifier=pgauth.scram_sha256("x"))
    assert "CREATE ROLE serversherpa LOGIN" in sql
    assert "ALTER ROLE serversherpa WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:" in sql
    assert "GRANT serversherpa TO doadmin" in sql
    assert "CREATE DATABASE serversherpa OWNER serversherpa" in sql and "\\gexec" in sql
    assert "ALTER DATABASE serversherpa OWNER TO serversherpa" in sql


@pytest.mark.parametrize("kw", [{"role": "Bad-Role"}, {"database": "x;drop"},
                                {"verifier": "md5abc"}, {"verifier": "SCRAM-SHA-256$1:a'$b:c"}])
def test_setup_sql_refuses_unsafe_values(kw):
    base = {"role": "serversherpa", "database": "serversherpa",
            "verifier": pgauth.scram_sha256("x")}
    with pytest.raises(ValueError):
        pgauth.setup_sql(**{**base, **kw})


async def test_postgres_accepts_the_password_behind_our_verifier():
    """A real PostgreSQL (the tests' server) stores our verifier as given and
    then lets the role in with the plaintext password, and not with another."""
    import secrets as pysecrets

    import asyncpg

    from .conftest import BASE_URL, TEST_DB
    role = f"sirdar_scram_{pysecrets.token_hex(4)}"
    password = pysecrets.token_hex(16)
    admin = await asyncpg.connect(host=BASE_URL.host, port=BASE_URL.port, user=BASE_URL.username,
                                  password=BASE_URL.password, database=TEST_DB)
    try:
        try:
            await admin.execute(f"CREATE ROLE {role} LOGIN PASSWORD "
                                f"'{pgauth.scram_sha256(password)}'")
        except asyncpg.InsufficientPrivilegeError:
            pytest.skip("the tests' database user can't create roles")
        stored = await admin.fetchval("SELECT rolpassword FROM pg_authid WHERE rolname = $1",
                                      role)
        assert stored.startswith("SCRAM-SHA-256$4096:") and password not in stored
        conn = await asyncpg.connect(host=BASE_URL.host, port=BASE_URL.port, user=role,
                                     password=password, database=TEST_DB)
        assert await conn.fetchval("SELECT current_user") == role
        await conn.close()
        with pytest.raises(asyncpg.InvalidPasswordError):
            await asyncpg.connect(host=BASE_URL.host, port=BASE_URL.port, user=role,
                                  password=password + "x", database=TEST_DB)
    finally:
        await admin.execute(f"DROP ROLE IF EXISTS {role}")
        await admin.close()
