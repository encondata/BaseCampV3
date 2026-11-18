"""`devices` command line: the API server and the background worker."""

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
def worker() -> None:
    """Run the background worker (Apple registration, profiles, re-signing)."""
    typer.echo("The devices worker isn't built yet.")
    raise typer.Exit(1)
