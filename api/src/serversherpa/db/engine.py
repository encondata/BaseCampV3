"""Async engine / session factory. Built lazily so Settings (and therefore
the environment) is read at first use, not import time."""

import logging
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from serversherpa.config import get_settings
from serversherpa.db import tls

log = logging.getLogger(__name__)

DEFAULT_APPLICATION_NAME = "serversherpa"
_MAX_APPLICATION_NAME = 63      # Postgres truncates anything longer (NAMEDATALEN - 1)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None
_application_name = DEFAULT_APPLICATION_NAME


def set_application_name(name: str) -> None:
    """Name this process's database connections (pg_stat_activity shows it).

    Call it before the engine is first built. Connections already open keep
    the name they were made with, so if the engine exists this still records
    the new name for any connection made after a dispose, but warns (and
    otherwise ignores the call) rather than pretending it took effect now.
    An empty name resets to the default.
    """
    global _application_name
    name = (name or DEFAULT_APPLICATION_NAME)[:_MAX_APPLICATION_NAME]
    if _engine is not None and name != _application_name:
        log.warning("application_name set to %r after the engine was built; open "
                    "connections keep %r until the engine is disposed",
                    name, _application_name)
    _application_name = name


def connect_args(settings) -> dict:
    """asyncpg's connect arguments: the Postgres application_name, plus ssl
    verified against the managed database's CA when SS_DATABASE_CA_B64 is
    set, else the system store for "require"."""
    args: dict = {"server_settings": {"application_name": _application_name}}
    if settings.database_ssl == "require":
        args["ssl"] = True
    args.update(tls.asyncpg_kwargs(settings))
    return args


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.database_url.get_secret_value(),
            pool_size=settings.database_pool_size,
            max_overflow=settings.database_pool_max_overflow,
            pool_pre_ping=True,
            connect_args=connect_args(settings),
        )
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


async def dispose_engine() -> None:
    """Dispose the engine and reset (used by tests and clean shutdown)."""
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _sessionmaker = None


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one transaction-per-request session."""
    async with get_sessionmaker()() as session:
        yield session
