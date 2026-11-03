"""The Project plan PDF (reports/project_plan): its run options, the
project_plans:view gate on runs and history, the definition migration 0110
seeds, and the build: a title block, the task table, then the Gantt chart
on its own pages, tiled across and down, every text escaped and nothing
fetched but data: URIs."""

import importlib.util
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select, text
from weasyprint import HTML

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment,
    Client,
    Notification,
    PermissionOverride,
    ReportDefinition,
    ReportRun,
)
from serversherpa.plans.models import ProjectPlan
from serversherpa.reports import project_plan, worker
from serversherpa.reports.project_plan import gantt
from serversherpa.reports.project_plan import gather as gather_mod
from serversherpa.reports.project_plan.pdf import (
    data_fetcher,
    day_span,
    render_html,
    sheet_day,
    task_deep,
    task_hue,
)
from serversherpa.reports.registry import OptionsError, get_module
from tests.test_plans_api import _create, _initiative, _person_id
from tests.test_plans_ops import _add, _ok, _update
from tests.test_sites_api import login
from tests.test_status_values_write import _make

MIGRATION = (Path(__file__).resolve().parents[1]
             / "migrations" / "versions" / "0110_project_plans.py")
EVIL = "<script>alert(1)</script>"
ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;"
BLUE = "#1668a7"


def _migration_module():
    spec = importlib.util.spec_from_file_location("_migration_0110", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── options ──────────────────────────────────────────────────────────


def _problems(options: dict) -> list[str]:
    with pytest.raises(OptionsError) as exc:
        project_plan.validate_run_options(options)
    return exc.value.problems


def test_the_module_is_registered():
    assert get_module("project_plan") is project_plan
    assert project_plan.report_type == "project_plan"


def test_run_options_keep_what_the_run_says():
    assert project_plan.validate_run_options({}) == {}
    opts = {"columns": ["id", "name", "duration", "duration"], "from": "2026-11-02",
            "to": "2026-12-31", "zoom": "weeks", "paper": "a4", "include_completed": False,
            "show_critical": True, "show_baseline": True}
    deduped = {**opts, "columns": ["id", "name", "duration"]}
    assert project_plan.validate_run_options(opts) == deduped
    # Fit is the zoom left out
    assert project_plan.validate_run_options({"zoom": "fit"}) == {}


@pytest.mark.parametrize("options, needle", [
    ({"zoom": "years"}, "zoom"),
    ({"from": "2026-12-01", "to": "2026-11-01"}, "on or before"),
    ({"from": "2026-12-01"}, "both"),
    ({"to": "2026-12-01"}, "both"),
    ({"from": "12/01/2026", "to": "2026-12-31"}, "YYYY-MM-DD"),
    ({"from": "2026-02-30", "to": "2026-03-01"}, "YYYY-MM-DD"),
    ({"columns": ["id", "nope"]}, "nope"),
    ({"columns": []}, "columns"),
    ({"columns": "id,name"}, "columns"),
    ({"paper": "legal"}, "paper"),
    ({"include_completed": "yes"}, "include_completed"),
    ({"show_critical": 1}, "show_critical"),
    ({"bogus": 1}, "bogus"),
])
def test_bad_run_options_are_problems(options, needle):
    problems = _problems(options)
    assert any(needle in p for p in problems), problems


def test_problems_are_all_reported_together():
    assert len(_problems({"zoom": "x", "paper": "y", "columns": ["zz"]})) == 3


def test_definition_options_are_empty():
    assert project_plan.default_options() == {}
    assert project_plan.validate_options({}) == {}
    with pytest.raises(OptionsError):
        project_plan.validate_options({"paper": "a4"})


# ── the seeded definition (migration 0110) ───────────────────────────


def test_migration_seeds_the_definition():
    m = _migration_module()
    assert m.DEFINITION_NAME == "Project plan"
    assert m.REPORT_TYPE == "project_plan"
    assert json.loads(m.DEFAULT_OPTIONS) == project_plan.default_options()
    assert m.DEFINITION_DESCRIPTION == (
        "An initiative's project plan as a PDF: the task table, then the Gantt chart "
        "on pages of its own.")


async def test_the_definition_insert_is_idempotent(db):
    m = _migration_module()
    params = {"name": m.DEFINITION_NAME, "description": m.DEFINITION_DESCRIPTION,
              "report_type": m.REPORT_TYPE, "options": m.DEFAULT_OPTIONS}
    await db.execute(text(m.INSERT_DEFINITION_SQL), params)
    await db.execute(text(m.INSERT_DEFINITION_SQL), params)
    await db.commit()
    rows = (await db.execute(text(
        "SELECT report_type, options, is_system FROM report_definitions WHERE name = :n"),
        {"n": m.DEFINITION_NAME})).all()
    assert rows == [("project_plan", {}, True)]
    await db.execute(text(m.DELETE_DEFINITION_SQL), {"report_type": m.REPORT_TYPE})
    await db.commit()
    assert (await db.scalar(text("SELECT count(*) FROM report_definitions"))) == 0


# ── runs and history ─────────────────────────────────────────────────


async def _definition(db) -> ReportDefinition:
    d = ReportDefinition(name="Project plan", description="d", report_type="project_plan",
                         options={}, is_system=True)
    db.add(d)
    await db.commit()
    return d


def _body(d, initiative_id, options=None):
    return {"definition_id": str(d.id), "initiative_id": str(initiative_id),
            "options": options or {}, "notify": False}


async def _admin(db, client):
    email = f"pp-{uuid.uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    return hdrs, await _person_id(db, email)


async def test_a_run_needs_project_plans_view(client, db, seeded_user):
    """Staff have reports:add but not project_plans: 403 before anything else."""
    d = await _definition(db)
    move = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=_body(d, move.id, {"bogus": 1}))
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "project_plans_view_required"
    assert (await db.scalar(select(ReportRun.id))) is None


async def test_a_run_needs_an_initiative_with_a_plan(client, db):
    d = await _definition(db)
    hdrs, _ = await _admin(db, client)
    move = await _initiative(db)
    resp = await client.post("/reports/runs", headers=hdrs, json=_body(d, move.id))
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "plan_not_found"
    resp = await client.post("/reports/runs", headers=hdrs,
                             json={**_body(d, move.id), "initiative_id": None})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "initiative_required"
    await _create(client, hdrs, move)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=_body(d, move.id, {"zoom": "weeks", "paper": "a4"}))
    assert resp.status_code == 201, resp.text
    assert resp.json()["report_type"] == "project_plan"
    assert resp.json()["options"] == {"zoom": "weeks", "paper": "a4"}


async def test_bad_options_are_422_with_problems(client, db):
    d = await _definition(db)
    hdrs, _ = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    resp = await client.post("/reports/runs", headers=hdrs, json=_body(
        d, move.id, {"zoom": "years", "from": "2026-12-01", "columns": ["id", "nope"]}))
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "invalid_options" and len(detail["problems"]) == 3


async def test_history_hides_project_plan_runs_without_view(client, db):
    d = await _definition(db)
    email = f"pp-{uuid.uuid4().hex[:8]}@test.example.com"
    hdrs = await _make(db, client, "admin", email)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    run = (await client.post("/reports/runs", headers=hdrs, json=_body(d, move.id))).json()
    row = await db.get(ReportRun, uuid.UUID(run["id"]))
    row.status = "completed"
    row.storage_key = f"reports/{move.id}/{row.id}.pdf"
    row.filename = "Move - Project plan - 2026-11-03 0900.pdf"
    await db.commit()
    listed = (await client.get("/reports/runs", headers=hdrs)).json()
    assert [r["id"] for r in listed] == [run["id"]]
    assert (await client.get(f"/reports/runs/{run['id']}", headers=hdrs)).status_code == 200

    db.add(PermissionOverride(person_id=await _person_id(db, email), resource="project_plans",
                              action="view", allow=False))
    await db.commit()
    hdrs = await login(client, email=email)
    assert (await client.get("/reports/runs", headers=hdrs)).json() == []
    for url in (f"/reports/runs/{run['id']}", f"/reports/runs/{run['id']}/download"):
        resp = await client.get(url, headers=hdrs)
        assert resp.status_code == 404 and resp.json()["detail"]["code"] == "run_not_found"


# ── the build ────────────────────────────────────────────────────────


async def _twelve(client, db):
    """A 12-task plan: a summary over three tasks, a milestone, FS and SS
    links, a blue task, a finished task, a deadline, a baseline, and a task
    named like a script. Returns (hdrs, person id, initiative, ids by name)."""
    hdrs, me = await _admin(db, client)
    acme = Client(name="Acme Corp")
    db.add(acme)
    await db.flush()
    move = await _initiative(db, "NAP11 Hall Migration", code="NAP11", client_id=acme.id)
    plan = await _create(client, hdrs, move)
    ids = await _add(client, hdrs, plan, "Phase 1", "Survey", "Pack", "Ship", EVIL, "Install",
                     "Test", "Cutover", "Train", "Document", "Handoff", "Go live")
    await _ok(client, hdrs, plan, [
        {"op": "indent", "ids": [ids["Survey"], ids["Pack"], ids["Ship"]]},
        _update(ids["Survey"], duration="2d", color=BLUE),
        _update(ids["Ship"], duration="3d"),
        _update(ids["Install"], duration="2d", deadline="2026-11-20"),
        _update(ids["Go live"], duration="0", is_milestone=True),
        {"op": "add_link", "predecessor_id": ids["Survey"], "successor_id": ids["Pack"]},
        {"op": "add_link", "predecessor_id": ids["Pack"], "successor_id": ids["Ship"],
         "link_type": "SS"},
        {"op": "add_link", "predecessor_id": ids["Ship"], "successor_id": ids["Install"]},
        {"op": "add_link", "predecessor_id": ids["Handoff"], "successor_id": ids["Go live"]},
    ])
    resp = await client.post(f"/plans/{plan['id']}/baseline", headers=hdrs)
    assert resp.status_code == 200, resp.text
    await _ok(client, hdrs, plan, [_update(ids["Test"], percent_complete=100)])
    return hdrs, me, move, ids


async def _html(db, move, me, **options) -> str:
    data = await gather_mod.gather(db, move.id, me)
    choices = project_plan.parse_options(project_plan.validate_run_options(options))
    return render_html(data, choices, generated_at=datetime(2026, 11, 3, 14, 5, tzinfo=UTC),
                       tracking_id=str(uuid.uuid4()))


def _section(html: str, cls: str) -> str:
    start = html.index(f'<section class="{cls}')
    end = html.find("</section>", start)
    return html[start:end]


async def test_the_pdf_is_a_title_block_the_table_then_the_gantt(client, db):
    _, me, move, ids = await _twelve(client, db)
    html = await _html(db, move, me)
    title, table, chart = (html.index('class="title'), html.index('<section class="tasks'),
                           html.index('<section class="gantt'))
    assert title < table < chart
    # the Gantt section starts on a page of its own
    assert re.search(r"\.gantt\s*\{[^}]*break-before:\s*page", html)
    assert re.search(r"thead\s*\{[^}]*display:\s*table-header-group", html)
    head = html[html.index('class="title'):table]
    for fact in ("NAP11 Hall Migration", "Acme Corp", "NAP11", "Baseline saved", "Status date",
                 "Owner", "Generated"):
        assert fact in head, fact
    # the table: the sheet's default columns, IDs as the sheet numbers them,
    # names indented by outline level, summaries bold
    rows = _section(html, "tasks")
    for label in ("ID", "Task Mode", "Task Name", "Duration", "Start", "Finish",
                  "Predecessors", "Resource Names", "% Complete", "Deadline"):
        assert f">{label}</th>" in rows, label
    assert re.search(r'<tr class="sum" data-id="1">\s*<td[^>]*>1</td>\s*<td[^>]*>[^<]*</td>\s*'
                     r'<td class="name" style="padding-left: 6px">Phase 1</td>', rows)
    assert re.search(r'<tr data-id="2">.*?<td class="name" style="padding-left: 18px">Survey</td>',
                     rows, re.S)
    assert "Mon 11/2/26" in rows


async def test_text_is_escaped_in_both_sections(client, db):
    _, me, move, _ = await _twelve(client, db)
    html = await _html(db, move, me)
    assert EVIL not in html
    assert ESCAPED in _section(html, "tasks")
    assert ESCAPED in _section(html, "gantt")


async def test_every_gantt_page_repeats_the_names_and_the_timescale(client, db):
    _, me, move, _ = await _twelve(client, db)
    html = await _html(db, move, me, zoom="days", **{"from": "2026-11-01", "to": "2026-12-31"})
    pages = html.count('<div class="gpage"')
    assert pages >= 2
    assert html.count('class="gnames"') == pages
    assert html.count('class="gscale"') == pages
    assert html.count('class="gchart"') == pages
    # each page's header names its dates and rows
    assert len(re.findall(r'<div class="ghead">.*?Rows 1–12 of 12', html, re.S)) == pages


async def test_bars_take_the_task_color_and_critical_its_class(client, db):
    _, me, move, ids = await _twelve(client, db)
    marks = r'<(?:rect|polygon) class="([^"]*)" data-task="([^"]+)"'
    html = await _html(db, move, me)
    survey = re.search(rf'<rect class="bar[^"]*" data-task="{ids["Survey"]}"[^>]*>', html).group(0)
    assert f'fill="{BLUE}"' in survey
    assert not any("critical" in cls for cls, _ in re.findall(marks, html))
    # Show critical path: Survey -> Pack -> Ship -> Install drives the finish
    html = await _html(db, move, me, show_critical=True)
    critical = {task for cls, task in re.findall(marks, html) if "critical" in cls.split()}
    assert {ids["Survey"], ids["Ship"], ids["Install"]} <= critical
    # the blue critical task stays red, its color a stripe along the top
    survey = re.search(rf'<rect class="bar[^"]*" data-task="{ids["Survey"]}"[^>]*>', html).group(0)
    assert f'fill="{BLUE}"' not in survey
    assert re.search(rf'<rect class="hue" data-task="{ids["Survey"]}"[^>]*fill="{BLUE}"', html)


async def test_the_baseline_shows_when_asked(client, db):
    _, me, move, _ = await _twelve(client, db)
    assert 'class="baseline"' not in await _html(db, move, me)
    assert 'class="baseline"' in await _html(db, move, me, show_baseline=True)


async def test_include_completed_false_drops_finished_tasks(client, db):
    _, me, move, ids = await _twelve(client, db)
    shown = await _html(db, move, me)
    assert ">Test<" in _section(shown, "tasks") and ">Test<" in _section(shown, "gantt")
    hidden = await _html(db, move, me, include_completed=False)
    assert ">Test<" not in hidden
    assert f'data-task="{ids["Test"]}"' not in hidden


async def test_chosen_columns_and_an_unknown_one(client, db):
    _, me, move, _ = await _twelve(client, db)
    html = await _html(db, move, me, columns=["wbs", "duration", "notes"])
    table = _section(html, "tasks")
    heads = re.findall(r"<th[^>]*>([^<]*)</th>", table)
    assert heads == ["ID", "Task Name", "WBS", "Duration", "Notes"]


async def test_a_year_at_days_tiles_across_pages_with_page_footers(client, db):
    _, me, move, _ = await _twelve(client, db)
    html = await _html(db, move, me, zoom="days", **{"from": "2026-11-01", "to": "2027-10-31"})
    windows = set(re.findall(r'<svg class="gchart" [^>]*viewBox="(-?[\d.]+) ', html))
    est = gantt.estimate_pages(12, "2026-11-01T00:00", "2027-11-01T00:00", "days", "letter")
    assert len(windows) == est.across >= 2
    assert 'content: "Page " counter(page) " of " counter(pages)' in html
    pages = HTML(string=html, url_fetcher=data_fetcher()).render().pages
    assert len(pages) == est.table + est.gantt


async def test_build_makes_a_pdf_named_for_the_initiative(client, db):
    _, me, move, _ = await _twelve(client, db)
    d = await _definition(db)
    run = ReportRun(definition_id=d.id, report_type="project_plan", initiative_id=move.id,
                    options={"zoom": "weeks"}, requested_by=me, requested_rank=60,
                    status="running")
    db.add(run)
    await db.commit()
    result = await project_plan.build(db, run)
    assert result.content.startswith(b"%PDF")
    assert result.content_type == "application/pdf"
    assert re.fullmatch(r"NAP11 - Project plan - \d{4}-\d{2}-\d{2} \d{4}\.pdf", result.filename)


def test_task_colors_are_capped_as_the_portal_caps_them():
    """--pln-hue: lightness capped at oklch 0.60, so a palette color stays
    as picked and a pale one darkens enough to show on a white lane."""
    for color in ("#178a4c", "#a36207", "#c03540", BLUE, "#6d4fc4", "#0f7c86", "#51606f"):
        assert task_hue(color) == color
    pale = task_hue("#fff59d")
    assert pale != "#fff59d" and sum(int(pale[i:i + 2], 16) for i in (1, 3, 5)) < 3 * 160
    assert task_deep(BLUE) != BLUE


def test_dates_read_as_the_sheet_and_the_tiles_say_them():
    assert sheet_day(datetime(2026, 11, 2, 8, 0)) == "Mon 11/2/26"
    assert sheet_day(datetime(2026, 11, 2, 13, 5), True) == "Mon 11/2/26 1:05 PM"
    assert sheet_day(datetime(2026, 11, 2, 0, 0), True) == "Mon 11/2/26 12:00 AM"
    assert day_span(datetime(2026, 11, 2), datetime(2026, 11, 16)) == "Nov 2–16, 2026"
    assert day_span(datetime(2026, 11, 30), datetime(2026, 12, 14)) == "Nov 30 – Dec 14, 2026"
    assert day_span(datetime(2026, 12, 28), datetime(2027, 1, 11)) == (
        "Dec 28, 2026 – Jan 11, 2027")
    assert day_span(datetime(2026, 11, 2), datetime(2026, 11, 2, 17)) == "Nov 2, 2026"


def test_the_fetcher_refuses_all_but_data_uris():
    for url in ("http://169.254.169.254/latest/meta-data", "https://example.com/x.png",
                "file:///etc/passwd", "ftp://example.com/x"):
        with pytest.raises(ValueError, match="disallowed protocol"):
            data_fetcher().fetch(url)
    resp = data_fetcher().fetch("data:text/plain,hi")
    assert resp.read() == b"hi"
    resp.close()


# ── the worker ───────────────────────────────────────────────────────


@pytest.fixture
def stored(monkeypatch):
    keys: dict[str, bytes] = {}

    async def put_object(key, data, content_type):
        keys[key] = data

    monkeypatch.setattr(worker, "put_object", put_object)
    return keys


async def _queued(db, d, move, me, options=None):
    run = ReportRun(definition_id=d.id, report_type="project_plan", initiative_id=move.id,
                    options=options or {}, requested_by=me, requested_rank=60, notify=True,
                    status="queued")
    db.add(run)
    await db.commit()
    return run.id


async def test_the_worker_keeps_the_pdf_on_the_run_only(client, db, stored):
    """Files are readable with attachments:view; a plan is project_plans
    data, so the file lives on the run (History download) only."""
    _, me, move, _ = await _twelve(client, db)
    d = await _definition(db)
    run_id = await _queued(db, d, move, me)
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    await db.refresh(run)
    assert run.status == "completed", run.error
    assert stored[f"reports/{move.id}/{run_id}.pdf"].startswith(b"%PDF")
    assert run.attachment_id is None
    assert await db.scalar(select(Attachment.id)) is None
    n = await db.scalar(select(Notification).where(Notification.person_id == me))
    assert n.kind == "report_ready" and n.body == "NAP11 Hall Migration"


async def test_a_plan_deleted_before_the_run_fails_it_as_plan_not_found(client, db, stored):
    hdrs, me = await _admin(db, client)
    move = await _initiative(db)
    await _create(client, hdrs, move)
    d = await _definition(db)
    run_id = await _queued(db, d, move, me)
    await db.delete(await db.scalar(select(ProjectPlan).where(
        ProjectPlan.initiative_id == move.id)))
    await db.commit()
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    await db.refresh(run)
    assert run.status == "failed" and run.error == "plan_not_found"
