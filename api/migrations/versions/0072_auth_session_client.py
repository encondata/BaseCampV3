"""Which app minted a session.

`POST /auth/login` skips the 2FA challenge for `client="kiosk"`, and that
field is self-asserted. Recording the client on the session row lets the
API hold such a session to the kiosk routes, so the exemption can never
be traded for a portal session.

Revision ID: 0072
Revises: 0071
Create Date: 2026-09-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0072"
down_revision: str | None = "0071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("auth_sessions", sa.Column(
        "client", sa.Text(), nullable=False, server_default="portal",
        comment="Which app minted the login: portal | kiosk. "
                "Kiosk sessions may reach only kiosk routes."))
    op.create_check_constraint(
        "auth_sessions_client_check", "auth_sessions",
        "client IN ('portal', 'kiosk')")


def downgrade() -> None:
    op.drop_constraint("auth_sessions_client_check", "auth_sessions",
                       type_="check")
    op.drop_column("auth_sessions", "client")
