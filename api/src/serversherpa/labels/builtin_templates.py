"""The five stored code templates rebuilt as label builder designs (spec
§4.11), and `serversherpa seed-label-templates`, which loads them.

Each design is rebuilt from its stored 300 DPI ZPL: every position below is
the old template's dots at 300 DPI, converted to inches the way the Vegas
fixture (fixtures/vegas_v2.json) was: a text element's box stops at its
baseline, 0.72 of the font height, and its size in points is dots × 72 /
300. What changed on purpose:
- The V2 tokens become field keys: `{'asset serial number'}` is
  `serial_number`, `{destination_raw}` / `{source_raw}` are
  `destination_rack` / `source_rack`, `{source_site}` is
  `origin_site_code`, the RUs are the bare-number RU fields.
- The QR codes carry the bare asset ID (the `<` was a typo).
- Fonts the library doesn't hold (`E:85620388.TTF`, `^A0`) print in the
  default family, Swiss 721 Condensed Bold.
- Vegas and Amsterdam split `destination_rack` into their own pieces;
  Generic Rack and RU makes no assumption about a site's location format
  and prints it whole.

The seed creates each one as an inactive parent with its 203, 300 and 600
DPI children and no site links (Jimmy links sites and runs Replace… by
hand). An older template that already holds the exact name is renamed
"<name> Old" (then " Old 2", …) first; a builder template under the name
is left alone, so the seed can run again."""

import copy
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelTemplate, LabelVocab
from serversherpa.labels import templates_tree as tree
from serversherpa.labels.fields import MOCK_VALUES, design_field_keys
from serversherpa.labels.fonts import DEFAULT_FAMILY
from serversherpa.services.audit import audit, diff, snapshot

_DPI = 300          # the stored templates' DPI: the positions below are its dots
_CAP = 0.72         # a text box stops at the baseline, this much of the font height
_PAD_Y = 10         # dots: an inverted banner's padding across the text
_BANNER, _BODY = 100, 35   # the 4x2 tags' font heights in dots: banner, grid
_FONT = {"family": DEFAULT_FAMILY, "weight": "regular"}


def _in(dots: float) -> float:
    return round(dots / _DPI, 4)


def _reserve(chars: int, font_dots: int) -> int:
    """The width in dots the Vegas fixture reserves for `chars` characters:
    half the font height each."""
    return chars * font_dots // 2


def _typeset(ft_x: float, ft_y: float, font_dots: int, w_dots: int) -> dict:
    """Box and font of upright text whose `^FT` origin (the start of its
    baseline) is ft_x, ft_y at 300 DPI, `font_dots` tall, `w_dots` wide."""
    baseline = _in(_CAP * font_dots)
    return {"x": _in(ft_x), "y": round(ft_y / _DPI - baseline, 4), "w": _in(w_dots),
            "h": baseline, "rotation": 0, "locked": False, "font": dict(_FONT),
            "sizePt": round(font_dots * 72 / _DPI, 2), "baselineIn": baseline}


def _text(eid: str, content: str, ft_x: int, ft_y: float, font_dots: int, w_dots: int) -> dict:
    return {"id": eid, "type": "text", "content": content,
            **_typeset(ft_x, ft_y, font_dots, w_dots),
            "inverted": False, "align": "left", "lines": 1}


def _field(eid: str, key: str, ft_x: int, ft_y: float, font_dots: int, w_dots: int, *,
           piece: int | None = None, display: str = "text",
           expected: int | None = None) -> dict:
    el = {"id": eid, "type": "field", "field": key}
    if piece is not None:
        el["piece"] = piece
    return {**el, **_typeset(ft_x, ft_y, font_dots, w_dots), "hideWhenEmpty": False,
            "display": display, "inverted": False, "expectedLength": expected, "align": "left",
            "maxChars": None, "trim": None, "strip": None, "stripWhere": None}


def _boxed(eid: str, key: str, ft_x: int, ft_y: int, font_dots: int, *, box_x: int,
           box_w: int, **kw) -> dict:
    """A field printed in reverse inside the stored `^GB` box that starts at
    box_x and is box_w wide: the padding along the text is the gap from the
    box's edge to the text, the field's width what the box leaves inside."""
    pad = ft_x - box_x
    el = _field(eid, key, ft_x, ft_y, font_dots, box_w - 2 * pad, **kw)
    return {**el, "inverted": True, "invertPad": {"x": _in(pad), "y": _in(_PAD_Y)}}


def _samples(design: dict, **over: str) -> dict[str, str]:
    """A sample for every field the design places: the portal's mock value
    unless `over` gives one."""
    return {key: over.get(key, MOCK_VALUES[key]) for key in sorted(design_field_keys(design))}


VEGAS_DESTINATION: dict = json.loads(
    (Path(__file__).parent / "fixtures" / "vegas_v2.json").read_text())

_VEGAS = {el["id"]: el for el in VEGAS_DESTINATION["elements"]}


def _from_vegas(*ids: str) -> list[dict]:
    """Elements the 4x2 location tags share with Vegas: their stored ZPL is
    the same line for line (Name/Serial/Model, the rule, barcode, QR and
    the site and date up the right edge)."""
    return [copy.deepcopy(_VEGAS[i]) for i in ids]


_NAME_SERIAL_MODEL = ("caption-name", "value-name", "caption-serial", "value-serial",
                      "caption-model", "value-model", "rule")
_CODES_AND_SIDE = ("barcode", "qr", "side-site", "side-date")

# ^FO100,10^GB200 floor ^FT120 · room ^FT375 · ^FO580,10^GB250 rack ^FT620 ·
# ru ^FT950; the grid's second column at ^FT627 (captions) and ^FT759 (values)
AMSTERDAM_DESTINATION: dict = {
    "schema": 2,
    "size": {"w": 4, "h": 2},
    "splits": {"destination_rack": {"pieces": ["Floor", "Room", "POD", "Row", "Rack"]}},
    "elements": [
        _boxed("banner-floor", "destination_rack", 120, 100, _BANNER, box_x=100, box_w=200,
               piece=0, expected=2),
        _field("banner-room", "destination_rack", 375, 100, _BANNER, _reserve(2, _BANNER),
               piece=1, expected=2),
        _boxed("banner-rack", "destination_rack", 620, 100, _BANNER, box_x=580, box_w=250,
               piece=4, expected=2),
        _field("banner-ru", "destination_ru", 950, 100, _BANNER, _reserve(2, _BANNER),
               display="number", expected=2),
        *_from_vegas(*_NAME_SERIAL_MODEL),
        _text("grid-caption-floor", "FLOOR:", 38, 351, _BODY, 140),
        _field("grid-floor", "destination_rack", 185, 351, _BODY, _reserve(2, _BODY),
               piece=0, expected=2),
        _text("grid-caption-room", "ROOM:", 627, 351, _BODY, 120),
        _field("grid-room", "destination_rack", 759, 351, _BODY, _reserve(2, _BODY),
               piece=1, expected=2),
        _text("grid-caption-pod", "POD:", 38, 420, _BODY, 140),
        _field("grid-pod", "destination_rack", 185, 420, _BODY, _reserve(3, _BODY),
               piece=2, expected=3),
        _text("grid-caption-row", "ROW:", 627, 420, _BODY, 120),
        _field("grid-row", "destination_rack", 759, 420, _BODY, _reserve(2, _BODY),
               piece=3, expected=2),
        _text("grid-caption-rack", "RACK:", 38, 489, _BODY, 140),
        _field("grid-rack", "destination_rack", 185, 489, _BODY, _reserve(2, _BODY),
               piece=4, expected=2),
        _text("grid-caption-ru", "RU:", 627, 489, _BODY, 120),
        _field("grid-ru", "destination_ru", 759, 489, _BODY, _reserve(2, _BODY),
               display="number", expected=2),
        *_from_vegas(*_CODES_AND_SIDE),
    ],
}

# rack ^FT120 · ru ^FT650. With no Split there is no floor, room or row to
# print, so the stored grid keeps only POD (the roster's destination pod),
# RACK (the whole rack) and RU, where they were.
GENERIC_RACK_AND_RU: dict = {
    "schema": 2,
    "size": {"w": 4, "h": 2},
    "elements": [
        _field("banner-rack", "destination_rack", 120, 100, _BANNER, 500),
        _field("banner-ru", "destination_ru", 650, 100, _BANNER, _reserve(2, _BANNER),
               display="number", expected=2),
        *_from_vegas(*_NAME_SERIAL_MODEL),
        _text("grid-caption-pod", "POD:", 38, 420, _BODY, 140),
        _field("grid-pod", "destination_pod", 185, 420, _BODY, 400),
        _text("grid-caption-rack", "RACK:", 38, 489, _BODY, 140),
        _field("grid-rack", "destination_rack", 185, 489, _BODY, 400),
        _text("grid-caption-ru", "RU:", 627, 489, _BODY, 120),
        _field("grid-ru", "destination_ru", 759, 489, _BODY, _reserve(2, _BODY),
               display="number", expected=2),
        *_from_vegas(*_CODES_AND_SIDE),
    ],
}

# 2x1 (600 x 300 dots): ^FO15,2 Code 128 (^BC 35 tall, default ^BY2, text
# below); Target / RU at baseline 110; a 7-dot divider at ^FO15,125;
# Name, Serial, Model at 170, 205, 240; Source / RU at 275. Every text 35
# dots, captions at ^FT15 and ^FT450, values at ^FT140 and ^FT525.
FRONT_ASSET_TAG: dict = {
    "schema": 2,
    "size": {"w": 2, "h": 1},
    "elements": [
        # the compiler starts the six-digit sample in subset C (`>;`, two
        # digits a character): start, three characters and the check (11
        # modules each) plus stop (13) = 68 modules, 2 dots each = 136 dots
        # (at 203 DPI the module is one dot, ^BY1); the box is what prints
        {"id": "barcode", "type": "barcode", "field": "asset_id", "symbology": "code128",
         "moduleIn": _in(2), "showText": True, "x": _in(15), "y": _in(2), "w": _in(136),
         "h": _in(35), "rotation": 0, "locked": False, "hideWhenEmpty": False},
        _text("caption-target", "Target:", 15, 110, _BODY, 120),
        _field("value-target", "destination_rack", 140, 110, _BODY, 300),
        _text("caption-target-ru", "RU:", 450, 110, _BODY, 70),
        _field("value-target-ru", "destination_ru", 525, 110, _BODY, _reserve(2, _BODY),
               display="number", expected=2),
        {"id": "rule", "type": "line", "x": _in(15), "y": _in(125), "w": _in(570), "h": 0,
         "rotation": 0, "locked": False, "strokeIn": _in(7)},
        _text("caption-name", "Name:", 15, 170, _BODY, 120),
        _field("value-name", "asset_name", 140, 170, _BODY, 445),
        _text("caption-serial", "Serial:", 15, 205, _BODY, 120),
        _field("value-serial", "serial_number", 140, 205, _BODY, 445),
        _text("caption-model", "Model:", 15, 240, _BODY, 120),
        _field("value-model", "make_model", 140, 240, _BODY, 445),
        _text("caption-source", "Source:", 15, 275, _BODY, 120),
        _field("value-source", "source_rack", 140, 275, _BODY, 300),
        _text("caption-source-ru", "RU:", 450, 275, _BODY, 70),
        _field("value-source-ru", "source_ru", 525, 275, _BODY, _reserve(2, _BODY),
               display="number", expected=2),
    ],
}

# ^FO50,50^A0N,40,40: the serial number, its top 50 dots in and down
SWITCH_FRONT_TAG: dict = {
    "schema": 2,
    "size": {"w": 4, "h": 2},
    "elements": [_field("value-serial", "serial_number", 50, 50 + _CAP * 40, 40, 1100)],
}


@dataclass(frozen=True)
class BuiltinTemplate:
    name: str
    description: str
    label_type: str
    size_key: str
    design: dict
    samples: dict[str, str]
    language_key: str = "zpl"


BUILTIN_TEMPLATES: list[BuiltinTemplate] = [
    BuiltinTemplate(
        "Vegas Destination",
        "Top label for Switch sites: the destination location split into NAP, sector, POD, "
        "row and rack, plus the RU.",
        "top", "4x2", VEGAS_DESTINATION, _samples(VEGAS_DESTINATION)),
    BuiltinTemplate(
        "Amsterdam Destination",
        "Top label for Amsterdam sites: the destination location split into floor, room, "
        "POD, row and rack, plus the RU.",
        "top", "4x2", AMSTERDAM_DESTINATION, _samples(AMSTERDAM_DESTINATION)),
    BuiltinTemplate(
        "Generic Rack and RU",
        "Fallback top label for any site, with the destination rack and RU as the roster "
        "has them.",
        # a rack the banner fits: the mock's full location string is
        # a Vegas one, longer than the banner holds at this size
        "top", "4x2", GENERIC_RACK_AND_RU,
        _samples(GENERIC_RACK_AND_RU, destination_rack="DH2-R14")),
    BuiltinTemplate(
        "Front Asset Tag",
        "Front label with the asset ID barcode, the target and source rack and RU, and the "
        "asset's name, serial and model.",
        "front", "2x1", FRONT_ASSET_TAG, _samples(FRONT_ASSET_TAG)),
    BuiltinTemplate(
        "Switch Front Tag",
        "Top label for Switch sites that prints only the asset's serial number.",
        "top", "4x2", SWITCH_FRONT_TAG, _samples(SWITCH_FRONT_TAG)),
]


# ── seed-label-templates ────────────────────────────────────────────

@dataclass
class SeedReport:
    created: list[str] = field(default_factory=list)
    renamed: list[tuple[str, str]] = field(default_factory=list)   # (from, to)
    skipped: list[str] = field(default_factory=list)


class TemplateSeedError(RuntimeError):
    """The seed can't go on. Templates seeded before it stay; nothing of
    the one that failed is kept. `report` is what the seed did before it
    stopped, so the command can still list it."""

    def __init__(self, message: str, report: SeedReport | None = None):
        super().__init__(message)
        self.report = report or SeedReport()


async def _check_vocab(db: AsyncSession) -> None:
    """Every type, size, DPI and language the five use is in the label
    vocabulary, and each size is the design's size."""
    rows = {(r.kind, r.key): r for r in (await db.execute(select(LabelVocab))).scalars()}
    needed = {("dpi", d) for d in tree.TREE_DPIS}
    for b in BUILTIN_TEMPLATES:
        needed |= {("type", b.label_type), ("size", b.size_key), ("language", b.language_key)}
    missing = sorted(needed - rows.keys())
    if missing:
        raise TemplateSeedError("not in the label vocabulary: "
                                + ", ".join(f"{kind} {key}" for kind, key in missing))
    for b in BUILTIN_TEMPLATES:
        meta = rows[("size", b.size_key)].meta or {}
        w, h = b.design["size"]["w"], b.design["size"]["h"]
        if (meta.get("width_in"), meta.get("height_in")) != (w, h):
            raise TemplateSeedError(f"size {b.size_key} in the label vocabulary is not "
                                    f'{w}" x {h}"')


async def _rename_old(db: AsyncSession, row: LabelTemplate, name: str) -> str:
    """Rename an older template "<name> Old" (or the next free " Old N") the
    way a rename on the templates page does: a version line, an audit row,
    and the one-active rule when it is active. Returns the new name."""
    before = snapshot(row, tree.TEMPLATE_FIELDS)
    row.name = await tree.free_old_name(db, name)
    row.version += 1
    row.updated_at = datetime.now(UTC)
    tree.add_version(db, row, version=row.version, summary="Changed name", actor_id=None)
    audit(db, actor_id=None, entity_type="label_template", entity_id=str(row.id),
          action="update", changes=diff(before, snapshot(row, tree.TEMPLATE_FIELDS)))
    if row.is_active:
        await tree.guard_active(db, [row])
    await db.flush()
    return row.name


async def _create(db: AsyncSession, b: BuiltinTemplate) -> None:
    parent = await tree.create_parent(
        db, name=b.name, description=b.description, label_type=b.label_type,
        size_key=b.size_key, language_key=b.language_key, design=b.design, samples=b.samples,
        site_ids=[], actor_id=None, is_active=False)
    changes = diff({}, snapshot(parent, tree.TEMPLATE_FIELDS))
    changes["children"] = {"from": [], "to": [
        tree.child_name(parent.name, d) for d in tree.TREE_DPIS]}
    audit(db, actor_id=None, entity_type="label_template", entity_id=str(parent.id),
          action="create", changes=changes)


async def seed(db: AsyncSession) -> SeedReport:
    """Create each built-in template that no builder template holds the
    name of yet; each one commits on its own."""
    await _check_vocab(db)
    report = SeedReport()
    for b in BUILTIN_TEMPLATES:
        holder = await db.scalar(select(LabelTemplate).where(LabelTemplate.name == b.name))
        if holder is not None and holder.is_tree_parent:
            report.skipped.append(b.name)
            continue
        renamed: tuple[str, str] | None = None
        try:
            if holder is not None:
                if holder.parent_id is not None:
                    raise TemplateSeedError(f'"{b.name}" is a DPI child\'s name; rename it first',
                                            report)
                renamed = (holder.name, await _rename_old(db, holder, b.name))
            await _create(db, b)
        except tree.TreeError as exc:
            await db.rollback()
            detail = ", ".join(f"{k}: {v}" for k, v in exc.extra.items())
            raise TemplateSeedError(f"{b.name}: {exc.code}" + (f" ({detail})" if detail else ""),
                                    report) from exc
        except TemplateSeedError:
            await db.rollback()
            raise
        await db.commit()
        if renamed:
            report.renamed.append(renamed)
        report.created.append(b.name)
    return report
