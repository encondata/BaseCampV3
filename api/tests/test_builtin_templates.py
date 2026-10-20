"""The five stored code templates rebuilt as label builder designs, and
`serversherpa seed-label-templates`, which loads them as inactive builder
parents (spec §4.11). The rebuilt Vegas tag is the acceptance test: the
portal renders it from the database exactly as a Label Station renders it
from the kiosk sync (kiosk_laptop/edge/tests/test_vegas_parity.py is the
other half)."""

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

import serversherpa.labels as labels_pkg
from serversherpa.db.models import (
    AuditLog,
    InitiativeAsset,
    LabelTemplate,
    LabelTemplateSite,
    LabelTemplateVersion,
    LabelVocab,
    Site,
)
from serversherpa.labels import builtin_templates
from serversherpa.labels import templates_tree as tree
from serversherpa.labels.barcode import barcode_modules
from serversherpa.labels.builtin_templates import (
    AMSTERDAM_DESTINATION,
    BUILTIN_TEMPLATES,
    FRONT_ASSET_TAG,
    GENERIC_RACK_AND_RU,
    SWITCH_FRONT_TAG,
    VEGAS_DESTINATION,
)
from serversherpa.labels.field_rules import split_value
from serversherpa.labels.fields import design_field_keys, field_values
from serversherpa.labels.model import (
    BarcodeEl,
    FieldEl,
    QrEl,
    element_hidden,
    element_value,
    parse_design,
)
from serversherpa.labels.qr import qr_modules
from serversherpa.labels.render import render_template

FIXTURES = Path(labels_pkg.__file__).parent / "fixtures"
NAMES = ["Vegas Destination", "Amsterdam Destination", "Generic Rack and RU",
         "Front Asset Tag", "Switch Front Tag"]
DPIS = (203, 300, 600)
BY_NAME = {b.name: b for b in BUILTIN_TEMPLATES}


def _source(design: dict) -> SimpleNamespace:
    return SimpleNamespace(kind="design", code=None, design=design, language_key="zpl")


def _render(builtin, dpi: int, values: dict | None = None) -> tuple[str, set[str]]:
    size = builtin.design["size"]
    return render_template(_source(builtin.design), builtin.samples if values is None else values,
                           width_in=size["w"], height_in=size["h"], dots=dpi)


# ── the five designs ────────────────────────────────────────────────

def test_five_builtins_take_the_family_names_types_and_sizes():
    assert [b.name for b in BUILTIN_TEMPLATES] == NAMES
    assert {b.name: (b.label_type, b.size_key, b.language_key) for b in BUILTIN_TEMPLATES} == {
        "Vegas Destination": ("top", "4x2", "zpl"),
        "Amsterdam Destination": ("top", "4x2", "zpl"),
        "Generic Rack and RU": ("top", "4x2", "zpl"),
        "Front Asset Tag": ("front", "2x1", "zpl"),
        "Switch Front Tag": ("top", "4x2", "zpl"),
    }
    assert [b.design for b in BUILTIN_TEMPLATES] == [
        VEGAS_DESTINATION, AMSTERDAM_DESTINATION, GENERIC_RACK_AND_RU, FRONT_ASSET_TAG,
        SWITCH_FRONT_TAG]
    sizes = {"4x2": {"w": 4, "h": 2}, "2x1": {"w": 2, "h": 1}}
    for b in BUILTIN_TEMPLATES:
        assert b.design["schema"] == 2 and b.design["size"] == sizes[b.size_key], b.name
        # one short sentence on what the tag is for
        assert b.description.endswith(".") and b.description.count(".") == 1, b.name
        assert 20 < len(b.description) < 140, b.name


def test_vegas_is_the_fixture_file():
    assert VEGAS_DESTINATION == json.loads((FIXTURES / "vegas_v2.json").read_text())


@pytest.mark.parametrize("name", NAMES)
def test_samples_cover_every_placed_field_and_each_prints_something(name):
    b = BY_NAME[name]
    design = parse_design(b.design)
    assert set(b.samples) == design_field_keys(b.design)
    assert all(isinstance(v, str) and v for v in b.samples.values())
    # the sample fixes the Split's piece count
    for key, pieces in design.splits.items():
        assert len(split_value(b.samples[key])) == len(pieces), key
    for el in design.elements:
        if getattr(el, "field", None) is None:
            continue
        assert not element_hidden(el, b.samples), el.id
        assert element_value(el, b.samples) != "", el.id


@pytest.mark.parametrize("dpi", DPIS)
@pytest.mark.parametrize("name", NAMES)
def test_every_builtin_compiles_without_warnings_except_the_qr_cap_at_600(name, dpi):
    """What the builder warns about, checked on the compiled bytes: a field
    the values don't hold (render_template's unknown keys), an element off
    the label, and a QR code whose box asks for more than the printer's
    magnification cap of 10. Only the documented cap at 600 DPI is allowed
    (spec §4.2, QR codes at 600 DPI)."""
    b = BY_NAME[name]
    design = parse_design(b.design)
    zpl, unknown = _render(b, dpi)
    assert unknown == set()
    assert zpl.startswith(f"^XA\n^PW{round(design.width_in * dpi)}\n^LL{round(design.height_in * dpi)}")
    assert zpl.endswith("^XZ")

    for el in design.elements:
        across = el.h
        pad = getattr(el, "invert_pad", None) if getattr(el, "inverted", False) else None
        px, py = (pad.x, pad.y) if pad else (0.0, 0.0)
        w, h = ((across + 2 * py, el.w + 2 * px) if el.rotation in (90, 270)
                else (el.w + 2 * px, across + 2 * py))
        x0 = el.x - (py if el.rotation in (90, 270) else px)
        y0 = el.y - (px if el.rotation in (90, 270) else py)
        assert x0 >= 0 and y0 >= 0, el.id
        assert x0 + w <= design.width_in + 1e-9 and y0 + h <= design.height_in + 1e-9, el.id

    qrs = [el for el in design.elements
           if isinstance(el, QrEl) or (isinstance(el, FieldEl) and el.display == "qr")]
    asked = [round(round(el.w * dpi) / qr_modules(element_value(el, b.samples))) for el in qrs]
    printed = [int(m) for m in re.findall(r"\^BQN,2,(\d+)\^", zpl)]
    assert printed == [min(10, m) for m in asked]
    capped = [el.id for el, m in zip(qrs, asked, strict=True) if m > 10]
    assert capped == ([el.id for el in qrs] if dpi == 600 else [])


def test_the_three_location_tags_cap_their_qr_at_600_only():
    for name in ("Vegas Destination", "Amsterdam Destination", "Generic Rack and RU"):
        b = BY_NAME[name]
        mags = {dpi: re.findall(r"\^BQN,2,(\d+)\^", _render(b, dpi)[0]) for dpi in DPIS}
        assert mags == {203: ["5"], 300: ["7"], 600: ["10"]}, name
    for name in ("Front Asset Tag", "Switch Front Tag"):
        assert "^BQ" not in _render(BY_NAME[name], 300)[0]


# Anchors from the stored code templates (300 DPI), the way
# test_labels_zpl_v2.py pins the Vegas fixture: every rebuilt element
# prints where the old template put it, except the QR code: the stored
# ^FO1000,148 printed its symbol 60 dots lower (a ZD421 draws ^BQ 60 dots
# below its ^FO), and the design puts the symbol's top at 148, so its ^FO
# is now 88 (labels/qr.py QR_FO_OFFSET_IN).
_SHARED_4X2 = ("^FT38,173^", "^FT185,173^", "^FT38,220^", "^FT185,220^", "^FT38,270^",
               "^FT185,270^", "^FO38,295^GB1120,5,5^FS", "^FO440,500^BY4^BCN,50,Y,N,N^FH_^FD>;100000^FS",
               "^FO1000,88^BQN,2,7^FH_^FDMA,100000^FS", "^FT1120,580^A@B,45,45,",
               "^FT1160,580^A@B,45,45,")
_GRID_759 = ("^FT38,351^", "^FT185,351^", "^FT627,351^", "^FT759,351^", "^FT38,420^",
             "^FT185,420^", "^FT627,420^", "^FT759,420^", "^FT38,489^", "^FT185,489^",
             "^FT627,489^", "^FT759,489^")


def _lines(zpl: str) -> list[str]:
    return zpl.split("\n")


def test_amsterdam_keeps_its_banner_and_grid():
    zpl, _ = _render(BY_NAME["Amsterdam Destination"], 300)
    for anchor in (*_SHARED_4X2, *_GRID_759,
                   # banner: Floor and Rack reversed in the stored boxes, Room and RU plain
                   "^FO100,18^GB200,92,92^FS", "^FT120,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD14^FS",
                   "^FT375,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD01^FS",
                   "^FO580,18^GB250,92,92^FS", "^FT620,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD03^FS",
                   "^FT950,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD12^FS"):
        assert anchor in zpl, anchor
    assert AMSTERDAM_DESTINATION["splits"] == {
        "destination_rack": {"pieces": ["Floor", "Room", "POD", "Row", "Rack"]}}
    captions = re.findall(r"\^FD([A-Z]+:)\^FS", zpl)
    assert captions == ["FLOOR:", "ROOM:", "POD:", "ROW:", "RACK:", "RU:"]
    grid = {(m[0], m[1]): m[2] for m in re.findall(
        r"\^FT(185|759),(351|420|489)\^A@N,35,35,E:TT0003M_\.TTF\^FH_\^FD([^^]*)\^FS", zpl)}
    assert grid == {("185", "351"): "14", ("759", "351"): "01", ("185", "420"): "07C",
                    ("759", "420"): "02", ("185", "489"): "03", ("759", "489"): "12"}


def test_generic_prints_the_rack_whole_with_no_split():
    zpl, _ = _render(BY_NAME["Generic Rack and RU"], 300)
    rack = BY_NAME["Generic Rack and RU"].samples["destination_rack"]
    for anchor in (*_SHARED_4X2, "^FT38,420^", "^FT38,489^", "^FT627,489^",
                   f"^FT120,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD{rack}^FS",
                   "^FT650,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD12^FS",
                   f"^FT185,489^A@N,35,35,E:TT0003M_.TTF^FH_^FD{rack}^FS",
                   "^FT759,489^A@N,35,35,E:TT0003M_.TTF^FH_^FD12^FS",
                   "^FT185,420^A@N,35,35,E:TT0003M_.TTF^FH_^FDD4^FS"):
        assert anchor in zpl, anchor
    assert "splits" not in GENERIC_RACK_AND_RU or not GENERIC_RACK_AND_RU["splits"]
    assert all("piece" not in el for el in GENERIC_RACK_AND_RU["elements"])
    assert "^GB200," not in zpl and "^FR" not in zpl   # no banner boxes
    # no vocabulary, so no floor, room or row: only the grid rows with a
    # value keep their captions, where the stored template put them
    captions = re.findall(r"\^FD([A-Z]+:)\^FS", zpl)
    assert captions == ["POD:", "RACK:", "RU:"]
    for spot in ("^FT38,351^", "^FT185,351^", "^FT627,351^", "^FT759,351^", "^FT627,420^",
                 "^FT759,420^"):
        assert spot not in zpl, spot


def test_the_old_typos_are_gone():
    for b in BUILTIN_TEMPLATES:
        zpl, _ = _render(b, 300)
        assert "{" not in zpl and "'" not in zpl and "<" not in zpl, b.name
    serial = {el["field"] for el in AMSTERDAM_DESTINATION["elements"] if el["type"] == "field"}
    assert "serial_number" in serial


def test_front_asset_tag_keeps_the_stored_layout():
    zpl, _ = _render(BY_NAME["Front Asset Tag"], 300)
    assert zpl.startswith("^XA\n^PW600\n^LL300\n")
    for anchor in ("^FO15,2^BY2^BCN,35,Y,N,N^FH_^FD>;100000^FS",
                   "^FT15,110^A@N,35,35,E:TT0003M_.TTF^FH_^FDTarget:^FS",
                   "^FT140,110^A@N,35,35,E:TT0003M_.TTF^FH_^FD14.01.07C.02.03^FS",
                   "^FT450,110^A@N,35,35,E:TT0003M_.TTF^FH_^FDRU:^FS",
                   "^FT525,110^A@N,35,35,E:TT0003M_.TTF^FH_^FD12^FS",
                   "^FO15,125^GB570,7,7^FS",
                   "^FT15,170^A@N,35,35,E:TT0003M_.TTF^FH_^FDName:^FS",
                   "^FT140,170^A@N,35,35,E:TT0003M_.TTF^FH_^FDSAMPLE-SERVER-01^FS",
                   "^FT15,205^A@N,35,35,E:TT0003M_.TTF^FH_^FDSerial:^FS",
                   "^FT140,205^A@N,35,35,E:TT0003M_.TTF^FH_^FDSN0000001^FS",
                   "^FT15,240^A@N,35,35,E:TT0003M_.TTF^FH_^FDModel:^FS",
                   "^FT140,240^A@N,35,35,E:TT0003M_.TTF^FH_^FDDell PowerEdge R740^FS",
                   "^FT15,275^A@N,35,35,E:TT0003M_.TTF^FH_^FDSource:^FS",
                   "^FT140,275^A@N,35,35,E:TT0003M_.TTF^FH_^FD09.01.05D.02.10^FS",
                   "^FT450,275^A@N,35,35,E:TT0003M_.TTF^FH_^FDRU:^FS",
                   "^FT525,275^A@N,35,35,E:TT0003M_.TTF^FH_^FD12^FS"):
        assert anchor in zpl, anchor
    # the unknown E:85620388.TTF became the default family
    assert "85620388" not in zpl


def test_front_asset_tag_barcode_box_is_the_printed_symbol():
    """The compiler starts the six-digit sample in subset C (`>;`, two
    digits a character): start + three characters + check (11 modules
    each) + stop (13) = 68 modules, at 2 dots a module 136 dots at 300 DPI,
    inside the 600-dot label from x 15."""
    (bar,) = [el for el in FRONT_ASSET_TAG["elements"] if el["type"] == "barcode"]
    digits = len(BY_NAME["Front Asset Tag"].samples["asset_id"])
    modules = 11 + 11 * digits // 2 + 11 + 13
    assert (digits, modules) == (6, 68)
    module_dots = round(bar["moduleIn"] * 300)
    assert module_dots == 2
    assert round(bar["w"] * 300) == modules * module_dots == 136
    assert round((bar["x"] + bar["w"]) * 300) <= 600


@pytest.mark.parametrize("name", NAMES)
def test_every_barcode_box_is_as_wide_as_it_prints(name):
    """The canvas draws a barcode at modules x module (labels.barcode), so
    each stored box is that wide at 300 DPI for the template's sample."""
    b = BY_NAME[name]
    design = parse_design(b.design)
    for el in design.elements:
        if not (isinstance(el, BarcodeEl) or (isinstance(el, FieldEl) and el.display == "barcode")):
            continue
        modules = barcode_modules(el.symbology, element_value(el, b.samples))
        assert modules == 68, el.id   # the six-digit asset ID, subset C
        module_dots = max(1, min(10, round(el.module_in * 300)))
        assert round(el.w * 300) == modules * module_dots, (name, el.id)


def test_switch_front_tag_is_one_serial_number():
    zpl, _ = _render(BY_NAME["Switch Front Tag"], 300)
    assert _lines(zpl) == ["^XA", "^PW1200", "^LL600", "^CI28",
                           "^FT50,79^A@N,40,40,E:TT0003M_.TTF^FH_^FDSN0000001^FS", "^XZ"]


# ── seed-label-templates ────────────────────────────────────────────

async def _parents(db) -> dict[str, LabelTemplate]:
    rows = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.parent_id.is_(None), LabelTemplate.schema_version == 2))).scalars().all()
    return {r.name: r for r in rows}


async def _count(db, model) -> int:
    return await db.scalar(select(func.count()).select_from(model))


async def test_seed_creates_five_inactive_parents_with_their_children(db):
    report = await builtin_templates.seed(db)
    assert report.created == NAMES
    assert report.renamed == [] and report.skipped == []

    parents = await _parents(db)
    assert sorted(parents) == sorted(NAMES)
    for b in BUILTIN_TEMPLATES:
        p = parents[b.name]
        assert (p.label_type, p.size_key, p.language_key, p.dpi_key) == (
            b.label_type, b.size_key, "zpl", "300")
        assert p.design == b.design and p.samples == b.samples
        assert p.description == b.description
        assert p.is_active is False and p.version == 1 and p.dpis == ["203", "300", "600"]
        children = await tree.children_of(db, p)
        assert [c.name for c in children] == [f"{b.name} · {d}" for d in ("203", "300", "600")]
        assert all(c.is_active is False and c.design == b.design and c.samples == {}
                   for c in children)
    assert await _count(db, LabelTemplateSite) == 0
    assert await _count(db, LabelTemplate) == 20
    created = (await db.execute(select(AuditLog.entity_id).where(
        AuditLog.entity_type == "label_template", AuditLog.action == "create"))).scalars().all()
    assert sorted(created) == sorted(str(p.id) for p in parents.values())


async def test_seed_is_idempotent(db):
    await builtin_templates.seed(db)
    before = {name: (p.id, p.version) for name, p in (await _parents(db)).items()}

    report = await builtin_templates.seed(db)
    assert report.created == [] and report.renamed == []
    assert report.skipped == NAMES
    assert {name: (p.id, p.version) for name, p in (await _parents(db)).items()} == before
    assert await _count(db, LabelTemplate) == 20


def _code_row(name, *, dpi_key="300", label_type="top", is_active=False, version=1):
    return LabelTemplate(name=name, label_type=label_type, size_key="4x2", dpi_key=dpi_key,
                         language_key="zpl", kind="code", code="^XA^FD{asset_id}^FS^XZ",
                         is_active=is_active, version=version, dpis=[dpi_key])


async def test_seed_renames_an_old_code_row_that_holds_a_family_name(db):
    """The dev DB's old code rows hold three of the names: each becomes
    "<name> Old" (or the next free " Old N"), keeps its id, code, state and
    sites, and the rebuilt parent takes the name. Rows that only share the
    family ("Generic Rack and RU - 203DPI") are left alone."""
    site = Site(name="NAP14 - Switch")
    db.add(site)
    vegas = _code_row("Vegas Destination")
    switch = _code_row("Switch Front Tag", is_active=True, version=3)
    taken = _code_row("Switch Front Tag Old", dpi_key="203")
    generic = _code_row("Generic Rack and RU - 203DPI", dpi_key="203", is_active=True, version=8)
    db.add_all([vegas, switch, taken, generic])
    await db.flush()
    db.add(LabelTemplateSite(template_id=switch.id, site_id=site.id))
    await db.commit()
    ids = {"vegas": vegas.id, "switch": switch.id, "generic": generic.id}

    report = await builtin_templates.seed(db)

    assert report.created == NAMES
    assert report.renamed == [("Vegas Destination", "Vegas Destination Old"),
                              ("Switch Front Tag", "Switch Front Tag Old 2")]
    old_vegas, old_switch, old_generic = [
        await db.get(LabelTemplate, ids[k], populate_existing=True)
        for k in ("vegas", "switch", "generic")]
    assert (old_vegas.name, old_vegas.kind, old_vegas.is_active, old_vegas.version) == (
        "Vegas Destination Old", "code", False, 2)
    assert (old_switch.name, old_switch.code, old_switch.is_active, old_switch.version) == (
        "Switch Front Tag Old 2", "^XA^FD{asset_id}^FS^XZ", True, 4)
    assert (old_generic.name, old_generic.is_active, old_generic.version) == (
        "Generic Rack and RU - 203DPI", True, 8)
    links = (await db.execute(select(LabelTemplateSite.template_id))).scalars().all()
    assert links == [ids["switch"]]
    # the rename is a saved change like any other: a version line and an audit row
    line = await db.scalar(select(LabelTemplateVersion.summary).where(
        LabelTemplateVersion.template_id == ids["switch"], LabelTemplateVersion.version == 4))
    assert line == "Changed name"
    renames = (await db.execute(select(AuditLog.entity_id, AuditLog.changes).where(
        AuditLog.entity_type == "label_template", AuditLog.action == "update"))).all()
    assert sorted((eid, c["name"]["to"]) for eid, c in renames) == sorted([
        (str(ids["vegas"]), "Vegas Destination Old"),
        (str(ids["switch"]), "Switch Front Tag Old 2")])

    parents = await _parents(db)
    assert sorted(parents) == sorted(NAMES)
    assert all(p.is_active is False for p in parents.values())

    # the operator's next step: Replace… swaps the old rows for the new
    # parent in one transaction under the one-active rule
    off, on = await tree.replace(db, parents["Generic Rack and RU"], [ids["generic"]],
                                 actor_id=None)
    assert [r.id for r in off] == [ids["generic"]]
    assert sorted(r.name for r in on) == [
        "Generic Rack and RU", "Generic Rack and RU · 203", "Generic Rack and RU · 300",
        "Generic Rack and RU · 600"]
    await db.rollback()


async def test_a_renamed_active_row_keeps_its_family_until_replace(db):
    """The old row the seed renames "Switch Front Tag Old" stays active and
    in the Switch Front Tag family: turning the rebuilt parent on beside it
    is refused, and Replace… swaps the two in one step (spec §4.1)."""
    old = _code_row("Switch Front Tag", is_active=True, version=3)
    db.add(old)
    await db.commit()
    old_id = old.id

    report = await builtin_templates.seed(db)
    assert ("Switch Front Tag", "Switch Front Tag Old") in report.renamed
    parent_id = (await _parents(db))["Switch Front Tag"].id
    row = await db.get(LabelTemplate, old_id, populate_existing=True)
    assert (row.name, row.is_active) == ("Switch Front Tag Old", True)
    assert await tree.family_of(db, row) == "Switch Front Tag"

    parent = await db.get(LabelTemplate, parent_id)
    with pytest.raises(tree.ActiveConflict) as refused:
        await tree.activate(db, parent)
    assert refused.value.names == ["Switch Front Tag Old"]
    await db.rollback()

    parent = await db.get(LabelTemplate, parent_id, populate_existing=True)
    off, on = await tree.replace(db, parent, [old_id], None)
    await db.commit()
    assert [r.id for r in off] == [old_id]
    assert sorted(r.name for r in on) == [
        "Switch Front Tag", "Switch Front Tag · 203", "Switch Front Tag · 300",
        "Switch Front Tag · 600"]
    row = await db.get(LabelTemplate, old_id, populate_existing=True)
    assert row.is_active is False
    children = await tree.children_of(db, parent)
    assert all(c.is_active for c in children) and parent.is_active


async def test_seed_refuses_a_name_a_dpi_child_holds(db):
    """ledger B3: a DPI child under one of the names is the coded error, and
    that template is not created (the ones before it are)."""
    other = await tree.create_parent(
        db, name="Elsewhere", description="", label_type="front", size_key="2x1",
        language_key="zpl", design=FRONT_ASSET_TAG, samples={}, site_ids=[], actor_id=None,
        is_active=False)
    child = (await tree.children_of(db, other))[0]
    child.name = "Front Asset Tag"
    await db.commit()
    with pytest.raises(builtin_templates.TemplateSeedError,
                       match="\"Front Asset Tag\" is a DPI child's name; rename it first") as exc:
        await builtin_templates.seed(db)
    assert exc.value.report.created == NAMES[:3]
    assert sorted(await _parents(db)) == sorted(["Elsewhere", *NAMES[:3]])


async def test_seed_rolls_back_a_rename_when_the_create_is_refused(db):
    """ledger B3: an older row named like one of the new DPI children
    ("<name> · 300") stops that template with NameTaken; the rename of
    the old row holding the name itself is rolled back with it, and the
    report the error carries lists what the seed did before."""
    db.add_all([_code_row("Vegas Destination"), _code_row("Front Asset Tag", label_type="front"),
                _code_row("Front Asset Tag · 300", label_type="front")])
    await db.commit()
    with pytest.raises(builtin_templates.TemplateSeedError,
                       match="Front Asset Tag: label_template_exists") as exc:
        await builtin_templates.seed(db)
    assert exc.value.report.created == NAMES[:3]
    assert exc.value.report.renamed == [("Vegas Destination", "Vegas Destination Old")]
    names = set((await db.execute(select(LabelTemplate.name))).scalars())
    assert {"Front Asset Tag", "Front Asset Tag · 300", "Vegas Destination Old"} <= names
    assert "Front Asset Tag Old" not in names
    assert sorted(await _parents(db)) == sorted(NAMES[:3])


async def test_seed_stops_before_writing_when_a_vocabulary_row_is_missing(db):
    await db.execute(LabelVocab.__table__.delete().where(
        LabelVocab.kind == "size", LabelVocab.key == "2x1"))
    await db.commit()
    with pytest.raises(builtin_templates.TemplateSeedError, match="2x1"):
        await builtin_templates.seed(db)
    assert await _count(db, LabelTemplate) == 0


def test_cli_seed_label_templates(monkeypatch):
    """`serversherpa seed-label-templates` runs the seed and reports what it
    renamed, created and skipped; a refused seed exits with the failure code."""
    from typer.testing import CliRunner

    from serversherpa import cli

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    async def no_dispose():
        pass

    outcome: list = [builtin_templates.SeedReport(
        created=["Vegas Destination", "Front Asset Tag"],
        renamed=[("Vegas Destination", "Vegas Destination Old")],
        skipped=["Switch Front Tag"])]

    async def fake_seed(db):
        if isinstance(outcome[0], Exception):
            raise outcome[0]
        return outcome[0]

    monkeypatch.setattr(cli, "get_sessionmaker", lambda: _Session)
    monkeypatch.setattr(cli, "dispose_engine", no_dispose)
    monkeypatch.setattr(builtin_templates, "seed", fake_seed)

    result = CliRunner().invoke(cli.app, ["seed-label-templates"])
    assert result.exit_code == 0, result.output
    assert 'renamed "Vegas Destination" to "Vegas Destination Old"' in result.output
    assert "created Vegas Destination" in result.output
    assert "created Front Asset Tag" in result.output
    assert "skipped Switch Front Tag" in result.output
    assert "Seeded 2 label template(s)" in result.output

    outcome[0] = builtin_templates.TemplateSeedError("no size 2x1 in the label vocabulary")
    result = CliRunner().invoke(cli.app, ["seed-label-templates"])
    assert result.exit_code == cli.EXIT_FAILED
    assert "no size 2x1" in result.output

    # ledger B2: a seed that stops partway still lists what it did first
    outcome[0] = builtin_templates.TemplateSeedError(
        "Front Asset Tag: label_template_exists", builtin_templates.SeedReport(
            created=["Vegas Destination"],
            renamed=[("Vegas Destination", "Vegas Destination Old")]))
    result = CliRunner().invoke(cli.app, ["seed-label-templates"])
    assert result.exit_code == cli.EXIT_FAILED
    assert 'renamed "Vegas Destination" to "Vegas Destination Old"' in result.output
    assert "created Vegas Destination" in result.output
    assert "Front Asset Tag: label_template_exists" in result.output


# ── the portal renders the seeded Vegas tag as the sync's item does ──

async def test_seeded_vegas_renders_alike_from_the_database_and_the_sync(client, db, seeded_user):
    """Three roster rows (a full five-piece location, a row with no
    destination, a blank row): the portal generator's path — asset_payload
    and label_context over ORM rows, into render_label with the seeded
    300 DPI child — prints the bytes render_template prints from the
    /kiosk/sync/assets item and its label_context, which is all a Label
    Station has (the edge's half is kiosk_laptop/edge/tests/test_vegas_parity.py)."""
    from serversherpa.db.models import Asset, AssetModel, Initiative
    from serversherpa.labels.generate.engine import render_label
    from serversherpa.labels.generate.payloads import (
        asset_payload,
        label_context,
        load_status_labels,
    )
    from tests.test_kiosk_label_inputs_sync import _builder_body, _seed_builder

    move = await _seed_builder(db)
    await builtin_templates.seed(db)
    child = await db.scalar(select(LabelTemplate).where(
        LabelTemplate.name == "Vegas Destination · 300"))
    body = await _builder_body(client, move)
    items = {i["name"]: i for i in body["assets"]}

    initiative = await db.get(Initiative, move.id)
    ctx = label_context(initiative, await db.get(Site, initiative.origin_site_id),
                        await db.get(Site, initiative.destination_site_id))
    statuses = await load_status_labels(db, "asset")
    rows = (await db.execute(
        select(Asset, InitiativeAsset, AssetModel)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == move.id))).all()
    assert len(rows) == 3
    printed = {}
    for asset, ia, model in rows:
        portal, unknown = render_label(
            child, field_values(asset_payload(asset, ia, model, statuses), ctx),
            size_meta={"width_in": 4, "height_in": 2}, dpi_meta={"dots": 300},
            language_key="zpl")
        station, _ = render_template(_source(child.design),
                                     field_values(items[asset.name], body["label_context"]),
                                     width_in=4, height_in=2, dots=300)
        assert unknown == set()
        assert portal == station, asset.name
        printed[asset.name] = portal

    full = printed["bld-0"]
    for anchor in ("^FT10,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD14^FS",
                   "^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS",
                   "^FO1030,18^GB165,92,92^FS",
                   "^FT1050,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD14^FS",
                   "^FT1120,580^A@B,45,45,E:TT0003M_.TTF^FH_^FDNAP9^FS",
                   "^FT1160,580^A@B,45,45,E:TT0003M_.TTF^FH_^FD10/07/2026^FS"):
        assert anchor in full, anchor
    # no destination: the inverted banner boxes print nothing at all
    assert "^GB165,92,92" not in printed["bld-1"] and "^FR" not in printed["bld-1"]
