"""Matching rules API schemas (Developer › Matching rules)."""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from serversherpa.matching_rules.check import CheckResult, RowResult
from serversherpa.matching_rules.engine import JS_WHITESPACE, RunResult, Target, TraceStep
from serversherpa.matching_rules.flow import EXPECTED, Flow, Place
from serversherpa.matching_rules.validate import CheckItem


class CheckSummaryOut(BaseModel):
    passed: int
    total: int
    ok: bool
    checked_at: datetime | None


class ProblemOut(BaseModel):
    message: str
    node_ids: list[str]


class CheckItemOut(BaseModel):
    code: str
    label: str
    ok: bool
    problems: list[ProblemOut]


class HitOut(BaseModel):
    id: str
    asset_tag: int | None
    name: str | None
    rfid: str | None
    serial: str | None
    sits: Literal["move", "client"]


class TestRowResultOut(BaseModel):
    __test__ = False  # not a pytest class, despite the name

    row_id: uuid.UUID
    test_asset_id: uuid.UUID
    asset_tag: int
    asset_name: str
    value: str
    expected: str
    outcome: Literal["found", "not_found", "stopped"]
    found_asset_tag: int | None
    found_field: str | None
    passed: bool


class CheckOut(BaseModel):
    ok: bool
    structure_ok: bool
    tests_ok: bool
    passed: int
    total: int
    structure: list[CheckItemOut]
    tests: list[TestRowResultOut]


def check_item_out(item: CheckItem) -> CheckItemOut:
    return CheckItemOut(
        code=item.code,
        label=item.label,
        ok=item.ok,
        problems=[ProblemOut(message=p.message, node_ids=list(p.node_ids))
                  for p in item.problems],
    )


def row_result_out(r: RowResult) -> TestRowResultOut:
    hit = r.result.asset
    return TestRowResultOut(
        row_id=r.row.id,
        test_asset_id=r.asset.id,
        asset_tag=r.asset.asset_tag,
        asset_name=r.asset.name,
        value=r.row.value,
        expected=r.row.expected,
        outcome=r.result.outcome,
        found_asset_tag=hit.asset_tag if hit else None,
        found_field=r.result.field,
        passed=r.passed,
    )


def check_out(res: CheckResult) -> CheckOut:
    return CheckOut(
        ok=res.ok,
        structure_ok=res.structure_ok,
        tests_ok=res.tests_ok,
        passed=res.passed,
        total=res.total,
        structure=[check_item_out(i) for i in res.structure],
        tests=[row_result_out(r) for r in res.rows],
    )


def current_summary(res: CheckResult) -> CheckSummaryOut:
    """Today's result: a re-run, not a stored check, so it has no time."""
    return CheckSummaryOut(passed=res.passed, total=res.total, ok=res.ok, checked_at=None)


class VersionOut(BaseModel):
    id: uuid.UUID
    place: Place
    version: int
    state: Literal["draft", "standby", "live", "retired"]
    based_on_version: int | None
    saved_by_name: str | None
    saved_at: datetime
    state_changed_at: datetime | None
    checked: CheckSummaryOut | None
    current: CheckSummaryOut


class VersionDetailOut(VersionOut):
    flow: Flow
    check: CheckOut


class VersionCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    place: Place
    flow: Flow
    based_on_id: uuid.UUID | None = None


class VersionUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    flow: Flow


class CheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    place: Place
    flow: Flow


class TestRunIn(BaseModel):
    __test__ = False  # not a pytest class, despite the name
    model_config = ConfigDict(extra="forbid")

    place: Place
    flow: Flow
    value: Annotated[str, Field(max_length=256)]
    against: Literal["test_set", "move"]
    initiative_id: uuid.UUID | None = None


def hit_out(t: Target) -> HitOut:
    return HitOut(id=t.key, asset_tag=t.asset_tag, name=t.name, rfid=t.rfid,
                  serial=t.serial, sits=t.sits)


class TraceStepOut(BaseModel):
    node_id: str
    kind: str
    value_in: str
    value_out: str | None
    output: str | None
    hits: list[HitOut] | None


class RunOut(BaseModel):
    outcome: Literal["found", "not_found", "stopped"]
    stop_reason: str | None
    end_node_id: str | None
    asset: HitOut | None
    field: str | None
    action: str | None
    message: str | None
    trace: list[TraceStepOut]


def trace_step_out(s: TraceStep) -> TraceStepOut:
    return TraceStepOut(
        node_id=s.node_id, kind=s.kind, value_in=s.value_in, value_out=s.value_out,
        output=s.output, hits=None if s.hits is None else [hit_out(h) for h in s.hits])


def run_out(r: RunResult) -> RunOut:
    return RunOut(
        outcome=r.outcome, stop_reason=r.stop_reason, end_node_id=r.end_node_id,
        asset=hit_out(r.asset) if r.asset else None, field=r.field, action=r.action,
        message=r.message, trace=[trace_step_out(s) for s in r.trace])


class TestRowIn(BaseModel):
    __test__ = False
    model_config = ConfigDict(extra="forbid")

    place: Place
    value: Annotated[str, Field(min_length=1, max_length=256)]
    expected: Literal[*EXPECTED]  # type: ignore[valid-type]

    @field_validator("value")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip(JS_WHITESPACE).strip():
            raise ValueError("value is blank")
        return v


class TestRowOut(TestRowIn):
    __test__ = False

    id: uuid.UUID
    test_asset_id: uuid.UUID


def _blank_to_none(v: str | None) -> str | None:
    if v is None or not v.strip():
        return None
    return v


class TestAssetIn(BaseModel):
    __test__ = False
    model_config = ConfigDict(extra="forbid")

    asset_tag: Annotated[int, Field(ge=1, le=2**53 - 1)]  # a safe JavaScript number
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    rfid: Annotated[str | None, Field(max_length=128)] = None
    serial: Annotated[str | None, Field(max_length=128)] = None
    sits: Literal["move", "client"] = "move"

    @field_validator("rfid", "serial")
    @classmethod
    def _null_when_blank(cls, v: str | None) -> str | None:
        return _blank_to_none(v)


class TestAssetOut(TestAssetIn):
    __test__ = False

    id: uuid.UUID
    rows: list[TestRowOut]
