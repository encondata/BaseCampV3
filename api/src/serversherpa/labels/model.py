"""Parse/validate label element-model JSON into frozen dataclasses.

The single validator every compiler consumes. Pure — no DB, no IO.
Coordinates are inches (floats); only compilers convert to dots.
Problems are collected per element (prefixed with the element id) so the
editor can surface them inline; any problem raises DesignError.

Two schemas. A design with no `schema` (or `schema: 1`) is the original
model: text whose content carries {tokens}, barcodes and QR codes with
token data, lines and boxes. `schema: 2` is the label builder's model
(spec §4.2): `field` elements bound to a field key (a catalog key or an
`ft:<header>` From-To column; keys are opaque strings), optionally one
piece of the field's Split, each with its own rules, font and inverted
flag; static `text` with a font and a baseline; barcodes and QR codes
bound to a field or holding static data; lines; boxes that can be filled.
`schema: 3` is schema 2 plus `image` elements (spec 2026-10-20-badge-
templates §4.3, §4.6): a design with an image is schema 3 and one without
stays schema 2, so a laptop edge that prints up to schema 2 refuses a
design with an image instead of printing it without one.

Geometry, schema 2 and 3: x, y is the top-left of the element's footprint
on the label. w runs along the element's own text direction and h across
it, so at rotation 90 or 270 the footprint is h wide and w tall (an image
fits its unrotated w x h box, then turns with it). A text
element's `baselineIn` is the distance from its top edge (in its own
frame) to the text baseline; the browser computes it from the font's
metrics, and the compiler never measures text."""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Mapping
from dataclasses import dataclass

from serversherpa.labels.dither import BRIGHTNESS, CONTRAST, MODES, THRESHOLD, Params
from serversherpa.labels.field_rules import FieldRules, apply_rules, is_blank
from serversherpa.labels.field_rules import piece as split_piece
from serversherpa.labels.fonts import DEFAULT_FAMILY, FAMILIES, WEIGHTS

ROTATIONS = (0, 90, 180, 270)
SYMBOLOGIES = ("code128", "code39")
ALIGNS = ("left", "center", "right")
SCHEMAS = (1, 2, 3)
DISPLAYS = ("text", "number", "barcode", "qr")
TRIMS = ("front", "rear")
STRIP_WHERES = ("front", "rear", "anywhere")
IMAGE_SOURCES = ("photo", "logo", "static")
FITS = ("cover", "contain")
# a photo fills its box and is dithered; a logo or a static image fits
# inside it and is thresholded (spec §4.3)
IMAGE_DEFAULTS = {"photo": ("cover", "dither"), "logo": ("contain", "threshold"),
                  "static": ("contain", "threshold")}
# A field's expected length and max characters pad or trim its value to
# that many characters, and a text's lines size its ^FB, so each has a
# ceiling: nothing on a label needs more, and the compile must not
# allocate whatever a request asks for.
MAX_COUNT = 64
MAX_LINES = 50
# every save copies the design into a version row and each DPI child, and
# it rides every kiosk sync
MAX_ELEMENTS = 500


class DesignError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass(frozen=True)
class Font:
    """A family slug from labels.fonts and a weight (regular | bold)."""
    family: str
    weight: str


@dataclass(frozen=True)
class Pad:
    """An inverted element's padding in inches: x along the text, y across."""
    x: float
    y: float


@dataclass(frozen=True)
class _Base:
    id: str
    x: float
    y: float
    w: float
    h: float
    rotation: int


@dataclass(frozen=True)
class TextEl(_Base):
    content: str
    font_size_pt: float
    bold: bool
    align: str
    # `reverse` emits ZPL ^FR (knockout text, for text sitting on a filled
    # bar); `lines` is the ^FB line count, so a field can wrap. Both are
    # Zebra-only and default to the pre-2026-09-16 behavior.
    reverse: bool = False
    lines: int = 1
    # schema 2 only (None/False on a schema 1 design): static text, no tokens
    font: Font | None = None
    baseline_in: float | None = None
    inverted: bool = False
    invert_pad: Pad | None = None


@dataclass(frozen=True)
class BarcodeEl(_Base):
    symbology: str
    data: str
    show_text: bool
    # Narrow-module width in INCHES. None keeps the historical hardcoded
    # ^BY2, which makes a barcode physically narrower at 300 dpi than at
    # 203; a design that needs the same physical width at both sets this.
    module_in: float | None = None
    # schema 2: bound to a field key (then `data` is ""), else static data
    field: str | None = None
    hide_when_empty: bool = False


@dataclass(frozen=True)
class QrEl(_Base):
    data: str
    field: str | None = None
    hide_when_empty: bool = False


@dataclass(frozen=True)
class LineEl(_Base):
    stroke_in: float


@dataclass(frozen=True)
class BoxEl(_Base):
    stroke_in: float
    fill: bool = False


@dataclass(frozen=True)
class FieldEl(_Base):
    """Schema 2: one placement of a field, with its own formatting."""
    field: str
    piece: int | None  # 0-based piece of the field's Split; None = whole value
    display: str
    font: Font
    font_size_pt: float
    baseline_in: float
    align: str
    inverted: bool
    invert_pad: Pad
    hide_when_empty: bool = False
    expected_length: int | None = None
    max_chars: int | None = None
    trim: str | None = None
    strip: str | None = None
    strip_where: str | None = None
    # display == "barcode"
    symbology: str = "code128"
    module_in: float | None = None
    show_text: bool = True

    @property
    def bold(self) -> bool:
        return self.font.weight == "bold"

    @property
    def rules(self) -> FieldRules:
        pairs = (("display", self.display), ("expected_length", self.expected_length),
                 ("max_chars", self.max_chars), ("trim", self.trim),
                 ("strip", self.strip), ("strip_where", self.strip_where))
        return {k: v for k, v in pairs if v is not None}  # type: ignore[return-value]


@dataclass(frozen=True)
class ImageEl(_Base):
    """Schema 3: a picture printed as a Zebra graphic. `source` is the
    sample person's photo or logo, or a static image from the label image
    library (`image_id`, a static image only; None until one is picked).
    The compiler takes its already-dithered bits from the caller
    (labels/zpl.py `compile_zpl(images=)`); never a field key, so an image
    is never a placeholder or an unknown key."""
    source: str
    image_id: str | None
    fit: str
    mode: str
    brightness: int = 0
    contrast: int = 100
    threshold: int = 128
    invert: bool = False
    # a missing photo or logo prints nothing; off, an outlined box
    hide_when_empty: bool = True

    @property
    def params(self) -> Params:
        return Params(brightness=self.brightness, contrast=self.contrast,
                      threshold=self.threshold, mode=self.mode, invert=self.invert)


@dataclass(frozen=True)
class Design:
    width_in: float
    height_in: float
    elements: tuple
    schema: int = 1
    # schema 2 and 3: field key -> the piece names of its Split (one per field)
    splits: dict[str, tuple[str, ...]] = dataclasses.field(default_factory=dict)


def _raw_value(el: FieldEl, values: Mapping[str, str]) -> str:
    raw = values.get(el.field) or ""
    return raw if el.piece is None else split_piece(raw, el.piece)


def element_value(el: object, values: Mapping[str, str]) -> str:
    """The text a schema-2 element prints: a field's value through Split
    and its rules, a static text's content, a barcode's or QR code's field
    value or static data. Values are never token-expanded."""
    if isinstance(el, FieldEl):
        return apply_rules(_raw_value(el, values), el.rules)
    if isinstance(el, TextEl):
        return el.content
    if isinstance(el, (BarcodeEl, QrEl)):
        return (values.get(el.field) or "") if el.field is not None else el.data
    return ""


def element_hidden(el: object, values: Mapping[str, str]) -> bool:
    """A schema-2 element that prints nothing at all: hide-when-empty with
    a value that is blank after Strip and trim, or an inverted element with
    nothing to reverse (no box either)."""
    if isinstance(el, FieldEl):
        blank = is_blank(_raw_value(el, values), el.rules)
        return blank and (el.hide_when_empty or el.inverted)
    if isinstance(el, TextEl):
        return el.inverted and el.content == ""
    if isinstance(el, (BarcodeEl, QrEl)):
        return el.hide_when_empty and element_value(el, values) == ""
    return False


def _num(v) -> bool:
    """A finite number: JSON's Infinity/NaN parse, but no length is one."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _need_num(el: dict, field: str, p: list[str], allow_zero: bool = True) -> float:
    v = el.get(field)
    if not _num(v) or v < 0 or (v == 0 and not allow_zero):
        p.append(f"{field} must be a non-negative number"
                 if allow_zero else f"{field} must be a positive number")
        return 0.0
    return float(v)


def _align(el: dict, p: list[str]) -> str:
    align = el.get("align", "left")
    if align not in ALIGNS:
        p.append("align must be left/center/right")
        return "left"
    return align


def _lines(el: dict, p: list[str]) -> int:
    lines = el.get("lines", 1)
    if not _int(lines) or lines < 1:
        p.append("lines must be an integer of 1 or more")
        return 1
    if lines > MAX_LINES:
        p.append(f"lines must be at most {MAX_LINES}")
        return 1
    return lines


def _symbology(el: dict, p: list[str]) -> str:
    sym = el.get("symbology")
    if sym not in SYMBOLOGIES:
        p.append("symbology must be code128 or code39")
        return "code128"
    return sym


def _module_in(el: dict, p: list[str]) -> float | None:
    module_in = el.get("moduleIn")
    if module_in is None:
        return None
    if not _num(module_in) or module_in <= 0:
        p.append("moduleIn must be a positive number")
        return None
    return float(module_in)


def _barcode_opts(el: dict, p: list[str]) -> tuple[str, float | None, bool]:
    return _symbology(el, p), _module_in(el, p), bool(el.get("showText", True))


def _stroke(el: dict, p: list[str]) -> float:
    stroke = el.get("strokeIn")
    if not _num(stroke) or stroke <= 0:
        p.append("strokeIn must be a positive number")
        return 0.01
    return float(stroke)


def _v1_element(el: dict, base: dict, p: list[str]) -> object | None:
    etype = el.get("type")
    if etype == "text":
        content = el.get("content")
        if not isinstance(content, str):
            p.append("content must be a string")
            content = ""
        fs = el.get("fontSizePt")
        if not _num(fs) or fs <= 0:
            p.append("fontSizePt must be a positive number")
            fs = 10
        return TextEl(**base, content=content, font_size_pt=float(fs),
                      bold=bool(el.get("bold", False)), align=_align(el, p),
                      reverse=bool(el.get("reverse", False)), lines=_lines(el, p))
    if etype == "barcode":
        sym = _symbology(el, p)
        data = el.get("data")
        if not isinstance(data, str) or not data:
            p.append("data must be a non-empty string")
            data = ""
        return BarcodeEl(**base, symbology=sym, data=data,
                         show_text=bool(el.get("showText", True)),
                         module_in=_module_in(el, p))
    if etype == "qr":
        data = el.get("data")
        if not isinstance(data, str) or not data:
            p.append("data must be a non-empty string")
            data = ""
        return QrEl(**base, data=data)
    if etype in ("line", "box"):
        cls = LineEl if etype == "line" else BoxEl
        return cls(**base, stroke_in=_stroke(el, p))
    p.append(f"unknown type {etype!r}")
    return None


def _font(el: dict, p: list[str]) -> Font:
    raw = el.get("font")
    if raw is None:
        return Font(DEFAULT_FAMILY, "regular")
    if (not isinstance(raw, dict) or raw.get("family") not in FAMILIES
            or raw.get("weight", "regular") not in WEIGHTS):
        p.append("font must name a known family and a weight of regular or bold")
        return Font(DEFAULT_FAMILY, "regular")
    return Font(raw["family"], raw.get("weight", "regular"))


def _typeset(el: dict, p: list[str], *, required: bool = True) -> tuple[Font, float, float]:
    """Font, size in points and baseline in inches. A field displayed as a
    barcode or QR code needs none of them (defaults when absent)."""
    font = _font(el, p)
    size = el.get("sizePt")
    if size is None and not required:
        size = 0.0
    elif not _num(size) or size <= 0:
        p.append("sizePt must be a positive number")
        size = 10.0
    baseline = el.get("baselineIn")
    if baseline is None and not required:
        baseline = 0.0
    elif not _num(baseline) or baseline < 0:
        p.append("baselineIn must be a non-negative number")
        baseline = 0.0
    return font, float(size), float(baseline)


def _invert_pad(el: dict, p: list[str], size_pt: float) -> Pad:
    """Default: a quarter of the font size along the text, a tenth across."""
    default = Pad(x=0.25 * size_pt / 72, y=0.10 * size_pt / 72)
    raw = el.get("invertPad")
    if raw is None:
        return default
    if (not isinstance(raw, dict) or not _num(raw.get("x")) or raw["x"] < 0
            or not _num(raw.get("y")) or raw["y"] < 0):
        p.append("invertPad must hold non-negative numbers x and y")
        return default
    return Pad(x=float(raw["x"]), y=float(raw["y"]))


def _opt_count(el: dict, key: str, p: list[str]) -> int | None:
    v = el.get(key)
    if v is None:
        return None
    if not _int(v) or v < 1:
        p.append(f"{key} must be a whole number of 1 or more")
        return None
    if v > MAX_COUNT:
        p.append(f"{key} must be at most {MAX_COUNT}")
        return None
    return v


def _opt_choice(el: dict, key: str, choices: tuple[str, ...], p: list[str]) -> str | None:
    v = el.get(key)
    if v is None:
        return None
    if v not in choices:
        p.append(f"{key} must be one of {'/'.join(choices)}")
        return None
    return v


def _source(el: dict, p: list[str]) -> tuple[str | None, str]:
    """A barcode or QR code holds a field key or static data, never both."""
    field, data = el.get("field"), el.get("data")
    if (field is None) == (data is None):
        p.append("needs exactly one of field or data")
        return None, ""
    if field is not None:
        if not isinstance(field, str) or not field:
            p.append("field must be a non-empty string")
            return None, ""
        return field, ""
    if not isinstance(data, str) or not data:
        p.append("data must be a non-empty string")
        return None, ""
    return None, data


def _v2_field(el: dict, base: dict, p: list[str], splits: dict) -> FieldEl:
    key = el.get("field")
    if not isinstance(key, str) or not key:
        p.append("field must be a non-empty string")
        key = ""
    piece = el.get("piece")
    if piece is not None:
        if not _int(piece) or piece < 0:
            p.append("piece must be a whole number of 0 or more")
            piece = None
        elif key not in splits:
            p.append(f"piece {piece} needs a Split defined for {key!r}")
        elif piece >= len(splits[key]):
            p.append(f"piece {piece} is beyond {key!r}'s Split ({len(splits[key])} pieces)")
    display = el.get("display", "text")
    if display not in DISPLAYS:
        p.append("display must be one of " + "/".join(DISPLAYS))
        display = "text"
    font, size, baseline = _typeset(el, p, required=display in ("text", "number"))
    strip = el.get("strip")
    if strip is not None and not isinstance(strip, str):
        p.append("strip must be a string")
        strip = None
    sym, module_in, show_text = (_barcode_opts(el, p) if display == "barcode"
                                 else ("code128", None, True))
    return FieldEl(
        **base, field=key, piece=piece, display=display, font=font,
        font_size_pt=size, baseline_in=baseline, align=_align(el, p),
        inverted=bool(el.get("inverted", False)), invert_pad=_invert_pad(el, p, size),
        hide_when_empty=bool(el.get("hideWhenEmpty", False)),
        expected_length=_opt_count(el, "expectedLength", p),
        max_chars=_opt_count(el, "maxChars", p),
        trim=_opt_choice(el, "trim", TRIMS, p),
        strip=strip or None,
        strip_where=_opt_choice(el, "stripWhere", STRIP_WHERES, p),
        symbology=sym, module_in=module_in, show_text=show_text)


def _whole_in(el: dict, key: str, default: int, bounds: tuple[int, int],
              p: list[str]) -> int:
    v = el.get(key, default)
    lo, hi = bounds
    if not _int(v) or not lo <= v <= hi:
        p.append(f"{key} must be a whole number from {lo} to {hi}")
        return default
    return v


def _v2_image(el: dict, base: dict, p: list[str]) -> ImageEl:
    source = el.get("source")
    if source not in IMAGE_SOURCES:
        p.append("source must be one of " + "/".join(IMAGE_SOURCES))
        source = "static"
    image_id = None
    if source == "static" and el.get("imageId") is not None:
        image_id = el["imageId"]
        if not isinstance(image_id, str) or not image_id:
            p.append("imageId must be a non-empty string")
            image_id = None
    fit_default, mode_default = IMAGE_DEFAULTS[source]
    fit = el.get("fit", fit_default)
    if fit not in FITS:
        p.append("fit must be cover or contain")
        fit = fit_default
    mode = el.get("mode", mode_default)
    if mode not in MODES:
        p.append("mode must be dither or threshold")
        mode = mode_default
    brightness = _whole_in(el, "brightness", 0, BRIGHTNESS, p)
    contrast = _whole_in(el, "contrast", 100, CONTRAST, p)
    threshold = _whole_in(el, "threshold", 128, THRESHOLD, p)
    if base["w"] <= 0 or base["h"] <= 0:
        p.append("an image needs a positive w and h")
    return ImageEl(**base, source=source, image_id=image_id, fit=fit, mode=mode,
                   brightness=brightness, contrast=contrast, threshold=threshold,
                   invert=bool(el.get("invert", False)),
                   hide_when_empty=bool(el.get("hideWhenEmpty", True)))


def _v2_element(el: dict, base: dict, p: list[str], splits: dict,
                schema: int) -> object | None:
    etype = el.get("type")
    if etype == "image":
        if schema < 3:
            p.append("an image element needs schema 3")
        return _v2_image(el, base, p)
    if etype == "field":
        return _v2_field(el, base, p, splits)
    if etype == "text":
        content = el.get("content")
        if not isinstance(content, str):
            p.append("content must be a string")
            content = ""
        font, size, baseline = _typeset(el, p)
        return TextEl(**base, content=content, font_size_pt=size,
                      bold=font.weight == "bold", align=_align(el, p),
                      lines=_lines(el, p), font=font, baseline_in=baseline,
                      inverted=bool(el.get("inverted", False)),
                      invert_pad=_invert_pad(el, p, size))
    if etype in ("barcode", "qr"):
        field, data = _source(el, p)
        hide = bool(el.get("hideWhenEmpty", False))
        if etype == "qr":
            return QrEl(**base, data=data, field=field, hide_when_empty=hide)
        sym, module_in, show_text = _barcode_opts(el, p)
        return BarcodeEl(**base, symbology=sym, data=data, show_text=show_text,
                         module_in=module_in, field=field, hide_when_empty=hide)
    if etype == "line":
        return LineEl(**base, stroke_in=_stroke(el, p))
    if etype == "box":
        return BoxEl(**base, stroke_in=_stroke(el, p), fill=bool(el.get("fill", False)))
    p.append(f"unknown type {etype!r}")
    return None


def _splits(raw: object, problems: list[str]) -> dict[str, tuple[str, ...]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        problems.append("splits must be an object")
        return {}
    out: dict[str, tuple[str, ...]] = {}
    for key, spec in raw.items():
        pieces = spec.get("pieces") if isinstance(spec, dict) else None
        if (not isinstance(pieces, list) or not pieces
                or not all(isinstance(n, str) for n in pieces)):
            problems.append(f"splits: {key!r} must hold a non-empty list of piece names")
            continue
        out[key] = tuple(pieces)
    return out


def parse_design(raw: object) -> Design:
    problems: list[str] = []
    if not isinstance(raw, dict):
        raise DesignError(["design must be an object"])
    schema = raw.get("schema", 1)
    if not _int(schema) or schema not in SCHEMAS:
        raise DesignError([f"schema must be 1, 2 or 3, not {schema!r}"])
    size = raw.get("size")
    if (not isinstance(size, dict) or not _num(size.get("w"))
            or not _num(size.get("h")) or size["w"] <= 0 or size["h"] <= 0):
        raise DesignError(["size must hold positive numbers w and h"])
    elements = raw.get("elements")
    if not isinstance(elements, list):
        raise DesignError(["elements must be a list"])
    if len(elements) > MAX_ELEMENTS:
        raise DesignError([f"a design holds at most {MAX_ELEMENTS} elements"])
    splits = _splits(raw.get("splits"), problems) if schema >= 2 else {}

    parsed: list[object] = []
    for i, el in enumerate(elements):
        if not isinstance(el, dict):
            problems.append(f"element {i}: must be an object")
            continue
        eid = el.get("id") if isinstance(el.get("id"), str) else f"element {i}"
        p: list[str] = []
        x, y = _need_num(el, "x", p), _need_num(el, "y", p)
        w, h = _need_num(el, "w", p), _need_num(el, "h", p)
        rotation = el.get("rotation", 0)
        if rotation not in ROTATIONS:
            p.append("rotation must be one of 0/90/180/270")
            rotation = 0
        base = dict(id=eid, x=x, y=y, w=w, h=h, rotation=rotation)
        parsed_el = (_v1_element(el, base, p) if schema == 1
                     else _v2_element(el, base, p, splits, schema))
        if parsed_el is not None:
            parsed.append(parsed_el)
        problems.extend(f"{eid}: {msg}" for msg in p)
    if schema == 3 and not any(isinstance(e, ImageEl) for e in parsed):
        problems.append("a schema 3 design needs an image element")

    if problems:
        raise DesignError(problems)
    return Design(width_in=float(size["w"]), height_in=float(size["h"]),
                  elements=tuple(parsed), schema=schema, splits=splits)
