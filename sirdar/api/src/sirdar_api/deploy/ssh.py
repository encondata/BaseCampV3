"""Custom (SSH) connection test. The server's host key must already be
trusted (known_hosts); the connect step pins that stored key. Error
reasons are our own copy — asyncssh messages never reach the caller."""

import asyncio
from dataclasses import dataclass, field
from pathlib import PurePosixPath

import asyncssh
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.config import Settings
from sirdar_api.deploy import Check, ConnectFailed, ConnectResult, known_hosts

CONNECT_TIMEOUT = 15
COMMAND_TIMEOUT = 10
CHECKS_BUDGET_SECONDS = 30
_MAX_VALUE = 200
_AUTH_FAILED = "The SSH server rejected the username, password or key."
_UNLOCK_FAILED = "Couldn't unlock the SSH key (check the passphrase)."

_GB = 1024 * 1024            # KiB per GiB
MIN_DISK_GB = 10
MIN_MEMORY_GB = 2


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

    @property
    def auth_label(self) -> str:
        key, password = bool(self.key_name), self.password is not None
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


async def _load_client_key(cfg: SshTargetConfig) -> asyncssh.SSHKey | None:
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
        result = await asyncio.wait_for(conn.run(command, check=False, errors="replace"), COMMAND_TIMEOUT)
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


async def test_connection(cfg: SshTargetConfig, db: AsyncSession, *,
                          target_id: str = "ssh") -> ConnectResult:
    host, port, user = cfg.host, cfg.port, cfg.user

    live = await known_hosts.fetch_host_key(host, port)
    actual, key_type = known_hosts.fingerprint(live), live.get_algorithm()
    stored = await known_hosts.lookup(db, host, port)
    if stored is None:
        raise HostKeyUnknown(host, port, key_type, actual)
    if stored.fingerprint_sha256 != actual:
        raise HostKeyMismatch(host, port, stored.fingerprint_sha256, actual, key_type)
    try:
        pinned = asyncssh.import_public_key(stored.public_key)
    except (asyncssh.KeyImportError, ValueError):
        raise ConnectFailed("Sirdar's saved key for this host is unreadable. "
                            "Forget the host and trust it again.") from None

    client_key = await _load_client_key(cfg)
    password = cfg.password
    try:
        conn = await asyncio.wait_for(asyncssh.connect(
            host, port=port, username=user, password=password,
            client_keys=[client_key] if client_key else None,
            # Pin the stored key: (trusted host keys, trusted CA keys, revoked keys).
            known_hosts=([pinned], [], []),
            agent_path=None, config=None, connect_timeout=CONNECT_TIMEOUT,
        ), CONNECT_TIMEOUT + 5)
    except asyncssh.PermissionDenied:
        raise ConnectFailed(_AUTH_FAILED) from None
    except asyncssh.HostKeyNotVerifiable:
        raise ConnectFailed("The server's host key changed during the test. Try again.") \
            from None
    except (OSError, TimeoutError, asyncssh.Error):
        raise known_hosts.unreachable(host, port) from None

    async with conn:
        checks = await _checks(conn)
    facts = {"host": host, "port": port, "user": user, "auth": cfg.auth_label,
             "key_type": key_type, "fingerprint": actual}
    return ConnectResult(ok=not any(c.status == "fail" for c in checks), target=target_id,
                         checks=checks, facts=facts)


test_connection.__test__ = False  # not a pytest test, despite the name
