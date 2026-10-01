"""Argon2id with a server-side pepper — byte-for-byte the portal's scheme
(serversherpa/security/passwords.py), so imported hashes verify here.
test_portal_compat.py proves it."""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

_hasher = PasswordHasher()

# Verified against when no real hash exists, so "unknown email" and
# "wrong password" take the same time.
DUMMY_HASH = _hasher.hash("timing-equalizer-dummy-value")


def hash_password(password: str, *, pepper: str) -> str:
    return _hasher.hash(password + pepper)


def verify_password(password_hash: str, password: str, *, pepper: str) -> bool:
    try:
        _hasher.verify(password_hash, password + pepper)
        return True
    except (VerifyMismatchError, InvalidHashError):
        return False
