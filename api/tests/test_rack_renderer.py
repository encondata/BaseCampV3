"""Subprocess wrapper around the Node rack renderer: happy path against a
stub script, and every failure mode mapped to RackRendererUnavailable."""

import sys

import pytest

from serversherpa.reports import rack_renderer
from serversherpa.reports.rack_renderer import RackRendererUnavailable, render

OK = "import sys, json; d=json.load(sys.stdin); print('<svg>' + d['rackName'] + '</svg>', end='')"


def _script(tmp_path, body: str):
    p = tmp_path / "render-rack.js"
    p.write_text(body)
    return str(p)


@pytest.fixture
def python_as_node(monkeypatch):
    """Run the 'script' with python instead of node so the test needs no
    Node toolchain: `python -c <script contents>` via a tiny shim."""
    shim = ("import sys, runpy; sys.argv = sys.argv[1:]; "
            "exec(open(sys.argv[0]).read())")
    monkeypatch.setattr(rack_renderer, "_command",
                        lambda script: [sys.executable, "-c", shim, script])


async def test_render_pipes_json_and_returns_stdout(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path", lambda: _script(tmp_path, OK))
    out = await render([{"id": "r1"}], "R7", "source")
    assert out == "<svg>R7</svg>"


async def test_missing_script_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path", lambda: str(tmp_path / "nope.js"))
    with pytest.raises(RackRendererUnavailable, match="not found"):
        await render([], "R1", "source")


async def test_nonzero_exit_surfaces_stderr(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path",
                        lambda: _script(tmp_path, "import sys; sys.stderr.write('kaboom'); sys.exit(2)"))
    with pytest.raises(RackRendererUnavailable, match="kaboom"):
        await render([], "R1", "source")


async def test_timeout_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path",
                        lambda: _script(tmp_path, "import time; time.sleep(5)"))
    monkeypatch.setattr(rack_renderer, "RACK_RENDER_TIMEOUT_SECONDS", 0.2)
    with pytest.raises(RackRendererUnavailable, match="timed out"):
        await render([], "R1", "source")
