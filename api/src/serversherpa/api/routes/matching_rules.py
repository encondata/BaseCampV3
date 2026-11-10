"""Developer › Matching rules: the versions of each place's flow (drafts,
standby, deploy, rollback). Under the `devtools` resource like the rest of
the Developer area: view for reads, change for every write."""

import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext, DbSession, client_ip, require_permission
from serversherpa.db.models import Person
from serversherpa.matching_rules import versions
from serversherpa.matching_rules.check import (
    MAX_TEST_ASSETS,
    CheckResult,
    check_against,
    load_test_set,
    move_targets,
    test_set_targets,
    uses_client,
)
from serversherpa.matching_rules.engine import JS_WHITESPACE, run_flow
from serversherpa.matching_rules.flow import Flow, Place
from serversherpa.matching_rules.models import (
    MatchingRuleVersion,
    MatchingTestAsset,
    MatchingTestRow,
)
from serversherpa.matching_rules.schemas import (
    CheckIn,
    CheckOut,
    CheckSummaryOut,
    RunOut,
    TestAssetIn,
    TestAssetOut,
    TestRowIn,
    TestRowOut,
    TestRunIn,
    VersionCreateIn,
    VersionDetailOut,
    VersionOut,
    VersionUpdateIn,
    check_out,
    current_summary,
    run_out,
)
from serversherpa.services.audit import audit

router = APIRouter(prefix="/devtools/matching-rules", tags=["devtools"])

# module-level so the route signatures stay free of calls in defaults
_CAN_VIEW = require_permission("devtools", "view")
_CAN_CHANGE = require_permission("devtools", "change")

_ENTITY = "matching_rule_version"


@contextmanager
def _refusals() -> Iterator[None]:
    try:
        yield
    except versions.MatchingError as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, **exc.extra}) from None


def _run(version: MatchingRuleVersion, assets: Sequence[MatchingTestAsset]) -> CheckResult:
    """Re-run a version against today's test set."""
    flow = Flow.model_validate(version.flow)
    return check_against(flow, version.place, assets)


async def _names(db: AsyncSession, person_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not person_ids:
        return {}
    people = (await db.execute(select(Person).where(Person.id.in_(person_ids)))).scalars()
    return {p.id: p.display_name for p in people}


def _version_fields(
    v: MatchingRuleVersion,
    res: CheckResult,
    *,
    names: dict[uuid.UUID, str],
    numbers: dict[uuid.UUID, int],
) -> dict:
    return {
        "id": v.id,
        "place": v.place,
        "version": v.version,
        "state": v.state,
        "based_on_version": numbers.get(v.based_on_id) if v.based_on_id else None,
        "saved_by_name": names.get(v.updated_by) if v.updated_by else None,
        "saved_at": v.updated_at,
        "state_changed_at": v.state_changed_at,
        "checked": CheckSummaryOut.model_validate(v.checked) if v.checked else None,
        "current": current_summary(res),
    }


async def _detail(db: AsyncSession, v: MatchingRuleVersion) -> VersionDetailOut:
    res = _run(v, await load_test_set(db))
    numbers: dict[uuid.UUID, int] = {}
    if v.based_on_id is not None:
        base = await db.get(MatchingRuleVersion, v.based_on_id)
        if base is not None:
            numbers[base.id] = base.version
    names = await _names(db, {v.updated_by} if v.updated_by else set())
    return VersionDetailOut(
        **_version_fields(v, res, names=names, numbers=numbers),
        flow=Flow.model_validate(v.flow),
        check=check_out(res),
    )


@router.get("/versions", response_model=list[VersionOut])
async def list_versions(
        place: Place, db: DbSession, actor: AuthContext = _CAN_VIEW) -> list[VersionOut]:
    rows = await versions.list_versions(db, place)
    assets = await load_test_set(db)
    names = await _names(db, {v.updated_by for v in rows if v.updated_by})
    numbers = {v.id: v.version for v in rows}  # a draft is based on a version of its place
    return [VersionOut(**_version_fields(v, _run(v, assets), names=names, numbers=numbers))
            for v in rows]


@router.get("/versions/{version_id}", response_model=VersionDetailOut)
async def get_version(
        version_id: uuid.UUID, db: DbSession,
        actor: AuthContext = _CAN_VIEW) -> VersionDetailOut:
    with _refusals():
        v = await versions.get_version(db, version_id)
    return await _detail(db, v)


@router.post("/versions", response_model=VersionDetailOut, status_code=201)
async def create_version(
        body: VersionCreateIn, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> VersionDetailOut:
    with _refusals():
        v = await versions.create_draft(
            db, place=body.place, flow=body.flow, based_on_id=body.based_on_id,
            actor_id=actor.person.id)
    audit(db, actor_id=actor.person.id, entity_type=_ENTITY, entity_id=str(v.id),
          action="matching_rules.save",
          changes={"place": v.place, "version": v.version, "created": True},
          ip=client_ip(request))
    await db.commit()
    return await _detail(db, v)


@router.put("/versions/{version_id}", response_model=VersionDetailOut)
async def update_version(
        version_id: uuid.UUID, body: VersionUpdateIn, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> VersionDetailOut:
    with _refusals():
        v = await versions.get_version(db, version_id)
        await versions.update_draft(db, v, body.flow, actor.person.id)
    audit(db, actor_id=actor.person.id, entity_type=_ENTITY, entity_id=str(v.id),
          action="matching_rules.save",
          changes={"place": v.place, "version": v.version, "created": False},
          ip=client_ip(request))
    await db.commit()
    return await _detail(db, v)


@router.post("/versions/{version_id}/standby", response_model=VersionDetailOut)
async def standby_version(
        version_id: uuid.UUID, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> VersionDetailOut:
    with _refusals():
        v = await versions.make_standby(db, version_id, actor.person.id)
    audit(db, actor_id=actor.person.id, entity_type=_ENTITY, entity_id=str(v.id),
          action="matching_rules.standby",
          changes={"place": v.place, "version": v.version},
          ip=client_ip(request))
    await db.commit()
    return await _detail(db, v)


@router.post("/versions/{version_id}/deploy", response_model=VersionDetailOut)
async def deploy_version(
        version_id: uuid.UUID, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> VersionDetailOut:
    with _refusals():
        v, retired = await versions.deploy(db, version_id, actor.person.id)
    audit(db, actor_id=actor.person.id, entity_type=_ENTITY, entity_id=str(v.id),
          action="matching_rules.deploy",
          changes={"place": v.place, "version": v.version, "retired_version": retired},
          ip=client_ip(request))
    await db.commit()
    return await _detail(db, v)


@router.post("/versions/{version_id}/rollback", response_model=VersionDetailOut)
async def rollback_version(
        version_id: uuid.UUID, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> VersionDetailOut:
    with _refusals():
        v, retired = await versions.rollback(db, version_id, actor.person.id)
    audit(db, actor_id=actor.person.id, entity_type=_ENTITY, entity_id=str(v.id),
          action="matching_rules.rollback",
          changes={"place": v.place, "version": v.version, "retired_version": retired},
          ip=client_ip(request))
    await db.commit()
    return await _detail(db, v)


# ── check and test run: pure reads, nothing stored ───────────────────

@router.post("/check", response_model=CheckOut)
async def check_draft(body: CheckIn, db: DbSession, actor: AuthContext = _CAN_VIEW) -> CheckOut:
    """Check a flow that may not be saved yet."""
    return check_out(check_against(body.flow, body.place, await load_test_set(db)))


@router.post("/test-run", response_model=RunOut)
async def test_run(body: TestRunIn, db: DbSession, actor: AuthContext = _CAN_VIEW) -> RunOut:
    """Run a value through a flow and trace every step. Writes and commits nothing."""
    if not body.value.strip(JS_WHITESPACE):
        raise HTTPException(status_code=422, detail={"code": "value_required"})
    if body.against == "move":
        if body.initiative_id is None:
            raise HTTPException(status_code=422, detail={"code": "initiative_required"})
        targets = await move_targets(
            db, body.initiative_id, with_client=uses_client(body.flow))
    else:
        targets = test_set_targets(await load_test_set(db))
    return run_out(run_flow(body.flow, body.value, targets))


# ── the test set ─────────────────────────────────────────────────────

_ASSET_ENTITY = "matching_test_asset"
_ROW_ENTITY = "matching_test_row"
_TAG_KEY = "matching_test_assets_asset_tag_key"
_VALUE_KEY = "matching_test_rows_place_value_key"


def _violated(exc: IntegrityError) -> str | None:
    """The constraint an IntegrityError broke (it sits on asyncpg's exception)."""
    inner = exc.orig.__cause__ if exc.orig is not None else None
    return getattr(inner, "constraint_name", None)


async def _asset_or_404(db: AsyncSession, asset_id: uuid.UUID) -> MatchingTestAsset:
    asset = await db.get(MatchingTestAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail={"code": "test_asset_not_found"})
    return asset


async def _row_or_404(db: AsyncSession, row_id: uuid.UUID) -> MatchingTestRow:
    row = await db.get(MatchingTestRow, row_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "test_row_not_found"})
    return row


async def _save(db: AsyncSession, key: str, code: str) -> None:
    """Commit, turning a break of the unique constraint `key` into 409 `code`."""
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _violated(exc) != key:
            raise
        raise HTTPException(status_code=409, detail={"code": code}) from None


def _asset_out(asset: MatchingTestAsset) -> TestAssetOut:
    return TestAssetOut(
        id=asset.id, asset_tag=asset.asset_tag, name=asset.name, rfid=asset.rfid,
        serial=asset.serial, sits=asset.sits,  # type: ignore[arg-type]
        rows=[_row_out(r) for r in asset.rows])


def _row_out(row: MatchingTestRow) -> TestRowOut:
    return TestRowOut(
        id=row.id, test_asset_id=row.test_asset_id, place=row.place,  # type: ignore[arg-type]
        value=row.value, expected=row.expected)  # type: ignore[arg-type]


def _row_changes(row: MatchingTestRow) -> dict:
    return {"place": row.place, "value": row.value, "expected": row.expected}


@router.get("/test-assets", response_model=list[TestAssetOut])
async def list_test_assets(db: DbSession, actor: AuthContext = _CAN_VIEW) -> list[TestAssetOut]:
    return [_asset_out(a) for a in await load_test_set(db)]


@router.post("/test-assets", response_model=TestAssetOut, status_code=201)
async def create_test_asset(
        body: TestAssetIn, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> TestAssetOut:
    count = await db.scalar(select(func.count()).select_from(MatchingTestAsset))
    if (count or 0) >= MAX_TEST_ASSETS:
        raise HTTPException(status_code=409, detail={"code": "test_set_full"})
    asset = MatchingTestAsset(**body.model_dump())
    db.add(asset)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if _violated(exc) != _TAG_KEY:
            raise
        raise HTTPException(status_code=409, detail={"code": "duplicate_asset_tag"}) from None
    audit(db, actor_id=actor.person.id, entity_type=_ASSET_ENTITY, entity_id=str(asset.id),
          action="matching_rules.test_asset.create",
          changes={"asset_tag": asset.asset_tag}, ip=client_ip(request))
    await db.commit()
    await db.refresh(asset, ["rows"])
    return _asset_out(asset)


@router.patch("/test-assets/{asset_id}", response_model=TestAssetOut)
async def update_test_asset(
        asset_id: uuid.UUID, body: TestAssetIn, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> TestAssetOut:
    asset = await _asset_or_404(db, asset_id)
    for field, value in body.model_dump().items():
        setattr(asset, field, value)
    asset.updated_at = func.now()
    audit(db, actor_id=actor.person.id, entity_type=_ASSET_ENTITY, entity_id=str(asset.id),
          action="matching_rules.test_asset.update",
          changes={"asset_tag": body.asset_tag}, ip=client_ip(request))
    await _save(db, _TAG_KEY, "duplicate_asset_tag")
    await db.refresh(asset)
    return _asset_out(asset)


@router.delete("/test-assets/{asset_id}", status_code=204)
async def delete_test_asset(
        asset_id: uuid.UUID, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> Response:
    asset = await _asset_or_404(db, asset_id)
    audit(db, actor_id=actor.person.id, entity_type=_ASSET_ENTITY, entity_id=str(asset.id),
          action="matching_rules.test_asset.delete",
          changes={"asset_tag": asset.asset_tag}, ip=client_ip(request))
    await db.delete(asset)  # its rows go with it (ORM cascade, and ON DELETE CASCADE)
    await db.commit()
    return Response(status_code=204)


@router.post("/test-assets/{asset_id}/rows", response_model=TestRowOut, status_code=201)
async def create_test_row(
        asset_id: uuid.UUID, body: TestRowIn, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> TestRowOut:
    asset = await _asset_or_404(db, asset_id)
    row = MatchingTestRow(test_asset_id=asset.id, **body.model_dump())
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        if _violated(exc) != _VALUE_KEY:
            raise
        raise HTTPException(status_code=409, detail={"code": "duplicate_value"}) from None
    audit(db, actor_id=actor.person.id, entity_type=_ROW_ENTITY, entity_id=str(row.id),
          action="matching_rules.test_row.create", changes=_row_changes(row),
          ip=client_ip(request))
    await db.commit()
    return _row_out(row)


@router.patch("/test-rows/{row_id}", response_model=TestRowOut)
async def update_test_row(
        row_id: uuid.UUID, body: TestRowIn, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> TestRowOut:
    row = await _row_or_404(db, row_id)
    for field, value in body.model_dump().items():
        setattr(row, field, value)
    audit(db, actor_id=actor.person.id, entity_type=_ROW_ENTITY, entity_id=str(row.id),
          action="matching_rules.test_row.update", changes=_row_changes(row),
          ip=client_ip(request))
    await _save(db, _VALUE_KEY, "duplicate_value")
    await db.refresh(row)
    return _row_out(row)


@router.delete("/test-rows/{row_id}", status_code=204)
async def delete_test_row(
        row_id: uuid.UUID, request: Request, db: DbSession,
        actor: AuthContext = _CAN_CHANGE) -> Response:
    row = await _row_or_404(db, row_id)
    audit(db, actor_id=actor.person.id, entity_type=_ROW_ENTITY, entity_id=str(row.id),
          action="matching_rules.test_row.delete", changes=_row_changes(row),
          ip=client_ip(request))
    await db.delete(row)
    await db.commit()
    return Response(status_code=204)
