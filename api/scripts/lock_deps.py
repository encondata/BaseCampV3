"""The API's dependency lock, api/constraints.txt.

The lock pins serversherpa-api's runtime dependency tree (pyproject's
[project].dependencies and everything they pull in on Linux) to the versions
installed in api/.venv, the venv the API test suite runs in. api/Dockerfile
installs with `pip install -c api/constraints.txt`, so the image gets the
versions the tests ran on instead of whatever PyPI has that day.

    api/.venv/bin/python api/scripts/lock_deps.py          # rewrite the lock from the venv
    api/.venv/bin/python api/scripts/lock_deps.py check    # exit 1 if the venv no longer matches it
    python api/scripts/lock_deps.py verify                 # (in the image) exit 1 if anything
                                                           # installed isn't pinned at that version

`write` and `check` read the installed packages of the interpreter that runs
them, so run them with the venv's python. `verify` needs only the standard
library: the image has no `packaging`.
"""
from __future__ import annotations

import argparse
import difflib
import re
import sys
from importlib import metadata
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
PYPROJECT = API_DIR / "pyproject.toml"
LOCK = API_DIR / "constraints.txt"
PROJECT = "serversherpa-api"
# Installed alongside the app but not part of its tree: pip ships with the
# base image, and the project itself is what's being installed.
NOT_LOCKED = {"pip", PROJECT}
# The image is Debian on amd64 (droplets, ESXi/Proxmox VMs) or arm64 (Docker
# on a Mac). Markers are evaluated for both, not for the Mac running this.
TARGETS = {
    "x86_64": {"sys_platform": "linux", "platform_system": "Linux", "os_name": "posix",
               "platform_machine": "x86_64", "platform_release": "", "platform_version": ""},
    "aarch64": {"sys_platform": "linux", "platform_system": "Linux", "os_name": "posix",
                "platform_machine": "aarch64", "platform_release": "", "platform_version": ""},
}
ROOTS_HEADER = "# Locked for these api/pyproject.toml dependencies (a test compares them):"
REFRESH = "api/.venv/bin/python api/scripts/lock_deps.py"


def canonical(name: str) -> str:
    """PEP 503 name normalization (packaging.utils.canonicalize_name)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def installed() -> dict[str, metadata.Distribution]:
    """Every distribution on this interpreter's path, by canonical name."""
    found: dict[str, metadata.Distribution] = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        if name:
            found.setdefault(canonical(name), dist)
    return found


def root_line(req) -> str:
    """A pyproject dependency as the lock records it: name, extras and
    marker, but not the version range (the test checks pins against that)."""
    line = canonical(req.name)
    if req.extras:
        line += "[" + ",".join(sorted(canonical(e) for e in req.extras)) + "]"
    if req.marker:
        line += f"; {req.marker}"
    return line


def render() -> str:
    """The lock as `write` would write it from this interpreter's packages."""
    import tomllib

    try:
        from packaging.markers import default_environment
        from packaging.requirements import Requirement
    except ImportError:  # pip vendors packaging; the venv has the real one via pytest
        from pip._vendor.packaging.markers import default_environment
        from pip._vendor.packaging.requirements import Requirement

    roots = [Requirement(r) for r in
             tomllib.loads(PYPROJECT.read_text())["project"]["dependencies"]]
    dists = installed()
    base = default_environment()
    envs = {arch: {**base, **overrides} for arch, overrides in TARGETS.items()}

    def applies(req, arch: str, extras: set[str]) -> bool:
        if req.marker is None:
            return True
        return any(req.marker.evaluate({**envs[arch], "extra": e}) for e in extras | {""})

    errors: list[str] = []
    via: dict[str, set[str]] = {}
    arches: dict[str, set[str]] = {}
    for arch in TARGETS:
        # breadth-first from the project's own requirements; a package is
        # walked again whenever a dependent asks for an extra not yet seen
        wanted: dict[str, set[str]] = {}
        queue: list[tuple[object, str, set[str]]] = [(r, PROJECT, set()) for r in roots]
        while queue:
            req, parent, parent_extras = queue.pop(0)
            if not applies(req, arch, parent_extras):
                continue
            name = canonical(req.name)
            dist = dists.get(name)
            if dist is None:
                errors.append(f"{req.name} (needed by {parent} on Linux {arch}) isn't installed "
                              f"in this environment: the tests didn't run with it. Install it in "
                              f"api/.venv, run the API suite, then rerun this script.")
                continue
            if not req.specifier.contains(dist.version, prereleases=True):
                errors.append(f"{parent} needs {req}, but {dist.metadata['Name']} "
                              f"{dist.version} is installed")
            via.setdefault(name, set()).add(parent)
            arches.setdefault(name, set()).add(arch)
            extras = {canonical(e) for e in req.extras}
            seen = wanted.get(name)
            if seen is not None and extras <= seen:
                continue
            wanted[name] = (seen or set()) | extras
            for sub in dist.requires or []:
                queue.append((Requirement(sub), dist.metadata["Name"], wanted[name]))
    if errors:
        raise SystemExit("\n".join(sorted(set(errors))))

    python = ".".join(map(str, sys.version_info[:3]))
    lines = [
        "# The API image's dependency lock: serversherpa-api's runtime dependency",
        "# tree pinned to the versions in api/.venv, where the API test suite runs.",
        "# api/Dockerfile installs with `pip install -c` this file and fails the",
        "# build if anything it installed isn't pinned here at that version.",
        "#",
        "# Generated by api/scripts/lock_deps.py; don't edit it by hand. To refresh it",
        "# (deploy/stack/README.md, \"API dependency lock\"):",
        f"#   {REFRESH}",
        "#",
        f"# Python {python}; markers evaluated for Linux {' and '.join(TARGETS)}.",
        "#",
        ROOTS_HEADER,
        *(f"#   {line}" for line in sorted(root_line(r) for r in roots)),
        "",
    ]
    for name in sorted(via, key=canonical):
        dist = dists[name]
        lines.append(f"{dist.metadata['Name']}=={dist.version}")
        lines.append("    # via " + ", ".join(sorted(via[name], key=canonical)))
        if arches[name] != set(TARGETS):
            lines.append("    # only on Linux " + ", ".join(sorted(arches[name])))
    return "\n".join(lines) + "\n"


def pins(text: str) -> dict[str, tuple[str, str]]:
    """canonical name -> (name as written, version) for each `name==version`."""
    found: dict[str, tuple[str, str]] = {}
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            name, _, version = line.partition("==")
            found[canonical(name)] = (name.strip(), version.strip())
    return found


def verify() -> int:
    """Every installed distribution (but pip and the project) pinned at its version."""
    locked = pins(LOCK.read_text())
    problems = []
    for name, dist in sorted(installed().items()):
        if name in NOT_LOCKED:
            continue
        pinned = locked.get(name)
        if pinned is None:
            problems.append(f"  {dist.metadata['Name']}=={dist.version} isn't in the lock")
        elif pinned[1] != dist.version:
            problems.append(f"  {dist.metadata['Name']}=={dist.version} is pinned at {pinned[1]}")
    if problems:
        print(f"{LOCK.name} doesn't cover what pip installed:", *problems,
              f"Refresh the lock from api/.venv: {REFRESH}", sep="\n", file=sys.stderr)
        return 1
    print(f"every installed package matches {LOCK.name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", nargs="?", default="write", choices=("write", "check", "verify"))
    command = parser.parse_args().command
    if command == "verify":
        return verify()
    text = render()
    if command == "check":
        current = LOCK.read_text() if LOCK.exists() else ""
        if current == text:
            print(f"{LOCK.name} matches this environment")
            return 0
        sys.stdout.writelines(difflib.unified_diff(
            current.splitlines(keepends=True), text.splitlines(keepends=True),
            f"{LOCK.name} (committed)", f"{LOCK.name} (from this environment)"))
        return 1
    LOCK.write_text(text)
    print(f"wrote {LOCK.relative_to(API_DIR.parent)}: {len(pins(text))} packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
