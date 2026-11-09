"""Biometric sign-in on the iOS kiosk: Secure Enclave keys.

Widens `ck_biometric_keys_security_level` to admit 'secure_enclave', the
level an iOS enroll stores (the key is made in the Secure Enclave and its
App Attest statement is checked at enroll). No new columns.

Rolling back deletes every 'secure_enclave' key (those iPads fall back to
the password until they enroll again on a build that has this migration),
then restores the narrower check.

Design: docs/superpowers/specs/2026-11-09-ios-biometric-sign-in-design.md

Revision ID: 0124
Revises: 0123
Create Date: 2026-11-09
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0124"
down_revision: str | None = "0123"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_biometric_keys_security_level", "biometric_keys", type_="check")
    op.create_check_constraint(
        "ck_biometric_keys_security_level", "biometric_keys",
        "security_level IN ('tee', 'strongbox', 'secure_enclave')")


def downgrade() -> None:
    op.execute("DELETE FROM biometric_keys WHERE security_level = 'secure_enclave'")
    op.drop_constraint("ck_biometric_keys_security_level", "biometric_keys", type_="check")
    op.create_check_constraint(
        "ck_biometric_keys_security_level", "biometric_keys",
        "security_level IN ('tee', 'strongbox')")
