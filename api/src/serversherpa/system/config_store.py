"""system_config readers. Defaults mirror migration 0024's seeds so a
missing row never breaks a caller; the DB row's keys win on conflict."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULTS: dict[str, dict] = {
    "logging": {
        "mode": "local",
        "local_max_rows_per_process": 20000,
        "local_max_age_days": 14,
        "remote_buffer_rows": 10000,
        "min_level": "INFO",
        "transport": "loki",
        "loki": {"url": "", "username": "", "password": "",
                 "tenant_id": ""},
        "syslog": {"host": "", "port": 514, "protocol": "udp"},
    },
    "admin": {
        "read_only": False,
        "read_only_message": "",
        "pause_workers": False,
        "banner_enabled": False,
        "banner_message": "",
    },
    # 2FA policy flags plus the password expiry policy (To-Do #32).
    # password_expiry_since is server-set: the moment the switch was last
    # turned on; the expiry clock never reaches back before it.
    "security": {
        "two_factor_enabled": False,
        "two_factor_required": False,
        "password_expiry_enabled": False,
        "password_expiry_days": 90,
        "password_history_count": 3,
        "password_expiry_since": None,
    },
    # Makes / Models spec lookup (Claude). Field groups decide what the
    # worker asks for; auto_apply fills BLANK fields only (never knowledge).
    "ai_lookup": {
        "background_enabled": False,
        "auto_apply": False,
        "fields_specs": True,
        "fields_mounting": False,
        "fields_knowledge": False,
        "retry_after_days": 90,
        "effort": "medium",            # low | medium | high (spec_lookup.provider)
    },
}


def _merged(section: str, row_data: dict | None) -> dict:
    base = dict(DEFAULTS.get(section, {}))
    if row_data:
        base.update(row_data)
    return base


async def read_section(db: AsyncSession, section: str) -> dict:
    from serversherpa.db.models import SystemConfig

    row = await db.get(SystemConfig, section)
    return _merged(section, row.data if row is not None else None)


def read_section_sync(engine, section: str) -> dict:
    """Same merge over a sync engine — for the log handler's flusher
    thread, which must never touch the async event loop."""
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT data FROM system_config WHERE section = :s"),
            {"s": section}).fetchone()
    return _merged(section, row[0] if row is not None else None)
