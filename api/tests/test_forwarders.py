"""Pure transport builders + the config gate. Senders are exercised in
test_log_service_forwarding.py against live local endpoints."""

import base64
import json
from datetime import UTC, datetime

from serversherpa.system.forwarders import (
    build_loki_payload, build_syslog_frame, loki_headers,
    transport_configured,
)

AT = datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)


def _row(**over):
    row = {"process": "api", "level": "INFO", "levelno": 20,
           "logger": "serversherpa.x", "message": "hello", "extra": {},
           "at": AT}
    row.update(over)
    return row


def test_loki_payload_groups_by_process_and_level():
    rows = [_row(), _row(message="again"),
            _row(process="import-worker", level="ERROR", levelno=40,
                 message="boom")]
    payload = build_loki_payload(rows, "devbox")
    assert set(payload) == {"streams"}
    streams = {(s["stream"]["process"], s["stream"]["level"]): s
               for s in payload["streams"]}
    assert set(streams) == {("api", "INFO"), ("import-worker", "ERROR")}
    api_stream = streams[("api", "INFO")]
    assert api_stream["stream"] == {"app": "serversherpa", "process": "api",
                                    "level": "INFO", "host": "devbox"}
    ns = str(int(AT.timestamp() * 1_000_000_000))
    assert api_stream["values"] == [[ns, "serversherpa.x: hello"],
                                    [ns, "serversherpa.x: again"]]


def test_loki_line_without_logger_is_bare_message():
    payload = build_loki_payload([_row(logger="")], "devbox")
    assert payload["streams"][0]["values"][0][1] == "hello"


def test_loki_headers_auth_and_tenant():
    assert loki_headers({"url": "x", "username": "", "password": "",
                         "tenant_id": ""}) == {
        "Content-Type": "application/json"}
    headers = loki_headers({"url": "x", "username": "u", "password": "p",
                            "tenant_id": "team1"})
    assert headers["Authorization"] == \
        "Basic " + base64.b64encode(b"u:p").decode()
    assert headers["X-Scope-OrgID"] == "team1"


def test_syslog_frame_shape():
    frame = build_syslog_frame(_row(), "devbox").decode()
    # facility 16, severity 6 (INFO) -> PRI 134
    assert frame.startswith(f"<134>1 {AT.isoformat()} devbox "
                            "serversherpa-api - - - ")
    body = json.loads(frame.split(" - - - ", 1)[1])
    assert body == {"process": "api", "level": "INFO",
                    "logger": "serversherpa.x", "message": "hello",
                    "at": AT.isoformat(), "extra": {}}
    err = build_syslog_frame(_row(levelno=40), "devbox").decode()
    assert err.startswith("<131>1 ")            # 16*8 + 3 (ERROR)
    weird = build_syslog_frame(_row(levelno=25), "devbox").decode()
    assert weird.startswith("<134>1 ")          # unknown levelno -> 6


def _cfg(mode="local_remote", transport="loki", url="http://l:3100",
         host="siem.local"):
    return {"mode": mode, "transport": transport,
            "loki": {"url": url, "username": "", "password": "",
                     "tenant_id": ""},
            "syslog": {"host": host, "port": 514, "protocol": "udp"}}


def test_transport_configured_matrix():
    assert transport_configured(_cfg()) is True
    assert transport_configured(_cfg(mode="local")) is False
    assert transport_configured(_cfg(url="")) is False
    assert transport_configured(_cfg(transport="syslog")) is True
    assert transport_configured(_cfg(transport="syslog", host="")) is False
    assert transport_configured(_cfg(mode="remote")) is True


def test_defaults_grew_transport_keys():
    from serversherpa.system.config_store import DEFAULTS
    logging_defaults = DEFAULTS["logging"]
    assert logging_defaults["transport"] == "loki"
    assert logging_defaults["loki"] == {"url": "", "username": "",
                                        "password": "", "tenant_id": ""}
