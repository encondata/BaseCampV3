"""Notifications Phase 2, answer 7: an import job remembers who committed it.

- `import_jobs.committed_by`: the person who queued the job to write its data. Both commit
  routes (From-To import and Bulk update assets) set it where they set phase "commit". It is a
  foreign key to `people.id`, declared as `created_by` is. NULL means nobody did: a job that was
  never committed, a move setup (its creator queues it, so the creator is who committed it), or
  a job queued before this column existed.
- The worker's finished and failed notice goes to the committer first, then to the uploader
  (`created_by`) when that's someone else. A job with no committer tells its uploader alone, as
  before.

The column is nullable and every reader treats NULL as "the uploader", so nothing is backfilled
and an old slot that doesn't know the column keeps working on it.

Rolling back drops the column: a job still queued then tells its uploader alone.

Design: docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md (Answers, 7)

Revision ID: 0119
Revises: 0118
Create Date: 2026-11-04
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0119"
down_revision: str | None = "0118"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("import_jobs", sa.Column(
        "committed_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=True))


def downgrade() -> None:
    op.drop_column("import_jobs", "committed_by")
