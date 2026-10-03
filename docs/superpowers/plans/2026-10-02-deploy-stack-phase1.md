# Deploy stack — phase 1 (Containerize) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the whole ServerSherpa environment (API + 10 workers + migrate, portal, kiosk, wiki, MinIO, mailpit, Postgres, status) as five Compose stacks driven by one `ss-stack` script, proven end-to-end on this Mac and then deployed by hand to a LAN Ubuntu box as `*.uat.serversherpa.com`.

**Architecture:** Two new images (`api/Dockerfile` for the API and every worker, `portal/Dockerfile` for the SPA) join the existing kiosk, wiki and status images. `deploy/stack/` holds a `build.yml` (the only file that builds), five runtime Compose files (`db`, `storage`, `api`, `web`, `status`) that only reference `image:` tags, an `env.example`, and the `ss-stack` script (build / up / down / ps / dump) that phase 2's Sirdar pipeline will call. Every runtime setting comes from the environment's `.env` plus `STACK_DOMAIN`-derived URLs, so one set of images serves any environment.

**Tech Stack:** Docker Compose v2 (profiles, `up --wait`), BuildKit, bash, Caddy 2, python:3.13-slim-trixie, node:20-alpine, postgres:16-alpine, minio/minio, axllent/mailpit, pytest (the main checkout's `api/.venv`).

**Spec:** `docs/superpowers/specs/2026-10-02-sirdar-deploy-pipeline-design.md` (Section 1 — Target layout; Phasing item 1).

## Global Constraints

- Stack names: Compose project `ss-<STACK_ENV>-<stack>` for stack in `db`, `storage`, `api`, `web`, `status`; every service on the external Docker network `ss-<STACK_ENV>`.
- `STACK_ENV` matches `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`.
- Default published ports: api 8000, portal 8091, kiosk 8090, wiki 8096, spaces (MinIO S3) 9000, status 8095, mailpit UI 8025. Postgres and the MinIO console are never published.
- Public names: `api`, `portal`, `kiosk`, `wiki`, `spaces`, `status` — each `https://<name>.${STACK_DOMAIN}`.
- Containers that call public names (api, every worker, status) map all six names to `STACK_PROXY_IP` via `extra_hosts`.
- Postgres 16 (`postgres:16-alpine`), database and user `serversherpa`.
- Every runtime image reference is `${STACK_<X>_IMAGE:-serversherpa-<x>}:${STACK_IMAGE_TAG}`; only `deploy/stack/build.yml` has `build:`.
- One-shot jobs (`migrate`, `minio-init`) live in the `jobs` profile and are run explicitly by `ss-stack up` with `docker compose run --rm`.
- Every service with a published port has a Compose `healthcheck`. Workers have none (they rely on `restart: unless-stopped` and the API's worker-health summary).
- SMTP always goes to the stack's mailpit; `SS_ENV=staging`.
- The first LAN environment is `uat` (`*.uat.serversherpa.com`) — `*.dev.serversherpa.com` already serves the Mac dev stack. Never touch the `dev` DNS records or NPM hosts.
- American English in all copy and comments. Comment density matches the existing Dockerfiles (a header block explaining why, short inline comments).
- Scripts must run on macOS bash 3.2 as well as Linux bash 5 (no `head -n -N`, no bare `"${empty_array[@]}"` under `set -u`).

## Working environment

- Work in a new worktree: `git worktree add .claude/worktrees/deploy-stack -b deploy-stack sirdar` (branched from `sirdar`, which carries the spec and this plan). All paths below are relative to that worktree.
- The worktree has no `api/.venv`. Run every pytest command with the main checkout's interpreter: `PY=/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python`. `deploy/tests/conftest.py` puts the worktree's `api/src` first on `sys.path`, so tests import the worktree's code, not the main checkout's editable install.
- Default test run (fast, needs only the `docker` CLI): `$PY -m pytest -c deploy/pytest.ini deploy/tests -q`
- Image tests (build images, need the Docker daemon, several minutes): add `-m images`.
- End-to-end test (builds everything and runs a whole environment): `SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -q -s`.
- Never `npm install` in the worktree (its `portal/node_modules` is a symlink to the main checkout). Docker builds don't need it — `.dockerignore` excludes every `node_modules`.

## File map

| File | Responsibility |
|---|---|
| `api/Dockerfile` | The one image for the API, every worker and migrate: Python app + LibreOffice/poppler/pango (wiki worker) + Node and the bundled portal renderers (report/label workers) + `pg_dump` (db-testing worker) + Alembic files |
| `portal/Dockerfile` | Portal SPA built with Vite, served by Caddy |
| `portal/docker/Caddyfile` | Static SPA serving with history fallback and immutable asset caching |
| `deploy/stack/build.yml` | Builds all five images at `STACK_IMAGE_TAG` (the only file with `build:`) |
| `deploy/stack/db/compose.yml` | Postgres |
| `deploy/stack/storage/compose.yml` | MinIO, `minio-init` job, mailpit |
| `deploy/stack/api/compose.yml` | `migrate` job, `api`, 10 workers; the full `SS_*` environment |
| `deploy/stack/web/compose.yml` | portal, kiosk, wiki |
| `deploy/stack/status/compose.yml` | status |
| `deploy/stack/env.example` | One environment's settings, every secret `CHANGEME` |
| `deploy/stack/ss-stack` | build / up / down / ps / dump in dependency order |
| `deploy/stack/README.md` | Manual LAN deploy runbook |
| `deploy/pytest.ini` | Test config + markers |
| `deploy/tests/conftest.py` | Shared paths and docker helpers |
| `deploy/tests/test_api_image.py` | API image contents |
| `deploy/tests/test_portal_image.py` | Portal image serving |
| `deploy/tests/test_stack_config.py` | Rendered Compose config rules + settings coverage |
| `deploy/tests/test_ss_stack.py` | `ss-stack` command sequences against a fake `docker` |
| `deploy/tests/test_stack_e2e.py` | Whole environment on this machine |

---

### Task 1: API image

**Files:**
- Create: `deploy/pytest.ini`
- Create: `deploy/tests/conftest.py`
- Create: `deploy/tests/test_api_image.py`
- Create: `api/Dockerfile`

**Interfaces:**
- Produces: image built by `docker build -f api/Dockerfile .` (repo-root context). Inside: CLI `serversherpa`, `uvicorn`, `alembic`, `node` ≥ 20, `pg_dump`, `soffice`, `pdftoppm`; files `/app/api/alembic.ini`, `/app/api/migrations/`, `/app/renderers/render-rack.js`, `/app/renderers/render-container-labels.js`; env `SS_REPORT_RACK_RENDERER`, `SS_REPORT_CONTAINER_LABEL_RENDERER` pointing at those; runs as uid 10001; default CMD = uvicorn on 0.0.0.0:8000.
- Produces (conftest): `REPO`, `STACK_DIR`, `ENV_EXAMPLE`, `SS_STACK` (Paths); `docker_daemon_ok() -> bool`; `docker_cli_ok() -> bool`; `build_image(dockerfile: str, tag: str) -> None`; `docker_run(tag: str, *cmd: str) -> subprocess.CompletedProcess[str]`; `free_port() -> int`; `wait_http(url: str, timeout: float = 60.0) -> int` (returns the final HTTP status, raises `TimeoutError`).

- [ ] **Step 1: Create the test scaffolding**

`deploy/pytest.ini`:

```ini
[pytest]
testpaths = tests
addopts = -m "not images and not e2e"
markers =
    images: builds a Docker image and inspects it (needs the Docker daemon; minutes)
    e2e: builds every image and runs a whole environment on this machine (opt-in: SS_STACK_E2E=1)
```

`deploy/tests/conftest.py`:

```python
"""Shared helpers for the deploy-stack tests.

Run with the main checkout's interpreter (the worktree has no venv):
    $PY -m pytest -c deploy/pytest.ini deploy/tests
The worktree's api/src goes first on sys.path so settings tests import
this checkout's serversherpa, not the main checkout's editable install.
"""
from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STACK_DIR = REPO / "deploy" / "stack"
ENV_EXAMPLE = STACK_DIR / "env.example"
SS_STACK = STACK_DIR / "ss-stack"

sys.path.insert(0, str(REPO / "api" / "src"))


def docker_cli_ok() -> bool:
    return shutil.which("docker") is not None


def docker_daemon_ok() -> bool:
    if not docker_cli_ok():
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


def build_image(dockerfile: str, tag: str) -> None:
    subprocess.run(["docker", "build", "-f", dockerfile, "-t", tag, "."],
                   cwd=REPO, check=True)


def docker_run(tag: str, *cmd: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", "run", "--rm", tag, *cmd],
                          capture_output=True, text=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 60.0) -> int:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            last = exc
            time.sleep(1)
    raise TimeoutError(f"{url} not answering after {timeout}s: {last}")
```

- [ ] **Step 2: Write the failing image test**

`deploy/tests/test_api_image.py`:

```python
"""The API image carries everything the API, every worker and the
migrate job need — one image, many commands."""
from __future__ import annotations

import pytest

from conftest import build_image, docker_daemon_ok, docker_run

pytestmark = [
    pytest.mark.images,
    pytest.mark.skipif(not docker_daemon_ok(), reason="Docker daemon not available"),
]

TAG = "serversherpa-api:pytest"


@pytest.fixture(scope="module", autouse=True)
def api_image() -> None:
    build_image("api/Dockerfile", TAG)


def test_cli_lists_every_worker_command() -> None:
    out = docker_run(TAG, "serversherpa", "--help")
    assert out.returncode == 0, out.stderr
    for command in ("import-worker", "log-service", "notification-worker",
                    "scan-matching-worker", "report-worker", "label-worker",
                    "spec-lookup-worker", "db-testing-worker", "wiki-worker"):
        assert command in out.stdout


def test_runs_as_uid_10001() -> None:
    assert docker_run(TAG, "id", "-u").stdout.strip() == "10001"


def test_node_is_20_or_newer() -> None:
    out = docker_run(TAG, "node", "--version")
    assert out.returncode == 0, out.stderr
    assert int(out.stdout.strip().lstrip("v").split(".")[0]) >= 20


def test_renderers_are_bundled_and_wired() -> None:
    script = ("const fs=require('fs');"
              "for (const k of ['SS_REPORT_RACK_RENDERER','SS_REPORT_CONTAINER_LABEL_RENDERER'])"
              "{ fs.accessSync(process.env[k]); }")
    out = docker_run(TAG, "node", "-e", script)
    assert out.returncode == 0, out.stderr


@pytest.mark.parametrize("tool", [["pg_dump", "--version"],
                                  ["soffice", "--version"],
                                  ["pdftoppm", "-v"]])
def test_worker_tools_present(tool: list[str]) -> None:
    out = docker_run(TAG, *tool)
    assert out.returncode == 0, out.stderr


def test_migrations_ship_with_the_image() -> None:
    out = docker_run(TAG, "sh", "-c", "cd /app/api && alembic heads")
    assert out.returncode == 0, out.stderr
    assert "(head)" in out.stdout
```

- [ ] **Step 3: Run it to verify it fails**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_api_image.py -m images -q`
Expected: FAIL / ERROR — `docker build` exits non-zero because `api/Dockerfile` does not exist.

- [ ] **Step 4: Write `api/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# ServerSherpa API image — the API (uvicorn), every worker, and the
# one-shot `migrate` job all run THIS image with a different command
# (deploy/stack/api/compose.yml). Build context is the REPO ROOT:
#
#   - the report and label workers shell out to Node renderers that are
#     bundled from portal/src (vite SSR builds with noExternal, so the
#     bundles need no node_modules at runtime) — built in the first stage
#     and wired up through SS_REPORT_*_RENDERER, because the package's
#     own <repo>/portal/dist-node fallback doesn't exist once installed;
#   - the wiki worker needs LibreOffice + poppler (previews, search text)
#     and pango (WeasyPrint exports) — the same packages as
#     wiki/Dockerfile.worker, which this image supersedes in the stack;
#   - the db-testing worker runs pg_dump/psql (Debian's client dumps the
#     stack's Postgres 16 fine);
#   - `migrate` runs Alembic from /app/api, so alembic.ini and
#     migrations/ ship with the image.
#
#   docker build -f api/Dockerfile -t serversherpa-api .
#   docker run --rm serversherpa-api serversherpa --help

# The renderers are plain JS: build them on the build machine's own
# platform so a cross-platform build only emulates the Python stage.
FROM --platform=$BUILDPLATFORM node:20-alpine AS renderers
WORKDIR /app
COPY portal/package.json portal/package-lock.json ./portal/
RUN npm ci --prefix portal --ignore-scripts
COPY portal ./portal
RUN npm --prefix portal run build:rack-renderer \
 && npm --prefix portal run build:container-labels

# trixie, pinned: its nodejs is 20.x (bookworm's is 18, too old for the
# renderers' node20 target)
FROM python:3.13-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/home/serversherpa \
    SS_REPORT_RACK_RENDERER=/app/renderers/render-rack.js \
    SS_REPORT_CONTAINER_LABEL_RENDERER=/app/renderers/render-container-labels.js
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils \
      fonts-dejavu libpango-1.0-0 libpangoft2-1.0-0 \
      nodejs postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api ./api-src
RUN pip install --no-cache-dir ./api-src \
 && mkdir -p /app/api \
 && cp -r api-src/alembic.ini api-src/migrations /app/api/ \
 && rm -rf api-src
COPY --from=renderers /app/portal/dist-node /app/renderers
# LibreOffice needs a writable HOME for its per-run profile
RUN useradd --system --create-home --uid 10001 --home-dir /home/serversherpa serversherpa
USER serversherpa
EXPOSE 8000
CMD ["uvicorn", "serversherpa.api.app:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
```

If `npm ci --prefix portal` refuses the lockfile with an `ERESOLVE` peer-dependency error (the kiosk Dockerfile's comment says it once did), change that one line to `RUN npm ci --prefix portal --ignore-scripts --legacy-peer-deps` and add a one-line comment saying why. Do not change `portal/package-lock.json`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_api_image.py -m images -q`
Expected: PASS (all 9 tests). The first build takes several minutes (LibreOffice).

- [ ] **Step 6: Commit**

```bash
git add deploy/pytest.ini deploy/tests/conftest.py deploy/tests/test_api_image.py api/Dockerfile
git commit -m "feat(deploy): API image — one image for the API, every worker and migrate"
```

---

### Task 2: Portal image

**Files:**
- Create: `deploy/tests/test_portal_image.py`
- Create: `portal/Dockerfile`
- Create: `portal/docker/Caddyfile`

**Interfaces:**
- Consumes: conftest `build_image`, `docker_daemon_ok`, `free_port`, `wait_http`.
- Produces: image built by `docker build -f portal/Dockerfile .`, serving the SPA on container port 8080 with history fallback; no environment variables needed (the portal derives `api.`, `kiosk.`, `wiki.` origins from its own hostname via `portal/src/lib/siblingOrigin.ts`).

- [ ] **Step 1: Write the failing test**

`deploy/tests/test_portal_image.py`:

```python
"""The portal image serves the built SPA on :8080 with a history
fallback, so deep links load the app."""
from __future__ import annotations

import re
import subprocess
import urllib.request
from collections.abc import Iterator

import pytest

from conftest import build_image, docker_daemon_ok, free_port, wait_http

pytestmark = [
    pytest.mark.images,
    pytest.mark.skipif(not docker_daemon_ok(), reason="Docker daemon not available"),
]

TAG = "serversherpa-portal:pytest"


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    build_image("portal/Dockerfile", TAG)
    port = free_port()
    cid = subprocess.run(
        ["docker", "run", "-d", "--rm", "-p", f"127.0.0.1:{port}:8080", TAG],
        capture_output=True, text=True, check=True).stdout.strip()
    try:
        url = f"http://127.0.0.1:{port}"
        wait_http(url + "/", timeout=30)
        yield url
    finally:
        subprocess.run(["docker", "stop", cid], capture_output=True)


def _get(url: str) -> tuple[int, dict[str, str], str]:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status, dict(resp.headers), resp.read().decode()


def test_index_is_the_portal(base_url: str) -> None:
    status, _, body = _get(base_url + "/")
    assert status == 200
    assert "<title>ServerSherpa Portal</title>" in body


def test_deep_links_fall_back_to_index(base_url: str) -> None:
    status, _, body = _get(base_url + "/people/users/00000000-0000-0000-0000-000000000000")
    assert status == 200
    assert "<title>ServerSherpa Portal</title>" in body


def test_hashed_assets_are_cached_forever(base_url: str) -> None:
    _, _, body = _get(base_url + "/")
    asset = re.search(r'src="(/assets/[^"]+\.js)"', body)
    assert asset, "index.html references no /assets/*.js bundle"
    status, headers, _ = _get(base_url + asset.group(1))
    assert status == 200
    assert "immutable" in headers.get("Cache-Control", "")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_portal_image.py -m images -q`
Expected: ERROR — `docker build` fails, `portal/Dockerfile` does not exist.

- [ ] **Step 3: Write `portal/Dockerfile` and `portal/docker/Caddyfile`**

`portal/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# ServerSherpa portal — the SPA (portal/, Vite) served by Caddy. One
# build serves every environment: lib/api.ts and lib/appLinks.ts derive
# the API, kiosk and wiki origins from the page's own hostname
# (portal.uat.serversherpa.com → api.uat.serversherpa.com, see
# lib/siblingOrigin.ts), so nothing environment-specific is baked in and
# no runtime config file is needed. Type-checking (`tsc -b` in
# `npm run build`) happens outside the image, as for the kiosk; the
# rack/label renderers are built into the API image, not here.
#
#   docker build -f portal/Dockerfile -t serversherpa-portal .
#   docker run -p 8091:8080 serversherpa-portal

FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY portal/package.json portal/package-lock.json ./portal/
RUN npm ci --prefix portal --ignore-scripts
COPY portal ./portal
RUN cd portal && npx vite build

FROM caddy:2-alpine
COPY --from=build /app/portal/dist /srv
COPY portal/docker/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
```

(If Task 1 needed `--legacy-peer-deps`, use the same flag and comment here.)

`portal/docker/Caddyfile`:

```caddyfile
# Static SPA: every unknown path falls back to index.html. Vite's
# /assets/* names carry a content hash, so they can be cached forever.
:8080 {
	root * /srv
	encode gzip
	header /assets/* Cache-Control "public, max-age=31536000, immutable"
	header {
		X-Frame-Options SAMEORIGIN
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
	}
	try_files {path} /index.html
	file_server
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_portal_image.py -m images -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add deploy/tests/test_portal_image.py portal/Dockerfile portal/docker/Caddyfile
git commit -m "feat(deploy): portal image — Vite SPA served by Caddy, no per-environment config"
```

---

### Task 3: The five stacks, build file and env.example

**Files:**
- Create: `deploy/tests/test_stack_config.py`
- Create: `deploy/stack/env.example`
- Create: `deploy/stack/build.yml`
- Create: `deploy/stack/db/compose.yml`
- Create: `deploy/stack/storage/compose.yml`
- Create: `deploy/stack/api/compose.yml`
- Create: `deploy/stack/web/compose.yml`
- Create: `deploy/stack/status/compose.yml`

**Interfaces:**
- Consumes: conftest `STACK_DIR`, `ENV_EXAMPLE`, `docker_cli_ok`; `serversherpa.config.Settings` (pydantic-settings, prefix `SS_`).
- Produces: Compose files at `deploy/stack/<stack>/compose.yml` for stacks `db`, `storage`, `api`, `web`, `status`, each with top-level `name: ss-${STACK_ENV}-<stack>` and network `ss-${STACK_ENV}` (external); service names `postgres`, `minio`, `minio-init` (profile `jobs`), `mailpit`, `migrate` (profile `jobs`), `api`, `import-worker`, `log-service`, `notification-worker`, `scan-matching-worker`, `report-worker`, `label-worker`, `spec-lookup-worker`, `db-testing-worker`, `wiki-worker`, `wiki-export-worker`, `portal`, `kiosk`, `wiki`, `status`. `deploy/stack/build.yml` builds services `api`, `portal`, `kiosk`, `wiki`, `status`. Env keys listed in `env.example` (below). Task 4's `ss-stack` relies on all of these names.

- [ ] **Step 1: Write the failing config tests**

`deploy/tests/test_stack_config.py`:

```python
"""Rules every rendered stack must follow (docker compose config, so
interpolation and anchors are resolved exactly as on a target)."""
from __future__ import annotations

import json
import subprocess
from functools import cache
from typing import Any

import pytest

from conftest import ENV_EXAMPLE, STACK_DIR, docker_cli_ok

pytestmark = pytest.mark.skipif(not docker_cli_ok(), reason="docker CLI not available")

STACKS = ("db", "storage", "api", "web", "status")
ENV = "uat"                      # STACK_ENV in env.example
DOMAIN = "uat.serversherpa.com"  # STACK_DOMAIN in env.example
PROXY_IP = "10.0.0.2"            # STACK_PROXY_IP in env.example
TAG = "local"                    # STACK_IMAGE_TAG in env.example
PUBLIC = ("api", "portal", "kiosk", "wiki", "spaces", "status")
WORKERS = {
    "import-worker": ["serversherpa", "import-worker"],
    "log-service": ["serversherpa", "log-service"],
    "notification-worker": ["serversherpa", "notification-worker"],
    "scan-matching-worker": ["serversherpa", "scan-matching-worker"],
    "report-worker": ["serversherpa", "report-worker"],
    "label-worker": ["serversherpa", "label-worker"],
    "spec-lookup-worker": ["serversherpa", "spec-lookup-worker"],
    "db-testing-worker": ["serversherpa", "db-testing-worker"],
    "wiki-worker": ["serversherpa", "wiki-worker", "--exclude-kinds", "export"],
    "wiki-export-worker": ["serversherpa", "wiki-worker", "--kinds", "export"],
}


@cache
def rendered(stack: str) -> dict[str, Any]:
    path = STACK_DIR / "build.yml" if stack == "build" else STACK_DIR / stack / "compose.yml"
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(ENV_EXAMPLE), "-f", str(path),
         "--profile", "jobs", "config", "--format", "json"],
        capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def published(service: dict[str, Any]) -> list[int]:
    return [int(p["published"]) for p in service.get("ports", [])]


def extra_hosts(service: dict[str, Any]) -> dict[str, str]:
    raw = service.get("extra_hosts", [])
    if isinstance(raw, dict):
        return {k: v[0] if isinstance(v, list) else v for k, v in raw.items()}
    pairs = {}
    for entry in raw:
        sep = "=" if "=" in entry else ":"
        host, ip = entry.split(sep, 1)
        pairs[host] = ip
    return pairs


@pytest.mark.parametrize("stack", STACKS)
def test_project_is_named_for_the_environment(stack: str) -> None:
    assert rendered(stack)["name"] == f"ss-{ENV}-{stack}"


@pytest.mark.parametrize("stack", STACKS)
def test_every_service_joins_the_environment_network(stack: str) -> None:
    cfg = rendered(stack)
    assert cfg["networks"]["default"]["name"] == f"ss-{ENV}"
    assert cfg["networks"]["default"]["external"] is True


@pytest.mark.parametrize("stack", STACKS)
def test_published_services_have_healthchecks(stack: str) -> None:
    for name, svc in rendered(stack)["services"].items():
        if svc.get("ports"):
            assert "healthcheck" in svc, f"{stack}/{name} publishes a port without a healthcheck"


def test_default_published_ports() -> None:
    ports = {name: published(svc)
             for stack in STACKS
             for name, svc in rendered(stack)["services"].items()
             if svc.get("ports")}
    assert ports == {"api": [8000], "portal": [8091], "kiosk": [8090], "wiki": [8096],
                     "minio": [9000], "status": [8095], "mailpit": [8025]}


def test_postgres_is_16_and_unpublished() -> None:
    pg = rendered("db")["services"]["postgres"]
    assert pg["image"] == "postgres:16-alpine"
    assert not pg.get("ports")


def test_api_stack_runs_every_worker() -> None:
    services = rendered("api")["services"]
    assert set(services) == {"migrate", "api", *WORKERS}
    for name, command in WORKERS.items():
        assert services[name]["command"] == command
        assert services[name]["restart"] == "unless-stopped"


@pytest.mark.parametrize("stack,service", [("api", "migrate"), ("storage", "minio-init")])
def test_one_shot_jobs_live_in_the_jobs_profile(stack: str, service: str) -> None:
    assert rendered(stack)["services"][service]["profiles"] == ["jobs"]


def test_migrate_runs_alembic_from_the_image() -> None:
    migrate = rendered("api")["services"]["migrate"]
    assert migrate["command"] == ["alembic", "upgrade", "head"]
    assert migrate["working_dir"] == "/app/api"


def test_runtime_images_are_tagged_and_never_built() -> None:
    for stack in ("api", "web", "status"):
        for name, svc in rendered(stack)["services"].items():
            assert "build" not in svc, f"{stack}/{name} builds; only build.yml may"
            assert svc["image"].endswith(f":{TAG}"), f"{stack}/{name}: {svc['image']}"


def test_build_file_builds_exactly_the_runtime_images() -> None:
    built = {svc["image"] for svc in rendered("build")["services"].values()}
    used = {svc["image"]
            for stack in ("api", "web", "status")
            for svc in rendered(stack)["services"].values()}
    assert built == used == {f"serversherpa-{x}:{TAG}"
                             for x in ("api", "portal", "kiosk", "wiki", "status")}


@pytest.mark.parametrize("stack,service", [("api", "api"), ("api", "report-worker"),
                                           ("api", "wiki-export-worker"), ("status", "status")])
def test_public_names_resolve_to_the_proxy(stack: str, service: str) -> None:
    hosts = extra_hosts(rendered(stack)["services"][service])
    assert hosts == {f"{name}.{DOMAIN}": PROXY_IP for name in PUBLIC}


def test_api_environment_covers_every_required_setting() -> None:
    from serversherpa.config import Settings
    env = rendered("api")["services"]["api"]["environment"]
    required = {f"SS_{n.upper()}" for n, f in Settings.model_fields.items() if f.is_required()}
    assert required - set(env) == set()


def test_api_environment_has_no_unknown_ss_keys() -> None:
    from serversherpa.config import Settings
    env = rendered("api")["services"]["api"]["environment"]
    known = {f"SS_{n.upper()}" for n in Settings.model_fields}
    assert {k for k in env if k.startswith("SS_")} - known == set()


def test_api_environment_points_at_the_stack() -> None:
    env = rendered("api")["services"]["api"]["environment"]
    assert env["SS_ENV"] == "staging"
    assert env["SS_API_BASE_URL"] == f"https://api.{DOMAIN}"
    assert env["SS_PORTAL_ORIGIN"] == f"https://portal.{DOMAIN}"
    assert env["SS_WIKI_ORIGIN"] == f"https://wiki.{DOMAIN}"
    assert env["SS_SPACES_ENDPOINT"] == f"https://spaces.{DOMAIN}"
    assert env["SS_SPACES_USE_PATH_STYLE"] == "true"
    assert env["SS_SMTP_HOST"] == "mailpit"
    assert env["SS_DATABASE_SSL"] == "disable"
    assert env["SS_DATABASE_URL"].endswith("@postgres:5432/serversherpa")
    assert env["SS_WIKI_RENDER_URL"] == "http://wiki:8080"
    assert set(env["SS_ALLOWED_ORIGINS"].split(",")) == {
        f"https://{n}.{DOMAIN}" for n in ("portal", "kiosk", "wiki")}


def test_every_worker_shares_the_api_environment() -> None:
    services = rendered("api")["services"]
    for name in ("migrate", *WORKERS):
        assert services[name]["environment"] == services["api"]["environment"], name


def test_web_apps_point_at_the_stack() -> None:
    web = rendered("web")["services"]
    assert web["kiosk"]["environment"]["KIOSK_API_URL"] == f"https://api.{DOMAIN}"
    assert web["kiosk"]["environment"]["KIOSK_PORTAL_URL"] == f"https://portal.{DOMAIN}"
    assert web["wiki"]["environment"]["WIKI_API_URL"] == "http://api:8000"
    status = rendered("status")["services"]["status"]["environment"]
    assert status["STATUS_API_URL"] == f"https://api.{DOMAIN}"
    assert status["STATUS_PUBLIC_URL"] == f"https://status.{DOMAIN}"


def test_env_example_secrets_are_placeholders() -> None:
    lines = dict(line.split("=", 1) for line in ENV_EXAMPLE.read_text().splitlines()
                 if line and not line.startswith("#"))
    for key in ("POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "SS_JWT_SECRET",
                "SS_TOTP_ENCRYPTION_KEY", "SS_PASSWORD_PEPPER", "SS_WIKI_SERVICE_TOKEN"):
        assert lines[key] == "CHANGEME", key
```

- [ ] **Step 2: Run them to verify they fail**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_stack_config.py -q`
Expected: FAIL — `docker compose config` errors (files don't exist).

- [ ] **Step 3: Write `deploy/stack/env.example`**

```dotenv
# One ServerSherpa environment's settings for deploy/stack (ss-stack).
# Copy to /opt/serversherpa/<env>/.env, chmod 600, and replace every
# CHANGEME — ss-stack refuses to build or start while one is left.
# Plain KEY=value lines only: no inline comments, no spaces around "=".
#
# Generate the secrets:
#   hex:    openssl rand -hex 32
#   Fernet: python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'
# POSTGRES_PASSWORD must be hex (it goes into a database URL unescaped).

# ── Environment ─────────────────────────────────────────
# lowercase letters, digits, hyphens; names the Compose projects and network
STACK_ENV=uat
# public names are <service>.<STACK_DOMAIN>
STACK_DOMAIN=uat.serversherpa.com
# image tag every runtime container uses (the deployed git SHA)
STACK_IMAGE_TAG=local
# checkout build.yml builds from
STACK_REPO_DIR=/opt/serversherpa/uat/repo
# LAN IP of Nginx Proxy Manager; containers reach the public names through it
STACK_PROXY_IP=10.0.0.2
# address the published ports bind to on this host
STACK_BIND_IP=0.0.0.0
STACK_API_PORT=8000
STACK_PORTAL_PORT=8091
STACK_KIOSK_PORT=8090
STACK_WIKI_PORT=8096
STACK_SPACES_PORT=9000
STACK_STATUS_PORT=8095
STACK_MAILPIT_PORT=8025
# pre-deploy dumps kept in <env-dir>/backups
STACK_KEEP_DUMPS=5

# ── Secrets ─────────────────────────────────────────────
# hex
POSTGRES_PASSWORD=CHANGEME
# hex; also the API's Spaces secret key
MINIO_ROOT_PASSWORD=CHANGEME
# hex
SS_JWT_SECRET=CHANGEME
# Fernet — must match the seeded data's key, or enrolled 2FA stops working
SS_TOTP_ENCRYPTION_KEY=CHANGEME
# hex — must match the seeded data's pepper, or every password fails
SS_PASSWORD_PEPPER=CHANGEME
# hex; shared by the API, the wiki server and the wiki workers
SS_WIKI_SERVICE_TOKEN=CHANGEME

# ── Optional ────────────────────────────────────────────
SS_SPACES_BUCKET=serversherpa
SS_LOG_LEVEL=INFO
SS_ANTHROPIC_API_KEY=
SS_DB_TESTING_PASSWORD=
```

- [ ] **Step 4: Write `deploy/stack/build.yml`**

```yaml
# Builds every image one environment runs, tagged STACK_IMAGE_TAG — the
# only file in deploy/stack with `build:`. The runtime stacks reference
# the same image names, so moving to a registry later means skipping
# this file and pulling STACK_*_IMAGE instead.
#
#   ss-stack build <env-dir>
name: ss-${STACK_ENV:?set STACK_ENV}-build

services:
  api:
    image: ${STACK_API_IMAGE:-serversherpa-api}:${STACK_IMAGE_TAG:?set STACK_IMAGE_TAG}
    build:
      context: ${STACK_REPO_DIR:?set STACK_REPO_DIR}
      dockerfile: api/Dockerfile
  portal:
    image: ${STACK_PORTAL_IMAGE:-serversherpa-portal}:${STACK_IMAGE_TAG}
    build:
      context: ${STACK_REPO_DIR}
      dockerfile: portal/Dockerfile
  kiosk:
    image: ${STACK_KIOSK_IMAGE:-serversherpa-kiosk}:${STACK_IMAGE_TAG}
    build:
      context: ${STACK_REPO_DIR}
      dockerfile: kiosk/Dockerfile
      args:
        KIOSK_VERSION: ${STACK_IMAGE_TAG}
  wiki:
    image: ${STACK_WIKI_IMAGE:-serversherpa-wiki}:${STACK_IMAGE_TAG}
    build:
      context: ${STACK_REPO_DIR}
      dockerfile: wiki/Dockerfile
  status:
    image: ${STACK_STATUS_IMAGE:-serversherpa-status}:${STACK_IMAGE_TAG}
    build:
      context: ${STACK_REPO_DIR}
      dockerfile: status/Dockerfile
```

- [ ] **Step 5: Write `deploy/stack/db/compose.yml`**

```yaml
# Postgres for one environment. Never published: the API reaches it as
# postgres:5432 on the ss-<env> network, and `ss-stack dump` streams
# pg_dump out through `docker compose exec`.
name: ss-${STACK_ENV:?set STACK_ENV}-db

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: serversherpa
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: serversherpa
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U serversherpa -d serversherpa"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

volumes:
  pgdata:

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 6: Write `deploy/stack/storage/compose.yml`**

```yaml
# Object storage ("spaces") and the environment's mail catcher. MinIO's
# S3 port is published for NPM (spaces.<domain>); the console is not.
# SMTP never leaves the box: the API sends to mailpit:1025 and testers
# read mail at the mailpit UI.
name: ss-${STACK_ENV:?set STACK_ENV}-storage

services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: serversherpa
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD}
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_SPACES_PORT:-9000}:9000"
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped

  # one-shot, run by `ss-stack up` after minio is healthy
  minio-init:
    image: minio/mc:latest
    profiles: ["jobs"]
    environment:
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      BUCKET: ${SS_SPACES_BUCKET:-serversherpa}
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 serversherpa "$$MINIO_ROOT_PASSWORD" &&
      mc mb --ignore-existing "local/$$BUCKET"
      "
    restart: "no"

  mailpit:
    image: axllent/mailpit:latest
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
      MP_SMTP_AUTH_ALLOW_INSECURE: "1"
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_MAILPIT_PORT:-8025}:8025"
    healthcheck:
      test: ["CMD", "/mailpit", "readyz"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  miniodata:

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 7: Write `deploy/stack/api/compose.yml`**

```yaml
# The API, every worker, and the one-shot migrate job — one image, many
# commands. All of them share one environment (x-ss-env) so a setting
# can never differ between the API and a worker. URLs derive from
# STACK_DOMAIN; secrets come from the env file.
name: ss-${STACK_ENV:?set STACK_ENV}-api

x-ss-env: &ss-env
  SS_ENV: staging
  SS_LOG_LEVEL: ${SS_LOG_LEVEL:-INFO}
  SS_API_BASE_URL: https://api.${STACK_DOMAIN:?set STACK_DOMAIN}
  SS_PORTAL_ORIGIN: https://portal.${STACK_DOMAIN}
  SS_WIKI_ORIGIN: https://wiki.${STACK_DOMAIN}
  SS_ALLOWED_ORIGINS: https://portal.${STACK_DOMAIN},https://kiosk.${STACK_DOMAIN},https://wiki.${STACK_DOMAIN}
  SS_COOKIE_DOMAIN: ""
  SS_DATABASE_URL: postgresql+asyncpg://serversherpa:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/serversherpa
  SS_DATABASE_SSL: disable
  SS_JWT_SECRET: ${SS_JWT_SECRET:?set SS_JWT_SECRET}
  SS_TOTP_ENCRYPTION_KEY: ${SS_TOTP_ENCRYPTION_KEY:?set SS_TOTP_ENCRYPTION_KEY}
  SS_PASSWORD_PEPPER: ${SS_PASSWORD_PEPPER:?set SS_PASSWORD_PEPPER}
  # presigned URLs are signed for this host, so it must be the public name
  SS_SPACES_ENDPOINT: https://spaces.${STACK_DOMAIN}
  SS_SPACES_REGION: us-east-1
  SS_SPACES_BUCKET: ${SS_SPACES_BUCKET:-serversherpa}
  SS_SPACES_ACCESS_KEY: serversherpa
  SS_SPACES_SECRET_KEY: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD}
  SS_SPACES_USE_PATH_STYLE: "true"
  SS_SMTP_HOST: mailpit
  SS_SMTP_PORT: "1025"
  SS_SMTP_STARTTLS: "false"
  SS_SMTP_FROM: noreply@${STACK_DOMAIN}
  SS_WIKI_SERVICE_TOKEN: ${SS_WIKI_SERVICE_TOKEN:?set SS_WIKI_SERVICE_TOKEN}
  SS_WIKI_RENDER_URL: http://wiki:8080
  SS_ANTHROPIC_API_KEY: ${SS_ANTHROPIC_API_KEY:-}
  SS_DB_TESTING_PASSWORD: ${SS_DB_TESTING_PASSWORD:-}

x-ss-service: &ss-service
  image: ${STACK_API_IMAGE:-serversherpa-api}:${STACK_IMAGE_TAG:?set STACK_IMAGE_TAG}
  environment: *ss-env
  # the public names go straight to NPM on the LAN, never out and back
  # through the router (hairpin NAT is not a given)
  extra_hosts:
    - "api.${STACK_DOMAIN}:${STACK_PROXY_IP:?set STACK_PROXY_IP}"
    - "portal.${STACK_DOMAIN}:${STACK_PROXY_IP}"
    - "kiosk.${STACK_DOMAIN}:${STACK_PROXY_IP}"
    - "wiki.${STACK_DOMAIN}:${STACK_PROXY_IP}"
    - "spaces.${STACK_DOMAIN}:${STACK_PROXY_IP}"
    - "status.${STACK_DOMAIN}:${STACK_PROXY_IP}"
  restart: unless-stopped

services:
  # one-shot, run by `ss-stack up` before the API starts
  migrate:
    <<: *ss-service
    profiles: ["jobs"]
    working_dir: /app/api
    command: ["alembic", "upgrade", "head"]
    restart: "no"

  api:
    <<: *ss-service
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_API_PORT:-8000}:8000"
    healthcheck:
      test: ["CMD", "python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"]
      interval: 10s
      timeout: 5s
      start_period: 20s
      retries: 6

  import-worker:
    <<: *ss-service
    command: ["serversherpa", "import-worker"]
  log-service:
    <<: *ss-service
    command: ["serversherpa", "log-service"]
  notification-worker:
    <<: *ss-service
    command: ["serversherpa", "notification-worker"]
  scan-matching-worker:
    <<: *ss-service
    command: ["serversherpa", "scan-matching-worker"]
  report-worker:
    <<: *ss-service
    command: ["serversherpa", "report-worker"]
  label-worker:
    <<: *ss-service
    command: ["serversherpa", "label-worker"]
  spec-lookup-worker:
    <<: *ss-service
    command: ["serversherpa", "spec-lookup-worker"]
  db-testing-worker:
    <<: *ss-service
    command: ["serversherpa", "db-testing-worker"]
  # two wiki workers so a long export never holds up previews and search
  # text (same split as wiki/docker-compose.yml)
  wiki-worker:
    <<: *ss-service
    command: ["serversherpa", "wiki-worker", "--exclude-kinds", "export"]
  wiki-export-worker:
    <<: *ss-service
    command: ["serversherpa", "wiki-worker", "--kinds", "export"]

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 8: Write `deploy/stack/web/compose.yml`**

```yaml
# The three browser apps. The portal needs no settings (it derives its
# siblings from its own hostname); the kiosk writes its two URLs into
# config.js at start; the wiki server talks to the API over the
# ss-<env> network.
name: ss-${STACK_ENV:?set STACK_ENV}-web

services:
  portal:
    image: ${STACK_PORTAL_IMAGE:-serversherpa-portal}:${STACK_IMAGE_TAG:?set STACK_IMAGE_TAG}
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_PORTAL_PORT:-8091}:8080"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/ >/dev/null"]
      interval: 15s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  kiosk:
    image: ${STACK_KIOSK_IMAGE:-serversherpa-kiosk}:${STACK_IMAGE_TAG}
    environment:
      KIOSK_API_URL: https://api.${STACK_DOMAIN:?set STACK_DOMAIN}
      KIOSK_PORTAL_URL: https://portal.${STACK_DOMAIN}
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_KIOSK_PORT:-8090}:8080"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/ >/dev/null"]
      interval: 15s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # exactly ONE replica: the collab server keeps open pages in memory
  wiki:
    image: ${STACK_WIKI_IMAGE:-serversherpa-wiki}:${STACK_IMAGE_TAG}
    environment:
      WIKI_API_URL: http://api:8000
      WIKI_SERVICE_TOKEN: ${SS_WIKI_SERVICE_TOKEN:?set SS_WIKI_SERVICE_TOKEN}
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_WIKI_PORT:-8096}:8080"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 15s
      timeout: 5s
      start_period: 10s
      retries: 5
    restart: unless-stopped

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 9: Write `deploy/stack/status/compose.yml`**

```yaml
# The status page. It checks the PUBLIC names (what users see), which
# resolve to NPM on the LAN via extra_hosts. Its own volume, so it can
# move to its own host later untouched. Outage alerts (ntfy) stay off
# for UAT environments.
name: ss-${STACK_ENV:?set STACK_ENV}-status

services:
  status:
    image: ${STACK_STATUS_IMAGE:-serversherpa-status}:${STACK_IMAGE_TAG:?set STACK_IMAGE_TAG}
    environment:
      STATUS_API_URL: https://api.${STACK_DOMAIN:?set STACK_DOMAIN}
      STATUS_PORTAL_URL: https://portal.${STACK_DOMAIN}
      STATUS_KIOSK_URL: https://kiosk.${STACK_DOMAIN}
      STATUS_WIKI_URL: https://wiki.${STACK_DOMAIN}
      STATUS_PUBLIC_URL: https://status.${STACK_DOMAIN}
    extra_hosts:
      - "api.${STACK_DOMAIN}:${STACK_PROXY_IP:?set STACK_PROXY_IP}"
      - "portal.${STACK_DOMAIN}:${STACK_PROXY_IP}"
      - "kiosk.${STACK_DOMAIN}:${STACK_PROXY_IP}"
      - "wiki.${STACK_DOMAIN}:${STACK_PROXY_IP}"
      - "spaces.${STACK_DOMAIN}:${STACK_PROXY_IP}"
      - "status.${STACK_DOMAIN}:${STACK_PROXY_IP}"
    ports:
      - "${STACK_BIND_IP:-0.0.0.0}:${STACK_STATUS_PORT:-8095}:8080"
    volumes:
      - status-data:/data
    healthcheck:
      test: ["CMD", "python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
    restart: unless-stopped

volumes:
  status-data:

networks:
  default:
    name: ss-${STACK_ENV}
    external: true
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_stack_config.py -q`
Expected: PASS (all tests). If `test_api_environment_covers_every_required_setting` lists a missing key, add it to `x-ss-env` (deriving it from `STACK_DOMAIN` or a new `env.example` entry) — never weaken the test. If `extra_hosts` comes back in a shape `extra_hosts()` doesn't parse, fix the helper, not the assertion.

- [ ] **Step 11: Commit**

```bash
git add deploy/stack deploy/tests/test_stack_config.py
git commit -m "feat(deploy): five Compose stacks (db, storage, api, web, status), build file and env.example"
```

---

### Task 4: `ss-stack` script

**Files:**
- Create: `deploy/tests/test_ss_stack.py`
- Create: `deploy/stack/ss-stack` (mode 755)

**Interfaces:**
- Consumes: Task 3's file paths, project names, the `jobs` profile services `minio-init` and `migrate`, env keys `STACK_ENV`, `STACK_KEEP_DUMPS`.
- Produces: `deploy/stack/ss-stack <command> <env-dir> [--volumes]` with commands `build`, `up`, `down [--volumes]`, `ps`, `dump`. `<env-dir>` holds `.env` and `backups/`. `dump` prints the new dump's path on stdout. Exit non-zero with `ss-stack: <reason>` on stderr for every refusal. Phase 2's pipeline calls exactly these commands.

- [ ] **Step 1: Write the failing tests**

`deploy/tests/test_ss_stack.py`:

```python
"""ss-stack runs the five stacks in dependency order. A fake `docker`
on PATH records every call, so these tests need no daemon."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from conftest import ENV_EXAMPLE, SS_STACK, STACK_DIR

FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "network inspect "*) [[ -n "${FAKE_NETWORK_EXISTS:-}" ]] && exit 0 || exit 1 ;;
  *pg_dump*) [[ -n "${FAKE_FAIL_PG_DUMP:-}" ]] && exit 1; printf 'PGDMP-fake' ;;
esac
exit 0
"""


@pytest.fixture
def env_dir(tmp_path: Path) -> Path:
    d = tmp_path / "uat"
    d.mkdir()
    text = ENV_EXAMPLE.read_text().replace("=CHANGEME", "=0123abcd")
    (d / ".env").write_text(text)
    return d.resolve()   # ss-stack logs the physical path (macOS /private/var)


@pytest.fixture
def fake(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    log.touch()
    return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "DOCKER_LOG": str(log)}


def run(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SS_STACK), *args], env=env,
                          capture_output=True, text=True)


def calls(env: dict[str, str]) -> list[str]:
    return Path(env["DOCKER_LOG"]).read_text().splitlines()


def dc(env_dir: Path, stack: str, rest: str) -> str:
    return (f"compose --env-file {env_dir}/.env -f {STACK_DIR}/{stack}/compose.yml {rest}")


def test_up_starts_stacks_in_dependency_order(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    wait = "up -d --wait --wait-timeout 300 --remove-orphans"
    assert calls(fake) == [
        "network inspect ss-uat",
        "network create ss-uat",
        dc(env_dir, "db", wait),
        dc(env_dir, "storage", wait),
        dc(env_dir, "storage", "run --rm minio-init"),
        dc(env_dir, "api", "run --rm migrate"),
        dc(env_dir, "api", wait),
        dc(env_dir, "web", wait),
        dc(env_dir, "status", wait),
    ]


def test_up_reuses_an_existing_network(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert "network create ss-uat" not in calls(fake)


@pytest.mark.parametrize("command", ["build", "up"])
def test_refuses_placeholder_secrets(env_dir: Path, fake: dict[str, str], command: str) -> None:
    (env_dir / ".env").write_text(ENV_EXAMPLE.read_text())
    out = run(fake, command, str(env_dir))
    assert out.returncode != 0
    assert "SS_JWT_SECRET" in out.stderr
    assert calls(fake) == []


@pytest.mark.parametrize("bad", ["Bad_Name", "-uat", "uat-", "a"])
def test_rejects_bad_environment_names(env_dir: Path, fake: dict[str, str], bad: str) -> None:
    env_file = env_dir / ".env"
    env_file.write_text(env_file.read_text().replace("STACK_ENV=uat", f"STACK_ENV={bad}"))
    out = run(fake, "ps", str(env_dir))
    assert out.returncode != 0
    assert "STACK_ENV" in out.stderr


def test_missing_env_file_is_refused(tmp_path: Path, fake: dict[str, str]) -> None:
    out = run(fake, "up", str(tmp_path))
    assert out.returncode != 0
    assert ".env" in out.stderr


def test_unknown_command_prints_usage(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "explode", str(env_dir))
    assert out.returncode == 2
    assert "ss-stack build" in out.stdout + out.stderr


def test_build_uses_only_the_build_file(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "build", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [f"compose --env-file {env_dir}/.env -f {STACK_DIR}/build.yml build"]


def test_down_stops_in_reverse_order_and_keeps_data(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "down", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, s, "down") for s in ("status", "web", "api", "storage", "db")]


def test_down_volumes_deletes_data_and_the_network(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "down", str(env_dir), "--volumes")
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [
        *[dc(env_dir, s, "down --volumes") for s in ("status", "web", "api", "storage", "db")],
        "network rm ss-uat",
    ]


def test_ps_lists_every_stack(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "ps", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, s, "ps") for s in ("db", "storage", "api", "web", "status")]


def test_dump_writes_and_keeps_the_newest(env_dir: Path, fake: dict[str, str]) -> None:
    backups = env_dir / "backups"
    backups.mkdir()
    for i in range(6):
        (backups / f"20200101T00000{i}Z.dump").write_text("old")
    out = run(fake, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    new = Path(out.stdout.strip())
    assert new.parent == backups and new.read_text() == "PGDMP-fake"
    assert calls(fake) == [dc(env_dir, "db",
                              "exec -T postgres pg_dump -U serversherpa -d serversherpa -Fc")]
    remaining = sorted(p.name for p in backups.glob("*.dump"))
    assert len(remaining) == 5
    assert new.name in remaining
    assert "20200101T000000Z.dump" not in remaining
    assert "20200101T000001Z.dump" not in remaining


def test_failed_dump_leaves_no_partial_file(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_FAIL_PG_DUMP": "1"}, "dump", str(env_dir))
    assert out.returncode != 0
    assert "pg_dump failed" in out.stderr
    assert list((env_dir / "backups").glob("*.dump")) == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py -q`
Expected: FAIL — `bash: …/ss-stack: No such file or directory`.

- [ ] **Step 3: Write `deploy/stack/ss-stack`**

```bash
#!/usr/bin/env bash
# ss-stack — run one ServerSherpa environment's five Compose stacks
# (db, storage, api, web, status) on this host, in dependency order.
#
#   ss-stack build <env-dir>              build every image at STACK_IMAGE_TAG
#   ss-stack up    <env-dir>              start or update everything, waiting on health
#   ss-stack down  <env-dir> [--volumes]  stop everything; --volumes also deletes the data
#   ss-stack ps    <env-dir>              list every stack's containers
#   ss-stack dump  <env-dir>              pg_dump into <env-dir>/backups (keeps STACK_KEEP_DUMPS)
#
# <env-dir> holds the environment's .env (see env.example) and backups/.
# Sirdar's deploy pipeline runs exactly these commands over SSH.
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACKS=(db storage api web status)
WAIT=(--wait --wait-timeout 300 --remove-orphans)

die() { echo "ss-stack: $*" >&2; exit 1; }
usage() { sed -n '4,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

[[ $# -ge 2 ]] || usage
cmd=$1
env_dir=$(cd "$2" 2>/dev/null && pwd) || die "no such environment directory: $2"
shift 2
env_file="$env_dir/.env"
[[ -f $env_file ]] || die "missing $env_file (copy deploy/stack/env.example)"

# One value from the env file: last assignment wins, surrounding quotes dropped.
env_value() {
  local v
  v=$(sed -n "s/^$1=//p" "$env_file" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

STACK_ENV=$(env_value STACK_ENV)
[[ $STACK_ENV =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] \
  || die "STACK_ENV must be 2-32 lowercase letters, digits and hyphens (got '$STACK_ENV')"
NETWORK="ss-$STACK_ENV"

dc() {  # dc <stack> <compose args…>
  local stack=$1; shift
  docker compose --env-file "$env_file" -f "$STACK_DIR/$stack/compose.yml" "$@"
}

refuse_placeholders() {
  local left
  left=$(grep -oE '^[A-Z0-9_]+=CHANGEME' "$env_file" | cut -d= -f1 | tr '\n' ' ' || true)
  [[ -z $left ]] || die "replace the CHANGEME values in $env_file: $left"
}

case $cmd in
  build)
    [[ $# -eq 0 ]] || usage
    refuse_placeholders
    docker compose --env-file "$env_file" -f "$STACK_DIR/build.yml" build
    ;;
  up)
    [[ $# -eq 0 ]] || usage
    refuse_placeholders
    docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
    dc db up -d "${WAIT[@]}"
    dc storage up -d "${WAIT[@]}"
    dc storage run --rm minio-init
    dc api run --rm migrate
    dc api up -d "${WAIT[@]}"
    dc web up -d "${WAIT[@]}"
    dc status up -d "${WAIT[@]}"
    ;;
  down)
    volumes=""
    if [[ ${1:-} == --volumes ]]; then volumes="--volumes"; shift; fi
    [[ $# -eq 0 ]] || usage
    for (( i=${#STACKS[@]}-1; i>=0; i-- )); do
      # $volumes is deliberately unquoted: empty means no argument at all
      # shellcheck disable=SC2086
      dc "${STACKS[i]}" down $volumes
    done
    if [[ -n $volumes ]]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
    ;;
  ps)
    [[ $# -eq 0 ]] || usage
    for s in "${STACKS[@]}"; do dc "$s" ps; done
    ;;
  dump)
    [[ $# -eq 0 ]] || usage
    keep=$(env_value STACK_KEEP_DUMPS)
    keep=${keep:-5}
    [[ $keep =~ ^[1-9][0-9]*$ ]] || die "STACK_KEEP_DUMPS must be a whole number above 0"
    mkdir -p "$env_dir/backups"
    out="$env_dir/backups/$(date -u +%Y%m%dT%H%M%SZ).dump"
    if ! dc db exec -T postgres pg_dump -U serversherpa -d serversherpa -Fc > "$out"; then
      rm -f "$out"
      die "pg_dump failed"
    fi
    # names are UTC timestamps, so name order is age order (newest first)
    ls -1 "$env_dir/backups"/*.dump | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r old; do
      rm -f "$old"
    done
    echo "$out"
    ;;
  *)
    usage
    ;;
esac
```

Then: `chmod 755 deploy/stack/ss-stack`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests/test_ss_stack.py -q`
Expected: PASS (all tests). Also run `shellcheck deploy/stack/ss-stack` if shellcheck is installed; expected: no findings.

- [ ] **Step 5: Commit**

```bash
git add deploy/stack/ss-stack deploy/tests/test_ss_stack.py
git commit -m "feat(deploy): ss-stack — build, up, down, ps and dump in dependency order"
```

---

### Task 5: End-to-end environment on this machine

**Files:**
- Create: `deploy/tests/test_stack_e2e.py`
- Modify (only if the run exposes a defect): any file from Tasks 1–4

**Interfaces:**
- Consumes: `ss-stack` (Task 4), all stacks (Task 3), all images (Tasks 1–2 + existing kiosk/wiki/status Dockerfiles), conftest `REPO`, `SS_STACK`, `wait_http`, `docker_daemon_ok`.
- Produces: proof that a whole environment builds, migrates, starts healthy, keeps every worker running, and dumps — the gate before the LAN deploy.

- [ ] **Step 1: Write the end-to-end test**

`deploy/tests/test_stack_e2e.py`:

```python
"""A whole environment on this machine: build every image, start every
stack, check every service answers and every worker stays up, dump the
database, tear it all down. Opt-in (minutes, real containers):

    SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s

Ports sit in the 18xxx/19xxx range so the Mac dev stack (8000, 8025,
9000, ...) can keep running alongside.
"""
from __future__ import annotations

import base64
import os
import secrets
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from conftest import REPO, SS_STACK, docker_daemon_ok, wait_http

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1"),
    pytest.mark.skipif(not docker_daemon_ok(), reason="Docker daemon not available"),
]

PORTS = {"API": 18000, "PORTAL": 18091, "KIOSK": 18090, "WIKI": 18096,
         "SPACES": 19000, "STATUS": 18095, "MAILPIT": 18025}
SERVICES = {"api", "import-worker", "log-service", "notification-worker",
            "scan-matching-worker", "report-worker", "label-worker",
            "spec-lookup-worker", "db-testing-worker", "wiki-worker", "wiki-export-worker"}


def ss(*args: str, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SS_STACK), *args], capture_output=True,
                          text=True, timeout=timeout)


@pytest.fixture(scope="module")
def env_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    d = tmp_path_factory.mktemp("e2e")
    fernet = base64.urlsafe_b64encode(os.urandom(32)).decode()
    lines = [
        "STACK_ENV=e2e", "STACK_DOMAIN=e2e.serversherpa.test", "STACK_IMAGE_TAG=e2e",
        f"STACK_REPO_DIR={REPO}", "STACK_PROXY_IP=127.0.0.1", "STACK_BIND_IP=127.0.0.1",
        *[f"STACK_{k}_PORT={v}" for k, v in PORTS.items()],
        "STACK_KEEP_DUMPS=5",
        f"POSTGRES_PASSWORD={secrets.token_hex(16)}",
        f"MINIO_ROOT_PASSWORD={secrets.token_hex(16)}",
        f"SS_JWT_SECRET={secrets.token_hex(32)}",
        f"SS_TOTP_ENCRYPTION_KEY={fernet}",
        f"SS_PASSWORD_PEPPER={secrets.token_hex(32)}",
        f"SS_WIKI_SERVICE_TOKEN={secrets.token_hex(32)}",
    ]
    (d / ".env").write_text("\n".join(lines) + "\n")
    build = ss("build", str(d), timeout=3600)
    assert build.returncode == 0, build.stdout[-4000:] + build.stderr[-4000:]
    up = ss("up", str(d))
    try:
        assert up.returncode == 0, up.stdout[-4000:] + up.stderr[-4000:]
        yield d
    finally:
        ss("down", str(d), "--volumes")


@pytest.mark.parametrize("name,path", [
    ("API", "/healthz"), ("PORTAL", "/"), ("KIOSK", "/"), ("WIKI", "/healthz"),
    ("SPACES", "/minio/health/live"), ("STATUS", "/healthz"), ("MAILPIT", "/"),
])
def test_every_service_answers(env_dir: Path, name: str, path: str) -> None:
    assert wait_http(f"http://127.0.0.1:{PORTS[name]}{path}", timeout=60) == 200


def test_migrations_reached_head(env_dir: Path) -> None:
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_dir / ".env"),
         "-f", str(REPO / "deploy/stack/api/compose.yml"),
         "exec", "-T", "-w", "/app/api", "api", "alembic", "current"],
        capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert "(head)" in out.stdout


def test_every_worker_stays_up(env_dir: Path) -> None:
    time.sleep(20)   # long enough for a crashing worker to restart at least once
    out = subprocess.run(
        ["docker", "ps", "--filter", "label=com.docker.compose.project=ss-e2e-api",
         "--format", '{{.Label "com.docker.compose.service"}} {{.ID}}'],
        capture_output=True, text=True, check=True)
    rows = dict(line.split() for line in out.stdout.splitlines())
    assert set(rows) == SERVICES
    for service, cid in rows.items():
        restarts = subprocess.run(["docker", "inspect", "-f", "{{.RestartCount}}", cid],
                                  capture_output=True, text=True, check=True).stdout.strip()
        assert restarts == "0", f"{service} restarted {restarts} times"


def test_dump_produces_a_postgres_archive(env_dir: Path) -> None:
    out = ss("dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    dump = Path(out.stdout.strip())
    assert dump.read_bytes()[:5] == b"PGDMP"
```

- [ ] **Step 2: Run it**

Run: `SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -q -s`
Expected: PASS (11 tests). First run builds every image (expect 10–20 minutes).

- [ ] **Step 3: Fix what the run exposes**

For any failure, use superpowers:systematic-debugging: read the failing container's logs with `docker compose --env-file <env-dir>/.env -f deploy/stack/<stack>/compose.yml logs <service>` (re-run with the teardown commented out locally to keep containers around — do NOT commit that). Fix the cause in the file from Tasks 1–4 it belongs to, add or adjust a fast test in `test_stack_config.py` / `test_ss_stack.py` that would have caught it when one is possible, and re-run Step 2 until green. Likely candidates: a worker needing a setting `x-ss-env` lacks (add it there), a healthcheck tool missing from an image (switch the check to a tool the image has).

- [ ] **Step 4: Run the fast suite too**

Run: `$PY -m pytest -c deploy/pytest.ini deploy/tests -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy api portal
git commit -m "test(deploy): whole environment end to end — build, migrate, health, workers stay up, dump"
```

---

### Task 6: LAN deploy runbook

**Files:**
- Create: `deploy/stack/README.md`
- Modify: `.dockerignore` — no change expected; verify `deploy/stack/README.md` is not needed in any image (it isn't; `*.md` stays excluded)

**Interfaces:**
- Consumes: everything above.
- Produces: the step-by-step manual deploy that Task 7 follows and phase 2 automates.

- [ ] **Step 1: Write `deploy/stack/README.md`**

````markdown
# deploy/stack — one ServerSherpa environment on one host

Five Compose stacks run one environment on a Docker host:

| Stack | Services | Published |
|---|---|---|
| `db` | postgres (16) | — |
| `storage` | minio, minio-init (job), mailpit | 9000 (spaces), 8025 (mailpit UI) |
| `api` | migrate (job), api, 10 workers | 8000 |
| `web` | portal, kiosk, wiki | 8091, 8090, 8096 |
| `status` | status | 8095 |

All of them share the Docker network `ss-<env>`. `ss-stack` runs them in
order; Sirdar's deploy pipeline (phase 2) will run the same commands.

## Manual deploy to an Ubuntu host (phase 1)

These steps assume Ubuntu 22.04/24.04 with sudo, on the same LAN as Nginx
Proxy Manager. Use an environment name other than `dev` — the
`*.dev.serversherpa.com` names already serve the Mac dev stack. The first
LAN environment is `uat`.

1. **Docker** (skip if `docker compose version` works):

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker "$USER"   # then log out and back in
   ```

2. **Checkout** (the deployed SHA becomes the image tag):

   ```bash
   sudo mkdir -p /opt/serversherpa/uat && sudo chown "$USER" /opt/serversherpa/uat
   git clone https://github.com/encondata/BaseCampV3.git /opt/serversherpa/uat/repo
   git -C /opt/serversherpa/uat/repo checkout <branch-or-sha>
   ```

3. **Settings**:

   ```bash
   cp /opt/serversherpa/uat/repo/deploy/stack/env.example /opt/serversherpa/uat/.env
   chmod 600 /opt/serversherpa/uat/.env
   ```

   Edit `/opt/serversherpa/uat/.env`:
   - `STACK_IMAGE_TAG` = `git -C /opt/serversherpa/uat/repo rev-parse --short HEAD`
   - `STACK_PROXY_IP` = NPM's LAN IP
   - every `CHANGEME`: hex values from `openssl rand -hex 32`; the
     Fernet key from
     `python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'`.
     To sign in with existing accounts later, `SS_PASSWORD_PEPPER` and
     `SS_TOTP_ENCRYPTION_KEY` must instead equal the values of the
     database you seed from.

4. **Build and start**:

   ```bash
   cd /opt/serversherpa/uat/repo/deploy/stack
   ./ss-stack build /opt/serversherpa/uat
   ./ss-stack up /opt/serversherpa/uat
   ./ss-stack ps /opt/serversherpa/uat
   ```

5. **DNS (Cloudflare, DNS only / grey cloud)** — A records to the WAN IP
   (`curl -fsS https://api.ipify.org` on the host):
   `api.uat`, `portal.uat`, `kiosk.uat`, `wiki.uat`, `spaces.uat`, `status.uat`.

6. **Nginx Proxy Manager** — one proxy host per name, scheme `http`,
   forward to the host's LAN IP, Websockets Support ON, then SSL tab:
   request a new Let's Encrypt certificate, Force SSL ON.

   | Domain | Forward port |
   |---|---|
   | `api.uat.serversherpa.com` | 8000 |
   | `portal.uat.serversherpa.com` | 8091 |
   | `kiosk.uat.serversherpa.com` | 8090 |
   | `wiki.uat.serversherpa.com` | 8096 |
   | `spaces.uat.serversherpa.com` | 9000 |
   | `status.uat.serversherpa.com` | 8095 |

   For `spaces`, add to the Advanced tab: `client_max_body_size 0;`
   (large uploads go straight to MinIO).

7. **First admin** (an empty database has no users):

   ```bash
   docker compose --env-file /opt/serversherpa/uat/.env -f api/compose.yml \
     exec api serversherpa bootstrap-admin \
       --email you@example.com --first-name First --last-name Last
   ```

   It prompts for the password twice (hidden).

## Updating

```bash
git -C /opt/serversherpa/uat/repo fetch && git -C /opt/serversherpa/uat/repo checkout <sha>
# set STACK_IMAGE_TAG to the new short SHA in /opt/serversherpa/uat/.env
./ss-stack dump  /opt/serversherpa/uat     # pre-deploy dump
./ss-stack build /opt/serversherpa/uat
./ss-stack up    /opt/serversherpa/uat     # migrate runs before the API restarts
```

Roll back: set `STACK_IMAGE_TAG` back to the previous SHA (its images are
still on the host), restore the dump with `pg_restore --clean`, then
`./ss-stack up`.

## Tests

From the repo root, with any Python that has pytest:

```bash
python -m pytest -c deploy/pytest.ini deploy/tests              # config + script (seconds)
python -m pytest -c deploy/pytest.ini deploy/tests -m images    # build and inspect images
SS_STACK_E2E=1 python -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s   # whole environment
```
````

- [ ] **Step 2: Commit**

```bash
git add deploy/stack/README.md
git commit -m "docs(deploy): manual LAN deploy runbook for deploy/stack"
```

---

### Task 7: Live LAN deploy as `uat` (controller + Jimmy — not a subagent task)

This task touches real infrastructure (an Ubuntu host, Cloudflare, NPM), so the controlling session runs it with Jimmy, following `deploy/stack/README.md` exactly and fixing the README wherever reality differs.

- [ ] **Step 1:** Ask Jimmy for the target host (LAN IP, SSH user) and NPM's LAN IP. Confirm the environment name `uat` and that nothing already uses `*.uat.serversherpa.com`.
- [ ] **Step 2:** Run README steps 1–4 on the host over SSH. Expected: `ss-stack up` exits 0 and `ss-stack ps` shows every service `running`/`healthy`.
- [ ] **Step 3:** Jimmy creates the six DNS records and six NPM proxy hosts (README steps 5–6) — or the controller does it in Jimmy's browser with Jimmy's explicit go-ahead for each submit.
- [ ] **Step 4:** Verify in the browser pane: `https://portal.uat.serversherpa.com` loads the sign-in page with a valid certificate; `https://api.uat.serversherpa.com/healthz` is 200; `https://wiki.uat…`, `https://kiosk.uat…`, `https://status.uat…` load; `https://spaces.uat.serversherpa.com/minio/health/live` is 200.
- [ ] **Step 5:** Create the first admin (README step 7), sign in to the portal, upload a wiki attachment and open it (proves presigned `spaces.` URLs and the wiki workers), and check that an email triggered by the portal shows up in mailpit on port 8025.
- [ ] **Step 6:** Commit README corrections found during the run: `git commit -m "docs(deploy): runbook fixes from the first uat deploy"`.

---

## Self-review notes

- Spec Section 1 coverage: images (Tasks 1–2, existing kiosk/wiki/status reused via `build.yml`), five stacks + network + prefixes (Task 3), default ports (Task 3 test), env-only configuration and public `SS_SPACES_ENDPOINT` (Task 3), mailpit SMTP (Task 3), healthchecks + start order (Tasks 3–4), hairpin-free public names (Task 3), image tag = SHA with registry seam (`build.yml` + `STACK_*_IMAGE`), Postgres 16 (Task 3), pre-deploy dump (Task 4 `dump`, used by phase 2 step 6).
- Deferred to later phases by the spec: Sirdar-rendered `.env` and secrets (phase 2), snapshots and restore (phase 3), Cloudflare/NPM automation and smoke tests (phase 4).
- `wiki/docker-compose.yml`, `kiosk/docker-compose.yml`, `status/docker-compose.yml` and `wiki/Dockerfile.worker` stay as they are — they serve standalone installs; `deploy/stack` is additive.
