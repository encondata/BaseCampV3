import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pyotp
import pytest
from cryptography.fernet import Fernet

from sirdar_api.security import passwords, tokens, totp

SECRET = "s" * 40


def test_password_roundtrip_and_pepper_matters():
    h = passwords.hash_password("CorrectHorse9!", pepper="p1")
    assert passwords.verify_password(h, "CorrectHorse9!", pepper="p1")
    assert not passwords.verify_password(h, "CorrectHorse9!", pepper="p2")
    assert not passwords.verify_password("not-a-hash", "x", pepper="p1")


def test_access_token_roundtrip():
    pid, sid = uuid.uuid4(), uuid.uuid4()
    tok = tokens.create_access_token(person_id=pid, session_id=sid, secret=SECRET, ttl_seconds=60)
    claims = tokens.decode_access_token(tok, secret=SECRET)
    assert claims["sub"] == str(pid) and claims["sid"] == str(sid) and claims["iss"] == "sirdar"


def test_access_token_rejects_other_issuer_and_challenge_type():
    portal_style = jwt.encode({"iss": "serversherpa", "sub": "x", "sid": "y", "typ": "access",
                               "iat": datetime.now(UTC),
                               "exp": datetime.now(UTC) + timedelta(minutes=1)},
                              SECRET, algorithm="HS256")
    with pytest.raises(tokens.TokenError):
        tokens.decode_access_token(portal_style, secret=SECRET)
    challenge = tokens.create_challenge_token(person_id=uuid.uuid4(), secret=SECRET)
    with pytest.raises(tokens.TokenError):
        tokens.decode_access_token(challenge, secret=SECRET)


def test_challenge_roundtrip_and_expiry():
    pid = uuid.uuid4()
    assert tokens.decode_challenge_token(
        tokens.create_challenge_token(person_id=pid, secret=SECRET), secret=SECRET) == pid
    expired = jwt.encode({"iss": "sirdar", "sub": str(pid), "typ": "totp", "purpose": "verify",
                          "iat": datetime.now(UTC) - timedelta(minutes=10),
                          "exp": datetime.now(UTC) - timedelta(minutes=5)},
                         SECRET, algorithm="HS256")
    with pytest.raises(tokens.TokenError):
        tokens.decode_challenge_token(expired, secret=SECRET)


def test_refresh_token_hash_is_stable_sha256():
    t = tokens.generate_refresh_token()
    assert len(t) >= 43
    assert tokens.hash_refresh_token(t) == tokens.hash_refresh_token(t)
    assert len(tokens.hash_refresh_token(t)) == 64


def test_secret_roundtrip_and_wrong_key():
    key = Fernet.generate_key().decode()
    blob = totp.encrypt_secret("JBSWY3DPEHPK3PXP", key=key)
    assert totp.decrypt_secret(blob, key=key) == "JBSWY3DPEHPK3PXP"
    with pytest.raises(totp.TotpSeedError):
        totp.decrypt_secret(blob, key=Fernet.generate_key().decode())


def test_match_counter_accepts_drift_and_rejects_replay():
    seed = pyotp.random_base32()
    otp = pyotp.TOTP(seed)
    now = datetime.now(UTC)
    counter = otp.timecode(now)
    code = otp.generate_otp(counter)
    assert totp.match_counter(seed, code, None, now=now) == counter
    assert totp.match_counter(seed, code, counter, now=now) is None          # replay
    assert totp.match_counter(seed, otp.generate_otp(counter - 1), None, now=now) == counter - 1
    assert totp.match_counter(seed, otp.generate_otp(counter - 3), None, now=now) is None


def test_code_helpers():
    assert totp.compact_code("123 456") == "123456"
    assert totp.is_app_code("123456") and not totp.is_app_code("12345a")
    assert totp.normalize_backup("ABCDE-fghjk") == "abcdefghjk"


def test_is_app_code_rejects_non_ascii_digits():
    # Arabic-Indic digits (should be rejected)
    assert not totp.is_app_code("١٢٣٤٥٦")
    # Mixed ASCII and non-ASCII (should be rejected)
    assert not totp.is_app_code("12345١")


def test_match_counter_handles_non_ascii_gracefully():
    # Non-ASCII code should return None instead of raising TypeError
    seed = pyotp.random_base32()
    assert totp.match_counter(seed, "١٢٣٤٥٦", None) is None
    # Mixed ASCII and non-ASCII should also return None
    assert totp.match_counter(seed, "12345١", None) is None
