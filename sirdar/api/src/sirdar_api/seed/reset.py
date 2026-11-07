"""The password reset list: the one ServerSherpa-specific part of Seed Data.

"Make everyone reset their password" changes exactly this, in the subset,
before it is dumped. The tables and columns are ServerSherpa's, from
api/src/serversherpa/db/models.py (UserAccount and the sign-in tables that
hang off it: PasswordHistory, TotpBackupCode, TrustedDevice, AuthSession,
PasswordResetToken, BiometricKey). A snapshot without one of them (an older
or newer schema) fails the build (reset_target_missing) rather than ship a
secret; keep this list in step with those models.

password_hash goes to NULL, not to a random hash: nothing can match it,
and the reset link sets a real one."""

USER_TABLE = "user_accounts"
# column -> the value every copied account gets
USER_COLUMNS: dict[str, object] = {
    "password_hash": None,
    "must_change_password": True,
    "password_updated_at": None,
    "totp_secret_enc": None,
    "totp_confirmed_at": None,
    "totp_last_counter": None,
    "failed_login_count": 0,
    "locked_until": None,
}
# emptied whole: old hashes, backup codes, remembered browsers, sessions,
# reset links and biometric keys
EMPTY_TABLES = ("password_history", "totp_backup_codes", "trusted_devices", "auth_sessions",
                "password_reset_tokens", "biometric_keys")
