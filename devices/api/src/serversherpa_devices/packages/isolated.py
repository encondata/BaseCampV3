"""Package inspection in a child process with hard limits.

Uploaded files can be hostile, and androguard inflates APK members without
any size limit (see apk.py). So uploads are inspected by
`python -I -m serversherpa_devices.packages.worker` under a wall-clock
timeout, a CPU limit and (on Linux) an address-space limit. If the child
dies, times out or prints something unexpected, the upload is refused with
one plain message. This module never imports androguard, so its import-time
logging setup stays out of the API process."""

import base64
import dataclasses
import datetime as dt
import json
import logging
import math
import os
import subprocess
import sys
import threading
from pathlib import Path

from serversherpa_devices.packages import PackageError, PackageInfo
from serversherpa_devices.packages.provision import ProvisionInfo

FAILED = "This file couldn't be inspected. It may be damaged or too large."
WORKER_MODULE = "serversherpa_devices.packages.worker"
DEFAULT_MEMORY_LIMIT = 1024 * 1024 * 1024
# The largest honest answer is an 8 MB icon in base64 plus a capped profile.
OUTPUT_LIMIT = 16 * 1024 * 1024
_STDERR_TAIL = 2000

log = logging.getLogger(__name__)


def inspect_package_isolated(path: Path, *, timeout_seconds: float = 60,
                             memory_limit_bytes: int = DEFAULT_MEMORY_LIMIT) -> PackageInfo:
    """`inspect_package(path)` run in the worker. Raises PackageError with the
    worker's own message, or FAILED when the worker doesn't finish cleanly."""
    command = _worker_command(path, cpu_seconds=math.ceil(timeout_seconds) + 1,
                              memory_limit_bytes=memory_limit_bytes)
    returncode, stdout, stderr = _run_bounded(command, timeout_seconds)
    if returncode != 0:
        log.warning("package inspection worker exited with %s: %s", returncode,
                    stderr.decode(errors="replace"))
        raise PackageError(FAILED)
    try:
        payload = json.loads(stdout)
        if isinstance(payload.get("error"), str):
            error = payload["error"]
        else:
            return from_json(payload["info"])
    except (ValueError, TypeError, KeyError, AttributeError):   # binascii.Error is a ValueError
        log.warning("package inspection worker printed unexpected output")
        raise PackageError(FAILED) from None
    raise PackageError(error)


def _run_bounded(command: list[str], timeout_seconds: float) -> tuple[int, bytes, bytes]:
    """Run the worker; return (exit code, stdout, the tail of stderr). Stdout
    is read up to OUTPUT_LIMIT: past that, or past the timeout, the child is
    killed and the inspection fails."""
    proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=_child_env())
    stdout, stderr = bytearray(), bytearray()
    too_much = threading.Event()

    def read_stdout() -> None:
        while chunk := proc.stdout.read1(65536):
            stdout.extend(chunk)
            if len(stdout) > OUTPUT_LIMIT:
                too_much.set()
                proc.kill()
                return

    def read_stderr() -> None:
        while chunk := proc.stderr.read1(65536):
            stderr.extend(chunk)
            del stderr[:-_STDERR_TAIL]

    readers = [threading.Thread(target=read_stdout, daemon=True),
               threading.Thread(target=read_stderr, daemon=True)]
    for reader in readers:
        reader.start()
    try:
        returncode = proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        log.warning("package inspection timed out after %ss", timeout_seconds)
        raise PackageError(FAILED) from None
    finally:
        for reader in readers:
            reader.join(timeout=5)
        proc.stdout.close()
        proc.stderr.close()
    if too_much.is_set():
        log.warning("package inspection worker printed over %s bytes", OUTPUT_LIMIT)
        raise PackageError(FAILED)
    return returncode, bytes(stdout), bytes(stderr)


def _worker_command(path: Path, *, cpu_seconds: int, memory_limit_bytes: int) -> list[str]:
    return [sys.executable, "-I", "-m", WORKER_MODULE, str(memory_limit_bytes),
            str(cpu_seconds), str(path)]


def _child_env() -> dict[str, str]:
    """Only PATH: the child parses hostile files and needs none of the
    service's settings or secrets (and -I ignores PYTHON* variables)."""
    return {"PATH": os.environ.get("PATH", os.defpath)}


def to_json(info: PackageInfo) -> dict:
    data = dataclasses.asdict(info)
    if info.icon_png is not None:
        data["icon_png"] = base64.b64encode(info.icon_png).decode("ascii")
    if info.provision is not None and info.provision.expires_at is not None:
        data["provision"]["expires_at"] = info.provision.expires_at.isoformat()
    return data


def from_json(data: dict) -> PackageInfo:
    data = dict(data)
    if data.get("icon_png") is not None:
        data["icon_png"] = base64.b64decode(data["icon_png"], validate=True)
    if data.get("provision") is not None:
        profile = dict(data["provision"])
        if profile.get("expires_at") is not None:
            profile["expires_at"] = dt.datetime.fromisoformat(profile["expires_at"])
        data["provision"] = ProvisionInfo(**profile)
    return PackageInfo(**data)
