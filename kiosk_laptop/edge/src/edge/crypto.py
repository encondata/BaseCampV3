"""Secrets at rest. /data/edge.key holds a Fernet key (cloud tokens) and
the JWT secret (edge access tokens); it is created 0600 on first start and
never silently replaced — a new key would orphan every encrypted token, so
an unreadable file stops the edge until `python -m edge reset-key`."""

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet

KEY_FILE = "edge.key"
_hasher = PasswordHasher()


class KeyFileError(RuntimeError):
    pass


@dataclass(frozen=True)
class Keys:
    fernet: Fernet
    jwt_secret: str


def load_or_create_keys(data_dir: Path) -> Keys:
    path = data_dir / KEY_FILE
    if path.exists():
        try:
            raw = json.loads(path.read_text())
            return Keys(fernet=Fernet(raw["fernet"].encode()), jwt_secret=raw["jwt"])
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise KeyFileError(f"{path} is unreadable; run `python -m edge reset-key`") from exc
    raw = {"fernet": Fernet.generate_key().decode(), "jwt": secrets.token_urlsafe(48)}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(raw, fh)
    return Keys(fernet=Fernet(raw["fernet"].encode()), jwt_secret=raw["jwt"])


def encrypt(keys: Keys, value: str) -> str:
    return keys.fernet.encrypt(value.encode()).decode()


def decrypt(keys: Keys, value: str) -> str:
    return keys.fernet.decrypt(value.encode()).decode()


def make_verifier(secret: str) -> str:
    return _hasher.hash(secret)


def check_verifier(verifier: str, secret: str) -> bool:
    try:
        return _hasher.verify(verifier, secret)
    except (VerificationError, InvalidHashError):
        return False
