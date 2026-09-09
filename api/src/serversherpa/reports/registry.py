"""Explicit registry of report modules keyed by `report_type`. Explicit
(not glob-discovered like V2) so a typo is an import error, not a silent
404 at runtime."""

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun


@dataclass(frozen=True)
class ReportResult:
    pdf: bytes
    filename: str


class OptionsError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


class ReportModule(Protocol):
    report_type: str

    def default_options(self) -> dict: ...
    def validate_options(self, options: dict) -> dict: ...
    async def build(self, db: AsyncSession, run: ReportRun) -> ReportResult: ...


_REGISTRY: dict[str, ReportModule] | None = None


def registry() -> dict[str, ReportModule]:
    """Lazy so report modules may import this module's types without a
    circular import at package load."""
    global _REGISTRY
    if _REGISTRY is None:
        from serversherpa.reports import move_report
        _REGISTRY = {move_report.report_type: move_report}      # type: ignore[dict-item]
    return _REGISTRY


def get_module(report_type: str) -> ReportModule:
    try:
        return registry()[report_type]
    except KeyError:
        raise ValueError(f"unknown report type {report_type!r}") from None
