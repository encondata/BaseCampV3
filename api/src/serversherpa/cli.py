"""ServerSherpa operations CLI.

    serversherpa bootstrap-admin --email you@company.com --first-name You --last-name Name

Helper scripts belong here as commands sharing the service layer —
never as standalone scripts with their own DB code.
"""

import asyncio
from datetime import UTC, datetime

import typer
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.engine import dispose_engine, get_sessionmaker
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

app = typer.Typer(no_args_is_help=True, help="ServerSherpa operations CLI")


@app.callback()
def _main() -> None:
    """ServerSherpa operations CLI."""


@app.command()
def bootstrap_admin(
    email: str = typer.Option(..., help="Login email for the admin account"),
    first_name: str = typer.Option(...),
    last_name: str = typer.Option(...),
    password: str = typer.Option(
        ..., prompt=True, confirmation_prompt=True, hide_input=True),
) -> None:
    """Create the first admin: person + account + admin role grant."""

    async def _run() -> None:
        settings = get_settings()
        async with get_sessionmaker()() as db:
            existing = await db.scalar(
                select(UserAccount).where(UserAccount.email == email))
            if existing is not None:
                typer.secho(f"An account for {email} already exists.", fg="red")
                raise typer.Exit(code=1)

            now = datetime.now(UTC)
            person = Person(first_name=first_name, last_name=last_name,
                            email=email, source="manual")
            db.add(person)
            await db.flush()  # person.id

            db.add(UserAccount(
                person_id=person.id,
                email=email,
                password_hash=hash_password(
                    password,
                    pepper=settings.password_pepper.get_secret_value()),
                password_updated_at=now,
            ))
            db.add(PersonRole(person_id=person.id, role="admin"))  # granted_by NULL = bootstrap
            await db.commit()
            typer.secho(
                f"Admin created: {person.first_name} {person.last_name} "
                f"<{email}> (person {person.id})", fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command()
def import_v2_assets(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    limit: int = typer.Option(100, help="Max assets to import this run"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Seed real assets (+ referenced catalog models/aliases) from a legacy
    BaseCamp V2 dump. Additive: re-runs skip already-imported legacy_ids."""

    async def _run() -> None:
        from serversherpa.assets.v2_import import SOURCE_REF, import_assets
        from serversherpa.services.audit import audit

        async with get_sessionmaker()() as db:
            stats = await import_assets(db, dump, limit)
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] would import: {stats}", fg="yellow")
            else:
                audit(db, actor_id=None, entity_type="asset", entity_id=None,
                      action="import",
                      changes={"source": SOURCE_REF, **stats})
                await db.commit()
                typer.secho(f"Imported: {stats}", fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command()
def set_password(
    email: str = typer.Option(..., help="Login email of the existing account"),
    password: str = typer.Option(
        ..., prompt=True, confirmation_prompt=True, hide_input=True),
) -> None:
    """Reset an existing account's password."""

    async def _run() -> None:
        settings = get_settings()
        async with get_sessionmaker()() as db:
            account = await db.scalar(
                select(UserAccount).where(UserAccount.email == email))
            if account is None:
                typer.secho(f"No account found for {email}.", fg="red")
                raise typer.Exit(code=1)

            account.password_hash = hash_password(
                password, pepper=settings.password_pepper.get_secret_value())
            account.password_updated_at = datetime.now(UTC)
            account.must_change_password = False
            await db.commit()
            typer.secho(f"Password updated for {email}.", fg="green")
        await dispose_engine()

    asyncio.run(_run())


if __name__ == "__main__":
    app()
