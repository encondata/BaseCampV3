"""A pinned host key is checked against the live key of the same type. An
Ubuntu VM that cloud-init gave only Sirdar's ed25519 key gains RSA and ECDSA
keys when openssh-server upgrades; the server then offers those first, and
the pin must still hold."""

import asyncssh
import pytest

from sirdar_api.deploy import known_hosts, ssh, vmcommon, vms
from sirdar_api.deploy.publish import StepFailed

from .proxmox_helpers import no_sleep
from .ssh_server import ssh_config, ssh_server  # noqa: F401

MISMATCH = "The VM's live SSH key isn't the one Sirdar generated for it. Sirdar pinned nothing."


def _gain_keys(fake) -> list[asyncssh.SSHKey]:
    """ECDSA and RSA host keys appear, offered ahead of the original."""
    extra = [asyncssh.generate_private_key(a) for a in ("ecdsa-sha2-nistp256", "ssh-rsa")]
    fake.serve_host_keys(*extra, fake.host_key)
    return extra


async def _trust(db, fake):
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()


def test_host_key_algs():
    assert known_hosts.host_key_algs("ssh-ed25519") == ["ssh-ed25519"]
    assert known_hosts.host_key_algs("ssh-rsa") == ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]
    assert known_hosts.host_key_algs("ecdsa-sha2-nistp256") == ["ecdsa-sha2-nistp256"]


async def test_fetch_asks_for_a_key_type(ssh_server):
    _gain_keys(ssh_server)
    live = await known_hosts.fetch_host_key(ssh_server.host, ssh_server.port)
    assert live.get_algorithm() != "ssh-ed25519"            # the server's preference wins
    live = await known_hosts.fetch_host_key(ssh_server.host, ssh_server.port, ["ssh-ed25519"])
    assert known_hosts.fingerprint(live) == ssh_server.fingerprint


async def test_fetch_of_a_type_the_server_lacks(ssh_server):
    ssh_server.serve_host_keys(asyncssh.generate_private_key("ecdsa-sha2-nistp256"))
    with pytest.raises(known_hosts.HostKeyTypeMissing):
        await known_hosts.fetch_host_key(ssh_server.host, ssh_server.port, ["ssh-ed25519"])


async def test_a_pin_survives_gained_host_keys(db, ssh_server):
    await _trust(db, ssh_server)
    _gain_keys(ssh_server)
    pinned = await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    assert (pinned.key_type, pinned.fingerprint) == ("ssh-ed25519", ssh_server.fingerprint)
    result = await ssh.test_connection(ssh_config(ssh_server), db)
    assert result.ok and result.facts["fingerprint"] == ssh_server.fingerprint


async def test_an_rsa_pin_is_checked_against_the_rsa_key(db, ssh_server):
    ecdsa, rsa = _gain_keys(ssh_server)
    ssh_server.serve_host_keys(ecdsa, rsa)
    expected = known_hosts.fingerprint(rsa)
    row = await known_hosts.trust(db, ssh_server.host, ssh_server.port, expected, None,
                                  key_type="ssh-rsa")
    await db.commit()
    assert (row.key_type, row.fingerprint_sha256) == ("ssh-rsa", expected)
    pinned = await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    assert pinned.fingerprint == expected


async def test_trust_with_a_key_type_finds_that_key(db, ssh_server):
    _gain_keys(ssh_server)
    with pytest.raises(known_hosts.HostKeyChanged):     # without one: the offered key
        await known_hosts.trust(db, ssh_server.host, ssh_server.port, ssh_server.fingerprint,
                                None)
    row = await known_hosts.trust(db, ssh_server.host, ssh_server.port, ssh_server.fingerprint,
                                  None, key_type="ssh-ed25519")
    assert (row.key_type, row.fingerprint_sha256) == ("ssh-ed25519", ssh_server.fingerprint)


async def test_a_changed_key_of_the_pinned_type_is_a_mismatch(db, ssh_server):
    await _trust(db, ssh_server)
    other = asyncssh.generate_private_key("ssh-ed25519")
    ssh_server.serve_host_keys(asyncssh.generate_private_key("ecdsa-sha2-nistp256"), other)
    with pytest.raises(ssh.HostKeyMismatch) as e:
        await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    assert (e.value.actual, e.value.key_type) == (known_hosts.fingerprint(other), "ssh-ed25519")
    with pytest.raises(known_hosts.HostKeyChanged) as c:
        await known_hosts.trust(db, ssh_server.host, ssh_server.port, ssh_server.fingerprint,
                                None, key_type="ssh-ed25519")
    assert c.value.actual == known_hosts.fingerprint(other)


async def test_a_server_without_the_pinned_type_is_a_mismatch(db, ssh_server):
    await _trust(db, ssh_server)
    ecdsa = asyncssh.generate_private_key("ecdsa-sha2-nistp256")
    ssh_server.serve_host_keys(ecdsa)
    with pytest.raises(ssh.HostKeyMismatch) as e:
        await ssh.pinned_host_key(db, ssh_server.host, ssh_server.port)
    assert (e.value.expected, e.value.actual, e.value.key_type) == (
        ssh_server.fingerprint, known_hosts.fingerprint(ecdsa), "ecdsa-sha2-nistp256")
    with pytest.raises(known_hosts.HostKeyChanged) as c:
        await known_hosts.trust(db, ssh_server.host, ssh_server.port, ssh_server.fingerprint,
                                None, key_type="ssh-ed25519")
    assert c.value.actual == known_hosts.fingerprint(ecdsa)


async def _confirm(fake, lines, **kw):
    return await vmcommon.confirm_pin(
        ip=fake.host, expected=fake.fingerprint, actor_id=None, target_id="esxi:demo",
        tries=2, poll=1, sleep=no_sleep, out=lines.append, how="the key Sirdar generated",
        mismatch=MISMATCH, **kw)


async def test_confirm_pin_with_gained_host_keys(db, ssh_server, monkeypatch):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    _gain_keys(ssh_server)
    lines: list[str] = []
    assert await _confirm(ssh_server, lines, key_type="ssh-ed25519") is True
    assert await _confirm(ssh_server, lines, key_type="ssh-ed25519") is False
    assert lines[-1] == f"SSH host key {ssh_server.fingerprint} is pinned.\n"
    row = await known_hosts.lookup(db, ssh_server.host, ssh_server.port)
    assert (row.key_type, row.fingerprint_sha256) == ("ssh-ed25519", ssh_server.fingerprint)


async def test_confirm_pin_refuses_a_server_without_the_generated_type(db, ssh_server,
                                                                       monkeypatch):
    monkeypatch.setattr(vms, "VM_SSH_PORT", ssh_server.port)
    ssh_server.serve_host_keys(asyncssh.generate_private_key("ecdsa-sha2-nistp256"))
    with pytest.raises(StepFailed) as e:
        await _confirm(ssh_server, [], key_type="ssh-ed25519")
    assert e.value.reason == MISMATCH
    assert await known_hosts.lookup(db, ssh_server.host, ssh_server.port) is None
