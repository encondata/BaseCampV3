"""Labels: vocabularies, placeholder catalog, templates, compile/preview.

Reads gate on labels:view; template mutations on labels:add/change/delete;
vocab + placeholder mutations are devtools-gated (god-only), matching the
rest of the Variables surface. All mutations audit into the caller's txn.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    LabelPlaceholderCreateIn, LabelPlaceholderOut, LabelPlaceholderUpdateIn,
    LabelVocabCreateIn, LabelVocabOut, LabelVocabUpdateIn,
)
from serversherpa.db.models import LabelPlaceholder, LabelTemplate, LabelVocab
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/labels", tags=["labels"])

VOCAB_FIELDS = ["label", "description", "meta", "sort_order", "is_active"]

# which label_templates column each vocab kind is referenced from
_KIND_COLUMN = {"type": "label_type", "size": "size_key",
                "dpi": "dpi_key", "language": "language_key"}


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
