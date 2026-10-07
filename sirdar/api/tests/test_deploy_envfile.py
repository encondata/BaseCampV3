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
    # the DigitalOcean extras follow, commented out in env.example
    assert tuple(example) + envfile.EXTRA_KEYS == envfile.KNOWN_KEYS


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


def test_extras_render_after_the_optional_secrets():
    text = envfile.render_env(_cfg(extra={"STACK_EXTERNAL_DATA": "1", "SS_DATABASE_SSL": "require",
                                          "STACK_DB_PORT": "25060"}))
    keys = _keys(text)
    assert keys[-3:] == ["STACK_EXTERNAL_DATA", "SS_DATABASE_SSL", "STACK_DB_PORT"]
    assert keys.index("SS_DB_TESTING_PASSWORD") < keys.index("STACK_EXTERNAL_DATA")
    assert envfile.parse_env(text)["STACK_DB_PORT"] == "25060"


@pytest.mark.parametrize("extra, reason", [
    ({"NOT_ALLOWED": "1"}, "unknown key NOT_ALLOWED"),
    ({"POSTGRES_PASSWORD": "x"}, "unknown key POSTGRES_PASSWORD"),
    ({"SS_DATABASE_URL": "a\nB=c"}, "SS_DATABASE_URL contains a control or line-break character"),
])
def test_extras_are_checked(extra, reason):
    with pytest.raises(RenderError) as err:
        envfile.render_env(_cfg(extra=extra))
    assert err.value.reason == reason


def test_extras_stay_out_of_repr():
    cfg = _cfg(extra={"SS_SPACES_SECRET_KEY": "spaces-SECRET"})
    assert "spaces-SECRET" not in repr(cfg)


def test_the_cluster_ca_rides_one_line_after_the_ssl_mode():
    keys = envfile.EXTRA_KEYS
    assert keys.index("SS_DATABASE_CA_B64") == keys.index("SS_DATABASE_SSL") + 1


def test_the_cert_worker_keys_close_the_extras():
    assert envfile.EXTRA_KEYS[-6:] == ("STACK_DROPLET_ID", "SS_CERT_DO_TOKEN", "SS_CERT_LB_ID",
                                       "SS_CERT_NAMES", "SS_CERT_ACME_DIRECTORY",
                                       "SS_CERT_ACME_KEY")
    text = ENV_EXAMPLE.read_text()
    for key in envfile.EXTRA_KEYS:
        assert f"# {key}=" in text or f" {key}=" in text, key     # listed, commented out


# ---- LAN Blue/Green (phase 8b): the data VM's .env ----

def _data_cfg(**kw):
    base = dict(name="lan9", domain="lan9.serversherpa.com", bind_ip="0.0.0.0", spaces_port=9000,
                mailpit_port=8025, keep_dumps=5, spaces_bucket="serversherpa", db_port=5432,
                allow=("10.10.48.48", "10.10.48.49"),
                secrets={k: f"{k.lower()}-value" for k in envfile.REQUIRED_SECRETS})
    return envfile.DataEnvConfig(**{**base, **kw})


def test_the_data_vm_env_has_only_the_data_secrets():
    secrets = {k: f"{k.lower()}-value" for k in envfile.REQUIRED_SECRETS}
    text = envfile.render_data_env(envfile.DataEnvConfig(
        name="lan9", domain="lan9.serversherpa.com", bind_ip="0.0.0.0", spaces_port=9000,
        mailpit_port=8025, keep_dumps=5, spaces_bucket="serversherpa", db_port=5432,
        allow=("10.10.48.48", "10.10.48.49"), secrets=secrets))
    values = envfile.parse_env(text)
    assert list(values) == list(envfile.DATA_KEYS)
    assert (values["STACK_DB_PUBLISH"], values["STACK_DB_ALLOW"]) == (
        "1", "10.10.48.48,10.10.48.49")
    assert values["POSTGRES_PASSWORD"] == "postgres_password-value"
    for key in ("SS_JWT_SECRET", "SS_PASSWORD_PEPPER", "SS_TOTP_ENCRYPTION_KEY",
                "SS_WIKI_SERVICE_TOKEN"):
        assert key not in values and secrets[key] not in text


def test_the_data_vm_env_refuses_a_bad_address():
    with pytest.raises(envfile.RenderError):
        envfile.render_data_env(envfile.DataEnvConfig(
            name="lan9", domain="lan9.serversherpa.com", bind_ip="0.0.0.0", spaces_port=9000,
            mailpit_port=8025, keep_dumps=5, spaces_bucket="serversherpa", db_port=5432,
            allow=("10.10.48.48\nX=1",),
            secrets={k: "v" for k in envfile.REQUIRED_SECRETS}))


@pytest.mark.parametrize("allow", [(), ("10.10.48.48", ""), ("10.10.48.48,10.10.48.49",),
                                   ("::1",), ("10.10.48.256",)])
def test_the_data_vm_env_refuses_other_allow_lists(allow):
    with pytest.raises(envfile.RenderError) as err:
        envfile.render_data_env(_data_cfg(allow=allow))
    assert "STACK_DB_ALLOW" in err.value.reason


@pytest.mark.parametrize("missing", ["POSTGRES_PASSWORD", "SPACES_SECRET_KEY"])
def test_the_data_vm_env_needs_the_data_secrets(missing):
    secrets = {k: "v" for k in envfile.REQUIRED_SECRETS if k != missing}
    with pytest.raises(envfile.RenderError) as err:
        envfile.render_data_env(_data_cfg(secrets=secrets))
    assert missing in err.value.reason


def test_the_data_vm_env_names_keys_never_values():
    secrets = {k: "v" for k in envfile.REQUIRED_SECRETS}
    secrets["POSTGRES_PASSWORD"] = "top\nsecret"
    with pytest.raises(envfile.RenderError) as err:
        envfile.render_data_env(_data_cfg(secrets=secrets))
    assert "POSTGRES_PASSWORD" in err.value.reason and "secret" not in err.value.reason
    assert "top" not in repr(_data_cfg(secrets=secrets))


def test_stack_db_sslmode_is_an_extra_key():
    assert "STACK_DB_SSLMODE" in envfile.EXTRA_KEYS
    assert envfile.EXTRA_KEYS.index("STACK_DB_SSLMODE") == \
        envfile.EXTRA_KEYS.index("STACK_DB_USER") + 1


@pytest.mark.parametrize("field, key", [("db_port", "STACK_DB_PORT"),
                                        ("spaces_port", "STACK_SPACES_PORT"),
                                        ("mailpit_port", "STACK_MAILPIT_PORT")])
@pytest.mark.parametrize("port", [0, 65536, 70000])
def test_the_data_vm_env_caps_its_ports(field, key, port):
    with pytest.raises(envfile.RenderError) as err:
        envfile.render_data_env(_data_cfg(**{field: port}))
    assert key in err.value.reason and "1-65535" in err.value.reason


def test_the_data_vm_env_takes_the_top_port():
    values = envfile.parse_env(envfile.render_data_env(_data_cfg(db_port=65535)))
    assert values["STACK_DB_PORT"] == "65535"


def test_apps_and_mail_keys():
    assert "SS_SMTP_PASSWORD" in envfile.OPTIONAL_SECRETS
    assert envfile.EXTRA_KEYS[:6] == ("STACK_APPS", "SS_SMTP_HOST", "SS_SMTP_PORT",
                                      "SS_SMTP_USERNAME", "SS_SMTP_STARTTLS", "SS_SMTP_FROM")
