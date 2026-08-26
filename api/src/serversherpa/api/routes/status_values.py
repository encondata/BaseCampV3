"""Status values — one discriminated vocabulary for every entity's status.

Reads follow the owning entity's view permission (a site picker needs the
labels). Writes are developer-only: the *value* on a record is normal data,
but the *vocabulary* is not."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import column, func, select, table, text as sqla_text

from serversherpa.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from serversherpa.api.schemas import StatusValueCreateIn, StatusValueOut, StatusValueUpdateIn
from serversherpa.db.models import StatusValue
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.status.registry import STATUS_REGISTRY, StatusRecordType

router = APIRouter(prefix="/status-values", tags=["status-values"])

STATUS_FIELDS = ["label", "description", "color", "sort_order", "is_active",
                  "progress_weight"]

# every mutable column is NOT NULL (0012_status_values.py:33-38), but the
# update schema types them `X | None` and exclude_unset INCLUDES an explicitly
# sent null — so `{"description": null}` would setattr None and surface as an
# unhandled IntegrityError. Pre-checking mirrors update_site (sites.py:251-253).
# The predicate is `is None`, NOT sites' falsy `not data[field]`: is_active=False
# and sort_order=0 are legitimate values that must pass through.
NON_NULLABLE_STATUS_FIELDS = ("label", "description", "color", "sort_order",
                              "is_active")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _record_type(record_type: str) -> StatusRecordType:
    rt = STATUS_REGISTRY.get(record_type)
    if rt is None:
        raise _err(422, "unknown_record_type")
    return rt


def _validate_progress_weight(value: object) -> int | None:
    """None (excluded) or an int 0-100; anything else — out of range, a
    float, a numeric string, a bool — is `invalid_progress_weight`. Typed
    loosely (schemas.py: `Any`) so every bad shape lands here instead of
    pydantic's own coercion error."""
    if value is None:
        return None
    # bool is an int subclass — True/False must not slip through as 1/0
    if isinstance(value, bool) or not isinstance(value, int):
        raise _err(422, "invalid_progress_weight")
    if not (0 <= value <= 100):
        raise _err(422, "invalid_progress_weight")
    return value


async def _usage_counts(db: DbSession, rt: StatusRecordType) -> dict[str, int]:
    """Count referencing rows per key, summed across every source table.
    Table/column come from the frozen code registry, never from user
    input."""
    totals: dict[str, int] = {}
    for tbl, col in rt.sources:
        if rt.array:
            rows = (await db.execute(sqla_text(
                f"SELECT k, count(*) FROM {tbl}, unnest({col}) AS k "
                f"GROUP BY k"))).all()
        else:
            t = table(tbl, column(col))
            rows = (await db.execute(
                select(t.c[col], func.count())
                .group_by(t.c[col]))).all()
        for key, n in rows:
            if key is not None:
                totals[key] = totals.get(key, 0) + n
    return totals


@router.get("", response_model=list[StatusValueOut])
async def list_status_values(
    db: DbSession,
    actor: CurrentUser,
    record_type: str | None = None,
) -> list[StatusValueOut]:
    if record_type is not None:
        rt = _record_type(record_type)
        if not actor.access.can(rt.resource, "view"):
            raise _err(403, "forbidden")
        rows = (await db.scalars(
            select(StatusValue)
            .where(StatusValue.record_type == rt.id,
                   StatusValue.is_active.is_(True))
            .order_by(StatusValue.sort_order, StatusValue.label))).all()
        return [StatusValueOut.model_validate(r) for r in rows]

    # the unfiltered listing spans every record type — that is the Variables
    # page's view, and it is developer-only
    if not actor.access.can("devtools", "view"):
        raise _err(403, "forbidden")
    rows = (await db.scalars(
        select(StatusValue).order_by(
            StatusValue.record_type, StatusValue.sort_order,
            StatusValue.label))).all()
    counts = {rt.id: await _usage_counts(db, rt)
              for rt in STATUS_REGISTRY.values()}
    out = []
    for r in rows:
        item = StatusValueOut.model_validate(r)
        item.usage_count = counts.get(r.record_type, {}).get(r.key, 0)
        out.append(item)
    return out


@router.post("", response_model=StatusValueOut, status_code=201)
async def create_status_value(
    body: StatusValueCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> StatusValueOut:
    rt = _record_type(body.record_type)
    existing = await db.get(StatusValue, (rt.id, body.key))
    if existing is not None:
        raise _err(409, "status_value_exists")
    weight = _validate_progress_weight(body.progress_weight)
    row = StatusValue(
        record_type=rt.id, key=body.key, label=body.label,
        description=body.description, color=body.color,
        sort_order=body.sort_order, is_active=True,
        progress_weight=weight,
        updated_at=datetime.now(UTC),
    )
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="status_value",
          entity_id=f"{rt.id}:{body.key}", action="create",
          changes=diff({}, snapshot(row, STATUS_FIELDS)))
    await db.commit()
    return StatusValueOut.model_validate(row)


@router.patch("/{record_type}/{key}", response_model=StatusValueOut)
async def update_status_value(
    record_type: str,
    key: str,
    body: StatusValueUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> StatusValueOut:
    rt = _record_type(record_type)
    row = await db.get(StatusValue, (rt.id, key))
    if row is None:
        raise _err(404, "status_value_not_found")
    data = body.model_dump(exclude_unset=True)
    # reject an explicit null up front rather than letting it reach the UPDATE
    for field in NON_NULLABLE_STATUS_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    # progress_weight IS nullable (null = excluded) — validate shape/range
    # rather than reject null outright, unlike the fields above
    if "progress_weight" in data:
        data["progress_weight"] = _validate_progress_weight(data["progress_weight"])
    before = snapshot(row, STATUS_FIELDS)
    # no in-loop guard: `value is not None` would silently DROP is_active=False
    # (the whole retirement mechanism). exclude_unset already means "the caller
    # named this field", and the null case is handled by the pre-check above.
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, STATUS_FIELDS))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="status_value",
              entity_id=f"{rt.id}:{key}", action="update", changes=changes)
    await db.commit()
    return StatusValueOut.model_validate(row)
