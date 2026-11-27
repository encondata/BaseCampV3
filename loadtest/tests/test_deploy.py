"""Running the tool in a container: the address people open it by, the page's sign-in
from the environment, and the Docker files themselves."""

import re
import socket
from pathlib import Path

import pytest
import uvicorn

from loadtest import __main__ as cli
from loadtest.web import app as web

ROOT = Path(__file__).resolve().parents[1]
EVERYONE = "Everyone signs in, on this machine too."


def free_port() -> int:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


@pytest.fixture
def start(monkeypatch, tmp_path, capsys):
    """Runs main() up to the point where it would serve; returns what it printed and the
    arguments it built the app with."""
    for name in ("LOADTEST_PUBLIC_URL", "LOADTEST_USERNAME", "LOADTEST_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    real = web.create_app

    class Fake(uvicorn.Server):
        def run(self, sockets=None):
            for s in sockets or ():
                s.close()

    monkeypatch.setattr(uvicorn, "Server", Fake)

    def go(*extra: str) -> tuple[list[str], dict]:
        seen: dict = {}

        def spy(runner, **kwargs):
            seen.update(kwargs)
            return real(runner, **kwargs)

        monkeypatch.setattr(web, "create_app", spy)
        cli.main(["--host", "127.0.0.1", "--port", str(free_port()),
                  "--runs-dir", str(tmp_path / "runs"), *extra])
        return capsys.readouterr().out.splitlines(), seen

    return go


# ── the address people open the page by ────────────────────────────────


def test_a_public_address_is_allowed_and_printed_and_everyone_signs_in(start):
    out, seen = start("--public-url", "https://Loadtest.Example.com/")
    assert "loadtest.example.com" in seen["allowed_hosts"]
    assert seen["local_skip"] is False          # everyone arrives through the container
    assert seen["secure_cookie"] is True        # https: the session cookie stays there
    assert seen["sign_in"].matches("admin", "password123")
    assert out == ["Move load test: https://loadtest.example.com", EVERYONE,
                   cli.DEFAULT_SIGN_IN]


def test_a_public_address_keeps_its_port(start):
    out, seen = start("--public-url", "http://10.0.0.5:9000")
    assert "10.0.0.5" in seen["allowed_hosts"]
    assert seen["secure_cookie"] is False
    assert out[0] == "Move load test: http://10.0.0.5:9000"


def test_the_public_address_can_come_from_the_environment(start, monkeypatch):
    monkeypatch.setenv("LOADTEST_PUBLIC_URL", "https://loadtest.example.com")
    out, seen = start()
    assert out[0] == "Move load test: https://loadtest.example.com"
    assert seen["local_skip"] is False


def test_an_empty_public_address_in_the_environment_is_no_address(start, monkeypatch):
    monkeypatch.setenv("LOADTEST_PUBLIC_URL", "")
    out, seen = start()
    assert seen["local_skip"] is True and seen["sign_in"] is None
    assert len(out) == 1 and out[0].startswith("On this machine: http://localhost:")


@pytest.mark.parametrize("bad", [
    "loadtest.example.com",                     # no scheme
    "ftp://loadtest.example.com",
    "https://",
    "https://loadtest.example.com/page",        # a path
    "https://loadtest.example.com/?key=abc",    # a query
    "https://loadtest.example.com/#top",
    "https://user:secret@loadtest.example.com",
    "https://loadtest.example.com:port",
])
def test_a_bad_public_address_stops_the_tool(start, bad):
    with pytest.raises(SystemExit) as stopped:
        start("--public-url", bad)
    assert stopped.value.code == cli.BAD_PUBLIC_URL
    assert "secret" not in cli.BAD_PUBLIC_URL


# ── the page's sign-in ─────────────────────────────────────────────────


def test_the_sign_in_comes_from_the_environment_and_is_never_printed(start, monkeypatch):
    monkeypatch.setenv("LOADTEST_USERNAME", "jimmy")
    monkeypatch.setenv("LOADTEST_PASSWORD", "a-long-own-pass-77")
    out, seen = start("--public-url", "https://loadtest.example.com")
    assert seen["sign_in"].matches("jimmy", "a-long-own-pass-77")
    assert not seen["sign_in"].matches("admin", "password123")
    assert out[-1] == cli.OWN_SIGN_IN
    assert "a-long-own-pass-77" not in "\n".join(out) and "jimmy" not in "\n".join(out)


def test_an_own_password_alone_keeps_the_default_username(start, monkeypatch):
    monkeypatch.setenv("LOADTEST_PASSWORD", "a-long-own-pass-77")
    out, seen = start("--allow-host", "proxy.example")
    assert seen["sign_in"].matches("admin", "a-long-own-pass-77")
    assert out[-1] == cli.OWN_SIGN_IN


def test_empty_sign_in_settings_mean_the_defaults(start, monkeypatch):
    monkeypatch.setenv("LOADTEST_USERNAME", "")
    monkeypatch.setenv("LOADTEST_PASSWORD", "")
    out, seen = start("--allow-host", "proxy.example")
    assert seen["sign_in"].matches("admin", "password123")
    assert out[-1] == cli.DEFAULT_SIGN_IN
    assert "admin and password123" in cli.DEFAULT_SIGN_IN


def test_on_this_machine_only_there_is_no_sign_in(start, monkeypatch):
    monkeypatch.setenv("LOADTEST_PASSWORD", "a-long-own-pass-77")
    out, seen = start()                         # --host 127.0.0.1 and no proxy name
    assert seen["sign_in"] is None
    assert len(out) == 1 and "sign" not in out[0].lower()


def test_on_every_network_the_start_lines_say_who_signs_in(monkeypatch, tmp_path, capsys):
    class Fake(uvicorn.Server):
        def run(self, sockets=None):
            for s in sockets or ():
                s.close()

    monkeypatch.setattr(uvicorn, "Server", Fake)
    monkeypatch.setattr(cli, "lan_address", lambda: "192.168.1.10")
    for name in ("LOADTEST_PUBLIC_URL", "LOADTEST_USERNAME", "LOADTEST_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    port = free_port()
    cli.main(["--port", str(port), "--runs-dir", str(tmp_path / "runs")])
    assert capsys.readouterr().out.splitlines() == [
        f"Move load test: http://192.168.1.10:{port}",
        f"On this machine: http://localhost:{port} (no sign-in)",
        cli.DEFAULT_SIGN_IN]


# ── the Docker files ───────────────────────────────────────────────────


def test_the_image_serves_the_default_port_and_keeps_its_data_in_the_volume():
    dockerfile = (ROOT / "Dockerfile").read_text()
    assert f"EXPOSE {cli.DEFAULT_PORT}" in dockerfile
    assert f"127.0.0.1:{cli.DEFAULT_PORT}/" in dockerfile            # the health check
    assert 'CMD ["--runs-dir", "/data/runs"]' in dockerfile
    assert re.search(r"^USER 10001$", dockerfile, re.M)             # never root
    # the tool finds profiles/ next to src/, so the install must be editable
    assert "pip install --no-cache-dir -e ." in dockerfile
    assert "COPY profiles ./profiles" in dockerfile


def test_the_compose_file_asks_for_the_public_address():
    compose = (ROOT / "docker-compose.yml").read_text()
    assert "LOADTEST_PUBLIC_URL: ${LOADTEST_PUBLIC_URL:?" in compose
    assert "LOADTEST_USERNAME: ${LOADTEST_USERNAME:-admin}" in compose
    assert "LOADTEST_PASSWORD: ${LOADTEST_PASSWORD:-password123}" in compose
    assert f":{cli.DEFAULT_PORT}\"" in compose
    assert "loadtest-data:/data" in compose
    example = (ROOT / ".env.example").read_text()
    assert re.search(r"^LOADTEST_PUBLIC_URL=", example, re.M)
    for name in re.findall(r"\$\{(LOADTEST_[A-Z_]+)", compose):
        assert name in example, f"{name} is not explained in .env.example"


def test_nothing_private_can_enter_the_image():
    ignored = (ROOT / ".dockerignore").read_text().split()
    for name in ("runs", ".venv", ".env", "tests"):
        assert name in ignored
