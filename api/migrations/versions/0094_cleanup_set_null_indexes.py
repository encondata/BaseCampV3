"""Index email_outbox.notification_id, spec_suggestions.job_id and
report_runs.attachment_id.

The first two are ON DELETE SET NULL and report_runs.attachment_id is NO
ACTION (the purge clears it first). Either way, deleting a notification, a
spec lookup job or an attachment makes Postgres look for the rows that still
point at it. Without an index that is a sequential scan per deleted row,
which makes the data cleanup purges of old notifications, finished spec
lookups and deleted files crawl on big tables.

Revision ID: 0094
Revises: 0093
Create Date: 2026-10-09
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0094"
down_revision: str | None = "0093"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("email_outbox_notification_idx", "email_outbox", ["notification_id"])
    op.create_index("spec_suggestions_job_idx", "spec_suggestions", ["job_id"])
    op.create_index("report_runs_attachment_idx", "report_runs", ["attachment_id"])


def downgrade() -> None:
    op.drop_index("report_runs_attachment_idx", table_name="report_runs")
    op.drop_index("spec_suggestions_job_idx", table_name="spec_suggestions")
    op.drop_index("email_outbox_notification_idx", table_name="email_outbox")
