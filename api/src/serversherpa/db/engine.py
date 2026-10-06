"""Async engine / session factory. Built lazily so Settings (and therefore
the environment) is read at first use, not import time."""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from serversherpa.config import get_settings
from serversherpa.db import tls

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def connect_args(settings) -> dict:
    """asyncpg's ssl: verified against the managed database's CA when
    SS_DATABASE_CA_B64 is set, else the system store for "require"."""
    args: dict = {}
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
