"""Runs one deploy step's playbook on a target. The pipeline depends only
on the Runner protocol, so tests swap in a fake; AnsibleRunner drives
ansible-runner in a worker thread.

Each run gets a private folder (mode 700) under SIRDAR_RUNNER_DIR holding a
copy of the playbooks, the inventory, a known_hosts file that pins the
target's trusted host key, the extra vars (secrets included, mode 600) and,
for key auth, a decrypted copy of the SSH key (mode 600). The folder is
deleted when the run ends, however it ends. Event files are never written
(the event handler returns False), so task output never lands on disk
outside that folder. Output is passed to on_output raw: the caller redacts."""

import asyncio
import json
import os
import shlex
import shutil
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Literal, Protocol

from sirdar_api.deploy.steps import PLAYBOOK_DIR

RunStatus = Literal["successful", "failed", "timeout", "canceled"]
_STATUSES = ("successful", "failed", "timeout", "canceled")
CANCEL_GRACE_SECONDS = 30
# Longer than the longest step timeout (the "up" step: 45 minutes) plus the
# cancel grace, so a sweep never touches a live run.
STALE_RUN_SECONDS = 2 * 60 * 60
# The only variables a job inherits from the API process; everything else
# (database URL, secrets key, ...) stays out of ansible, ssh and sshpass.
_INHERITED_ENV = ("PATH", "HOME", "LANG", "TZ")
_INHERITED_PREFIXES = ("LC_",)


@dataclass(frozen=True)
class RunTarget:
    host: str
    port: int
    user: str
    known_hosts_line: str
    host_key_algorithms: str
    password: str | None = field(default=None, repr=False)
    private_key: str | None = field(default=None, repr=False)   # unencrypted OpenSSH text
    become_password: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class RunRequest:
    step: str
    playbook: str
    target: RunTarget
    timeout: int
    extravars: dict = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class RunResult:
    status: RunStatus
    rc: int
    changed: int = 0
    data: dict = field(default_factory=dict)      # set_stats data (aggregate)


class Runner(Protocol):
    async def run(self, request: RunRequest,
                  on_output: Callable[[str], None]) -> RunResult: ...


def ansible_playbook_binary() -> str:
    """ansible-playbook beside this interpreter (a venv's bin/), else PATH."""
    beside = Path(sys.executable).parent / "ansible-playbook"
    if beside.is_file():
        return str(beside)
    found = shutil.which("ansible-playbook")
    if found is None:
        raise RuntimeError("ansible-playbook is not installed")
    return found


def _write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


def _discard_prepared(fut: asyncio.Future) -> None:
    if fut.cancelled() or fut.exception() is not None:
        return
    shutil.rmtree(fut.result(), ignore_errors=True)


class AnsibleRunner:
    def __init__(self, runner_dir: str):
        self.runner_dir = Path(runner_dir)

    def sweep_stale(self, max_age: float = STALE_RUN_SECONDS) -> int:
        """Remove run-* folders older than max_age (left by a crash or kill)."""
        removed = 0
        if not self.runner_dir.is_dir():
            return 0
        cutoff = time.time() - max_age
        for entry in self.runner_dir.glob("run-*"):
            with suppress(OSError):
                if (entry.is_dir() and not entry.is_symlink()
                        and entry.stat().st_mtime < cutoff):
                    shutil.rmtree(entry, ignore_errors=True)
                    removed += 1
        return removed

    def prepare(self, request: RunRequest) -> Path:
        self.runner_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.runner_dir, 0o700)
        self.sweep_stale()
        run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=self.runner_dir))   # mode 700
        try:
            for sub in ("env", "inventory", "home", "tmp"):
                (run_dir / sub).mkdir(mode=0o700)
            shutil.copytree(PLAYBOOK_DIR, run_dir / "project")
            t = request.target
            _write_private(run_dir / "known_hosts", t.known_hosts_line + "\n")
            host: dict = {"ansible_host": t.host, "ansible_port": t.port,
                          "ansible_user": t.user}
            if t.private_key is not None:
                key_file = run_dir / "id_key"
                text = t.private_key if t.private_key.endswith("\n") else t.private_key + "\n"
                _write_private(key_file, text)
                host["ansible_ssh_private_key_file"] = str(key_file)
            _write_private(run_dir / "inventory" / "hosts.json",
                           json.dumps({"all": {"hosts": {"target": host}}}))
            extravars = dict(request.extravars)
            if t.password is not None:
                extravars["ansible_password"] = t.password
            if t.become_password is not None:
                extravars["ansible_become_password"] = t.become_password
            _write_private(run_dir / "env" / "extravars", json.dumps(extravars))
            # An empty config: nothing from /etc/ansible or the working folder applies.
            _write_private(run_dir / "ansible.cfg", "[defaults]\n")
        except BaseException:
            shutil.rmtree(run_dir, ignore_errors=True)
            raise
        return run_dir

    def envvars(self, run_dir: Path, target: RunTarget) -> dict[str, str]:
        known = shlex.quote(str(run_dir / "known_hosts"))
        ssh_args = " ".join([
            "-F /dev/null",                       # no user or system ssh_config
            "-o ControlMaster=no", "-o ControlPersist=no",
            f"-o UserKnownHostsFile={known}", "-o GlobalKnownHostsFile=/dev/null",
            "-o StrictHostKeyChecking=yes",
            f"-o HostKeyAlgorithms={target.host_key_algorithms}",
            "-o IdentitiesOnly=yes",
            "-o ServerAliveInterval=30", "-o ServerAliveCountMax=10",
        ])
        return {
            # ansible-runner starts "ansible-playbook" through PATH (its
            # `binary` option would switch it to raw mode and drop the
            # playbook argument): put this interpreter's copy first.
            "PATH": os.pathsep.join([str(Path(ansible_playbook_binary()).parent),
                                     os.environ.get("PATH", "")]),
            "ANSIBLE_CONFIG": str(run_dir / "ansible.cfg"),
            "ANSIBLE_HOME": str(run_dir / "home"),
            "ANSIBLE_LOCAL_TEMP": str(run_dir / "tmp"),
            "ANSIBLE_SSH_ARGS": ssh_args,
            "ANSIBLE_HOST_KEY_CHECKING": "True",
            "ANSIBLE_PIPELINING": "False",
            "ANSIBLE_TIMEOUT": "30",
            "ANSIBLE_PYTHON_INTERPRETER": "auto_silent",
            "ANSIBLE_NOCOLOR": "1",
            "ANSIBLE_FORCE_COLOR": "0",
            "ANSIBLE_RETRY_FILES_ENABLED": "False",
            "ANSIBLE_DEPRECATION_WARNINGS": "False",
        }

    def build_runner(self, run_dir: Path, request: RunRequest, event_handler,
                     cancel_callback):
        """An ansible-runner Runner whose job environment is an allowlist.
        ansible-runner seeds the job env from os.environ and `envvars` can
        only add to it, so the merged env is replaced here (never touching
        the process-wide os.environ) before the run starts."""
        import ansible_runner.interface

        overrides = self.envvars(run_dir, request.target)
        runner = ansible_runner.interface.init_runner(
            private_data_dir=str(run_dir), playbook=request.playbook, ident="run",
            envvars=overrides, event_handler=event_handler,
            cancel_callback=cancel_callback, timeout=request.timeout, quiet=True)
        runner.config.env = {
            k: v for k, v in runner.config.env.items()
            if k in _INHERITED_ENV or k.startswith(_INHERITED_PREFIXES)
            or k in overrides or os.environ.get(k) != v}
        runner.config.suppress_output_file = True   # no unredacted stdout/stderr files
        return runner

    def _run_sync(self, run_dir: Path, request: RunRequest,
                  on_output: Callable[[str], None], cancel: threading.Event) -> RunResult:
        import ansible_runner   # imported here: heavy, and only a real run needs it

        stats: dict = {}

        def event_handler(event: dict) -> bool:
            text = event.get("stdout") or ""
            if text:
                on_output(text + "\n")
            if event.get("event") == "playbook_on_stats":
                data = event.get("event_data") or {}
                stats["changed"] = sum((data.get("changed") or {}).values())
                stats["data"] = dict(data.get("artifact_data") or {})
            return False                          # never write event files

        runner = self.build_runner(run_dir, request, event_handler, cancel.is_set)
        status_text, code = runner.run()
        result = SimpleNamespace(status=status_text, rc=code)
        status = result.status if result.status in _STATUSES else "failed"
        rc = result.rc if isinstance(result.rc, int) else -1
        return RunResult(status=status, rc=rc, changed=stats.get("changed", 0),
                         data=stats.get("data", {}))

    async def run(self, request: RunRequest,
                  on_output: Callable[[str], None]) -> RunResult:
        prepared = asyncio.ensure_future(asyncio.to_thread(self.prepare, request))
        try:
            run_dir = await asyncio.shield(prepared)
        except asyncio.CancelledError:
            # The thread keeps going and will create the folder: delete it then.
            prepared.add_done_callback(_discard_prepared)
            raise
        cancel = threading.Event()
        work = asyncio.ensure_future(
            asyncio.to_thread(self._run_sync, run_dir, request, on_output, cancel))
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            cancel.set()                          # ansible-runner polls this and stops
            with suppress(BaseException):
                await asyncio.wait_for(asyncio.shield(work), CANCEL_GRACE_SECONDS)
            raise
        finally:
            if work.done():
                shutil.rmtree(run_dir, ignore_errors=True)
            else:                                 # still stopping: clean up when it does
                def _late(fut: asyncio.Future) -> None:
                    if not fut.cancelled():
                        fut.exception()               # mark retrieved
                    shutil.rmtree(run_dir, ignore_errors=True)
                work.add_done_callback(_late)
