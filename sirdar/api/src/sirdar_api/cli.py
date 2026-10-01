"""`sirdar` command line. Each command opens its own event loop and
disposes the engine before exiting."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

import typer

from sirdar_api.db.engine import dispose_engine, get_sessionmaker
from sirdar_api.services.import_users import ImportNotConfigured, ImportSourceError, import_users
from sirdar_api.services.local_users import (
    MIN_PASSWORD_LENGTH, LocalUserError, create_local_admin, reset_local_password,
)

app = typer.Typer(help="Sirdar — manage ServerSherpa environments.", no_args_is_help=True)
T = TypeVar("T")

_MESSAGES = {
    "password_too_short": f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
    "unknown_role": "Unknown role. Use one of the roles on the Roles & access page.",
    "invalid_email": ("That email address can't be used to sign in. "
                      "Use a normal address like name@company.com."),
    "email_taken": "A user with that email already exists.",
    "not_found": "No user with that email.",
    "not_local": "That user comes from the portal — change the password there, then re-import.",
}


def _run(fn: Callable[..., Awaitable[T]]) -> T:
    async def main() -> T:
        try:
            async with get_sessionmaker()() as db:
                return await fn(db)
        finally:
            await dispose_engine()
    return asyncio.run(main())


@app.command("import-users")
def import_users_cmd() -> None:
    """Copy portal users with an admin-or-higher role into Sirdar."""
    try:
        run = _run(lambda db: import_users(db, actor_id=None, trigger="cli"))
    except ImportNotConfigured:
        typer.echo("SIRDAR_SOURCE_DATABASE_URL is not set — nothing to import from.")
        raise typer.Exit(1) from None
    except ImportSourceError as exc:
        typer.echo(f"Import failed: {exc}")
        raise typer.Exit(1) from None
    typer.echo(f"Import finished: added {run.added}, updated {run.updated}, "
               f"unchanged {run.unchanged}, disabled {run.disabled}, skipped {run.skipped}")
    for row in run.rows:
        if row["action"] != "unchanged":
            detail = row["reason"] or ", ".join(row["changes"]) or ", ".join(row["roles"])
            typer.echo(f"  {row['action']:<9} {row['email']}  {detail}")


@app.command("create-admin")
def create_admin_cmd(
    email: str = typer.Option(...),
    first_name: str = typer.Option(...),
    last_name: str = typer.Option(...),
    role: str = typer.Option("developer"),
) -> None:
    """Create a Sirdar-only (local) user — break-glass access for a fresh install."""
    password = typer.prompt("Password", hide_input=True, confirmation_prompt=True)
    try:
        user = _run(lambda db: create_local_admin(db, email=email, first_name=first_name,
                                                  last_name=last_name, role=role,
                                                  password=password))
    except LocalUserError as exc:
        typer.echo(_MESSAGES[exc.code])
        raise typer.Exit(1) from None
    typer.echo(f"Created local {role} {user.email}")


@app.command("reset-password")
def reset_password_cmd(email: str = typer.Option(...)) -> None:
    """Set a new password for a local user."""
    password = typer.prompt("New password", hide_input=True, confirmation_prompt=True)
    try:
        user = _run(lambda db: reset_local_password(db, email=email, password=password))
    except LocalUserError as exc:
        typer.echo(_MESSAGES[exc.code])
        raise typer.Exit(1) from None
    typer.echo(f"Password updated for {user.email}")
