"""Working minutes between two plan times, held to the vectors the portal
reads too (tests/fixtures/plans/work_between.json): the Gantt's resize
measures a dragged bar's working time with lib/plans/drag.ts `workMinutes`,
a port of `WorkCalendar.work_between`, and both must agree on every row.

The vectors' expected minutes were written by the API itself; a change to
`work_between` that moves any of them fails here and in the portal's
drag.test.ts until both sides agree again.
"""

import json
from pathlib import Path

import pytest

from serversherpa.plans.calendar import WorkCalendar
from serversherpa.plans.floating import parse_floating

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "plans" / "work_between.json").read_text()
)


@pytest.fixture(autouse=True)
def clean_db():
    """These tests are pure and never touch the database: shadow the
    conftest fixture that truncates every table before each test."""
    yield


def at(text: str):
    return parse_floating(text, date_only_time=None)


@pytest.mark.parametrize("row", VECTORS, ids=[row["name"] for row in VECTORS])
def test_work_between_matches_the_vectors(row):
    calendar = WorkCalendar.from_json(row["calendar"])
    assert calendar.work_between(at(row["a"]), at(row["b"])) == row["minutes"]


def test_the_vectors_cover_what_the_portal_relies_on():
    names = " | ".join(row["name"] for row in VECTORS)
    for needed in ("weeks", "7 days in", "24:00", "reversed", "lunch gap", "Thanksgiving",
                   "Sat 2026-11-14", "nonworking start"):
        assert needed in names
    # a reversed span is the negative of its forward one
    by_name = {row["name"]: row["minutes"] for row in VECTORS}
    assert by_name["reversed span"] == -by_name["Friday afternoon over the move weekend to Monday"]
