"""Labels: vocabularies, placeholder catalog, templates, compile/preview,
and the label-generation queue (runs, preview, generated labels).

Reads gate on labels:view; template mutations on labels:add/change/delete
AND rank 80 (super admin or developer, spec §4.9 — the builder, its
versions, clone, Replace… and delete); the tree itself
(labels/templates_tree.py) owns every write to a template;
vocab + placeholder mutations are devtools-gated (god-only), matching the
rest of the Variables surface — except a new size, which the builder's New
template › Custom… lets a designer (labels:add and rank 80) add. Of the generate-labels routes, list/get/
preview/generated stay view-gated, but creating a run is a mutation — it
enqueues work and (with `regenerate_existing`) can redo prior output — so
it gates on labels:add (labels:change for the regenerate flavor), and
canceling one gates on labels:change and loads through the same
scope-aware `_runs_query` the list/get routes use rather than a bare
`db.get`, so a run outside the actor's scope 404s exactly like an unknown
one. All mutations audit into the caller's txn.
"""

import re
import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from serversherpa.access.defaults import SUPER_ADMIN_RANK
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import (
    AuthContext, CurrentUser, DbSession, require_permission, require_rank,
)
from serversherpa.api.schemas import (
    GeneratedLabelOut,
    GeneratedLabelBundleItemOut, GeneratedLabelBundleOut,
    LabelCompileIn, LabelCompileOut,
    LabelFieldsOut,
    LabelFontMetricsOut, LabelFontOut, LabelFontUsedByOut,
    LabelGeneratePreviewCandidateOut, LabelGeneratePreviewInitiativeOut,
    LabelGeneratePreviewOut, LabelGeneratePreviewTemplateOut, LabelGeneratePreviewTypeOut,
    LabelPlaceholderCreateIn, LabelPlaceholderOut, LabelPlaceholderUpdateIn,
    LabelRunCreateIn, LabelRunOut,
    LabelTemplateChildOut, LabelTemplateCloneIn, LabelTemplateCreateIn,
    LabelTemplateDeleteIn, LabelTemplateDeleteSummaryOut, LabelTemplateDpiIn,
    LabelTemplateOut, LabelTemplateReplaceIn, LabelTemplateSaveOut, LabelTemplateTreeOut,
    LabelTemplateUpdateIn, LabelTemplateVersionDetailOut, LabelTemplateVersionNoteIn,
    LabelTemplateVersionOut,
    LabelVocabCreateIn, LabelVocabOut, LabelVocabUpdateIn,
    LabelZplPreviewIn,
)
from serversherpa.db.models import (
    Asset, AssetModel, Client, Container, GeneratedLabel, Initiative, InitiativeAsset,
    LabelFont, LabelGenerationRun, LabelPlaceholder, LabelTemplate, LabelTemplateSite,
    LabelTemplateVersion, LabelVocab, Person, Site,
)
from serversherpa.db.ordering import natural, natural_key
from serversherpa.labels import labelary
from serversherpa.labels import templates_tree as tree
from serversherpa.labels.compile import UnsupportedLanguage, compile_design
from serversherpa.labels.fields import (
    CONTAINER_LABEL_TYPES, design_field_keys, field_values, groups_for, mock_field_values,
)
from serversherpa.labels.font_metrics import UnreadableFont, metrics as font_metrics
from serversherpa.labels.font_seed import (
    FONT_FIELDS, MAX_FONT_BYTES, TRUETYPE_MAGICS, display_name as family_display_name,
    new_storage_key,
)
from serversherpa.labels.fonts import FAMILIES, object_family, resident_object
from serversherpa.labels.generate import (
    InvalidDpi, InvalidLabelTypes, InvalidTemplates, RunActive, entity_for_type, enqueue_run,
)
from serversherpa.labels.generate.payloads import (
    asset_payload, label_context, load_status_labels,
)
from serversherpa.labels.generate.select import candidate_templates
from serversherpa.labels.kiosk_templates import family_name
from serversherpa.labels.model import DesignError, parse_design
from serversherpa.labels.tokens import apply_placeholders
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import delete_object, get_object, put_object

router = APIRouter(prefix="/labels", tags=["labels"])

VOCAB_FIELDS = ["label", "description", "meta", "sort_order", "is_active"]


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


# The builder: its mutations, and what only the builder reads (sample
# values), need labels:<action> AND rank 80 (spec §4.9).
DESIGNER = require_rank(SUPER_ADMIN_RANK)


def _validate_meta(kind: str, meta: dict) -> str | None:
    """Kind-specific meta contract; returns a problem string or None."""
    if kind == "size":
        for f in ("width_in", "height_in"):
            v = meta.get(f)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0:
                return f"meta.{f} must be a positive number"
    elif kind == "dpi":
        v = meta.get("dots")
        if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
            return "meta.dots must be a positive integer"
    elif kind == "language":
        if meta.get("family") not in ("zebra", "brother"):
            return "meta.family must be 'zebra' or 'brother'"
    return None


async def vocab_usage(db: DbSession) -> dict[tuple[str, str], int]:
    """(kind, key) -> count of label_templates referencing it. Public:
    the kiosk's own vocab route reuses it so both listings match."""
    totals: dict[tuple[str, str], int] = {}
    rows = (await db.execute(select(
        LabelTemplate.label_type, LabelTemplate.size_key,
        LabelTemplate.dpi_key, LabelTemplate.language_key))).all()
    for label_type, size_key, dpi_key, language_key in rows:
        for kind, key in (("type", label_type), ("size", size_key),
                          ("dpi", dpi_key), ("language", language_key)):
            totals[(kind, key)] = totals.get((kind, key), 0) + 1
    return totals


@router.get("/vocab", response_model=list[LabelVocabOut])
async def list_vocab(
    db: DbSession, kind: str | None = None,
    _actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelVocabOut]:
    q = select(LabelVocab).order_by(natural(LabelVocab.kind), LabelVocab.sort_order,
                                    natural(LabelVocab.key))
    if kind is not None:
        q = q.where(LabelVocab.kind == kind)
    rows = (await db.execute(q)).scalars().all()
    usage = await vocab_usage(db)
    out = []
    for r in rows:
        item = LabelVocabOut.model_validate(r)
        item.usage_count = usage.get((r.kind, r.key), 0)
        out.append(item)
    return out


@router.post("/vocab", response_model=LabelVocabOut, status_code=201)
async def create_vocab(
    body: LabelVocabCreateIn, db: DbSession, actor: CurrentUser,
) -> LabelVocabOut:
    """Devtools-gated, except a size: the builder's New template › Custom…
    lets a designer (labels:add and rank 80, spec §4.10) add one, to the
    list or (is_active false) for the one template it is made for."""
    if not actor.access.can("devtools", "add"):
        if body.kind != "size" or not actor.access.can("labels", "add"):
            raise _err(403, "forbidden")
        if actor.access.max_rank < SUPER_ADMIN_RANK:
            raise _err(403, "forbidden", min_rank=SUPER_ADMIN_RANK)
    problem = _validate_meta(body.kind, body.meta)
    if problem:
        raise _err(422, "bad_meta", message=problem)
    if await db.get(LabelVocab, (body.kind, body.key)):
        raise _err(409, "label_vocab_exists")
    row = LabelVocab(**body.model_dump())
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="label_vocab",
          entity_id=f"{body.kind}:{body.key}", action="create",
          changes=diff({}, snapshot(row, VOCAB_FIELDS)))
    await db.commit()
    return LabelVocabOut.model_validate(row)


@router.patch("/vocab/{kind}/{key}", response_model=LabelVocabOut)
async def update_vocab(
    kind: str, key: str, body: LabelVocabUpdateIn, db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> LabelVocabOut:
    row = await db.get(LabelVocab, (kind, key))
    if row is None:
        raise _err(404, "unknown_vocab")
    data = body.model_dump(exclude_unset=True)
    if "meta" in data:
        if data["meta"] is None:
            raise _err(422, "bad_meta", message="meta cannot be null")
        problem = _validate_meta(kind, data["meta"])
        if problem:
            raise _err(422, "bad_meta", message=problem)
    for f in ("label", "description", "sort_order", "is_active"):
        if f in data and data[f] is None:
            raise _err(422, "bad_field", field=f)
    before = snapshot(row, VOCAB_FIELDS)
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, VOCAB_FIELDS))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="label_vocab",
              entity_id=f"{kind}:{key}", action="update", changes=changes)
    await db.commit()
    return LabelVocabOut.model_validate(row)


PLACEHOLDER_FIELDS = ["label", "description", "sample_value", "applies_to",
                      "sort_order", "is_active"]


async def _placeholder_usage(db: DbSession) -> dict[str, int]:
    """key -> count of templates whose design JSON or code holds {key}.
    One fetch, counted in Python — the catalog is tiny and this listing
    is a dev-screen surface."""
    import json as _json

    bodies = []
    for design, code in (await db.execute(
            select(LabelTemplate.design, LabelTemplate.code))).all():
        bodies.append(code if code is not None else _json.dumps(design))
    keys = (await db.execute(select(LabelPlaceholder.key))).scalars().all()
    return {k: sum(1 for b in bodies if ("{" + k + "}") in b) for k in keys}


async def _valid_type_keys(db: DbSession) -> set[str]:
    rows = (await db.execute(
        select(LabelVocab.key).where(LabelVocab.kind == "type"))).scalars()
    return set(rows)


@router.get("/fields", response_model=LabelFieldsOut)
async def list_fields(
    db: DbSession,
    label_type: str | None = None,
    actor: AuthContext = require_permission("labels", "view"),
) -> LabelFieldsOut:
    """The label builder's fields for a template of `label_type` (every
    group when omitted; labels/fields.py has the catalog), and the From-To
    headers across every move's roster for the `ft:<header>` fields. A
    container label has no From-To row, so it gets no headers."""
    headers: list[str] = []
    if label_type not in CONTAINER_LABEL_TYPES:
        key = func.jsonb_object_keys(InitiativeAsset.raw_ft)
        q = (select(key).distinct()
             .where(InitiativeAsset.raw_ft.is_not(None),
                    func.jsonb_typeof(InitiativeAsset.raw_ft) == "object"))
        # Defense in depth, same posture as _runs_query: `labels` is
        # global-only today, so this leg is unreachable.
        cond = scope_conditions("initiatives", actor.access, actor.person.id)
        if cond is not None:
            q = q.join(Initiative, Initiative.id == InitiativeAsset.initiative_id).where(cond)
        headers = sorted((await db.scalars(q)).all(), key=natural_key)
    return LabelFieldsOut(groups=groups_for(label_type), ft_headers=headers)


@router.get("/sample-values", response_model=dict[str, str])
async def sample_values(
    db: DbSession,
    initiative_id: uuid.UUID,
    asset_id: uuid.UUID,
    actor: AuthContext = require_permission("labels", "view"),
    _rank: AuthContext = DESIGNER,
) -> dict[str, str]:
    """The builder's Load from asset…: one roster asset's field values as
    its label prints them, {key: text} for every asset catalog key plus
    `ft:<header>` for each column of its uploaded From-To row. The same
    `field_values` over the same `asset_payload` and `label_context` the
    kiosk sync and the portal generator use, except that the whole From-To
    row comes back (the builder samples columns no template places yet),
    so it needs the builder's rank 80 as well as labels:view.

    404 `initiative_not_found` for an unknown initiative or one outside the
    caller's scope; 404 `asset_not_on_move` when the asset is not on that
    initiative's roster."""
    q = select(Initiative).where(Initiative.id == initiative_id)
    # Defense in depth, as list_fields: `labels` is global-only today.
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        q = q.where(cond)
    initiative = await db.scalar(q)
    if initiative is None:
        raise _err(404, "initiative_not_found")
    row = (await db.execute(
        select(Asset, InitiativeAsset, AssetModel)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative.id,
               InitiativeAsset.asset_id == asset_id))).first()
    if row is None:
        raise _err(404, "asset_not_on_move")
    asset, roster_row, model = row
    origin = (await db.get(Site, initiative.origin_site_id)
              if initiative.origin_site_id else None)
    destination = (await db.get(Site, initiative.destination_site_id)
                   if initiative.destination_site_id else None)
    payload = asset_payload(asset, roster_row, model, await load_status_labels(db, "asset"))
    return field_values(payload, label_context(initiative, origin, destination))


@router.get("/placeholders", response_model=list[LabelPlaceholderOut])
async def list_placeholders(
    db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelPlaceholderOut]:
    rows = (await db.execute(select(LabelPlaceholder).order_by(
        LabelPlaceholder.sort_order, natural(LabelPlaceholder.key)))).scalars().all()
    usage = await _placeholder_usage(db)
    out = []
    for r in rows:
        item = LabelPlaceholderOut.model_validate(r)
        item.usage_count = usage.get(r.key, 0)
        out.append(item)
    return out


@router.post("/placeholders", response_model=LabelPlaceholderOut,
             status_code=201)
async def create_placeholder(
    body: LabelPlaceholderCreateIn, db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> LabelPlaceholderOut:
    bad = set(body.applies_to) - await _valid_type_keys(db)
    if bad:
        raise _err(422, "bad_applies_to", unknown=sorted(bad))
    if await db.get(LabelPlaceholder, body.key):
        raise _err(409, "label_placeholder_exists")
    row = LabelPlaceholder(**body.model_dump())
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="label_placeholder",
          entity_id=body.key, action="create",
          changes=diff({}, snapshot(row, PLACEHOLDER_FIELDS)))
    await db.commit()
    return LabelPlaceholderOut.model_validate(row)


@router.patch("/placeholders/{key}", response_model=LabelPlaceholderOut)
async def update_placeholder(
    key: str, body: LabelPlaceholderUpdateIn, db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> LabelPlaceholderOut:
    row = await db.get(LabelPlaceholder, key)
    if row is None:
        raise _err(404, "unknown_placeholder")
    data = body.model_dump(exclude_unset=True)
    for f, v in data.items():
        if v is None:
            raise _err(422, "bad_field", field=f)
    if "applies_to" in data:
        bad = set(data["applies_to"]) - await _valid_type_keys(db)
        if bad:
            raise _err(422, "bad_applies_to", unknown=sorted(bad))
    before = snapshot(row, PLACEHOLDER_FIELDS)
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, PLACEHOLDER_FIELDS))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="label_placeholder",
              entity_id=key, action="update", changes=changes)
    await db.commit()
    return LabelPlaceholderOut.model_validate(row)


TEMPLATE_FIELDS = tree.TEMPLATE_FIELDS

_TEMPLATE_VOCAB = (("type", "label_type"), ("size", "size_key"),
                   ("dpi", "dpi_key"), ("language", "language_key"))

_GENERATION_TOKEN_RE = re.compile(r"^[a-z0-9_]+$")


def _validate_generation_rules(rules: dict) -> list[str]:
    """422 bad_generation_rules problems for a template's generation_rules:
    `{"destination": {"<1-based position>": "<token>"}, "source": {...},
    "length_limits": {"<token>": <positive int>}}` — the V2
    label_generation_code port (see db/models.py LabelTemplate docstring
    and labels/generate/values.py). Returns [] when the whole dict is
    valid; every problem is reported (not just the first) so a single
    editor save can surface everything wrong at once."""
    problems: list[str] = []
    unknown = set(rules) - {"destination", "source", "length_limits"}
    if unknown:
        problems.append(f"unknown keys: {', '.join(sorted(unknown))}")
    for side in ("destination", "source"):
        if side not in rules:
            continue
        mapping = rules[side]
        # None (explicit JSON null) is NOT treated as "not provided" here —
        # only an absent key skips validation; a side present with `null`
        # is a malformed object, same as any other non-dict value.
        if not isinstance(mapping, dict):
            problems.append(f"{side} must be an object")
            continue
        for pos, name in mapping.items():
            if not (isinstance(pos, str) and pos.isdigit() and int(pos) > 0):
                problems.append(f"{side} position {pos!r} must be a positive integer string")
            if not (isinstance(name, str) and _GENERATION_TOKEN_RE.match(name)):
                problems.append(f"{side}.{pos} token {name!r} must match [a-z0-9_]+")
    if "length_limits" in rules:
        limits = rules["length_limits"]
        if not isinstance(limits, dict):
            problems.append("length_limits must be an object")
        else:
            for key, limit in limits.items():
                if not (isinstance(key, str) and _GENERATION_TOKEN_RE.match(key)):
                    problems.append(f"length_limits key {key!r} must match [a-z0-9_]+")
                elif not (isinstance(limit, int) and not isinstance(limit, bool) and limit > 0):
                    problems.append(f"length_limits.{key} must be a positive integer")
    return problems


async def _check_template_vocab(
    db: DbSession, values: dict, current: LabelTemplate | None = None,
) -> None:
    """422 unknown_vocab unless every referenced vocab row exists.

    A changed value must also be active. An unchanged value (equal to
    `current`'s existing value) only needs to exist — deactivating a vocab
    row must not brick templates that already reference it."""
    for kind, field in _TEMPLATE_VOCAB:
        if field in values:
            row = await db.get(LabelVocab, (kind, values[field]))
            unchanged = (current is not None
                         and values[field] == getattr(current, field))
            if row is None or (not row.is_active and not unchanged):
                raise _err(422, "unknown_vocab", field=field,
                           key=values[field])


async def _check_new_size(db: DbSession, size_key: str) -> None:
    """A new builder template's size: a listed (active) size, or an
    unlisted custom size (inactive) no template uses yet — the one New
    template › Custom… just made for it. 422 unknown_vocab otherwise."""
    row = await db.get(LabelVocab, ("size", size_key))
    if row is not None and not row.is_active:
        used = await db.scalar(select(func.count()).select_from(LabelTemplate)
                               .where(LabelTemplate.size_key == size_key))
        if not used:
            return
    await _check_template_vocab(db, {"size_key": size_key})


async def _check_site_ids(db: DbSession, site_ids: list[uuid.UUID]) -> None:
    for sid in site_ids:
        if await db.get(Site, sid) is None:
            raise _err(422, "unknown_site", site_id=str(sid))


async def _site_ids_map(db: DbSession) -> dict[uuid.UUID, list[uuid.UUID]]:
    rows = (await db.execute(select(
        LabelTemplateSite.template_id, LabelTemplateSite.site_id))).all()
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for tid, sid in rows:
        out.setdefault(tid, []).append(sid)
    return out



def _tree_err(exc: tree.TreeError) -> HTTPException:
    return _err(exc.status, exc.code, **exc.extra)


async def _template_or_404(db: DbSession, template_id: uuid.UUID) -> LabelTemplate:
    row = (await db.execute(select(LabelTemplate)
        .options(selectinload(LabelTemplate.site_links))
        .where(LabelTemplate.id == template_id))).scalar_one_or_none()
    if row is None:
        raise _err(404, "unknown_template")
    return row


async def _template_site_ids(db: DbSession, template_id: uuid.UUID) -> list[uuid.UUID]:
    return list((await db.execute(select(LabelTemplateSite.site_id).where(
        LabelTemplateSite.template_id == template_id))).scalars())


async def _template_out(db: DbSession, row: LabelTemplate, cls=LabelTemplateOut, **extra):
    item = cls(**LabelTemplateOut.model_validate(row).model_dump(), **extra)
    item.site_ids = await _template_site_ids(db, row.id)
    return item


def _parse_v2(design: object) -> None:
    """422 bad_design unless `design` is a valid schema 2 design."""
    if not isinstance(design, dict) or design.get("schema") != 2:
        raise _err(422, "bad_design", problems=["a builder template needs a schema 2 design"])
    try:
        parse_design(design)
    except DesignError as e:
        raise _err(422, "bad_design", problems=e.problems) from e


def _is_v2(design: object) -> bool:
    return isinstance(design, dict) and design.get("schema", 1) == 2


def _readable_samples(item, actor: AuthContext):
    """A template's stored sample values are the builder's: they come from
    Load from asset… (a whole From-To row, rank 80 like the sample-values
    route), so the list, tree and get routes show them only at rank 80."""
    if actor.access.max_rank < SUPER_ADMIN_RANK:
        item.samples = {}
    return item


@router.get("/templates", response_model=list[LabelTemplateOut])
async def list_templates(
    db: DbSession, label_type: str | None = None, size_key: str | None = None,
    dpi_key: str | None = None, language_key: str | None = None,
    active: bool | None = None, site_id: uuid.UUID | None = None,
    actor: AuthContext = require_permission("labels", "view"),
) -> list:
    q = select(LabelTemplate).order_by(natural(LabelTemplate.name))
    for col, val in ((LabelTemplate.label_type, label_type),
                     (LabelTemplate.size_key, size_key),
                     (LabelTemplate.dpi_key, dpi_key),
                     (LabelTemplate.language_key, language_key),
                     (LabelTemplate.is_active, active)):
        if val is not None:
            q = q.where(col == val)
    if site_id is not None:
        assigned = select(LabelTemplateSite.template_id).where(
            LabelTemplateSite.site_id == site_id)
        has_any = select(LabelTemplateSite.template_id)
        q = q.where(LabelTemplate.id.in_(assigned)
                    | LabelTemplate.id.not_in(has_any))
    rows = (await db.execute(q)).scalars().all()
    site_map = await _site_ids_map(db)
    out = []
    for r in rows:
        item = _readable_samples(LabelTemplateOut.model_validate(r), actor)
        item.site_ids = site_map.get(r.id, [])
        out.append(item)
    return out


@router.get("/templates/tree", response_model=list[LabelTemplateTreeOut])
async def template_tree(
    db: DbSession, actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelTemplateTreeOut]:
    """The templates list (spec §4.9): every top-level template, natural by
    name — a builder parent with its DPI children (current and Old, natural
    by name), or an older single row with none."""
    rows = (await db.execute(select(LabelTemplate))).scalars().all()
    site_map = await _site_ids_map(db)
    children: dict[uuid.UUID, list[LabelTemplate]] = {}
    tops: list[LabelTemplate] = []
    for r in rows:
        if r.parent_id is None:
            tops.append(r)
        else:
            children.setdefault(r.parent_id, []).append(r)
    out = []
    for top in sorted(tops, key=lambda r: natural_key(r.name)):
        kids = [_readable_samples(LabelTemplateChildOut(
                    **LabelTemplateOut.model_validate(c).model_dump(),
                    out_of_date=tree.is_out_of_date(c, top)), actor)
                for c in sorted(children.get(top.id, []), key=lambda r: natural_key(r.name))]
        item = _readable_samples(LabelTemplateTreeOut(
            **LabelTemplateOut.model_validate(top).model_dump(),
            family=top.name if top.is_tree_parent else family_name(top.name), children=kids),
            actor)
        item.site_ids = site_map.get(top.id, [])
        out.append(item)
    return out


@router.get("/templates/{template_id}", response_model=LabelTemplateOut)
async def get_template(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "view"),
) -> LabelTemplateOut:
    row = await _template_or_404(db, template_id)
    item = _readable_samples(LabelTemplateOut.model_validate(row), actor)
    item.site_ids = [l.site_id for l in row.site_links]
    return item


@router.post("/templates", response_model=LabelTemplateOut, status_code=201)
async def create_template(
    body: LabelTemplateCreateIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "add"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    if (body.kind == "design") != (body.design is not None) or \
       (body.kind == "code") != (body.code is not None):
        raise _err(422, "bad_payload",
                   message="kind must match exactly one of design/code")
    site_ids = list(dict.fromkeys(body.site_ids or []))
    if _is_v2(body.design):
        return await _create_parent(db, body, site_ids, actor)
    if body.dpi_key is None:
        raise _err(422, "bad_field", field="dpi_key")
    if body.samples:
        raise _err(422, "bad_field", field="samples",
                   message="sample values belong to builder templates")
    values = body.model_dump(exclude={"site_ids", "samples"})
    problems = _validate_generation_rules(values.get("generation_rules") or {})
    if problems:
        raise _err(422, "bad_generation_rules", problems=problems)
    if values.get("design") is not None:
        try:
            parse_design(values["design"])
        except DesignError as e:
            raise _err(422, "bad_design", problems=e.problems) from e
    await _check_template_vocab(db, values)
    await _check_site_ids(db, site_ids)
    existing = (await db.execute(select(LabelTemplate).where(
        LabelTemplate.name == body.name))).scalar_one_or_none()
    if existing is not None:
        raise _err(409, "label_template_exists")
    row = LabelTemplate(**values, dpis=[body.dpi_key])
    db.add(row)
    await db.flush()  # server-generated UUID for the audit row
    for sid in site_ids:
        db.add(LabelTemplateSite(template_id=row.id, site_id=sid))
    tree.add_version(db, row, version=1, summary="Created", actor_id=actor.person.id)
    try:
        await tree.guard_active(db, [row])
    except tree.TreeError as e:
        raise _tree_err(e) from e
    changes = diff({}, snapshot(row, TEMPLATE_FIELDS))
    if site_ids:
        changes["site_ids"] = {"from": [], "to": sorted(str(s) for s in site_ids)}
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="create", changes=changes)
    await db.commit()
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = site_ids
    return item


async def _create_parent(db: DbSession, body: LabelTemplateCreateIn,
                         site_ids: list[uuid.UUID], actor: AuthContext) -> LabelTemplateOut:
    """A schema 2 body: the builder parent and its three DPI children."""
    if body.dpi_key not in (None, tree.PARENT_DPI):
        raise _err(422, "bad_field", field="dpi_key",
                   message="a builder template is designed at 300 DPI")
    if body.generation_rules:
        raise _err(422, "bad_field", field="generation_rules",
                   message="a builder template carries its rules on each field")
    _parse_v2(body.design)
    _check_samples(body.samples)
    await _check_template_vocab(db, {"label_type": body.label_type,
                                     "language_key": body.language_key})
    await _check_new_size(db, body.size_key)
    for dpi in tree.TREE_DPIS:
        await _check_template_vocab(db, {"dpi_key": dpi})
    await _check_site_ids(db, site_ids)
    try:
        parent = await tree.create_parent(
            db, name=body.name, description=body.description, label_type=body.label_type,
            size_key=body.size_key, language_key=body.language_key, design=body.design,
            samples=body.samples or {}, site_ids=site_ids, actor_id=actor.person.id,
            is_active=body.is_active)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    changes = diff({}, snapshot(parent, TEMPLATE_FIELDS))
    changes["children"] = {"from": [], "to": [
        tree.child_name(parent.name, d) for d in tree.TREE_DPIS]}
    if site_ids:
        changes["site_ids"] = {"from": [], "to": sorted(str(s) for s in site_ids)}
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(parent.id), action="create", changes=changes)
    await db.commit()
    return await _template_out(db, parent)


@router.patch("/templates/{template_id}", response_model=LabelTemplateSaveOut)
async def update_template(
    template_id: uuid.UUID, body: LabelTemplateUpdateIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateSaveOut:
    """A builder parent saves its next version (children without hand
    edits follow, `out_of_date` lists the customized ones it has passed);
    a child saves a hand edit (`v<parent>.<edits>`) and otherwise takes only
    activation; an older row updates as it always has."""
    row = await _template_or_404(db, template_id)
    data = body.model_dump(exclude_unset=True)
    summary = data.pop("summary", None)
    try:
        if row.parent_id is not None:
            out_of_date = await _patch_child(db, row, data, summary, actor)
        elif row.is_tree_parent:
            out_of_date = await _patch_parent(db, row, data, summary, actor)
        else:
            out_of_date = await _patch_single(db, row, data, actor)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    await db.commit()
    return await _template_out(db, row, LabelTemplateSaveOut, out_of_date=out_of_date)


def _no_nulls(data: dict, *, allowed: tuple[str, ...] = ()) -> None:
    for f, v in data.items():
        if v is None and f not in allowed:
            raise _err(422, "bad_field", field=f)


async def _set_active(db: DbSession, row: LabelTemplate, active: bool) -> bool:
    if active == row.is_active:
        return False
    if active:
        await tree.activate(db, row)
    else:
        await tree.deactivate(db, row)
    return True


async def _patch_child(db: DbSession, row: LabelTemplate, data: dict, summary: str | None,
                       actor: AuthContext) -> list[uuid.UUID]:
    if "is_active" in data:
        raise tree.ChildFollowsParent()
    for f in data:
        if f != "design":
            raise _err(422, "bad_field", field=f, message="set on the parent template")
    _no_nulls(data)
    changes: dict = {}
    if "design" in data:
        _parse_v2(data["design"])
        if data["design"] != row.design:
            before = tree.version_label(row.generated_from_version or 0, row.child_edits)
            await tree.save_child(db, row, design=data["design"], summary=summary,
                                  actor_id=actor.person.id)
            changes["version"] = {"from": before, "to": tree.version_label(
                row.generated_from_version or 0, row.child_edits)}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="update", changes=changes)
    return await _out_of_date(db, row)


async def _patch_parent(db: DbSession, row: LabelTemplate, data: dict, summary: str | None,
                        actor: AuthContext) -> list[uuid.UUID]:
    for f in ("dpi_key", "code", "generation_rules"):
        if f in data:
            raise _err(422, "bad_field", field=f,
                       message="a builder template has no " + f.replace("_", " "))
    _no_nulls(data)
    new_site_ids = data.pop("site_ids", None)
    if "design" in data:
        _parse_v2(data["design"])
    _check_samples(data.get("samples"))
    await _check_template_vocab(db, data, current=row)
    changes: dict = {}
    if "name" in data and data["name"] != row.name:
        before = row.name
        await tree.rename_parent(db, row, data["name"])
        changes["name"] = {"from": before, "to": row.name}
    if "description" in data and data["description"] != row.description:
        changes["description"] = {"from": row.description, "to": data["description"]}
        row.description = data["description"]
    fields = {f: data[f] for f in ("label_type", "size_key", "language_key")
              if f in data and data[f] != getattr(row, f)}
    if fields:
        changes.update({f: {"from": getattr(row, f), "to": v} for f, v in fields.items()})
        await tree.set_parent_fields(db, row, fields)
    if new_site_ids is not None:
        new_site_ids = list(dict.fromkeys(new_site_ids))
        await _check_site_ids(db, new_site_ids)
        current = sorted(str(link.site_id) for link in row.site_links)
        incoming = sorted(str(s) for s in new_site_ids)
        if current != incoming:
            changes["site_ids"] = {"from": current, "to": incoming}
            row.site_links = [LabelTemplateSite(template_id=row.id, site_id=sid)
                              for sid in new_site_ids]
    design = data.get("design", row.design)
    samples = data.get("samples", row.samples or {})
    if design != row.design or samples != (row.samples or {}):
        before_version = row.version
        await tree.save_parent(db, row, design=design, samples=samples, summary=summary,
                               actor_id=actor.person.id)
        changes["version"] = {"from": before_version, "to": row.version}
    if "is_active" in data and await _set_active(db, row, data["is_active"]):
        changes["is_active"] = {"from": not data["is_active"], "to": data["is_active"]}
    elif "name" in changes or "label_type" in changes:
        # a new family name or type can land on another active template
        # (guard_active looks at the active rows only)
        await tree.guard_active(db, await tree.printing_rows(db, row))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="update", changes=changes)
    return await _out_of_date(db, row)


async def _patch_single(db: DbSession, row: LabelTemplate, data: dict,
                        actor: AuthContext) -> list[uuid.UUID]:
    """An older (schema 1, no parent) row: the update as it always was,
    plus a version per change and the one-active rule."""
    if "samples" in data:
        raise _err(422, "bad_field", field="samples",
                   message="sample values belong to builder templates")
    new_site_ids = data.pop("site_ids", None)
    if new_site_ids is not None:
        new_site_ids = list(dict.fromkeys(new_site_ids))
    # design/code nullability is owned by kind; other fields reject null
    _no_nulls(data, allowed=("design", "code"))
    if row.kind == "design" and data.get("design", row.design) is None:
        raise _err(422, "bad_payload", message="design templates need design")
    if row.kind == "code" and data.get("code", row.code) is None:
        raise _err(422, "bad_payload", message="code templates need code")
    if row.kind == "design" and "code" in data and data["code"] is not None:
        raise _err(422, "bad_payload", message="design templates carry no code")
    if row.kind == "code" and "design" in data and data["design"] is not None:
        raise _err(422, "bad_payload", message="code templates carry no design")
    if "generation_rules" in data:
        problems = _validate_generation_rules(data["generation_rules"] or {})
        if problems:
            raise _err(422, "bad_generation_rules", problems=problems)
    if data.get("design") is not None:
        if _is_v2(data["design"]):
            raise _err(422, "bad_design", problems=[
                "a schema 2 design needs a builder template: create one"])
        try:
            parse_design(data["design"])
        except DesignError as e:
            raise _err(422, "bad_design", problems=e.problems) from e
    await _check_template_vocab(db, data, current=row)
    if "name" in data and data["name"].lower() != row.name.lower():
        dupe = (await db.execute(select(LabelTemplate).where(
            LabelTemplate.name == data["name"]))).scalar_one_or_none()
        if dupe is not None:
            raise _err(409, "label_template_exists")
    before = snapshot(row, TEMPLATE_FIELDS)
    for field, value in data.items():
        setattr(row, field, value)
    if "dpi_key" in data:
        row.dpis = [row.dpi_key]
    changes = diff(before, snapshot(row, TEMPLATE_FIELDS))
    if new_site_ids is not None:
        await _check_site_ids(db, new_site_ids)
        current = sorted(str(link.site_id) for link in row.site_links)
        incoming = sorted(str(s) for s in new_site_ids)
        if current != incoming:
            changes["site_ids"] = {"from": current, "to": incoming}
            row.site_links = [LabelTemplateSite(template_id=row.id,
                                                site_id=sid)
                              for sid in new_site_ids]
    if changes:
        row.version += 1
        row.updated_at = datetime.now(UTC)
        tree.add_version(db, row, version=row.version, summary=_single_summary(before, changes),
                         actor_id=actor.person.id)
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="update", changes=changes)
        if row.is_active and changes.keys() & {"is_active", "name", "label_type", "dpi_key"}:
            await tree.guard_active(db, [row])
    return []


_FIELD_WORDS = {"site_ids": "sites", "is_active": "active", "label_type": "type",
                "size_key": "size", "dpi_key": "DPI", "language_key": "language",
                "generation_rules": "generation rules"}


def _single_summary(before: dict, changes: dict) -> str:
    """The version line for an older row's update."""
    if "design" in changes:
        return tree.change_summary(before.get("design"), changes["design"]["to"])
    if "code" in changes:
        return "Edited the code"
    return "Changed " + ", ".join(_FIELD_WORDS.get(f, f) for f in sorted(changes))


async def _sample_values(db: DbSession) -> dict[str, str]:
    rows = (await db.execute(select(LabelPlaceholder))).scalars().all()
    return {r.key: r.sample_value for r in rows}


# A preview or test print compiles with the page's samples: a field's worth
# each, not a payload.
MAX_COMPILE_SAMPLES = 200
MAX_SAMPLE_CHARS = 500


def _check_samples(samples: dict[str, str] | None) -> None:
    """422 bad_field (samples) past the caps: a preview's, a create's and a
    save's sample values alike."""
    if samples is not None and len(samples) > MAX_COMPILE_SAMPLES:
        raise _err(422, "bad_field", field="samples",
                   message=f"at most {MAX_COMPILE_SAMPLES} sample values")
    if samples and max(map(len, samples.values())) > MAX_SAMPLE_CHARS:
        raise _err(422, "bad_field", field="samples",
                   message=f"a sample value is at most {MAX_SAMPLE_CHARS} characters")


def _builder_values(design: dict, samples: dict[str, str] | None) -> dict[str, str]:
    """What a schema 2 design prints in the builder's preview and test
    print: the portal's mock values, shaped like `field_values` (a From-To
    column prints its header), with the template's samples over them —
    never the placeholder catalog's v1 samples."""
    return {**mock_field_values(None, design_field_keys(design)), **(samples or {})}


async def _compile_design(db: DbSession, design_json: dict, size_key: str,
                          dpi_key: str, language_key: str,
                          subs: dict[str, str] | None) -> str:
    """Shared by the compile endpoint and convert-to-code: resolves the
    size/dpi/language vocab rows, then calls the vocab-free core
    (labels/compile.py, shared with the label-generation runner)."""
    size = await db.get(LabelVocab, ("size", size_key))
    dpi = await db.get(LabelVocab, ("dpi", dpi_key))
    lang = await db.get(LabelVocab, ("language", language_key))
    if size is None or dpi is None or lang is None:
        raise _err(404, "unknown_vocab")
    try:
        return compile_design(
            design_json, width_in=size.meta["width_in"], height_in=size.meta["height_in"],
            dots=dpi.meta["dots"], language_key=lang.key, subs=subs)
    except DesignError as e:
        raise _err(422, "bad_design", problems=e.problems) from e
    except UnsupportedLanguage as e:
        raise _err(422, "unsupported_language", key=e.key) from e


@router.post("/templates/compile", response_model=LabelCompileOut)
async def compile_template(
    body: LabelCompileIn, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> LabelCompileOut:
    size = await db.get(LabelVocab, ("size", body.size_key))
    dpi = await db.get(LabelVocab, ("dpi", body.dpi_key))
    lang = await db.get(LabelVocab, ("language", body.language_key))
    if size is None or dpi is None or lang is None:
        raise _err(404, "unknown_vocab")
    v2 = body.kind == "design" and _is_v2(body.design)
    if body.samples is not None and not v2:
        raise _err(422, "bad_field", field="samples",
                   message="sample values belong to builder templates")
    _check_samples(body.samples)
    if v2:
        subs = _builder_values(body.design, body.samples)
    else:
        subs = await _sample_values(db) if body.mode == "sample" else None

    if body.kind == "code":
        if body.code is None:
            raise _err(422, "bad_payload", message="code kind needs code")
        out = body.code if subs is None else apply_placeholders(body.code, subs)
        return LabelCompileOut(code=out)

    if body.design is None:
        raise _err(422, "bad_payload", message="design kind needs design")
    out = await _compile_design(db, body.design, body.size_key, body.dpi_key,
                                body.language_key, subs)
    return LabelCompileOut(code=out)


@router.post("/templates/{template_id}/convert-to-code",
             response_model=LabelTemplateOut)
async def convert_template_to_code(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    row = await _template_or_404(db, template_id)
    if row.kind != "design":
        raise _err(409, "not_a_design_template")
    if row.parent_id is not None or row.is_tree_parent or _is_v2(row.design):
        # a schema 2 design has no token form to keep as code
        raise _err(409, "builder_template")
    code = await _compile_design(db, row.design, row.size_key, row.dpi_key,
                                 row.language_key, None)
    row.kind = "code"
    row.code = code
    row.design = None
    row.version += 1
    row.updated_at = datetime.now(UTC)
    tree.add_version(db, row, version=row.version, summary="Converted to code",
                     actor_id=actor.person.id)
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="convert_to_code",
          changes={"kind": {"from": "design", "to": "code"}})
    await db.commit()
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = [l.site_id for l in row.site_links]
    return item


_DPMM = {203: 8, 300: 12, 600: 24}

# The resident cut by its printer object name: Labelary has no copy, and
# its font 0 is the same face (spec §4.4), so a preview draws it with that.
_RESIDENT_A_AT = re.compile(
    r"\^A@([NRIB]),(\d+),(\d+),E:(?:"
    + "|".join(re.escape(obj) for f in FAMILIES.values() if f["resident"]
               for obj in f["objects"].values() if obj)
    + r")", re.IGNORECASE)

# Font bytes per stored file, read once: (font id, storage key, size) → bytes.
# Only the builder's few open fonts come through here; the cap bounds it.
_FONT_BYTES_CACHE: dict[tuple[uuid.UUID, str, int], bytes] = {}
_FONT_BYTES_CACHE_MAX = 32


async def _font_download(db: DbSession, font_id: uuid.UUID) -> bytes:
    """`~DY` of one library font, as Install Fonts sends it: the binary
    TrueType header, then the file. Never the resident font (403
    `font_not_servable`, as its content route)."""
    font = await _font_or_404(db, font_id)
    if font.resident or resident_object(font.name):
        raise _err(403, "font_not_servable")
    if not font.storage_key:
        raise _err(404, "no_font_file")
    key = (font.id, font.storage_key, font.size_bytes)
    data = _FONT_BYTES_CACHE.get(key)
    if data is None:
        data = await get_object(font.storage_key)
        if len(_FONT_BYTES_CACHE) >= _FONT_BYTES_CACHE_MAX:
            _FONT_BYTES_CACHE.clear()
        _FONT_BYTES_CACHE[key] = data
    return f"~DYE:{font.name.upper()},B,T,{len(data)},,".encode() + data


@router.post("/preview/zpl")
async def preview_zpl(
    body: LabelZplPreviewIn, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> Response:
    """The printer-rendered preview (Labelary). `font_ids` embeds those
    library fonts ahead of the label (`~DY`) so it renders in them; the
    resident Swiss cut is drawn with Labelary's font 0 (`^A0`)."""
    size = await db.get(LabelVocab, ("size", body.size_key))
    dpi = await db.get(LabelVocab, ("dpi", body.dpi_key))
    if size is None or dpi is None:
        raise _err(404, "unknown_vocab")
    dpmm = _DPMM.get(dpi.meta["dots"])
    if dpmm is None:
        raise _err(422, "unsupported_dpi", dots=dpi.meta["dots"])
    zpl = _RESIDENT_A_AT.sub(r"^A0\1,\2,\3", body.zpl)
    downloads = [await _font_download(db, fid) for fid in dict.fromkeys(body.font_ids)]
    payload: str | bytes = b"".join(downloads) + zpl.encode("utf-8") if downloads else zpl
    try:
        png = await labelary.render_png(
            payload, size.meta["width_in"], size.meta["height_in"], dpmm)
    except Exception:
        raise _err(502, "labelary_unavailable") from None
    return Response(png, media_type="image/png")


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(
    template_id: uuid.UUID, db: DbSession, body: LabelTemplateDeleteIn | None = None,
    actor: AuthContext = require_permission("labels", "delete"),
    _rank: AuthContext = DESIGNER,
) -> None:
    """Delete for real (spec §3.4, §4.1). A DPI child goes alone (a current
    one leaves its parent's DPI set); a top-level template needs
    `typed_name` to be exactly its name (422 `name_mismatch` with the
    summary otherwise) and takes its children with it. Either way the
    labels generated from them go too. Deactivating is POST …/deactivate."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    name = row.name
    try:
        if row.parent_id is not None:
            summary = await tree.delete_child(db, row)
        else:
            summary = await tree.delete_parent(db, row, body.typed_name if body else None)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(template_id), action="delete",
          changes={"name": {"from": name, "to": None}, "children": summary["children"],
                   "generated_labels": summary["generated_labels"]})
    await db.commit()


@router.get("/templates/{template_id}/delete-summary",
            response_model=LabelTemplateDeleteSummaryOut)
async def template_delete_summary(
    template_id: uuid.UUID, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
    _rank: AuthContext = DESIGNER,
) -> dict:
    """What DELETE would take: the children by name and the count of
    labels generated from the template and its children."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    return await tree.delete_summary(db, row)


@router.post("/templates/{template_id}/deactivate", status_code=204)
async def deactivate_template(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> None:
    """Turn a template off (a parent with its children). A child follows
    its parent: 409 `child_follows_parent` on a child."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    try:
        changed = await tree.deactivate(db, row)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    if changed:
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="deactivate",
              changes={"name": row.name, "rows": [r.name for r in changed]})
    await db.commit()


@router.post("/templates/{template_id}/activate", response_model=LabelTemplateOut)
async def activate_template(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    """Turn a template on (a parent with its current children) — refused
    with 422 `active_conflict` while another active template prints the
    same family, type and DPI; Replace… swaps them instead. A child follows
    its parent: 409 `child_follows_parent` on a child."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    try:
        changed = await tree.activate(db, row)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    if changed:
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="activate",
              changes={"name": row.name, "rows": [r.name for r in changed]})
    await db.commit()
    return await _template_out(db, row)


@router.post("/templates/{template_id}/replace", response_model=LabelTemplateOut)
async def replace_templates(
    template_id: uuid.UUID, body: LabelTemplateReplaceIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    """Replace…: deactivate `old_template_ids` and activate this template in
    one step (spec §4.1). On an `active_conflict` nothing changes."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    try:
        off, on = await tree.replace(db, row, body.old_template_ids, actor.person.id)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="replace",
          changes={"deactivated": sorted((r.name for r in off), key=natural_key),
                   "activated": sorted((r.name for r in on), key=natural_key)})
    await db.commit()
    return await _template_out(db, row)


@router.post("/templates/{template_id}/update-from-parent", response_model=LabelTemplateOut,
             status_code=201)
async def update_child_from_parent(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    """A customized child gives way to a fresh one generated from the
    parent; it stays nested as "… Old", inactive. Returns the fresh child —
    the same one again when the child was already updated (idempotent)."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    try:
        fresh, created = await tree.update_from_parent(db, row, actor.person.id)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    if created:
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="update_from_parent",
              changes={"name": {"from": fresh.name, "to": row.name},
                       "replaced_by": str(fresh.id)})
    await db.commit()
    return await _template_out(db, fresh)


@router.post("/templates/{template_id}/dpis", response_model=LabelTemplateOut,
             status_code=201)
async def add_template_dpi(
    template_id: uuid.UUID, body: LabelTemplateDpiIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    """Add DPI: bring a deleted DPI child back, generated from the parent."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    before = list(row.dpis or [])
    try:
        child = await tree.add_dpi(db, row, body.dpi, actor_id=actor.person.id)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="add_dpi",
          changes={"dpis": {"from": before, "to": list(row.dpis)}, "child": child.name})
    await db.commit()
    return await _template_out(db, child)


@router.post("/templates/{template_id}/clone", response_model=LabelTemplateOut,
             status_code=201)
async def clone_template(
    template_id: uuid.UUID, body: LabelTemplateCloneIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "add"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateOut:
    """Clone to a new, inactive template named `name`: design, samples,
    sites and (for a parent) its current children, customizations and all."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    try:
        copy_row = await tree.clone(db, row, body.name, actor.person.id)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(copy_row.id), action="clone",
          changes={"from": str(row.id), "name": {"from": None, "to": copy_row.name}})
    await db.commit()
    return await _template_out(db, copy_row)


def _version_fields(v: LabelTemplateVersion, by: dict[uuid.UUID, str]) -> dict:
    return {"version": v.version, "child_edits": v.child_edits,
            "label": tree.version_label(v.version, v.child_edits), "summary": v.summary,
            "note": v.note, "created_by": v.created_by,
            "created_by_name": by.get(v.created_by) if v.created_by else None,
            "created_at": v.created_at}


async def _authors(db: DbSession, ids) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    rows = (await db.execute(select(Person.id, Person.preferred_name, Person.first_name,
                                     Person.last_name).where(Person.id.in_(ids)))).all()
    return {pid: _person_display(p, first, last) for pid, p, first, last in rows}


async def _version_detail(db: DbSession, v: LabelTemplateVersion) -> LabelTemplateVersionDetailOut:
    by = await _authors(db, [v.created_by])
    return LabelTemplateVersionDetailOut(**_version_fields(v, by), design=v.design,
                                         code=v.code, samples=v.samples or {})


@router.get("/templates/{template_id}/versions", response_model=list[LabelTemplateVersionOut])
async def list_template_versions(
    template_id: uuid.UUID, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
    _rank: AuthContext = DESIGNER,
) -> list[LabelTemplateVersionOut]:
    """One line per save, newest first (`v7`, a child's `v7.2`)."""
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    rows = await tree.versions(db, row)
    by = await _authors(db, (v.created_by for v in rows))
    return [LabelTemplateVersionOut(**_version_fields(v, by)) for v in rows]


async def _template_version(db: DbSession, template_id: uuid.UUID, version: int,
                            child_edits: int) -> tuple[LabelTemplate, LabelTemplateVersion]:
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    try:
        return row, await tree.get_version(db, row, version, child_edits)
    except tree.TreeError as e:
        raise _tree_err(e) from e


@router.get("/templates/{template_id}/versions/{version}/{child_edits}",
            response_model=LabelTemplateVersionDetailOut)
async def get_template_version(
    template_id: uuid.UUID, version: int, child_edits: int, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateVersionDetailOut:
    """One saved state, to open read-only."""
    _row, v = await _template_version(db, template_id, version, child_edits)
    return await _version_detail(db, v)


@router.patch("/templates/{template_id}/versions/{version}/{child_edits}",
              response_model=LabelTemplateVersionDetailOut)
async def note_template_version(
    template_id: uuid.UUID, version: int, child_edits: int,
    body: LabelTemplateVersionNoteIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateVersionDetailOut:
    """The author's note on a version, added after the save (⌘S never asks)."""
    row, v = await _template_version(db, template_id, version, child_edits)
    if body.note != v.note:
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="version_note",
              changes={"version": tree.version_label(version, child_edits),
                       "note": {"from": v.note, "to": body.note}})
        v.note = body.note
    await db.commit()
    return await _version_detail(db, v)


@router.post("/templates/{template_id}/versions/{version}/{child_edits}/restore",
             response_model=LabelTemplateSaveOut)
async def restore_template_version(
    template_id: uuid.UUID, version: int, child_edits: int, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
    _rank: AuthContext = DESIGNER,
) -> LabelTemplateSaveOut:
    """Save an older version again as the next one (a parent's children
    follow as on any parent save)."""
    row = await _template_or_404(db, template_id)
    try:
        await tree.restore(db, row, version, child_edits, actor.person.id)
    except tree.TreeError as e:
        raise _tree_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="restore",
          changes={"restored": tree.version_label(version, child_edits),
                   "version": row.version})
    await db.commit()
    return await _template_out(db, row, LabelTemplateSaveOut,
                               out_of_date=await _out_of_date(db, row))


async def _out_of_date(db: DbSession, row: LabelTemplate) -> list[uuid.UUID]:
    """A parent's out-of-date children, or a child itself when it is one."""
    if row.is_tree_parent:
        return await tree.out_of_date_ids(db, row)
    if row.parent_id is not None and tree.is_out_of_date(row, await tree.parent_of(db, row)):
        return [row.id]
    return []


# ── generate labels (runs, preview, generated) ─────────────────────

RUNS_DEFAULT_LIMIT = 25
RUNS_MAX_LIMIT = 200
GENERATED_DEFAULT_LIMIT = 100
GENERATED_MAX_LIMIT = 500
ACTIVE_RUN_STATUSES = ("queued", "running")


async def _scoped_initiative(
    db: DbSession, actor: AuthContext, initiative_id: uuid.UUID,
) -> Initiative:
    """Same 404 initiative_not_found contract as reports.py's create_run:
    unknown, archived, or out-of-scope all read identically to the
    caller (no leaking which case it was)."""
    ini = await db.get(Initiative, initiative_id)
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if ini is None or ini.archived_at is not None or (
            cond is not None and await db.scalar(
                select(Initiative.id).where(Initiative.id == ini.id, cond)) is None):
        raise _err(404, "initiative_not_found")
    return ini


def _run_out(run: LabelGenerationRun, initiative_name: str, requested_by_name: str) -> LabelRunOut:
    progress_pct = round(run.processed / run.total * 100) if run.total else 0
    return LabelRunOut(
        id=run.id, initiative_id=run.initiative_id, initiative_name=initiative_name,
        label_types=list(run.label_types), regenerate_existing=run.regenerate_existing,
        status=run.status, cancel_requested=run.cancel_requested,
        current_label_type=run.current_label_type, current_item=run.current_item,
        total=run.total, processed=run.processed, generated=run.generated,
        skipped=run.skipped, errors=run.errors, error_summary=run.error_summary,
        error_details=run.error_details, error=run.error, requested_by=run.requested_by,
        requested_by_name=requested_by_name, notify=run.notify, created_at=run.created_at,
        started_at=run.started_at, finished_at=run.finished_at, worker_id=run.worker_id,
        progress_pct=progress_pct, template_overrides=dict(run.template_overrides or {}),
        dpi_key=run.dpi_key)


def _runs_query(actor: AuthContext):
    q = (select(LabelGenerationRun, Initiative.name, Person.preferred_name,
                Person.first_name, Person.last_name)
         .join(Initiative, Initiative.id == LabelGenerationRun.initiative_id)
         .join(Person, Person.id == LabelGenerationRun.requested_by))
    # Defense in depth, same posture as reports.py's _visible_runs: `labels`
    # is a global-only resource today (require_permission already blocked
    # a non-global actor), so scope_conditions() always returns None here
    # and this leg is unreachable — it stays so history narrows the day
    # initiatives grow a scoped grant, instead of leaking.
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        q = q.where(cond)
    return q


async def _run_out_for_id(db: DbSession, run_id: uuid.UUID, actor: AuthContext) -> LabelRunOut:
    row = (await db.execute(
        _runs_query(actor).where(LabelGenerationRun.id == run_id))).first()
    if row is None:
        raise _err(404, "run_not_found")
    run, initiative_name, preferred, first, last = row
    return _run_out(run, initiative_name, f"{preferred or first} {last}".strip())


@router.post("/generate/runs", response_model=LabelRunOut, status_code=202)
async def create_generation_run(
    body: LabelRunCreateIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "add"),
) -> LabelRunOut:
    if body.regenerate_existing and not actor.access.can("labels", "change"):
        raise _err(403, "forbidden")
    await _scoped_initiative(db, actor, body.initiative_id)
    try:
        run = await enqueue_run(
            db, initiative_id=body.initiative_id, label_types=body.label_types,
            regenerate_existing=body.regenerate_existing, requested_by=actor.person.id,
            notify=body.notify,
            template_overrides={k: str(v) for k, v in body.templates.items()},
            dpi_key=body.dpi_key)
    except InvalidLabelTypes as exc:
        raise _err(422, "invalid_label_types", problems=exc.problems) from exc
    except InvalidDpi as exc:
        raise _err(422, "invalid_dpi") from exc
    except InvalidTemplates as exc:
        raise _err(422, "invalid_templates", problems=exc.problems) from exc
    except RunActive as exc:
        raise _err(409, "run_active", run_id=str(exc.run_id)) from exc
    except IntegrityError as exc:
        # Defense in depth against the one-active-run-per-initiative
        # partial unique index: a race between two concurrent enqueue_run
        # calls surfaces here as a raw IntegrityError rather than
        # RunActive (see gl-task-1-report.md's own note on this). Roll
        # back the aborted transaction, then report the same clean 409.
        await db.rollback()
        existing = await db.scalar(select(LabelGenerationRun).where(
            LabelGenerationRun.initiative_id == body.initiative_id,
            LabelGenerationRun.status.in_(ACTIVE_RUN_STATUSES)))
        if existing is not None:
            raise _err(409, "run_active", run_id=str(existing.id)) from exc
        raise
    audit(db, actor_id=actor.person.id, entity_type="label_generation_run",
          entity_id=str(run.id), action="create",
          changes={"initiative_id": {"from": None, "to": str(body.initiative_id)},
                   "label_types": {"from": [], "to": list(run.label_types)},
                   "dpi_key": {"from": None, "to": run.dpi_key}})
    await db.commit()
    return await _run_out_for_id(db, run.id, actor)


@router.get("/generate/runs", response_model=list[LabelRunOut])
async def list_generation_runs(
    db: DbSession, initiative_id: uuid.UUID | None = None,
    limit: int = RUNS_DEFAULT_LIMIT,
    actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelRunOut]:
    q = _runs_query(actor)
    if initiative_id is not None:
        q = q.where(LabelGenerationRun.initiative_id == initiative_id)
    q = (q.order_by(LabelGenerationRun.created_at.desc(), LabelGenerationRun.id.desc())
          .limit(max(1, min(limit, RUNS_MAX_LIMIT))))
    rows = (await db.execute(q)).all()
    return [_run_out(run, initiative_name, f"{preferred or first} {last}".strip())
            for run, initiative_name, preferred, first, last in rows]


@router.get("/generate/runs/{run_id}", response_model=LabelRunOut)
async def get_generation_run(
    run_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "view"),
) -> LabelRunOut:
    return await _run_out_for_id(db, run_id, actor)


@router.post("/generate/runs/{run_id}/cancel", response_model=LabelRunOut)
async def cancel_generation_run(
    run_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
) -> LabelRunOut:
    row = (await db.execute(
        _runs_query(actor).where(LabelGenerationRun.id == run_id))).first()
    if row is None:
        raise _err(404, "run_not_found")
    run = row[0]
    before_status = run.status
    before_cancel_requested = run.cancel_requested
    if run.status == "queued":
        run.status = "canceled"
        run.cancel_requested = True
        run.finished_at = datetime.now(UTC)
    elif run.status == "running":
        run.cancel_requested = True
    else:
        raise _err(409, "run_not_cancelable")
    # A running run that already had cancel_requested=True (a repeat
    # cancel click, or two callers racing) changes nothing here — record
    # the TRUE prior value rather than hardcoding False->True, and skip
    # the audit row entirely when nothing actually changed so a no-op
    # cancel never fabricates a transition that didn't happen.
    changes: dict = {}
    if before_status != run.status:
        changes["status"] = {"from": before_status, "to": run.status}
    if before_cancel_requested != run.cancel_requested:
        changes["cancel_requested"] = {"from": before_cancel_requested,
                                       "to": run.cancel_requested}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="label_generation_run",
              entity_id=str(run.id), action="cancel", changes=changes)
    await db.commit()
    return await _run_out_for_id(db, run_id, actor)


@router.get("/generate/preview", response_model=LabelGeneratePreviewOut)
async def preview_generation(
    initiative_id: uuid.UUID, db: DbSession, dpi_key: str = "300",
    actor: AuthContext = require_permission("labels", "view"),
) -> LabelGeneratePreviewOut:
    """What a run at `dpi_key` (300 by default, like a run) would do: each
    type's templates at that DPI and the counts of its labels at that DPI."""
    ini = await _scoped_initiative(db, actor, initiative_id)

    client_name = (await db.scalar(select(Client.name).where(Client.id == ini.client_id))
                  if ini.client_id is not None else None)
    source_name = (await db.scalar(select(Site.name).where(Site.id == ini.origin_site_id))
                  if ini.origin_site_id is not None else None)
    destination_name = (
        await db.scalar(select(Site.name).where(Site.id == ini.destination_site_id))
        if ini.destination_site_id is not None else None)
    asset_count = await db.scalar(
        select(func.count()).select_from(InitiativeAsset)
        .where(InitiativeAsset.initiative_id == ini.id)) or 0
    # The container label types label containers, not assets, so the preview
    # carries both counts and the portal shows whichever the picked types
    # describe. Counted exactly as the runner's roster is built
    # (`_load_container_roster`) — initiative match AND not archived — so the
    # number the operator sees is the number of labels the run produces.
    container_count = await db.scalar(
        select(func.count()).select_from(Container)
        .where(Container.initiative_id == ini.id,
               Container.archived_at.is_(None))) or 0

    # Same site preference as the runner: destination, else origin.
    template_site_id = ini.destination_site_id or ini.origin_site_id
    type_rows = (await db.execute(
        select(LabelVocab).where(LabelVocab.kind == "type", LabelVocab.is_active == True)  # noqa: E712
        .order_by(LabelVocab.sort_order, natural(LabelVocab.key)))).scalars().all()

    types: list[LabelGeneratePreviewTypeOut] = []
    for vocab in type_rows:
        candidates = await candidate_templates(db, vocab.key, template_site_id, dpi_key)
        template = None
        template_out = None
        if candidates and candidates[0].scope in ("site", "global"):
            auto = candidates[0]
            template = auto.template
            template_out = LabelGeneratePreviewTemplateOut(
                id=auto.template.id, name=auto.template.name,
                version=auto.template.version, scope=auto.scope)
        candidates_out = [
            LabelGeneratePreviewCandidateOut(
                id=c.template.id, name=c.template.name, version=c.template.version,
                scope=c.scope, site_names=c.site_names)
            for c in candidates]

        current = stale = 0
        existing_rows = (await db.execute(
            select(GeneratedLabel.template_id, GeneratedLabel.template_version,
                   GeneratedLabel.stale)
            .where(GeneratedLabel.initiative_id == ini.id,
                   GeneratedLabel.entity_type == entity_for_type(vocab.key),
                   GeneratedLabel.label_type == vocab.key,
                   GeneratedLabel.dpi_key == dpi_key))).all()
        for template_id, template_version, is_stale in existing_rows:
            if (template is not None and template_id == template.id
                    and template_version == template.version and not is_stale):
                current += 1
            else:
                stale += 1

        types.append(LabelGeneratePreviewTypeOut(
            key=vocab.key, label=vocab.label, template=template_out,
            candidates=candidates_out, current=current, stale=stale))

    active_run_id = await db.scalar(select(LabelGenerationRun.id).where(
        LabelGenerationRun.initiative_id == ini.id,
        LabelGenerationRun.status.in_(ACTIVE_RUN_STATUSES)))

    return LabelGeneratePreviewOut(
        initiative=LabelGeneratePreviewInitiativeOut(
            id=ini.id, name=ini.name, client_name=client_name, status=ini.status,
            scheduled_start=ini.scheduled_start, source_name=source_name,
            destination_name=destination_name, asset_count=asset_count,
            container_count=container_count),
        types=types, active_run_id=active_run_id)


@router.get("/generated", response_model=list[GeneratedLabelOut])
async def list_generated_labels(
    db: DbSession, initiative_id: uuid.UUID | None = None,
    label_type: str | None = None, entity_id: uuid.UUID | None = None,
    dpi_key: str | None = None,
    limit: int = GENERATED_DEFAULT_LIMIT, before: datetime | None = None,
    actor: AuthContext = require_permission("labels", "view"),
) -> list[GeneratedLabelOut]:
    q = (select(GeneratedLabel, Asset.legacy_id, Asset.serial_number, Asset.name,
                LabelTemplate.name, LabelTemplate.version)
         .outerjoin(Asset, Asset.id == GeneratedLabel.entity_id)
         .join(LabelTemplate, LabelTemplate.id == GeneratedLabel.template_id))
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        # Defense in depth, same posture as _runs_query above — unreachable
        # today since `labels` is global-only. GeneratedLabel.initiative_id
        # is nullable (a label may outlive its initiative), so the join
        # must be OUTER and the scope check paired with "no initiative at
        # all" rather than silently dropping those rows for a scoped actor.
        q = (q.outerjoin(Initiative, Initiative.id == GeneratedLabel.initiative_id)
              .where(or_(GeneratedLabel.initiative_id.is_(None), cond)))
    if initiative_id is not None:
        q = q.where(GeneratedLabel.initiative_id == initiative_id)
    if label_type is not None:
        q = q.where(GeneratedLabel.label_type == label_type)
    if entity_id is not None:
        q = q.where(GeneratedLabel.entity_id == entity_id)
    if dpi_key is not None:
        q = q.where(GeneratedLabel.dpi_key == dpi_key)
    if before is not None:
        q = q.where(GeneratedLabel.generated_at < before)
    q = (q.order_by(GeneratedLabel.generated_at.desc(), GeneratedLabel.id.desc())
          .limit(max(1, min(limit, GENERATED_MAX_LIMIT))))
    rows = (await db.execute(q)).all()
    out = []
    for gl, legacy_id, serial, name, template_name, template_version in rows:
        is_asset = gl.entity_type == "asset"
        out.append(GeneratedLabelOut(
            id=gl.id, entity_type=gl.entity_type, entity_id=gl.entity_id,
            asset_id=legacy_id if is_asset else None,
            serial_number=serial if is_asset else None,
            name=name if is_asset else None,
            label_type=gl.label_type, template_name=template_name,
            template_version=template_version, dpi_key=gl.dpi_key,
            generated_at=gl.generated_at, stale=gl.stale, code=gl.code))
    return out


@router.get("/generated/bundle", response_model=GeneratedLabelBundleOut)
async def get_generated_label_bundle(
    db: DbSession, initiative_id: uuid.UUID, label_type: str,
    actor: AuthContext = require_permission("labels", "view"),
) -> GeneratedLabelBundleOut:
    """Print Labels' data source: every label of one type on one
    initiative — asset or container, whichever `label_type` maps to —
    with the language/size/dpi keys the page needs to decide what a
    Zebra printer can take. Every DPI's labels come down (an entity has
    one per DPI it was generated at); the page keeps the connected
    printer's, and its offline cache holds them all. Unknown/archived/
    out-of-scope initiatives read as 404 like the preview endpoint."""
    ini = await _scoped_initiative(db, actor, initiative_id)
    # The entity filter is the whole point of the mapping: a container type
    # must never serve asset labels (or the reverse), whatever rows happen
    # to share the initiative. Display names are deliberately NOT joined —
    # the page builds its roster from /assets and /containers, which carry
    # far richer rows, and keys this payload by entity_id alone.
    entity_type = entity_for_type(label_type)
    query = (select(GeneratedLabel, LabelTemplate.name)
             .join(LabelTemplate, LabelTemplate.id == GeneratedLabel.template_id)
             .where(GeneratedLabel.initiative_id == ini.id,
                    GeneratedLabel.entity_type == entity_type,
                    GeneratedLabel.label_type == label_type)
             .order_by(GeneratedLabel.generated_at, GeneratedLabel.id))
    rows = (await db.execute(query)).all()
    return GeneratedLabelBundleOut(
        initiative_id=ini.id, label_type=label_type, fetched_at=datetime.now(UTC),
        labels=[
            GeneratedLabelBundleItemOut(
                id=gl.id, entity_type=gl.entity_type, entity_id=gl.entity_id,
                template_id=gl.template_id, template_name=template_name,
                template_version=gl.template_version, language_key=gl.language_key,
                size_key=gl.size_key, dpi_key=gl.dpi_key, stale=gl.stale,
                generated_at=gl.generated_at, code=gl.code)
            for gl, template_name in rows])


# ── font library (Labels → Printers › Install Fonts) ─────────────────

FONT_NAME_RE = re.compile(r"^[A-Z0-9_]{1,8}\.TTF$")


def font_object_name(filename: str | None) -> str | None:
    """Zebra object name for a font file: the bare filename, upper-cased,
    valid only as 8.3 `NAME.TTF` (letters, digits, underscore).

    `fullmatch`, not `match` — Python's `$` matches just before a trailing
    newline, so `match()` would let a name like "AB.TTF\\n" through."""
    name = PurePosixPath(filename or "").name.upper()
    return name if FONT_NAME_RE.fullmatch(name) else None


def _person_display(preferred: str | None, first: str | None, last: str | None) -> str | None:
    full = " ".join(p for p in (first, last) if p).strip()
    return preferred or full or None


async def _fonts_used_by(db: DbSession) -> dict[str, list[LabelFontUsedByOut]]:
    """Map upper-cased `E:<NAME>` references found in active code templates
    → the templates that carry them (templates are few; a scan is fine)."""
    rows = (await db.execute(
        select(LabelTemplate.id, LabelTemplate.name, LabelTemplate.code)
        .where(LabelTemplate.is_active == True, LabelTemplate.code.isnot(None)))).all()  # noqa: E712
    out: dict[str, list[LabelFontUsedByOut]] = {}
    for tpl_id, tpl_name, code in rows:
        for ref in re.findall(r"E:([A-Z0-9_]{1,8}\.TTF)", (code or "").upper()):
            out.setdefault(ref, []).append(LabelFontUsedByOut(template_id=tpl_id, template_name=tpl_name))
    return out


def _font_out(font: LabelFont, uploader: str | None, used_by: list[LabelFontUsedByOut]) -> LabelFontOut:
    return LabelFontOut(
        id=font.id, name=font.name, display_name=font.display_name, size_bytes=font.size_bytes,
        content_type=font.content_type, uploaded_by=font.uploaded_by, uploaded_by_name=uploader,
        created_at=font.created_at, used_by=used_by, family=font.family, weight=font.weight,
        resident=font.resident, source_url=font.source_url)


async def _font_or_404(db: DbSession, font_id: uuid.UUID) -> LabelFont:
    font = await db.get(LabelFont, font_id)
    if font is None or font.deleted_at is not None:
        raise _err(404, "font_not_found")
    return font


@router.get("/fonts", response_model=list[LabelFontOut])
async def list_label_fonts(
    db: DbSession, _actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelFontOut]:
    rows = (await db.execute(
        select(LabelFont, Person.preferred_name, Person.first_name, Person.last_name)
        .outerjoin(Person, Person.id == LabelFont.uploaded_by)
        .where(LabelFont.deleted_at.is_(None))
        .order_by(natural(LabelFont.name)))).all()
    used = await _fonts_used_by(db)
    return [_font_out(f, _person_display(p, fn, ln), used.get(f.name.upper(), []))
            for f, p, fn, ln in rows]


async def _active_font_id(db: DbSession, name: str) -> uuid.UUID | None:
    """The id of a non-deleted LabelFont named `name`, or None. Pulled out
    of upload_label_font so a test can monkeypatch it to force the
    duplicate-name race (see test_upload_race_reports_font_name_taken)."""
    return await db.scalar(select(LabelFont.id).where(
        LabelFont.name == name, LabelFont.deleted_at.is_(None)))


@router.post("/fonts", response_model=LabelFontOut, status_code=201)
async def upload_label_font(
    db: DbSession,
    file: Annotated[UploadFile, File()],
    name: Annotated[str | None, Form()] = None,
    actor: AuthContext = require_permission("labels", "add"),
) -> LabelFontOut:
    object_name = font_object_name(name) if name else font_object_name(file.filename)
    if object_name is None:
        raise _err(422, "invalid_font_name")
    data = await file.read()
    if len(data) == 0:
        raise _err(422, "empty_file")
    if len(data) > MAX_FONT_BYTES:
        raise _err(413, "file_too_large")
    if not data.startswith(TRUETYPE_MAGICS):
        raise _err(422, "not_a_truetype_font")
    uploader = _person_display(actor.person.preferred_name, actor.person.first_name,
                               actor.person.last_name)
    # The resident font's row exists without a file until its library
    # copy arrives (for its metrics): the upload fills that row. Locked, so
    # a second concurrent upload finds it filled and gets the 409 below.
    fileless = await db.scalar(
        select(LabelFont).where(LabelFont.name == object_name, LabelFont.deleted_at.is_(None),
                                LabelFont.resident.is_(True), LabelFont.storage_key.is_(None))
        .with_for_update())
    if fileless is not None:
        before = snapshot(fileless, FONT_FIELDS)
        key = new_storage_key()
        await put_object(key, data, "font/ttf")
        try:
            fileless.storage_key, fileless.size_bytes = key, len(data)
            fileless.content_type, fileless.uploaded_by = "font/ttf", actor.person.id
            audit(db, actor_id=actor.person.id, entity_type="label_font",
                  entity_id=str(fileless.id), action="update",
                  changes=diff(before, snapshot(fileless, FONT_FIELDS)))
            await db.commit()
        except Exception:
            # as on the create path: the key was never persisted, so nothing
            # else can reach the blob; best-effort remove it
            await db.rollback()
            try:
                await delete_object(key)
            except Exception:
                pass
            raise
        await db.refresh(fileless)
        used = await _fonts_used_by(db)
        return _font_out(fileless, uploader, used.get(object_name, []))
    if await _active_font_id(db, object_name) is not None:
        raise _err(409, "font_name_taken")

    # A file under one of the builder's object names joins that family (and
    # the resident name stays resident, so it is never served).
    family, weight = object_family(object_name) or (None, None)
    key = new_storage_key()
    await put_object(key, data, "font/ttf")
    font = LabelFont(name=object_name,
                     display_name=(family_display_name(family, weight) if family
                                   else file.filename or object_name),
                     storage_key=key, size_bytes=len(data), content_type="font/ttf",
                     uploaded_by=actor.person.id, family=family, weight=weight,
                     resident=bool(family and FAMILIES[family]["resident"]))
    try:
        db.add(font)
        await db.flush()
        audit(db, actor_id=actor.person.id, entity_type="label_font", entity_id=str(font.id),
              action="create", changes=diff({}, snapshot(font, FONT_FIELDS)))
        await db.commit()
    except IntegrityError as exc:
        # Defense in depth against the label_fonts_name_active_idx unique
        # index: the pre-check above and this INSERT aren't atomic, so two
        # concurrent uploads of the same name can both pass the check and
        # race here. Roll back, best-effort clean up the blob we already
        # wrote (its key was never persisted, so nothing else can reach
        # it), and report the same clean 409 as the pre-check.
        await db.rollback()
        try:
            await delete_object(key)
        except Exception:
            pass
        raise _err(409, "font_name_taken") from exc
    await db.refresh(font)
    used = await _fonts_used_by(db)
    return _font_out(font, uploader, used.get(object_name, []))


@router.delete("/fonts/{font_id}", status_code=204)
async def delete_label_font(
    font_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "delete"),
) -> None:
    font = await _font_or_404(db, font_id)
    font.deleted_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="label_font", entity_id=str(font.id),
          action="delete", changes={"name": {"from": font.name, "to": None}})
    await db.commit()


@router.get("/fonts/{font_id}/content")
async def label_font_content(
    font_id: uuid.UUID, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> Response:
    """The raw TTF bytes — the browser pushes them to the printer over
    WebUSB (`~DY`), so it needs the bytes, not a presigned URL. Never the
    resident font: Zebra's commercial file stays off browsers (403
    `font_not_servable`)."""
    font = await _font_or_404(db, font_id)
    if font.resident or resident_object(font.name):
        raise _err(403, "font_not_servable")
    data = await get_object(font.storage_key)
    return Response(content=data, media_type=font.content_type,
                    headers={"Content-Disposition": f'attachment; filename="{font.name}"'})


# Metrics per stored file, read once: (font id, storage key, size) → metrics.
# Fonts are few; the cap only bounds a pathological library.
_METRICS_CACHE: dict[tuple[uuid.UUID, str, int], dict] = {}
_METRICS_CACHE_MAX = 128


@router.get("/fonts/{font_id}/metrics", response_model=LabelFontMetricsOut)
async def label_font_metrics(
    font_id: uuid.UUID, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> dict:
    """Glyph metrics for the builder canvas (labels/font_metrics.py), read
    from the library file with fontTools. The resident font has them only
    once its library copy is uploaded (else 404 `no_font_file`); a file
    fontTools can't read is 422 `unreadable_font`."""
    font = await _font_or_404(db, font_id)
    if not font.storage_key:
        raise _err(404, "no_font_file")
    cache_key = (font.id, font.storage_key, font.size_bytes)
    cached = _METRICS_CACHE.get(cache_key)
    if cached is None:
        try:
            cached = font_metrics(await get_object(font.storage_key))
        except UnreadableFont as exc:
            raise _err(422, "unreadable_font") from exc
        if len(_METRICS_CACHE) >= _METRICS_CACHE_MAX:
            _METRICS_CACHE.clear()
        _METRICS_CACHE[cache_key] = cached
    return cached
