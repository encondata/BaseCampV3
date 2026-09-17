"""Labels: vocabularies, placeholder catalog, templates, compile/preview,
and the label-generation queue (runs, preview, generated labels).

Reads gate on labels:view; template mutations on labels:add/change/delete;
vocab + placeholder mutations are devtools-gated (god-only), matching the
rest of the Variables surface. Of the generate-labels routes, list/get/
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

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    GeneratedLabelOut,
    GeneratedLabelBundleItemOut, GeneratedLabelBundleOut,
    LabelCompileIn, LabelCompileOut,
    LabelFontOut, LabelFontUsedByOut,
    LabelGeneratePreviewCandidateOut, LabelGeneratePreviewInitiativeOut,
    LabelGeneratePreviewOut, LabelGeneratePreviewTemplateOut, LabelGeneratePreviewTypeOut,
    LabelPlaceholderCreateIn, LabelPlaceholderOut, LabelPlaceholderUpdateIn,
    LabelRunCreateIn, LabelRunOut,
    LabelTemplateCreateIn, LabelTemplateOut, LabelTemplateUpdateIn,
    LabelVocabCreateIn, LabelVocabOut, LabelVocabUpdateIn,
    LabelZplPreviewIn,
)
from serversherpa.db.models import (
    Asset, Client, Container, GeneratedLabel, Initiative, InitiativeAsset,
    LabelFont, LabelGenerationRun, LabelPlaceholder, LabelTemplate, LabelTemplateSite,
    LabelVocab, Person, Site,
)
from serversherpa.labels import labelary
from serversherpa.labels.compile import UnsupportedLanguage, compile_design
from serversherpa.labels.generate import InvalidLabelTypes, InvalidTemplates, RunActive, entity_for_type, enqueue_run
from serversherpa.labels.generate.select import candidate_templates
from serversherpa.labels.model import DesignError, parse_design
from serversherpa.labels.tokens import apply_placeholders
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import delete_object, get_object, put_object

router = APIRouter(prefix="/labels", tags=["labels"])

VOCAB_FIELDS = ["label", "description", "meta", "sort_order", "is_active"]
FONT_FIELDS = ["name", "display_name", "storage_key", "size_bytes",
              "content_type", "uploaded_by"]


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


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
    q = select(LabelVocab).order_by(LabelVocab.kind, LabelVocab.sort_order,
                                    LabelVocab.key)
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
    body: LabelVocabCreateIn, db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> LabelVocabOut:
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


@router.get("/placeholders", response_model=list[LabelPlaceholderOut])
async def list_placeholders(
    db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelPlaceholderOut]:
    rows = (await db.execute(select(LabelPlaceholder).order_by(
        LabelPlaceholder.sort_order, LabelPlaceholder.key))).scalars().all()
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


TEMPLATE_FIELDS = ["name", "description", "label_type", "size_key",
                   "dpi_key", "language_key", "design", "code", "is_active",
                   "generation_rules"]

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


@router.get("/templates", response_model=list[LabelTemplateOut])
async def list_templates(
    db: DbSession, label_type: str | None = None, size_key: str | None = None,
    dpi_key: str | None = None, language_key: str | None = None,
    active: bool | None = None, site_id: uuid.UUID | None = None,
    _actor: AuthContext = require_permission("labels", "view"),
) -> list:
    q = select(LabelTemplate).order_by(LabelTemplate.name)
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
        item = LabelTemplateOut.model_validate(r)
        item.site_ids = site_map.get(r.id, [])
        out.append(item)
    return out


@router.get("/templates/{template_id}", response_model=LabelTemplateOut)
async def get_template(
    template_id: uuid.UUID, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> LabelTemplateOut:
    row = (await db.execute(select(LabelTemplate)
        .options(selectinload(LabelTemplate.site_links))
        .where(LabelTemplate.id == template_id))).scalar_one_or_none()
    if row is None:
        raise _err(404, "unknown_template")
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = [l.site_id for l in row.site_links]
    return item


@router.post("/templates", response_model=LabelTemplateOut, status_code=201)
async def create_template(
    body: LabelTemplateCreateIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "add"),
) -> LabelTemplateOut:
    if (body.kind == "design") != (body.design is not None) or \
       (body.kind == "code") != (body.code is not None):
        raise _err(422, "bad_payload",
                   message="kind must match exactly one of design/code")
    values = body.model_dump()
    site_ids = values.pop("site_ids", None) or []
    site_ids = list(dict.fromkeys(site_ids))
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
    row = LabelTemplate(**values)
    db.add(row)
    await db.flush()  # server-generated UUID for the audit row
    for sid in site_ids:
        db.add(LabelTemplateSite(template_id=row.id, site_id=sid))
    changes = diff({}, snapshot(row, TEMPLATE_FIELDS))
    if site_ids:
        changes["site_ids"] = {"from": [], "to": sorted(str(s) for s in site_ids)}
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="create", changes=changes)
    await db.commit()
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = site_ids
    return item


@router.patch("/templates/{template_id}", response_model=LabelTemplateOut)
async def update_template(
    template_id: uuid.UUID, body: LabelTemplateUpdateIn, db: DbSession,
    actor: AuthContext = require_permission("labels", "change"),
) -> LabelTemplateOut:
    row = (await db.execute(select(LabelTemplate)
        .options(selectinload(LabelTemplate.site_links))
        .where(LabelTemplate.id == template_id))).scalar_one_or_none()
    if row is None:
        raise _err(404, "unknown_template")
    data = body.model_dump(exclude_unset=True)
    new_site_ids = data.pop("site_ids", None)
    if new_site_ids is not None:
        new_site_ids = list(dict.fromkeys(new_site_ids))
    # design/code nullability is owned by kind; other fields reject null
    for f, v in data.items():
        if v is None and f not in ("design", "code"):
            raise _err(422, "bad_field", field=f)
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
    changes = diff(before, snapshot(row, TEMPLATE_FIELDS))
    if new_site_ids is not None:
        await _check_site_ids(db, new_site_ids)
        current = sorted(str(l.site_id) for l in row.site_links)
        incoming = sorted(str(s) for s in new_site_ids)
        if current != incoming:
            changes["site_ids"] = {"from": current, "to": incoming}
            row.site_links = [LabelTemplateSite(template_id=row.id,
                                                site_id=sid)
                              for sid in new_site_ids]
    if changes:
        row.version += 1
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="update", changes=changes)
    await db.commit()
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = [l.site_id for l in row.site_links]
    return item


async def _sample_values(db: DbSession) -> dict[str, str]:
    rows = (await db.execute(select(LabelPlaceholder))).scalars().all()
    return {r.key: r.sample_value for r in rows}


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
) -> LabelTemplateOut:
    row = (await db.execute(select(LabelTemplate)
        .options(selectinload(LabelTemplate.site_links))
        .where(LabelTemplate.id == template_id))).scalar_one_or_none()
    if row is None:
        raise _err(404, "unknown_template")
    if row.kind != "design":
        raise _err(409, "not_a_design_template")
    code = await _compile_design(db, row.design, row.size_key, row.dpi_key,
                                 row.language_key, None)
    row.kind = "code"
    row.code = code
    row.design = None
    row.version += 1
    row.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="label_template",
          entity_id=str(row.id), action="convert_to_code",
          changes={"kind": {"from": "design", "to": "code"}})
    await db.commit()
    item = LabelTemplateOut.model_validate(row)
    item.site_ids = [l.site_id for l in row.site_links]
    return item


_DPMM = {203: 8, 300: 12}


@router.post("/preview/zpl")
async def preview_zpl(
    body: LabelZplPreviewIn, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> Response:
    size = await db.get(LabelVocab, ("size", body.size_key))
    dpi = await db.get(LabelVocab, ("dpi", body.dpi_key))
    if size is None or dpi is None:
        raise _err(404, "unknown_vocab")
    dpmm = _DPMM.get(dpi.meta["dots"])
    if dpmm is None:
        raise _err(422, "unsupported_dpi", dots=dpi.meta["dots"])
    try:
        png = await labelary.render_png(
            body.zpl, size.meta["width_in"], size.meta["height_in"], dpmm)
    except Exception:
        raise _err(502, "labelary_unavailable") from None
    return Response(png, media_type="image/png")


@router.delete("/templates/{template_id}", status_code=204)
async def deactivate_template(
    template_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "delete"),
) -> None:
    row = await db.get(LabelTemplate, template_id)
    if row is None:
        raise _err(404, "unknown_template")
    if row.is_active:
        row.is_active = False
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="label_template",
              entity_id=str(row.id), action="deactivate",
              changes={"name": row.name})
    await db.commit()


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
        progress_pct=progress_pct, template_overrides=dict(run.template_overrides or {}))


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
            template_overrides={k: str(v) for k, v in body.templates.items()})
    except InvalidLabelTypes as exc:
        raise _err(422, "invalid_label_types", problems=exc.problems) from exc
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
                   "label_types": {"from": [], "to": list(run.label_types)}})
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
    initiative_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "view"),
) -> LabelGeneratePreviewOut:
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

    # Same site preference as the runner: destination, else origin.
    template_site_id = ini.destination_site_id or ini.origin_site_id
    type_rows = (await db.execute(
        select(LabelVocab).where(LabelVocab.kind == "type", LabelVocab.is_active == True)  # noqa: E712
        .order_by(LabelVocab.sort_order, LabelVocab.key))).scalars().all()

    types: list[LabelGeneratePreviewTypeOut] = []
    for vocab in type_rows:
        candidates = await candidate_templates(db, vocab.key, template_site_id)
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
                   GeneratedLabel.label_type == vocab.key))).all()
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
            destination_name=destination_name, asset_count=asset_count),
        types=types, active_run_id=active_run_id)


@router.get("/generated", response_model=list[GeneratedLabelOut])
async def list_generated_labels(
    db: DbSession, initiative_id: uuid.UUID | None = None,
    label_type: str | None = None, entity_id: uuid.UUID | None = None,
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
            template_version=template_version, generated_at=gl.generated_at,
            stale=gl.stale, code=gl.code))
    return out


@router.get("/generated/bundle", response_model=GeneratedLabelBundleOut)
async def get_generated_label_bundle(
    db: DbSession, initiative_id: uuid.UUID, label_type: str,
    actor: AuthContext = require_permission("labels", "view"),
) -> GeneratedLabelBundleOut:
    """Print Labels' data source: every label of one type on one
    initiative — asset or container, whichever `label_type` maps to —
    with the language/size/dpi keys the page needs to decide what a
    Zebra printer can take. Unknown/archived/out-of-scope initiatives
    read as 404 like the preview endpoint."""
    ini = await _scoped_initiative(db, actor, initiative_id)
    entity_type = entity_for_type(label_type)
    name_col = Container.name if entity_type == "container" else Asset.name
    query = (select(GeneratedLabel, LabelTemplate.name, name_col)
             .join(LabelTemplate, LabelTemplate.id == GeneratedLabel.template_id)
             .where(GeneratedLabel.initiative_id == ini.id,
                    GeneratedLabel.entity_type == entity_type,
                    GeneratedLabel.label_type == label_type)
             .order_by(GeneratedLabel.generated_at, GeneratedLabel.id))
    if entity_type == "container":
        query = query.outerjoin(Container, Container.id == GeneratedLabel.entity_id)
    else:
        query = query.outerjoin(Asset, Asset.id == GeneratedLabel.entity_id)
    rows = (await db.execute(query)).all()
    return GeneratedLabelBundleOut(
        initiative_id=ini.id, label_type=label_type, fetched_at=datetime.now(UTC),
        labels=[
            GeneratedLabelBundleItemOut(
                id=gl.id, entity_type=gl.entity_type, entity_id=gl.entity_id,
                entity_name=entity_name,
                template_id=gl.template_id, template_name=template_name,
                template_version=gl.template_version, language_key=gl.language_key,
                size_key=gl.size_key, dpi_key=gl.dpi_key, stale=gl.stale,
                generated_at=gl.generated_at, code=gl.code)
            for gl, template_name, entity_name in rows])


# ── font library (Labels → Printers › Install Fonts) ─────────────────

FONT_NAME_RE = re.compile(r"^[A-Z0-9_]{1,8}\.TTF$")
MAX_FONT_BYTES = 2 * 1024 * 1024
TRUETYPE_MAGICS = (b"\x00\x01\x00\x00", b"true")


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
        created_at=font.created_at, used_by=used_by)


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
        .order_by(LabelFont.name))).all()
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
    if await _active_font_id(db, object_name) is not None:
        raise _err(409, "font_name_taken")

    key = f"label-fonts/{uuid.uuid4()}.ttf"
    await put_object(key, data, "font/ttf")
    font = LabelFont(name=object_name, display_name=file.filename or object_name,
                     storage_key=key, size_bytes=len(data), content_type="font/ttf",
                     uploaded_by=actor.person.id)
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
    uploader = _person_display(actor.person.preferred_name, actor.person.first_name,
                               actor.person.last_name)
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
    WebUSB (`~DY`), so it needs the bytes, not a presigned URL."""
    font = await _font_or_404(db, font_id)
    data = await get_object(font.storage_key)
    return Response(content=data, media_type=font.content_type,
                    headers={"Content-Disposition": f'attachment; filename="{font.name}"'})
