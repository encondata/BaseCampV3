"""Password hashing: Argon2id with a server-side pepper.

The pepper lives only in the environment (SS_PASSWORD_PEPPER), so a
database-only compromise cannot be attacked offline without it.
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# argon2-cffi defaults: Argon2id, 64 MiB memory, time_cost=3, parallelism=4
_hasher = PasswordHasher()

# Verified against when no real hash exists, so "unknown email" and
# "wrong password" take the same time (no account-enumeration timing oracle).
DUMMY_HASH = _hasher.hash("timing-equalizer-dummy-value")


def hash_password(password: str, *, pepper: str) -> str:
    return _hasher.hash(password + pepper)


def verify_password(password_hash: str, password: str, *, pepper: str) -> bool:
    try:
        _hasher.verify(password_hash, password + pepper)
        return True
    except (VerifyMismatchError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """True if hashing parameters have been strengthened since this hash."""
    return _hasher.check_needs_rehash(password_hash)
