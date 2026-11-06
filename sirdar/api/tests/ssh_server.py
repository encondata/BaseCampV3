"""A real in-process asyncssh server for the deploy SSH tests. It accepts
one user with a password or an authorized ed25519 key and answers the
connection-check commands with canned output."""

import asyncio
from dataclasses import dataclass, field
from pathlib import Path

import asyncssh
import pytest

SSH_USER = "deployer"
SSH_PASSWORD = "ssh-PW-secret-4242"
KEY_PASSPHRASE = "open-sesame-SECRET"

OUTPUTS = {
    '. /etc/os-release && echo "$PRETTY_NAME"': "Ubuntu 24.04.1 LTS\n",
    "uname -srm": "Linux 6.8.0-45-generic x86_64\n",
    "docker --version": "Docker version 27.3.1, build ce12230\n",
    "docker compose version": "Docker Compose version v2.29.7\n",
    # 61,000,000 KiB available ≈ 58.2 GB
    "df -Pk / | tail -1": "/dev/vda1 81000000 20000000 61000000 25% /\n",
    # 4,014,000 kB ≈ 3.8 GB
    "grep MemTotal /proc/meminfo": "MemTotal:        4014000 kB\n",
}


@dataclass
class FakeSshServer:
    port: int
    host_key: asyncssh.SSHKey
    client_key: asyncssh.SSHKey
    keys_dir: Path
    host: str = "127.0.0.1"
    docker: bool = True
    overrides: dict = field(default_factory=dict)
    commands: list = field(default_factory=list)
    delays: dict = field(default_factory=dict)   # command -> seconds to sleep first
    exits: dict = field(default_factory=dict)    # command -> exit status for an override
    stdin_echo: set = field(default_factory=set)  # commands that answer with their stdin
    stdins: list = field(default_factory=list)    # what those commands read
    acceptor: asyncssh.SSHAcceptor | None = None
    connections: int = 0                          # accepted TCP connections, host-key fetches too
    closed: int = 0                               # connections that have since closed
    server_conns: list = field(default_factory=list)  # server-side ends, to drop from a test
    max_sessions: int = 10                        # open channels per connection, as OpenSSH
    open_sessions: int = 0                        # commands whose channel is still open
    refuse_sessions: bool = False                 # refuse every new channel (ChannelOpenError)
    drop_after: set = field(default_factory=set)  # commands that close the connection on exit

    def serve_host_keys(self, *keys: asyncssh.SSHKey) -> None:
        """Change the host keys new connections are offered, in this order
        (as a VM gains RSA and ECDSA keys when openssh-server upgrades)."""
        self.acceptor.update(server_host_keys=list(keys))

    @property
    def fingerprint(self) -> str:
        return self.host_key.get_fingerprint("sha256")

    def answer(self, command: str) -> tuple[str, str, int]:
        self.commands.append(command)
        if command in self.overrides:
            return self.overrides[command], "", self.exits.get(command, 0)
        if command.startswith("docker") and not self.docker:
            return "", "bash: line 1: docker: command not found\n", 127
        if command in OUTPUTS:
            return OUTPUTS[command], "", 0
        return "", f"unknown command: {command}\n", 1


def _server_class(state: dict):
    class _Server(asyncssh.SSHServer):
        def connection_made(self, conn) -> None:
            state["fake"].connections += 1
            state["fake"].server_conns.append(conn)

        def connection_lost(self, exc) -> None:
            state["fake"].closed += 1

        def session_requested(self):
            fake = state["fake"]
            if fake.refuse_sessions or fake.open_sessions >= fake.max_sessions:
                return False                      # the client gets ChannelOpenError
            return asyncssh.SSHServerProcess(state["process_factory"], None, 3, False)

        def begin_auth(self, username: str) -> bool:
            return True

        def password_auth_supported(self) -> bool:
            return True

        def validate_password(self, username: str, password: str) -> bool:
            return username == SSH_USER and password == SSH_PASSWORD

        def public_key_auth_supported(self) -> bool:
            return True

        def validate_public_key(self, username: str, key: asyncssh.SSHKey) -> bool:
            return (username == SSH_USER
                    and key.public_data == state["fake"].client_key.public_data)

    return _Server


@pytest.fixture
async def ssh_server(tmp_path):
    state: dict = {}

    async def process_factory(process: asyncssh.SSHServerProcess) -> None:
        fake = state["fake"]
        fake.open_sessions += 1
        try:
            await _answer(fake, process)
        finally:
            fake.open_sessions -= 1

    async def _answer(fake: FakeSshServer, process: asyncssh.SSHServerProcess) -> None:
        if process.command in fake.stdin_echo:
            fake.commands.append(process.command)
            data = await process.stdin.read()
            fake.stdins.append(data.decode())
            process.stdout.write(data)
            process.exit(0)
            return
        out, err, code = fake.answer(process.command or "")
        if process.command in fake.delays:
            # The session ends early when the client closes its channel.
            closed = asyncio.ensure_future(process.channel.wait_closed())
            await asyncio.wait([closed], timeout=fake.delays[process.command])
            if closed.done():
                return
            closed.cancel()
        process.stdout.write(out if isinstance(out, bytes) else out.encode())
        process.stderr.write(err.encode())
        process.exit(code)
        if process.command in fake.drop_after:      # after the exit status has gone out
            asyncio.get_running_loop().call_later(0.1, process.channel.get_connection().close)

    state["process_factory"] = process_factory
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    client_key = asyncssh.generate_private_key("ssh-ed25519")
    keys_dir = tmp_path / "deploy-keys"
    keys_dir.mkdir()
    client_key.write_private_key(keys_dir / "id_ed25519")
    client_key.write_private_key(keys_dir / "id_locked", passphrase=KEY_PASSPHRASE)
    (keys_dir / "not_a_key").write_text("hello\n")

    server = await asyncssh.create_server(
        _server_class(state), "127.0.0.1", 0, server_host_keys=[host_key],
        encoding=None)
    port = server.sockets[0].getsockname()[1]
    state["fake"] = FakeSshServer(port=port, host_key=host_key, client_key=client_key,
                                  keys_dir=keys_dir, acceptor=server)
    try:
        yield state["fake"]
    finally:
        server.close()
        await server.wait_closed()


def ssh_settings(fake: FakeSshServer, **over):
    """Settings pointing at the fake server; password auth unless overridden."""
    from .test_scaffold import _settings
    kw = {"deploy_ssh_host": fake.host, "deploy_ssh_port": fake.port, "deploy_ssh_user": SSH_USER,
              "deploy_ssh_password": SSH_PASSWORD, "deploy_keys_dir": str(fake.keys_dir)}
    kw.update(over)
    return _settings(**kw)


def ssh_config(fake: FakeSshServer, **over):
    """The installer target's SshTargetConfig built from ssh_settings()."""
    from sirdar_api.deploy.ssh import SshTargetConfig
    return SshTargetConfig.from_settings(ssh_settings(fake, **over))
