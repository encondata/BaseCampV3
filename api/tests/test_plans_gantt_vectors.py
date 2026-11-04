"""The project plan PDF's Gantt geometry (reports/project_plan/gantt.py),
held to the vectors the portal writes and reads too
(tests/fixtures/plans/gantt.json, portal/src/lib/plans/
ganttGeometry.vectors.test.ts): the zooms' scale, the fit, the timescale
tiers and labels, bars, milestones, baselines, link paths and arrowheads,
nonworking shading and the PDF's page geometry. The portal is the
reference; gantt.py is its port, so the PDF draws what the portal would and
the options step's page estimate counts the Gantt pages the worker makes.

After a deliberate change, the portal rewrites the file
(`REGEN_GANTT_VECTORS=1 npx vitest run src/lib/plans/ganttGeometry.vectors.test.ts`
from portal/) and this port is made to agree."""

import json
import math
from dataclasses import asdict, is_dataclass
from pathlib import Path

import pytest

from serversherpa.reports.project_plan import gantt

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "plans" / "gantt.json").read_text())


@pytest.fixture(autouse=True)
def clean_db():
    """These tests are pure and never touch the database: shadow the
    conftest fixture that truncates every table before each test."""
    yield


def _scale(d: dict) -> gantt.Scale:
    return gantt.Scale(start_ms=d["startMs"], end_ms=d["endMs"], px_per_ms=d["pxPerMs"],
                       width=d["width"])


def _end(d: dict) -> gantt.LinkEnd:
    return gantt.LinkEnd(x0=d["x0"], x1=d["x1"], y=d["y"])


# the portal's names (camelCase JSON) for what the port returns
_KEYS = {"start_ms": "startMs", "end_ms": "endMs", "px_per_ms": "pxPerMs",
         "summary_height": "summaryHeight", "base_top": "baseTop",
         "base_height": "baseHeight", "gantt_rows": "ganttRows", "table_rows": "tableRows"}


def _json(value):
    """The port's answer in the vectors' shape."""
    if is_dataclass(value):
        value = asdict(value)
    if isinstance(value, dict):
        return {_KEYS.get(k, k): _json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json(v) for v in value]
    return value


FNS = {
    "makeScale": lambda start, finish, zoom: gantt.make_scale(start, finish, zoom),
    "fitZoom": lambda start, finish, width: gantt.fit_zoom(start, finish, width),
    "tiers": lambda scale, zoom, window: gantt.tiers(_scale(scale), zoom, window),
    "barOf": lambda scale, task: gantt.bar_of(_scale(scale), task["start"], task["finish"],
                                              task["is_milestone"]),
    "baselineOf": lambda scale, task: gantt.baseline_of(_scale(scale), task["baseline_start"],
                                                        task["baseline_finish"]),
    "progressWidth": lambda width, percent: gantt.progress_width(width, percent),
    "linkPath": lambda a, b, kind, row_h, stub: gantt.link_path(_end(a), _end(b), kind, row_h,
                                                                stub),
    "linkShape": lambda a, b, kind, row_h, stub, to_half: gantt.link_shape(
        _end(a), _end(b), kind, row_h, stub=stub, to_half=to_half),
    "linkStub": lambda zoom: gantt.link_stub(zoom),
    "barBox": lambda row_h, baseline: gantt.bar_box(row_h, baseline),
    "nonworkingBands": lambda calendar, scale: gantt.nonworking_bands(calendar, _scale(scale)),
    "printScale": lambda start, finish, zoom: gantt.print_scale(start, finish, zoom),
    "printFit": lambda start, finish, paper: gantt.print_fit(start, finish, paper),
    "planSpan": lambda start, finish, tasks: gantt.plan_span(
        start, finish, [(t["start"], t["finish"]) for t in tasks]),
    "printRange": lambda span, first, last: gantt.print_range(
        gantt.PrintRange(span["start"], span["finish"]), first, last),
    "spanTooLong": lambda start, finish: gantt.span_too_long(start, finish),
    "pageLayout": lambda paper: gantt.page_layout(paper),
    "estimatePages": lambda rows, start, finish, zoom, paper: gantt.estimate_pages(
        rows, start, finish, zoom, paper),
}


def _same(got, want, where="") -> None:
    """Equal, numbers to a billionth of a px (both sides do the same IEEE
    arithmetic, so they are in fact exact)."""
    if isinstance(want, dict):
        assert isinstance(got, dict) and set(got) == set(want), (where, got, want)
        for key in want:
            _same(got[key], want[key], f"{where}.{key}")
    elif isinstance(want, list):
        assert isinstance(got, list) and len(got) == len(want), (where, got, want)
        for i, (g, w) in enumerate(zip(got, want, strict=True)):
            _same(g, w, f"{where}[{i}]")
    elif isinstance(want, bool) or want is None or isinstance(want, str):
        assert got == want, (where, got, want)
    else:
        assert isinstance(got, (int, float)) and not isinstance(got, bool), (where, got)
        assert math.isclose(got, want, rel_tol=1e-12, abs_tol=1e-9), (where, got, want)


def test_the_vectors_cover_every_function_zoom_paper_and_link_type():
    assert len(VECTORS) >= 20
    assert {row["fn"] for row in VECTORS} == set(FNS)
    for zoom in gantt.ZOOMS:
        for fn in ("makeScale", "printScale", "tiers", "linkStub"):
            assert any(r["fn"] == fn and zoom in r["args"] for r in VECTORS), (fn, zoom)
    for paper in gantt.PAPERS:
        assert any(r["fn"] == "pageLayout" and r["args"] == [paper] for r in VECTORS)
    assert {r["args"][2] for r in VECTORS if r["fn"] == "linkPath"} == {"FS", "SS", "FF", "SF"}


@pytest.mark.parametrize("row", VECTORS, ids=[row["name"] for row in VECTORS])
def test_the_port_agrees_with_the_portal(row):
    _same(_json(FNS[row["fn"]](*row["args"])), row["expected"], row["name"])
