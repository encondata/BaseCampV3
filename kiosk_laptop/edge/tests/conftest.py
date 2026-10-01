import httpx
import pytest
import respx

from edge.app import create_app
from edge import sessions
from edge.config import Settings

CLOUD = "http://cloud.test"


@pytest.fixture
def settings(tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><div id=\"root\"></div>")
    (web / "assets" / "app.js").write_text("console.log('kiosk')")
    return Settings(cloud_api_url=CLOUD, portal_url="http://portal.test",
                    data_dir=tmp_path / "data", web_dir=web, background=False)


@pytest.fixture
def cloud():
    with respx.mock(base_url=CLOUD, assert_all_called=False) as router:
        yield router


@pytest.fixture
def app(settings, cloud):
    return create_app(settings)


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        yield c


def session_out(person_id="p-1", name="Jane Doe", max_rank=10, kiosk_move=None,
                access_token="cloud-access-1", email="jane@example.com"):
    """A cloud SessionOut, as /auth/login returns it."""
    return {
        "status": "ok", "access_token": access_token, "token_type": "bearer",
        "expires_in": 900, "session_expires_at": "2099-01-01T00:00:00Z",
        "person": {"id": person_id, "display_name": name, "first_name": name.split()[0],
                   "last_name": name.split()[-1], "email": email},
        "roles": ["worker"], "must_change_password": False, "must_change_reason": None,
        "password_expires_at": None, "preferences": {}, "perms": {"kiosk": {"view": True}},
        "max_rank": max_rank, "scope": {"global": False, "client_ids": [], "partner_ids": []},
        "password_min_length": 8,
        "totp": {"enrolled": False, "enrolled_at": None, "required": False,
                 "backup_codes_remaining": None},
        "kiosk_move": kiosk_move,
    }


def make_session(app, offline=False, **kw):
    out, _refresh = sessions.issue(app.state.store, app.state.keys,
                                   template=sessions.template_from(session_out(**kw)),
                                   offline=offline, expires_at="2099-01-01T00:00:00Z")
    return {"Authorization": f"Bearer {out['access_token']}"}
