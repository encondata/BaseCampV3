"""Which template a label uses: the selection order from
docs/superpowers/specs/2026-10-19-label-station-printing-station-design.md §3.

- Top: destination site, then source site, then a global template, then
  Generic Rack and RU.
- Front: destination site, then a global template.

A step with no version at the printer's DPI falls through to the next one,
and leaves a note saying so. Ties within a step go to the highest
`version`, then the newest `updated_at`.

Pure: callers pass the family name in (labels/kiosk_templates.family_name),
so this module only compares strings and imports nothing from the DB."""

from typing import Literal, NamedTuple

GENERIC_FAMILY = "generic rack and ru"

Scope = Literal["destination", "source", "both", "global", "other"]


class TemplateChoice(NamedTuple):
    id: str
    family: str
    label_type: str
    dpi_key: str
    version: int
    updated_at: str      # ISO 8601
    scope: Scope


def _is_generic(t: TemplateChoice) -> bool:
    return t.family.lower() == GENERIC_FAMILY


# Each step: what the note calls it, and which templates it holds.
_STEPS = {
    "destination": ("The destination site's", lambda t: t.scope in ("destination", "both")),
    "source": ("The source site's", lambda t: t.scope == "source"),
    "global": ("The global", lambda t: t.scope == "global" and not _is_generic(t)),
    "generic": ("The fallback", lambda t: t.scope == "global" and _is_generic(t)),
}
_ORDER = {
    "top": ("destination", "source", "global", "generic"),
    "front": ("destination", "global"),
}
_KIND_LABEL = {"top": "Top", "front": "Front"}


def _best(templates: list[TemplateChoice]) -> TemplateChoice:
    return max(templates, key=lambda t: (t.version, t.updated_at))


def pick_template(
    templates: list[TemplateChoice], kind: Literal["top", "front"], dpi_key: str,
) -> tuple[TemplateChoice | None, list[str]]:
    """The template for `kind` at `dpi_key`, and one note per earlier step
    that had templates of this kind only at another DPI."""
    of_kind = [t for t in templates if t.label_type == kind]
    notes: list[str] = []
    for step in _ORDER[kind]:
        who, holds = _STEPS[step]
        in_step = [t for t in of_kind if holds(t)]
        if not in_step:
            continue
        at_dpi = [t for t in in_step if t.dpi_key == dpi_key]
        if at_dpi:
            return _best(at_dpi), notes
        notes.append(f'{who} {_KIND_LABEL[kind]} template "{_best(in_step).family}" '
                     f"isn't available at {dpi_key} DPI.")
    return None, notes
