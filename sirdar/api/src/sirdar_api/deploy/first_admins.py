"""The first super admin of an environment that starts empty (deploy phase
8a): the record (environment_first_admins), its checks, the vars step 11
(Create the first admin) hands its playbook, and our copy for the exit codes
of `serversherpa bootstrap-admin`. A typed password is vault-encrypted until
step 11 used it; it never reaches a response, log, audit row, error or argv
(it travels only as the command's stdin). Callers audit and commit."""

import re
import unicodedata
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.db.models import EnvironmentFirstAdmin
from sirdar_api.deploy import vault
from sirdar_api.services import portal_policy

MODES = ("typed", "invite")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}")
_BAD_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})
ALREADY_CREATED = "The first admin was already created; nothing to do.\n"
EXISTS_NOTE = ("An account for {email} already exists in this environment; Sirdar left it as "
               "it is.\n")
_REFUSALS = {
    2: ("This commit's serversherpa bootstrap-admin doesn't know --password-stdin, --invite or "
        "--link-minutes. Deploy a newer commit, then retry."),
    3: ("The environment refused the first admin's password: it's shorter than its password "
        "policy allows. Set a new one on the environment's Settings tab, then retry from "
        "step 11."),
    4: ("The environment has no super_admin role. Deploy a commit whose migrations seed it, "
        "then retry."),
    5: ("The environment can't send email (SMTP isn't configured), so it can't invite the "
        "first admin. Use a typed password instead, then retry."),
}


class FirstAdminError(Exception):
    """A validation failure. `code` is the API error code; `extra` holds
    non-secret details (min_length), never the password."""

    def __init__(self, code: str, **extra):
        super().__init__(code)
        self.code = code
        self.extra = extra


def _clean(value) -> bool:
    return isinstance(value, str) and not any(
        unicodedata.category(ch) in _BAD_CATEGORIES for ch in value)


def _name(value) -> str:
    if not _clean(value) or not 1 <= len(value.strip()) <= 100:
        raise FirstAdminError("first_admin_name_invalid")
    return value.strip()


def check(fields) -> dict:
    """The first admin as create (or PUT …/first-admin) asked for it. A typed
    password meets ServerSherpa's own bar and has no line break (it is one
    line on stdin); an invite has no password."""
    if not isinstance(fields, dict) or fields.get("password_mode") not in MODES:
        raise FirstAdminError("first_admin_invalid")
    email = fields.get("email")
    if not _clean(email) or len(email.strip()) > 254 or not _EMAIL_RE.fullmatch(email.strip()):
        raise FirstAdminError("first_admin_email_invalid")
    mode, password = fields["password_mode"], fields.get("password")
    if mode == "invite":
        if password not in (None, ""):
            raise FirstAdminError("first_admin_password_not_allowed")
        password = None
    else:
        # A blank (all-whitespace) password counts as none at all.
        if password is None or not isinstance(password, str) or not password.strip() \
                or len(password) < portal_policy.PASSWORD_MIN_LENGTH:
            raise FirstAdminError("first_admin_password_too_short",
                                  min_length=portal_policy.PASSWORD_MIN_LENGTH)
        if not _clean(password):
            raise FirstAdminError("first_admin_password_invalid")
    return {"first_name": _name(fields.get("first_name")),
            "last_name": _name(fields.get("last_name")), "email": email.strip(),
            "password_mode": mode, "password": password}


async def get(db: AsyncSession, env_id: uuid.UUID) -> EnvironmentFirstAdmin | None:
    return await db.get(EnvironmentFirstAdmin, env_id, populate_existing=True)


async def pending(db: AsyncSession, env_id: uuid.UUID) -> bool:
    row = await get(db, env_id)
    return row is not None and row.done_at is None


async def put(db: AsyncSession, settings: Settings, env_id: uuid.UUID,
              spec: dict) -> EnvironmentFirstAdmin:
    """Insert or replace the first admin (a checked spec). Once step 11 has
    created them (done_at set) it refuses with first_admin_done: a password
    stored then would have nothing to use or clear it."""
    row = await get(db, env_id)
    if row is not None and row.done_at is not None:
        raise FirstAdminError("first_admin_done")
    if row is None:
        row = EnvironmentFirstAdmin(environment_id=env_id)
        db.add(row)
    row.first_name, row.last_name, row.email = spec["first_name"], spec["last_name"], \
        spec["email"]
    row.password_mode = spec["password_mode"]
    row.password_enc = (vault.encrypt(settings, spec["password"])
                        if spec["password_mode"] == "typed" else None)
    row.updated_at = datetime.now(UTC)
    await db.flush()
    return row


async def step_vars(db: AsyncSession, settings: Settings,
                    env_id: uuid.UUID) -> tuple[dict, list[str]]:
    """Step 11's extra vars and the values to redact. vault.SecretsKeyMissing
    and vault.SecretUnreadable propagate."""
    row = await get(db, env_id)
    if row is None or row.done_at is not None:
        return {}, []
    password = vault.decrypt(settings, row.password_enc) if row.password_enc else ""
    values = {"admin_email": row.email, "admin_first_name": row.first_name,
              "admin_last_name": row.last_name, "admin_role": portal_policy.FIRST_ADMIN_ROLE,
              "admin_invite": row.password_mode == "invite", "admin_password": password,
              "admin_link_minutes": portal_policy.FIRST_ADMIN_LINK_MINUTES}
    return values, [password] if password else []


async def mark_done(db: AsyncSession, env_id: uuid.UUID) -> None:
    row = await get(db, env_id)
    if row is not None:
        now = datetime.now(UTC)
        row.password_enc, row.done_at, row.updated_at = None, now, now


def exit_code(data: dict) -> int:
    """bootstrap-admin's exit code, as first_admin.yml reported it."""
    try:
        return int(str(data.get("first_admin_rc")))
    except (TypeError, ValueError):
        return -1


def refusal(rc: int) -> str:
    return _REFUSALS.get(rc, f"serversherpa bootstrap-admin failed (exit {rc}). See the api "
                             "container's log, then retry.")


def public(row: EnvironmentFirstAdmin | None) -> dict | None:
    if row is None:
        return None
    return {"first_name": row.first_name, "last_name": row.last_name, "email": row.email,
            "password_mode": row.password_mode, "done": row.done_at is not None}
