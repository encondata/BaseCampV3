"""Devices migrations — synchronous (psycopg), hand-written SQL, no autogenerate."""

import sys
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from serversherpa_devices.config import get_settings
from serversherpa_devices.db import tls

target_metadata = None


def run_migrations_offline() -> None:
    context.configure(url=get_settings().sync_database_url, target_metadata=target_metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # a managed database: verify-full against its CA (the URL as is otherwise)
    engine = create_engine(tls.migration_url(get_settings()), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
