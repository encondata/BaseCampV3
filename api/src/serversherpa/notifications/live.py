"""Live inbox signals (SS-500). A change to someone's inbox runs
`pg_notify('ss_inbox', '<person_id>')` on the writer's own session, so
Postgres delivers it only if that transaction commits. Each API process
keeps one dedicated LISTEN connection (`InboxHub`) and pokes the queues of
that person's open streams. The signal carries no content: a stream that
gets a poke re-reads the inbox over the normal, authorized HTTP call."""

import asyncio
import contextlib
import logging
import uuid

import asyncpg
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.engine import connect_args, get_application_name

log = logging.getLogger(__name__)

INBOX_CHANNEL = "ss_inbox"

BACKOFF_START = 1.0         # seconds before the first reconnect attempt
BACKOFF_MAX = 30.0
HEALTH_INTERVAL = 15.0      # how often an idle listen connection is checked
HEALTH_TIMEOUT = 10.0
CLOSE_TIMEOUT = 5.0


async def signal_inbox(db: AsyncSession, person_id: uuid.UUID) -> None:
    """Queue an inbox signal for `person_id` on the caller's transaction.
    Never commits: the NOTIFY goes out when (and only if) the caller's
    commit does."""
    await db.execute(text("SELECT pg_notify(:ch, :pid)"),
                      {"ch": INBOX_CHANNEL, "pid": str(person_id)})


async def connect_raw(suffix: str = "-inbox") -> asyncpg.Connection:
    """A plain asyncpg connection to the app's database, with the engine's
    TLS settings and this process's application_name plus `suffix`."""
    settings = get_settings()
    url = make_url(settings.database_url.get_secret_value().replace("+asyncpg", ""))
    kwargs = connect_args(settings)
    kwargs["server_settings"] = {"application_name": get_application_name(suffix)}
    return await asyncpg.connect(
        user=url.username, password=url.password, host=url.host,
        port=url.port, database=url.database, **kwargs)


class InboxHub:
    """One LISTEN connection per process, fanning signals out to per-person
    queues. Each queue holds at most one pending poke: one is as good as ten,
    since the reader re-reads the whole inbox anyway."""

    def __init__(self) -> None:
        self._subs: dict[uuid.UUID, set[asyncio.Queue[None]]] = {}
        self._conn: asyncpg.Connection | None = None
        self._lost = asyncio.Event()
        self._starting: asyncio.Future | None = None
        self._supervisor: asyncio.Task | None = None
        self._stopping = False
        self.loop: asyncio.AbstractEventLoop | None = None

    # ── subscriptions ────────────────────────────────────────────────

    def subscribe(self, person_id: uuid.UUID) -> asyncio.Queue[None]:
        q: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
        self._subs.setdefault(person_id, set()).add(q)
        return q

    def unsubscribe(self, person_id: uuid.UUID, q: asyncio.Queue[None]) -> None:
        queues = self._subs.get(person_id)
        if queues is None:
            return
        queues.discard(q)
        if not queues:
            del self._subs[person_id]

    def _poke(self, queues) -> None:
        for q in list(queues):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(None)

    def _poke_everyone(self) -> None:
        for queues in list(self._subs.values()):
            self._poke(queues)

    def _on_notify(self, _conn, _pid, _channel, payload: str) -> None:
        try:
            person_id = uuid.UUID(payload)
        except (ValueError, TypeError, AttributeError):
            return
        queues = self._subs.get(person_id)
        if queues:
            self._poke(queues)

    def _on_terminated(self, conn) -> None:
        if conn is self._conn:
            self._lost.set()

    # ── connection lifecycle ─────────────────────────────────────────

    async def start(self) -> None:
        """Connect and LISTEN, then keep it up. Idempotent and safe to await
        from several callers at once. A failed first connect does not raise:
        the supervisor keeps retrying with backoff."""
        if self._starting is None:
            self.loop = asyncio.get_running_loop()
            self._starting = asyncio.ensure_future(self._first_start())
        await asyncio.shield(self._starting)

    async def _first_start(self) -> None:
        connected = False
        try:
            await self._connect()
            connected = True
        except Exception:
            log.warning("inbox listen connection failed; retrying", exc_info=True)
        self._supervisor = asyncio.create_task(self._supervise(connected))

    async def _connect(self) -> None:
        conn = await connect_raw("-inbox")
        try:
            await conn.add_listener(INBOX_CHANNEL, self._on_notify)
        except BaseException:
            conn.terminate()
            raise
        self._lost.clear()
        self._conn = conn
        conn.add_termination_listener(self._on_terminated)

    async def _healthy(self) -> bool:
        conn = self._conn
        if conn is None or conn.is_closed():
            return False
        try:
            await asyncio.wait_for(conn.execute("SELECT 1"), HEALTH_TIMEOUT)
        except Exception:  # noqa: BLE001 - any failure means reconnect
            return False
        return True

    async def _supervise(self, connected: bool) -> None:
        while not self._stopping:
            if connected:
                # Wait for the connection to drop, checking it now and then
                # so a half-open socket is noticed too.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._lost.wait(), HEALTH_INTERVAL)
                if not self._lost.is_set() and await self._healthy():
                    continue
                log.warning("inbox listen connection lost; reconnecting")
                await self._drop_conn()
                connected = False
            delay = BACKOFF_START
            while not self._stopping and not connected:
                await asyncio.sleep(delay)
                try:
                    await self._connect()
                    connected = True
                except Exception:
                    log.warning("inbox listen reconnect failed; next try in %.0f s",
                                min(delay * 2, BACKOFF_MAX), exc_info=True)
                    delay = min(delay * 2, BACKOFF_MAX)
            if connected:
                # Signals sent while it was down are lost: everyone re-reads.
                self._poke_everyone()

    async def _drop_conn(self) -> None:
        conn, self._conn = self._conn, None
        if conn is None or conn.is_closed():
            return
        try:
            await asyncio.wait_for(conn.close(), CLOSE_TIMEOUT)
        except Exception:  # noqa: BLE001 - a close that fails is aborted instead
            conn.terminate()

    async def stop(self) -> None:
        self._stopping = True
        if self._starting is not None and not self._starting.done():
            with contextlib.suppress(Exception):
                await self._starting
        task, self._supervisor = self._supervisor, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        await self._drop_conn()


_hub: InboxHub | None = None


async def get_hub() -> InboxHub:
    """This process's hub, created and started on first use."""
    global _hub
    hub = _hub
    loop = asyncio.get_running_loop()
    if hub is not None and hub.loop is not None and hub.loop is not loop:
        # Left over from another event loop (a previous TestClient): its
        # connection belongs to that loop and cannot be used or closed here.
        hub = None
    if hub is None:
        hub = _hub = InboxHub()
    await hub.start()
    return hub


async def stop_hub() -> None:
    """Stop this process's hub (app shutdown) and forget it."""
    global _hub
    hub, _hub = _hub, None
    if hub is None:
        return
    if hub.loop is not None and hub.loop is not asyncio.get_running_loop():
        # Its tasks and connection belong to another (likely closed) loop:
        # nothing here can await them, so just drop the socket.
        hub._stopping = True
        if hub._conn is not None:
            with contextlib.suppress(Exception):
                hub._conn.terminate()
        return
    await hub.stop()
