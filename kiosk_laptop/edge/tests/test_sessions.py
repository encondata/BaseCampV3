import jwt

from edge import sessions
from tests.conftest import session_out


def _issue(app, **kw):
    return sessions.issue(app.state.store, app.state.keys,
                          template=sessions.template_from(session_out(**kw)),
                          offline=False, expires_at="2099-01-01T00:00:00Z")


def test_issue_returns_sessionout_shape_with_edge_token(app):
    out, refresh = _issue(app)
    assert out["status"] == "ok" and out["token_type"] == "bearer"
    assert out["expires_in"] == sessions.ACCESS_TTL_S
    assert out["access_token"] != "cloud-access-1"
    assert out["person"]["id"] == "p-1"
    assert out["session_expires_at"] == "2099-01-01T00:00:00+00:00"
    assert refresh


def test_access_token_resolves_to_session(app):
    out, _ = _issue(app, max_rank=60)
    s = sessions.from_access_token(app.state.store, app.state.keys, out["access_token"])
    assert s.person_id == "p-1" and s.max_rank == 60 and s.offline is False
    assert s.person_name == "Jane Doe"


def test_foreign_or_tampered_tokens_rejected(app):
    bad = jwt.encode({"sid": "x", "typ": "edge", "exp": 9999999999}, "other-key-that-is-at-least-32-bytes!", algorithm="HS256")
    assert sessions.from_access_token(app.state.store, app.state.keys, bad) is None
    assert sessions.from_access_token(app.state.store, app.state.keys, "cloud-access-1") is None


def test_refresh_rotates_and_old_refresh_dies(app):
    _, r1 = _issue(app)
    out, r2 = sessions.refresh(app.state.store, app.state.keys, r1)
    assert out["person"]["id"] == "p-1" and r2 != r1
    assert sessions.refresh(app.state.store, app.state.keys, r1) is None


def test_revoke_kills_access_and_refresh(app):
    out, r1 = _issue(app)
    ended = sessions.revoke(app.state.store, r1)
    assert ended.person_id == "p-1"
    assert sessions.from_access_token(app.state.store, app.state.keys, out["access_token"]) is None
    assert sessions.refresh(app.state.store, app.state.keys, r1) is None
    assert sessions.has_live_session(app.state.store, "p-1") is False


def test_move_id_from_kiosk_move(app):
    out, _ = _issue(app, kiosk_move={"initiative_id": "m-1", "name": "Move"})
    s = sessions.from_access_token(app.state.store, app.state.keys, out["access_token"])
    assert s.move_id == "m-1"
