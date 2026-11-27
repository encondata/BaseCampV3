"""String checks on the page's files, and that the real app serves them. No browser."""

import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from loadtest.web.app import create_app

STATIC = Path(__file__).resolve().parents[1] / "src" / "loadtest" / "web" / "static"
ROUTES = ("/api/state", "/api/connect", "/api/check", "/api/start", "/api/stop",
          "/api/continue", "/api/discard", "/api/result", "/api/events")
POST_ROUTES = ("/api/connect", "/api/check", "/api/start", "/api/stop", "/api/continue",
               "/api/discard")


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def without_comments(js: str) -> str:
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", js)


@pytest.fixture
async def client():
    app = create_app(SimpleNamespace())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app),
                                 base_url="http://localhost") as c:
        yield c


# ── what is served ─────────────────────────────────────────────────────


async def test_page_keeps_generate_and_drops_coming_later(client):
    page = await client.get("/")
    assert page.status_code == 200
    assert '<h1 class="page-title">Generate</h1>' in page.text
    assert "What do you want to do?" in page.text
    assert "Coming later" not in page.text
    assert 'data-go="simulate"' in page.text
    assert '<h1 class="page-title" id="sim-title" tabindex="-1">Simulate</h1>' in page.text


@pytest.mark.parametrize("name, kind", [("simulate.js", "javascript"), ("simulate.css", "css")])
async def test_the_app_serves_the_page_files(client, name, kind):
    got = await client.get(f"/static/{name}")
    assert got.status_code == 200
    assert kind in got.headers["content-type"]
    assert got.text == read(name)


def test_index_loads_the_page_files_by_root_relative_url():
    page = read("index.html")
    assert '<link rel="stylesheet" href="/static/simulate.css">' in page
    assert '<script src="/static/simulate.js"></script>' in page


def test_generate_gains_the_containers_and_trucks_line():
    page = read("index.html")
    assert "Containers needed: ${fmt(containers)} · Trucks needed: ${fmt(trucks)}" in page
    assert "(20 per container, 15 containers per truck)" in page
    assert "Math.ceil(res.rows.length / 20)" in page
    assert "Math.ceil(containers / 15)" in page


def test_the_only_outside_requests_are_the_fonts_and_they_never_block():
    page = read("index.html")
    hosts = set(re.findall(r"https?://([^/\"'\s]+)", page))
    # the xlsx writer's XML namespaces are names, and the server field's placeholder is a
    # format hint: neither is a request
    hosts -= {"schemas.openxmlformats.org", "api.example.com"}
    assert 'placeholder="https://api.example.com"' in page
    assert hosts == {"fonts.googleapis.com", "fonts.gstatic.com"}
    sheet = re.search(r'<link[^>]+fonts\.googleapis\.com/css2[^>]*>', page).group(0)
    assert 'media="print"' in sheet and "onload=" in sheet
    assert "-apple-system" in page and "ui-monospace" in page     # fallbacks offline


def test_password_fields_are_never_autofilled():
    page = read("index.html")
    inputs = re.findall(r"<input[^>]*>", page)
    secret = [i for i in inputs if 'type="password"' in i]
    assert len(secret) == 4    # portal password, move password, and both again for Continue
    for tag in secret:
        assert 'autocomplete="off"' in tag
    for field in ("sim-totp", "sim-c-totp"):
        tag = next(i for i in inputs if f'id="{field}"' in i)
        assert 'autocomplete="off"' in tag


# ── simulate.js ────────────────────────────────────────────────────────


def test_simulate_js_uses_every_route():
    js = read("simulate.js")
    for route in ROUTES:
        assert f"'{route}'" in js, route


def test_every_post_goes_through_the_one_helper_that_sends_the_header():
    js = without_comments(read("simulate.js"))
    fetches = [m.start() for m in re.finditer(r"\bfetch\(", js)]
    assert len(fetches) == 2                        # one GET helper, one POST helper
    posts = [i for i in fetches if "'POST'" in js[i:i + 300]]
    assert len(posts) == 1
    call = js[posts[0]:posts[0] + 300]
    assert "'X-Loadtest': '1'" in call
    assert "'Content-Type': 'application/json'" in call
    for route in POST_ROUTES:
        uses = re.findall(r"(\w+)\('" + re.escape(route) + "'", js)
        assert uses and set(uses) == {"post"}, (route, uses)
    assert "method: 'POST'" not in js.replace(js[posts[0]:posts[0] + 300], "")


def test_no_browser_dialogs():
    js = without_comments(read("simulate.js"))
    assert not re.search(r"\b(confirm|alert|prompt)\(", js)


def test_no_secret_is_ever_stored():
    js = without_comments(read("simulate.js"))
    writes = re.findall(r"(?:localStorage|sessionStorage)\.setItem\(([^;]*)\)", js)
    assert writes, "the server, email and speed are remembered"
    for args in writes:
        assert not re.search(r"password|totp", args, re.I), args
    assert "sessionStorage" not in js
    assert "document.cookie" not in js
    # setItem is reached only through remember(), whose keys are the three allowed ones
    remembered = set(re.findall(r"remember\('(\w+)'", js))
    assert remembered == {"server", "email", "speed"}


def test_no_absolute_urls_in_the_page_files():
    for name in ("simulate.js", "simulate.css"):
        assert not re.search(r"https?://", read(name)), name


def test_the_feed_is_bounded_and_batched():
    js = read("simulate.js")
    assert "FEED_MAX = 500" in js
    assert "requestAnimationFrame(" in js
    assert "new EventSource('/api/events')" in js


def test_untrusted_text_is_never_written_as_html():
    js = without_comments(read("simulate.js"))
    assert "innerHTML" not in js and "insertAdjacentHTML" not in js


# ── simulate.css ───────────────────────────────────────────────────────


def test_simulate_css_has_no_color_literals():
    css = re.sub(r"/\*.*?\*/", "", read("simulate.css"), flags=re.S)
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b", css)
    assert not re.search(r"\brgba?\(\s*\d", css)
    assert not re.search(r"\bhsla?\(", css)
    # every color it sets comes from the page's tokens
    for value in re.findall(r"(?:^|[;{\s])(?:color|background|border-color)\s*:\s*([^;}]+)",
                            css):
        assert "var(--" in value or value.strip() in ("transparent", "none", "inherit", "0"), \
            value


def test_status_tokens_live_in_both_themes():
    page = read("index.html")
    light = page[page.index(":root {"):page.index(":root[data-theme='dark']")]
    dark = page[page.index(":root[data-theme='dark']"):page.index("* { box-sizing")]
    for token in ("--c-green", "--c-green-bg", "--c-green-bd", "--c-amber", "--c-amber-bg",
                  "--c-amber-bd"):
        assert f"{token}:" in light and f"{token}:" in dark, token
