"""Template resolution for one label type, generalizing V2's `top`-only
site preference (portal_routes.py `process_label_generation_job`) to
every type: V3 site links apply uniformly, not just to `top`."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import LabelTemplate, LabelTemplateSite


async def select_template(
    db: AsyncSession, label_type: str, site_id: uuid.UUID | None,
) -> LabelTemplate | None:
    """Active templates of `label_type`: prefer one linked to `site_id`
    (the caller decides which site that is — the spec says destination,
    else origin); otherwise a GLOBAL template (no site links at all).
    Ties break on highest version, then newest updated_at. A template
    linked only to OTHER sites is never picked."""
    base = select(LabelTemplate).where(
        LabelTemplate.label_type == label_type, LabelTemplate.is_active == True)  # noqa: E712
    order = (LabelTemplate.version.desc(), LabelTemplate.updated_at.desc())

    if site_id is not None:
        site_scoped = (base.join(LabelTemplateSite,
                                 LabelTemplateSite.template_id == LabelTemplate.id)
                       .where(LabelTemplateSite.site_id == site_id)
                       .order_by(*order).limit(1))
        found = await db.scalar(site_scoped)
        if found is not None:
            return found

    has_any_site_link = (select(LabelTemplateSite.template_id)
                         .where(LabelTemplateSite.template_id == LabelTemplate.id)
                         .exists())
    global_scoped = base.where(~has_any_site_link).order_by(*order).limit(1)
    return await db.scalar(global_scoped)
