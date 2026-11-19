"""api/constraints.txt pins the API image's dependency tree to the versions
the API test suite ran on (api/Dockerfile installs with `pip install -c`).
These checks keep it in step with api/pyproject.toml: a dependency added or
dropped there, or given another extra or marker, or a pin outside its
version range, fails here until the lock is refreshed (deploy/stack/README.md,
"API dependency lock"). They read files only: no venv, network or Docker."""
from __future__ import annotations

import re
import subprocess
import tomllib
from dataclasses import dataclass, field

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

from conftest import REPO

LOCK = REPO / "api" / "constraints.txt"
PYPROJECT = REPO / "api" / "pyproject.toml"
DOCKERFILE = REPO / "api" / "Dockerfile"
PROJECT = "serversherpa-api"
ROOTS_HEADER = "# Locked for these api/pyproject.toml dependencies"
REFRESH = "Refresh the lock: api/.venv/bin/python api/scripts/lock_deps.py"
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$")


@dataclass
class Pin:
    name: str
    version: str
    via: list[str] = field(default_factory=list)
    only_on: list[str] = field(default_factory=list)


def parse_lock() -> tuple[list[str], dict[str, Pin], list[str]]:
    """(recorded pyproject dependencies, pins by canonical name, malformed lines)."""
    roots: list[str] = []
    pins: dict[str, Pin] = {}
    bad: list[str] = []
    in_roots = False
    current: Pin | None = None
    for raw in LOCK.read_text().splitlines():
        if raw.startswith(ROOTS_HEADER):
            in_roots = True
            continue
        if raw.startswith("#   ") and in_roots:
            roots.append(raw[4:].strip())
            continue
        in_roots = False
        stripped = raw.strip()
        if not stripped or raw.startswith("#"):
            continue
        if raw[0].isspace() and stripped.startswith("#") and current is not None:
            note = stripped[1:].strip()
            if note.startswith("via "):
                current.via += [p.strip() for p in note[4:].split(",")]
            elif note.startswith("only on Linux "):
                current.only_on += [a.strip() for a in note[14:].split(",")]
            else:
                bad.append(raw)
            continue
        match = PIN.match(stripped)
        if not match or canonicalize_name(match[1]) in pins:
            bad.append(raw)
            current = None
            continue
        current = Pin(match[1], match[2])
        pins[canonicalize_name(match[1])] = current
    return roots, pins, bad


def pyproject_requirements() -> list[Requirement]:
    return [Requirement(r) for r in
            tomllib.loads(PYPROJECT.read_text())["project"]["dependencies"]]


def root_line(req: Requirement) -> str:
    line = canonicalize_name(req.name)
    if req.extras:
        line += "[" + ",".join(sorted(canonicalize_name(e) for e in req.extras)) + "]"
    if req.marker:
        line += f"; {req.marker}"
    return line


def test_lock_is_not_git_ignored() -> None:
    # ss-stack builds from a clean checkout: an ignored lock never gets there
    out = subprocess.run(["git", "check-ignore", "-q", str(LOCK)], cwd=REPO, check=False)
    if out.returncode == 128:
        pytest.skip("not a git checkout")
    assert out.returncode == 1, f"{LOCK.relative_to(REPO)} is git-ignored"


def test_every_line_is_an_exact_pin() -> None:
    _, pins, bad = parse_lock()
    assert pins, f"{LOCK.relative_to(REPO)} pins nothing"
    assert bad == [], f"not `name==version` lines (or duplicates): {bad}"
    for pin in pins.values():
        try:
            Version(pin.version)
        except InvalidVersion:
            pytest.fail(f"{pin.name}=={pin.version}: not a version")
        assert pin.via, f"{pin.name} has no `# via` line"


def test_lock_records_pyprojects_dependencies() -> None:
    roots, _, _ = parse_lock()
    wanted = sorted(root_line(r) for r in pyproject_requirements())
    added = sorted(set(wanted) - set(roots))
    dropped = sorted(set(roots) - set(wanted))
    assert not (added or dropped), (
        f"api/pyproject.toml's dependencies changed since the lock was made "
        f"(new: {added}, gone: {dropped}). {REFRESH}")


def test_every_dependency_is_pinned_within_its_range() -> None:
    _, pins, _ = parse_lock()
    for req in pyproject_requirements():
        pin = pins.get(canonicalize_name(req.name))
        assert pin is not None, f"{req.name} isn't pinned. {REFRESH}"
        assert req.specifier.contains(pin.version, prereleases=True), (
            f"pyproject wants {req}, the lock pins {pin.name}=={pin.version}. {REFRESH}")


def test_every_pin_belongs_to_the_projects_tree() -> None:
    _, pins, _ = parse_lock()
    direct = {name for name, pin in pins.items() if PROJECT in pin.via}
    assert direct == {canonicalize_name(r.name) for r in pyproject_requirements()}, (
        f"pins `via {PROJECT}` that aren't pyproject dependencies, or the reverse. {REFRESH}")
    for pin in pins.values():
        unknown = [p for p in pin.via if p != PROJECT and canonicalize_name(p) not in pins]
        assert not unknown, f"{pin.name} is pulled in by unpinned {unknown}. {REFRESH}"
    # and nothing is left over from a dependency that's gone
    reached, todo = set(), [PROJECT]
    while todo:
        parent = canonicalize_name(todo.pop())
        for name, pin in pins.items():
            if name not in reached and parent in {canonicalize_name(p) for p in pin.via}:
                reached.add(name)
                todo.append(name)
    assert set(pins) == reached, f"pins nothing needs: {sorted(set(pins) - reached)}. {REFRESH}"


def test_dockerfile_installs_with_the_lock_and_verifies_it() -> None:
    text = re.sub(r"\\\n\s*", " ", DOCKERFILE.read_text())
    install = next((line for line in text.splitlines()
                    if line.startswith("RUN ") and "pip install" in line), "")
    assert "-c api-src/constraints.txt ./api-src" in install, install
    assert "api-src/scripts/lock_deps.py verify" in install, install
    assert install.index("pip install") < install.index("lock_deps.py verify")
