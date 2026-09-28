"""Spec lookup env settings: defaults, and tests never carry a real key."""
from serversherpa.config import Settings, get_settings


def test_defaults():
    s = Settings(_env_file=None)
    assert s.anthropic_api_key.get_secret_value() == ""
    assert s.spec_lookup_model == "claude-sonnet-5"
    assert s.spec_lookup_max_searches == 4
    assert s.spec_lookup_max_fetches == 3


def test_suite_never_has_a_real_key():
    assert get_settings().anthropic_api_key.get_secret_value() == ""
