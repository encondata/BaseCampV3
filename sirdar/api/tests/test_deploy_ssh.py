import socket

import asyncssh
import pytest
from sqlalchemy import select

from sirdar_api.db.models import AuditLog, SshKnownHost
from sirdar_api.deploy import ConnectFailed, known_hosts, ssh

from .ssh_server import KEY_PASSPHRASE, SSH_PASSWORD, ssh_server, ssh_settings  # noqa: F401

AUTH_FAILED = "The SSH server rejected the username, password or key."


def _checks(result):
    return {c.label: (c.status, c.value) for c in result.checks}


async def _trust(db, fake):
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()


def test_fingerprint_matches_asyncssh():
    for alg in ("ssh-ed25519", "ecdsa-sha2-nistp256"):
        key = asyncssh.generate_private_key(alg)
        assert known_hosts.fingerprint(key) == key.get_fingerprint("sha256")
        assert known_hosts.fingerprint(key).startswith("SHA256:")
        assert not known_hosts.fingerprint(key).endswith("=")


async def test_unknown_host_raises_with_fingerprint(db, ssh_server):
    with pytest.raises(ssh.HostKeyUnknown) as exc:
        await ssh.test_connection(ssh_settings(ssh_server), db)
    e = exc.value
    assert (e.host, e.port, e.key_type, e.fingerprint) == (
        "127.0.0.1", ssh_server.port, "ssh-ed25519", ssh_server.fingerprint)
    assert ssh_server.commands == []


async def test_trust_then_connect_runs_checks(db, ssh_server):
    await _trust(db, ssh_server)
    row = await db.scalar(select(SshKnownHost))
    assert (row.host, row.port, row.key_type, row.fingerprint_sha256) == (
        "127.0.0.1", ssh_server.port, "ssh-ed25519", ssh_server.fingerprint)
    assert asyncssh.import_public_key(row.public_key).public_data == \
        ssh_server.host_key.public_data
    audit = await db.scalar(select(AuditLog).where(AuditLog.action == "deploy.host_trust"))
    assert audit.changes == {"host": "127.0.0.1", "port": ssh_server.port,
                             "key_type": "ssh-ed25519", "fingerprint": ssh_server.fingerprint}

    result = await ssh.test_connection(ssh_settings(ssh_server), db)
    assert result.ok and result.target == "ssh"
    assert _checks(result) == {
        "OS": ("pass", "Ubuntu 24.04.1 LTS"),
        "Kernel": ("pass", "Linux 6.8.0-45-generic x86_64"),
        "Docker": ("pass", "Docker version 27.3.1, build ce12230"),
        "Compose": ("pass", "Docker Compose version v2.29.7"),
        "Disk": ("pass", "58.2 GB free on /"),
        "Memory": ("pass", "3.8 GB"),
    }
    assert result.facts == {"host": "127.0.0.1", "port": ssh_server.port, "user": "deployer",
                            "auth": "password", "key_type": "ssh-ed25519",
                            "fingerprint": ssh_server.fingerprint}
    assert SSH_PASSWORD not in repr(result.as_dict())


async def test_mismatched_stored_key_raises(db, ssh_server):
    other = asyncssh.generate_private_key("ssh-ed25519")
    db.add(SshKnownHost(host="127.0.0.1", port=ssh_server.port, key_type="ssh-ed25519",
                        fingerprint_sha256=other.get_fingerprint("sha256"),
                        public_key=other.export_public_key("openssh").decode().strip()))
    await db.commit()
    with pytest.raises(ssh.HostKeyMismatch) as exc:
        await ssh.test_connection(ssh_settings(ssh_server), db)
    e = exc.value
    assert (e.expected, e.actual, e.key_type) == (
        other.get_fingerprint("sha256"), ssh_server.fingerprint, "ssh-ed25519")
    assert ssh_server.commands == []


async def test_wrong_password_is_connect_failed(db, ssh_server):
    await _trust(db, ssh_server)
    with pytest.raises(ConnectFailed) as exc:
        await ssh.test_connection(ssh_settings(ssh_server, deploy_ssh_password="nope"), db)
    assert exc.value.reason == AUTH_FAILED and exc.value.__cause__ is None


async def test_key_auth_works_without_password(db, ssh_server):
    await _trust(db, ssh_server)
    s = ssh_settings(ssh_server, deploy_ssh_password="", deploy_ssh_key_path="id_ed25519")
    result = await ssh.test_connection(s, db)
    assert result.ok and result.facts["auth"] == "key"
    assert _checks(result)["OS"] == ("pass", "Ubuntu 24.04.1 LTS")


async def test_key_wins_and_wrong_password_is_not_needed(db, ssh_server):
    await _trust(db, ssh_server)
    s = ssh_settings(ssh_server, deploy_ssh_password="wrong", deploy_ssh_key_path="id_ed25519")
    assert (await ssh.test_connection(s, db)).facts["auth"] == "key + password"


async def test_passphrase_key(db, ssh_server):
    await _trust(db, ssh_server)
    base = dict(deploy_ssh_password="", deploy_ssh_key_path="id_locked")
    ok = await ssh.test_connection(
        ssh_settings(ssh_server, **base, deploy_ssh_key_passphrase=KEY_PASSPHRASE), db)
    assert ok.ok
    for passphrase in ("wrong", ""):
        with pytest.raises(ConnectFailed) as exc:
            await ssh.test_connection(
                ssh_settings(ssh_server, **base, deploy_ssh_key_passphrase=passphrase), db)
        assert exc.value.reason == "Couldn't unlock the SSH key (check the passphrase)."


async def test_missing_or_escaping_key_file(db, ssh_server):
    await _trust(db, ssh_server)
    for path, name in (("id_missing", "id_missing"), ("../deploy-keys/id_ed25519", "id_ed25519"),
                       (str(ssh_server.keys_dir / "nope"), "nope")):
        with pytest.raises(ConnectFailed) as exc:
            await ssh.test_connection(ssh_settings(ssh_server, deploy_ssh_key_path=path), db)
        assert exc.value.reason == f"The SSH key file {name} wasn't found in deploy-keys."
        assert str(ssh_server.keys_dir) not in exc.value.reason


async def test_invalid_key_file(db, ssh_server):
    await _trust(db, ssh_server)
    with pytest.raises(ConnectFailed) as exc:
        await ssh.test_connection(ssh_settings(ssh_server, deploy_ssh_key_path="not_a_key"), db)
    assert exc.value.reason == "The SSH key file not_a_key isn't a private key Sirdar can read."


async def test_missing_docker_warns(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.docker = False
    result = await ssh.test_connection(ssh_settings(ssh_server), db)
    checks = _checks(result)
    assert result.ok
    assert checks["Docker"] == ("warn", "Not installed")
    assert checks["Compose"] == ("warn", "Not available")
    assert checks["OS"][0] == "pass"


async def test_low_disk_and_memory_warn(db, ssh_server):
    await _trust(db, ssh_server)
    ssh_server.overrides = {
        "df -Pk / | tail -1": "/dev/vda1 10000000 9000000 5242880 90% /\n",
        "grep MemTotal /proc/meminfo": "MemTotal:        1015000 kB\n",
    }
    checks = _checks(await ssh.test_connection(ssh_settings(ssh_server), db))
    assert checks["Disk"] == ("warn", "5.0 GB free on /")
    assert checks["Memory"] == ("warn", "1.0 GB")


async def test_unreachable_host(db):
    from .test_scaffold import _settings
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    settings = _settings(deploy_ssh_host="127.0.0.1", deploy_ssh_port=port,
                         deploy_ssh_user="u", deploy_ssh_password=SSH_PASSWORD)
    with pytest.raises(ConnectFailed) as exc:
        await ssh.test_connection(settings, db)
    assert exc.value.reason == f"Couldn't reach 127.0.0.1:{port}."


async def test_trust_refuses_changed_key_and_forget(db, ssh_server):
    with pytest.raises(known_hosts.HostKeyChanged) as exc:
        await known_hosts.trust(db, ssh_server.host, ssh_server.port, "SHA256:stale", None)
    assert (exc.value.expected, exc.value.actual) == ("SHA256:stale", ssh_server.fingerprint)
    assert await db.scalar(select(SshKnownHost)) is None

    await _trust(db, ssh_server)
    await _trust(db, ssh_server)                         # idempotent upsert
    rows = await known_hosts.list_hosts(db)
    assert [(h.host, h.port, name) for h, name in rows] == [("127.0.0.1", ssh_server.port, None)]

    assert await known_hosts.forget(db, ssh_server.host, ssh_server.port, None) is True
    await db.commit()
    assert await known_hosts.forget(db, ssh_server.host, ssh_server.port, None) is False
    assert await known_hosts.list_hosts(db) == []
    actions = list(await db.scalars(select(AuditLog.action).order_by(AuditLog.id)))
    assert actions == ["deploy.host_trust", "deploy.host_trust", "deploy.host_forget"]
    with pytest.raises(ssh.HostKeyUnknown):
        await ssh.test_connection(ssh_settings(ssh_server), db)


async def test_connect_pins_the_stored_public_key(db, ssh_server):
    """The fingerprint matches but the stored key is a different one: the
    connect step must refuse, proving it verifies against the stored key."""
    other = asyncssh.generate_private_key("ssh-ed25519")
    db.add(SshKnownHost(host="127.0.0.1", port=ssh_server.port, key_type="ssh-ed25519",
                        fingerprint_sha256=ssh_server.fingerprint,
                        public_key=other.export_public_key("openssh").decode().strip()))
    await db.commit()
    with pytest.raises(ConnectFailed) as exc:
        await ssh.test_connection(ssh_settings(ssh_server), db)
    assert exc.value.reason == "The server's host key changed during the test. Try again."
    assert ssh_server.commands == []
