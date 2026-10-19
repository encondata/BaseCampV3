"""The Label Station's label generator: one finished label per asset, made
with the portal's own label code (api/src/serversherpa/labels)."""

import json
from pathlib import Path

from serversherpa.labels.render import render_template

from edge import laptop_setup
from edge.labels import generate
from edge.sync import sync_paths

MOVE = "m-1"
CATALOG = ["asset_id", "asset_name", "serial_number", "make_model", "source_ru",
           "source_raw", "destination_site", "move_date", "move_date_long"]

DESIGN = {
    "elements": [
        {"type": "text", "x": 0.1, "y": 0.1, "w": 2.0, "h": 0.3,
         "content": "{asset_name} / {source_ru}", "fontSizePt": 12},
        {"type": "barcode", "x": 0.1, "y": 0.5, "w": 2.0, "h": 0.5,
         "data": "{serial_number}", "symbology": "code128"},
    ],
}


def _asset(n: int, **over) -> dict:
    """One synced asset, `label` as the portal computes it for CATALOG."""
    a = {"id": f"a-{n}", "asset_id": str(100 + n), "legacy_id": 100 + n,
         "name": f"web{n:02d}", "rfid": None, "serial_number": f"SN{n}",
         "make": "Dell", "model": "R640", "make_model": "Dell R640", "container_id": None,
         "source_rack": "R1", "source_ru": "14.5", "source_ru_raw": "14.50",
         "source_position": "R1.14", "source_pod": None,
         "destination_rack": "D9", "destination_ru": "3", "destination_ru_raw": "3",
         "destination_position": None, "destination_pod": None,
         "priority_wave": "1", "disposition": None,
         "label": {"asset_id": str(100 + n), "asset_name": f"web{n:02d}",
                   "serial_number": f"SN{n}", "make_model": "Dell R640",
                   "source_ru": "U14.5", "source_raw": "R1.14",
                   "destination_site": "New DC", "move_date": "11/03/2026",
                   "move_date_long": "03-NOV-2026"}}
    a.update(over)
    return a


def _template(tid: str, *, family="Rack", dpi="203", scope="destination", kind="design",
              version=1, label_type="top", design=DESIGN, code="", error=None,
              rules=None) -> dict:
    dots = int(dpi) if dpi.isdigit() else 203
    return {"id": tid, "name": f"{family} - {dpi}DPI", "family": family,
            "label_type": label_type, "size_key": "4x2", "dpi_key": dpi,
            "language_key": "zpl", "version": version,
            "updated_at": "2026-10-01T12:00:00+00:00", "move_site_names": [],
            "reasons": [], "code": code, "generation_rules": rules or {},
            "width_in": 4.0, "height_in": 2.0, "dots": dots, "error": error,
            "kind": kind, "design": design if kind == "design" else None, "scope": scope}


def _put_cache(store, path: str, body: dict) -> None:
    with store.tx() as c:
        c.execute("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, 'x') "
                  "ON CONFLICT(key) DO UPDATE SET body = excluded.body", (path, json.dumps(body)))


def _seed(app, *, assets=None, templates=None, dpi=203, label_kind="top"):
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": MOVE}, "label")
    laptop_setup.save_label_station(store, {
        "label_kind": label_kind, "printer": {"type": "usb", "ip": None, "model": None,
                                              "serial": None},
        "dpi": dpi, "offset_x": 0, "offset_y": 0, "peel": False})
    assets_path, templates_path = _paths()
    _put_cache(store, assets_path, {
        "initiative_id": MOVE, "initiative_name": "Move 1",
        "generated_at": "2026-10-19T00:00:00Z",
        "assets": [_asset(1), _asset(2)] if assets is None else assets,
        "label_context": {"move_name": "Move 1", "move_day": "2026-11-03",
                          "source_site": "Old DC", "destination_site": "New DC",
                          "catalog_keys": CATALOG}})
    _put_cache(store, templates_path, {
        "initiative_id": MOVE, "generated_at": "2026-10-19T00:00:00Z",
        "templates": [_template("t-203")] if templates is None else templates})
    return store


def _paths() -> tuple[str, str]:
    paths = sync_paths(MOVE)
    return (next(p for p in paths if p.startswith("/kiosk/sync/assets?")),
            next(p for p in paths if p.startswith("/kiosk/sync/label-templates?")))


def _apply_all(store, plan) -> None:
    for job in plan.assets:
        zpl, error = generate.render_job(plan.template_json, job)
        generate.apply(store, plan, job, zpl, error)


def test_shared_label_code_imports_from_api_source():
    import serversherpa.labels.render as shared
    api_src = Path(__file__).resolve().parents[3] / "api" / "src"
    assert Path(shared.__file__).resolve().is_relative_to(api_src)


def test_no_plan_without_a_label_station(app):
    assert generate.build_plan(app.state.store) is None
    laptop_setup.save(app.state.store, {"initiative_id": MOVE}, "label")
    assert generate.build_plan(app.state.store) is None  # no label_station saved yet


def test_plan_picks_by_dpi_and_builds_portal_values(app):
    store = _seed(app, dpi=300, templates=[
        _template("dest-203", family="Dest", scope="destination", dpi="203"),
        _template("glob-300", family="Glob", scope="global", dpi="300"),
        _template("front-300", family="Front", scope="destination", dpi="300",
                  label_type="front"),
    ])
    plan = generate.build_plan(store)
    assert plan.template.id == "glob-300"
    assert plan.template_json["id"] == "glob-300"
    assert any("Dest" in n and "300 DPI" in n for n in plan.notes)
    assert [j.asset_id for j in plan.assets] == ["a-1", "a-2"]
    for job, asset in zip(plan.assets, [_asset(1), _asset(2)]):
        assert job.values == {k: asset["label"][k] for k in CATALOG}
        assert len(job.fingerprint) == 64


def test_values_use_the_templates_own_generation_rules(app):
    rules = {"source": {"1": "src_rack", "2": "src_slot"},
             "length_limits": {"asset_name": 3}}
    store = _seed(app, templates=[_template("t-203", rules=rules)])
    job = generate.build_plan(store).assets[0]
    assert job.values["src_rack"] == "R1" and job.values["src_slot"] == "14"
    assert job.values["asset_name"] == "web"


def test_render_matches_render_template(app):
    store = _seed(app)
    plan = generate.build_plan(store)
    job = plan.assets[0]
    zpl, error = generate.render_job(plan.template_json, job)
    source = type("T", (), {"kind": "design", "code": None, "design": DESIGN,
                            "language_key": "zpl"})()
    expected, _ = render_template(source, job.values, width_in=4.0, height_in=2.0, dots=203)
    assert error is None and zpl == expected
    assert "web01 / U14.5" in zpl


def test_code_template_fills_its_code_and_unknown_tokens_are_not_errors(app):
    store = _seed(app, templates=[_template("c-203", kind="code",
                                            code="^XA^FD{asset_name}^FS^FD{nope}^FS^XZ")])
    plan = generate.build_plan(store)
    zpl, error = generate.render_job(plan.template_json, plan.assets[0])
    assert error is None and zpl == "^XA^FDweb01^FS^FD^FS^XZ"


def test_a_design_with_a_conversion_error_still_renders_from_design(app):
    store = _seed(app, templates=[_template("t-203", error="font_missing", code="")])
    plan = generate.build_plan(store)
    zpl, error = generate.render_job(plan.template_json, plan.assets[0])
    assert error is None and "web01" in zpl


def _rows(store) -> dict:
    return {r["asset_id"]: dict(r) for r in store.all("SELECT * FROM station_labels")}


def test_only_changed_assets_are_rerendered(app):
    store = _seed(app)
    plan = generate.build_plan(store)
    assert len(generate.changed_jobs(store, plan)) == 2
    _apply_all(store, plan)
    rows = _rows(store)
    assert rows["a-1"]["template_id"] == "t-203" and rows["a-1"]["dpi"] == 203
    assert rows["a-1"]["label_kind"] == "top" and rows["a-1"]["template_version"] == 1
    assert rows["a-1"]["template_name"] == "Rack - 203DPI" and rows["a-1"]["error"] is None
    assert generate.changed_jobs(store, generate.build_plan(store)) == []

    # a label input changes on one asset
    _seed(app, assets=[_asset(1, name="web99", label={**_asset(1)["label"],
                                                      "asset_name": "web99"}), _asset(2)])
    assert [j.asset_id for j in generate.changed_jobs(store, generate.build_plan(store))] \
        == ["a-1"]

    # a field no label prints changes: nothing to do
    _seed(app, assets=[_asset(1), _asset(2, priority_wave="7", rfid="E200")])
    assert generate.changed_jobs(store, generate.build_plan(store)) == []

    # the template's version moves: every label
    _seed(app, templates=[_template("t-203", version=2)])
    assert len(generate.changed_jobs(store, generate.build_plan(store))) == 2

    # the printer's DPI changes: every label
    _seed(app, dpi=300, templates=[_template("t-203"), _template("t-300", dpi="300")])
    _apply_all(store, generate.build_plan(store))
    _seed(app, dpi=203, templates=[_template("t-203"), _template("t-300", dpi="300")])
    assert len(generate.changed_jobs(store, generate.build_plan(store))) == 2


def test_bad_template_gives_error_rows_not_a_crash(app):
    broken = {"elements": [{"type": "text", "x": -1, "y": 0, "w": 1, "h": 1,
                            "content": "{asset_name}"}]}
    store = _seed(app, templates=[_template("t-203", design=broken)])
    plan = generate.build_plan(store)
    _apply_all(store, plan)
    rows = _rows(store)
    assert {r["error"] for r in rows.values()} == {"template_failed"}
    assert all(r["zpl"] is None for r in rows.values())

    store = _seed(app, templates=[_template("t-300", dpi="300")])
    plan = generate.build_plan(store)
    assert plan.template is None
    assert plan.notes
    _apply_all(store, plan)
    rows = _rows(store)
    assert {r["error"] for r in rows.values()} == {"no_template_at_dpi"}
    assert {r["template_id"] for r in rows.values()} == {None}


def test_prune_removes_assets_off_the_move(app):
    store = _seed(app)
    _apply_all(store, generate.build_plan(store))
    _seed(app, assets=[_asset(2)])
    plan = generate.build_plan(store)
    generate.prune(store, plan)
    assert set(_rows(store)) == {"a-2"}


async def test_wipe_clears_station_labels_and_label_run(app):
    from edge.routes.edge import MOVE_TABLES
    assert "station_labels" in MOVE_TABLES and "label_run" in MOVE_TABLES
