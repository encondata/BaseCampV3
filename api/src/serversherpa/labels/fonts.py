"""The label builder's font families and the printer object each weight
prints with (spec §4.4).

Every family is TrueType and lives on the printer under an 8.3 object
name, which the ZPL compiler emits as `^A@…,E:<object>`. Swiss 721
Condensed Bold is Zebra's own resident cut: it is never pushed to a
printer or served to a browser, and it has no separate Bold file, so Bold
on it is faux (see `font_object`).

Pure: the ZPL compiler imports this on the portal and on the laptop edge
(which imports serversherpa.labels straight from api/src)."""

from collections.abc import Mapping
from typing import TypedDict


class FamilyObjects(TypedDict):
    regular: str
    bold: str | None


class Family(TypedDict):
    label: str
    objects: FamilyObjects
    resident: bool
    mono: bool


WEIGHTS = ("regular", "bold")
DEFAULT_FAMILY = "swiss721-cond-bold"


def _family(label: str, regular: str, bold: str | None, *, resident: bool = False,
            mono: bool = False) -> Family:
    return {"label": label, "objects": {"regular": regular, "bold": bold},
            "resident": resident, "mono": mono}


FAMILIES: dict[str, Family] = {
    "swiss721-cond-bold": _family("Swiss 721 Condensed Bold", "TT0003M_.TTF", None,
                                  resident=True),
    "roboto-condensed": _family("Roboto Condensed", "ROBOCO_R.TTF", "ROBOCO_B.TTF"),
    "roboto": _family("Roboto", "ROBOTO_R.TTF", "ROBOTO_B.TTF"),
    "oswald": _family("Oswald", "OSWALD_R.TTF", "OSWALD_B.TTF"),
    "roboto-mono": _family("Roboto Mono", "ROBOMO_R.TTF", "ROBOMO_B.TTF", mono=True),
    "ibm-plex-mono": _family("IBM Plex Mono", "PLEXMO_R.TTF", "PLEXMO_B.TTF", mono=True),
    "atkinson-hyperlegible": _family("Atkinson Hyperlegible", "ATKINS_R.TTF", "ATKINS_B.TTF"),
    "source-sans-3": _family("Source Sans 3", "SRCSAN_R.TTF", "SRCSAN_B.TTF"),
}


def font_object(family: str, weight: str, *,
                objects: Mapping[str, str | None] | None = None) -> tuple[str, bool]:
    """(object name, faux_bold) for one weight of a family. Bold on a
    family with no Bold file prints the regular file with faux_bold set,
    and the compiler thickens it. `objects` replaces the family's own
    `{"regular", "bold"}` when the caller knows what the font library
    actually holds (a missing Bold file there makes Bold faux too)."""
    if weight not in WEIGHTS:
        raise ValueError(f"unknown font weight: {weight!r}")
    objs = objects if objects is not None else FAMILIES[family]["objects"]
    if weight == "bold":
        bold = objs.get("bold")
        return (bold, False) if bold else (objs["regular"], True)
    return objs["regular"], False
