"""rate_limit_ip in isolation: which address it picks for a given peer +
X-Forwarded-For, without spinning up the app or a DB. See
test_kiosk_pairing_api.py for the same rules exercised end to end."""

from serversherpa.api.deps import rate_limit_ip


class _Client:
    def __init__(self, host):
        self.host = host


class _Request:
    """Just enough of fastapi.Request for rate_limit_ip to read."""

    def __init__(self, *, host, headers=None):
        self.client = _Client(host) if host else None
        self.headers = headers or {}


def test_public_peer_with_header_uses_the_peer():
    # 8.8.8.8 is a real public address, unlike 203.0.113.0/24 (TEST-NET-3),
    # which ipaddress.is_private treats as private (RFC 5737 reserved range).
    req = _Request(host="8.8.8.8", headers={"x-forwarded-for": "1.2.3.4, 5.6.7.8"})
    assert rate_limit_ip(req) == "8.8.8.8"


def test_loopback_peer_with_valid_header_uses_the_rightmost_entry():
    req = _Request(host="127.0.0.1", headers={"x-forwarded-for": "1.2.3.4, 203.0.113.9"})
    assert rate_limit_ip(req) == "203.0.113.9"


def test_loopback_peer_with_invalid_rightmost_entry_falls_back_to_peer():
    req = _Request(host="127.0.0.1", headers={"x-forwarded-for": "203.0.113.9, not-an-ip"})
    assert rate_limit_ip(req) == "127.0.0.1"


def test_no_client_and_no_header_is_unknown():
    req = _Request(host=None)
    assert rate_limit_ip(req) == "unknown"
