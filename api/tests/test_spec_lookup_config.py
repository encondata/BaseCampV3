"""Spec lookup env settings: defaults, and tests never carry a real key."""
from serversherpa.config import Settings, get_settings


def test_defaults():
    f = Settings.model_fields
    assert f["anthropic_api_key"].default.get_secret_value() == ""
    assert f["spec_lookup_model"].default == "claude-sonnet-5"
    assert "spec_lookup_max_searches" not in f and "spec_lookup_max_fetches" not in f


def test_suite_never_has_a_real_key():
    assert get_settings().anthropic_api_key.get_secret_value() == ""
