"""Page templates (spec §7): a page starting point, either global
(`space_id` null — the four seeded builtins plus any a wiki admin adds)
or scoped to one space. "New page" offers Blank plus these, and a page
can be "saved as template" via `from_node_id`.

Visibility: a global or builtin template is visible to anyone with
wiki:view; a space template needs view on its space. Rights to add,
change or remove one: manage on its space, or wiki admin for a global
one — a builtin is read-only for everyone (422 `builtin`), including a
wiki admin.

`GET /templates?space=<key>` lists the templates a "New page" in that
space may offer: builtins, then other global templates, then the
space's own — each group name-ordered. `POST /nodes` (`nodes.py`) uses
`template_visible` and a template's `content_json` directly to create a
page from one.
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Response
from sqlalchemy import func, select

from serversherpa.api.routes.wiki.deps import WikiContext
from serversherpa.api.routes.wiki.errors import err, is_edit, not_found
from serversherpa.api.routes.wiki.schemas import (
    TemplateCreateIn,
    TemplateDetail,
    TemplateOut,
    TemplatePatchIn,
)
from serversherpa.api.routes.wiki.serialize import person_refs
from serversherpa.db.models import WikiNode, WikiPage, WikiSpace, WikiTemplate
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.wiki import pages
from serversherpa.wiki.content import docs_equal, strip_asset_nodes, strip_comment_marks
from serversherpa.wiki.permissions import require_node_level, require_space_level

router = APIRouter()

TEMPLATE_FIELDS = ["name", "description", "icon"]


# ── visibility / rights ─────────────────────────────────────────────


async def template_visible(ctx: WikiContext, template: WikiTemplate) -> bool:
    """A global template (builtin or not) is visible to anyone with
    wiki:view (already guaranteed by `WikiContext`); a space template
    needs view on its space."""
    if template.space_id is None:
        return True
    return await ctx.ix.level_for_space(template.space_id) is not None


async def _require_manage_rights(ctx: WikiContext, space_id: uuid.UUID | None) -> None:
    """A space template needs manage on its space; a global one needs
    wiki admin."""
    if space_id is None:
        if not ctx.principal.is_admin:
            raise err(403, "forbidden",
                      "Only a wiki administrator can manage a global template.")
        return
    await require_space_level(ctx.ix, await ctx.db.get(WikiSpace, space_id), "manage")


async def _get_visible(ctx: WikiContext, template_id: uuid.UUID) -> WikiTemplate:
    template = await ctx.db.get(WikiTemplate, template_id)
    if template is None or not await template_visible(ctx, template):
        raise not_found()
    return template


def _refuse_builtin(template: WikiTemplate) -> None:
    if template.is_builtin:
        raise err(422, "builtin", "Builtin templates can't be changed.")


async def _name_taken(ctx: WikiContext, space_id: uuid.UUID | None, name: str,
                      exclude_id: uuid.UUID | None = None) -> bool:
    q = select(WikiTemplate.id).where(
        func.lower(WikiTemplate.name) == name.strip().lower(),
        WikiTemplate.space_id == space_id if space_id is not None
        else WikiTemplate.space_id.is_(None))
    if exclude_id is not None:
        q = q.where(WikiTemplate.id != exclude_id)
    return await ctx.db.scalar(q) is not None


# ── content sources ──────────────────────────────────────────────────


def _template_doc(content: object) -> dict:
    """What a template stores of `content`: a valid doc, without the page's
    own assets (a template has none) or its comment anchors (they belong
    to the page's threads)."""
    return strip_comment_marks(strip_asset_nodes(pages.check_doc(content)))


async def _content_from_node(ctx: WikiContext, node_id: uuid.UUID) -> dict:
    """The content a new template starts from when created `from_node_id`:
    an editor's current draft (falling back to the published content, or
    the empty doc if there's neither yet); a viewer's published content,
    or 404 `not_published` if the page was never published. 422 `private`
    for a private page — a template is visible to more people than it."""
    node = await require_node_level(ctx.ix, await ctx.db.get(WikiNode, node_id), "view")
    if node.kind != "page":
        raise err(422, "not_a_page", "Only a page can become a template.")
    if await ctx.ix.is_private(node):
        raise err(422, "private", "A private page can't be saved as a template.")
    page = await ctx.db.get(WikiPage, node.id)
    level = await ctx.ix.level_for_node(node)
    published = await pages.published_content(ctx.db, page)
    if is_edit(level):
        if page.draft_json is not None:
            return page.draft_json
        return published if published is not None else pages.EMPTY_DOC
    if published is None:
        raise err(404, "not_published", "This page hasn't been published yet.")
    return published


# ── serialize ────────────────────────────────────────────────────────


async def _templates_out(ctx: WikiContext, templates: Sequence[WikiTemplate],
                         ) -> list[TemplateOut]:
    space_ids = {t.space_id for t in templates if t.space_id is not None}
    space_keys: dict[uuid.UUID, str] = {}
    if space_ids:
        space_keys = {sid: str(key) for sid, key in (await ctx.db.execute(
            select(WikiSpace.id, WikiSpace.key).where(WikiSpace.id.in_(space_ids))
        )).all()}
    people = await person_refs(ctx.db, [t.created_by for t in templates])
    return [
        TemplateOut(
            id=t.id, space_id=t.space_id, space_key=space_keys.get(t.space_id),
            name=t.name, description=t.description, icon=t.icon,
            is_builtin=t.is_builtin,
            created_by=people.get(t.created_by) if t.created_by else None,
            created_at=t.created_at, updated_at=t.updated_at,
        )
        for t in templates
    ]


async def _one_out(ctx: WikiContext, template: WikiTemplate) -> TemplateOut:
    return (await _templates_out(ctx, [template]))[0]


# ── list / get ───────────────────────────────────────────────────────


def _group(template: WikiTemplate) -> int:
    """Sort group: builtin, then other global, then the requested space's
    own (the only three kinds a single listing ever mixes)."""
    if template.is_builtin:
        return 0
    return 1 if template.space_id is None else 2


@router.get("/templates", response_model=list[TemplateOut])
async def list_templates(ctx: WikiContext, space: str | None = None) -> list[TemplateOut]:
    """Builtins, then other global templates, then (with `?space=`) that
    space's own — each group name-ordered."""
    where = WikiTemplate.space_id.is_(None)
    if space is not None:
        space_row = await require_space_level(
            ctx.ix, await ctx.db.scalar(
                select(WikiSpace).where(WikiSpace.key == space.strip())), "view")
        where = where | (WikiTemplate.space_id == space_row.id)

    templates = (await ctx.db.scalars(select(WikiTemplate).where(where))).all()
    templates = sorted(templates, key=lambda t: (_group(t), t.name.lower()))
    return await _templates_out(ctx, templates)


@router.get("/templates/{template_id}", response_model=TemplateDetail)
async def get_template(template_id: uuid.UUID, ctx: WikiContext) -> TemplateDetail:
    template = await _get_visible(ctx, template_id)
    out = await _one_out(ctx, template)
    return TemplateDetail(**out.model_dump(), content_json=template.content_json)


# ── create ───────────────────────────────────────────────────────────


@router.post("/templates", response_model=TemplateOut, status_code=201)
async def create_template(body: TemplateCreateIn, ctx: WikiContext) -> TemplateOut:
    await _require_manage_rights(ctx, body.space_id)

    if body.from_node_id is not None:
        content = await _content_from_node(ctx, body.from_node_id)
    else:
        content = body.content_json
    content = _template_doc(content)

    if await _name_taken(ctx, body.space_id, body.name):
        raise err(409, "name_taken", "A template with that name already exists here.")

    actor_id = ctx.user.person.id
    template = WikiTemplate(
        space_id=body.space_id, name=body.name, description=body.description,
        icon=body.icon, content_json=content, created_by=actor_id)
    ctx.db.add(template)
    await ctx.db.flush()

    audit(ctx.db, actor_id=actor_id, entity_type="wiki_template",
          entity_id=str(template.id), action="create",
          changes=diff({}, {"space_id": str(body.space_id) if body.space_id else None,
                            "name": template.name}))
    await ctx.db.commit()
    return await _one_out(ctx, template)


# ── patch / delete ───────────────────────────────────────────────────


@router.patch("/templates/{template_id}", response_model=TemplateOut)
async def patch_template(template_id: uuid.UUID, body: TemplatePatchIn,
                         ctx: WikiContext) -> TemplateOut:
    template = await _get_visible(ctx, template_id)
    _refuse_builtin(template)
    await _require_manage_rights(ctx, template.space_id)

    if body.name is not None and await _name_taken(
            ctx, template.space_id, body.name, exclude_id=template.id):
        raise err(409, "name_taken", "A template with that name already exists here.")
    new_content = (_template_doc(body.content_json)
                   if body.content_json is not None else None)

    before = snapshot(template, TEMPLATE_FIELDS)
    if body.name is not None:
        template.name = body.name
    if body.description is not None:
        template.description = body.description
    if body.icon is not None:
        template.icon = body.icon
    changes = diff(before, snapshot(template, TEMPLATE_FIELDS))
    # the doc itself never goes in the audit log (see pages.publish, which
    # logs version_id/note, never content) — just that it changed
    if new_content is not None and not docs_equal(template.content_json, new_content):
        template.content_json = new_content
        changes["content_json"] = "changed"
    if changes:
        actor_id = ctx.user.person.id
        template.updated_at = pages.utcnow()
        audit(ctx.db, actor_id=actor_id, entity_type="wiki_template",
              entity_id=str(template.id), action="update", changes=changes)
        await ctx.db.commit()
    return await _one_out(ctx, template)


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(template_id: uuid.UUID, ctx: WikiContext) -> Response:
    template = await _get_visible(ctx, template_id)
    _refuse_builtin(template)
    await _require_manage_rights(ctx, template.space_id)

    audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_template",
          entity_id=str(template.id), action="delete",
          changes={"space_id": str(template.space_id) if template.space_id else None,
                   "name": template.name})
    await ctx.db.delete(template)
    await ctx.db.commit()
    return Response(status_code=204)
