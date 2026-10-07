"""Sirdar copies a few portal security rules instead of importing the
portal package. These tests fail the moment the two drift: they load the
portal's pure password module by path and pin the exact lines of the
other rules Sirdar ports. A failure means: re-read the portal change,
port it to sirdar_api, then update the pin."""

import importlib.util
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from sirdar_api.security import passwords, totp

REPO = Path(__file__).resolve().parents[3]
PORTAL = REPO / "api" / "src" / "serversherpa"

pytestmark = pytest.mark.skipif(not PORTAL.exists(), reason="portal source not checked out")


def _portal_passwords():
    spec = importlib.util.spec_from_file_location(
        "portal_passwords", PORTAL / "security" / "passwords.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_portal_hash_verifies_in_sirdar_and_back():
    portal = _portal_passwords()
    h = portal.hash_password("CorrectHorse9!", pepper="pep")
    assert passwords.verify_password(h, "CorrectHorse9!", pepper="pep")
    h2 = passwords.hash_password("CorrectHorse9!", pepper="pep")
    assert portal.verify_password(h2, "CorrectHorse9!", pepper="pep")


def test_portal_totp_seed_encryption_is_plain_fernet():
    src = (PORTAL / "services" / "totp.py").read_text()
    assert "return fernet().encrypt(secret.encode())" in src
    assert "return fernet().decrypt(bytes(blob)).decode()" in src
    secretbox = (PORTAL / "security" / "secretbox.py").read_text()
    assert "return Fernet(key.encode())" in secretbox
    key = Fernet.generate_key().decode()
    blob = Fernet(key.encode()).encrypt(b"JBSWY3DPEHPK3PXP")   # what the portal stores
    assert totp.decrypt_secret(blob, key=key) == "JBSWY3DPEHPK3PXP"


def test_portal_backup_code_rules_unchanged():
    src = (PORTAL / "services" / "totp.py").read_text()
    assert "BACKUP_CODE_LENGTH = 10" in src
    assert 'return "".join(ch for ch in code.lower() if ch.isalnum())' in src
    assert "code_hash=hash_password(code, pepper=pepper)" in src


def test_portal_totp_policy_unchanged():
    src = (PORTAL / "services" / "totp.py").read_text()
    assert 'if not cfg.get("two_factor_enabled"):' in src
    assert 'if cfg.get("two_factor_required") or account.totp_required:' in src
    assert "AccessGroup.totp_required.is_(True)" in src
    assert "Role.totp_required.is_(True)" in src


def test_portal_password_expiry_unchanged():
    src = (PORTAL / "services" / "password_policy.py").read_text()
    assert "start = policy.since if changed is None else max(changed, policy.since)" in src
    assert "return start + timedelta(days=policy.days)" in src
    assert "if not policy.enabled or policy.since is None or account.password_hash is None:" in src


def test_first_admin_password_bar_is_the_portals_default():
    """Sirdar checks a typed first-admin password against ServerSherpa's
    default bar; an environment Sirdar builds never overrides it."""
    from sirdar_api.services import portal_policy
    config = (PORTAL / "config.py").read_text()
    assert f"password_min_length: int = {portal_policy.PASSWORD_MIN_LENGTH}" in config
    compose = (REPO / "deploy" / "stack" / "api" / "compose.yml").read_text()
    assert "SS_PASSWORD_MIN_LENGTH" not in compose
    roles = (PORTAL / "access" / "defaults.py").read_text()
    assert f'"{portal_policy.FIRST_ADMIN_ROLE}":' in roles
