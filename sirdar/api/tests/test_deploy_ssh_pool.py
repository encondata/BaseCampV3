"""The per-deployment SSH pool: one connection per pinned host, a reconnect
(logged) when it drops, never a re-run of a command that was cut off."""

import asyncio

import asyncssh

from sirdar_api.deploy import known_hosts, ssh

from .ssh_server import ssh_config, ssh_server  # noqa: F401

RECONNECT = "Lost the SSH connection to 127.0.0.1; reconnecting.\n"


async def _trust(db, fake):
    await known_hosts.trust(db, fake.host, fake.port, fake.fingerprint, actor_id=None)
    await db.commit()
    fake.connections = 0                          # trusting fetched the key once
    fake.closed = 0
    fake.server_conns.clear()


async def _until(predicate, seconds: float = 5) -> None:
    for _ in range(int(seconds / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting")


async def test_pool_reuses_one_connection(db, ssh_server):
    await _trust(db, ssh_server)
    cfg = ssh_config(ssh_server)
    async with ssh.SshPool() as pool:
        with ssh.using_pool(pool):
            first = await ssh.run_command(cfg, db, "uname -srm")
            second = await ssh.run_command(cfg, db, "docker --version")
    assert first.exit_status == 0 and second.exit_status == 0
    assert second.stdout == "Docker version 27.3.1, build ce12230\n"
    assert ssh_server.connections == 1


async def test_pool_reconnects_after_drop_and_logs(db, ssh_server):
    await _trust(db, ssh_server)
    cfg, lines = ssh_config(ssh_server), []
    async with ssh.SshPool() as pool:
        with ssh.using_pool(pool):
            assert (await ssh.run_command(cfg, db, "uname -srm", log=lines.append)).exit_status == 0
            ssh_server.server_conns[0].close()
            await _until(lambda: ssh_server.closed == 1)
            second = await ssh.run_command(cfg, db, "uname -srm", log=lines.append)
    assert second.exit_status == 0 and second.stdout == "Linux 6.8.0-45-generic x86_64\n"
    assert ssh_server.connections == 2
    assert lines == [RECONNECT]


async def test_dropped_command_is_not_rerun(db, ssh_server):
    await _trust(db, ssh_server)
    cfg, lines, slow = ssh_config(ssh_server), [], "docker --version"
    ssh_server.delays = {slow: 5}
    async with ssh.SshPool() as pool:
        with ssh.using_pool(pool):
            task = asyncio.create_task(ssh.run_command(cfg, db, slow, log=lines.append))
            await _until(lambda: slow in ssh_server.commands)
            ssh_server.server_conns[0].abort()
            result = await task
            later = await ssh.run_command(cfg, db, "uname -srm", log=lines.append)
    assert result.exit_status is None and result.stdout == ""
    assert later.exit_status == 0
    assert ssh_server.commands.count(slow) == 1
    assert ssh_server.connections == 2 and lines == [RECONNECT]


async def test_new_fingerprint_gets_new_connection(db, ssh_server):
    await _trust(db, ssh_server)
    cfg = ssh_config(ssh_server)
    async with ssh.SshPool() as pool:
        with ssh.using_pool(pool):
            assert (await ssh.run_command(cfg, db, "uname -srm")).exit_status == 0
            new = asyncssh.generate_private_key("ssh-ed25519")
            ssh_server.serve_host_keys(new)
            await known_hosts.trust(db, ssh_server.host, ssh_server.port,
                                    new.get_fingerprint("sha256"), actor_id=None)
            await db.commit()
            ssh_server.connections = 0            # trusting fetched the key again
            again = await ssh.run_command(cfg, db, "uname -srm")
            conn, pinned = await pool.connection(cfg, db)
    assert again.exit_status == 0
    assert ssh_server.connections == 1
    assert pinned.fingerprint == new.get_fingerprint("sha256")
    assert conn.is_closed()                       # closed on leaving the pool


async def test_pool_closes_on_exit_and_cancel(db, ssh_server):
    await _trust(db, ssh_server)
    cfg, slow = ssh_config(ssh_server), "docker --version"
    ssh_server.delays = {slow: 30}
    conns = []

    async def deploy():
        async with ssh.SshPool() as pool:
            with ssh.using_pool(pool):
                conns.append((await pool.connection(cfg, db))[0])
                await ssh.run_command(cfg, db, slow)

    task = asyncio.create_task(deploy())
    await _until(lambda: slow in ssh_server.commands)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert ssh_server.connections == 1 and conns[0].is_closed()
    await _until(lambda: ssh_server.closed == 1)


async def test_outside_pool_unchanged(db, ssh_server):
    await _trust(db, ssh_server)
    cfg = ssh_config(ssh_server)
    assert ssh.current_pool.get() is None
    assert (await ssh.run_command(cfg, db, "uname -srm")).exit_status == 0
    assert (await ssh.run_command(cfg, db, "uname -srm")).exit_status == 0
    assert ssh_server.connections == 2
