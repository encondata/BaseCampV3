"""The confidentiality statement on an exported PDF's cover (spec
2026-09-30 export cover): the wiki's standard statement (system_config
section `wiki`, edited by wiki administrators), unless the library sets
its own non-empty `confidentiality_statement`."""
from sqlalchemy.ext.asyncio import AsyncSession

# defined in config_store (which seeds the section's default) so the two
# modules don't import each other
from serversherpa.system.config_store import DEFAULT_CONFIDENTIALITY_STATEMENT, read_section

__all__ = [
    "DEFAULT_CONFIDENTIALITY_STATEMENT", "MAX_STATEMENT_LENGTH", "SECTION",
    "effective_statement", "standard_statement",
]

SECTION = "wiki"
MAX_STATEMENT_LENGTH = 1000


async def standard_statement(db: AsyncSession) -> str:
    return str((await read_section(db, SECTION)).get("confidentiality_statement") or "").strip()


def effective_statement(standard: str, space_settings: dict | None) -> str:
    """The library's own statement when it set a non-empty one, else the
    standard one ("" when neither says anything)."""
    own = str((space_settings or {}).get("confidentiality_statement") or "").strip()
    return own or standard.strip()
