"""ServerSherpa operations CLI.

    serversherpa bootstrap-admin --email you@company.com --first-name You --last-name Name

Helper scripts belong here as commands sharing the service layer —
never as standalone scripts with their own DB code.
"""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

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
def import_v2_sites(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    limit: int = typer.Option(100, help="Max sites to import this run"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Seed real sites (+ resolved SiteType/client/partner links) from a
    legacy BaseCamp V2 dump. Additive: re-runs skip already-imported
    source_refs/names."""

    async def _run() -> None:
        from serversherpa.services.audit import audit
        from serversherpa.sites.v2_import import import_sites

        async with get_sessionmaker()() as db:
            stats = await import_sites(db, dump, limit)
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] would import: {stats}", fg="yellow")
            else:
                audit(db, actor_id=None, entity_type="site", entity_id=None,
                      action="import", changes=stats)
                await db.commit()
                typer.secho(f"Imported: {stats}", fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command()
def import_v2_workers(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    limit: int = typer.Option(200, help="Max workers to import this run"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
    photos: bool = typer.Option(True, help="Also fetch and attach avatars"),
    photos_dir: list[str] = typer.Option(
        [], help="Local dir(s) searched for photo files by filename"),
    spaces_env: str = typer.Option(
        "", help="V2 .env with DO_SPACES_* creds for S3-stored photos"),
) -> None:
    """Seed worker people (+ profiles, work-history notes, best-effort
    avatars) from a legacy BaseCamp V2 dump. Additive: re-runs skip
    already-imported source_refs and existing emails; never deletes."""

    async def _run() -> None:
        from serversherpa.people.v2_import import (
            attach_photos, import_workers, spaces_getter_from_env)
        from serversherpa.services.audit import audit

        async with get_sessionmaker()() as db:
            stats = await import_workers(db, dump, limit)
            id_map = stats.pop("id_map")
            if photos and not dry_run:
                s3_get = spaces_getter_from_env(spaces_env) \
                    if spaces_env else None
                stats |= await attach_photos(
                    db, dump, id_map, list(photos_dir), s3_get)
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] would import: {stats}", fg="yellow")
            else:
                audit(db, actor_id=None, entity_type="person", entity_id=None,
                      action="import", changes=stats)
                await db.commit()
                typer.secho(f"Imported: {stats}", fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command()
def import_v2_status_rules(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Import V2 process-engine rules as V3 status rules. Upserts by
    rule name; first imports land DISABLED for review in
    /admin/status-rules. Truck-dependent rules are skipped (no trucks
    in V3)."""

    async def _run() -> None:
        from serversherpa.status_rules.v2_import import import_rules

        async with get_sessionmaker()() as db:
            stats = await import_rules(db, dump)
            for name, reason in stats["skipped"]:
                typer.secho(f"skipped: {name} — {reason}", fg="yellow")
            for name, what, _ in stats["partial"]:
                typer.secho(f"partial: {name} — {what}", fg="yellow")
            summary = (f"{stats['imported']} imported (disabled), "
                       f"{stats['updated']} updated, "
                       f"{len(stats['partial'])} partial, "
                       f"{len(stats['skipped'])} skipped")
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] {summary}", fg="yellow")
            else:
                await db.commit()
                typer.secho(summary, fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command()
def import_v2_label_templates(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Import V2 label templates as inactive raw-code V3 templates.
    Upserts by name; skips non-Zebra printers and design-kind name
    collisions; placeholders translated where mappable."""

    async def _run() -> None:
        from serversherpa.labels.v2_import import import_label_templates

        async with get_sessionmaker()() as db:
            stats = await import_label_templates(db, dump)
            for name, reason in stats["skipped"]:
                typer.secho(f"skipped: {name} — {reason}", fg="yellow")
            for note in stats["notes"]:
                typer.secho(f"note: {note}", fg="yellow")
            summary = (f"{len(stats['created'])} created (inactive), "
                       f"{len(stats['updated'])} updated, "
                       f"{len(stats['unchanged'])} unchanged, "
                       f"{len(stats['skipped'])} skipped")
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] {summary}", fg="yellow")
            else:
                await db.commit()
                typer.secho(summary, fg="green")
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


def _run_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point. Module-level (picklable) so
    watchfiles can re-spawn it in a fresh process after every change;
    hard restarts are safe by the worker's design (batched commits +
    stale-job requeue on startup)."""

    async def _run() -> None:
        from serversherpa.imports import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass    # watchfiles stops the old process with SIGINT on reload


@app.command()
def import_worker(
    poll_seconds: float = typer.Option(
        2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(
        False, help="Process at most one job, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src "
                    "changes (uvicorn-style)"),
) -> None:
    """Run the bulk-import worker loop — a separate process from the API,
    so imports never affect API readiness or response times."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]   # …/api/src
        typer.secho(f"[import-worker] dev reload — watching {src_dir}",
                    fg="cyan")
        watchfiles.run_process(src_dir, target=_run_worker_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.imports import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 job" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_log_service_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    async def _run() -> None:
        from serversherpa.system import log_service

        await log_service.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass    # watchfiles stops the old process with SIGINT on reload


@app.command()
def log_service(
    poll_seconds: float = typer.Option(
        10.0, help="Seconds between retention/probe ticks"),
    once: bool = typer.Option(
        False, help="One retention pass + one probe, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart when api/src changes "
                    "(uvicorn-style)"),
) -> None:
    """Run the log-service worker — retention enforcement and the web
    probe (SIEM forwarding arrives with the config slice)."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[log-service] dev reload — watching {src_dir}",
                    fg="cyan")
        watchfiles.run_process(src_dir, target=_run_log_service_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.system import log_service as svc

        if once:
            await svc.run_once()
            typer.secho("retention + probe + forwarding pass complete",
                        fg="green")
        else:
            await svc.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_notification_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    async def _run() -> None:
        from serversherpa.notifications import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass    # watchfiles stops the old process with SIGINT on reload


@app.command()
def notification_worker(
    poll_seconds: float = typer.Option(
        5.0, help="Seconds between status-log checks"),
    once: bool = typer.Option(
        False, help="One status pass, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart when api/src changes "
                    "(uvicorn-style)"),
) -> None:
    """Run the notification-worker placeholder — heartbeat + periodic
    status logs only. No delivery pipeline yet."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[notification-worker] dev reload — watching {src_dir}",
                    fg="cyan")
        watchfiles.run_process(src_dir, target=_run_notification_worker_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.notifications import worker

        if once:
            await worker.run_once(get_sessionmaker())
            typer.secho("status pass complete", fg="green")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_scan_matching_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    async def _run() -> None:
        from serversherpa.scans import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass    # watchfiles stops the old process with SIGINT on reload


@app.command()
def scan_matching_worker(
    poll_seconds: float = typer.Option(
        2.0, help="Idle sleep between raw-scan polls"),
    once: bool = typer.Option(
        False, help="One batch pass, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart when api/src changes "
                    "(uvicorn-style)"),
) -> None:
    """Run the scan-matching worker — matches raw scans to entities,
    applies status rules, and moves them to processed_scans."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[scan-matching-worker] dev reload — watching {src_dir}",
                    fg="cyan")
        watchfiles.run_process(src_dir,
                               target=_run_scan_matching_worker_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.scans import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed a batch" if worked else "inbox empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


if __name__ == "__main__":
    app()
