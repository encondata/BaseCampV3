"""Labels: vocabularies, placeholder catalog, templates, compile/preview.

Reads gate on labels:view; template mutations on labels:add/change/delete;
vocab + placeholder mutations are devtools-gated (god-only), matching the
rest of the Variables surface. All mutations audit into the caller's txn.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    LabelCompileIn, LabelCompileOut,
    LabelPlaceholderCreateIn, LabelPlaceholderOut, LabelPlaceholderUpdateIn,
    LabelTemplateCreateIn, LabelTemplateOut, LabelTemplateUpdateIn,
    LabelVocabCreateIn, LabelVocabOut, LabelVocabUpdateIn,
    LabelZplPreviewIn,
)
from serversherpa.db.models import (
    LabelPlaceholder, LabelTemplate, LabelTemplateSite, LabelVocab, Site,
)
from serversherpa.labels import labelary
from serversherpa.labels.brother_escp import compile_escp
from serversherpa.labels.brother_ptouch import compile_ptouch
from serversherpa.labels.model import DesignError, parse_design
from serversherpa.labels.tokens import apply_placeholders
from serversherpa.labels.zpl import compile_zpl
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/labels", tags=["labels"])

VOCAB_FIELDS = ["label", "description", "meta", "sort_order", "is_active"]


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


async def _vocab_usage(db: DbSession) -> dict[tuple[str, str], int]:
    """(kind, key) -> count of label_templates referencing it."""
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
    usage = await _vocab_usage(db)
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
                   "dpi_key", "language_key", "design", "code", "is_active"]

_TEMPLATE_VOCAB = (("type", "label_type"), ("size", "size_key"),
                   ("dpi", "dpi_key"), ("language", "language_key"))


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
    try:
        design = parse_design({
            **body.design,
            "size": {"w": size.meta["width_in"], "h": size.meta["height_in"]},
        })
    except DesignError as e:
        raise _err(422, "bad_design", problems=e.problems) from e

    if lang.key == "zpl":
        out = compile_zpl(design, dpi.meta["dots"], subs)
    elif lang.key == "escp":
        out = compile_escp(design, subs)
    elif lang.key == "ptouch":
        out = compile_ptouch(design, subs)
    else:
        raise _err(422, "unsupported_language", key=lang.key)
    return LabelCompileOut(code=out)


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
