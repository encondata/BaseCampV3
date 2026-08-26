"""Pure config shaping: masking, password keep-rule, validation."""

from serversherpa.system.config_store import DEFAULTS
from serversherpa.system.logging_config import (
    apply_password_rule, mask_logging, validate_logging,
)


def _cfg(**over):
    cfg = {**DEFAULTS["logging"]}
    cfg["loki"] = {**cfg["loki"]}
    cfg["syslog"] = {**cfg["syslog"]}
    for key, value in over.items():
        if isinstance(value, dict):
            cfg[key] = {**cfg[key], **value}
        else:
            cfg[key] = value
    return cfg


def test_mask_hides_password():
    masked = mask_logging(_cfg(loki={"password": "hunter2"}))
    assert "password" not in masked["loki"]
    assert masked["loki"]["password_set"] is True
    assert mask_logging(_cfg())["loki"]["password_set"] is False


def test_password_rule_keeps_and_replaces():
    stored = _cfg(loki={"password": "old"})
    kept = apply_password_rule(_cfg(loki={"password": ""}), stored)
    assert kept["loki"]["password"] == "old"
    replaced = apply_password_rule(_cfg(loki={"password": "new"}), stored)
    assert replaced["loki"]["password"] == "new"
    # password_set from a GET round-trip never persists
    via_get = apply_password_rule(
        {**_cfg(), "loki": {**_cfg()["loki"], "password_set": True}}, stored)
    assert "password_set" not in via_get["loki"]


def test_validate_accepts_defaults_and_good_remote():
    assert validate_logging(_cfg()) == {}
    assert validate_logging(_cfg(
        mode="local_remote", loki={"url": "http://loki:3100"})) == {}
    assert validate_logging(_cfg(
        mode="remote", transport="syslog",
        syslog={"host": "wazuh.local"})) == {}


def test_validate_rejects_bad_fields():
    assert "mode" in validate_logging(_cfg(mode="sometimes"))
    assert "transport" in validate_logging(_cfg(transport="carrier-pigeon"))
    assert "min_level" in validate_logging(_cfg(min_level="LOUD"))
    assert "local_max_rows_per_process" in validate_logging(
        _cfg(local_max_rows_per_process=10))
    assert "local_max_age_days" in validate_logging(
        _cfg(local_max_age_days=0))
    assert "loki.url" in validate_logging(_cfg(mode="local_remote"))
    assert "loki.url" in validate_logging(
        _cfg(mode="remote", loki={"url": "ftp://nope"}))
    assert "syslog.host" in validate_logging(
        _cfg(mode="remote", transport="syslog", syslog={"host": ""}))
    assert "syslog.port" in validate_logging(
        _cfg(mode="remote", transport="syslog",
             syslog={"host": "x", "port": 70000}))
    assert "syslog.protocol" in validate_logging(
        _cfg(mode="remote", transport="syslog",
             syslog={"host": "x", "protocol": "smoke-signal"}))
    # local mode skips transport requireds
    assert validate_logging(_cfg(mode="local")) == {}


def test_null_sections_do_not_crash():
    stored = _cfg(loki={"password": "old"})
    # PUT bodies where optional objects were serialized as null
    data = apply_password_rule({**_cfg(), "loki": None}, stored)
    assert data["loki"]["password"] == "old"
    assert validate_logging({**_cfg(mode="local_remote"), "loki": None}) \
        .get("loki.url")
    assert validate_logging({**_cfg(mode="remote", transport="syslog"),
                             "syslog": None}).get("syslog.host")
