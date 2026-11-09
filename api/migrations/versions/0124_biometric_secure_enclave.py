"""Biometric sign-in on the iOS kiosk: Secure Enclave keys.

Widens `ck_biometric_keys_security_level` to admit the two levels an iOS
enroll stores, both for a key made in the Secure Enclave:
- 'secure_enclave': its App Attest statement was checked at enroll;
- 'unattested': enrolled without App Attest, which is off until the team
  has the paid Apple Developer Program (Harbor Master SS-521 turns it on and
  can find these keys by this level).
No new columns.

Rolling back deletes every 'secure_enclave' and 'unattested' key (those
iPads fall back to the password until they enroll again on a build that has
this migration), then restores the narrower check.

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
        "security_level IN ('tee', 'strongbox', 'secure_enclave', 'unattested')")


def downgrade() -> None:
    op.execute("DELETE FROM biometric_keys "
               "WHERE security_level IN ('secure_enclave', 'unattested')")
    op.drop_constraint("ck_biometric_keys_security_level", "biometric_keys", type_="check")
    op.create_check_constraint(
        "ck_biometric_keys_security_level", "biometric_keys",
        "security_level IN ('tee', 'strongbox')")
