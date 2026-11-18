"""The isolated inspection worker:

    python -I -m serversherpa_devices.packages.worker MEMORY_BYTES CPU_SECONDS PATH

It sets its own limits before importing any parser, then prints one JSON
object: {"info": ...} (isolated.to_json) or {"error": "<PackageError message>"}.
Anything else (a crash, MemoryError, hitting a limit) exits non-zero. The
limits are set here rather than through subprocess's preexec_fn, which is
unsafe in a threaded parent such as the API server."""

import json
import resource
import sys
from pathlib import Path


def _limit(kind: int, value: int) -> None:
    _, hard = resource.getrlimit(kind)
    if hard != resource.RLIM_INFINITY:
        value = min(value, hard)
    resource.setrlimit(kind, (value, hard if hard != resource.RLIM_INFINITY else value + 1))


def main(argv: list[str]) -> int:
    memory_bytes, cpu_seconds, path = int(argv[0]), int(argv[1]), Path(argv[2])
    _limit(resource.RLIMIT_CPU, cpu_seconds)   # SIGXCPU at the soft limit
    if sys.platform.startswith("linux"):
        # macOS doesn't enforce RLIMIT_AS; there (dev only) the timeout and
        # CPU limit still apply.
        _limit(resource.RLIMIT_AS, memory_bytes)

    from serversherpa_devices.packages import PackageError, inspect_package
    from serversherpa_devices.packages.isolated import to_json

    try:
        result = {"info": to_json(inspect_package(path))}
    except PackageError as err:
        result = {"error": err.message}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
