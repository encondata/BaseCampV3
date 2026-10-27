"""Learning policy settings: the system_config `learning` section as a
frozen value for the services that enforce it (code lockout, schedules,
retention). The route in api/routes/system.py is the only writer."""

from dataclasses import dataclass, fields

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.system.config_store import read_section

SECTION = "learning"


@dataclass(frozen=True)
class LearningSettings:
    code_max_failures: int
    code_lockout_seconds: int
    ip_limit: int
    ip_window_seconds: int
    global_limit: int
    general_code_days: int | None
    default_validity_days: int | None
    invite_offset_days: int
    invite_time: str
    reminder_offsets: list[int]
    due_offset_days: int
    retention_days: int | None
    brand_line: str
    email_text: dict
    languages: list[str]


async def load_settings(db: AsyncSession) -> LearningSettings:
    data = await read_section(db, SECTION)
    return LearningSettings(**{f.name: data[f.name] for f in fields(LearningSettings)})
