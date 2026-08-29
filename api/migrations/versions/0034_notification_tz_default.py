"""Notification groups: default timezone becomes America/New_York.

The company is worldwide and the timezone pickers now offer every IANA
zone; New York is the agreed reference default for newly created groups
(Jimmy, 2026-08-29). Existing rows keep whatever timezone they carry —
only the column default changes.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("notification_groups", "timezone",
                    server_default="America/New_York")


def downgrade() -> None:
    op.alter_column("notification_groups", "timezone",
                    server_default="America/Chicago")
