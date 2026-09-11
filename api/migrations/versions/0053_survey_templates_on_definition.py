"""Survey templates move from the partner to the report definition.

Design change (see docs/superpowers/specs/2026-09-11-site-move-survey-
design.md): the Site & Move Survey xlsx template is no longer owned by
the logistics partner — it's a company-owned `survey_template`
attachment on the report definition, alongside the `report_asset` docx.
Partners are still chosen per run (name goes into the context and
filename), but they carry no template.

Data-only migration: re-points every non-deleted `attachments` row with
`entity_type='partner' AND kind='survey_template'` onto the "Site & Move
Survey" report definition (the same row migration 0052 seeded). No
schema change — `attachments.entity_type`/`entity_id` already accept any
value the app-level `KIND_ENTITY_TYPES` map allows.

Revision ID: 0053
Revises: 0052
Create Date: 2026-09-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0053"
down_revision: str | None = "0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Module-level constants (rather than inline in upgrade()) so the test
# suite can execute these exact statements directly — see
# tests/test_site_move_survey_fixtures.py, following 0052's pattern.
SELECT_DEFINITION_ID_SQL = (
    "SELECT id FROM report_definitions "
    "WHERE report_type = 'site_move_survey' AND archived_at IS NULL "
    "ORDER BY is_system DESC, created_at LIMIT 1"
)

UPDATE_SURVEY_TEMPLATES_SQL = (
    "UPDATE attachments SET entity_type = 'report_definition', entity_id = :definition_id "
    "WHERE entity_type = 'partner' AND kind = 'survey_template' AND deleted_at IS NULL"
)


def repoint_survey_templates(conn) -> None:
    """Re-points every non-deleted `entity_type='partner' AND
    kind='survey_template'` attachment onto the "Site & Move Survey"
    report definition. No-ops (leaves legacy rows on the partner) when
    that definition doesn't exist yet — e.g. a fresh DB where 0052
    hasn't run, or the seeded row was deleted. Shared with the test so
    the guard clause and the UPDATE itself are what gets exercised —
    same shape as 0052's `assert_no_standalone_runs(conn)`."""
    definition_id = conn.execute(sa.text(SELECT_DEFINITION_ID_SQL)).scalar()
    if definition_id is None:
        return
    conn.execute(sa.text(UPDATE_SURVEY_TEMPLATES_SQL), {"definition_id": definition_id})


def upgrade() -> None:
    repoint_survey_templates(op.get_bind())


def downgrade() -> None:
    # Documented no-op: which partner each re-pointed template used to
    # belong to isn't recoverable — the UPDATE above doesn't keep a
    # record of the prior (entity_type, entity_id) per row. Downgrading
    # this migration leaves every survey_template attachment on the
    # report definition rather than restoring partner ownership. Note
    # also that 0052's own downgrade() DELETEs the "Site & Move Survey"
    # definition outright — running that after this migration's upgrade()
    # has re-pointed attachments onto it would orphan those rows (they'd
    # 404 `entity_not_found` on view), not just leave ownership unrestored.
    pass
