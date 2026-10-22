"""The label template set a kiosk downloads for a move, and each template's
printer code with its {placeholder} tokens intact (spec
docs/superpowers/specs/2026-10-19-kiosk-label-templates-sync-design.md §2-3).

Active templates of the label types a kiosk prints (KIOSK_LABEL_TYPES) only:
an ID badge or a custom type's template never syncs, whatever its site links
or name. A template is included when any of these hold, and carries every
reason it matched:
- `front`: its label_type is front;
- `destination_site` / `source_site`: it is linked to the move's
  destination / origin site;
- `generic`: "generic" appears anywhere in its name, ignoring case;
- `container`: its label_type is container or container_info;
- `global`: its label_type is top or front and it is linked to no site, so
  the Label Station can pick it when no site template applies;
- `fallback`: its family name (below) is "Generic Rack and RU" (ignoring
  case), so every DPI version of it qualifies, whatever the destination
  site's links (the Label Station's pick order ends on it).

Templates come in DPI versions named like "Generic Rack and RU - 203DPI" /
"... - 300DPI" or "Container Label 4x6 203dpi". `family_name` strips that
trailing DPI marker, so every client groups the versions the same way and
picks the one whose `dpi_key` matches its printer. It strips a trailing
" Old" / " Old N" too: an older row renamed when a rebuilt template took
its name (labels/builtin_templates.py) stays in its family, so the
one-active rule still sees it and Replace… still offers it.

The label builder's templates (labels/templates_tree.py) reach a kiosk as
their DPI children only, never the parent: a child takes its family (the
parent's name) and its site links from the parent, and an Old child is
inactive, so it never qualifies. A child's schema 2 design has no token
form: the edge renders it from the design itself, so its `code` is "".

The kiosk device's own site plays no part. Conversion goes through the
portal's own compiler (labels/compile.py) with `subs=None`, built the same
way labels/generate/engine.py's `render_label` builds the design and size."""

import re
import uuid
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from serversherpa.db.models import Initiative, LabelTemplate, LabelTemplateSite, Site
from serversherpa.db.ordering import natural, natural_key
from serversherpa.labels.compile import compile_parsed_design
from serversherpa.labels.fields import ALL_LABEL_TYPES
from serversherpa.labels.model import parse_design

FALLBACK_NAME = "generic rack and ru"
# A trailing DPI marker: " - 203DPI", " 300 dpi", "(600DPI)", " – 203 DPI".
_DPI_SUFFIX = re.compile(r"\s*[-–—]?\s*\(?\s*\d+\s*dpi\s*\)?\s*$", re.IGNORECASE)
# A kept older row: " Old", " Old 2" (the word itself, case as written).
_OLD_SUFFIX = re.compile(r"\s+Old(?:\s+\d+)?\s*$")


def family_name(name: str) -> str:
    """The template's name without a trailing DPI marker or " Old" /
    " Old N", in either order: the key its DPI versions and its kept older
    rows share. Never empty: a name that is only a marker stays as is."""
    base = name.strip()
    while True:
        stripped = _OLD_SUFFIX.sub("", _DPI_SUFFIX.sub("", base)).strip()
        if not stripped or stripped == base:
            return base
        base = stripped


def row_family(name: str, parent_name: str | None) -> str:
    """A template's family: a builder child's is its parent's name; any
    other row's is its own name without the DPI marker."""
    return parent_name if parent_name is not None else family_name(name)


CONTAINER_TYPES = ("container", "container_info")
# The only label types a kiosk prints: the catalog's asset and container
# types (labels/fields.py). An ID badge (fields.PERSON_LABEL_TYPES) or a
# custom type from New template › Custom… never reaches one: not in the
# sync, the font list or the test render.
KIOSK_LABEL_TYPES = tuple(ALL_LABEL_TYPES)


class PickedTemplate(NamedTuple):
    """One template of a move's set (move_template_set)."""
    template: LabelTemplate
    reasons: set[str]
    move_site_names: list[str]
    scope: str
    family: str


class TemplateConvertError(ValueError):
    """A design template whose size or DPI has no vocabulary details."""


def link_scope(sites: set[uuid.UUID], origin_id: uuid.UUID | None,
               destination_id: uuid.UUID | None) -> str:
    """How a template's site links relate to this move: "both" (linked to
    its origin and destination), "destination", "source", "global" (no
    links at all) or "other" (linked only to sites that aren't the move's).
    The same words labels/pick.py's TemplateChoice.scope uses."""
    to_dest = destination_id is not None and destination_id in sites
    to_src = origin_id is not None and origin_id in sites
    if to_dest and to_src:
        return "both"
    if to_dest:
        return "destination"
    if to_src:
        return "source"
    return "other" if sites else "global"


async def move_template_set(db: AsyncSession, initiative: Initiative) -> list[PickedTemplate]:
    """Every active template the move's kiosk needs, ordered by
    natural(name), each with the set of reasons it was picked and
    `move_site_names`: the names of the move's OWN origin/destination
    sites the template is linked to (natural-sorted). Links to any other
    site are never named — a Front/Generic/Container template linked only
    elsewhere is still picked, with an empty list. Then the template's
    `link_scope` and its family (`row_family`). Builder parents are never
    in the set; their children are, with the parent's site links. Only the
    KIOSK_LABEL_TYPES are ever in it."""
    parent = aliased(LabelTemplate)
    rows = (await db.execute(
        select(LabelTemplate, parent.name)
        .outerjoin(parent, parent.id == LabelTemplate.parent_id)
        .where(LabelTemplate.is_active.is_(True),
               LabelTemplate.label_type.in_(KIOSK_LABEL_TYPES),
               (LabelTemplate.parent_id.is_not(None)) | (LabelTemplate.schema_version < 2))
        .order_by(natural(LabelTemplate.name), LabelTemplate.id))).all()
    if not rows:
        return []
    templates = [t for t, _ in rows]
    parent_names = {t.id: pname for t, pname in rows}
    # a child's site links are its parent's
    link_owner = {t.id: t.parent_id or t.id for t in templates}

    origin_id = initiative.origin_site_id
    destination_id = initiative.destination_site_id
    move_sites = {sid for sid in (origin_id, destination_id) if sid is not None}

    links: dict[uuid.UUID, set[uuid.UUID]] = {}
    move_names: dict[uuid.UUID, list[str]] = {}
    for template_id, site_id, site_name in (await db.execute(
            select(LabelTemplateSite.template_id, LabelTemplateSite.site_id, Site.name)
            .join(Site, Site.id == LabelTemplateSite.site_id)
            .where(LabelTemplateSite.template_id.in_(set(link_owner.values()))))).all():
        links.setdefault(template_id, set()).add(site_id)
        if site_id in move_sites:
            move_names.setdefault(template_id, []).append(site_name)

    picked: list[PickedTemplate] = []
    for template in templates:
        owner = link_owner[template.id]
        sites = links.get(owner, set())
        name = template.name.lower()
        family = row_family(template.name, parent_names[template.id])
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
        if template.label_type in ("top", "front") and not sites:
            reasons.add("global")
        if family.lower() == FALLBACK_NAME:
            reasons.add("fallback")
        if reasons:
            picked.append(PickedTemplate(
                template, reasons, sorted(move_names.get(owner, []), key=natural_key),
                link_scope(sites, origin_id, destination_id), family))
    return picked


def template_code(template: LabelTemplate, size_meta: dict, dpi_meta: dict) -> str:
    """Printer code with {placeholder} tokens intact. A `code` template's
    stored code as is; a `design` template compiled with no substitutions
    at its own size and DPI; "" for a schema 2 design, which has no token
    form (the edge renders it from the design). Raises a ValueError
    (DesignError, UnsupportedLanguage or TemplateConvertError) when a
    design can't convert."""
    if template.kind == "code":
        return template.code or ""
    if design_schema(template) >= 2:
        return ""
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


def design_schema(template: LabelTemplate) -> int:
    """The schema of a template's design (1 for a code template)."""
    if template.kind != "design" or not isinstance(template.design, dict):
        return 1
    schema = template.design.get("schema", 1)
    return schema if isinstance(schema, int) and not isinstance(schema, bool) else 1
