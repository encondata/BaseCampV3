"""Custom (SSH) connection test. The server's host key must already be
trusted (known_hosts); the connect step pins that stored key. Error
reasons are our own copy — asyncssh messages never reach the caller."""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Iterator
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Self

import asyncssh
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, known_hosts

CONNECT_TIMEOUT = 15
CONNECT_TRIES = 5            # the office network drops many outbound port-22 connections
CONNECT_RETRY_DELAY = 3.0
COMMAND_TIMEOUT = 10
RUN_TIMEOUT = 60
OUTPUT_LIMIT = 256 * 1024
CHECKS_BUDGET_SECONDS = 30
_MAX_VALUE = 200
_AUTH_FAILED = "The SSH server rejected the username, password or key."
_UNLOCK_FAILED = "Couldn't unlock the SSH key (check the passphrase)."

_GB = 1024 * 1024            # KiB per GiB
MIN_DISK_GB = 10
MIN_MEMORY_GB = 2


async def with_connect_retry[T](host: str, port: int, attempt: Callable[[], Awaitable[T]], *,
                             tries: int = CONNECT_TRIES,
                             log: Callable[[str], None] | None = None,
                             sleep: Callable[[float], Awaitable[None]] | None = None) -> T:
    """Run `attempt`, trying again when the host didn't answer (Unreachable).
    Host-key and login failures propagate at once; the last failure is
    re-raised unchanged."""
    sleep = sleep or asyncio.sleep
    for n in range(1, tries + 1):
        try:
            return await attempt()
        except known_hosts.Unreachable:
            if n == tries:
                raise
        if log:
            log(f"Couldn't reach {host}:{port}; trying again ({n + 1} of {tries}).\n")
        await sleep(CONNECT_RETRY_DELAY)
    raise AssertionError("unreachable")        # tries < 1


class HostKeyUnknown(Exception):
    def __init__(self, host: str, port: int, key_type: str, fingerprint: str):
        super().__init__(f"unknown host key for {host}:{port}")
        self.host, self.port, self.key_type, self.fingerprint = host, port, key_type, fingerprint


class HostKeyMismatch(Exception):
    def __init__(self, host: str, port: int, expected: str, actual: str, key_type: str):
        super().__init__(f"host key mismatch for {host}:{port}")
        self.host, self.port = host, port
        self.expected, self.actual, self.key_type = expected, actual, key_type


@dataclass(frozen=True)
class SshTargetConfig:
    """What a connection test needs. `key_file` is the resolved path (None
    when no key, or when the configured name would escape deploy-keys);
    `key_name` is what the user configured, for messages. Secrets are kept
    out of repr(). `sudo_password` is the password for sudo when it differs
    from the SSH password (key-only targets)."""

    host: str
    port: int
    user: str
    password: str | None = field(default=None, repr=False)
    key_file: str | None = None
    key_name: str = ""
    passphrase: str | None = field(default=None, repr=False)
    sudo_password: str | None = field(default=None, repr=False)
    # An unencrypted OpenSSH private key held in memory (a Proxmox VM's key,
    # decrypted from proxmox_vms); used instead of key_file.
    private_key: str | None = field(default=None, repr=False)

    @property
    def auth_label(self) -> str:
        key, password = bool(self.key_name) or self.private_key is not None, \
            self.password is not None
        return "key + password" if key and password else "key" if key else "password"

    @classmethod
    def from_settings(cls, s: Settings) -> "SshTargetConfig":
        """The installer target (SIRDAR_DEPLOY_SSH_* in .env)."""
        return cls(
            host=s.deploy_ssh_host.strip(), port=s.deploy_ssh_port,
            user=s.deploy_ssh_user.strip(),
            password=(s.deploy_ssh_password.get_secret_value()
                      if s.deploy_ssh_password is not None else None),
            key_file=s.deploy_ssh_key_file, key_name=s.deploy_ssh_key_path.strip(),
            passphrase=(s.deploy_ssh_key_passphrase.get_secret_value()
                        if s.deploy_ssh_key_passphrase is not None else None))


async def load_client_key(cfg: SshTargetConfig) -> asyncssh.SSHKey | None:
    if cfg.private_key is not None:
        try:
            return asyncssh.import_private_key(cfg.private_key)
        except (asyncssh.KeyImportError, ValueError):
            raise ConnectFailed("Sirdar's key for this VM can't be read.") from None
    raw = cfg.key_name
    if not raw:
        return None
    name = PurePosixPath(raw).name or raw          # never the folder path
    not_found = ConnectFailed(f"The SSH key file {name} wasn't found in deploy-keys.")
    path = cfg.key_file
    if path is None:                               # a relative name that would escape the folder
        raise not_found
    try:
        return await asyncio.to_thread(asyncssh.read_private_key, path, cfg.passphrase)
    except OSError:
        raise not_found from None
    except asyncssh.KeyEncryptionError:
        raise ConnectFailed(_UNLOCK_FAILED) from None
    except asyncssh.KeyImportError as exc:
        if "passphrase" in str(exc).lower():      # encrypted key, no passphrase given
            raise ConnectFailed(_UNLOCK_FAILED) from None
        raise ConnectFailed(f"The SSH key file {name} isn't a private key Sirdar can read.") \
            from None


async def _run(conn: asyncssh.SSHClientConnection, command: str) -> tuple[int | None, str]:
    """(exit status, first stdout line); exit None when the command didn't answer."""
    try:
        result = await asyncio.wait_for(conn.run(command, check=False, errors="replace"),
                                        COMMAND_TIMEOUT)
    except (OSError, TimeoutError, asyncssh.Error):
        return None, ""
    out = result.stdout if isinstance(result.stdout, str) else ""
    line = next((ln.strip() for ln in out.splitlines() if ln.strip()), "")
    return result.exit_status, line[:_MAX_VALUE]


def _text_check(label: str, status: int | None, line: str, missing: str) -> Check:
    if status is None:
        return Check(label, "fail", "No answer")
    if status == 0 and line:
        return Check(label, "pass", line)
    return Check(label, "warn", missing)


def _number(line: str, index: int) -> float | None:
    try:
        return float(line.split()[index])
    except (IndexError, ValueError):
        return None


_TEXT_CHECKS = (
    ("OS", '. /etc/os-release && echo "$PRETTY_NAME"', "Unknown"),
    ("Kernel", "uname -srm", "Unknown"),
    ("Docker", "docker --version", "Not installed"),
    ("Compose", "docker compose version", "Not available"),
)
_CHECK_LABELS = ["OS", "Kernel", "Docker", "Compose", "Disk", "Memory"]


async def _run_checks(conn: asyncssh.SSHClientConnection, done: list[Check]) -> None:
    """Run the checks in order, appending each to `done` as it finishes so a
    timeout keeps the completed ones."""
    for label, command, missing in _TEXT_CHECKS:
        done.append(_text_check(label, *(await _run(conn, command)), missing))

    status, line = await _run(conn, "df -Pk / | tail -1")
    free_kib = _number(line, 3) if status == 0 else None
    if status is None:
        done.append(Check("Disk", "fail", "No answer"))
    elif free_kib is None:
        done.append(Check("Disk", "warn", "Unknown"))
    else:
        gb = free_kib / _GB
        done.append(Check("Disk", "pass" if gb >= MIN_DISK_GB else "warn",
                          f"{gb:.1f} GB free on /"))

    status, line = await _run(conn, "grep MemTotal /proc/meminfo")
    total_kib = _number(line, 1) if status == 0 else None
    if status is None:
        done.append(Check("Memory", "fail", "No answer"))
    elif total_kib is None:
        done.append(Check("Memory", "warn", "Unknown"))
    else:
        gb = total_kib / _GB
        done.append(Check("Memory", "pass" if gb >= MIN_MEMORY_GB else "warn", f"{gb:.1f} GB"))


async def _checks(conn: asyncssh.SSHClientConnection) -> list[Check]:
    done: list[Check] = []
    try:
        await asyncio.wait_for(_run_checks(conn, done), CHECKS_BUDGET_SECONDS)
    except TimeoutError:
        pass
    done.extend(Check(label, "fail", "No answer") for label in _CHECK_LABELS[len(done):])
    return done


@dataclass(frozen=True)
class PinnedHost:
    """A host whose live key matches the trusted one in ssh_known_hosts."""

    key: asyncssh.SSHKey
    key_type: str
    fingerprint: str
    public_key: str            # the stored OpenSSH public key line


async def pinned_host_key(db: AsyncSession, host: str, port: int, *, tries: int = CONNECT_TRIES,
                          log: Callable[[str], None] | None = None) -> PinnedHost:
    """Fetch the live host key of the trusted key's type and compare it with
    the trusted one. Raises HostKeyUnknown, HostKeyMismatch or ConnectFailed;
    never logs in."""
    stored = await known_hosts.lookup(db, host, port)
    key_type = stored.key_type if stored else None
    live = await with_connect_retry(
        host, port, lambda: known_hosts.fetch_key_of_type(host, port, key_type),
        tries=tries, log=log)
    actual, key_type = known_hosts.fingerprint(live), live.get_algorithm()
    if stored is None:
        raise HostKeyUnknown(host, port, key_type, actual)
    if stored.fingerprint_sha256 != actual:
        raise HostKeyMismatch(host, port, stored.fingerprint_sha256, actual, key_type)
    try:
        pinned = asyncssh.import_public_key(stored.public_key)
    except (asyncssh.KeyImportError, ValueError):
        raise ConnectFailed("Sirdar's saved key for this host is unreadable. "
                            "Forget the host and trust it again.") from None
    return PinnedHost(key=pinned, key_type=key_type, fingerprint=actual,
                      public_key=stored.public_key)


class _HostKeyRejected(ConnectFailed):
    """The login refused the server's key (it isn't the pinned one)."""


async def _login_pinned(cfg: SshTargetConfig, pinned: PinnedHost, *, tries: int,
                        log: Callable[[str], None] | None = None
                        ) -> asyncssh.SSHClientConnection:
    client_key = await load_client_key(cfg)
    return await with_connect_retry(
        cfg.host, cfg.port, lambda: _connect(cfg, pinned, client_key), tries=tries, log=log)


async def open_pinned(cfg: SshTargetConfig, db: AsyncSession, *, tries: int = CONNECT_TRIES,
                      log: Callable[[str], None] | None = None
                      ) -> tuple[asyncssh.SSHClientConnection, PinnedHost]:
    """Log in with the stored host key pinned: one connection when the key
    still matches. The live key is fetched only to explain a refusal
    (HostKeyUnknown with no stored key, HostKeyMismatch when it changed)."""
    stored = await known_hosts.lookup(db, cfg.host, cfg.port)
    if stored is None:
        await pinned_host_key(db, cfg.host, cfg.port, tries=tries, log=log)   # raises HostKeyUnknown
        raise ConnectFailed("The host's key was trusted while connecting. Try again.")
    try:
        key = asyncssh.import_public_key(stored.public_key)
    except (asyncssh.KeyImportError, ValueError):
        raise ConnectFailed("Sirdar's saved key for this host is unreadable. "
                            "Forget the host and trust it again.") from None
    pinned = PinnedHost(key=key, key_type=stored.key_type,
                        fingerprint=stored.fingerprint_sha256, public_key=stored.public_key)
    try:
        return await _login_pinned(cfg, pinned, tries=tries, log=log), pinned
    except _HostKeyRejected as rejected:
        live = await with_connect_retry(
            cfg.host, cfg.port,
            lambda: known_hosts.fetch_key_of_type(cfg.host, cfg.port, stored.key_type),
            tries=tries, log=log)
        actual = known_hosts.fingerprint(live)
        if actual == stored.fingerprint_sha256:
            raise rejected from None
        raise HostKeyMismatch(cfg.host, cfg.port, stored.fingerprint_sha256, actual,
                              live.get_algorithm()) from None


async def connect_pinned(cfg: SshTargetConfig, pinned: PinnedHost, *,
                         tries: int = CONNECT_TRIES,
                         log: Callable[[str], None] | None = None
                         ) -> asyncssh.SSHClientConnection:
    """Log in, accepting only the pinned host key."""
    return await _login_pinned(cfg, pinned, tries=tries, log=log)


async def _connect(cfg: SshTargetConfig, pinned: PinnedHost,
                   client_key: asyncssh.SSHKey | None) -> asyncssh.SSHClientConnection:
    try:
        return await asyncio.wait_for(asyncssh.connect(
            cfg.host, port=cfg.port, username=cfg.user, password=cfg.password,
            client_keys=[client_key] if client_key else None,
            # Pin the stored key: (trusted host keys, trusted CA keys, revoked keys).
            known_hosts=([pinned.key], [], []),
            agent_path=None, config=None, connect_timeout=CONNECT_TIMEOUT,
        ), CONNECT_TIMEOUT + 5)
    except asyncssh.PermissionDenied:
        raise ConnectFailed(_AUTH_FAILED) from None
    except (asyncssh.HostKeyNotVerifiable, asyncssh.KeyExchangeFailed):
        # KeyExchangeFailed: the server no longer offers the pinned key's type.
        raise _HostKeyRejected("The server's host key changed during the test. Try again.") \
            from None
    except (OSError, TimeoutError, asyncssh.Error):
        raise known_hosts.unreachable(cfg.host, cfg.port) from None


async def test_connection(cfg: SshTargetConfig, db: AsyncSession, *,
                          target_id: str = "ssh") -> ConnectResult:
    pinned = await pinned_host_key(db, cfg.host, cfg.port, tries=1)
    conn = await connect_pinned(cfg, pinned, tries=1)      # the Test button: one quick attempt
    async with conn:
        checks = await _checks(conn)
    facts = {"host": cfg.host, "port": cfg.port, "user": cfg.user, "auth": cfg.auth_label,
             "key_type": pinned.key_type, "fingerprint": pinned.fingerprint}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target=target_id,
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name


@dataclass(frozen=True)
class CommandResult:
    exit_status: int | None            # None: no answer in time
    stdout: str = field(repr=False)    # may hold secrets (an adopted .env)


class SshPool:
    """One deployment's SSH connections, one per pinned host: the office
    network drops repeated connections to one address. Keyed by (host, port,
    user, stored fingerprint), so a re-trusted key gets a new connection.
    Every connection is made by open_pinned; leaving the pool closes them
    all, also on errors and cancellation."""

    def __init__(self) -> None:
        self._conns: dict[tuple, tuple[asyncssh.SSHClientConnection, PinnedHost]] = {}
        self._locks: dict[tuple, asyncio.Lock] = {}
        self._lost: set[tuple] = set()
        self._closing: list[asyncssh.SSHClientConnection] = []

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc) -> None:
        conns = [conn for conn, _ in self._conns.values()] + self._closing
        self._conns.clear()
        self._closing = []
        for conn in conns:                 # close all first, so a cancel mid-wait leaves none open
            conn.close()
        for conn in conns:
            await conn.wait_closed()

    async def connection(self, cfg: SshTargetConfig, db: AsyncSession, *,
                         tries: int = CONNECT_TRIES,
                         log: Callable[[str], None] | None = None
                         ) -> tuple[asyncssh.SSHClientConnection, PinnedHost]:
        """The open connection for this host, or a new pinned one; a
        replacement for a lost connection is logged first."""
        stored = await known_hosts.lookup(db, cfg.host, cfg.port)
        key = (cfg.host, cfg.port, cfg.user, stored.fingerprint_sha256 if stored else None)
        async with self._locks.setdefault(key, asyncio.Lock()):
            held = self._conns.get(key)
            if held is not None:
                if not held[0].is_closed():
                    return held
                self.discard(held[0])
            if key in self._lost and log:
                log(f"Lost the SSH connection to {cfg.host}; reconnecting.\n")
            held = await open_pinned(cfg, db, tries=tries, log=log)
            self._lost.discard(key)
            self._conns[key] = held
            return held

    def discard(self, conn: asyncssh.SSHClientConnection) -> None:
        """Drop a connection that broke; the next connection() for its host
        opens a new one."""
        for key, (held, _) in list(self._conns.items()):
            if held is conn:
                del self._conns[key]
                self._lost.add(key)
        conn.close()
        self._closing.append(conn)


current_pool: ContextVar[SshPool | None] = ContextVar("current_pool", default=None)


@contextlib.contextmanager
def using_pool(pool: SshPool) -> Iterator[SshPool]:
    """Route run_command through `pool` inside the block."""
    token = current_pool.set(pool)
    try:
        yield pool
    finally:
        current_pool.reset(token)


async def run_command(cfg: SshTargetConfig, db: AsyncSession, command: str, *,
                      timeout: float = RUN_TIMEOUT, input: str | None = None,
                      tries: int = CONNECT_TRIES,
                      log: Callable[[str], None] | None = None) -> CommandResult:
    """Run one command on a pinned host and return its stdout (capped at
    OUTPUT_LIMIT) for the caller to parse. Callers quote every argument and
    never log the output. `input` goes to the command's stdin (for secrets:
    never argv). `tries` caps the connection attempts; `log` hears each retry.
    Inside using_pool the pool's connection is reused and left open."""
    pool = current_pool.get()
    if pool is not None:
        return await _run_pooled(pool, cfg, db, command, timeout=timeout, input=input,
                                 tries=tries, log=log)
    conn, _ = await open_pinned(cfg, db, tries=tries, log=log)
    async with conn:
        try:
            result = await asyncio.wait_for(
                conn.run(command, check=False, errors="replace", input=input), timeout)
        except (OSError, TimeoutError, asyncssh.Error):
            return CommandResult(None, "")
    out = result.stdout if isinstance(result.stdout, str) else ""
    return CommandResult(result.exit_status, out[:OUTPUT_LIMIT])


async def _run_pooled(pool: SshPool, cfg: SshTargetConfig, db: AsyncSession, command: str, *,
                      timeout: float, input: str | None, tries: int,
                      log: Callable[[str], None] | None) -> CommandResult:
    """run_command on the pool's connection. A dropped connection is
    discarded and the command is never re-run (it may have half-run); a
    timeout keeps the connection."""
    conn, _ = await pool.connection(cfg, db, tries=tries, log=log)
    try:
        result = await asyncio.wait_for(
            conn.run(command, check=False, errors="replace", input=input), timeout)
    except (OSError, asyncssh.ConnectionLost, asyncssh.DisconnectError):
        pool.discard(conn)
        return CommandResult(None, "")
    except (TimeoutError, asyncssh.Error):
        return CommandResult(None, "")
    if conn.is_closed():                   # asyncssh returns, not raises, when cut off
        pool.discard(conn)
        if result.exit_status is None:     # partial output isn't an answer
            return CommandResult(None, "")
    out = result.stdout if isinstance(result.stdout, str) else ""
    return CommandResult(result.exit_status, out[:OUTPUT_LIMIT])
