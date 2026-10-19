"""The label template set a kiosk downloads for a move, and each template's
printer code with its {placeholder} tokens intact (spec
docs/superpowers/specs/2026-10-19-kiosk-label-templates-sync-design.md §2-3).

Active templates only. A template is included when any of these hold, and
carries every reason it matched:
- `front`: its label_type is front;
- `destination_site` / `source_site`: it is linked to the move's
  destination / origin site;
- `generic`: "generic" appears anywhere in its name, ignoring case;
- `container`: its label_type is container or container_info;
- `fallback`: it is named exactly "Generic Rack and RU" (ignoring case)
  and no ACTIVE template is linked to the destination site. A move with no
  destination site counts as having none.

The kiosk device's own site plays no part. Conversion goes through the
portal's own compiler (labels/compile.py) with `subs=None`, built the same
way labels/generate/engine.py's `render_label` builds the design and size."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, LabelTemplate, LabelTemplateSite, Site
from serversherpa.db.ordering import natural, natural_key
from serversherpa.labels.compile import compile_parsed_design
from serversherpa.labels.model import parse_design

FALLBACK_NAME = "generic rack and ru"
CONTAINER_TYPES = ("container", "container_info")


class TemplateConvertError(ValueError):
    """A design template whose size or DPI has no vocabulary details."""


async def move_template_set(
    db: AsyncSession, initiative: Initiative,
) -> list[tuple[LabelTemplate, set[str], list[str]]]:
    """Every active template the move's kiosk needs, ordered by
    natural(name), each with the set of reasons it was picked and
    `move_site_names`: the names of the move's OWN origin/destination
    sites the template is linked to (natural-sorted). Links to any other
    site are never named — a Front/Generic/Container template linked only
    elsewhere is still picked, with an empty list."""
    templates = (await db.execute(
        select(LabelTemplate)
        .where(LabelTemplate.is_active.is_(True))
        .order_by(natural(LabelTemplate.name), LabelTemplate.id))).scalars().all()
    if not templates:
        return []

    origin_id = initiative.origin_site_id
    destination_id = initiative.destination_site_id
    move_sites = {sid for sid in (origin_id, destination_id) if sid is not None}

    links: dict[uuid.UUID, set[uuid.UUID]] = {}
    move_names: dict[uuid.UUID, list[str]] = {}
    for template_id, site_id, site_name in (await db.execute(
            select(LabelTemplateSite.template_id, LabelTemplateSite.site_id, Site.name)
            .join(Site, Site.id == LabelTemplateSite.site_id)
            .where(LabelTemplateSite.template_id.in_([t.id for t in templates])))).all():
        links.setdefault(template_id, set()).add(site_id)
        if site_id in move_sites:
            move_names.setdefault(template_id, []).append(site_name)

    destination_has_template = destination_id is not None and any(
        destination_id in sites for sites in links.values())

    picked: list[tuple[LabelTemplate, set[str], list[str]]] = []
    for template in templates:
        sites = links.get(template.id, set())
        name = template.name.lower()
        reasons: set[str] = set()
        if template.label_type == "front":
            reasons.add("front")
        if destination_id is not None and destination_id in sites:
            reasons.add("destination_site")
        if origin_id is not None and origin_id in sites:
            reasons.add("source_site")
        if "generic" in name:
            reasons.add("generic")
        if template.label_type in CONTAINER_TYPES:
            reasons.add("container")
        if name == FALLBACK_NAME and not destination_has_template:
            reasons.add("fallback")
        if reasons:
            picked.append((template, reasons,
                           sorted(move_names.get(template.id, []), key=natural_key)))
    return picked


def template_code(template: LabelTemplate, size_meta: dict, dpi_meta: dict) -> str:
    """Printer code with {placeholder} tokens intact. A `code` template's
    stored code as is; a `design` template compiled with no substitutions
    at its own size and DPI. Raises a ValueError (DesignError,
    UnsupportedLanguage or TemplateConvertError) when a design can't
    convert."""
    if template.kind == "code":
        return template.code or ""
    width = size_meta.get("width_in")
    height = size_meta.get("height_in")
    dots = dpi_meta.get("dots")
    if width is None or height is None:
        raise TemplateConvertError(f"unknown label size: {template.size_key}")
    if dots is None:
        raise TemplateConvertError(f"unknown DPI: {template.dpi_key}")
    design = parse_design({**(template.design or {}), "size": {"w": width, "h": height}})
    return compile_parsed_design(design, dots=dots, language_key=template.language_key,
                                 subs=None)
