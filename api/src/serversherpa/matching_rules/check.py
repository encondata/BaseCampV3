"""Check a flow against the test set, and build run targets from a real move."""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.routes.kiosk import _assets_body, _client_assets_body
from serversherpa.matching_rules.engine import RunResult, Target, run_flow
from serversherpa.matching_rules.flow import Flow
from serversherpa.matching_rules.models import MatchingTestAsset, MatchingTestRow
from serversherpa.matching_rules.validate import CheckItem, structure_checks

MAX_TEST_ASSETS = 10


async def load_test_set(db: AsyncSession) -> list[MatchingTestAsset]:
    return list(
        (await db.execute(select(MatchingTestAsset).order_by(MatchingTestAsset.asset_tag)))
        .scalars()
        .all()
    )


def test_set_targets(assets: Sequence[MatchingTestAsset]) -> list[Target]:
    return [
        Target(
            key=str(a.id),
            asset_tag=a.asset_tag,
            name=a.name,
            rfid=a.rfid,
            serial=a.serial,
            sits=a.sits,  # type: ignore[arg-type]
        )
        for a in assets
    ]


@dataclass
class RowResult:
    row: MatchingTestRow
    asset: MatchingTestAsset
    result: RunResult
    passed: bool


def run_test_set(flow: Flow, place: str, assets: Sequence[MatchingTestAsset]) -> list[RowResult]:
    targets = test_set_targets(assets)
    out: list[RowResult] = []
    for asset in sorted(assets, key=lambda a: a.asset_tag):
        for row in sorted((r for r in asset.rows if r.place == place), key=lambda r: r.value):
            result = run_flow(flow, row.value, targets)
            if row.expected == "not_found":
                passed = result.outcome == "not_found"
            else:
                passed = (
                    result.outcome == "found"
                    and result.field == row.expected
                    and result.asset is not None
                    and result.asset.key == str(asset.id)
                )
            out.append(RowResult(row, asset, result, passed))
    return out


@dataclass
class CheckResult:
    structure: list[CheckItem]
    rows: list[RowResult]

    @property
    def structure_ok(self) -> bool:
        return all(i.ok for i in self.structure)

    @property
    def passed(self) -> int:
        return sum(1 for r in self.rows if r.passed)

    @property
    def total(self) -> int:
        return len(self.rows)

    @property
    def tests_ok(self) -> bool:
        return self.total > 0 and self.passed == self.total

    @property
    def ok(self) -> bool:
        return self.structure_ok and self.tests_ok

    def summary(self, now: datetime) -> dict:
        return {
            "passed": self.passed,
            "total": self.total,
            "ok": self.ok,
            "checked_at": now.isoformat(),
        }


def check_against(flow: Flow, place: str, assets: Sequence[MatchingTestAsset]) -> CheckResult:
    """The one place a check is composed: structure checks plus the test rows."""
    return CheckResult(structure_checks(flow), run_test_set(flow, place, assets))


async def check_flow(db: AsyncSession, place: str, flow: Flow) -> CheckResult:
    return check_against(flow, place, await load_test_set(db))


async def move_targets(
    db: AsyncSession, initiative_id: uuid.UUID, *, with_client: bool
) -> list[Target]:
    body = await _assets_body(db, initiative_id)
    targets = [
        Target(
            key=str(a.id),
            asset_tag=int(a.asset_id) if a.asset_id else None,
            name=a.name,
            rfid=a.rfid,
            serial=a.serial_number,
            sits="move",
        )
        for a in body.assets
    ]
    if with_client:
        client_body = await _client_assets_body(db, initiative_id)
        seen: set[uuid.UUID] = set()
        for a in client_body.assets:
            if a.id in seen:
                continue
            seen.add(a.id)
            targets.append(
                Target(
                    key=str(a.id),
                    asset_tag=int(a.asset_id) if a.asset_id else None,
                    name=a.name,
                    rfid=a.rfid,
                    serial=a.serial_number,
                    sits="client",
                )
            )
    return targets


def uses_client(flow: Flow) -> bool:
    return any(
        n.kind == "match" and n.settings.get("search_in") == "move_and_client" for n in flow.nodes
    )
