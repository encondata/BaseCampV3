"""Template resolution for one label type, generalizing V2's `top`-only
site preference (portal_routes.py `process_label_generation_job`) to
every type: V3 site links apply uniformly, not just to `top`.

A run prints at one DPI, so only templates at that DPI are candidates: a
label builder template prints through its child at that DPI (the parent
never prints, and its site links stand for its children), and an older
single row through its own `dpi_key`. A scope with nothing at the run's DPI
falls through to the next one, as the kiosk's pick does (labels/pick.py)."""

import dataclasses
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelTemplate, LabelTemplateSite, Site
from serversherpa.db.ordering import natural_key

# the row whose site links a template uses: a DPI child's are its parent's
_LINK_OWNER = func.coalesce(LabelTemplate.parent_id, LabelTemplate.id)


def _printing_at(label_type: str, dpi_key: str):
    """Active templates of `label_type` that print at `dpi_key`: builder
    children and older single rows, never a builder parent."""
    return select(LabelTemplate).where(
        LabelTemplate.label_type == label_type, LabelTemplate.is_active.is_(True),
        LabelTemplate.dpi_key == dpi_key,
        (LabelTemplate.parent_id.is_not(None)) | (LabelTemplate.schema_version < 2))


async def select_template(
    db: AsyncSession, label_type: str, site_id: uuid.UUID | None, dpi_key: str,
) -> LabelTemplate | None:
    """Active templates of `label_type` at `dpi_key`: prefer one linked to
    `site_id` (the caller decides which site that is — the spec says
    destination, else origin); otherwise a GLOBAL template (no site links
    at all). Ties break on highest version, then newest updated_at. A
    template linked only to OTHER sites is never picked."""
    base = _printing_at(label_type, dpi_key)
    order = (LabelTemplate.version.desc(), LabelTemplate.updated_at.desc())

    if site_id is not None:
        site_scoped = (base.join(LabelTemplateSite,
                                 LabelTemplateSite.template_id == _LINK_OWNER)
                       .where(LabelTemplateSite.site_id == site_id)
                       .order_by(*order).limit(1))
        found = await db.scalar(site_scoped)
        if found is not None:
            return found

    has_any_site_link = (select(LabelTemplateSite.template_id)
                         .where(LabelTemplateSite.template_id == _LINK_OWNER)
                         .exists())
    global_scoped = base.where(~has_any_site_link).order_by(*order).limit(1)
    return await db.scalar(global_scoped)


@dataclasses.dataclass
class Candidate:
    """One selectable template for the portal's per-type picker.
    `scope` is 'site' (linked to the caller's `site_id`), 'global' (no
    site links at all), or 'other' (linked only to other sites — never
    auto-matched, but still pickable by an operator who knows they want
    it). `site_names` is populated only for 'other' (the site/global
    scopes are unambiguous from the label alone)."""

    template: LabelTemplate
    scope: str
    site_names: list[str]


async def candidate_templates(
    db: AsyncSession, label_type: str, site_id: uuid.UUID | None, dpi_key: str,
) -> list["Candidate"]:
    """Every ACTIVE template of `label_type` that prints at `dpi_key`, for
    the portal's per-type template selector: the auto-match first (exactly
    what `select_template` would return for the same `site_id` and DPI),
    then the remaining `site_id`-linked templates, then globals, then
    templates linked only to other sites — each group ordered by version
    desc, then updated_at desc. An auto-match only ever comes from the site
    or global groups; a type whose only active templates are 'other' has
    candidates but no auto-match (candidates[0].scope == 'other')."""
    order = (LabelTemplate.version.desc(), LabelTemplate.updated_at.desc())
    templates = (await db.execute(
        _printing_at(label_type, dpi_key).order_by(*order))).scalars().all()
    if not templates:
        return []

    link_owner = {t.id: t.parent_id or t.id for t in templates}
    link_rows = (await db.execute(
        select(LabelTemplateSite.template_id, Site.id, Site.name)
        .join(Site, Site.id == LabelTemplateSite.site_id)
        .where(LabelTemplateSite.template_id.in_(set(link_owner.values()))))).all()
    linked_sites: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {}
    for template_id, linked_site_id, site_name in link_rows:
        linked_sites.setdefault(template_id, []).append((linked_site_id, site_name))

    site_group: list[LabelTemplate] = []
    global_group: list[LabelTemplate] = []
    other_group: list[LabelTemplate] = []
    other_site_names: dict[uuid.UUID, list[str]] = {}
    for template in templates:
        links = linked_sites.get(link_owner[template.id], [])
        if not links:
            global_group.append(template)
        elif site_id is not None and any(sid == site_id for sid, _ in links):
            site_group.append(template)
        else:
            other_group.append(template)
            other_site_names[template.id] = sorted((name for _, name in links), key=natural_key)

    ordered: list[Candidate] = []
    seen: set[uuid.UUID] = set()
    auto_match, auto_scope = (
        (site_group[0], "site") if site_group
        else (global_group[0], "global") if global_group
        else (None, None))
    if auto_match is not None:
        ordered.append(Candidate(auto_match, auto_scope, []))
        seen.add(auto_match.id)
    for template in site_group:
        if template.id not in seen:
            ordered.append(Candidate(template, "site", []))
            seen.add(template.id)
    for template in global_group:
        if template.id not in seen:
            ordered.append(Candidate(template, "global", []))
            seen.add(template.id)
    for template in other_group:
        ordered.append(Candidate(template, "other", other_site_names.get(template.id, [])))
    return ordered
