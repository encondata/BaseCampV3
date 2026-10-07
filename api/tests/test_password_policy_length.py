"""The one password-length bar (SS_PASSWORD_MIN_LENGTH) shared by the API's
routes and the bootstrap-admin command."""

import pytest
from fastapi import HTTPException

from serversherpa.api.deps import require_password_length
from serversherpa.config import get_settings
from serversherpa.services.password_policy import length_problem


def test_length_problem_names_the_bar():
    bar = get_settings().password_min_length
    assert length_problem("x" * bar) is None
    assert length_problem("x" * (bar - 1)) == bar
    assert length_problem("") == bar


def test_the_route_gate_uses_the_same_rule():
    bar = get_settings().password_min_length
    require_password_length("y" * bar)
    with pytest.raises(HTTPException) as e:
        require_password_length("y" * (bar - 1))
    assert e.value.status_code == 422
    assert e.value.detail == {"code": "password_too_short", "min_length": bar}


def test_the_bar_follows_the_setting(monkeypatch):
    monkeypatch.setenv("SS_PASSWORD_MIN_LENGTH", "12")
    get_settings.cache_clear()
    try:
        assert length_problem("z" * 11) == 12
        assert length_problem("z" * 12) is None
    finally:
        get_settings.cache_clear()
