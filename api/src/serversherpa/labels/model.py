"""Parse/validate label element-model JSON into frozen dataclasses.

The single validator every compiler consumes. Pure — no DB, no IO.
Coordinates are inches (floats); only compilers convert to dots.
Problems are collected per element (prefixed with the element id) so the
editor can surface them inline; any problem raises DesignError."""

from __future__ import annotations

from dataclasses import dataclass

ROTATIONS = (0, 90, 180, 270)
SYMBOLOGIES = ("code128", "code39")
ALIGNS = ("left", "center", "right")


class DesignError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


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


@dataclass(frozen=True)
class BarcodeEl(_Base):
    symbology: str
    data: str
    show_text: bool


@dataclass(frozen=True)
class QrEl(_Base):
    data: str


@dataclass(frozen=True)
class LineEl(_Base):
    stroke_in: float


@dataclass(frozen=True)
class BoxEl(_Base):
    stroke_in: float


@dataclass(frozen=True)
class Design:
    width_in: float
    height_in: float
    elements: tuple


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_design(raw: object) -> Design:
    problems: list[str] = []
    if not isinstance(raw, dict):
        raise DesignError(["design must be an object"])
    size = raw.get("size")
    if (not isinstance(size, dict) or not _num(size.get("w"))
            or not _num(size.get("h")) or size["w"] <= 0 or size["h"] <= 0):
        raise DesignError(["size must hold positive numbers w and h"])
    elements = raw.get("elements")
    if not isinstance(elements, list):
        raise DesignError(["elements must be a list"])

    parsed: list[object] = []
    for i, el in enumerate(elements):
        if not isinstance(el, dict):
            problems.append(f"element {i}: must be an object")
            continue
        eid = el.get("id") if isinstance(el.get("id"), str) else f"element {i}"
        p: list[str] = []

        def need_num(field: str, allow_zero: bool = True) -> float:
            v = el.get(field)
            if not _num(v) or v < 0 or (v == 0 and not allow_zero):
                p.append(f"{field} must be a non-negative number"
                         if allow_zero else f"{field} must be a positive number")
                return 0.0
            return float(v)

        x, y = need_num("x"), need_num("y")
        w, h = need_num("w"), need_num("h")
        rotation = el.get("rotation", 0)
        if rotation not in ROTATIONS:
            p.append("rotation must be one of 0/90/180/270")
            rotation = 0
        etype = el.get("type")
        base = dict(id=eid, x=x, y=y, w=w, h=h, rotation=rotation)

        if etype == "text":
            content = el.get("content")
            if not isinstance(content, str):
                p.append("content must be a string")
                content = ""
            fs = el.get("fontSizePt")
            if not _num(fs) or fs <= 0:
                p.append("fontSizePt must be a positive number")
                fs = 10
            align = el.get("align", "left")
            if align not in ALIGNS:
                p.append("align must be left/center/right")
                align = "left"
            parsed.append(TextEl(**base, content=content,
                                 font_size_pt=float(fs),
                                 bold=bool(el.get("bold", False)),
                                 align=align))
        elif etype == "barcode":
            sym = el.get("symbology")
            if sym not in SYMBOLOGIES:
                p.append("symbology must be code128 or code39")
                sym = "code128"
            data = el.get("data")
            if not isinstance(data, str) or not data:
                p.append("data must be a non-empty string")
                data = ""
            parsed.append(BarcodeEl(**base, symbology=sym, data=data,
                                    show_text=bool(el.get("showText", True))))
        elif etype == "qr":
            data = el.get("data")
            if not isinstance(data, str) or not data:
                p.append("data must be a non-empty string")
                data = ""
            parsed.append(QrEl(**base, data=data))
        elif etype in ("line", "box"):
            stroke = el.get("strokeIn")
            if not _num(stroke) or stroke <= 0:
                p.append("strokeIn must be a positive number")
                stroke = 0.01
            cls = LineEl if etype == "line" else BoxEl
            parsed.append(cls(**base, stroke_in=float(stroke)))
        else:
            p.append(f"unknown type {etype!r}")

        problems.extend(f"{eid}: {msg}" for msg in p)

    if problems:
        raise DesignError(problems)
    return Design(width_in=float(size["w"]), height_in=float(size["h"]),
                  elements=tuple(parsed))
