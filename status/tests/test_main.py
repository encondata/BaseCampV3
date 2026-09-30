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


def _settings(**extra):
    from serversherpa_status.config import load_settings

    return load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        **extra,
    })


def test_test_alert_exit_codes(capsys):
    import respx

    from serversherpa_status.__main__ import run_test_alert

    settings = _settings(STATUS_NTFY_TOPIC="t", STATUS_NTFY_SERVER="http://ntfy.test")
    with respx.mock:
        route = respx.post("http://ntfy.test/").respond(200)
        assert run_test_alert(settings) == 0
        assert route.call_count == 1
        respx.post("http://ntfy.test/").respond(500)
        assert run_test_alert(settings) == 1
    assert run_test_alert(_settings()) == 2
    assert capsys.readouterr().out
