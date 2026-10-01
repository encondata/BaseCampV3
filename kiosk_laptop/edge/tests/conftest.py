import httpx
import pytest
import respx

from edge.app import create_app
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
