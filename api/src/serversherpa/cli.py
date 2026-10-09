"""ServerSherpa operations CLI.

    serversherpa bootstrap-admin --email you@company.com --first-name You --last-name Name \
        [--role super_admin] [--password-stdin | --invite] [--link-minutes 240]

Helper scripts belong here as commands sharing the service layer —
never as standalone scripts with their own DB code.
"""

import asyncio
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

import typer
from sqlalchemy import select

from serversherpa.db.engine import dispose_engine, get_sessionmaker, set_application_name
from serversherpa.db.models import UserAccount
from serversherpa.services.password_policy import (
    PasswordReused,
    apply_password,
    assert_not_reused,
    load_policy,
)

app = typer.Typer(no_args_is_help=True, help="ServerSherpa operations CLI",
                  pretty_exceptions_show_locals=False)   # a traceback never shows a password


def _name_connections(command: str) -> None:
    """Name this worker's database connections after its CLI command, so
    pg_stat_activity (Dev > Database > Health) can tell the workers apart.
    Call before the first query: the name is baked in when the engine builds."""
    set_application_name(f"serversherpa-{command}")


@app.callback()
def _main() -> None:
    """ServerSherpa operations CLI."""


# bootstrap-admin's exit codes (Sirdar's step 11 reads them; 2 is typer's usage error).
# 1 is never used on purpose: docker compose exec, ss-stack's die and Python's
# uncaught exceptions all exit 1. A crash here is 6; "already there, done" is 10.
EXIT_ACCOUNT_EXISTS = 10
EXIT_USAGE = 2
EXIT_PASSWORD_REFUSED = 3
EXIT_ROLE_UNKNOWN = 4
EXIT_MAIL_OFF = 5
EXIT_FAILED = 6
EXIT_PERSON_EXISTS = 7
EXIT_EMAIL_INVALID = 8
_EXIT_CODES = {"account_exists": EXIT_ACCOUNT_EXISTS, "password_too_short": EXIT_PASSWORD_REFUSED,
               "role_unknown": EXIT_ROLE_UNKNOWN, "mail_not_configured": EXIT_MAIL_OFF,
               "person_exists": EXIT_PERSON_EXISTS, "link_required": EXIT_USAGE,
               "email_invalid": EXIT_EMAIL_INVALID}


async def _create_first_admin(**kwargs):
    """One session: create, commit, dispose (tests replace this)."""
    from serversherpa.services.first_admin import create_admin

    try:
        async with get_sessionmaker()() as db:
            result = await create_admin(db, **kwargs)
            await db.commit()
            return result
    finally:
        await dispose_engine()


@app.command()
def bootstrap_admin(
    email: str = typer.Option(..., help="Login email for the admin account"),
    first_name: str = typer.Option(...),
    last_name: str = typer.Option(...),
    role: str = typer.Option("admin", help="The role to grant, e.g. super_admin"),
    password_stdin: bool = typer.Option(
        False, "--password-stdin", help="Read the password from stdin (one line); no prompt"),
    invite: bool = typer.Option(
        False, "--invite", help="No password: email a set-password link (needs --link-minutes)"),
    link_minutes: int | None = typer.Option(
        None, "--link-minutes", min=1, max=1440,
        help="Email a link valid this many minutes: change-password, or set-password with "
             "--invite"),
) -> None:
    """Create the first admin: person + account + role grant, and optionally
    the account-ready or invite email. The password never goes in argv."""
    from serversherpa.services.first_admin import FirstAdminError

    if password_stdin and invite:
        typer.secho("Use --password-stdin or --invite, not both.", fg="red", err=True)
        raise typer.Exit(code=EXIT_USAGE)
    if invite and link_minutes is None:
        typer.secho("--invite needs --link-minutes (how long the set-password link works).",
                    fg="red", err=True)
        raise typer.Exit(code=EXIT_USAGE)
    password: str | None = None
    if password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
        if not password:
            typer.secho("No password was given on stdin.", fg="red", err=True)
            raise typer.Exit(code=EXIT_USAGE)
    elif not invite:
        password = typer.prompt("Password", hide_input=True, confirmation_prompt=True)
    try:
        result = asyncio.run(_create_first_admin(
            email=email, first_name=first_name, last_name=last_name, role=role,
            password=password, link_minutes=link_minutes))
    except FirstAdminError as e:
        messages = {
            "account_exists": f"An account for {email} already exists.",
            "password_too_short": "The password is too short: use at least "
                                  f"{e.extra.get('min_length')} characters.",
            "person_exists": f"A person with the email {email} already exists but has no "
                             "account; give them one from the portal, or use another email.",
            "role_unknown": f"There is no global role named {role}.",
            "mail_not_configured": "Email isn't configured (SS_SMTP_HOST and SS_SMTP_FROM), "
                                   "so an invite can't be sent.",
            "link_required": "--invite needs --link-minutes.",
            "email_invalid": f"The portal can't sign in with {email}: "
                             f"{e.extra.get('reason')}",
        }
        typer.secho(messages.get(e.code, e.code), fg="red", err=True)
        raise typer.Exit(code=_EXIT_CODES.get(e.code, EXIT_USAGE)) from None
    except Exception as e:
        # the class name only: a message or repr can carry SQL parameters
        typer.secho(f"Couldn't create the first admin ({type(e).__name__}); see the "
                    "environment's API log.", fg="red", err=True)
        raise typer.Exit(code=EXIT_FAILED) from None
    kind = "invited" if invite else "created"
    typer.secho(f"Admin {kind}: {first_name} {last_name} <{email}> as {role} "
                f"(person {result.person_id})", fg="green")
    if link_minutes and not result.emailed:
        typer.secho("No email was sent: email isn't configured.", fg="yellow", err=True)


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
def import_v2_models(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file "
                                       "(INSERT-statement format)"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
) -> None:
    """Import the entire V2 make/model catalog (+ fuzzy-lookup aliases)
    from a legacy BaseCamp V2 dump. Each created row notes its V2
    provenance in the knowledge field. Additive: re-runs skip existing
    legacy_ids and (make, model) pairs."""

    async def _run() -> None:
        from serversherpa.assets.v2_import import import_model_catalog
        from serversherpa.services.audit import audit

        async with get_sessionmaker()() as db:
            stats = await import_model_catalog(db, dump)
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] would import: {stats}", fg="yellow")
            else:
                audit(db, actor_id=None, entity_type="asset_model",
                      entity_id=None, action="import",
                      changes={"source": dump.rsplit("/", 1)[-1], **stats})
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
def seed_demo_trucks() -> None:
    """Seed the two demo trucks (idempotent by name) used for live
    verification of the trucks feature."""

    async def _run() -> None:
        from serversherpa.trucks.seed import seed_demo_trucks as _seed

        async with get_sessionmaker()() as db:
            added = await _seed(db)
            await db.commit()
            typer.secho(f"Seeded {added} truck(s).", fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command()
def seed_demo_warehouse() -> None:
    """Seed the demo warehouse containers and stock lines (idempotent by
    name/description) used for live verification of the warehouse
    feature."""

    async def _run() -> None:
        from serversherpa.warehouse.seed import seed_demo_warehouse as _seed

        async with get_sessionmaker()() as db:
            added = await _seed(db)
            await db.commit()
            typer.secho(f"Seeded {added} row(s).", fg="green")
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
        async with get_sessionmaker()() as db:
            account = await db.scalar(
                select(UserAccount).where(UserAccount.email == email))
            if account is None:
                typer.secho(f"No account found for {email}.", fg="red")
                raise typer.Exit(code=1)

            try:
                await assert_not_reused(db, await load_policy(db), account, password)
            except PasswordReused as exc:
                typer.secho(f"That password was one of the last {exc.count} used for "
                            f"{email}. Choose a different one.", fg="red")
                raise typer.Exit(code=1) from None
            await apply_password(db, account, password, must_change=False,
                                 now=datetime.now(UTC))
            await db.commit()
            typer.secho(f"Password updated for {email}.", fg="green")
        await dispose_engine()

    asyncio.run(_run())


@app.command(name="reset-totp")
def reset_totp(
    email: str = typer.Option(..., help="Login email of the account to reset"),
) -> None:
    """Last-resort 2FA reset: forget the authenticator, backup codes and
    trusted browsers. The user enrolls again at their next sign-in if
    policy requires it."""

    async def _run() -> None:
        from serversherpa.services import totp as totp_service

        async with get_sessionmaker()() as db:
            account = await db.scalar(
                select(UserAccount).where(UserAccount.email == email))
            if account is None:
                typer.secho(f"No account found for {email}.", fg="red")
                raise typer.Exit(code=1)
            await totp_service.reset(db, account, actor_id=None, ip=None)
            await db.commit()
            typer.secho(f"Two-factor reset for {email}.", fg="green")
        await dispose_engine()

    asyncio.run(_run())


def _run_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point. Module-level (picklable) so
    watchfiles can re-spawn it in a fresh process after every change;
    hard restarts are safe by the worker's design (batched commits +
    stale-job requeue on startup)."""

    _name_connections("import-worker")

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

    _name_connections("import-worker")

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


_HOMEBREW_LIB = Path("/opt/homebrew/lib")


def _ensure_pango_on_macos(*, exec_self: bool) -> None:
    """Dev-only: make WeasyPrint's dylibs findable under honcho.

    Homebrew's Pango lives outside dyld's default search path, so
    WeasyPrint needs DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib — and
    that variable cannot be handed down: honcho starts every Procfile
    line through `/bin/sh -c` (Popen(shell=True)), and SIP strips every
    DYLD_* variable whenever a protected system binary such as /bin/sh is
    exec'd. Setting it in `.env` or exporting it in the parent shell
    therefore does nothing at all. Verified 2026-09-09:
    `honcho run … python -c 'os.environ'` shows the .env's SS_* variables
    arriving and DYLD_FALLBACK_LIBRARY_PATH gone.

    So set it here instead, in the worker's own process tree, where no
    protected binary sits in the way. dyld only reads DYLD_* at process
    start, so a process that is about to load WeasyPrint itself has to
    re-exec (`exec_self=True`); the reload supervisor does not — it only
    needs the variable in os.environ so the worker children it spawns from
    this same python inherit it. SS_DYLD_SHIM stops any of it happening
    twice.
    """
    # Under pytest this must do nothing: setting DYLD_* (let alone
    # re-exec'ing) from inside a test process would leak into the whole
    # session and, in exec_self mode, restart the test runner itself.
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if (sys.platform != "darwin"
            or os.environ.get("SS_DYLD_SHIM")
            or os.environ.get("DYLD_FALLBACK_LIBRARY_PATH")
            or not (_HOMEBREW_LIB / "libpango-1.0.dylib").exists()):
        return
    os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = str(_HOMEBREW_LIB)
    os.environ["SS_DYLD_SHIM"] = "1"
    if exec_self:
        os.execve(sys.executable, [sys.executable, *sys.argv], os.environ)


def _run_report_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    _name_connections("report-worker")

    async def _run() -> None:
        from serversherpa.reports import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command()
def report_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one run, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
) -> None:
    """Run the report worker — renders queued report_runs into PDFs, stores
    them in Spaces, attaches them to the initiative, and notifies."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        # the supervisor never loads WeasyPrint — its children do, and they
        # are spawned from this python, so os.environ is enough here
        _ensure_pango_on_macos(exec_self=False)
        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[report-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_report_worker_process,
                               args=(poll_seconds,))
        return

    _ensure_pango_on_macos(exec_self=True)      # re-execs; nothing above may
                                                # have imported WeasyPrint yet

    _name_connections("report-worker")

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.reports import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 run" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_label_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    _name_connections("label-worker")

    async def _run() -> None:
        from serversherpa.labels.generate import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command()
def label_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one run, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
) -> None:
    """Run the label worker — renders queued label_generation_runs into
    generated_labels rows for every asset on the initiative."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[label-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_label_worker_process,
                               args=(poll_seconds,))
        return

    _name_connections("label-worker")

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.labels.generate import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 run" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_wiki_worker_process(poll_seconds: float, kinds: frozenset[str] | None = None) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    from serversherpa.wiki import worker

    _name_connections(worker.process_name(kinds or worker.JOB_KINDS))

    async def _run() -> None:
        await worker.run_forever(poll_seconds, kinds=kinds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command(name="wiki-worker")
def wiki_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one job, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
    kinds: str | None = typer.Option(
        None, help="Handle only these job kinds (comma-separated, e.g. export)"),
    exclude_kinds: str | None = typer.Option(
        None, help="Handle every job kind but these (comma-separated, e.g. export)"),
) -> None:
    """Run the wiki worker — office-file PDF previews, text extraction for
    search, storage purges after delete-forever, exports, review
    reminders, the daily retention sweep and the hourly trash expiry
    sweep. Needs LibreOffice (soffice), poppler (pdftotext) and
    WeasyPrint. Production splits exports into their own worker
    (--kinds export) beside one with --exclude-kinds export."""
    from serversherpa.wiki import worker

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    try:
        handles = worker.resolve_kinds(kinds, exclude_kinds)
    except ValueError as exc:
        typer.secho(str(exc), fg="red")
        raise typer.Exit(code=1) from exc
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[wiki-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_wiki_worker_process,
                               args=(poll_seconds, handles))
        return

    # the registry/log name, so the export worker and the main one differ
    _name_connections(worker.process_name(handles))

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker

        if once:
            worked = await worker.run_once(get_sessionmaker(), kinds=handles)
            typer.secho("processed 1 job" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds, kinds=handles)
        await dispose_engine()

    asyncio.run(_run())


def _run_spec_lookup_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    _name_connections("spec-lookup-worker")

    async def _run() -> None:
        from serversherpa.spec_lookup import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command()
def spec_lookup_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one job, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
) -> None:
    """Run the spec lookup worker — asks Claude for missing Makes / Models
    specs one model at a time and records verified suggestions."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[spec-lookup-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_spec_lookup_worker_process,
                               args=(poll_seconds,))
        return

    _name_connections("spec-lookup-worker")

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.spec_lookup import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 job" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_db_testing_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    _name_connections("db-testing-worker")

    async def _run() -> None:
        from serversherpa.devtools.testing import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command(name="db-testing-worker")
def db_testing_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one session, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
) -> None:
    """Run the db-testing worker — snapshots the database when a Testing
    session starts and restores it when a session is reverted. Does not
    honor the read-only worker pause: it is the process that sets it
    during a revert."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[db-testing-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_db_testing_worker_process,
                               args=(poll_seconds,))
        return

    _name_connections("db-testing-worker")

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.devtools.testing import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 session" if worked else "nothing to do",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


@app.command(name="cert-worker")
def cert_worker(
    once: bool = typer.Option(False, help="One check now, print its outcome, then exit "
                                          "(stop the cert-worker service first: it owns :8089)"),
    renew_days: float = typer.Option(30.0, help="Renew at this many days left or fewer "
                                                "(raise it to force a renewal)"),
) -> None:
    """Run the cert-worker on a DigitalOcean droplet (Sirdar phase 7):
    renews the load balancer's Let's Encrypt certificate from the active
    slot. Idles where SS_CERT_* aren't set."""

    _name_connections("cert-worker")

    async def _run() -> None:
        from serversherpa.certs import acme, worker

        try:
            outcome = await worker.run_forever(once=once, renew_days=renew_days)
            if once:
                typer.echo(outcome)
        except (worker.CertWorkerError, acme.AcmeError) as e:
            typer.secho(e.reason, fg="red", err=True)   # our own copy, never a secret
            raise typer.Exit(code=1) from None
        except Exception as e:  # noqa: BLE001 — never print an unknown error's text
            typer.secho(f"cert-worker: check failed ({type(e).__name__})", fg="red", err=True)
            raise typer.Exit(code=1) from None
        finally:
            await dispose_engine()

    asyncio.run(_run())


def _run_log_service_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    _name_connections("log-service")

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

    _name_connections("log-service")

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

    _name_connections("notification-worker")

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
        5.0, help="Seconds between outbox delivery passes"),
    once: bool = typer.Option(
        False, help="One status pass and one email delivery pass, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart when api/src changes "
                    "(uvicorn-style)"),
) -> None:
    """Run the notification worker — delivers the email outbox, sends the
    hourly password-expiry reminders, and logs periodic status lines."""

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

    _name_connections("notification-worker")

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.notifications import worker

        if once:
            from serversherpa.mail.delivery import deliver_once

            maker = get_sessionmaker()
            await worker.run_once(maker)
            sent = await deliver_once(maker)
            typer.secho(f"status pass complete; processed {sent} queued email(s)",
                        fg="green")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())


def _run_scan_matching_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (picklable, like the import
    worker's)."""

    _name_connections("scan-matching-worker")

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

    _name_connections("scan-matching-worker")

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
