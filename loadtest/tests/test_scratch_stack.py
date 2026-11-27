"""The scratch stack's process bookkeeping: only the processes it started are its own."""

import importlib.util
import os
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


@pytest.fixture
def stack(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("scratch_stack",
                                                  HERE / "e2e" / "scratch_stack.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "SCRATCH", tmp_path)
    # a harmless stand-in: this test's own sleep, never a real API or worker
    monkeypatch.setattr(module, "PROCESSES", {"api": ["sleep", "37"]})
    monkeypatch.setattr(module, "SIGNATURES", {"api": ("sleep 37",)})
    monkeypatch.setattr(module, "say", lambda text: None)
    started: list[int] = []
    yield module, started
    for pid in started:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass


def test_a_process_is_ours_only_with_the_start_time_we_recorded(stack):
    module, started = stack
    pid = module.start("api", dict(os.environ))
    started.append(pid)
    lines = module.pid_file("api").read_text().splitlines()
    assert lines[0] == str(pid) and lines[1]           # the pid and its start time
    for _ in range(50):         # just after the fork, ps can still show the parent's command
        if module.started_pid("api") == pid:
            break
        time.sleep(0.1)
    assert module.started_pid("api") == pid
    # same pid and command line, another start time: a process that is not ours
    module.pid_file("api").write_text(f"{pid}\nMon Jan  1 00:00:00 2001\n")
    assert module.started_pid("api") is None
    module.pid_file("api").write_text("\n".join(lines) + "\n")
    module.stop("api")
    assert module.started_pid("api") is None and not module.pid_file("api").exists()
    _, status = os.waitpid(pid, 0)                       # it was stopped by a signal
    assert os.WIFSIGNALED(status)
    started.clear()
