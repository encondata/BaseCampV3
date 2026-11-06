"""A dropped outbound connection is retried (Sirdar 5 times, 3 s apart);
host-key, login and command failures never are."""

from types import SimpleNamespace

import asyncssh
import pytest

from sirdar_api.deploy import ConnectFailed, known_hosts, ssh
from sirdar_api.deploy.runner import AnsibleRunner

HOST, PORT = "10.0.0.5", 22
KEY = asyncssh.generate_private_key("ssh-ed25519")
STORED = SimpleNamespace(key_type="ssh-ed25519", fingerprint_sha256=known_hosts.fingerprint(KEY),
                         public_key=KEY.export_public_key().decode().strip())
CFG = ssh.SshTargetConfig(host=HOST, port=PORT, user="deploy", password="pw")


class Napper:
    def __init__(self):
        self.naps: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.naps.append(seconds)


@pytest.fixture
def nap(monkeypatch):
    napper = Napper()
    monkeypatch.setattr(ssh.asyncio, "sleep", napper)
    return napper


def _script(monkeypatch, outcomes: list):
    """known_hosts.fetch_key_of_type answers from `outcomes` (exceptions raise)."""
    calls: list[int] = []

    async def lookup(db, host, port):
        return STORED

    async def fetch(host, port, key_type):
        calls.append(1)
        outcome = outcomes[len(calls) - 1]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome
    monkeypatch.setattr(known_hosts, "lookup", lookup)
    monkeypatch.setattr(known_hosts, "fetch_key_of_type", fetch)
    return calls


async def test_connect_retries_then_succeeds(monkeypatch, nap):
    down = known_hosts.unreachable(HOST, PORT)
    calls = _script(monkeypatch, [down, down, KEY])
    lines: list[str] = []
    pinned = await ssh.pinned_host_key(None, HOST, PORT, log=lines.append)
    assert pinned.fingerprint == STORED.fingerprint_sha256
    assert len(calls) == 3
    assert lines == ["Couldn't reach 10.0.0.5:22; trying again (2 of 5).\n",
                     "Couldn't reach 10.0.0.5:22; trying again (3 of 5).\n"]
    assert nap.naps == [3.0, 3.0]


async def test_connect_gives_up_after_five(monkeypatch, nap):
    calls = _script(monkeypatch, [known_hosts.unreachable(HOST, PORT)] * 5)
    with pytest.raises(ConnectFailed) as err:
        await ssh.pinned_host_key(None, HOST, PORT)
    assert err.value.reason == "Couldn't reach 10.0.0.5:22."
    assert len(calls) == 5
    assert len(nap.naps) == 4


async def test_single_try_when_asked(monkeypatch, nap):
    calls = _script(monkeypatch, [known_hosts.unreachable(HOST, PORT)] * 5)
    with pytest.raises(ConnectFailed):
        await ssh.pinned_host_key(None, HOST, PORT, tries=1)
    assert len(calls) == 1 and nap.naps == []


async def test_mismatch_and_auth_not_retried(monkeypatch, nap):
    other = asyncssh.generate_private_key("ssh-ed25519")
    calls = _script(monkeypatch, [other, KEY])
    with pytest.raises(ssh.HostKeyMismatch):
        await ssh.pinned_host_key(None, HOST, PORT)
    assert len(calls) == 1

    pinned = ssh.PinnedHost(key=KEY, key_type="ssh-ed25519",
                            fingerprint=STORED.fingerprint_sha256, public_key=STORED.public_key)
    attempts: list[int] = []

    async def denied(*a, **kw):
        attempts.append(1)
        raise asyncssh.PermissionDenied("no")
    monkeypatch.setattr(ssh.asyncssh, "connect", denied)
    with pytest.raises(ConnectFailed) as err:
        await ssh.connect_pinned(CFG, pinned)
    assert err.value.reason == ssh._AUTH_FAILED
    assert len(attempts) == 1 and nap.naps == []


async def test_run_command_failure_after_connect_not_retried(monkeypatch, nap):
    _script(monkeypatch, [KEY])
    connects: list[int] = []

    class Conn:
        async def run(self, *a, **kw):
            raise asyncssh.ChannelOpenError(1, "x")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    async def connect(*a, **kw):
        connects.append(1)
        return Conn()
    monkeypatch.setattr(ssh.asyncssh, "connect", connect)
    result = await ssh.run_command(CFG, None, "true")
    assert result == ssh.CommandResult(None, "")
    assert len(connects) == 1


def test_runner_sets_ssh_retries(tmp_path):
    from .test_deploy_runner import _target
    env = AnsibleRunner(str(tmp_path)).envvars(tmp_path / "run-x", _target())
    assert env["ANSIBLE_SSH_RETRIES"] == "5"
    assert "-o ConnectTimeout=15" in env["ANSIBLE_SSH_ARGS"]
