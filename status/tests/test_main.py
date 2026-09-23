from serversherpa_status.__main__ import main


def test_main_disables_proxy_headers(monkeypatch):
    """No reverse proxy sits in front of this container's own port, and
    nothing in the app reads client IP or scheme — trusting forwarded
    headers here would let a client spoof them for no benefit."""
    calls = []
    monkeypatch.setattr(
        "serversherpa_status.__main__.uvicorn.run",
        lambda app, **kw: calls.append(kw),
    )
    monkeypatch.setenv("STATUS_API_URL", "http://api.test")
    monkeypatch.setenv("STATUS_PORTAL_URL", "http://portal.test")
    monkeypatch.setenv("STATUS_KIOSK_URL", "http://kiosk.test")
    main()
    assert len(calls) == 1
    assert calls[0]["proxy_headers"] is False
    assert "forwarded_allow_ips" not in calls[0]
