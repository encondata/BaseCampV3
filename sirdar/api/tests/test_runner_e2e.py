"""Opt-in: real playbooks end to end through ansible-runner against a
throwaway Ubuntu 24.04 SSH container that this test builds (about a minute
the first time).

    SIRDAR_RUNNER_E2E=1 .venv/bin/pytest -q tests/test_runner_e2e.py

Needs Docker and sshpass (brew install sshpass) on this machine, plus the
sirdar-db test database like every other test."""

import base64
import dataclasses
import os
import shutil
import socket
import subprocess
import time
import uuid

import asyncssh
import pytest

from sirdar_api.deploy import known_hosts, ssh
from sirdar_api.deploy.runner import AnsibleRunner, RunRequest, RunTarget

pytestmark = pytest.mark.skipif(os.environ.get("SIRDAR_RUNNER_E2E") != "1",
                                reason="opt-in: set SIRDAR_RUNNER_E2E=1")

IMAGE = "sirdar-e2e-runner:latest"
USER = "deployer"
PASSWORD = "e2e-SSH-pw-5150"
ENV_DIR = "/opt/serversherpa/e2e"
DOCKERFILE = f"""
FROM ubuntu:24.04
RUN apt-get update \\
 && apt-get install -y --no-install-recommends openssh-server python3 sudo \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /run/sshd \\
 && useradd --create-home --shell /bin/bash {USER} \\
 && echo '{USER}:{PASSWORD}' | chpasswd \\
 && echo '{USER} ALL=(ALL) ALL' > /etc/sudoers.d/{USER} \\
 && chmod 440 /etc/sudoers.d/{USER} \\
 && install -d -o {USER} -m 750 {ENV_DIR}
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def target():
    for tool in ("docker", "sshpass"):
        if shutil.which(tool) is None:
            pytest.fail(f"{tool} not found (sshpass: brew install sshpass)")
    subprocess.run(["docker", "build", "-t", IMAGE, "-"], input=DOCKERFILE, text=True,
                   check=True, capture_output=True)
    port = _free_port()
    name = f"sirdar-e2e-runner-{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "run", "-d", "--rm", "--name", name,
                    "-p", f"127.0.0.1:{port}:22", IMAGE], check=True, capture_output=True)
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
                    if s.recv(4).startswith(b"SSH-"):
                        break
            except OSError:
                pass
            if time.monotonic() > deadline:
                pytest.fail("the SSH container didn't start")
            time.sleep(0.3)
        yield {"name": name, "port": port}
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)


def _exec(target, *cmd: str, stdin: str | None = None) -> str:
    return subprocess.run(["docker", "exec", "-i", target["name"], *cmd], input=stdin,
                          text=True, capture_output=True, check=True).stdout


async def _pinned(db, target, **auth) -> RunTarget:
    host, port = "127.0.0.1", target["port"]
    live = await known_hosts.fetch_host_key(host, port)
    await known_hosts.trust(db, host, port, known_hosts.fingerprint(live), actor_id=None)
    await db.commit()
    pinned = await ssh.pinned_host_key(db, host, port)
    return RunTarget(host=host, port=port, user=USER,
                     known_hosts_line=known_hosts.openssh_line(host, port, pinned.public_key),
                     host_key_algorithms=known_hosts.host_key_algorithms(pinned.key_type),
                     **auth)


async def test_preflight_with_password_and_sudo(db, target, tmp_path):
    run_target = await _pinned(db, target, password=PASSWORD, become_password=PASSWORD)
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(
        RunRequest(step="preflight", playbook="preflight.yml", target=run_target, timeout=300,
                   extravars={"min_disk_gb": 1, "min_memory_mb": 64}),
        lines.append)
    out = "".join(lines)
    assert result.status == "successful", out
    assert "Preflight passed: Ubuntu 24.04" in out
    assert "missing (Bootstrap installs it)" in out
    assert PASSWORD not in out
    assert list((tmp_path / "runner").iterdir()) == []


async def test_render_with_key_auth_is_private_and_idempotent(db, target, tmp_path):
    key = asyncssh.generate_private_key("ssh-ed25519")
    _exec(target, "sh", "-c",
          f"install -d -m 700 -o {USER} /home/{USER}/.ssh"
          f" && cat > /home/{USER}/.ssh/authorized_keys"
          f" && chown {USER} /home/{USER}/.ssh/authorized_keys"
          f" && chmod 600 /home/{USER}/.ssh/authorized_keys",
          stdin=key.export_public_key("openssh").decode())
    run_target = await _pinned(db, target,
                               private_key=key.export_private_key("openssh").decode())
    secret = "render-SECRET-" + uuid.uuid4().hex
    text = f"STACK_ENV=e2e\nPOSTGRES_PASSWORD={secret}\n"
    b64 = base64.b64encode(text.encode()).decode()
    runner = AnsibleRunner(str(tmp_path / "runner"))
    request = RunRequest(step="render", playbook="render.yml", target=run_target, timeout=300,
                         extravars={"env_dir": ENV_DIR, "env_file_b64": b64})
    lines: list[str] = []
    first = await runner.run(request, lines.append)
    second = await runner.run(request, lines.append)
    out = "".join(lines)
    assert (first.status, second.status) == ("successful", "successful"), out
    assert first.changed >= 1 and second.changed == 0
    assert secret not in out and b64 not in out
    assert _exec(target, "cat", f"{ENV_DIR}/.env") == text
    assert _exec(target, "stat", "-c", "%a %U", f"{ENV_DIR}/.env").strip() == f"600 {USER}"


async def test_a_wrong_pinned_key_is_refused(db, target, tmp_path):
    run_target = await _pinned(db, target, password=PASSWORD, become_password=PASSWORD)
    other = asyncssh.generate_private_key("ssh-ed25519").export_public_key("openssh").decode()
    wrong = dataclasses.replace(
        run_target, known_hosts_line=known_hosts.openssh_line("127.0.0.1", target["port"], other))
    lines: list[str] = []
    result = await AnsibleRunner(str(tmp_path / "runner")).run(
        RunRequest(step="preflight", playbook="preflight.yml", target=wrong, timeout=120,
                   extravars={"min_disk_gb": 1, "min_memory_mb": 64}),
        lines.append)
    out = "".join(lines)
    assert result.status == "failed", out
    # With a password, sshpass reports the refused key as "Host Key checking is
    # enabled"; with a key, ssh says "Host key verification failed".
    assert "Host Key checking is enabled" in out or "Host key verification failed" in out
    assert PASSWORD not in out
