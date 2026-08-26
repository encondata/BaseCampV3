"""Logging-config shaping shared by the API routes: masking (the Loki
password never leaves the server), the PUT password keep-rule, and
validation. Pure — no I/O."""

import copy

MODES = ("local", "local_remote", "remote")
TRANSPORTS = ("loki", "syslog")
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
PROTOCOLS = ("udp", "tcp", "tls")
ROW_CAP_RANGE = (1000, 1_000_000)
AGE_RANGE = (1, 365)


def mask_logging(cfg: dict) -> dict:
    masked = copy.deepcopy(cfg)
    loki = masked.setdefault("loki", {})
    loki["password_set"] = bool(loki.pop("password", ""))
    return masked


def apply_password_rule(incoming: dict, stored: dict) -> dict:
    data = copy.deepcopy(incoming)
    loki = data.setdefault("loki", {})
    loki.pop("password_set", None)
    if not loki.get("password"):
        loki["password"] = stored.get("loki", {}).get("password", "")
    return data


def _int_in(value, lo, hi) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) \
        and lo <= value <= hi


def validate_logging(cfg: dict) -> dict[str, str]:
    errors: dict[str, str] = {}
    if cfg.get("mode") not in MODES:
        errors["mode"] = "must be local, local_remote, or remote"
    if cfg.get("transport", "loki") not in TRANSPORTS:
        errors["transport"] = "must be loki or syslog"
    if not _int_in(cfg.get("local_max_rows_per_process"), *ROW_CAP_RANGE):
        errors["local_max_rows_per_process"] = \
            f"must be an integer {ROW_CAP_RANGE[0]}–{ROW_CAP_RANGE[1]}"
    if not _int_in(cfg.get("remote_buffer_rows"), *ROW_CAP_RANGE):
        errors["remote_buffer_rows"] = \
            f"must be an integer {ROW_CAP_RANGE[0]}–{ROW_CAP_RANGE[1]}"
    if not _int_in(cfg.get("local_max_age_days"), *AGE_RANGE):
        errors["local_max_age_days"] = \
            f"must be an integer {AGE_RANGE[0]}–{AGE_RANGE[1]}"
    if cfg.get("min_level") not in LEVELS:
        errors["min_level"] = "must be a log level name"

    remote = cfg.get("mode") in ("local_remote", "remote")
    transport = cfg.get("transport", "loki")
    if remote and transport == "loki":
        url = cfg.get("loki", {}).get("url", "")
        if not (isinstance(url, str)
                and url.startswith(("http://", "https://"))):
            errors["loki.url"] = "must be an http(s) URL"
    if remote and transport == "syslog":
        syslog = cfg.get("syslog", {})
        if not syslog.get("host"):
            errors["syslog.host"] = "required for syslog forwarding"
        if not _int_in(syslog.get("port"), 1, 65535):
            errors["syslog.port"] = "must be 1–65535"
        if syslog.get("protocol") not in PROTOCOLS:
            errors["syslog.protocol"] = "must be udp, tcp, or tls"
    return errors
