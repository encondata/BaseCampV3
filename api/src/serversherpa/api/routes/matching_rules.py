"""Developer › Matching rules: the versions of each place's flow (drafts,
standby, deploy, rollback). Under the `devtools` resource like the rest of
the Developer area: view for reads, change for every write."""

import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext, DbSession, client_ip, require_permission
from serversherpa.db.models import Person
from serversherpa.matching_rules import versions
from serversherpa.matching_rules.check import CheckResult, load_test_set, run_test_set
from serversherpa.matching_rules.flow import Flow, Place
from serversherpa.matching_rules.models import MatchingRuleVersion, MatchingTestAsset
from serversherpa.matching_rules.schemas import (
    CheckSummaryOut,
    VersionCreateIn,
    VersionDetailOut,
    VersionOut,
    VersionUpdateIn,
    check_out,
    current_summary,
)
from serversherpa.matching_rules.validate import structure_checks
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
    return CheckResult(structure_checks(flow), run_test_set(flow, version.place, assets))


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
