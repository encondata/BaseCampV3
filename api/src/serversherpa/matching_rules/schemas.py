"""Matching rules API schemas (Developer › Matching rules)."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from serversherpa.matching_rules.check import CheckResult, RowResult
from serversherpa.matching_rules.flow import Flow, Place
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
