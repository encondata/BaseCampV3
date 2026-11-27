"""String checks on the page's files, and that the real app serves them. No browser."""

import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from loadtest.web.app import create_app

STATIC = Path(__file__).resolve().parents[1] / "src" / "loadtest" / "web" / "static"
ROUTES = ("/api/state", "/api/connect", "/api/check", "/api/start", "/api/stop",
          "/api/continue", "/api/discard", "/api/result", "/api/events", "/api/sites",
          "/api/setup")
POST_ROUTES = ("/api/connect", "/api/check", "/api/start", "/api/stop", "/api/continue",
               "/api/discard", "/api/setup")


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
    assert '<h1 class="page-title" id="gen-title" tabindex="-1">Generate</h1>' in page.text
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


def test_the_only_outside_requests_are_the_fonts_and_they_never_block():
    page = read("index.html")
    hosts = set(re.findall(r"https?://([^/\"'\s]+)", page))
    # the server field's placeholder is a format hint, not a request
    hosts -= {"api.example.com"}
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


# ── fix round 1 ────────────────────────────────────────────────────────

SRC = Path(__file__).resolve().parents[1] / "src" / "loadtest"


def recorded_call_names() -> set[str]:
    """Every call name the clients record, read from their source."""
    names: set[str] = set()
    for path in (SRC / "client" / "kiosk.py", SRC / "client" / "portal.py"):
        code = path.read_text(encoding="utf-8")
        names |= set(re.findall(r'\bname(?::\s*str)?\s*=\s*"([a-z][a-z-]*)"', code))
        names |= set(re.findall(r'metrics\.record\("([a-z][a-z-]*)"', code))
        names |= set(re.findall(r'\("/kiosk/[^"]*",\s*"([a-z][a-z-]*)",', code))      # scan batches
        names |= set(re.findall(r'self\._(?:container|truck)\("([a-z]+)"', code))       # pack/load…
    return names


def test_every_recorded_call_has_a_plain_name():
    js = read("simulate.js")
    names = recorded_call_names()
    assert {"portal-read", "station-scans", "scans", "pack", "unpack", "load", "unload",
            "enroll", "sync", "db-health"} <= names          # the reader finds them all
    for name in names:
        assert re.search(r"\['" + re.escape(name) + r"', '[A-Z][^']+'\]", js), name
    assert "'The move'" in js and "'Background and checks'" in js


def test_wording_of_round_one():
    page, js = read("index.html"), read("simulate.js")
    assert "afterwards" not in page and "afterwards" not in js
    assert "It cannot be continued afterward." in page
    assert "Standalone · runs on this machine" in page
    assert "local only" not in page
    assert "No problems found." in js
    assert "% of the move · " in js
    assert "Starting ${fmtN(snap.devices)} devices…" in js
    assert "furthest: ${t.furthest.name}, ${t.furthest.percent}% of route" in js
    assert "connect again" not in js


def test_no_formatter_returns_blank_for_an_unknown_value():
    js = without_comments(read("simulate.js"))
    # the table formatters give an en dash for null; only the feed's own time column
    # (blank on the runner's lines, which have no time) may be empty
    blanks = re.findall(r"const (\w+) = v => \(v == null \? '' :", js)
    assert blanks == ["feedMs"]
    assert "const ms = v => (v == null ? DASH :" in js


def test_errors_from_a_proxy_count_as_not_answering():
    js = without_comments(read("simulate.js"))
    assert "res.status >= 500" in js
    assert "Date.now() - lastOpen < RETRY_MS" in js      # a closed stream reopens slowly
    assert "if (priority || mine < appliedSeq) return;" in js   # no older state over a newer one


# ── fix round 2 ────────────────────────────────────────────────────────


def test_an_action_error_is_kept_and_painted_by_every_render():
    js = without_comments(read("simulate.js"))
    render = js[js.index("function render() {"):js.index("function focusView(")]
    assert "paintErrors();" in render
    assert "keepError(banners, err.message || INTERNAL);" in js
    # the failure path reads the state first, so the error lands on the view it left
    catch = js[js.index("async function act("):js.index("const UNF_FIELDS")]
    assert catch.index("await refresh(true);") < catch.index("keepError(")
    assert "const CHECK_BANNERS = ['sim-ready-err', 'sim-check-err'];" in js
    assert "document.addEventListener('input'" in js
    assert "showErr(" not in js.replace("function showErr(", "").replace(
        "BANNERS.forEach(id => showErr(", "")


def test_the_state_read_after_an_action_wins_over_the_stream():
    js = without_comments(read("simulate.js"))
    assert "if (s && !priority)" in js
    assert "await refresh();" not in js          # every follow-up read is the priority one


def test_a_stage_bar_is_full_only_when_the_stage_is_done():
    js = read("simulate.js")
    assert "if (s.total > 0 && s.done >= s.total) return 100;" in js
    assert "Math.min(99, Math.floor(raw))" in js
    assert "Math.round(s.percent)" not in js


def test_run_facts_counts_use_the_en_dash():
    js = read("simulate.js")
    assert "`${count(run.servers)} / ${count(run.containers)} / ${count(run.trucks)}`" in js


def test_the_tools_own_internal_error_shows_its_message_in_the_notice():
    js = read("simulate.js")
    assert "toolSilent(ours && data.code === 'internal' && data.message ? data.message : OFFLINE);" in js
    assert "stateDown ? downMessage : OFFLINE" in js


def test_run_facts_show_the_clock_difference():
    js = read("simulate.js")
    assert "['Clock difference', clockDifference(r.clock_offset_seconds)]," in js
    assert "'Not measured; scan delay uses this machine’s clock'" in js
    assert "${seconds < 0 ? 'behind' : 'ahead of'} this machine’s" in js


def test_no_request_to_the_tool_can_hold_the_page():
    js = without_comments(read("simulate.js"))
    assert "const WAIT_MS = 10000;" in js
    assert js.count("signal: wait.signal") == 2          # both fetch helpers
    assert js.count("wait.done();") == 2
    assert "LONG_POSTS.includes(path) ? LONG_WAIT_MS : WAIT_MS" in js
    assert "setTimeout(() => stop.abort(), ms)" in js


def test_the_container_scan_line_says_what_covers_them():
    js = read("simulate.js")
    assert "b.catch_up_seconds != null" in js
    assert "': not checked one by one; covered by the backlog reaching zero.'" in js
    assert ("': not checked one by one. The backlog did not reach zero, so they are not "
            "confirmed.'") in js


def test_no_unused_helpers():
    js = read("simulate.js")
    assert "const percent =" not in js


# ── Generate: the tool creates the move on the server ─────────────────


def generate_view(page: str) -> str:
    return page[page.index('<section id="view-generate"'):page.index('<section id="view-simulate"')]


def test_the_old_file_builders_are_gone():
    page = read("index.html")
    for gone in ("ft-form", "sw-form", "From-To list", "Switch From-To", "Download .xlsx",
                 "zipStore", "generateFT", "generateSW", "schemas.openxmlformats.org",
                 "sends nothing anywhere"):
        assert gone not in page, gone
    # the inline script is the theme switch and the view routing, nothing else
    inline = page[page.index("<script>"):page.index("</script>")]
    assert "'data-generator.theme'" in inline                 # the sign-in page's key
    assert "localStorage.setItem(THEME_KEY" in inline and "showView" in inline
    assert "fetch(" not in inline and "innerHTML" not in inline


def test_generate_has_exactly_the_briefs_inputs():
    view = generate_view(read("index.html"))
    ids = re.findall(r'<(?:input|select)[^>]*\bid="([^"]+)"', view)
    assert ids == ["gen-name", "gen-origin", "gen-destination", "gen-servers", "gen-containers",
                   "gen-trucks", "gen-move-password"]
    buttons = re.findall(r'<button[^>]*>', view)
    assert len(buttons) == 2                         # Start (back) and Create
    assert re.search(r'<button[^>]*type="submit"[^>]*id="gen-go"[^>]*>Create</button>', view)
    # step 1 is the Simulate view's own sign-in card, moved in by simulate.js
    assert 'id="gen-signin"' in view and "sim-connect" not in view
    assert "Step 2 · Create the move" in view
    # the button sits in the sticky strip, so it never hides below a scroll
    assert view.index('class="sim-stick"') < view.index('id="gen-go"')


def test_the_generated_move_password_is_visible_and_never_autofilled():
    view = generate_view(read("index.html"))
    tag = re.search(r'<input[^>]*id="gen-move-password"[^>]*>', view).group(0)
    assert 'type="text"' in tag and 'autocomplete="off"' in tag
    js = without_comments(read("simulate.js"))
    assert "crypto.getRandomValues(" in js and "Math.random" not in js
    # handed to Simulate's move password field in memory, never to storage
    assert re.search(r"\$\('sim-move-password'\)\.value = \w+", js)


def test_one_sign_in_serves_both_views():
    js = without_comments(read("simulate.js"))
    assert re.search(r"\$\('gen-signin'\)\.append\(\$\('sim-connect'\)\)", js)
    assert re.search(r"\$\('sim-setup'\)\.prepend\(\$\('sim-connect'\)\)", js)
    assert "'gen-notices'" in js                    # "not answering" shows on Generate too
    render = js[js.index("function render() {"):js.index("function focusView(")]
    assert "renderConnect()" in render and "renderGenerate()" in render


def test_connect_is_locked_while_a_run_is_active():
    js = without_comments(read("simulate.js"))
    line = next(l for l in js.splitlines() if "$('sim-connect-go').disabled =" in l)
    assert "ACTIVE.includes(snap.phase)" in line


def test_a_site_with_no_location_cannot_be_picked_and_says_why():
    js = without_comments(read("simulate.js"))
    fill = js[js.index("function fillSites() {"):js.index("const autoCounts")]
    assert "disabled = !site.has_location" in fill
    assert "(no map location)" in fill


def test_the_set_up_follows_the_snapshot():
    js = without_comments(read("simulate.js"))
    for step in ("draft", "assets", "crates_trucks", "create", "verify", "activate"):
        assert f"'{step}'" in js, step
    assert "s.step_label" in js
    # finished: Simulate opens on the new move; nothing else is started for him
    follow = js[js.index("function followSetup() {"):js.index("let sites = null")]
    assert "s.move_id" in follow and "location.hash = 'simulate'" in follow
    assert "post(" not in follow
    # an error leaves every typed value alone; only an empty password field is refilled
    error = follow[follow.index("if (s.state !== 'done')"):follow.index("madeMove =")]
    assert "gen-name" not in error and "gen-containers" not in error
    assert "if (!$('gen-move-password').value)" in error
    # a failed set-up's message shows until the next one starts
    assert "snap.setup.message" in js


def test_containers_and_trucks_follow_the_servers_from_the_profile():
    js = without_comments(read("simulate.js"))
    assert "sizes.container_size" in js and "sizes.containers_per_truck" in js
    assert "Math.ceil(" in js
    assert "window.loadtestSizes" not in js
    # only typing the servers recomputes them, never a snapshot or an error
    assert re.findall(r"followServers\b", js).count("followServers") == 2   # defined, bound


def test_the_sites_read_and_the_setup_post_get_the_long_deadline():
    js = without_comments(read("simulate.js"))
    posts = re.search(r"const LONG_POSTS = \[([^\]]*)\]", js).group(1)
    gets = re.search(r"const LONG_GETS = \[([^\]]*)\]", js).group(1)
    assert "'/api/setup'" in posts and "'/api/sites'" in gets
    assert re.findall(r"(\w+)\('/api/sites'", js) == ["get"]
