"""Learning compliance data: the rows of one initiative, or of every active
initiative that has people plus the general set. The judgment itself is
`learning.stats.evaluate`; this only flattens it into report rows."""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, InitiativePerson
from serversherpa.db.ordering import natural
from serversherpa.learning import stats
from serversherpa.reports.move_report.gather import InitiativeUnavailable

GENERAL = "General"


@dataclass
class Row:
    person: str
    document: str
    initiative: str
    state: str                    # valid | expires_during | missing
    status: str
    version: int | None
    language: str | None
    signed_at: datetime | None
    expires_on: date | None
    overrides: int


@dataclass
class ComplianceData:
    initiative_id: uuid.UUID | None
    initiative_name: str | None             # None = everyone
    rows: list[Row] = field(default_factory=list)

    @property
    def people(self) -> int:
        return len({(r.initiative, r.person) for r in self.rows})

    def count(self, state: str) -> int:
        return sum(1 for r in self.rows if r.state == state)


async def _rows(db: AsyncSession, initiative: Initiative | None) -> list[Row]:
    ev = await stats.evaluate(db, initiative)
    name = initiative.name if initiative else GENERAL
    rows = []
    for person in ev.people:
        for document in ev.documents:
            cell = ev.cells.get((person.id, document.id))
            if cell is None:
                continue
            rows.append(Row(
                person=cell.person, document=cell.document, initiative=name,
                state=cell.state, status=cell.status, version=cell.version,
                language=cell.language, signed_at=cell.signed_at,
                expires_on=cell.expires_on, overrides=cell.overrides))
    return rows


async def gather(db: AsyncSession, initiative_id: uuid.UUID | None) -> ComplianceData:
    if initiative_id is not None:
        initiative = await db.get(Initiative, initiative_id)
        if initiative is None or initiative.archived_at is not None:
            raise InitiativeUnavailable()
        return ComplianceData(initiative_id, initiative.name, await _rows(db, initiative))
    data = ComplianceData(None, None)
    for initiative in await db.scalars(
        select(Initiative)
        .where(Initiative.archived_at.is_(None),
               Initiative.status.not_in(stats.INACTIVE_STATUSES),
               Initiative.id.in_(select(InitiativePerson.initiative_id)))
        .order_by(natural(Initiative.name), Initiative.id)):
        data.rows += await _rows(db, initiative)
    data.rows += await _rows(db, None)
    return data
