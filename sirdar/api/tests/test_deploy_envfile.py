from pathlib import Path

import pytest

from sirdar_api.deploy import envfile
from sirdar_api.deploy.envfile import EnvConfig, RenderError

ENV_EXAMPLE = Path(__file__).resolve().parents[3] / "deploy" / "stack" / "env.example"
SECRETS = {
    "POSTGRES_PASSWORD": "a1" * 32,
    "SPACES_SECRET_KEY": "b2" * 32,
    "SS_JWT_SECRET": "c3" * 32,
    "SS_TOTP_ENCRYPTION_KEY": "x" * 43 + "=",
    "SS_PASSWORD_PEPPER": "d4" * 32,
    "SS_WIKI_SERVICE_TOKEN": "e5" * 32,
}


def _cfg(**over) -> EnvConfig:
    kw = {"name": "uat", "domain": "uat.serversherpa.com", "image_tag": "e73b99ca",
              "proxy_ip": "10.10.48.6", "bind_ip": "0.0.0.0", "ports": dict(envfile.DEFAULT_PORTS),
              "keep_dumps": 5, "spaces_bucket": "serversherpa", "log_level": "INFO",
              "secrets": dict(SECRETS)}
    kw.update(over)
    return EnvConfig(**kw)


def _keys(text: str) -> list[str]:
    return [line.split("=", 1)[0] for line in text.splitlines()
            if line and not line.startswith("#")]


def test_rendered_keys_match_env_example_in_order():
    example = _keys(ENV_EXAMPLE.read_text())
    assert _keys(envfile.render_env(_cfg())) == example
    assert tuple(example) == envfile.KNOWN_KEYS


def test_render_values():
    text = envfile.render_env(_cfg(secrets={**SECRETS, "SS_ANTHROPIC_API_KEY": "sk-ant-1"}))
    assert text.startswith("# Written by Sirdar")
    assert text.endswith("\n")
    values = envfile.parse_env(text)
    assert values["STACK_ENV"] == "uat"
    assert values["STACK_DOMAIN"] == "uat.serversherpa.com"
    assert values["STACK_IMAGE_TAG"] == "e73b99ca"
    assert values["STACK_REPO_DIR"] == "/opt/serversherpa/uat/repo"
    assert values["STACK_PROXY_IP"] == "10.10.48.6"
    assert values["STACK_BIND_IP"] == "0.0.0.0"
    assert values["STACK_API_PORT"] == "8000"
    assert values["STACK_MAILPIT_PORT"] == "8025"
    assert values["STACK_KEEP_DUMPS"] == "5"
    assert values["SS_SPACES_BUCKET"] == "serversherpa"
    assert values["SS_LOG_LEVEL"] == "INFO"
    assert values["SS_ANTHROPIC_API_KEY"] == "sk-ant-1"
    assert values["SS_DB_TESTING_PASSWORD"] == ""
    for key, value in SECRETS.items():
        assert values[key] == value


def test_secrets_are_not_in_repr():
    assert SECRETS["POSTGRES_PASSWORD"] not in repr(_cfg())


def test_missing_secret_names_the_key_only():
    secrets = {k: v for k, v in SECRETS.items() if k != "SS_JWT_SECRET"}
    with pytest.raises(RenderError) as exc:
        envfile.render_env(_cfg(secrets=secrets))
    assert "SS_JWT_SECRET" in exc.value.reason
    for value in SECRETS.values():
        assert value not in str(exc.value)


@pytest.mark.parametrize("bad", ["a\nb", "a\rb", "a\x00b", "a b"])
def test_control_characters_refused(bad):
    with pytest.raises(RenderError) as exc:
        envfile.render_env(_cfg(secrets={**SECRETS, "SS_PASSWORD_PEPPER": bad}))
    assert "SS_PASSWORD_PEPPER" in exc.value.reason
    assert bad not in str(exc.value)


def test_placeholder_refused():
    with pytest.raises(RenderError) as exc:
        envfile.render_env(_cfg(secrets={**SECRETS, "POSTGRES_PASSWORD": "CHANGEME"}))
    assert "POSTGRES_PASSWORD" in exc.value.reason


def test_parse_env_rules():
    text = ("# comment\n\nSTACK_ENV=uat\r\nA='q v'\nB=\"x\"\nA=last\nlower=no\n"
            "  C=indented\nD=has=equals\n")
    assert envfile.parse_env(text) == {"STACK_ENV": "uat", "A": "last", "B": "x",
                                       "D": "has=equals"}


def test_parse_env_example():
    values = envfile.parse_env(ENV_EXAMPLE.read_text())
    assert values["STACK_ENV"] == "uat"
    assert values["POSTGRES_PASSWORD"] == "CHANGEME"


def test_helpers():
    assert envfile.env_dir("uat") == "/opt/serversherpa/uat"
    assert envfile.image_tag("e73b99ca" + "0" * 32) == "e73b99ca"
    assert envfile.unsafe_value("ok-value") is False
    assert envfile.unsafe_value("a\tb") is True
    assert set(envfile.SERVICES) == set(envfile.DEFAULT_PORTS) == set(envfile.PORT_KEYS)
    assert envfile.PUBLIC_SERVICES == envfile.SERVICES[:6]
    assert set(envfile.HEX_SECRETS) | set(envfile.FERNET_SECRETS) == set(envfile.REQUIRED_SECRETS)
