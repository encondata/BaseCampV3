"""Writes reference.json: the labels the laptop's OWN code path prints for a
fixed set of cases, which kiosk/src/labelgen/reference.test.ts holds the
TypeScript port to, byte for byte.

Every case seeds a temporary edge Store the way
kiosk_laptop/edge/tests/test_label_generate.py does (the shared setup, the
Label Station settings and the two cached sync bodies) and calls the
edge's real `build_plan` and `render_job`. The sync bodies are stored and
recorded as the same text, so both sides read identical bytes.

The five built-in designs are imported from
api/src/serversherpa/labels/builtin_templates.py, which needs sqlalchemy,
so run this with the api venv (the edge venv lacks it), from the repo root:

    api/.venv/bin/python kiosk/src/labelgen/fixtures/make_reference.py

`source_hash` is the sha256 the test recomputes over the Python label
code (see `source_hash` below): when that code changes, the test fails
until this file is run again. Python files are only read here, never
edited."""

import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "api" / "src"), str(ROOT / "kiosk_laptop" / "edge" / "src")]

from serversherpa.labels.builtin_templates import (  # noqa: E402
    AMSTERDAM_DESTINATION, FRONT_ASSET_TAG, GENERIC_RACK_AND_RU, SWITCH_FRONT_TAG,
    VEGAS_DESTINATION)

from edge import laptop_setup  # noqa: E402
from edge.db import Store  # noqa: E402
from edge.labels import generate  # noqa: E402
from edge.sync import sync_paths  # noqa: E402

OUT = Path(__file__).resolve().parent / "reference.json"
MOVE = "m-1"


# ── the source hash ─────────────────────────────────────────────────

def source_files() -> list[Path]:
    """The Python the expected labels come from: the shared label code
    (labels/*.py, not its generate/ package) and the edge's generator."""
    labels = sorted((ROOT / "api" / "src" / "serversherpa" / "labels").glob("*.py"))
    return [*labels, ROOT / "kiosk_laptop" / "edge" / "src" / "edge" / "labels" / "generate.py"]


def source_hash() -> str:
    """sha256 over each file, in order of its repo-relative POSIX path: the
    path, a newline, the file's bytes, a newline (reference.test.ts
    computes the same)."""
    h = hashlib.sha256()
    for path in sorted(source_files(), key=lambda p: p.relative_to(ROOT).as_posix()):
        h.update(path.relative_to(ROOT).as_posix().encode() + b"\n")
        h.update(path.read_bytes() + b"\n")
    return h.hexdigest()


# ── sync-shaped inputs (after test_label_generate.py) ────────────────

CATALOG = ["asset_id", "asset_name", "serial_number", "make", "model", "make_model",
           "source_raw", "source_ru", "source_site", "destination_raw", "destination_ru",
           "destination_site", "move_name", "move_date", "move_date_long", "container_name",
           "container_id", "unknown_key"]

CONTEXT = {"move_name": "Sample Move", "move_code": "SMPL", "move_day": "2026-09-01",
           "source_site": "Sample Site A", "source_site_code": "SITE-A",
           "destination_site": "Sample Site B", "destination_site_code": "SITE-B",
           "catalog_keys": CATALOG}


def item(n: int, **over) -> dict:
    """One asset as /kiosk/sync/assets serializes it, every field included
    (the edge test's `_sync_item`, numbered)."""
    a = {
        "id": f"a-{n}", "asset_id": str(100000 + n), "legacy_id": 100000 + n,
        "name": f"SAMPLE-SERVER-{n:02d}", "rfid": f"{100000 + n:024d}",
        "serial_number": f"SN{n:07d}", "make": "Dell", "model": "PowerEdge R740",
        "make_model": "Dell PowerEdge R740", "container_id": None,
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
    a.update(over)
    return a


SIZES = {"4x2": (4.0, 2.0), "2x1": (2.0, 1.0)}


def template(tid: str, *, family="Rack", dpi="203", scope="destination", kind="design",
             version=1, label_type="top", size="4x2", design=None, code="", rules=None,
             language="zpl", schema_version=None, **over) -> dict:
    """One template as /kiosk/sync/label-templates sends it."""
    w, h = SIZES[size]
    t = {"id": tid, "name": f"{family} - {dpi}DPI", "family": family,
         "label_type": label_type, "size_key": size, "dpi_key": dpi,
         "language_key": language, "version": version,
         "updated_at": "2026-10-01T12:00:00+00:00", "move_site_names": [],
         "reasons": [], "code": code, "generation_rules": rules or {},
         "width_in": w, "height_in": h, "dots": int(dpi) if dpi.isdigit() else 203,
         "error": None, "kind": kind, "design": design if kind == "design" else None,
         "scope": scope}
    if schema_version is not None:
        t["schema_version"] = schema_version
    t.update(over)
    return t


def builtin(tid: str, design: dict, *, family: str, dpi: str, label_type="top",
            scope="destination") -> dict:
    size = f"{design['size']['w']}x{design['size']['h']}"
    return template(tid, family=family, dpi=dpi, scope=scope, label_type=label_type,
                    size=size, design=design, schema_version=2)


def vegas(tid: str, dpi: str, *, family="Vegas Destination", scope="destination",
          **over) -> dict:
    """The Vegas design as the sync sends a builder child; `over` replaces
    any of its fields."""
    return {**builtin(tid, VEGAS_DESTINATION, family=family, dpi=dpi, scope=scope), **over}


# A schema 1 design with every placeholder path (the edge test's E2E_DESIGN)
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
E2E_RULES = {"source": {"1": "src_rack", "2": "src_slot"}, "length_limits": {"asset_name": 6}}

CODE = ("^XA^CI28^FO20,20^A0N,30,30^FD{asset_name}^FS^FO20,60^A0N,30,30^FD{source_ru}|"
        "{src_rack}|{src_slot}|{dst_a}^FS^FO20,100^BCN,60,Y,N,N^FD{serial_number}^FS"
        "^FO400,20^BQN,2,4^FDQA,{asset_id}^FS^FO20,200^FD{move_date_long} {nope}^FS^XZ")


def field_el(eid: str, key: str, y: float, **over) -> dict:
    """A schema 2 field placement, Vegas-shaped."""
    el = {"id": eid, "type": "field", "field": key, "x": 0.1, "y": y, "w": 2.5, "h": 0.12,
          "rotation": 0, "locked": False, "hideWhenEmpty": False, "display": "text",
          "font": {"family": "swiss721-cond-bold", "weight": "regular"}, "sizePt": 10,
          "baselineIn": 0.12, "inverted": False, "expectedLength": None, "align": "left",
          "maxChars": None, "trim": None, "strip": None, "stripWhere": None}
    el.update(over)
    return el


def v2(elements: list[dict], **over) -> dict:
    return {"schema": 2, "size": {"w": 4, "h": 2}, "elements": elements, **over}


# Field rules: Split pieces, expected length (pad), max chars with each trim,
# strip at each place, alignment, number display, hide-when-empty, bold
RULES_DESIGN = v2([
    field_el("p0", "destination_rack", 0.05, piece=0, expectedLength=4),
    field_el("p2", "destination_rack", 0.2, piece=2, expectedLength=4, align="right"),
    field_el("p4", "destination_rack", 0.35, piece=4, maxChars=1, trim="front"),
    field_el("max-rear", "asset_name", 0.5, maxChars=6, trim="rear", align="center"),
    field_el("max-front", "serial_number", 0.65, maxChars=4, trim="front"),
    field_el("strip-front", "source_rack", 0.8, strip="0", stripWhere="front"),
    field_el("strip-rear", "source_rack", 0.95, strip="0", stripWhere="rear"),
    field_el("strip-any", "source_rack", 1.1, strip=".", stripWhere="anywhere"),
    field_el("ru-num", "source_ru", 1.25, display="number", expectedLength=3),
    field_el("ru-text", "destination_ru", 1.4, inverted=True,
             invertPad={"x": 0.05, "y": 0.02}),
    field_el("hide", "owner", 1.55, hideWhenEmpty=True,
             font={"family": "swiss721-cond-bold", "weight": "bold"}),
    field_el("pod", "pod_number", 1.7, x=2.7, w=1.2, rotation=90),
], splits={"destination_rack": {"pieces": ["A", "B", "C", "D", "E"]}})

# Codes: Code 128 and QR, bound to fields and as field displays
CODES_DESIGN = v2([
    {"id": "bc-serial", "type": "barcode", "field": "serial_number", "symbology": "code128",
     "moduleIn": 0.01, "showText": True, "x": 0.1, "y": 0.05, "w": 2.5, "h": 0.3,
     "rotation": 0, "locked": False, "hideWhenEmpty": False},
    {"id": "bc-id", "type": "barcode", "field": "asset_id", "symbology": "code128",
     "moduleIn": 0.0133, "showText": False, "x": 0.1, "y": 0.45, "w": 1.5, "h": 0.25,
     "rotation": 0, "locked": False, "hideWhenEmpty": True},
    {"id": "qr-serial", "type": "qr", "field": "serial_number", "x": 3.0, "y": 0.05,
     "w": 0.8, "h": 0.8, "rotation": 0, "locked": False, "hideWhenEmpty": False},
    {"id": "qr-name", "type": "qr", "field": "asset_name", "x": 3.0, "y": 1.0, "w": 0.6,
     "h": 0.6, "rotation": 0, "locked": False, "hideWhenEmpty": True},
    field_el("as-barcode", "location_detail", 0.85, display="barcode", h=0.3,
             symbology="code128", moduleIn=0.01, showText=True),
    field_el("as-qr", "rfid_tag", 1.3, display="qr", w=0.5, h=0.5),
    field_el("name", "asset_name", 1.9, w=2.8),
])
CODES_V1 = {"elements": [
    {"type": "barcode", "x": 0.1, "y": 0.1, "w": 2.5, "h": 0.5, "data": "{serial_number}",
     "symbology": "code128"},
    {"type": "qr", "x": 3.0, "y": 0.1, "w": 0.8, "h": 0.8, "data": "{asset_name}"},
    {"type": "barcode", "x": 0.1, "y": 1.0, "w": 2.5, "h": 0.5, "data": ">{asset_id}<",
     "symbology": "code128"},
]}

# raw_ft numbers through ft: fields
FT_DESIGN = v2([field_el(f"ft-{i}", f"ft:{h}", 0.1 + 0.15 * i)
                for i, h in enumerate(["Rack", "Num", "Notes", "Missing"])]
               + [field_el("bool", "has_rails", 0.8), field_el("vend", "vendor_involved", 0.95)])

# RUs through the schema 2 number and text displays
RU_DESIGN = v2([
    field_el("s-num", "source_ru", 0.1, display="number"),
    field_el("s-text", "source_ru", 0.3),
    field_el("d-num", "destination_ru", 0.5, display="number", expectedLength=2),
    field_el("d-text", "destination_ru", 0.7),
])

ODD_NAMES = ["Ünïcödé-Ω", "日本語サーバー", "😀emoji🚀", "a^b~c_d\\e", "tab\there", "",
             "x" * 60, "  pad  ", "^XZ^XA"]
CODE_VALUES = ["", "12345678", "1234567", "0", "AB12345678", ">x>", ">", "a" * 80,
               "1" * 41, "12 34", "ü-ß", "^~_", "Q" * 5000]
RU_RAWS = ["14.50", "14.00", "0.5", "abc", "_ 14", "14 _", "1_4", " 3 ", "7", "1E+2", "-0.0"]


def ru_assets() -> list[dict]:
    out = [item(i, source_ru_raw=raw, source_ru=raw, destination_ru_raw=raw,
                destination_ru=None) for i, raw in enumerate(RU_RAWS)]
    # no RU at all: '' and never 'None'
    out.append(item(90, source_ru_raw=None, source_ru=None, destination_ru_raw=None,
                    destination_ru=None))
    # the raw RU blank, the plain one used (Python's `or`)
    out.append(item(91, source_ru_raw="", source_ru="9.50", destination_ru_raw=None,
                    destination_ru="0"))
    return out


# ── the cases ───────────────────────────────────────────────────────

def case(name: str, *, templates: list[dict], assets: list[dict] | None = None,
         kind="top", dpi=203, context=CONTEXT, note=None, ruling=None,
         ensure_ascii=True) -> dict:
    assets_body = {"initiative_id": MOVE, "initiative_name": "Move 1",
                   "generated_at": "2026-10-19T00:00:00Z",
                   "assets": [item(1), item(2)] if assets is None else assets}
    if context is not None:
        assets_body["label_context"] = context
    templates_body = {"initiative_id": MOVE, "generated_at": "2026-10-19T00:00:00Z",
                      "templates": templates}
    c = {"name": name, "assetsJson": json.dumps(assets_body, ensure_ascii=ensure_ascii),
         "templatesJson": json.dumps(templates_body, ensure_ascii=ensure_ascii),
         "kind": kind, "dpi": dpi}
    if note:
        c["note"] = note
    if ruling:
        c["ruling"] = ruling
    return c


def cases() -> list[dict]:
    out: list[dict] = []
    builtins = [("VEGAS_DESTINATION", VEGAS_DESTINATION, "Vegas Destination", "top"),
                ("AMSTERDAM_DESTINATION", AMSTERDAM_DESTINATION, "Amsterdam Destination", "top"),
                ("GENERIC_RACK_AND_RU", GENERIC_RACK_AND_RU, "Generic Rack and RU", "top"),
                ("FRONT_ASSET_TAG", FRONT_ASSET_TAG, "Front Asset Tag", "front"),
                ("SWITCH_FRONT_TAG", SWITCH_FRONT_TAG, "Switch Front Tag", "top")]
    builtin_assets = [
        item(1), item(2, destination_rack="DH2-R14", destination_ru_raw="3.50",
                      source_ru_raw="0.5", asset_id="7", name="db02"),
        item(3, destination_rack="", destination_ru_raw=None, destination_ru=None,
             serial_number="", name=None, make_model=None),
        item(4, destination_rack="1.2.3.4.5.6.7", asset_id="123456789012", name="Ünïcödé😀"),
    ]
    for key, design, family, label_type in builtins:
        scope = "global" if key == "GENERIC_RACK_AND_RU" else "destination"
        for dpi in ("203", "300", "600"):
            out.append(case(f"builtin {key} {label_type} {dpi}", kind=label_type,
                            dpi=int(dpi), assets=builtin_assets, templates=[
                                builtin(f"{key.lower()}-{dpi}", design, family=family, dpi=dpi,
                                        label_type=label_type, scope=scope)]))

    e2e_assets = [
        item(1, name="web01-long", serial_number="SN-1", source_ru_raw="14.50",
             destination_ru_raw="3.00", source_position="R1.14"),
        item(2, name="db02", serial_number="SN/2 ü", source_ru_raw="7",
             destination_ru_raw=None, destination_ru=None, source_position=None),
        item(3, name=None, serial_number=None, source_ru_raw=None, source_ru=None,
             destination_ru_raw="42.25", source_position="A.B.C"),
    ]
    for dpi in (203, 300):
        out.append(case(f"E2E_DESIGN schema 1 {dpi}", dpi=dpi, assets=e2e_assets, templates=[
            template(f"e2e-{dpi}", dpi=str(dpi), design=E2E_DESIGN, rules=E2E_RULES)]))
        out.append(case(f"code template with tokens {dpi}", dpi=dpi, assets=e2e_assets,
                        templates=[template(f"code-{dpi}", dpi=str(dpi), kind="code", code=CODE,
                                            rules={**E2E_RULES,
                                                   "destination": {"1": "dst_a"}})]))
    out.append(case("code template front", kind="front", templates=[
        template("code-front", kind="code", label_type="front", size="2x1",
                 code="^XA^FD{asset_name}^FS^FD{serial_number}^FS^XZ")]))

    # the template pick: fall-through at the printer's DPI, both kinds
    out.append(case("pick top: destination only at 300 falls to source at 203", templates=[
        vegas("dest-300", "300"), vegas("src-203", "203", scope="source", family="Src"),
        builtin("gen-203", GENERIC_RACK_AND_RU, family="Generic Rack and RU", dpi="203",
                scope="global")]))
    out.append(case("pick top: destination and source elsewhere, global at 300", dpi=300,
                    templates=[vegas("dest-203", "203"),
                               vegas("src-600", "600", scope="source", family="Src"),
                               template("glob-300", family="Glob", dpi="300", scope="global",
                                        design=E2E_DESIGN, rules=E2E_RULES),
                               builtin("gen-300", GENERIC_RACK_AND_RU,
                                       family="Generic Rack and RU", dpi="300",
                                       scope="global")]))
    out.append(case("pick top: only the generic fallback at 203", templates=[
        vegas("dest-300", "300"), vegas("both-600", "600", scope="both"),
        builtin("gen-203", GENERIC_RACK_AND_RU, family="GENERIC RACK AND RU", dpi="203",
                scope="global")]))
    out.append(case("pick top: none at 203 (available elsewhere)", templates=[
        vegas("dest-300", "300"), vegas("glob-600", "600", scope="global", family="G"),
        builtin("front-203", FRONT_ASSET_TAG, family="Front", dpi="203", label_type="front")]))
    out.append(case("pick top: ties by version then updated_at", dpi=300, templates=[
        vegas("v1", "300", version=1), vegas("v2-old", "300", version=2),
        {**vegas("v2-new", "300", version=2), "updated_at": "2026-10-02T00:00:00+00:00"},
        {**vegas("v2-new-dup", "300", version=2), "updated_at": "2026-10-02T00:00:00+00:00"},
    ]))
    out.append(case("pick front: destination at 300 falls to global at 203", kind="front",
                    templates=[builtin("fd-300", FRONT_ASSET_TAG, family="Front Asset Tag",
                                       dpi="300", label_type="front"),
                               builtin("fg-203", FRONT_ASSET_TAG, family="Global Front",
                                       dpi="203", label_type="front", scope="global"),
                               builtin("fs-203", FRONT_ASSET_TAG, family="Source Front",
                                       dpi="203", label_type="front", scope="source")]))
    out.append(case("pick front: none at 600", kind="front", dpi=600, templates=[
        builtin("fd-300", FRONT_ASSET_TAG, family="Front Asset Tag", dpi="300",
                label_type="front"), vegas("top-600", "600")]))

    # generation rules on schema 1 values
    rule_sets = {
        "positions": {"source": {"1": "src_rack", "2": "src_slot", " 3 ": "src_c", "x": "bad",
                                 "4": ""},
                      "destination": {"1": "dst_a", "+2": "dst_b"}},
        "length limits": {"length_limits": {"asset_name": 3, "serial_number": "4",
                                            "make_model": 0, "src_rack": " 2 ", "nope": 5,
                                            "source_raw": -1}},
    }
    rules_design = {"elements": [
        {"type": "text", "x": 0.1, "y": 0.1 + 0.3 * i, "w": 3.5, "h": 0.25, "fontSizePt": 9,
         "content": content}
        for i, content in enumerate([
            "{asset_name}|{serial_number}|{make_model}",
            "{src_rack}|{src_slot}|{src_c}|{bad}",
            "{dst_a}|{dst_b}|{source_raw}|{destination_raw}",
            "{source_ru}|{destination_ru}|{move_name}|{unknown_key}"])]}
    rule_assets = [item(1, source_position="R1.14.B"), item(2, source_position=None,
                                                             source_rack="09.01.05D"),
                   item(3, source_position="", source_rack="", destination_position="X.Y",
                        name="日本語サーバー", serial_number="😀😀😀😀😀")]
    for label, rules in rule_sets.items():
        out.append(case(f"generation rules: {label}", assets=rule_assets, templates=[
            template("gr", design=rules_design, rules=rules)]))

    out.append(case("field rules: split, pad, max, strip", assets=[
        item(1), item(2, destination_rack="1.22.333", name="SHORT", serial_number="SN",
                      source_rack="00R1.0.0", owner=None, pod_number="Ü"),
        item(3, destination_rack="", name="A-very-long-asset-name", source_rack="...",
             source_ru_raw="7.25", destination_ru_raw="-0.5", owner="")], templates=[
        template("fr-203", design=RULES_DESIGN, schema_version=2)]))
    out.append(case("field rules at 300", dpi=300, templates=[
        template("fr-300", dpi="300", design=RULES_DESIGN, schema_version=2)]))

    code_assets = [item(i, serial_number=v, asset_id=v, name=v, location_detail=v, rfid=v)
                   for i, v in enumerate(CODE_VALUES)]
    for dpi in (203, 300):
        out.append(case(f"QR and Code 128 edge values {dpi}", dpi=dpi, assets=code_assets,
                        templates=[template(f"codes-{dpi}", dpi=str(dpi), design=CODES_DESIGN,
                                            schema_version=2)]))
    out.append(case("QR and Code 128 edge values, schema 1", assets=code_assets, templates=[
        template("codes-v1", design=CODES_V1)]))

    name_assets = [item(i, name=v, serial_number=v, make_model=v, destination_rack=v)
                   for i, v in enumerate(ODD_NAMES)]
    out.append(case("odd names: Vegas (UTF-8 escaped)", dpi=300, assets=name_assets,
                    templates=[vegas("v-300", "300")]))
    out.append(case("odd names: Vegas (raw UTF-8)", dpi=300, assets=name_assets,
                    templates=[vegas("v-300", "300")], ensure_ascii=False))
    out.append(case("odd names: schema 1", assets=name_assets, templates=[
        template("e2e", design=E2E_DESIGN, rules=E2E_RULES)], ensure_ascii=False))
    out.append(case("odd names: code template", assets=name_assets, templates=[
        template("code", kind="code", code=CODE)]))
    out.append(case("odd context: names and a datetime move day",
                    context={**CONTEXT, "move_name": "Mövé ^1~", "source_site": "😀",
                             "move_day": "2026-11-03T05:00:00Z", "destination_site": None},
                    templates=[template("e2e", design=E2E_DESIGN, rules=E2E_RULES)]))
    out.append(case("odd context: no move day, no catalog keys",
                    context={**CONTEXT, "move_day": None, "catalog_keys": None},
                    templates=[template("e2e", design=E2E_DESIGN, rules=E2E_RULES)]))

    ft_assets = [item(i, raw_ft={"Rack": v, "Num": n, "Notes": "ü^~"})
                 for i, (v, n) in enumerate([(12.0, 100), (7, 0.1), (1e-05, 1e16), (True, False),
                                             (None, ""), ("text", -0.0), ([1, "a"], {"a": 1})])]
    ft_assets.append(item(20, raw_ft=None, has_rails=None, vendor_involved=True))
    out.append(case("raw_ft numbers", assets=ft_assets, templates=[
        template("ft", design=FT_DESIGN, schema_version=2)]))

    out.append(case("source_ru_raw forms, schema 2", assets=ru_assets(), templates=[
        template("ru2", design=RU_DESIGN, schema_version=2)]))
    out.append(case("source_ru_raw forms, schema 1", assets=ru_assets(), templates=[
        template("ru1", design=E2E_DESIGN, rules=E2E_RULES)]))
    out.append(case("source_ru_raw forms, code template", assets=ru_assets(), templates=[
        template("ru-code", kind="code", code="^XA^FD{source_ru}|{destination_ru}^FS^XZ")]))

    out.append(case("missing label_context", context=None, templates=[vegas("v", "203")]))
    out.append(case("label_context, empty assets list", assets=[], templates=[vegas("v", "203")]))

    image = {"id": "photo", "type": "image", "source": "photo", "x": 0.1, "y": 0.1, "w": 0.8,
             "h": 1.0, "rotation": 0}
    out.append(case("schema 3 template", dpi=300, templates=[
        vegas("v3", "300", design={**VEGAS_DESTINATION, "schema": 3,
                                   "elements": [*VEGAS_DESTINATION["elements"], image]},
              schema_version=3)]))
    out.append(case("schema_version 4 on a schema 1 design", templates=[
        template("sv4", design=E2E_DESIGN, schema_version=4)]))
    out.append(case("schema_version 2 on a schema 1 design", templates=[
        template("sv2", design=E2E_DESIGN, rules=E2E_RULES, schema_version=2)]))
    out.append(case('design with "schema": 2.0', templates=[
        template("s20", design={**RU_DESIGN, "schema": 2.0}, schema_version=2)]))
    two_lines = {"elements": [{**E2E_DESIGN["elements"][0], "lines": 2.0}]}
    out.append(case('schema 1 design with "lines": 2.0', templates=[
        template("l20", design=two_lines)]))
    out.append(case('schema 2 design with "lines": 2.0', templates=[
        template("l20v2", design=v2([
            {"id": "t", "type": "text", "content": "Name:", "x": 0.1, "y": 0.1, "w": 1.0,
             "h": 0.2, "rotation": 0, "locked": False,
             "font": {"family": "swiss721-cond-bold", "weight": "regular"}, "sizePt": 10,
             "baselineIn": 0.1, "inverted": False, "align": "left", "lines": 2.0}]),
                 schema_version=2)]))
    out.append(case("design with no dots", templates=[
        template("nodots", design=E2E_DESIGN, dots=None)]))
    out.append(case("broken design", templates=[template("broken", design={"elements": [
        {"type": "text", "x": -1, "y": 0, "w": 1, "h": 1, "content": "{asset_name}"}]})]))
    out.append(case("ESC/P template", templates=[
        template("escp", design=E2E_DESIGN, language="escp")],
        ruling="template_unsupported",
        note="Ruling 7: Android prints only to Zebras, so a non-ZPL template is "
             "template_unsupported there; `expected` is still the laptop's ESC/P output."))
    return out


def run(store: Store, c: dict) -> dict:
    """The case through the edge: the setup, the Label Station settings and
    the cached sync bodies, then `build_plan` and `render_job`."""
    laptop_setup.save(store, {"initiative_id": MOVE}, "label")
    laptop_setup.save_label_station(store, {
        "label_kind": c["kind"], "printer": {"type": "usb", "ip": None, "model": None,
                                             "serial": None},
        "dpi": c["dpi"], "offset_x": 0, "offset_y": 0, "peel": False})
    paths = sync_paths(MOVE)
    with store.tx() as conn:
        for prefix, text in (("/kiosk/sync/assets?", c["assetsJson"]),
                             ("/kiosk/sync/label-templates?", c["templatesJson"])):
            key = next(p for p in paths if p.startswith(prefix))
            conn.execute("INSERT INTO cache (key, status, body, stored_at) VALUES (?, 200, ?, 'x') "
                         "ON CONFLICT(key) DO UPDATE SET body = excluded.body", (key, text))
    plan = generate.build_plan(store)
    expected = []
    for job in plan.assets:
        zpl, error = generate.render_job(plan.template_json, job)
        expected.append({"asset_id": job.asset_id, "zpl": zpl, "error": error})
    return {**c, "plan": {
        "template_id": plan.template.id if plan.template else None,
        "notes": plan.notes, "available_dpis": [int(d) for d in plan.available_dpis],
        "has_asset_data": plan.has_asset_data,
        "fonts": generate.template_fonts(plan.template_json)},
        "expected": expected}


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = Store(Path(tmp) / "edge.db")
        results = [run(store, c) for c in cases()]
        store.conn.close()
    names = [r["name"] for r in results]
    assert len(names) == len(set(names)), "case names must be unique"
    OUT.write_text(json.dumps({"source_hash": source_hash(), "cases": results},
                              indent=1, ensure_ascii=False) + "\n")
    jobs = sum(len(r["expected"]) for r in results)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(results)} cases, {jobs} labels")


if __name__ == "__main__":
    main()
