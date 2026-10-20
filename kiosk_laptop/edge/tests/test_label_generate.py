"""The Label Station's label generator: one finished label per asset, made
with the portal's own label code (api/src/serversherpa/labels)."""

import json
from pathlib import Path
from types import SimpleNamespace

import serversherpa.labels as labels_pkg
from serversherpa.labels.fields import MOCK_VALUES, design_field_keys, field_values
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


def _seed(app, *, assets=None, templates=None, dpi=203, label_kind="top", context=None):
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
        "label_context": context or {"move_name": "Move 1", "move_day": "2026-11-03",
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

    # the size/DPI vocabulary or language changes (same version): every label
    for change in ({"width_in": 4.5}, {"height_in": 2.5}, {"dots": 200},
                   {"language_key": "zpl2"}):
        _seed(app, templates=[_template("t-203")])
        _apply_all(store, generate.build_plan(store))
        _seed(app, templates=[{**_template("t-203"), **change}])
        assert len(generate.changed_jobs(store, generate.build_plan(store))) == 2, change

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


def test_a_design_without_size_or_dots_is_template_failed(app):
    for missing in ("width_in", "height_in", "dots"):
        for bad in (None, 0):
            store = _seed(app, templates=[{**_template("t-203"), missing: bad}])
            plan = generate.build_plan(store)
            assert generate.render_job(plan.template_json, plan.assets[0]) \
                == (None, "template_failed"), (missing, bad)
    # a code template needs none of them
    store = _seed(app, templates=[{**_template("c-203", kind="code", code="^XA^XZ"),
                                   "width_in": None, "height_in": None, "dots": None}])
    plan = generate.build_plan(store)
    assert generate.render_job(plan.template_json, plan.assets[0]) == ("^XA^XZ", None)


# Every placeholder the design compiles, so the round trip covers each value path
E2E_DESIGN = {
    "elements": [
        {"type": "text", "x": 0.1, "y": 0.1, "w": 3.0, "h": 0.3, "fontSizePt": 12,
         "content": "{asset_name} {asset_id} {make_model}"},
        {"type": "text", "x": 0.1, "y": 0.45, "w": 3.0, "h": 0.3, "fontSizePt": 10,
         "content": "{source_ru} {destination_ru} {src_rack}-{src_slot}"},
        {"type": "text", "x": 0.1, "y": 0.8, "w": 3.0, "h": 0.3, "fontSizePt": 10,
         "content": "{move_date} {move_date_long} {destination_site} {source_site}"},
        {"type": "barcode", "x": 0.1, "y": 1.2, "w": 2.5, "h": 0.5,
         "data": "{serial_number}", "symbology": "code128"},
        {"type": "qr", "x": 3.0, "y": 1.0, "w": 0.8, "h": 0.8, "data": "{asset_id}"},
    ],
}
E2E_KEYS = ["asset_id", "asset_name", "serial_number", "make_model", "source_ru",
            "destination_ru", "source_raw", "destination_raw", "source_site",
            "destination_site", "move_date", "move_date_long", "move_name"]


def test_sync_json_round_trip_renders_the_portals_bytes(app):
    """The sync bodies exactly as the API serializes them (RU as the stored
    numeric text in *_ru_raw, the move day as an ISO date, vocab floats,
    the design JSON) through the edge path give the same bytes as the
    portal's own inputs (Decimal RU, a `date`) through render_template."""
    from datetime import date
    from decimal import Decimal
    from types import SimpleNamespace

    from serversherpa.labels.label_values import LabelAsset, LabelMove, asset_label_values

    rules = {"source": {"1": "src_rack", "2": "src_slot"}, "length_limits": {"asset_name": 6}}
    rows = [  # (legacy_id, name, serial, source_ru, destination_ru, source_position)
        (101, "web01-long", "SN-1", Decimal("14.50"), Decimal("3.00"), "R1.14"),
        (102, "db02", "SN/2 ü", Decimal("7"), None, None),
        (103, None, None, None, Decimal("42.25"), "A.B.C"),
    ]
    assets = [{
        "id": f"a-{legacy}", "asset_id": str(legacy), "legacy_id": legacy, "name": name,
        "rfid": None, "serial_number": serial, "make": "Dell", "model": "R640",
        "make_model": "Dell R640", "container_id": None, "source_rack": "R1",
        "source_ru": None, "source_ru_raw": None if sru is None else str(sru),
        "source_position": pos, "source_pod": None, "destination_rack": "D9",
        "destination_ru": None, "destination_ru_raw": None if dru is None else str(dru),
        "destination_position": None, "destination_pod": None, "priority_wave": None,
        "disposition": None, "label": {}}
        for legacy, name, serial, sru, dru, pos in rows]
    template = {**_template("t-203", design=E2E_DESIGN, rules=rules),
                "width_in": 4.0, "height_in": 2.0, "dots": 203}
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": MOVE}, "label")
    laptop_setup.save_label_station(store, {
        "label_kind": "top", "printer": {"type": "usb", "ip": None, "model": None,
                                         "serial": None},
        "dpi": 203, "offset_x": 0, "offset_y": 0, "peel": False})
    assets_path, templates_path = _paths()
    _put_cache(store, assets_path, {
        "initiative_id": MOVE, "initiative_name": "Move 1",
        "generated_at": "2026-10-19T00:00:00Z", "assets": assets,
        "label_context": {"move_name": "Move 1", "move_day": "2026-11-03",
                          "source_site": "Old DC", "destination_site": "New DC",
                          "catalog_keys": E2E_KEYS}})
    _put_cache(store, templates_path, {
        "initiative_id": MOVE, "generated_at": "2026-10-19T00:00:00Z",
        "templates": [json.loads(json.dumps(template))]})

    plan = generate.build_plan(store)
    move = LabelMove(name="Move 1", day=date(2026, 11, 3), source_site="Old DC",
                     destination_site="New DC")
    source = SimpleNamespace(kind="design", code=None, design=E2E_DESIGN, language_key="zpl")
    assert len(plan.assets) == len(rows)
    for job, (legacy, name, serial, sru, dru, pos) in zip(plan.assets, rows):
        portal_asset = LabelAsset(
            legacy_id=legacy, name=name, serial_number=serial, make="Dell", model="R640",
            source_rack="R1", source_ru=sru, source_position=pos, destination_rack="D9",
            destination_ru=dru, destination_position=None)
        values = asset_label_values(portal_asset, move, E2E_KEYS, generation_rules=rules)
        expected, _ = render_template(source, values, width_in=4.0, height_in=2.0, dots=203)
        zpl, error = generate.render_job(plan.template_json, job)
        assert error is None and zpl == expected, job.asset_id
    assert "U14.5 U3" in generate.render_job(plan.template_json, plan.assets[0])[0]


# ── schema 2: label builder designs ─────────────────────────────────

FIXTURES = Path(labels_pkg.__file__).parent / "fixtures"
VEGAS = json.loads((FIXTURES / "vegas_v2.json").read_text())
VEGAS_KEYS = design_field_keys(VEGAS)
VEGAS_CONTEXT = {"move_name": "Sample Move", "move_code": "SMPL", "move_day": "2026-09-01",
                 "source_site": "Sample Site A", "source_site_code": "SITE-A",
                 "destination_site": "Sample Site B", "destination_site_code": "SITE-B",
                 "catalog_keys": CATALOG}


def _sync_item(**over) -> dict:
    """One asset as /kiosk/sync/assets serializes it, every builder field
    included, holding MOCK_VALUES' text (the RUs as the stored numeric text)."""
    item = {
        "id": "a-1", "asset_id": "100000", "legacy_id": 100000, "name": "SAMPLE-SERVER-01",
        "rfid": "000000000000000000100000", "serial_number": "SN0000001", "make": "Dell",
        "model": "PowerEdge R740", "make_model": "Dell PowerEdge R740", "container_id": None,
        "source_rack": "09.01.05D.02.10", "source_ru": "12", "source_ru_raw": "12.00",
        "source_position": "Front", "source_pod": "P4",
        "destination_rack": "14.01.07C.02.03", "destination_ru": "12",
        "destination_ru_raw": "12.00", "destination_position": "Front",
        "destination_pod": "D4", "priority_wave": "Wave 1", "disposition": "Relocate",
        "pod_number": "P4", "asset_status": "racked", "asset_status_label": "Racked",
        "has_rails": True, "location_detail": "F01 U18", "owner": "Data Services",
        "cable_info": {**{f"data_{i}": f"SW01/0{i}" for i in range(1, 7)},
                       "mgmt_1": "MGMT01/01", "mgmt_2": "MGMT01/02"},
        "vendor_involved": False, "roster_status": "labeled",
        "roster_status_label": "Labeled", "raw_ft": None, "label": {}}
    item.update(over)
    return item


def _vegas(tid="v-300", **over) -> dict:
    """The Vegas fixture as the template sync sends a builder child."""
    return {**_template(tid, family="Vegas", dpi="300", design=VEGAS), "schema_version": 2,
            **over}


def _seed_vegas(app, *, item=None, context=VEGAS_CONTEXT, templates=None):
    return _seed(app, dpi=300, assets=[item or _sync_item()],
                 templates=templates or [_vegas()], context=context)


def test_a_v2_design_prints_the_builder_field_values(app):
    """The Vegas fixture from a sync-shaped item and label_context: the
    edge's bytes are render_template's with field_values(item, context).
    The item holds MOCK_VALUES' text for every field the fixture places,
    so the bytes are also the golden the compiler test pins."""
    store = _seed_vegas(app)
    plan = generate.build_plan(store)
    values = field_values(_sync_item(), VEGAS_CONTEXT)
    assert {k: values[k] for k in VEGAS_KEYS} == {k: MOCK_VALUES[k] for k in VEGAS_KEYS}
    source = SimpleNamespace(kind="design", code=None, design=VEGAS, language_key="zpl")
    expected, unknown = render_template(source, values, width_in=4.0, height_in=2.0, dots=300)
    zpl, error = generate.render_job(plan.template_json, plan.assets[0])
    assert error is None and unknown == set()
    assert zpl == expected
    assert zpl + "\n" == (FIXTURES / "vegas_v2_300.zpl").read_text()
    assert "^FD07C^FS" in zpl and "^A@N," in zpl


def test_a_v2_label_changes_only_with_what_it_prints(app):
    """A v2 job carries only the fields its design places: a status that
    moves as the asset is scanned never regenerates its label."""
    store = _seed_vegas(app)
    plan = generate.build_plan(store)
    assert set(plan.assets[0].values) == VEGAS_KEYS
    _apply_all(store, plan)
    assert generate.changed_jobs(store, generate.build_plan(store)) == []

    _seed_vegas(app, item=_sync_item(roster_status="received", roster_status_label="Received",
                                     asset_status_label="In transit", owner="Ops"))
    assert generate.changed_jobs(store, generate.build_plan(store)) == []

    _seed_vegas(app, item=_sync_item(destination_rack="14.01.07C.02.04"))
    changed = generate.changed_jobs(store, generate.build_plan(store))
    assert [j.asset_id for j in changed] == ["a-1"]
    assert "^FD04^FS" in generate.render_job(generate.build_plan(store).template_json,
                                             changed[0])[0]

    _seed_vegas(app, context={**VEGAS_CONTEXT, "source_site_code": "SITE-Z"})
    assert len(generate.changed_jobs(store, generate.build_plan(store))) == 1


def test_a_v1_design_keeps_the_catalog_values(app):
    store = _seed(app, templates=[{**_template("t-203", design={**DESIGN, "schema": 1}),
                                   "schema_version": 1}])
    plan = generate.build_plan(store)
    assert plan.assets[0].values == {k: _asset(1)["label"][k] for k in CATALOG}
    zpl, error = generate.render_job(plan.template_json, plan.assets[0])
    assert error is None and "web01 / U14.5" in zpl


def test_template_schema_reads_the_design_like_the_server(app):
    schema = generate.template_schema
    assert schema(_template("c", kind="code", code="^XA^XZ")) == 1
    assert schema(_template("d", design=DESIGN)) == 1
    assert schema(_vegas()) == 2
    for odd in (True, "3", 3.0, None, [3]):
        assert schema(_template("d", design={**DESIGN, "schema": odd})) == 1, odd
    assert schema(_template("d", design={**DESIGN, "schema": 3})) == 3
    assert schema(_template("d", design={**DESIGN, "schema": 4})) == 4
    # the sync's own schema_version counts too (a kind this edge doesn't know)
    assert schema({**_template("x", kind="hologram"), "schema_version": 4}) == 4
    assert schema({**_template("d", design=DESIGN), "schema_version": True}) == 1
    assert generate.SUPPORTED_SCHEMA == 2


def test_a_newer_schema_is_template_unsupported_and_prints_nothing(app, monkeypatch):
    newer = {"schema": 4, "elements": [{"type": "hologram", "field": "asset_id"}]}
    store = _seed(app, templates=[{**_template("t-203", design=newer), "schema_version": 4}])
    plan = generate.build_plan(store)
    assert plan.template.id == "t-203"  # still the station's pick: it fails visibly
    assert generate.render_job(plan.template_json, plan.assets[0]) \
        == (None, "template_unsupported")
    _apply_all(store, plan)
    rows = _rows(store)
    assert {(r["zpl"], r["error"], r["template_id"]) for r in rows.values()} \
        == {(None, "template_unsupported", "t-203")}
    assert generate.changed_jobs(store, generate.build_plan(store)) == []

    # a laptop update that knows schema 4 redoes every label
    monkeypatch.setattr(generate, "SUPPORTED_SCHEMA", 4)
    assert len(generate.changed_jobs(store, generate.build_plan(store))) == 2


def test_a_schema_3_image_design_prints_nothing_here(app):
    """A builder design with an image is schema 3 (the portal's ID badges);
    this edge prints up to schema 2, so one that ever reached it is
    template_unsupported, never a label with the image missing."""
    image = {"id": "photo", "type": "image", "source": "photo", "x": 0.1, "y": 0.1,
             "w": 0.8, "h": 1.0, "rotation": 0}
    badge = {**VEGAS, "schema": 3, "elements": [*VEGAS["elements"], image]}
    store = _seed_vegas(app, templates=[_vegas(design=badge, schema_version=3)])
    plan = generate.build_plan(store)
    assert generate.template_schema(plan.template_json) == 3
    assert generate.render_job(plan.template_json, plan.assets[0]) \
        == (None, "template_unsupported")


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
