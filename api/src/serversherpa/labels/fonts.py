"""The label builder's font families and the printer object each weight
prints with (spec §4.4).

Every family is TrueType and lives on the printer under an 8.3 object
name, which the ZPL compiler emits as `^A@…,E:<object>`. Swiss 721
Condensed Bold is Zebra's own resident cut: it is never pushed to a
printer or served to a browser, and it has no separate Bold file, so Bold
on it is faux (see `font_object`). This table is the only source of the
object names: the compiler never asks the font library, so the canvas, the
portal and every laptop edge compile the same bytes.

Pure: the ZPL compiler imports this on the portal and on the laptop edge
(which imports serversherpa.labels straight from api/src)."""

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


def object_family(name: str) -> tuple[str, str] | None:
    """(family slug, weight) of a builder printer object name, matched
    without regard to case, or None for any other font."""
    upper = (name or "").upper()
    for slug, fam in FAMILIES.items():
        for weight, obj in fam["objects"].items():
            if obj == upper:
                return slug, weight
    return None


def resident_object(name: str) -> bool:
    """True for a resident family's printer object name: whatever the
    library row says, that file is never pushed to a printer or served."""
    found = object_family(name)
    return found is not None and FAMILIES[found[0]]["resident"]


def font_object(family: str, weight: str) -> tuple[str, bool]:
    """(object name, faux_bold) for one weight of a family. Bold on a
    family with no Bold file prints the regular file with faux_bold set,
    and the compiler thickens it. Every name in FAMILIES is an 8.3 `.TTF`
    object name (a test pins it), so no other text reaches `^A@`."""
    if weight not in WEIGHTS:
        raise ValueError(f"unknown font weight: {weight!r}")
    objs = FAMILIES[family]["objects"]
    bold = objs["bold"] if weight == "bold" else None
    return (bold, False) if bold else (objs["regular"], weight == "bold")
