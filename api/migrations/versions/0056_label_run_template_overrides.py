"""Per-type template overrides on label generation runs.

Design: docs/superpowers/specs/2026-09-11-generate-labels-design.md
(§API preview + create, §Portal). Jimmy's ask — "we also need to add a
template selector if one doesn't auto match" — lets the operator pick
any active template of a type and override the auto-match; the run
honors the override instead of `select_template`'s result.

`template_overrides` maps label type key -> template uuid (as text,
matching how it travels through the API and gets validated by
`enqueue_run`). Storing text rather than uuid keeps the column a plain
jsonb object of small strings with no cross-table FK the jsonb layer
would need to enforce; validity is checked by `enqueue_run` at write
time and re-checked by the runner at process time (a template can be
deactivated in between).

Revision ID: 0056
Revises: 0055
Create Date: 2026-09-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0056"
down_revision: str | None = "0055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("label_generation_runs", sa.Column(
        "template_overrides", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")))


def downgrade() -> None:
    op.drop_column("label_generation_runs", "template_overrides")
