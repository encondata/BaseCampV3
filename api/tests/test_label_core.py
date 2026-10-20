"""The pure label core (labels/label_values.py, render.py, pick.py) shared
by the portal generator and the laptop edge. Pure unit tests — no DB."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from serversherpa.db.models import Initiative, LabelTemplate, Site
from serversherpa.labels.generate.engine import render_label
from serversherpa.labels.generate.values import (
    AssetRow,
    ContainerRow,
    Sites,
    container_placeholder_values,
    placeholder_values,
)
from serversherpa.labels.label_values import (
    LabelAsset,
    LabelMove,
    asset_label_values,
    container_label_values,
)
from serversherpa.labels.pick import TemplateChoice, pick_template
from serversherpa.labels.render import render_template

SRC = Path(__file__).resolve().parents[1] / "src"


def test_core_modules_import_without_db():
    code = (
        "import sys\n"
        "sys.modules['sqlalchemy'] = None\n"
        "sys.modules['serversherpa.db'] = None\n"
        "sys.modules['serversherpa.services'] = None\n"
        "import serversherpa.labels.label_values, serversherpa.labels.render, "
        "serversherpa.labels.pick\n"
    )
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    proc = subprocess.run([sys.executable, "-c", code], env=env,
                          capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr


# --- values ---------------------------------------------------------------

CATALOG = [
    "asset_id", "asset_name", "serial_number", "make", "model", "make_model",
    "source_raw", "source_ru", "source_site", "destination_raw", "destination_ru",
    "destination_site", "move_name", "move_date", "move_date_long",
    "container_name", "container_id", "not_a_real_key",
]


def _row(**over) -> AssetRow:
    base = dict(
        asset_id="00000000-0000-0000-0000-0000000000aa", legacy_id=10482, name="core-sw-01",
        serial_number="C7X-00412-A", make="Cisco", model="Nexus 9336C",
        source_rack="NAP7 A12", source_ru=Decimal("14"), source_position="NAP7.A12.U14",
        destination_rack="NAP11 C03", destination_ru=Decimal("22"), destination_position=None,
    )
    base.update(over)
    return AssetRow(**base)


def _initiative(**over) -> Initiative:
    base = dict(name="NAP11 Hall Migration", initiative_type="move",
                scheduled_start=datetime(2026, 9, 15, tzinfo=UTC))
    base.update(over)
    return Initiative(**base)


def _sites() -> Sites:
    return Sites(origin=Site(name="NAP7"), destination=Site(name="NAP11"))


def _asset(row: AssetRow) -> LabelAsset:
    return LabelAsset(
        legacy_id=row.legacy_id, name=row.name, serial_number=row.serial_number,
        make=row.make, model=row.model, source_rack=row.source_rack,
        source_ru=row.source_ru, source_position=row.source_position,
        destination_rack=row.destination_rack, destination_ru=row.destination_ru,
        destination_position=row.destination_position)


def _move(initiative: Initiative, sites: Sites) -> LabelMove:
    day = initiative.scheduled_start.date() if initiative.scheduled_start else None
    return LabelMove(name=initiative.name, day=day,
                     source_site=sites.origin.name if sites.origin else None,
                     destination_site=sites.destination.name if sites.destination else None)


@pytest.mark.parametrize("row", [
    _row(source_ru=Decimal("14")),
    _row(source_ru=Decimal("14.5")),
    _row(source_ru=None, destination_ru=None),
    _row(legacy_id=None, make=None, model=None),
])
@pytest.mark.parametrize("rules", [
    None, {}, {"source": {"1": "src_room"}}, {"length_limits": {"asset_name": 5}},
])
@pytest.mark.parametrize("initiative", [_initiative(), _initiative(scheduled_start=None)])
def test_asset_label_values_matches_placeholder_values(row, rules, initiative):
    sites = _sites()
    keys = CATALOG + (["src_room"] if rules and "source" in rules else [])
    expected = placeholder_values(row, initiative, sites, keys, generation_rules=rules)
    got = asset_label_values(_asset(row), _move(initiative, sites), keys,
                             generation_rules=rules)
    assert got == expected


@pytest.mark.parametrize("tag", ["priority", "ewaste", None])
@pytest.mark.parametrize("legacy_id", [17, None])
def test_container_label_values_matches_container_placeholder_values(tag, legacy_id):
    initiative, sites = _initiative(), _sites()
    keys = ["container_name", "container_id", "label_tag", "move_name", "move_date",
            "move_date_long", "source_site", "destination_site", "asset_name"]
    rules = {"length_limits": {"container_name": 4}}
    row = ContainerRow(container_uuid="c", legacy_id=legacy_id, name="crate-17",
                       label_tag=tag)
    expected = container_placeholder_values(row, initiative, sites, keys,
                                            generation_rules=rules)
    got = container_label_values(
        legacy_id=row.legacy_id, name=row.name, label_tag=row.label_tag,
        move=_move(initiative, sites), catalog_keys=keys, generation_rules=rules)
    assert got == expected


# --- render ---------------------------------------------------------------

_DESIGN = {
    "elements": [
        {"type": "text", "x": 0.1, "y": 0.1, "w": 2.0, "h": 0.3,
         "content": "{asset_name} / {missing_token}", "fontSizePt": 12},
        {"type": "barcode", "x": 0.1, "y": 0.5, "w": 2.0, "h": 0.5,
         "data": "{serial_number}", "symbology": "code128"},
    ],
}


@pytest.mark.parametrize("dots", [203, 300])
@pytest.mark.parametrize("template", [
    LabelTemplate(kind="code", code="^XA^FD{asset_name}^FS^FD{nope}^FS^XZ", design=None,
                  language_key="zpl"),
    LabelTemplate(kind="design", code=None, design=_DESIGN, language_key="zpl"),
])
def test_render_template_matches_render_label(template, dots):
    values = {"asset_name": "a_b^c~d", "serial_number": "SN-1"}
    expected = render_label(template, values, size_meta={"width_in": 4, "height_in": 2},
                            dpi_meta={"dots": dots}, language_key="zpl")
    source = SimpleNamespace(kind=template.kind, code=template.code,
                             design=template.design, language_key="zpl")
    got = render_template(source, values, width_in=4, height_in=2, dots=dots)
    assert got == expected
    assert got[1]  # the unknown-token set is exercised, not vacuously empty


# --- pick -----------------------------------------------------------------

def _t(id, scope, dpi="203", *, family=None, label_type="top", version=1,
       updated_at="2026-10-01T00:00:00+00:00") -> TemplateChoice:
    return TemplateChoice(id=id, family=family or id, label_type=label_type, dpi_key=dpi,
                          version=version, updated_at=updated_at, scope=scope)


GRRU = "Generic Rack and RU"


def test_pick_falls_through_a_step_with_no_version_at_the_dpi():
    templates = [
        _t("dest-300", "destination", "300", family="Dest Top"),
        _t("src-203", "source", "203", family="Src Top"),
        _t("glob-203", "global", "203", family="Global Top"),
        _t("grru-203", "global", "203", family=GRRU),
    ]
    pick, notes = pick_template(templates, "top", "203")
    assert pick.id == "src-203"
    assert notes == [('The destination site\'s Top template "Dest Top" isn\'t available '
                      'at 203 DPI.')]
    pick, notes = pick_template(templates, "top", "300")
    assert pick.id == "dest-300"
    assert notes == []


def test_both_counts_as_destination():
    templates = [_t("src", "source"), _t("both", "both")]
    assert pick_template(templates, "top", "203")[0].id == "both"


def test_global_beats_generic_rack_and_ru():
    templates = [_t("grru", "global", family=GRRU), _t("glob", "global", family="Global Top"),
                 _t("other", "other")]
    assert pick_template(templates, "top", "203")[0].id == "glob"
    assert pick_template([_t("grru", "global", family="generic rack and ru")],
                         "top", "203")[0].id == "grru"


def test_generic_rack_and_ru_is_the_fallback_whatever_its_site_links():
    # The dev portal's Generic Rack and RU templates are linked to some other
    # site; the fallback must still be picked (Jimmy: the move always gets it).
    templates = [_t("grru-203", "other", "203", family=GRRU),
                 _t("grru-300", "other", "300", family=GRRU),
                 _t("elsewhere", "other", "300", family="Another site's Top")]
    assert pick_template(templates, "top", "300")[0].id == "grru-300"
    assert pick_template(templates, "top", "203")[0].id == "grru-203"


def test_front_ignores_source_and_generic_rack_and_ru():
    templates = [_t("src-f", "source", label_type="front"),
                 _t("grru-f", "global", family=GRRU, label_type="front"),
                 _t("top-dest", "destination")]
    assert pick_template(templates, "front", "203") == (None, [])
    templates.append(_t("glob-f", "global", label_type="front"))
    assert pick_template(templates, "front", "203")[0].id == "glob-f"
    templates.append(_t("dest-f", "destination", label_type="front"))
    assert pick_template(templates, "front", "203")[0].id == "dest-f"


def test_ties_break_by_version_then_updated_at():
    templates = [
        _t("a", "destination", version=2, updated_at="2026-10-05T00:00:00+00:00"),
        _t("b", "destination", version=3, updated_at="2026-10-01T00:00:00+00:00"),
        _t("c", "destination", version=3, updated_at="2026-10-02T00:00:00+00:00"),
    ]
    assert pick_template(templates, "top", "203")[0].id == "c"


def test_nothing_at_the_dpi_returns_none_with_notes():
    templates = [_t("dest", "destination", "300", family="Dest Top"),
                 _t("grru", "global", "300", family=GRRU)]
    pick, notes = pick_template(templates, "top", "203")
    assert pick is None
    assert notes[0] == ('The destination site\'s Top template "Dest Top" isn\'t available '
                        'at 203 DPI.')
    assert len(notes) == 2
