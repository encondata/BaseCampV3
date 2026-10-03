import re

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError

from sirdar_api.deploy import envfile, vault

from .test_scaffold import _settings

KEY = Fernet.generate_key().decode()


def test_round_trip_and_ciphertext_hides_the_value():
    s = _settings(secrets_key=KEY)
    token = vault.encrypt(s, "pg-SECRET-123")
    assert isinstance(token, bytes)
    assert b"pg-SECRET-123" not in token
    assert vault.decrypt(s, token) == "pg-SECRET-123"
    assert vault.decrypt(s, memoryview(token)) == "pg-SECRET-123"


def test_missing_key():
    s = _settings(secrets_key="")
    assert s.secrets_key is None
    assert vault.is_configured(s) is False
    with pytest.raises(vault.SecretsKeyMissing):
        vault.encrypt(s, "x")
    with pytest.raises(vault.SecretsKeyMissing):
        vault.decrypt(s, b"x")
    assert vault.is_configured(_settings(secrets_key=KEY)) is True


def test_wrong_key_is_unreadable():
    token = vault.encrypt(_settings(secrets_key=KEY), "value")
    other = _settings(secrets_key=Fernet.generate_key().decode())
    with pytest.raises(vault.SecretUnreadable):
        vault.decrypt(other, token)


def test_settings_validate_the_key_and_new_defaults():
    with pytest.raises(ValidationError) as exc:
        _settings(secrets_key="not-a-fernet-key")
    assert "SIRDAR_SECRETS_KEY must be a Fernet key" in str(exc.value)
    assert "not-a-fernet-key" not in str(exc.value)
    s = _settings()
    assert s.runner_dir == "/app/runner"
    assert s.deploy_repo_url == "https://github.com/encondata/BaseCampV3.git"
    for bad in ("http://github.com/x.git", "https://github.com/x y.git", "git@github.com:x.git"):
        with pytest.raises(ValidationError) as bad_exc:
            _settings(deploy_repo_url=bad)
        assert bad not in str(bad_exc.value)


def test_generated_env_secrets():
    a, b = vault.generate_env_secrets(), vault.generate_env_secrets()
    assert set(a) == set(envfile.REQUIRED_SECRETS)
    for key in envfile.HEX_SECRETS:
        assert re.fullmatch(r"[0-9a-f]{64}", a[key])
        assert a[key] != b[key]
    for key in envfile.FERNET_SECRETS:
        Fernet(a[key].encode())          # a valid Fernet key
        assert a[key] != b[key]
