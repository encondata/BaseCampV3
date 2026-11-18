"""`devices` command line: the API server and the background worker."""

import asyncio
from pathlib import Path

import typer

app = typer.Typer(help="ServerSherpa Devices — app distribution for crew devices.",
                  no_args_is_help=True)


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", help="Address to bind."),
    port: int = typer.Option(8099, help="Port to listen on."),
    reload: bool = typer.Option(False, help="Restart on code changes (development)."),
) -> None:
    """Run the devices API (and the built web app, when DEVICES_STATIC_DIR is set)."""
    import uvicorn

    uvicorn.run("serversherpa_devices.api.app:create_app", factory=True,
                host=host, port=port, reload=reload)


@app.command()
def worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls (seconds)."),
    once: bool = typer.Option(False, help="Process at most one job, then exit."),
    reload: bool = typer.Option(False, help="Restart whenever the code changes (development)."),
) -> None:
    """Run the background worker (Apple registration, profiles, re-signing)."""
    from serversherpa_devices.worker import run

    if reload and once:
        typer.secho("--once can't be combined with --reload", fg="red")
        raise typer.Exit(1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[devices worker] dev reload, watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=run.reload_child, args=(poll_seconds,))
        return

    run.configure_logging()

    async def _run() -> None:
        from serversherpa_devices.db.engine import dispose_engine

        try:
            if once:
                worked = await run.run_once()
                typer.secho("processed 1 job" if worked else "queue empty",
                            fg="green" if worked else "yellow")
            else:
                await run.run_forever(poll_seconds)
        finally:
            await dispose_engine()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
