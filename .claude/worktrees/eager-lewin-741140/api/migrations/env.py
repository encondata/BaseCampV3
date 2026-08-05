"""Alembic environment. Reads the database URL from application Settings
(env vars / repo-root .env) so credentials never live in alembic.ini."""

import sys
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from serversherpa.config import get_settings  # noqa: E402

config = context.config

# No SQLAlchemy models yet — autogenerate support comes when models land.
target_metadata = None


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of executing (alembic upgrade --sql)."""
    context.configure(
        url=get_settings().sync_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(get_settings().sync_database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
