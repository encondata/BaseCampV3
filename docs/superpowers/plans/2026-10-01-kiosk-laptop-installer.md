# Kiosk Laptop Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command per OS (Windows, macOS, Linux) installs Docker if needed, pulls the prebuilt kiosk-laptop image from GHCR, configures and starts it, opens it at sign-in, and keeps it updated nightly; CI builds and publishes the multi-arch image.

**Architecture:** Plain scripts — `install.sh` (bash 3.2, macOS + Linux) and `install.ps1` (PowerShell 5.1, Windows) — modeled on `sirdar/install.sh`, with all decisions in small functions callable in a library mode so tests can exercise them without Docker. A runtime compose file pulls `ghcr.io/encondata/serversherpa-kiosk-laptop:<channel>`. Per-OS schedulers run `update.*` nightly and `launch.*` at sign-in. A GitHub Actions workflow tests, builds amd64+arm64, smoke-tests and pushes.

**Tech Stack:** bash 3.2, PowerShell 5.1 + Pester 5, Docker Compose v2, systemd / launchd / Task Scheduler, GitHub Actions (Buildx + QEMU), pytest (shell-function tests run through `subprocess`).

**Spec:** `docs/superpowers/specs/2026-10-01-kiosk-laptop-installer-design.md` — read it first; its section numbers are referenced below.

## Global Constraints

- American English in all copy, comments and docs.
- Image: `ghcr.io/encondata/serversherpa-kiosk-laptop`; tags `:edge`, `:sha-<sha7>` (every `main` build), `:X.Y.Z` + `:stable` (git tag `kiosk-laptop-vX.Y.Z`). Channel default `stable`.
- One-liners: `irm https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.ps1 | iex` and `curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.sh | bash`. Companion files are fetched from the same ref (`KIOSK_INSTALLER_REF`, default `main`) under `https://raw.githubusercontent.com/encondata/BaseCampV3/<ref>/kiosk_laptop/installer/`.
- Paths (spec §1.4): Windows install `C:\ProgramData\ServerSherpaKiosk`, data `C:\ProgramData\ServerSherpaKiosk\data`; macOS install `/Library/Application Support/ServerSherpaKiosk`, data `/Library/Application Support/ServerSherpaKiosk/data`; Linux install `/opt/serversherpa-kiosk`, data `/var/lib/serversherpa-kiosk`. Overrides `KIOSK_DIR`, `KIOSK_DATA_DIR`.
- Port mapping `127.0.0.1:8090:8090`; `restart: unless-stopped`; config in `config.env` with keys `EDGE_CLOUD_API_URL`, `EDGE_PORTAL_URL`, `KIOSK_CHANNEL`, `KIOSK_DATA_DIR`.
- Default API URL `https://api.serversherpa.com`; portal derived by replacing a leading `api.` host label with `portal.`.
- Minimums: Windows 10 22H2 (build 19045) or Windows 11; macOS 13; Linux must have systemd.
- Waits: Docker engine 3 min; container healthy 2 min; launcher waits 5 min for `http://localhost:8090/edge/identity`.
- Nightly update 03:00 local; skip when `outbox.queued + outbox.sending > 0`; rollback if not healthy in 2 min; `update.log` capped at 1 MB.
- Scheduler names: Windows task `ServerSherpa Kiosk Update`; macOS agents `com.serversherpa.kiosk.update`, `com.serversherpa.kiosk.launch`; Linux `serversherpa-kiosk-update.service` + `.timer`, autostart `serversherpa-kiosk.desktop`.
- Uninstall never deletes the data folder unless `--purge-data` / `-PurgeData` AND the typed confirmation `DELETE`; never uninstalls Docker.
- No step modifies the data folder except creating it and the one-time migration (spec §2 step 4).
- Env/flag conventions mirror `sirdar/install.sh`: `info`/`warn`/`die`; prompts on `/dev/tty` (override `KIOSK_TTY` for tests); `KIOSK_NONINTERACTIVE=1` / `--yes` never prompts; `KIOSK_INSTALL_LIB=1` defines functions without running `main`; `KIOSK_IMAGE` overrides the full image reference (tests/CI).
- Tests: shell functions are tested from pytest (`kiosk_laptop/installer/tests/test_install_sh.py`) by running `bash -c 'KIOSK_INSTALL_LIB=1 source install.sh; <function> …'`; PowerShell functions with Pester 5 (`kiosk_laptop/installer/tests/install.Tests.ps1`). Run everything FOREGROUND with a 600000 ms timeout; never background a run.
- Local tooling: shellcheck is at `/opt/homebrew/bin/shellcheck`. pwsh is not installed — to run Pester locally, download the portable PowerShell tarball for `osx-arm64` from the PowerShell GitHub releases into the session scratchpad and `Save-Module Pester -Path <scratch>` there; never install system-wide.
- Commit after each task; end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
kiosk_laptop/edge/src/edge/{config.py,db.py,routes/edge.py}   Task 1 (exclusive lock, version)
kiosk_laptop/Dockerfile                                        Task 1 (EDGE_VERSION arg/env)
kiosk/src/components/EdgePanel.tsx (+ test)                    Task 1 (shows version)
kiosk_laptop/installer/
  docker-compose.yml                                           Task 2
  install.sh                                                   Tasks 2–3
  update.sh, launch.sh                                         Task 4
  install.ps1, update.ps1, launch.ps1                          Tasks 5–6
  tests/conftest.py, tests/test_install_sh.py                  Tasks 2–4
  tests/test_linux_e2e.sh                                      Task 7
  tests/install.Tests.ps1                                      Tasks 5–6
.github/workflows/kiosk-laptop-image.yml                       Task 7
kiosk_laptop/README.md                                         Task 8
```

---

### Task 1: Edge — exclusive SQLite locking and a visible version

**Files:**
- Modify: `kiosk_laptop/edge/src/edge/db.py` (Store `__init__`), `kiosk_laptop/edge/src/edge/config.py` (Settings `version`), `kiosk_laptop/edge/src/edge/routes/edge.py` (`_status`), `kiosk_laptop/Dockerfile`
- Modify: `kiosk/src/lib/api.ts` (`EdgeStatus.version`), `kiosk/src/components/EdgePanel.tsx`, `kiosk/src/components/EdgePanel.test.tsx`
- Test: `kiosk_laptop/edge/tests/test_db.py`, `kiosk_laptop/edge/tests/test_edge_routes.py`

**Interfaces:** Produces `Settings.version: str = "dev"` (env `EDGE_VERSION`), `/edge/status` key `"version"`, `EdgeStatus.version: string`.

- [ ] **Step 1: Failing tests.** Append to `tests/test_db.py`:

```python
import sqlite3


def test_store_holds_an_exclusive_lock(tmp_path):
    store = Store(tmp_path / "edge.db")
    store.run("INSERT INTO cache(key, status, body, stored_at) VALUES ('k', 200, 'b', 'now')")
    other = sqlite3.connect(tmp_path / "edge.db", timeout=0.1)
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        other.execute("INSERT INTO cache(key, status, body, stored_at) VALUES ('j', 200, 'b', 'now')")
    other.close()
    assert not (tmp_path / "edge.db-shm").exists()   # WAL index kept in process memory
    store.close()
```

Append to `tests/test_edge_routes.py`:

```python
async def test_status_reports_version(client):
    r = await client.get("/edge/status")
    assert r.json()["version"] == "dev"
```

and in `tests/test_edge_routes.py` (or `test_static.py`) a settings-based case:

```python
def test_version_from_env(monkeypatch):
    from edge.config import load_settings
    monkeypatch.setenv("EDGE_CLOUD_API_URL", "http://cloud.test")
    monkeypatch.setenv("EDGE_VERSION", "1.2.3")
    assert load_settings().version == "1.2.3"
```

- [ ] **Step 2: Run** `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q tests/test_db.py tests/test_edge_routes.py` (create the venv first if missing: `python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'`). Expected: the three new tests fail.

- [ ] **Step 3: Implement.**

`db.py` — in `Store.__init__`, replace the two PRAGMA lines with:

```python
        # Only the edge process opens edge.db. Exclusive locking makes WAL
        # keep its index in process memory instead of the -shm file, which
        # is what breaks on Docker Desktop's shared folders (Windows WSL
        # file sharing, macOS VirtioFS). Nothing else may open the file
        # while the edge runs — backups stop the kiosk first.
        self.conn.execute("PRAGMA locking_mode=EXCLUSIVE")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
```

`config.py` — add field `version: str = "dev"` to `Settings`; in `load_settings()` pass `version=os.environ.get("EDGE_VERSION", "dev").strip() or "dev"`.

`routes/edge.py` `_status` — add `"version": st.settings.version,` to the returned dict.

`Dockerfile` — in the python stage add before `ENV PYTHONDONTWRITEBYTECODE…`:

```dockerfile
ARG KIOSK_VERSION=0.0.0
ENV EDGE_VERSION=$KIOSK_VERSION
```

(the web stage already takes `KIOSK_VERSION` for the footer, so one build arg drives both).

Kiosk: add `version: string;` to `EdgeStatus` in `kiosk/src/lib/api.ts`; in `EdgePanel.tsx` add a first row before Cloud, following the existing `settings-row` markup:

```tsx
      <div className="settings-row">
        <div>
          <span className="settings-row-label">Version</span>
          <p className="page-hint">{status.version}</p>
        </div>
      </div>
```

and in `EdgePanel.test.tsx` add `version: '1.2.3'` to the fixture and assert `screen.getByText('1.2.3')`. Add `version` to any other `EdgeStatus` fixtures in kiosk tests (grep `needs_sign_in:` in `kiosk/src`).

- [ ] **Step 4: Run** the edge suite (`.venv/bin/python -m pytest -q -rw`), `npm --prefix kiosk test` and `npm --prefix kiosk run build` (if `kiosk/node_modules` is missing run `npm ci --prefix kiosk`; if tsc cannot resolve react through `portal/`, symlink `portal/node_modules` to the main checkout's `/Users/jrh1812/Developer/BaseCampV3/portal/node_modules` — it is gitignored). Expected: all pass, no warnings.

- [ ] **Step 5: Commit** `feat(kiosk-laptop): exclusive SQLite locking for shared folders; image version in /edge/status and the Edge tab`.

---

### Task 2: install.sh core — paths, config, compose file, migration (library functions + tests)

**Files:**
- Create: `kiosk_laptop/installer/docker-compose.yml`, `kiosk_laptop/installer/install.sh` (core functions + a `main` that is filled in by Task 3), `kiosk_laptop/installer/tests/conftest.py`, `kiosk_laptop/installer/tests/test_install_sh.py`

**Interfaces (Produces — exact function names Task 3/4/7 use):**
- `detect_os` → sets `OS` (`Darwin`|`Linux`), `ARCH` (`amd64`|`arm64`), `OS_VERSION`.
- `default_dirs` → sets `KIOSK_DIR`, `KIOSK_DATA_DIR` from the OS unless already set in the environment.
- `derive_portal_url <api_url>` → prints portal URL (`https://api.x.com` → `https://portal.x.com`; anything without a leading `api.` label → empty).
- `load_config <file>` → sets `CFG_API_URL`, `CFG_PORTAL_URL`, `CFG_CHANNEL`, `CFG_DATA_DIR` from an existing `config.env` (missing file → all empty).
- `merge_config` → final values: flag/env (`OPT_API_URL`, `OPT_PORTAL_URL`, `OPT_CHANNEL`) beat saved config beat defaults; channel default `stable`; must be `stable` or `edge` else `die`.
- `write_config <file>` → writes the four keys, one per line, `KEY=value` (no quotes; values validated to contain no newline, quote or `$`), mode 600.
- `image_ref` → prints `${KIOSK_IMAGE:-ghcr.io/encondata/serversherpa-kiosk-laptop:$CFG_CHANNEL}`.
- `render_compose <file>` → writes the runtime compose file (content below) with `KIOSK_IMAGE_REF` substituted.
- `find_legacy_data` → prints the phase-1 data dir (`$EDGE_DATA_HOST_DIR` or `$HOME_OF_USER/ServerSherpaKiosk`) if it contains `identity.json`, else nothing. `HOME_OF_USER` = home of `SUDO_USER` when set, else `$HOME`.
- `migrate_legacy_data` → if `$KIOSK_DATA_DIR` has no `identity.json` and `find_legacy_data` finds one: stop a running `serversherpa-kiosk-laptop` compose project if present (`docker compose -p serversherpa-kiosk-laptop stop` — ignore failure), `cp -Rp` the legacy folder's contents into `$KIOSK_DATA_DIR`, print that the old folder was left in place. Otherwise no-op.

`kiosk_laptop/installer/docker-compose.yml` (template; `__IMAGE__` and `__DATA_DIR__` are replaced by `render_compose`):

```yaml
# ServerSherpa kiosk — laptop edition (installed). Managed by the installer;
# re-run the installer instead of editing this file.
name: serversherpa-kiosk
services:
  edge:
    image: __IMAGE__
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8090"
    env_file: config.env
    volumes:
      - "__DATA_DIR__:/data"
```

- [ ] **Step 1: Test harness.** `tests/conftest.py`:

```python
import os
import subprocess
from pathlib import Path

import pytest

INSTALL_SH = Path(__file__).resolve().parents[1] / "install.sh"


@pytest.fixture
def sh(tmp_path):
    """Run `body` in bash with install.sh sourced in library mode; returns CompletedProcess."""
    def run(body, env=None, check=True):
        full_env = {**os.environ, "KIOSK_INSTALL_LIB": "1", "HOME": str(tmp_path / "home"),
                    "KIOSK_NONINTERACTIVE": "1", **(env or {})}
        (tmp_path / "home").mkdir(exist_ok=True)
        proc = subprocess.run(["bash", "-c", f'source "{INSTALL_SH}"; {body}'],
                              capture_output=True, text=True, env=full_env, cwd=tmp_path)
        if check and proc.returncode != 0:
            raise AssertionError(f"exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}")
        return proc
    return run
```

- [ ] **Step 2: Failing tests.** `tests/test_install_sh.py`:

```python
import pytest


def test_detect_os_sets_os_and_arch(sh):
    out = sh('detect_os; echo "$OS $ARCH"').stdout.split()
    assert out[0] in ("Darwin", "Linux") and out[1] in ("amd64", "arm64")


@pytest.mark.parametrize("os_name,install,data", [
    ("Linux", "/opt/serversherpa-kiosk", "/var/lib/serversherpa-kiosk"),
    ("Darwin", "/Library/Application Support/ServerSherpaKiosk",
     "/Library/Application Support/ServerSherpaKiosk/data"),
])
def test_default_dirs(sh, os_name, install, data):
    out = sh(f'OS={os_name}; default_dirs; printf "%s\\n%s" "$KIOSK_DIR" "$KIOSK_DATA_DIR"').stdout
    assert out.splitlines() == [install, data]


def test_default_dirs_respects_overrides(sh):
    out = sh('OS=Linux; default_dirs; echo "$KIOSK_DIR|$KIOSK_DATA_DIR"',
             env={"KIOSK_DIR": "/x", "KIOSK_DATA_DIR": "/y"}).stdout.strip()
    assert out == "/x|/y"


@pytest.mark.parametrize("api,portal", [
    ("https://api.serversherpa.com", "https://portal.serversherpa.com"),
    ("https://api.dev.serversherpa.com/", "https://portal.dev.serversherpa.com"),
    ("http://10.0.0.5:8000", ""),
])
def test_derive_portal_url(sh, api, portal):
    assert sh(f'derive_portal_url "{api}"').stdout.strip() == portal


def test_config_round_trip_and_merge_precedence(sh, tmp_path):
    cfg = tmp_path / "config.env"
    sh(f'CFG_API_URL=https://api.a.com CFG_PORTAL_URL=https://portal.a.com CFG_CHANNEL=edge '
       f'CFG_DATA_DIR=/d; write_config "{cfg}"')
    text = cfg.read_text()
    assert "EDGE_CLOUD_API_URL=https://api.a.com\n" in text and "KIOSK_CHANNEL=edge\n" in text
    assert oct(cfg.stat().st_mode & 0o777) == "0o600"
    # re-run with no flags keeps saved values
    out = sh(f'load_config "{cfg}"; merge_config; echo "$CFG_API_URL $CFG_CHANNEL"').stdout.strip()
    assert out == "https://api.a.com edge"
    # a flag beats the saved value
    out = sh(f'load_config "{cfg}"; OPT_API_URL=https://api.b.com; merge_config; echo "$CFG_API_URL"').stdout.strip()
    assert out == "https://api.b.com"


def test_merge_defaults_and_rejects_bad_channel(sh, tmp_path):
    out = sh(f'load_config "{tmp_path}/none"; merge_config; echo "$CFG_API_URL $CFG_PORTAL_URL $CFG_CHANNEL"').stdout.split()
    assert out == ["https://api.serversherpa.com", "https://portal.serversherpa.com", "stable"]
    bad = sh(f'load_config "{tmp_path}/none"; OPT_CHANNEL=nightly; merge_config', check=False)
    assert bad.returncode != 0 and "channel" in bad.stderr.lower()


def test_write_config_rejects_unsafe_values(sh, tmp_path):
    bad = sh(f'CFG_API_URL=\'https://x.com/$(id)\' CFG_PORTAL_URL= CFG_CHANNEL=stable CFG_DATA_DIR=/d; '
             f'write_config "{tmp_path}/c.env"', check=False)
    assert bad.returncode != 0


def test_render_compose(sh, tmp_path):
    out = tmp_path / "docker-compose.yml"
    sh(f'CFG_CHANNEL=stable; KIOSK_DATA_DIR="/var/lib/serversherpa-kiosk"; render_compose "{out}"')
    text = out.read_text()
    assert "image: ghcr.io/encondata/serversherpa-kiosk-laptop:stable" in text
    assert '"/var/lib/serversherpa-kiosk:/data"' in text
    assert '"127.0.0.1:8090:8090"' in text and "restart: unless-stopped" in text
    out2 = tmp_path / "c2.yml"
    sh(f'CFG_CHANNEL=stable; KIOSK_DATA_DIR=/d; render_compose "{out2}"', env={"KIOSK_IMAGE": "local/kiosk:test"})
    assert "image: local/kiosk:test" in out2.read_text()


def test_migration_copies_legacy_identity_once(sh, tmp_path):
    legacy = tmp_path / "home" / "ServerSherpaKiosk"
    legacy.mkdir(parents=True)
    (legacy / "identity.json").write_text('{"serial":"kiosk-laptop-old"}')
    (legacy / "edge.db").write_text("db")
    data = tmp_path / "data"
    data.mkdir()
    out = sh(f'KIOSK_DATA_DIR="{data}"; DOCKER=(true); migrate_legacy_data').stdout
    assert (data / "identity.json").read_text() == '{"serial":"kiosk-laptop-old"}'
    assert (legacy / "identity.json").exists() and "left in place" in out
    # second run: data already has an identity → untouched
    (legacy / "identity.json").write_text('{"serial":"other"}')
    sh(f'KIOSK_DATA_DIR="{data}"; DOCKER=(true); migrate_legacy_data')
    assert "kiosk-laptop-old" in (data / "identity.json").read_text()


def test_shellcheck_clean():
    import shutil, subprocess
    from conftest import INSTALL_SH
    sc = shutil.which("shellcheck")
    if sc is None:
        pytest.skip("shellcheck not installed")
    r = subprocess.run([sc, "-s", "bash", str(INSTALL_SH)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout
```

(`DOCKER=(true)` stubs Docker so the migration's "stop the old project" call is a no-op; `install.sh` must call Docker only through the `DOCKER` array, as `sirdar/install.sh` does.)

- [ ] **Step 3: Run** `cd kiosk_laptop/edge && .venv/bin/python -m pytest -q ../installer/tests` — expected: failures (install.sh missing).

- [ ] **Step 4: Implement** `install.sh` core. Start from `sirdar/install.sh`'s header/output helpers/TTY handling/traps (read it), adapted to `KIOSK_*` names; bash 3.2 only (no `declare -A`, no `${var,,}`, no `mapfile`). Include: the functions listed under Interfaces; globals `OS ARCH OS_VERSION KIOSK_DIR KIOSK_DATA_DIR CFG_* OPT_*`, `DOCKER=(docker)`; `parse_args` for `--api-url URL --portal-url URL --channel NAME --yes --uninstall --purge-data --help` (sets `OPT_*`, `DO_UNINSTALL`, `PURGE_DATA`, `KIOSK_NONINTERACTIVE`); and a `main` that, for now, runs `detect_os; default_dirs; parse_args "$@"` and dies with "not finished" (Task 3 completes it). End the file with:

```bash
if [ "${KIOSK_INSTALL_LIB:-0}" != "1" ]; then
  main "$@"
fi
```

`render_compose` reads the template from `$KIOSK_TEMPLATE_DIR/docker-compose.yml` when `KIOSK_TEMPLATE_DIR` is set (tests, local runs), otherwise downloads it (`fetch_companion docker-compose.yml <dest>`, using `curl -fsSL "$BASE_URL/<name>"`, `BASE_URL=https://raw.githubusercontent.com/encondata/BaseCampV3/${KIOSK_INSTALLER_REF:-main}/kiosk_laptop/installer`). In tests set `KIOSK_TEMPLATE_DIR` automatically: in `conftest.py` add `"KIOSK_TEMPLATE_DIR": str(INSTALL_SH.parent)` to the env.

- [ ] **Step 5: Run** the tests and `shellcheck -s bash kiosk_laptop/installer/install.sh`. Expected: all pass, shellcheck clean.

- [ ] **Step 6: Commit** `feat(kiosk-installer): install.sh core — OS paths, config merge, runtime compose file, phase-1 data migration`.

---

### Task 3: install.sh — Docker, start, login items, summary, uninstall (macOS + Linux)

**Files:**
- Modify: `kiosk_laptop/installer/install.sh`
- Modify: `kiosk_laptop/installer/tests/test_install_sh.py`

**Interfaces:**
- Consumes Task 2's functions.
- Produces: `preflight` (root/sudo re-exec, OS minimums, browser detection → `BROWSER_BIN`), `ensure_docker` (spec §2 step 2 for macOS/Linux), `enable_docker_autostart` (macOS: set `"AutoStart": true` in `~<user>/Library/Group Containers/group.com.docker/settings-store.json`, creating the key without touching others — use `/usr/bin/plutil`-free JSON editing via `python3 -c` only if python3 exists, else `sed` on the single key; Linux: `systemctl enable --now docker`), `wait_for_engine <seconds>`, `start_kiosk` (first stop a phase-1 manual project if one is running — `docker compose -p serversherpa-kiosk-laptop stop`, ignore failure — because it holds port 8090; then pull, `up -d`, wait healthy ≤120 s via `docker inspect -f '{{.State.Health.Status}}'`, then `curl -fsS http://127.0.0.1:8090/edge/identity`), `install_login_items` (Task 4 supplies the launcher/updater files; here: shortcuts + register jobs), `summary`, `uninstall`.
- `main` order: `parse_args` → `detect_os` → `default_dirs` → if `DO_UNINSTALL` → `uninstall`; else `preflight` → `ensure_docker` → `enable_docker_autostart` → `wait_for_engine 180` → settings (`load_config`, prompt via `ask` for API URL and portal URL when interactive and not already set, `merge_config`, warn-only reachability check `curl -fsS --max-time 5 "$CFG_API_URL/system/status"`) → `mkdir -p` install + data dirs (data dir mode 700, owner root) → `write_config` → `render_compose` → `migrate_legacy_data` → `start_kiosk` → `install_login_items` → `summary`. Everything appended to `$KIOSK_DIR/install.log` via `exec > >(tee -a …) 2>&1` — bash 3.2 supports process substitution.
- Docker installs: Linux `curl -fsSL https://get.docker.com | sh` (then add `SUDO_USER` to the `docker` group); macOS download `https://desktop.docker.com/mac/main/arm64/Docker.dmg` or `…/amd64/Docker.dmg`, `hdiutil attach -nobrowse`, `"/Volumes/Docker/Docker.app/Contents/MacOS/install" --accept-license --user="$SUDO_USER"`, `hdiutil detach`, `open -a Docker` as the user (`sudo -u "$SUDO_USER" open -a Docker`).
- Uninstall: `docker compose -f "$KIOSK_DIR/docker-compose.yml" down` (ignore missing), remove jobs/launcher/shortcuts (Task 4's `remove_login_items`), remove `docker-compose.yml`, `config.env`, `update.sh`, `launch.sh`, state files; keep `install.log`; print the data-folder note; with `PURGE_DATA=1` ask for `DELETE` (via `ask`; non-interactive purge requires `KIOSK_CONFIRM_PURGE=DELETE`) then `rm -rf "$KIOSK_DATA_DIR"`.

- [ ] **Step 1: Failing tests** (append; all use stubs — no real Docker):

```python
def test_preflight_rejects_old_macos(sh):
    r = sh('OS=Darwin; OS_VERSION=12.7; check_minimums', check=False)
    assert r.returncode != 0 and "macOS 13" in r.stderr


def test_preflight_requires_systemd_on_linux(sh, tmp_path):
    r = sh('OS=Linux; HAS_SYSTEMD=0; check_minimums', check=False)
    assert r.returncode != 0 and "systemd" in r.stderr


def test_find_browser_prefers_chrome(sh, tmp_path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    for name in ("google-chrome", "microsoft-edge"):
        p = bindir / name; p.write_text("#!/bin/sh\n"); p.chmod(0o755)
    out = sh(f'OS=Linux; PATH="{bindir}:$PATH"; find_browser; echo "$BROWSER_BIN"').stdout.strip()
    assert out.endswith("google-chrome")


def test_start_kiosk_waits_for_healthy(sh, tmp_path):
    # fake docker: compose pull/up succeed; inspect says starting twice then healthy
    fake = tmp_path / "docker"
    fake.write_text('#!/bin/sh\n'
                    'case "$1" in\n'
                    '  inspect) n=$(cat "$0.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.n";\n'
                    '           [ $n -ge 3 ] && echo healthy || echo starting ;;\n'
                    '  *) exit 0 ;;\n'
                    'esac\n')
    fake.chmod(0o755)
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; '
           f'identity_check() {{ echo ok; }}; start_kiosk; echo done')
    assert "done" in r.stdout


def test_start_kiosk_times_out(sh, tmp_path):
    fake = tmp_path / "docker"
    fake.write_text('#!/bin/sh\n[ "$1" = inspect ] && echo unhealthy\nexit 0\n')
    fake.chmod(0o755)
    r = sh(f'DOCKER=("{fake}"); KIOSK_DIR="{tmp_path}"; HEALTH_POLL_S=0; HEALTH_TIMEOUT_S=0; start_kiosk',
           check=False)
    assert r.returncode != 0 and "healthy" in r.stderr.lower()


def test_uninstall_keeps_data_without_purge(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "identity.json").write_text("{}")
    for f in ("docker-compose.yml", "config.env", "update.sh", "launch.sh"):
        (inst / f).write_text("x")
    r = sh(f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; '
           f'remove_login_items() {{ :; }}; uninstall')
    assert (data / "identity.json").exists() and not (inst / "config.env").exists()
    assert "identity" in r.stdout.lower()


def test_uninstall_purge_needs_typed_delete(sh, tmp_path):
    inst, data = tmp_path / "inst", tmp_path / "data"
    inst.mkdir(); data.mkdir(); (data / "identity.json").write_text("{}")
    base = (f'DOCKER=(true); KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{data}"; PURGE_DATA=1; '
            f'remove_login_items() {{ :; }}; uninstall')
    r = sh(base, check=False)                                   # non-interactive, no confirm
    assert r.returncode != 0 and data.exists()
    sh(base, env={"KIOSK_CONFIRM_PURGE": "DELETE"})
    assert not data.exists()
```

Name the helpers the tests call exactly: `check_minimums` (uses `OS`, `OS_VERSION`, `HAS_SYSTEMD`), `find_browser` (sets `BROWSER_BIN`; macOS checks `/Applications/Google Chrome.app`, `/Applications/Microsoft Edge.app`, `/Applications/Chromium.app` and sets `BROWSER_BIN` to the `.app` path; Linux checks `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge` on PATH in that order), `identity_check` (curl of `/edge/identity`; tests override it), `HEALTH_POLL_S` (default 3) and `HEALTH_TIMEOUT_S` (default 120).

- [ ] **Step 2: Run** — fail. **Step 3: Implement** per Interfaces. **Step 4: Run** the installer tests + shellcheck — pass.

- [ ] **Step 5: Commit** `feat(kiosk-installer): install.sh installs Docker, starts the kiosk, summary and uninstall on macOS and Linux`.

---

### Task 4: update.sh, launch.sh and their schedulers (macOS + Linux)

**Files:**
- Create: `kiosk_laptop/installer/update.sh`, `kiosk_laptop/installer/launch.sh`
- Modify: `kiosk_laptop/installer/install.sh` (`install_login_items`, `remove_login_items`)
- Modify: `kiosk_laptop/installer/tests/test_install_sh.py` (+ a `test_update_sh.py` if clearer)

**Interfaces:**
- `update.sh` (runs as root on Linux, as the Docker Desktop user on macOS), reads `KIOSK_DIR` (default from its own location: `$(cd "$(dirname "$0")" && pwd)`), library mode `KIOSK_UPDATE_LIB=1`. Functions: `uploading` (returns 0 when `/edge/status` shows `queued+sending>0`; parse with `python3 -c` if available else `sed`; if the status call fails, treat as NOT uploading — a dead kiosk should still be repairable), `current_digest` (`docker inspect --format '{{.Image}}' serversherpa-kiosk-edge-1`), `pull_changed` (records digest before `compose pull`, compares the channel image's ID after), `apply_update`, `rollback <image_id>` (`docker tag <id> <ref>` then `compose up -d`), `trim_log` (keep last 1 MB of `update.log`). Flow per spec §3; exit codes: 0 updated/unchanged/skipped, 1 rolled back, 2 other failure.
- `launch.sh`: wait ≤300 s for `http://localhost:8090/edge/identity` (poll every 2 s, `KIOSK_LAUNCH_TIMEOUT_S` override), then open the browser in app mode: macOS `open -na "<BROWSER_APP>" --args --app=http://localhost:8090`; Linux `"$BROWSER_BIN" --app=http://localhost:8090 &`. `BROWSER_*` comes from `$KIOSK_DIR/config.env` key `KIOSK_BROWSER` written by the installer (add `KIOSK_BROWSER` to `write_config`'s keys; update Task 2's test expectations accordingly).
- `install_login_items` (installer, after `start_kiosk`): copy `update.sh`/`launch.sh` into `$KIOSK_DIR` (from `KIOSK_TEMPLATE_DIR` or download), `chmod 755`; then:
  - **Linux:** write `/etc/systemd/system/serversherpa-kiosk-update.service` (`Type=oneshot`, `ExecStart=$KIOSK_DIR/update.sh`) and `.timer` (`OnCalendar=*-*-* 03:00:00`, `Persistent=true`), `systemctl daemon-reload && systemctl enable --now serversherpa-kiosk-update.timer`; write `~$SUDO_USER/.config/autostart/serversherpa-kiosk.desktop` and `~$SUDO_USER/.local/share/applications/serversherpa-kiosk.desktop` (`Exec=$KIOSK_DIR/launch.sh`, `Name=ServerSherpa Kiosk`), owned by the user.
  - **macOS:** `~$SUDO_USER/Library/LaunchAgents/com.serversherpa.kiosk.update.plist` (`StartCalendarInterval` Hour 3 Minute 0, `ProgramArguments` = update.sh) and `com.serversherpa.kiosk.launch.plist` (`RunAtLoad` true, launch.sh), owned by the user, loaded with `launchctl bootstrap gui/<uid>`; and `/Applications/ServerSherpa Kiosk.app` — a minimal app bundle whose `Contents/MacOS/ServerSherpa Kiosk` is a shell script exec'ing `launch.sh`, with an `Info.plist` (`CFBundleName`, `CFBundleExecutable`, `CFBundleIdentifier com.serversherpa.kiosk`).
- `remove_login_items` undoes exactly those (ignore missing; `launchctl bootout`, `systemctl disable --now`).
- Rendering functions are separate and testable: `render_systemd_units <dir>`, `render_desktop_entry <file>`, `render_launch_agent <label> <file> <calendar|runatload> <program>`, `render_app_bundle <dir>`.

- [ ] **Step 1: Failing tests** (append):

```python
import plistlib


def test_render_systemd_units(sh, tmp_path):
    sh(f'KIOSK_DIR=/opt/serversherpa-kiosk; render_systemd_units "{tmp_path}"')
    svc = (tmp_path / "serversherpa-kiosk-update.service").read_text()
    tmr = (tmp_path / "serversherpa-kiosk-update.timer").read_text()
    assert "ExecStart=/opt/serversherpa-kiosk/update.sh" in svc and "Type=oneshot" in svc
    assert "OnCalendar=*-*-* 03:00:00" in tmr and "Persistent=true" in tmr


def test_render_launch_agents(sh, tmp_path):
    upd, lch = tmp_path / "u.plist", tmp_path / "l.plist"
    sh(f'render_launch_agent com.serversherpa.kiosk.update "{upd}" calendar /k/update.sh; '
       f'render_launch_agent com.serversherpa.kiosk.launch "{lch}" runatload /k/launch.sh')
    u = plistlib.loads(upd.read_bytes()); l = plistlib.loads(lch.read_bytes())
    assert u["Label"] == "com.serversherpa.kiosk.update"
    assert u["StartCalendarInterval"] == {"Hour": 3, "Minute": 0}
    assert u["ProgramArguments"] == ["/k/update.sh"]
    assert l["RunAtLoad"] is True and l["ProgramArguments"] == ["/k/launch.sh"]


def test_render_desktop_entry(sh, tmp_path):
    f = tmp_path / "serversherpa-kiosk.desktop"
    sh(f'KIOSK_DIR=/opt/serversherpa-kiosk; render_desktop_entry "{f}"')
    t = f.read_text()
    assert "Name=ServerSherpa Kiosk" in t and "Exec=/opt/serversherpa-kiosk/launch.sh" in t


UPDATE_SH = __import__("pathlib").Path(__file__).resolve().parents[1] / "update.sh"


def _upd(tmp_path, body, docker_script, status_json, extra_env=None):
    import os, subprocess
    fake = tmp_path / "docker"; fake.write_text(docker_script); fake.chmod(0o755)
    st = tmp_path / "status.json"; st.write_text(status_json)
    env = {**os.environ, "KIOSK_UPDATE_LIB": "1", "KIOSK_DIR": str(tmp_path), **(extra_env or {})}
    return subprocess.run(["bash", "-c", f'source "{UPDATE_SH}"; DOCKER=("{fake}"); '
                           f'status_json() {{ cat "{st}"; }}; HEALTH_POLL_S=0; {body}'],
                          capture_output=True, text=True, env=env)


def test_update_skips_while_uploading(tmp_path):
    r = _upd(tmp_path, 'main; echo rc=$?', '#!/bin/sh\necho "$@" >> "$0.log"\n',
             '{"outbox": {"queued": 2, "sending": 0}}')
    assert "rc=0" in r.stdout and "skipped" in (tmp_path / "update.log").read_text()
    assert not (tmp_path / "docker.log").exists() or "pull" not in (tmp_path / "docker.log").read_text()


def test_update_noop_when_digest_unchanged(tmp_path):
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in *inspect*) echo sha256:same ;; *"image inspect"*) echo sha256:same ;; esac\n')
    r = _upd(tmp_path, 'main; echo rc=$?', script, '{"outbox": {"queued": 0, "sending": 0}}')
    log = (tmp_path / "docker.log").read_text()
    assert "rc=0" in r.stdout and "pull" in log and " up " not in f" {log} "


def test_update_rolls_back_when_unhealthy(tmp_path):
    script = ('#!/bin/sh\necho "$@" >> "$0.log"\n'
              'case "$*" in\n'
              '  *"--format {{.Image}}"*) echo sha256:old ;;\n'
              '  *"image inspect"*) echo sha256:new ;;\n'
              '  *Health*) echo unhealthy ;;\n'
              'esac\n')
    r = _upd(tmp_path, 'HEALTH_TIMEOUT_S=0; main; echo rc=$?', script,
             '{"outbox": {"queued": 0, "sending": 0}}')
    log = (tmp_path / "docker.log").read_text()
    assert "rc=1" in r.stdout and "tag sha256:old" in log
    assert "rolled back" in (tmp_path / "update.log").read_text()


def test_update_log_is_trimmed(tmp_path):
    (tmp_path / "update.log").write_text("x" * (2 * 1024 * 1024))
    _upd(tmp_path, 'trim_log', '#!/bin/sh\n', '{}')
    assert (tmp_path / "update.log").stat().st_size <= 1024 * 1024
```

Make the implementation's Docker invocations match what these stubs look for: `docker inspect --format {{.Image}} serversherpa-kiosk-edge-1` (current), `docker image inspect --format {{.Id}} <ref>` (after pull), `docker inspect --format {{.State.Health.Status}} serversherpa-kiosk-edge-1` (health), `docker tag <id> <ref>` (rollback). `status_json` is the function that fetches `/edge/status` (tests override it). Also add `shellcheck` for `update.sh` and `launch.sh` to `test_shellcheck_clean`.

- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** all installer tests + shellcheck — pass.

- [ ] **Step 5: Commit** `feat(kiosk-installer): nightly update with skip-while-uploading and rollback, at-login launcher, systemd and launchd jobs`.

---

### Task 5: install.ps1 — Windows core, WSL/Docker Desktop, start, summary, uninstall

**Files:**
- Create: `kiosk_laptop/installer/install.ps1`, `kiosk_laptop/installer/tests/install.Tests.ps1`

**Interfaces:** Parameters `-ApiUrl -PortalUrl -Channel -Yes -Uninstall -PurgeData -Resume -LibraryOnly` (`-LibraryOnly` defines functions and returns without running — the Pester entry point; also honors `$env:KIOSK_INSTALL_LIB -eq '1'`). Env overrides mirror the shell ones (`KIOSK_DIR`, `KIOSK_DATA_DIR`, `KIOSK_IMAGE`, `KIOSK_NONINTERACTIVE`, `KIOSK_INSTALLER_REF`, `KIOSK_TEMPLATE_DIR`, `KIOSK_CONFIRM_PURGE`). Functions (Pester tests call them by these names):
- `Get-KioskPaths` → `@{ Install = 'C:\ProgramData\ServerSherpaKiosk'; Data = 'C:\ProgramData\ServerSherpaKiosk\data' }` honoring overrides.
- `Test-WindowsSupported -Build <int> -ProductType <int>` → `$true` for client builds ≥ 19045; `$false` otherwise (and for Server SKUs: ProductType ≠ 1).
- `Get-PortalUrl -ApiUrl` (same rule as shell).
- `Read-KioskConfig -Path`, `Merge-KioskConfig -Saved -Options` (same precedence; channel validation throws), `Write-KioskConfig -Path -Config` (same keys incl. `KIOSK_BROWSER`; rejects values with newline, quote or `$`; ACL: Administrators + SYSTEM full control, inheritance off).
- `Get-ComposeText -ImageRef -DataDir` → the runtime compose text (template from `KIOSK_TEMPLATE_DIR` or download), data dir rendered with forward slashes (`C:/ProgramData/ServerSherpaKiosk/data`), which Docker Desktop accepts.
- `Get-ImageRef -Channel` → `$env:KIOSK_IMAGE` or `ghcr.io/encondata/serversherpa-kiosk-laptop:<channel>`.
- `Save-ResumeState -Path -Step -Arguments` / `Read-ResumeState -Path` (JSON `{ step, arguments }`); `Register-Resume` writes `HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce` value `ServerSherpaKioskInstall` = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<install>\install.ps1" -Resume`; the installer saves a copy of itself to the install folder before registering.
- `Find-Browser` → Chrome (`${env:ProgramFiles}\Google\Chrome\Application\chrome.exe`, then `${env:ProgramFiles(x86)}…`, then `$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe`) else Edge (`${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe`).
- `Assert-Admin` (relaunch elevated: `Start-Process powershell -Verb RunAs -ArgumentList` with the same bound parameters; when invoked via `irm | iex` there is no file — first save the script text (`$MyInvocation.MyCommand.ScriptBlock`) to `%TEMP%\serversherpa-kiosk-install.ps1` and relaunch that).
- `Install-DockerDesktop` (spec §2 step 2 Windows: `Get-Command docker`/`docker version` → skip; virtualization check `(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled` or Hyper-V present → else die with BIOS instructions; `wsl.exe --status` / `wsl --install --no-distribution`; if `$LASTEXITCODE` or output says a restart is required → `Save-ResumeState`, `Register-Resume`, message, `exit 0`; download `https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe` (arm64 Windows: `…/win/main/arm64/…`), run `install --quiet --accept-license --backend=wsl-2`, `Add-LocalGroupMember docker-users <user>`).
- `Enable-DockerAutostart` (edit `%APPDATA%\Docker\settings-store.json` of the signed-in user — set `AutoStart` true, keep other keys; create if missing) and start `"C:\Program Files\Docker\Docker\Docker Desktop.exe"` if the engine isn't up.
- `Wait-DockerEngine -Seconds`, `Start-Kiosk` (pull, up -d, health ≤120 s via `docker inspect`, then `Invoke-WebRequest http://127.0.0.1:8090/edge/identity -UseBasicParsing`), `Write-Summary`, `Uninstall-Kiosk` (same semantics as shell; purge requires typed `DELETE` or `KIOSK_CONFIRM_PURGE=DELETE`).
- Log: `Start-Transcript -Append "<install>\install.log"`.
- Login items/update scheduling are Task 6 (`Install-LoginItems`, `Remove-LoginItems` — define stubs that Task 6 fills, so `Uninstall-Kiosk` already calls `Remove-LoginItems`).
- `main` order mirrors the shell `main`; `-Resume` reads the saved arguments and continues from the saved step.

- [ ] **Step 1: Get Pester locally (scratchpad only).** Download the portable PowerShell for `osx-arm64` (the `powershell-*-osx-arm64.tar.gz` asset of the latest PowerShell GitHub release) into the session scratchpad, extract, and `Save-Module -Name Pester -MinimumVersion 5.5 -Path <scratch>/modules`; run tests with `PSModulePath=<scratch>/modules <scratch>/pwsh -NoProfile -Command "Invoke-Pester kiosk_laptop/installer/tests -Output Detailed"`. Do not install anything system-wide. If the download is blocked, report it and rely on CI (Task 7) for Pester.

- [ ] **Step 2: Failing tests.** `tests/install.Tests.ps1`:

```powershell
BeforeAll {
    $env:KIOSK_INSTALL_LIB = '1'
    $env:KIOSK_TEMPLATE_DIR = (Resolve-Path "$PSScriptRoot/..").Path
    . "$PSScriptRoot/../install.ps1" -LibraryOnly
}

Describe 'Windows support gate' {
    It 'accepts Windows 10 22H2 and 11 client builds' {
        Test-WindowsSupported -Build 19045 -ProductType 1 | Should -BeTrue
        Test-WindowsSupported -Build 22631 -ProductType 1 | Should -BeTrue
    }
    It 'refuses older builds and Server' {
        Test-WindowsSupported -Build 19044 -ProductType 1 | Should -BeFalse
        Test-WindowsSupported -Build 20348 -ProductType 3 | Should -BeFalse
    }
}

Describe 'Paths' {
    It 'defaults under ProgramData and honors overrides' {
        $env:KIOSK_DIR = $null; $env:KIOSK_DATA_DIR = $null
        (Get-KioskPaths).Install | Should -Be 'C:\ProgramData\ServerSherpaKiosk'
        (Get-KioskPaths).Data | Should -Be 'C:\ProgramData\ServerSherpaKiosk\data'
        $env:KIOSK_DIR = 'D:\K'; (Get-KioskPaths).Install | Should -Be 'D:\K'; $env:KIOSK_DIR = $null
    }
}

Describe 'Portal URL' {
    It 'derives portal from api' {
        Get-PortalUrl -ApiUrl 'https://api.serversherpa.com' | Should -Be 'https://portal.serversherpa.com'
        Get-PortalUrl -ApiUrl 'http://10.0.0.5:8000' | Should -Be ''
    }
}

Describe 'Config' {
    It 'keeps saved values, lets options win, defaults otherwise' {
        $saved = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; KIOSK_CHANNEL = 'edge' }
        (Merge-KioskConfig -Saved $saved -Options @{}).EDGE_CLOUD_API_URL | Should -Be 'https://api.a.com'
        (Merge-KioskConfig -Saved $saved -Options @{ ApiUrl = 'https://api.b.com' }).EDGE_CLOUD_API_URL | Should -Be 'https://api.b.com'
        $d = Merge-KioskConfig -Saved @{} -Options @{}
        $d.EDGE_CLOUD_API_URL | Should -Be 'https://api.serversherpa.com'
        $d.EDGE_PORTAL_URL | Should -Be 'https://portal.serversherpa.com'
        $d.KIOSK_CHANNEL | Should -Be 'stable'
    }
    It 'rejects an unknown channel' {
        { Merge-KioskConfig -Saved @{} -Options @{ Channel = 'nightly' } } | Should -Throw '*channel*'
    }
    It 'round-trips through config.env and rejects unsafe values' {
        $p = Join-Path $TestDrive 'config.env'
        $c = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; EDGE_PORTAL_URL = ''; KIOSK_CHANNEL = 'stable'; KIOSK_DATA_DIR = 'C:\d'; KIOSK_BROWSER = '' }
        Write-KioskConfig -Path $p -Config $c -SkipAcl
        (Read-KioskConfig -Path $p).EDGE_CLOUD_API_URL | Should -Be 'https://api.a.com'
        $c.EDGE_CLOUD_API_URL = 'https://x.com/$(whoami)'
        { Write-KioskConfig -Path $p -Config $c -SkipAcl } | Should -Throw
    }
}

Describe 'Compose file' {
    It 'renders image, loopback port and a forward-slash data path' {
        $t = Get-ComposeText -ImageRef 'ghcr.io/encondata/serversherpa-kiosk-laptop:stable' -DataDir 'C:\ProgramData\ServerSherpaKiosk\data'
        $t | Should -Match 'image: ghcr.io/encondata/serversherpa-kiosk-laptop:stable'
        $t | Should -Match '"C:/ProgramData/ServerSherpaKiosk/data:/data"'
        $t | Should -Match '"127.0.0.1:8090:8090"'
    }
    It 'uses KIOSK_IMAGE when set' {
        $env:KIOSK_IMAGE = 'local/kiosk:test'
        Get-ImageRef -Channel stable | Should -Be 'local/kiosk:test'
        $env:KIOSK_IMAGE = $null
        Get-ImageRef -Channel edge | Should -Be 'ghcr.io/encondata/serversherpa-kiosk-laptop:edge'
    }
}

Describe 'Resume after reboot' {
    It 'saves and reads the step and arguments' {
        $p = Join-Path $TestDrive 'install-state.json'
        Save-ResumeState -Path $p -Step 'docker' -Arguments @{ ApiUrl = 'https://api.a.com'; Yes = $true }
        $s = Read-ResumeState -Path $p
        $s.step | Should -Be 'docker'
        $s.arguments.ApiUrl | Should -Be 'https://api.a.com'
    }
}

Describe 'Uninstall' {
    It 'keeps data unless purge is confirmed' {
        $inst = Join-Path $TestDrive 'inst'; $data = Join-Path $TestDrive 'data'
        New-Item -ItemType Directory $inst, $data | Out-Null
        'x' | Set-Content (Join-Path $inst 'config.env'); '{}' | Set-Content (Join-Path $data 'identity.json')
        Mock Invoke-Docker {}
        Mock Remove-LoginItems {}
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        Test-Path (Join-Path $data 'identity.json') | Should -BeTrue
        Test-Path (Join-Path $inst 'config.env') | Should -BeFalse
        { Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData } | Should -Throw
        $env:KIOSK_CONFIRM_PURGE = 'DELETE'
        Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData
        Test-Path $data | Should -BeFalse
        $env:KIOSK_CONFIRM_PURGE = $null
    }
}
```

All Docker calls go through one function `Invoke-Docker` (so Pester can mock it); `Write-KioskConfig` takes `-SkipAcl` for tests (ACL APIs are Windows-only).

- [ ] **Step 3: Run** Pester — fail. **Step 4: Implement** `install.ps1`; keep it PowerShell 5.1-compatible (no `?:`, `??`, `-Parallel`, `ConvertFrom-Json -AsHashtable`; convert JSON objects to hashtables by hand). Guard Windows-only cmdlets (registry, ACL, `Get-CimInstance`) behind functions the tests don't call. **Step 5: Run** Pester — pass. Also run PSScriptAnalyzer if you obtained it (`Save-Module PSScriptAnalyzer` into the same scratch path): `Invoke-ScriptAnalyzer kiosk_laptop/installer/install.ps1 -Severity Warning,Error` → no findings except justified suppressions (`PSAvoidUsingWriteHost` is acceptable — suppress at file level with a comment).

- [ ] **Step 6: Commit** `feat(kiosk-installer): install.ps1 — WSL2 + Docker Desktop with resume after reboot, config, start, uninstall`.

---

### Task 6: Windows update.ps1, launch.ps1 and their scheduling

**Files:**
- Create: `kiosk_laptop/installer/update.ps1`, `kiosk_laptop/installer/launch.ps1`
- Modify: `kiosk_laptop/installer/install.ps1` (`Install-LoginItems`, `Remove-LoginItems`), `kiosk_laptop/installer/tests/install.Tests.ps1` (+ `update.Tests.ps1`)

**Interfaces:**
- `update.ps1` mirrors `update.sh` exactly (same steps, exit codes 0/1/2, same `update.log` with 1 MB trim), functions `Test-Uploading`, `Get-CurrentImageId`, `Get-PulledImageId`, `Invoke-Rollback`, `Limit-Log`, all Docker calls via `Invoke-Docker`, status via `Get-EdgeStatusJson` (mockable); `-LibraryOnly` / `KIOSK_UPDATE_LIB=1`.
- `launch.ps1`: wait ≤300 s for `/edge/identity`, then `Start-Process <KIOSK_BROWSER from config.env> --app=http://localhost:8090`.
- `Install-LoginItems`: copy `update.ps1`/`launch.ps1` into the install folder; scheduled task `ServerSherpa Kiosk Update` (`New-ScheduledTaskTrigger -Daily -At 3am`, action `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<install>\update.ps1"`, principal = the signed-in user, `-LogonType Interactive` — runs only while they're signed in; settings `-StartWhenAvailable`); shortcuts `ServerSherpa Kiosk.lnk` on the Public Desktop (`C:\Users\Public\Desktop`) and in `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`, target `powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "<install>\launch.ps1"`; startup entry: the same `.lnk` in `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp` (all users). `Remove-LoginItems` removes them all.
- Testable pieces: `Get-ShortcutSpec -InstallDir` (returns target + arguments), `Get-UpdateTaskSpec -InstallDir -User` (returns a hashtable: Name, Time `03:00`, Execute, Argument, LogonType), so Pester asserts on specs, not on the Windows APIs.

- [ ] **Step 1: Failing Pester tests** (new `tests/update.Tests.ps1` mirroring the shell update tests — skip while uploading; no-op when the pulled ID equals the current ID; rollback tags the old ID and returns exit code 1 when health never turns healthy (`-HealthTimeoutSeconds 0`); log trimmed to ≤1 MB — plus, in `install.Tests.ps1`, `Get-ShortcutSpec` / `Get-UpdateTaskSpec` assertions: name, `03:00`, `powershell.exe`, `-File "<install>\update.ps1"`, LogonType `Interactive`). Write them in the same style as Task 5's tests with `Mock Invoke-Docker` / `Mock Get-EdgeStatusJson`.

- [ ] **Step 2: Run** — fail. **Step 3: Implement.** **Step 4: Run** Pester (and PSScriptAnalyzer if available) — pass.

- [ ] **Step 5: Commit** `feat(kiosk-installer): Windows nightly update task, at-login launcher and shortcuts`.

---

### Task 7: CI — test, build multi-arch, smoke, publish; Linux end-to-end installer run

**Files:**
- Create: `.github/workflows/kiosk-laptop-image.yml`, `kiosk_laptop/installer/tests/test_linux_e2e.sh`

**Workflow** (`name: kiosk-laptop-image`):

```yaml
on:
  push:
    branches: [main]
    paths: ['kiosk/**', 'kiosk_laptop/**', 'portal/src/**', '.github/workflows/kiosk-laptop-image.yml']
    tags: ['kiosk-laptop-v*']
  pull_request:
    paths: ['kiosk/**', 'kiosk_laptop/**', 'portal/src/**', '.github/workflows/kiosk-laptop-image.yml']
  workflow_dispatch:

permissions:
  contents: read
  packages: write

env:
  IMAGE: ghcr.io/encondata/serversherpa-kiosk-laptop
```

Jobs:
1. `edge-tests` (ubuntu-latest, Python 3.13): `pip install -e 'kiosk_laptop/edge[dev]'`, `pytest -q kiosk_laptop/edge/tests kiosk_laptop/installer/tests` (installer shell tests run on Linux bash; install `shellcheck` via apt).
2. `installer-macos` (macos-latest): run `kiosk_laptop/installer/tests` with the system `/bin/bash` (3.2) — `python3 -m pip install pytest` then `pytest -q kiosk_laptop/installer/tests -k "not e2e"`.
3. `installer-windows` (windows-latest): `Install-Module Pester -MinimumVersion 5.5 -Force -Scope CurrentUser; Install-Module PSScriptAnalyzer -Force -Scope CurrentUser; Invoke-ScriptAnalyzer kiosk_laptop/installer -Recurse -Severity Warning,Error -EnableExit; Invoke-Pester kiosk_laptop/installer/tests -CI`.
4. `kiosk-tests` (ubuntu-latest, Node 20): `npm ci --prefix kiosk && npm --prefix kiosk test && npm --prefix kiosk run build:bundle`. (Full `tsc -b` needs portal's node_modules; `npm ci --prefix portal` fails on its lockfile conflict — use `build:bundle` here, as the Dockerfile does.)
5. `image` (needs 1–4; ubuntu-latest): compute version — tag `kiosk-laptop-vX.Y.Z` → `X.Y.Z`, else `0.0.0-<sha7>`; `docker/setup-qemu-action`, `docker/setup-buildx-action`; build amd64 with `load: true` tagged `kiosk-laptop:ci` and `--build-arg KIOSK_VERSION=<version>`; run `kiosk_laptop/scripts/smoke.sh` adapted to accept a prebuilt image (add `SMOKE_IMAGE` env: when set, skip `docker build` and use it); run `kiosk_laptop/installer/tests/test_linux_e2e.sh kiosk-laptop:ci`; then, unless `pull_request`, `docker/login-action` to ghcr.io with `GITHUB_TOKEN` and `docker/build-push-action` for `linux/amd64,linux/arm64` (cache `type=gha`) with tags: on `main` → `:edge`, `:sha-<sha7>`; on tag → `:X.Y.Z`, `:stable`. Labels `org.opencontainers.image.source=https://github.com/encondata/BaseCampV3`, `org.opencontainers.image.version=<version>`.

`test_linux_e2e.sh <image>` (bash, `set -euo pipefail`, runs as a sudo-capable runner user):
1. `sudo KIOSK_IMAGE=<image> KIOSK_TEMPLATE_DIR=$PWD/kiosk_laptop/installer KIOSK_NONINTERACTIVE=1 bash kiosk_laptop/installer/install.sh --api-url http://127.0.0.1:9 --yes` → expect exit 0; `curl -fs localhost:8090/edge/identity` → serial `kiosk-laptop-*`; `curl -fs localhost:8090/config.js | grep '"mode": "laptop"'`; `systemctl is-enabled serversherpa-kiosk-update.timer`.
2. Re-run the same install → same serial (idempotent).
3. Update with an unchanged image → `sudo /opt/serversherpa-kiosk/update.sh` exit 0, container not recreated (compare `docker inspect -f '{{.Created}}'`).
4. Rollback: build a broken image `FROM <image>` with `HEALTHCHECK CMD exit 1`, tag it as `<image>`, run `update.sh` with `HEALTH_TIMEOUT_S=20` → exit 1, `update.log` contains `rolled back`, container healthy again on the old ID.
5. `sudo bash install.sh --uninstall` → `/var/lib/serversherpa-kiosk/identity.json` exists, timer gone; `sudo KIOSK_CONFIRM_PURGE=DELETE bash install.sh --uninstall --purge-data` → data dir gone.
Exits non-zero with a clear message on the first failed check.

- [ ] **Step 1:** Add `SMOKE_IMAGE` support to `kiosk_laptop/scripts/smoke.sh` and run it locally with a locally built image: `docker build -f kiosk_laptop/Dockerfile -t kiosk-laptop:ci . && SMOKE_IMAGE=kiosk-laptop:ci kiosk_laptop/scripts/smoke.sh` → `smoke OK`.
- [ ] **Step 2:** Write `test_linux_e2e.sh`. It needs Linux + systemd, so it cannot run on this Mac directly; validate it with `shellcheck` and `bash -n` locally, and note in the report that its first real run is in CI.
- [ ] **Step 3:** Write the workflow; validate syntax with `actionlint` if available (`/opt/homebrew/bin/actionlint`; if missing, `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/kiosk-laptop-image.yml`).
- [ ] **Step 4: Commit** `ci(kiosk-laptop): test, build amd64+arm64, smoke, Linux installer end-to-end, publish to GHCR`.

---

### Task 8: README rewrite

**Files:** Modify `kiosk_laptop/README.md`.

Rewrite around the one-liners (spec §5), American English, short sections in this order: What it is · Requirements (Docker Desktop on Windows/macOS — installed for you; Docker Engine on Linux; Chrome or Edge; Docker Desktop licensing note: free for organizations under 250 employees and under $10M revenue, otherwise a paid seat per laptop) · Install (the two one-liners; flags `--api-url`/`-ApiUrl`, `--channel`/`-Channel`, `--yes`/`-Yes`; what it does in one paragraph; Windows may ask for a restart and continues by itself after sign-in) · First run (sign in online → Kiosk Setup) · Unattended stations (the kiosk starts when someone signs in on Windows/macOS; how to set automatic sign-in: Windows `netplwiz` / Sysinternals Autologon, macOS System Settings › Users & Groups › Automatically log in as; Linux starts at boot) · Updates (nightly 03:00, `stable` vs `edge`, skip while uploading, rollback, `update.log`, re-run the install command to update now) · Offline (keep the existing section's content) · Windows label printers (keep the Zadig/WinUSB steps; remove the "run from the WSL2 shell" guidance and the `\\wsl$` paths — data is in `C:\ProgramData\ServerSherpaKiosk\data` now) · Data and backups (the per-OS data paths; stop the kiosk before copying: `docker compose -f <install>/docker-compose.yml stop`) · Uninstall (`--uninstall`, `--purge-data`) · Troubleshooting (`install.log`, `update.log`, `docker compose -f <install>/docker-compose.yml logs -f edge`, reset-key: `docker compose -f <install>/docker-compose.yml run --rm edge python -m edge reset-key`) · For developers (the repo's `kiosk_laptop/docker-compose.yml` builds locally; `EDGE_BIND` stays `127.0.0.1` until TLS) · Maintainers (cut a release: `git tag kiosk-laptop-vX.Y.Z && git push github kiosk-laptop-vX.Y.Z`; first publish: GitHub › encondata › Packages › serversherpa-kiosk-laptop › Package settings › Change visibility → Public, and link it to the BaseCampV3 repo).

- [ ] **Step 1:** Write it. **Step 2:** Check every command and path in it against the scripts (grep each path/flag). **Step 3: Commit** `docs(kiosk-laptop): README for the one-command installer, unattended stations, updates and uninstall`.

---

### Task 9 (controller): Live verification on this Mac

Not dispatched to an implementer — the controlling session runs it, **after asking Jimmy for permission** because it installs launch agents and an app into `/Applications` and `/Library/Application Support` on his Mac:

1. Build `kiosk-laptop:local` from the worktree; run `sudo KIOSK_IMAGE=kiosk-laptop:local KIOSK_TEMPLATE_DIR=$PWD/kiosk_laptop/installer bash kiosk_laptop/installer/install.sh --api-url http://host.docker.internal:8001 --yes` against the branch API on :8001.
2. Check: Docker Desktop AutoStart on; container healthy; `/Applications/ServerSherpa Kiosk.app` opens an app-mode window; the launch agent and update agent are loaded (`launchctl print gui/$UID/com.serversherpa.kiosk.update`).
3. Run `update.sh` by hand (unchanged → no-op).
4. `--uninstall` (data kept), then `--uninstall --purge-data` with `KIOSK_CONFIRM_PURGE=DELETE`; confirm nothing is left in LaunchAgents/Applications.
5. Record results in the spec's Implementation notes; Windows and Linux real-hardware checks stay on the spec's manual checklist.
