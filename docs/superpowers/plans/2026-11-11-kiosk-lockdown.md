# Ubuntu Kiosk Lockdown (Laptop Edition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Linux laptops only, the kiosk takes over the screen.
- At sign-in a local "Connecting to ServerSherpa…" page waits for the cloud, retrying every 15 s.
- Chrome then runs `--kiosk` on `http://localhost:8090`, and a watcher reopens it whenever it closes.
- GNOME's escape shortcuts are off while the kiosk runs.
- Esc opens a PIN pad, and `csg` returns to the desktop.
- A Start Kiosk desktop icon brings the kiosk back.
- The kiosk top bar shows battery and Wi-Fi, with a Network modal to join Wi-Fi.

**Architecture:**
- One new stdlib-Python process, `kiosk_laptop/installer/kiosk_session.py`, run as the desktop user by `launch.sh` at sign-in. It owns:
  - a helper HTTP server on `127.0.0.1:8092` (waiting page plus a JSON API gated by Host, Origin and a per-session token);
  - the cloud-check loop;
  - the GNOME lock (gsettings, with save and restore);
  - the Chrome watcher.
- The kiosk web app gets the token through the URL fragment that the waiting page hands over. It calls the helper directly from the browser.
- `hostnet.sh` adds `"host_os": "linux"`, so the edge's `/config.js` can tell the page it is a Linux laptop.
- `install.sh` and `update.sh` install and refresh the new file.

**Tech Stack:**
- bash 3.2-compatible shell scripts, checked by pytest with stubs plus shellcheck;
- Python 3.10+ stdlib (Ubuntu 22.04's python3), tested with pytest;
- the edge: FastAPI + pytest;
- the kiosk: React 18 + Vite + Vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-11-kiosk-lockdown-design.md` (binding; read it before your task).

## Global Constraints

**Platform scope**
- **Linux only.** Windows (`*.ps1`) and macOS behavior must not change.
  - `launch.sh`'s Darwin path stays byte-for-byte the same in behavior.
  - `hostnet.sh` writes `host_os` only on Linux; macOS's `host-network.json` must stay identical.
  - `kiosk_session.py` is installed and refreshed only on Linux.
- The kiosk UI parts show only when `lockdownAvailable()` is true: `isLaptop()` && `lanAccess !== true` && `hostOs === 'linux'` && a helper token is in `sessionStorage`.

**Fixed values (decided by the user)**
- PIN: exactly `csg`, plain text, the same on every laptop, compared case-sensitively. No hashing and no setting.
- Cloud check: every **15 s**, never giving up, at `GET {EDGE_CLOUD_API_URL}/system/status` (any 2xx).
- Exit order: stop the watcher, then close Chrome, then restore the GNOME shortcuts.

**Assumed values** (mark them as assumptions in comments, as the spec §9 lists them):

| What | Value |
| --- | --- |
| Helper port | `127.0.0.1:8092` |
| Watch poll | 1 s |
| Relaunch delay | 2 s |
| Waiting-page poll | 2 s |
| Tray poll and Network re-list | 15 s |
| System-info cache | 5 s |
| Probe timeout | 5 s |
| Chrome stop grace | 5 s |
| nmcli | `--wait 45`, process timeout 60 s |
| Body limit | 4 KB |
| Password | ≤128 characters |
| SSID | 1–32 bytes |
| Session log | last 1 MB |

**Secrets**
- The Wi-Fi password goes to nmcli on **stdin only**. It is never on argv, in a log, or in a response.
- The helper token is never logged, never on a command line, and never sent to the edge.

**Project rules**
- American English.
- 24-hour `HH:MM` times.
- Every screen follows light/dark.
- Modals:
  - use the house modal (`modal-scrim` > `modal-card reports-modal-card rgm-card confirm-card`);
  - use the report-generate header (`modal-head` > `rgm-head-text` with `eyebrow`, `h3` and `page-hint`, plus `modal-close`);
  - have rounded corners;
  - keep their action buttons in a pinned `modal-foot` (never below a scroll).
- No default light scrollbars.
- Existing idioms only.
- No widgets beyond the spec.

**Test commands** (run them in the FOREGROUND with a 600000 ms timeout; never background a suite):

| Suite | Command |
| --- | --- |
| Installer | `cd <worktree> && python3 -m pytest -q kiosk_laptop/installer/tests/<file>` |
| Edge | `cd <worktree>/kiosk_laptop/edge && .venv/bin/pytest -q <files>` |
| Kiosk | `cd <worktree>/kiosk && npx vitest run <files>` |

- Edge venv: create it once if `.venv` is missing: `python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`.
- Kiosk deps: run `npm ci --prefix kiosk` once in the **worktree**, never in the main checkout.
- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/kiosk-lockdown` (branch `kiosk-lockdown`).
- Commit with explicit `git add <path>`, and never push.

## Helper HTTP contract (shared by Tasks 3, 5, 6)

Base: `http://127.0.0.1:8092`.

**Every request**
- `Host` must be exactly `127.0.0.1:8092`; anything else gets 400.
- If an `Origin` header is present, it must be `http://localhost:8090` or `http://127.0.0.1:8092`; anything else gets 403.
- Responses to Origin `http://localhost:8090` carry `Access-Control-Allow-Origin: http://localhost:8090` and `Vary: Origin`.
- `OPTIONS /v1/*` from that origin answers 204 with these headers. Any other origin gets 403.
  - `Access-Control-Allow-Methods: GET, POST`
  - `Access-Control-Allow-Headers: Content-Type, X-Kiosk-Token`
  - `Access-Control-Allow-Private-Network: true`
  - `Access-Control-Max-Age: 600`
- Every `/v1/*` request needs `X-Kiosk-Token: <token>`; without it the answer is 403 `{"error": "forbidden"}`.
- A POST needs `Content-Type: application/json` and a body of 1 to 4096 bytes holding a JSON object; anything else gets 400 `{"error": "bad_request"}`.

**Endpoints**

| Method, path | Answer |
| --- | --- |
| `GET /waiting` | HTML, no token needed. The token and the kiosk URL are inline. Headers: `Content-Security-Policy` containing `frame-ancestors 'none'`, and `X-Frame-Options: DENY`. |
| `GET /v1/state` | `{"ready": bool, "cloud": bool, "last_attempt": int epoch ms \| null, "system": System}` |
| `GET /v1/system` | `System` (see below) |
| `GET /v1/wifi` | `{"networks": WifiNetwork[], "wired": Wired \| null}`, with `WifiNetwork = {"ssid": str, "signal": int 0-100, "secure": bool, "active": bool}`. Sorted active first, then by signal, high to low. |
| `POST /v1/wifi/join` `{"ssid": str, "password": str}` | 200 `{"ok": true}` \| 422 `{"error": "wrong_password" \| "password_required" \| "not_found" \| "failed"}` \| 400 |
| `POST /v1/exit` `{"pin": str}` | 200 `{"ok": true}`, then the session exits \| 403 `{"error": "wrong_pin"}` |

```
System = {"battery": {"percent": int 0-100, "charging": bool} | null,
          "wifi": {"ssid": str, "signal": int 0-100} | null,
          "wired": {"connected": bool, "device": str} | null,
          "network": "wifi" | "wired" | "none"}
```

**Token handoff:** when ready, the waiting page navigates to `http://localhost:8090/#kh=<token>`. The token is `secrets.token_urlsafe(32)`, 43 characters from `[A-Za-z0-9_-]`.

---

### Task 1: hostnet reports the OS; the edge serves `hostOs`

**Files:**
- Modify: `kiosk_laptop/installer/hostnet.sh` (header comment, `to_json`, a new `host_os`, `main`)
- Modify: `kiosk_laptop/edge/src/edge/hostnet.py` (a new `read_host_os`)
- Modify: `kiosk_laptop/edge/src/edge/app.py` (`config_js`)
- Modify: `kiosk/src/lib/config.ts` (the `__KIOSK_CONFIG__` type)
- Test: `kiosk_laptop/installer/tests/test_hostnet_sh.py`, `kiosk_laptop/edge/tests/test_hostnet.py`, `kiosk_laptop/edge/tests/test_static.py`

**Interfaces:**
- Consumes:
  - `hostnet.sh` `to_json STAMP [GATEWAY [SELF]]`;
  - `main()`, which writes `<data>/host-network.json`;
  - `edge.hostnet.FILE_NAME`;
  - `app.py`'s `config_js` body.
- Produces:
  - `hostnet.sh` `host_os` prints `linux` when `$OS = Linux`, and nothing otherwise.
  - `to_json STAMP [GATEWAY [SELF [HOST_OS]]]` appends `, "host_os": "<HOST_OS>"` after `self_addresses` when HOST_OS isn't empty.
  - `edge.hostnet.read_host_os(data_dir) -> str | None` returns `"linux"` or `None`, and never raises.
  - `/config.js` gains `"hostOs": "linux"` or `"hostOs": null`.
  - `config.ts` type: `hostOs?: string | null`.

- [ ] **Step 1: Failing shell tests.** Append to `kiosk_laptop/installer/tests/test_hostnet_sh.py`:

```python
# ── host_os: which OS the laptop runs (Linux only) ────────────────────
def test_to_json_with_host_os(tmp_path):
    r = hn(tmp_path, 'to_json 2026-10-01T18:00:00Z 10.10.48.1 "10.10.48.57" linux',
           stdin="en0\t10.10.48.57\t24\n")
    data = json.loads(r.stdout)
    assert list(data) == ["updated_at", "interfaces", "gateway", "self_addresses", "host_os"]
    assert data["host_os"] == "linux"


def test_host_os_is_linux_only(tmp_path):
    assert hn(tmp_path, "OS=Linux; host_os").stdout == "linux"
    assert hn(tmp_path, "OS=Darwin; host_os").stdout == ""


def test_main_on_linux_writes_host_os(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    ipj = tmp_path / "ip.json"; ipj.write_text(IP_JSON)
    r = hn(tmp_path, f'OS=Linux; ip() {{ [ "$*" = "-j -4 addr" ] && cat "{ipj}"; }}; main; echo rc=$?',
           env={"KIOSK_DATA_DIR": str(data), "KIOSK_SYSFS_NET": str(fake_sysfs(tmp_path))})
    assert r.stdout == "rc=0\n", r.stderr
    assert json.loads((data / "host-network.json").read_text())["host_os"] == "linux"
    assert _edge_reader().read_host_os(data) == "linux"


def test_main_on_macos_writes_no_host_os(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    ifc = tmp_path / "ifconfig.txt"; ifc.write_text(IFCONFIG)
    ports = tmp_path / "ports.txt"; ports.write_text(PORTS)
    r = hn(tmp_path, f'OS=Darwin; ifconfig() {{ cat "{ifc}"; }}; '
                     f'networksetup() {{ cat "{ports}"; }}; main; echo rc=$?',
           env={"KIOSK_DATA_DIR": str(data)})
    assert r.stdout == "rc=0\n", r.stderr
    assert "host_os" not in json.loads((data / "host-network.json").read_text())
```

- [ ] **Step 2: Run the tests and watch them fail.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_hostnet_sh.py -k host_os` fails: there is no `host_os`, and `to_json` ignores a fourth argument.

- [ ] **Step 3: Implement in `hostnet.sh`.**
  - In the header comment, after the `"self_addresses"` paragraph, add: `On Linux it also writes "host_os": "linux" (the kiosk page turns the Linux lockdown on with it); macOS's file has no such key.`
  - Replace the `to_json` comment and function with:

```bash
# to_json STAMP [GATEWAY [SELF [HOST_OS]]]: "name<TAB>ipv4<TAB>prefix" lines on
# stdin -> the file's JSON, with a "gateway" key after the interfaces when
# GATEWAY isn't empty, then "self_addresses" (SELF split on spaces) when SELF is
# given, then "host_os" when HOST_OS isn't empty.
to_json() {
  awk -F '\t' -v stamp="$1" -v gw="${2:-}" -v hasself="$([ $# -ge 3 ] && echo 1 || echo 0)" -v selfs="${3:-}" \
      -v hostos="${4:-}" '
    function esc(v) { gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); return v }
    { items = items (NR > 1 ? ", " : "") sprintf("{\"name\": \"%s\", \"ipv4\": \"%s\", \"prefix\": %d}", esc($1), $2, $3) }
    END {
      extra = (gw != "") ? sprintf(", \"gateway\": \"%s\"", esc(gw)) : ""
      if (hasself) {
        n = split(selfs, ips, " "); list = ""
        for (i = 1; i <= n; i++) list = list (list != "" ? ", " : "") sprintf("\"%s\"", esc(ips[i]))
        extra = extra sprintf(", \"self_addresses\": [%s]", list)
      }
      if (hostos != "") extra = extra sprintf(", \"host_os\": \"%s\"", esc(hostos))
      printf "{\"updated_at\": \"%s\", \"interfaces\": [%s]%s}\n", stamp, items, extra
    }
  '
}

# host_os: "linux" on Linux, for the kiosk page (only a Linux laptop gets the
# kiosk lockdown). Nothing elsewhere, so macOS's file stays as it was.
host_os() { [ "$OS" != Linux ] || printf 'linux'; }
```

  - In `main`, change the last line to pass the OS:

```bash
  write_host_network "$(data_dir)" "$(printf '%s' "$found" | usable_only | to_json "$(utc_now)" "$(gateway)" "$self" "$(host_os)")"
```

- [ ] **Step 4: Run the shell tests again.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_hostnet_sh.py` now passes completely; the existing `test_to_json_with_self_addresses` key order still holds with three arguments. `test_main_on_linux_writes_host_os` needs Step 6's `read_host_os`, so run it again after Step 6.

- [ ] **Step 5: Failing edge tests.** Append to `kiosk_laptop/edge/tests/test_hostnet.py` (it already imports `json`/`datetime`; add `from edge.hostnet import read_host_os` to its imports):

```python
def test_read_host_os(tmp_path):
    f = tmp_path / "host-network.json"
    assert read_host_os(tmp_path) is None                      # no file
    f.write_text('{"updated_at": "2020-01-01T00:00:00Z", "interfaces": [], "host_os": "linux"}')
    assert read_host_os(tmp_path) == "linux"                   # stale still names the OS
    for bad in ('{"host_os": "Linux"}', '{"host_os": 1}', '{"interfaces": []}', '[]', 'nope'):
        f.write_text(bad)
        assert read_host_os(tmp_path) is None


async def test_config_js_carries_host_os(settings, cloud):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "host-network.json").write_text(
        json.dumps({"updated_at": "2026-11-11T09:00:00Z", "interfaces": [], "host_os": "linux"}))
    transport = httpx.ASGITransport(app=create_app(settings))
    async with httpx.AsyncClient(transport=transport, base_url="http://edge.test") as c:
        r = await c.get("/config.js", headers={"host": "localhost:8090"})
    assert '"hostOs": "linux"' in r.text
```

  Then append to `kiosk_laptop/edge/tests/test_static.py`:

```python
async def test_config_js_host_os_is_null_without_the_file(client):
    r = await client.get("/config.js")
    assert '"hostOs": null' in r.text
```

- [ ] **Step 6: Implement in the edge.**
  - In `kiosk_laptop/edge/src/edge/hostnet.py`, after `read_self_addresses`, add:

```python
def read_host_os(data_dir) -> str | None:
    """The laptop's OS as the host helper reports it: "linux" (hostnet.sh
    writes it on Linux only), else None. Stale or not, since an OS doesn't
    change. Never raises."""
    try:
        value = json.loads((Path(data_dir) / FILE_NAME).read_text()).get("host_os")
    except Exception:
        return None
    return "linux" if value == "linux" else None
```

  - In `kiosk_laptop/edge/src/edge/app.py`, change the import to `from edge.hostnet import DynamicHosts, HostCheckMiddleware, parse_host, read_host_os`. In `config_js`, add one line after the `"lanAccess"` line:

```python
            f'"hostOs": {json.dumps(read_host_os(settings.data_dir))}, '
```

  - In `kiosk/src/lib/config.ts`, add this to the `__KIOSK_CONFIG__` type, after `lanAccess`:

```ts
      /** The laptop edge serves "linux" when hostnet.sh reported a Linux
       *  laptop (the kiosk lockdown is Linux-only); null elsewhere. */
      hostOs?: string | null;
```

- [ ] **Step 7: Run everything.** All of these pass:
  - `cd kiosk_laptop/edge && .venv/bin/pytest -q tests/test_hostnet.py tests/test_static.py`
  - `python3 -m pytest -q kiosk_laptop/installer/tests/test_hostnet_sh.py kiosk_laptop/installer/tests/test_install_sh.py::test_shellcheck_clean`

- [ ] **Step 8: Commit.**

```bash
git add kiosk_laptop/installer/hostnet.sh kiosk_laptop/installer/tests/test_hostnet_sh.py \
  kiosk_laptop/edge/src/edge/hostnet.py kiosk_laptop/edge/src/edge/app.py \
  kiosk_laptop/edge/tests/test_hostnet.py kiosk_laptop/edge/tests/test_static.py kiosk/src/lib/config.ts
git commit -m "feat(kiosk-laptop): hostnet reports host_os on Linux; /config.js serves hostOs"
```

---

### Task 2: `kiosk_session.py`, part 1: desktop lock, system info, Wi-Fi join, Start Kiosk icon

**Files:**
- Create: `kiosk_laptop/installer/kiosk_session.py` (mode 755)
- Test: `kiosk_laptop/installer/tests/test_kiosk_session.py`

**Interfaces:**
- Consumes: nothing from other tasks. External tools: `gsettings`, `nmcli`, `xdg-user-dir`, `gio`, and `/sys/class/power_supply`.
- Produces (module `kiosk_session`, used by Tasks 3 and 4):
  - Constants: `KIOSK_DIR`, `KIOSK_URL`, `KIOSK_ORIGIN`, `EDGE_IDENTITY_URL`, `DEFAULT_API_URL`, `HELPER_HOST`, `HELPER_PORT`, `EXIT_PIN`, `CLOUD_CHECK_S`, `WATCH_S`, `RELAUNCH_DELAY_S`, `WAIT_POLL_MS`, `SYSTEM_CACHE_S`, `PROBE_TIMEOUT_S`, `CHROME_STOP_S`, `MAX_BODY`, `START_ICON`, `RESTORE_AUTOSTART`, `LOCK_KEYS`.
  - Functions:
    - `log(msg)`;
    - `run_cmd(cmd, *, stdin=None, timeout=10) -> CompletedProcess` (the only way tools run, so tests patch it);
    - `config_value(key, path=None) -> str`;
    - `state_dir() -> Path`;
    - `lock_desktop() -> int`;
    - `restore_desktop() -> bool`;
    - `battery(root=POWER_SUPPLY) -> dict | None`;
    - `nmcli_fields(line) -> list[str]`;
    - `wifi_networks(rescan=True) -> list[dict]`;
    - `wired_status() -> dict | None`;
    - `system_info() -> dict` (the `System` shape);
    - `valid_ssid(v) -> bool`, `valid_password(v) -> bool`;
    - `join_wifi(ssid, password) -> str` (`"ok"` or an error code);
    - `start_icon_text(launch: Path) -> str`;
    - `ensure_start_icon()`;
    - `cleanup_restore_entry()`;
    - `main(argv) -> int`, with `restore [--cleanup]` (Task 3 adds `run`).
  - CLI: `python3 kiosk_session.py restore [--cleanup]` exits 0 when the shortcuts are back.

- [ ] **Step 1: Failing tests.** Create `kiosk_laptop/installer/tests/test_kiosk_session.py`:

```python
"""kiosk_session.py (Linux kiosk lockdown): the GNOME lock, system info and
Wi-Fi join (Task 2); the helper server and the watcher (Task 3). Every tool
goes through run_cmd, which these tests replace."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SESSION_PY = Path(__file__).resolve().parents[1] / "kiosk_session.py"


def load(name="kiosk_session_under_test"):
    spec = importlib.util.spec_from_file_location(name, SESSION_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def ks(tmp_path, monkeypatch):
    (tmp_path / "home").mkdir()
    (tmp_path / "kiosk").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("KIOSK_DIR", str(tmp_path / "kiosk"))
    return load()


def done(cmd, rc=0, out="", err=""):
    return subprocess.CompletedProcess(cmd, rc, out, err)


class Tools:
    """run_cmd's stand-in: a gsettings store ((schema, key) -> printed value),
    an nmcli answer function, and every call with its stdin."""

    def __init__(self, values=None, nmcli=None):
        self.values = dict(values or {})
        self.fail = set()
        self.nmcli = nmcli or (lambda cmd, stdin: done(cmd, 1))
        self.calls = []

    def __call__(self, cmd, *, stdin=None, timeout=10):
        self.calls.append((list(cmd), stdin))
        if cmd[0] == "gsettings":
            verb, schema, key = cmd[1], cmd[2], cmd[3]
            if (schema, key) not in self.values:
                return done(cmd, 1, err="No such key")
            if verb == "get":
                return done(cmd, 0, self.values[(schema, key)] + "\n")
            if (schema, key) in self.fail:
                return done(cmd, 1, err="write failed")
            self.values[(schema, key)] = cmd[4] if verb == "set" else "DEFAULT"
            return done(cmd)
        if cmd[0] == "nmcli":
            return self.nmcli(cmd, stdin)
        return done(cmd, 127)


GNOME = {
    ("org.gnome.mutter", "overlay-key"): "'Super_L'",
    ("org.gnome.desktop.wm.keybindings", "switch-applications"): "['<Super>Tab', '<Alt>Tab']",
    ("org.gnome.desktop.interface", "enable-hot-corners"): "true",
    ("org.gnome.desktop.wm.preferences", "num-workspaces"): "4",
    ("org.gnome.mutter", "dynamic-workspaces"): "true",
    ("org.gnome.desktop.wm.keybindings", "switch-to-workspace-left"): "['<Super>Page_Up']",
}


# ── desktop lock ──────────────────────────────────────────────────────
def test_lock_keys_cover_the_four_groups(ks):
    keys = {(s, k): v for s, k, v in ks.LOCK_KEYS}
    assert keys[("org.gnome.mutter", "overlay-key")] == "''"
    assert keys[("org.gnome.shell.keybindings", "toggle-overview")] == "@as []"
    assert keys[("org.gnome.desktop.wm.keybindings", "switch-applications")] == "@as []"
    assert keys[("org.gnome.desktop.wm.keybindings", "switch-windows-backward")] == "@as []"
    assert keys[("org.gnome.desktop.interface", "enable-hot-corners")] == "false"
    assert keys[("org.gnome.desktop.wm.preferences", "num-workspaces")] == "1"
    assert keys[("org.gnome.desktop.wm.keybindings", "switch-to-workspace-12")] == "@as []"
    assert keys[("org.gnome.desktop.wm.keybindings", "move-to-workspace-last")] == "@as []"
    # Alt+F2 and Ctrl+Alt+T are real escapes, so they are locked too (spec §8)
    assert keys[("org.gnome.desktop.wm.keybindings", "panel-run-dialog")] == "@as []"
    assert keys[("org.gnome.settings-daemon.plugins.media-keys", "terminal")] == "@as []"


def test_lock_saves_first_then_locks_and_restore_puts_everything_back(ks, monkeypatch):
    tools = Tools(GNOME)
    order = []
    real_write = ks.write_saved
    monkeypatch.setattr(ks, "write_saved", lambda items: (order.append("saved"), real_write(items)))
    monkeypatch.setattr(ks, "run_cmd", lambda cmd, **kw: (order.append(cmd[1]), tools(cmd, **kw))[1])
    assert ks.lock_desktop() == len(GNOME)
    assert order.index("saved") < order.index("set")          # on disk before anything changes
    assert tools.values[("org.gnome.mutter", "overlay-key")] == "''"
    assert tools.values[("org.gnome.desktop.interface", "enable-hot-corners")] == "false"
    lock = ks.state_dir() / "desktop-lock.json"
    assert oct(lock.stat().st_mode & 0o777) == "0o600"
    assert ks.restore_desktop() is True
    assert tools.values == GNOME
    assert not lock.exists()


def test_relock_after_a_crash_keeps_the_originals(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    ks.lock_desktop()                                          # next sign-in, file still there
    assert ks.restore_desktop() is True
    assert tools.values == GNOME


def test_a_value_already_locked_is_reset_to_the_default(ks, monkeypatch):
    tools = Tools({**GNOME, ("org.gnome.mutter", "overlay-key"): "''"})   # a lost file left it locked
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    saved = json.loads((ks.state_dir() / "desktop-lock.json").read_text())["saved"]
    assert {"schema": "org.gnome.mutter", "key": "overlay-key", "value": None} in saved
    ks.restore_desktop()
    assert tools.values[("org.gnome.mutter", "overlay-key")] == "DEFAULT"


def test_keys_missing_on_this_desktop_are_skipped(ks, monkeypatch):
    tools = Tools({("org.gnome.mutter", "overlay-key"): "'Super_L'"})
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.lock_desktop() == 1
    sets = [c for c, _ in tools.calls if c[1] == "set"]
    assert sets == [["gsettings", "set", "org.gnome.mutter", "overlay-key", "''"]]


def test_a_key_that_fails_to_restore_stays_for_next_time(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    ks.lock_desktop()
    tools.fail.add(("org.gnome.mutter", "overlay-key"))
    assert ks.restore_desktop() is False
    left = json.loads((ks.state_dir() / "desktop-lock.json").read_text())["saved"]
    assert left == [{"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]
    tools.fail.clear()
    assert ks.restore_desktop() is True and tools.values == GNOME


def test_nothing_is_locked_when_the_originals_cant_be_saved(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    def refuse(items):
        raise OSError("read-only")
    monkeypatch.setattr(ks, "write_saved", refuse)
    assert ks.lock_desktop() == 0
    assert tools.values == GNOME


def test_restore_without_a_file_is_a_no_op(ks, monkeypatch):
    tools = Tools(GNOME)
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.restore_desktop() is True and tools.calls == []


def test_restore_cleanup_cli_removes_the_one_shot_entry_and_its_copy(tmp_path):
    home, state = tmp_path / "home", tmp_path / "state"
    auto = home / ".config" / "autostart"; auto.mkdir(parents=True)
    (auto / "serversherpa-kiosk-restore.desktop").write_text("[Desktop Entry]\n")
    (state / "serversherpa-kiosk").mkdir(parents=True)
    copy = state / "serversherpa-kiosk" / "kiosk_session.py"
    copy.write_text(SESSION_PY.read_text())
    (state / "serversherpa-kiosk" / "desktop-lock.json").write_text(
        json.dumps({"version": 1, "saved": [{"schema": "org.gnome.mutter", "key": "overlay-key", "value": "'Super_L'"}]}))
    bindir = tmp_path / "bin"; bindir.mkdir()
    (bindir / "gsettings").write_text("#!/bin/sh\nexit 1\n"); (bindir / "gsettings").chmod(0o755)
    env = {**os.environ, "HOME": str(home), "XDG_STATE_HOME": str(state), "PATH": f"{bindir}:/usr/bin:/bin"}
    r = subprocess.run([sys.executable, str(copy), "restore", "--cleanup"], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert not (auto / "serversherpa-kiosk-restore.desktop").exists() and not copy.exists()


# ── battery and network ───────────────────────────────────────────────
def supply(root, name, **files):
    d = root / name; d.mkdir(parents=True)
    for k, v in files.items():
        (d / k).write_text(f"{v}\n")


def test_battery_from_sysfs(ks, tmp_path):
    root = tmp_path / "ps"
    supply(root, "AC", type="Mains", online="1")
    supply(root, "hidpp_battery_0", type="Battery", scope="Device", capacity="12", status="Discharging")
    supply(root, "BAT0", type="Battery", capacity="87", status="Not charging")
    assert ks.battery(root) == {"percent": 87, "charging": True}
    (root / "AC" / "online").write_text("0\n")
    (root / "BAT0" / "status").write_text("Discharging\n")
    assert ks.battery(root) == {"percent": 87, "charging": False}
    assert ks.battery(tmp_path / "missing") is None


def test_nmcli_fields_unescape(ks):
    assert ks.nmcli_fields(r"*:Cafe\: Guest:72:WPA2") == ["*", "Cafe: Guest", "72", "WPA2"]
    assert ks.nmcli_fields(r" :back\\slash:5:") == [" ", "back\\slash", "5", ""]


WIFI = "\n".join([
    " :CSG-Ops:40:WPA2", "*:CSG-Ops:72:WPA2", " ::80:WPA2", " :Guest:55:", " :Lobby:90:--",
]) + "\n"
DEVICES = "docker0:bridge:connected (externally)\nveth1a2:ethernet:unmanaged\nenp0s31f6:ethernet:connected\nwlp2s0:wifi:connected\n"


def nm(cmd, stdin):
    if cmd[:6] == ["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi"]:
        return done(cmd, 0, WIFI)
    if cmd[:6] == ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"]:
        return done(cmd, 0, DEVICES)
    return done(cmd, 1)


def test_wifi_networks_merge_bssids_drop_hidden_and_sort(ks, monkeypatch):
    tools = Tools(nmcli=nm)
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.wifi_networks() == [
        {"ssid": "CSG-Ops", "signal": 72, "secure": True, "active": True},
        {"ssid": "Lobby", "signal": 90, "secure": False, "active": False},
        {"ssid": "Guest", "signal": 55, "secure": False, "active": False},
    ]
    assert tools.calls[-1][0][-2:] == ["--rescan", "auto"]
    ks.wifi_networks(rescan=False)
    assert tools.calls[-1][0][-2:] == ["--rescan", "no"]


def test_wired_status_and_system_info(ks, monkeypatch, tmp_path):
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=nm))
    monkeypatch.setattr(ks, "POWER_SUPPLY", tmp_path / "none")
    assert ks.wired_status() == {"connected": True, "device": "enp0s31f6"}
    assert ks.system_info() == {"battery": None, "wifi": {"ssid": "CSG-Ops", "signal": 72},
                                "wired": {"connected": True, "device": "enp0s31f6"}, "network": "wifi"}
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=lambda c, s: done(c, 1)))
    assert ks.system_info()["network"] == "none"


# ── Wi-Fi join ────────────────────────────────────────────────────────
def test_join_sends_the_password_on_stdin_only(ks, monkeypatch):
    tools = Tools(nmcli=lambda cmd, stdin: done(cmd, 0, "Device 'wlp2s0' successfully activated"))
    monkeypatch.setattr(ks, "run_cmd", tools)
    assert ks.join_wifi("CSG-Ops", "s3cret pass") == "ok"
    cmd, stdin = tools.calls[-1]
    assert cmd == ["nmcli", "--wait", "45", "--ask", "device", "wifi", "connect", "CSG-Ops"]
    assert stdin == "s3cret pass\n" and "s3cret pass" not in " ".join(cmd)
    assert ks.join_wifi("Guest", "") == "ok"
    assert tools.calls[-1] == (["nmcli", "--wait", "45", "device", "wifi", "connect", "Guest"], None)
    log = ks.state_dir() / "session.log"
    assert not log.exists() or "s3cret" not in log.read_text()


@pytest.mark.parametrize("err,password,code", [
    ("Error: Connection activation failed: Secrets were required, but not provided.", "x", "wrong_password"),
    ("Error: Connection activation failed: Secrets were required, but not provided.", "", "password_required"),
    ("Error: No network with SSID 'Nope' found.", "x", "not_found"),
    ("Error: something else", "x", "failed"),
])
def test_join_error_codes(ks, monkeypatch, err, password, code):
    monkeypatch.setattr(ks, "run_cmd", Tools(nmcli=lambda cmd, stdin: done(cmd, 4, "", err)))
    assert ks.join_wifi("Nope", password) == code


def test_join_input_checks(ks):
    assert ks.valid_ssid("CSG-Ops") and ks.valid_ssid("x" * 32)
    for bad in ("", "x" * 33, "a\nb", "a\x00", 5, None):
        assert not ks.valid_ssid(bad)
    assert ks.valid_password("") and ks.valid_password("p" * 128)
    for bad in ("p" * 129, "a\nb", "a\rb", None, 3):
        assert not ks.valid_password(bad)


# ── Start Kiosk icon ──────────────────────────────────────────────────
def test_start_icon_text(ks):
    t = ks.start_icon_text(Path("/opt/serversherpa-kiosk/launch.sh"))
    assert t.splitlines() == ["[Desktop Entry]", "Type=Application", "Name=Start Kiosk",
                              "Comment=Open the ServerSherpa kiosk", "Exec=/opt/serversherpa-kiosk/launch.sh",
                              "Icon=web-browser", "Terminal=false"]
    assert 'Exec="/opt/Server Sherpa/50%%/launch.sh"' in ks.start_icon_text(Path("/opt/Server Sherpa/50%/launch.sh"))


def test_ensure_start_icon_writes_marks_executable_and_trusted(ks, monkeypatch, tmp_path):
    tools = Tools()
    monkeypatch.setattr(ks, "run_cmd", tools)                  # xdg-user-dir missing: ~/Desktop
    ks.ensure_start_icon()
    f = tmp_path / "home" / "Desktop" / "serversherpa-start-kiosk.desktop"
    assert f.read_text() == ks.start_icon_text(ks.KIOSK_DIR / "launch.sh")
    assert f.stat().st_mode & 0o777 == 0o755
    assert (["gio", "set", str(f), "metadata::trusted", "true"], None) in tools.calls
```

- [ ] **Step 2: Run the tests and watch them fail.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_kiosk_session.py` fails because the file doesn't exist.

- [ ] **Step 3: Create `kiosk_laptop/installer/kiosk_session.py`** (then `chmod 755`):

```python
#!/usr/bin/env python3
"""ServerSherpa kiosk session (laptop edition, Linux only).

Started at sign-in by launch.sh (the autostart entry serversherpa-kiosk.desktop),
from the app menu, or from Start Kiosk on the desktop, as the desktop user,
inside the GNOME session. One process holds four parts:

  - a helper on 127.0.0.1:8092. It serves the "Connecting to ServerSherpa…"
    page and answers the kiosk page (battery, network, Wi-Fi, exit), gated by
    Host, Origin and a per-session token;
  - the cloud check, every 15 s, never giving up;
  - the desktop lock: the GNOME shortcuts that escape the kiosk are switched
    off (the earlier values saved first) and put back on exit;
  - the watcher: Chrome in --kiosk mode, reopened whenever it closes, until
    the kiosk is exited with the PIN.

Stdlib only; written for Ubuntu 22.04's python3 (3.10). Refreshed nightly by
update.sh (Linux only).

  kiosk_session.py run --browser PATH   the session (launch.sh)
  kiosk_session.py restore [--cleanup]  put the desktop shortcuts back
                                        (install.sh --uninstall; --cleanup
                                        also removes the one-shot restore entry)
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

KIOSK_DIR = Path(os.environ.get("KIOSK_DIR") or Path(__file__).resolve().parent)
KIOSK_URL = "http://localhost:8090"
KIOSK_ORIGIN = KIOSK_URL
EDGE_IDENTITY_URL = "http://127.0.0.1:8090/edge/identity"
DEFAULT_API_URL = "https://api.serversherpa.com"   # install.sh's default
HELPER_HOST = "127.0.0.1"
HELPER_PORT = 8092          # assumption: next to 8090 (UI) and 8091 (RFID reader)
# A barrier, not a secret (decided): the same on every laptop, plain text.
EXIT_PIN = "csg"
CLOUD_CHECK_S = 15          # decided
WATCH_S = 1.0               # assumption: how often the watcher looks at Chrome
RELAUNCH_DELAY_S = 2.0      # assumption: Chrome is back within about 3 s
WAIT_POLL_MS = 2000         # assumption: the waiting page's poll
SYSTEM_CACHE_S = 5.0        # assumption
PROBE_TIMEOUT_S = 5.0       # assumption
CHROME_STOP_S = 5.0         # assumption: SIGTERM grace before SIGKILL
JOIN_WAIT_S = 45            # assumption: nmcli --wait
JOIN_TIMEOUT_S = 60         # assumption
MAX_BODY = 4096             # assumption
MAX_PASSWORD = 128          # assumption
LOG_MAX_BYTES = 1_048_576   # as update.log
START_ICON = "serversherpa-start-kiosk.desktop"
RESTORE_AUTOSTART = "serversherpa-kiosk-restore.desktop"
POWER_SUPPLY = Path("/sys/class/power_supply")


# ── Small helpers ─────────────────────────────────────────────────────
def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "serversherpa-kiosk"


def log(message: str) -> None:
    """One line in session.log (the last LOG_MAX_BYTES kept). Never a password,
    a token or a request line."""
    try:
        d = state_dir()
        d.mkdir(parents=True, exist_ok=True)
        f = d / "session.log"
        if f.exists() and f.stat().st_size > LOG_MAX_BYTES:
            f.write_bytes(f.read_bytes()[-(LOG_MAX_BYTES // 2):])
        with f.open("a", encoding="utf-8") as out:
            out.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def run_cmd(cmd: list[str], *, stdin: str | None = None, timeout: float = 10) -> subprocess.CompletedProcess:
    """Runs a tool. A missing tool is exit 127 and a timeout is 124, never an
    exception. stdin, when given, is the tool's whole input."""
    try:
        return subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError:
        return subprocess.CompletedProcess(cmd, 127, "", "")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", "")


def config_value(key: str, path: Path | None = None) -> str:
    """KEY's value in config.env, read without executing the file ('' when missing)."""
    path = path or KIOSK_DIR / "config.env"
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line[len(key) + 1:].strip()
    except OSError:
        pass
    return ""


# ── Desktop lock ──────────────────────────────────────────────────────
# (schema, key, locked value), written with gsettings in the user's session.
# Values are in gsettings' own print format, so "already locked" is a plain
# string compare. A schema or key this desktop doesn't have is skipped.
EMPTY = "@as []"
_WM = "org.gnome.desktop.wm.keybindings"
_SHELL = "org.gnome.shell.keybindings"
_SWITCHERS = ("switch-applications", "switch-windows", "switch-group", "cycle-windows",
              "cycle-group", "switch-panels", "cycle-panels")
_WORKSPACE_KEYS = tuple(f"{verb}-to-workspace-{where}" for verb in ("switch", "move")
                        for where in ("left", "right", "up", "down", "last", *map(str, range(1, 13))))
LOCK_KEYS: tuple[tuple[str, str, str], ...] = (
    # 1. the Super key and the overview it opens
    ("org.gnome.mutter", "overlay-key", "''"),
    (_SHELL, "toggle-overview", EMPTY),
    (_SHELL, "toggle-application-view", EMPTY),
    (_SHELL, "toggle-message-tray", EMPTY),
    (_SHELL, "toggle-quick-settings", EMPTY),
    (_SHELL, "focus-active-notification", EMPTY),
    *((_SHELL, f"switch-to-application-{n}", EMPTY) for n in range(1, 10)),
    ("org.gnome.shell.extensions.dash-to-dock", "hot-keys", "false"),
    (_WM, "panel-main-menu", EMPTY),          # Alt+F1 opens the overview
    (_WM, "minimize", EMPTY),                 # Super+H
    (_WM, "panel-run-dialog", EMPTY),         # Alt+F2 runs a command
    ("org.gnome.settings-daemon.plugins.media-keys", "terminal", EMPTY),  # Ctrl+Alt+T
    # 2. Alt+Tab and the other window switchers
    *((_WM, k, EMPTY) for name in _SWITCHERS for k in (name, f"{name}-backward")),
    # 3. the Activities hot corner
    ("org.gnome.desktop.interface", "enable-hot-corners", "false"),
    # 4. workspaces: one, fixed, with no keys to switch or move
    ("org.gnome.mutter", "dynamic-workspaces", "false"),
    ("org.gnome.desktop.wm.preferences", "num-workspaces", "1"),
    (_SHELL, "shift-overview-up", EMPTY),
    (_SHELL, "shift-overview-down", EMPTY),
    *((_WM, k, EMPTY) for k in _WORKSPACE_KEYS),
)


def gsettings_get(schema: str, key: str) -> str | None:
    r = run_cmd(["gsettings", "get", schema, key])
    return r.stdout.strip() if r.returncode == 0 else None


def gsettings_set(schema: str, key: str, value: str) -> bool:
    return run_cmd(["gsettings", "set", schema, key, value]).returncode == 0


def gsettings_reset(schema: str, key: str) -> bool:
    return run_cmd(["gsettings", "reset", schema, key]).returncode == 0


def lock_file() -> Path:
    return state_dir() / "desktop-lock.json"


def read_saved() -> list[dict] | None:
    """The saved originals, or None when there is no (usable) file."""
    try:
        data = json.loads(lock_file().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        log("desktop-lock.json is unreadable; saving the current values again")
        return None
    items = data.get("saved") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    return [i for i in items if isinstance(i, dict) and isinstance(i.get("schema"), str)
            and isinstance(i.get("key"), str) and (i.get("value") is None or isinstance(i.get("value"), str))]


def write_saved(items: list[dict]) -> None:
    """Atomically, mode 600, synced to disk before it replaces the file."""
    d = state_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / ".desktop-lock.json.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "saved": items}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, lock_file())


def lock_desktop() -> int:
    """Saves the current values once (a file that is already there keeps the
    true originals after a crash), then writes the locked ones. A value
    already locked is saved as None, which means "reset to the default" on
    restore, so a lost file can never make the locked values the originals.
    Returns how many settings were locked (0 when the originals couldn't be
    saved: then nothing changes)."""
    saved = read_saved()
    if saved is None:
        saved = []
        for schema, key, locked in LOCK_KEYS:
            current = gsettings_get(schema, key)
            if current is None:
                continue
            saved.append({"schema": schema, "key": key, "value": None if current == locked else current})
        try:
            write_saved(saved)
        except OSError as exc:
            log(f"desktop lock skipped: can't save the current values ({exc})")
            return 0
    keep = {(i["schema"], i["key"]) for i in saved}
    n = sum(1 for schema, key, locked in LOCK_KEYS
            if (schema, key) in keep and gsettings_set(schema, key, locked))
    log(f"desktop locked ({n} settings)")
    return n


def restore_desktop() -> bool:
    """Puts every saved value back (None: reset). The file goes when all are
    back, or when a key no longer exists. A key that is there and failed
    stays in the file for the next restore. True when nothing is left."""
    saved = read_saved()
    if saved is None:
        return True
    left = []
    for item in saved:
        schema, key, value = item["schema"], item["key"], item["value"]
        ok = gsettings_reset(schema, key) if value is None else gsettings_set(schema, key, value)
        if not ok and gsettings_get(schema, key) is not None:
            left.append(item)
    if left:
        try:
            write_saved(left)
        except OSError:
            pass
        log(f"desktop restore: {len(left)} settings left for next time")
        return False
    try:
        lock_file().unlink()
    except FileNotFoundError:
        pass
    log("desktop restored")
    return True


# ── Battery and network ───────────────────────────────────────────────
def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def battery(root: Path | None = None) -> dict | None:
    """The laptop's own battery: the first type=Battery supply with a numeric
    capacity, never a device's (a mouse's: scope=Device). Charging means the
    battery says so, or the mains are on and it isn't discharging."""
    root = root or POWER_SUPPLY
    try:
        supplies = sorted(root.iterdir())
    except OSError:
        return None
    mains = any(_read(s / "type") == "Mains" and _read(s / "online") == "1" for s in supplies)
    for s in supplies:
        if _read(s / "type") != "Battery" or _read(s / "scope") == "Device" or _read(s / "present") == "0":
            continue
        cap = _read(s / "capacity")
        if not cap.isdigit():
            continue
        status = _read(s / "status")
        return {"percent": max(0, min(100, int(cap))),
                "charging": status == "Charging" or (mains and status != "Discharging")}
    return None


def nmcli_fields(line: str) -> list[str]:
    """One line of `nmcli -t` output, split on unescaped colons (`\\:` and
    `\\\\` are a literal colon and backslash)."""
    out: list[str] = []
    cur: list[str] = []
    i = 0
    while i < len(line):
        c = line[i]
        if c == "\\" and i + 1 < len(line):
            cur.append(line[i + 1])
            i += 2
            continue
        if c == ":":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return out


def wifi_networks(rescan: bool = True) -> list[dict]:
    """Visible Wi-Fi networks, one per name (the strongest access point),
    hidden ones dropped, the connected one first, then by signal."""
    r = run_cmd(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list",
                 "--rescan", "auto" if rescan else "no"], timeout=20)
    if r.returncode != 0:
        return []
    best: dict[str, dict] = {}
    for line in r.stdout.splitlines():
        f = nmcli_fields(line)
        if len(f) < 4 or not f[1]:
            continue
        net = {"ssid": f[1], "signal": max(0, min(100, int(f[2]) if f[2].isdigit() else 0)),
               "secure": f[3].strip() not in ("", "--"), "active": f[0].strip() == "*"}
        old = best.get(net["ssid"])
        if old is None:
            best[net["ssid"]] = net
            continue
        old["active"] = old["active"] or net["active"]
        if net["signal"] > old["signal"]:
            old["signal"], old["secure"] = net["signal"], net["secure"]
    return sorted(best.values(), key=lambda n: (not n["active"], -n["signal"], n["ssid"].lower()))


def wired_status() -> dict | None:
    """The first wired adapter NetworkManager manages (Docker's veths are
    unmanaged), connected ones first; None when there is none."""
    r = run_cmd(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"])
    if r.returncode != 0:
        return None
    found = None
    for line in r.stdout.splitlines():
        f = nmcli_fields(line)
        if len(f) < 3 or f[1] != "ethernet" or f[2] == "unmanaged":
            continue
        item = {"connected": f[2].startswith("connected"), "device": f[0]}
        if item["connected"]:
            return item
        found = found or item
    return found


def system_info() -> dict:
    nets = wifi_networks(rescan=False)
    active = next((n for n in nets if n["active"]), None)
    wired = wired_status()
    network = "wifi" if active else "wired" if wired and wired["connected"] else "none"
    return {"battery": battery(),
            "wifi": {"ssid": active["ssid"], "signal": active["signal"]} if active else None,
            "wired": wired, "network": network}


def _no_controls(v: str) -> bool:
    return not any(ord(c) < 32 or ord(c) == 127 for c in v)


def valid_ssid(v) -> bool:
    return isinstance(v, str) and 1 <= len(v.encode("utf-8")) <= 32 and _no_controls(v)


def valid_password(v) -> bool:
    return isinstance(v, str) and len(v) <= MAX_PASSWORD and _no_controls(v)


def join_wifi(ssid: str, password: str) -> str:
    """Joins SSID with NetworkManager: "ok", or "wrong_password",
    "password_required", "not_found", "failed". The password reaches nmcli on
    stdin only (--ask), never on its command line, and is never logged. An
    empty password uses a saved profile."""
    cmd = ["nmcli", "--wait", str(JOIN_WAIT_S)] + (["--ask"] if password else []) + ["device", "wifi", "connect", ssid]
    r = run_cmd(cmd, stdin=(password + "\n") if password else None, timeout=JOIN_TIMEOUT_S)
    if r.returncode == 0:
        return "ok"
    err = f"{r.stderr}\n{r.stdout}"
    if "No network with SSID" in err:
        return "not_found"
    if "Secrets were required" in err or "802-1X supplicant" in err or "(7) Secrets" in err:
        return "wrong_password" if password else "password_required"
    return "failed"


# ── Start Kiosk icon ──────────────────────────────────────────────────
def _exec_path(p: str) -> str:
    """As install.sh's exec_path: % doubled, quoted when it has spaces."""
    p = p.replace("%", "%%")
    return f'"{p}"' if any(c.isspace() for c in p) else p


def start_icon_text(launch: Path) -> str:
    """The desktop icon. install.sh's render_start_icon writes the same text
    (tests/test_install_sh.py checks they match)."""
    return ("[Desktop Entry]\nType=Application\nName=Start Kiosk\nComment=Open the ServerSherpa kiosk\n"
            f"Exec={_exec_path(str(launch))}\nIcon=web-browser\nTerminal=false\n")


def desktop_dir() -> Path:
    r = run_cmd(["xdg-user-dir", "DESKTOP"])
    p = r.stdout.strip() if r.returncode == 0 else ""
    return Path(p) if p and p != str(Path.home()) else Path.home() / "Desktop"


def ensure_start_icon() -> None:
    """Start Kiosk on the desktop: written when missing or different,
    executable, and trusted (the desktop launches it on a double-click)."""
    try:
        d = desktop_dir()
        d.mkdir(parents=True, exist_ok=True)
        f = d / START_ICON
        text = start_icon_text(KIOSK_DIR / "launch.sh")
        if not f.exists() or f.read_text(encoding="utf-8") != text:
            f.write_text(text, encoding="utf-8")
        f.chmod(0o755)
        run_cmd(["gio", "set", str(f), "metadata::trusted", "true"])
    except OSError as exc:
        log(f"Start Kiosk icon: {exc}")


def cleanup_restore_entry() -> None:
    """After an uninstall's one-shot restore: its autostart entry goes, and
    this file too when it is the copy in the state folder."""
    (Path.home() / ".config" / "autostart" / RESTORE_AUTOSTART).unlink(missing_ok=True)
    me = Path(__file__).resolve()
    if me.parent == state_dir().resolve():
        me.unlink(missing_ok=True)


# ── Command line ──────────────────────────────────────────────────────
def main(argv: list[str]) -> int:
    if argv[:1] == ["restore"] and argv[1:] in ([], ["--cleanup"]):
        ok = restore_desktop()
        if ok and argv[1:] == ["--cleanup"]:
            cleanup_restore_entry()
        return 0 if ok else 1
    print(__doc__, file=sys.stderr)
    return 2


# Called on the last line so a partially written file runs nothing.
if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run the tests again.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_kiosk_session.py` passes. `python3 -c "import ast,sys; ast.parse(open('kiosk_laptop/installer/kiosk_session.py').read())"` succeeds, and `head -n1` prints `#!/usr/bin/env python3`.

- [ ] **Step 5: Commit.**

```bash
chmod 755 kiosk_laptop/installer/kiosk_session.py
git add kiosk_laptop/installer/kiosk_session.py kiosk_laptop/installer/tests/test_kiosk_session.py
git commit -m "feat(kiosk-laptop): kiosk_session.py desktop lock, system info and Wi-Fi join (Linux)"
```

---

### Task 3: `kiosk_session.py`, part 2: helper server, waiting page, cloud check, watcher, `run`

**Files:**
- Modify: `kiosk_laptop/installer/kiosk_session.py`. Insert new sections between "Start Kiosk icon" and "Command line", and replace `main`.
- Test: `kiosk_laptop/installer/tests/test_kiosk_session.py` (append)

**Interfaces:**
- Consumes (Task 2, same file):
  - constants `HELPER_HOST`, `HELPER_PORT`, `KIOSK_ORIGIN`, `KIOSK_URL`, `EDGE_IDENTITY_URL`, `DEFAULT_API_URL`, `EXIT_PIN`, `CLOUD_CHECK_S`, `WATCH_S`, `RELAUNCH_DELAY_S`, `WAIT_POLL_MS`, `SYSTEM_CACHE_S`, `PROBE_TIMEOUT_S`, `CHROME_STOP_S`, `MAX_BODY`;
  - functions `log`, `config_value`, `lock_desktop`, `restore_desktop`, `system_info`, `wifi_networks`, `wired_status`, `valid_ssid`, `valid_password`, `join_wifi`, `ensure_start_icon`.
- Produces:
  - `url_answers(url, timeout=PROBE_TIMEOUT_S) -> bool`.
  - `Session(token, api_url)`, with:
    - fields `.token`, `.api_url`, `.exit` (`threading.Event`), `.cloud_ok`, `.edge_ok`, `.last_attempt_ms`, `.chrome`, `.waiting_url`;
    - property `.ready`;
    - methods `.system()`, `.forget_system()`, `.check_once()`, `.check_loop()`.
  - `HelperServer(session, port=None)`, with `.server_port`, `.host_header`, `.origin`.
  - `waiting_page(token) -> str`.
  - `CHROME_FLAGS`.
  - `profile_dir(browser) -> Path`.
  - `launch_chrome(browser, url) -> Popen`.
  - `close_chrome(proc)`.
  - `watch(session, browser, launch=launch_chrome)`.
  - `run(browser) -> int`.
  - CLI `run --browser PATH`.
  - The HTTP contract in the plan header, exactly.

- [ ] **Step 1: Failing tests.** Append to `kiosk_laptop/installer/tests/test_kiosk_session.py`:

```python
# ── Task 3: helper server, waiting page, cloud check, watcher ─────────
import http.client
import socket
import threading

KIOSK = "http://localhost:8090"
TOKEN = "t" * 43
SYS = {"battery": None, "wifi": None, "wired": None, "network": "none"}


@pytest.fixture
def helper(ks, monkeypatch):
    monkeypatch.setattr(ks, "system_info", lambda: dict(SYS))
    session = ks.Session(TOKEN, "http://cloud.test")
    server = ks.HelperServer(session, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield session, server.server_port
    server.shutdown()
    server.server_close()


def call(port, method, path, *, host=None, origin=None, token=None, body=None, ctype="application/json"):
    headers = {"Host": host or f"127.0.0.1:{port}"}
    if origin:
        headers["Origin"] = origin
    if token:
        headers["X-Kiosk-Token"] = token
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers["Content-Type"] = ctype
        headers["Content-Length"] = str(len(data))
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, body=data, headers=headers)
    r = conn.getresponse()
    raw = r.read()
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    conn.close()
    return r.status, hdrs, raw


def test_wrong_host_is_400(helper):
    _, port = helper
    for path in ("/waiting", "/v1/system"):
        assert call(port, "GET", path, host=f"evil.test:{port}", token=TOKEN)[0] == 400
        assert call(port, "GET", path, host=f"localhost:{port}", token=TOKEN)[0] == 400


def test_v1_needs_the_token_and_a_known_origin(helper):
    _, port = helper
    assert call(port, "GET", "/v1/system", origin=KIOSK)[0] == 403
    assert call(port, "GET", "/v1/system", origin=KIOSK, token="x" * 43)[0] == 403
    assert call(port, "GET", "/v1/system", origin="http://evil.test", token=TOKEN)[0] == 403
    assert call(port, "GET", "/v1/system", origin="http://10.10.48.57:8090", token=TOKEN)[0] == 403
    status, hdrs, raw = call(port, "GET", "/v1/system", origin=KIOSK, token=TOKEN)
    assert status == 200 and json.loads(raw) == SYS
    assert hdrs["access-control-allow-origin"] == KIOSK
    status, hdrs, _ = call(port, "GET", "/v1/system", origin=f"http://127.0.0.1:{port}", token=TOKEN)
    assert status == 200 and "access-control-allow-origin" not in hdrs   # same origin: no CORS


def test_preflight_only_for_the_kiosk(helper):
    _, port = helper
    status, hdrs, _ = call(port, "OPTIONS", "/v1/exit", origin=KIOSK)
    assert status == 204
    assert hdrs["access-control-allow-origin"] == KIOSK
    assert "X-Kiosk-Token" in hdrs["access-control-allow-headers"]
    assert hdrs["access-control-allow-private-network"] == "true"
    assert call(port, "OPTIONS", "/v1/exit", origin="http://evil.test")[0] == 403


def test_waiting_page(helper):
    _, port = helper
    status, hdrs, raw = call(port, "GET", "/waiting")
    page = raw.decode()
    assert status == 200 and hdrs["content-type"].startswith("text/html")
    assert "Connecting to ServerSherpa" in page and TOKEN in page and '"http://localhost:8090"' in page
    assert "frame-ancestors 'none'" in hdrs["content-security-policy"] and hdrs["x-frame-options"] == "DENY"
    assert "access-control-allow-origin" not in hdrs
    assert call(port, "GET", "/waiting", origin="http://evil.test")[0] == 403


def test_state_is_ready_once_cloud_and_edge_answer(helper):
    session, port = helper
    out = json.loads(call(port, "GET", "/v1/state", token=TOKEN)[2])
    assert out == {"ready": False, "cloud": False, "last_attempt": None, "system": SYS}
    session.cloud_ok = session.edge_ok = True
    session.last_attempt_ms = 1762851900000
    out = json.loads(call(port, "GET", "/v1/state", token=TOKEN)[2])
    assert out["ready"] is True and out["last_attempt"] == 1762851900000


def test_exit_needs_the_pin(helper):
    session, port = helper
    status, _, raw = call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body={"pin": "CSG"})
    assert status == 403 and json.loads(raw) == {"error": "wrong_pin"} and not session.exit.is_set()
    status, _, raw = call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body={"pin": "csg"})
    # the answer goes out first, then the session is told to exit
    assert status == 200 and json.loads(raw) == {"ok": True} and session.exit.wait(2)


def test_post_body_rules(helper):
    session, port = helper
    assert call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body=b"pin=csg", ctype="text/plain")[0] == 400
    assert call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body=b"[1]")[0] == 400
    assert call(port, "POST", "/v1/exit", origin=KIOSK, token=TOKEN, body={"pin": "x" * 5000})[0] == 400
    assert not session.exit.is_set()


def test_join_maps_codes_and_never_logs_the_password(helper, ks, monkeypatch):
    _, port = helper
    codes = iter(["wrong_password", "ok"])
    monkeypatch.setattr(ks, "join_wifi", lambda ssid, password: next(codes))
    body = {"ssid": "CSG-Ops", "password": "hunter2-secret"}
    status, _, raw = call(port, "POST", "/v1/wifi/join", origin=KIOSK, token=TOKEN, body=body)
    assert status == 422 and json.loads(raw) == {"error": "wrong_password"}
    status, _, raw = call(port, "POST", "/v1/wifi/join", origin=KIOSK, token=TOKEN, body=body)
    assert status == 200 and json.loads(raw) == {"ok": True}
    assert call(port, "POST", "/v1/wifi/join", origin=KIOSK, token=TOKEN, body={"ssid": "", "password": ""})[0] == 400
    log = ks.state_dir() / "session.log"
    assert "hunter2" not in log.read_text() and TOKEN not in log.read_text()


def test_check_once_tries_the_cloud_until_it_answers_then_only_the_edge(ks, monkeypatch):
    answers = {"http://cloud.test/system/status": [False, True], ks.EDGE_IDENTITY_URL: [True, True, True]}
    seen = []
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: (seen.append(url), answers[url].pop(0))[1])
    s = ks.Session(TOKEN, "http://cloud.test")
    s.check_once()
    assert not s.ready and s.last_attempt_ms is not None
    s.check_once()
    assert s.ready
    s.check_once()
    assert seen.count("http://cloud.test/system/status") == 2 and seen.count(ks.EDGE_IDENTITY_URL) == 3


class FakeProc:
    def __init__(self, life):
        self.life, self.returncode, self.pid = life, None, 999999

    def poll(self):
        if self.life <= 0:
            self.returncode = 0
            return 0
        self.life -= 1
        return None


def test_watch_reopens_chrome_until_exit(ks, monkeypatch):
    monkeypatch.setattr(ks, "WATCH_S", 0.01)
    monkeypatch.setattr(ks, "RELAUNCH_DELAY_S", 0.01)
    closed = []
    monkeypatch.setattr(ks, "close_chrome", lambda p: closed.append(p))
    s = ks.Session(TOKEN, "http://cloud.test")
    s.waiting_url = "http://127.0.0.1:8092/waiting"
    launched = []

    def launch(browser, url):
        launched.append((browser, url))
        if len(launched) == 3:
            s.exit.set()
        return FakeProc(2)
    ks.watch(s, "/usr/bin/google-chrome", launch=launch)
    assert launched == [("/usr/bin/google-chrome", "http://127.0.0.1:8092/waiting")] * 3
    assert closed == [s.chrome]


def test_launch_chrome_flags_and_profile(ks, monkeypatch, tmp_path):
    got = {}
    monkeypatch.setattr(ks.subprocess, "Popen", lambda args, **kw: got.update(args=args, kw=kw) or "proc")
    assert ks.launch_chrome("/usr/bin/google-chrome", "http://127.0.0.1:8092/waiting") == "proc"
    profile = tmp_path / "home" / ".local" / "share" / "serversherpa-kiosk" / "chrome"
    assert got["args"] == ["/usr/bin/google-chrome", *ks.CHROME_FLAGS, f"--user-data-dir={profile}",
                           "http://127.0.0.1:8092/waiting"]
    assert "--kiosk" in ks.CHROME_FLAGS and got["kw"]["start_new_session"] is True
    assert profile.is_dir()
    assert ks.profile_dir("/snap/bin/chromium") == tmp_path / "home" / "snap" / "chromium" / "common" / "serversherpa-kiosk"


def test_run_order_lock_watch_close_restore(ks, monkeypatch):
    events = []
    monkeypatch.setattr(ks, "HELPER_PORT", 0)
    monkeypatch.setattr(ks.signal, "signal", lambda *a: None)
    monkeypatch.setattr(ks, "url_answers", lambda url, timeout=5: False)
    monkeypatch.setattr(ks, "ensure_start_icon", lambda: events.append("icon"))
    monkeypatch.setattr(ks, "lock_desktop", lambda: events.append("lock") or 1)
    monkeypatch.setattr(ks, "restore_desktop", lambda: events.append("restore") or True)
    monkeypatch.setattr(ks, "close_chrome", lambda p: events.append("close"))

    def fake_watch(session, browser):
        events.append("watch")
        assert session.waiting_url.endswith("/waiting")
        session.exit.set()
    monkeypatch.setattr(ks, "watch", fake_watch)
    assert ks.run("/usr/bin/google-chrome") == 0
    assert events == ["icon", "lock", "watch", "close", "restore"]


def test_a_second_session_exits_quietly_when_the_port_is_taken(ks, monkeypatch):
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    try:
        monkeypatch.setattr(ks, "HELPER_PORT", blocker.getsockname()[1])
        monkeypatch.setattr(ks, "lock_desktop", lambda: pytest.fail("a second session must not lock"))
        assert ks.run("/usr/bin/google-chrome") == 0
    finally:
        blocker.close()
```

- [ ] **Step 2: Run the tests and watch them fail.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_kiosk_session.py -k "host or token or preflight or waiting or state or exit or body or join_maps or check_once or watch or launch_chrome or run_order or second"` fails: `Session` doesn't exist.

- [ ] **Step 3: Implement.** In `kiosk_session.py`, insert the following directly above `# ── Command line ──`:

```python
# ── Cloud and edge checks ─────────────────────────────────────────────
def url_answers(url: str, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """True when URL answers 2xx (a 4xx/5xx, a timeout or no network is False)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ServerSherpaKiosk"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


class Session:
    """What the helper, the check loop and the watcher share."""

    def __init__(self, token: str, api_url: str):
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.exit = threading.Event()
        self.cloud_ok = False          # the cloud answered once this session
        self.edge_ok = False           # the edge answered at the last check
        self.last_attempt_ms: int | None = None
        self.chrome: subprocess.Popen | None = None
        self.waiting_url = ""
        self._cloud_failing = False
        self._lock = threading.Lock()
        self._system: tuple[float, dict] | None = None

    @property
    def ready(self) -> bool:
        return self.cloud_ok and self.edge_ok

    def system(self) -> dict:
        with self._lock:
            now = time.monotonic()
            if self._system and now - self._system[0] < SYSTEM_CACHE_S:
                return self._system[1]
            info = system_info()
            self._system = (now, info)
            return info

    def forget_system(self) -> None:
        with self._lock:
            self._system = None

    def check_once(self) -> None:
        """The cloud until it has answered once (decided: every 15 s, never
        giving up), then the edge, every time."""
        if not self.cloud_ok:
            self.last_attempt_ms = int(time.time() * 1000)
            self.cloud_ok = url_answers(f"{self.api_url}/system/status")
            if self.cloud_ok:
                log("the cloud answered")
            elif not self._cloud_failing:
                log(f"the cloud doesn't answer yet ({self.api_url}); trying every {CLOUD_CHECK_S} s")
            self._cloud_failing = not self.cloud_ok
        self.edge_ok = url_answers(EDGE_IDENTITY_URL)

    def check_loop(self) -> None:
        while not self.exit.is_set():
            self.check_once()
            self.exit.wait(CLOUD_CHECK_S)


# ── Helper HTTP server ────────────────────────────────────────────────
CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


class Handler(BaseHTTPRequestHandler):
    server_version = "ServerSherpaKiosk"
    sys_version = ""

    def log_message(self, format, *args):  # noqa: A002 (the base class's name)
        """Request lines never reach a log."""

    @property
    def session(self) -> Session:
        return self.server.session

    def _send(self, status: int, body: bytes, ctype: str, extra=()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.headers.get("Origin") == KIOSK_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", KIOSK_ORIGIN)
            self.send_header("Vary", "Origin")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _path(self) -> str:
        return self.path.split("?", 1)[0]

    def _gate(self) -> bool:
        """Host (no DNS rebinding), Origin (only the kiosk and this page) and,
        for /v1/*, the session token."""
        if self.headers.get("Host") != self.server.host_header:
            self._send(400, b"Invalid host header", "text/plain; charset=utf-8")
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in (KIOSK_ORIGIN, self.server.origin):
            self._json(403, {"error": "forbidden"})
            return False
        if self._path().startswith("/v1/"):
            given = self.headers.get("X-Kiosk-Token", "").encode("utf-8", "replace")
            if not hmac.compare_digest(given, self.session.token.encode()):
                self._json(403, {"error": "forbidden"})
                return False
        return True

    def _body(self) -> dict | None:
        if self.headers.get_content_type() != "application/json":
            return None
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if not 0 < n <= MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def do_OPTIONS(self):  # noqa: N802
        if (self.headers.get("Host") != self.server.host_header
                or self.headers.get("Origin") != KIOSK_ORIGIN or not self._path().startswith("/v1/")):
            self._send(403, b"", "text/plain; charset=utf-8")
            return
        self._send(204, b"", "text/plain; charset=utf-8", (
            ("Access-Control-Allow-Methods", "GET, POST"),
            ("Access-Control-Allow-Headers", "Content-Type, X-Kiosk-Token"),
            ("Access-Control-Allow-Private-Network", "true"),
            ("Access-Control-Max-Age", "600"),
        ))

    def do_GET(self):  # noqa: N802
        if not self._gate():
            return
        path = self._path()
        s = self.session
        if path == "/waiting":
            self._send(200, waiting_page(s.token).encode(), "text/html; charset=utf-8",
                       (("Content-Security-Policy", CSP), ("X-Frame-Options", "DENY")))
        elif path == "/v1/state":
            self._json(200, {"ready": s.ready, "cloud": s.cloud_ok, "last_attempt": s.last_attempt_ms,
                             "system": s.system()})
        elif path == "/v1/system":
            self._json(200, s.system())
        elif path == "/v1/wifi":
            self._json(200, {"networks": wifi_networks(rescan=True), "wired": wired_status()})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if not self._gate():
            return
        path = self._path()
        body = self._body()
        if body is None:
            self._json(400, {"error": "bad_request"})
            return
        if path == "/v1/exit":
            pin = body.get("pin")
            if not isinstance(pin, str) or not hmac.compare_digest(pin.encode(), EXIT_PIN.encode()):
                log("exit: wrong PIN")
                self._json(403, {"error": "wrong_pin"})
                return
            self._json(200, {"ok": True})
            log("exit: PIN accepted")
            self.session.exit.set()
        elif path == "/v1/wifi/join":
            ssid, password = body.get("ssid"), body.get("password", "")
            if not valid_ssid(ssid) or not valid_password(password):
                self._json(400, {"error": "bad_request"})
                return
            code = join_wifi(ssid, password)
            log(f"join Wi-Fi {ssid!r}: {code}")
            self.session.forget_system()
            if code == "ok":
                self._json(200, {"ok": True})
            else:
                self._json(422, {"error": code})
        else:
            self._json(404, {"error": "not_found"})


class HelperServer(ThreadingHTTPServer):
    """127.0.0.1 only. The bind is also the single-instance lock: a second
    session finds the port taken."""
    daemon_threads = True

    def __init__(self, session: Session, port: int | None = None):
        super().__init__((HELPER_HOST, HELPER_PORT if port is None else port), Handler)
        self.session = session
        self.host_header = f"{HELPER_HOST}:{self.server_port}"
        self.origin = f"http://{self.host_header}"


# ── Waiting page ──────────────────────────────────────────────────────
# Served by the helper, not the container (which may be down while the cloud
# is too) and not a file:// page (origin null). House tokens, light/dark from
# the system, no scrollbars. Esc opens the same PIN pad as the kiosk.
WAITING_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connecting to ServerSherpa</title>
<style>
:root { color-scheme: light dark;
  --ink: #0c1117; --paper: #fbfcfd; --paper-2: #f1f4f7; --paper-line: #e4e8ee;
  --text-dark: #1b2129; --text-mute: #667085; --surface: #fff; --accent: #ffa12e; --c-red: #c03540;
  --font-display: 'Geologica', system-ui, sans-serif; --font-mono: 'Fragment Mono', ui-monospace, monospace; }
@media (prefers-color-scheme: dark) { :root {
  --paper: #10151f; --paper-2: #0b0f17; --paper-line: rgba(255, 255, 255, 0.09);
  --text-dark: #e8edf4; --text-mute: #8a97aa; --surface: #161d2a; --c-red: #ff5d6c; } }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--paper-2);
  color: var(--text-dark); font-family: var(--font-display); }
main { height: 100%; display: grid; place-items: center; text-align: center; }
.mark { font-weight: 600; font-size: 22px; letter-spacing: .01em; }
.mark em { font-style: normal; color: var(--accent); }
h1 { font-size: 28px; font-weight: 600; margin: 18px 0 12px; }
.facts { font-family: var(--font-mono); font-size: 14px; color: var(--text-mute); line-height: 1.9; }
.scrim { position: fixed; inset: 0; display: none; place-items: center; padding: 24px;
  background: rgba(5, 8, 12, 0.55); backdrop-filter: blur(4px); }
.scrim.open { display: grid; }
.card { width: min(420px, 96vw); background: var(--surface); color: var(--text-dark);
  border: 1px solid var(--paper-line); border-radius: 16px; overflow: hidden; text-align: left;
  box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.6); }
.head { padding: 18px 20px 12px; border-bottom: 1px solid var(--paper-line); }
.eyebrow, label { font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--text-mute); }
.head h3 { margin: 4px 0; font-size: 18px; }
.hint { margin: 0; font-size: 13px; color: var(--text-mute); }
.body { padding: 16px 20px; }
label { display: block; margin-bottom: 6px; }
input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--paper-line);
  border-radius: 10px; background: var(--paper); color: var(--text-dark); font: inherit; }
.err { color: var(--c-red); font-size: 13px; margin: 8px 0 0; min-height: 1em; }
.foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px;
  border-top: 1px solid var(--paper-line); }
button { font: inherit; font-size: 13px; border-radius: 999px; padding: 8px 16px; cursor: pointer; }
.ghost { background: transparent; color: var(--text-dark); border: 1px solid var(--paper-line); }
.solid { background: var(--accent); color: var(--ink); border: 1px solid var(--accent); font-weight: 600; }
</style>
</head>
<body>
<main>
  <div>
    <div class="mark">Server<em>Sherpa</em></div>
    <h1>Connecting to ServerSherpa…</h1>
    <div class="facts">
      <div>Last attempt <span id="last">—</span></div>
      <div>Network: <span id="net">…</span></div>
    </div>
  </div>
</main>
<div class="scrim" id="pin-scrim">
  <form class="card" id="pin-form" role="dialog" aria-modal="true" aria-label="Exit the kiosk">
    <div class="head">
      <div class="eyebrow">This laptop</div>
      <h3>Exit the kiosk</h3>
      <p class="hint">Enter the PIN to close the kiosk and go to the desktop. Start Kiosk on the desktop opens it again.</p>
    </div>
    <div class="body">
      <label for="pin">PIN</label>
      <input id="pin" type="password" autocomplete="new-password" spellcheck="false" maxlength="32">
      <p class="err" id="pin-err" role="alert"></p>
      <p class="hint" id="pin-msg" role="status"></p>
    </div>
    <div class="foot">
      <button type="button" class="ghost" id="pin-cancel">Cancel</button>
      <button type="submit" class="solid" id="pin-ok">Exit kiosk</button>
    </div>
  </form>
</div>
<script>
const TOKEN = __TOKEN__;
const KIOSK = __KIOSK_URL__;
const POLL_MS = __POLL_MS__;
const $ = (id) => document.getElementById(id);
const two = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
function networkText(s) {
  if (s && s.network === 'wifi' && s.wifi) return 'Wi-Fi: ' + s.wifi.ssid;
  if (s && s.network === 'wired') return 'Wired network';
  return 'No network';
}
const pinOpen = () => $('pin-scrim').classList.contains('open');
async function poll() {
  try {
    const r = await fetch('/v1/state', { headers: { 'X-Kiosk-Token': TOKEN }, cache: 'no-store' });
    if (r.ok) {
      const st = await r.json();
      $('last').textContent = st.last_attempt ? hhmm(st.last_attempt) : '—';
      $('net').textContent = networkText(st.system);
      if (st.ready && !pinOpen()) { location.replace(KIOSK + '/#kh=' + TOKEN); return; }
    }
  } catch (e) { /* this page's own server; try again */ }
  setTimeout(poll, POLL_MS);
}
function openPin() { $('pin-scrim').classList.add('open'); $('pin').value = ''; $('pin-err').textContent = ''; $('pin').focus(); }
function closePin() { $('pin-scrim').classList.remove('open'); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat) return;
  if (pinOpen()) closePin(); else openPin();
});
$('pin-cancel').addEventListener('click', closePin);
$('pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('pin').value;
  if (!pin) return;
  $('pin-ok').disabled = true;
  try {
    const r = await fetch('/v1/exit', { method: 'POST', body: JSON.stringify({ pin }),
      headers: { 'Content-Type': 'application/json', 'X-Kiosk-Token': TOKEN } });
    if (r.ok) { $('pin-err').textContent = ''; $('pin-msg').textContent = 'Closing the kiosk…'; return; }
    $('pin-err').textContent = r.status === 403 ? "That PIN isn't right." : "Couldn't exit. Try again.";
  } catch (e2) { $('pin-err').textContent = "Couldn't exit. Try again."; }
  $('pin').value = '';
  $('pin-ok').disabled = false;
});
poll();
</script>
</body>
</html>
"""


def waiting_page(token: str) -> str:
    return (WAITING_HTML.replace("__TOKEN__", json.dumps(token))
            .replace("__KIOSK_URL__", json.dumps(KIOSK_URL))
            .replace("__POLL_MS__", str(WAIT_POLL_MS)))


# ── Chrome and the watcher ────────────────────────────────────────────
CHROME_FLAGS = ("--kiosk", "--no-first-run", "--no-default-browser-check", "--noerrdialogs",
                "--password-store=basic", "--hide-crash-restore-bubble")


def profile_dir(browser: str) -> Path:
    """The kiosk's own Chrome profile. Without its own, a Chrome already open
    on the desktop would take the launch and exit at once. Snap Chromium
    can't reach hidden folders, so it gets its snap's own folder."""
    real = os.path.realpath(browser)
    snap = (browser.startswith("/snap/") or real.startswith("/snap/") or real.endswith("/usr/bin/snap")
            or (Path(browser).name == "chromium-browser" and Path("/snap/bin/chromium").exists()))
    if snap:
        return Path.home() / "snap" / "chromium" / "common" / "serversherpa-kiosk"
    return Path.home() / ".local" / "share" / "serversherpa-kiosk" / "chrome"


def launch_chrome(browser: str, url: str) -> subprocess.Popen:
    profile = profile_dir(browser)
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([browser, *CHROME_FLAGS, f"--user-data-dir={profile}", url],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)


def close_chrome(proc: subprocess.Popen | None) -> None:
    """SIGTERM to Chrome's process group, SIGKILL after CHROME_STOP_S."""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=CHROME_STOP_S)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=CHROME_STOP_S)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass


def watch(session: Session, browser: str, launch=launch_chrome) -> None:
    """Chrome on the waiting page (which goes on to the kiosk once ready),
    reopened whenever it closes, until the session is told to exit. Then the
    watcher stops and Chrome is closed."""
    while not session.exit.is_set():
        proc = launch(browser, session.waiting_url)
        session.chrome = proc
        while proc.poll() is None:
            if session.exit.wait(WATCH_S):
                break
        if session.exit.is_set():
            break
        log(f"Chrome closed (exit {proc.returncode}); opening it again")
        session.exit.wait(RELAUNCH_DELAY_S)
    close_chrome(session.chrome)


def run(browser: str) -> int:
    """The session. Exit order (decided): the watcher stops, Chrome closes,
    then the desktop shortcuts come back. A signal (sign-out, power-off,
    uninstall) takes the same way out."""
    session = Session(secrets.token_urlsafe(32), config_value("EDGE_CLOUD_API_URL") or DEFAULT_API_URL)
    try:
        server = HelperServer(session)
    except OSError:
        log("another kiosk session is running; nothing to do")
        return 0
    session.waiting_url = f"{server.origin}/waiting"

    def stop(signum, frame):
        session.exit.set()
    for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(s, stop)
    threading.Thread(target=server.serve_forever, name="helper", daemon=True).start()
    log(f"kiosk session started (browser {browser})")
    try:
        ensure_start_icon()
        lock_desktop()
        threading.Thread(target=session.check_loop, name="cloud-check", daemon=True).start()
        watch(session, browser)
    finally:
        session.exit.set()
        close_chrome(session.chrome)
        restore_desktop()
        server.shutdown()
        server.server_close()
        log("kiosk session ended")
    return 0
```

  Then replace `main` with:

```python
def main(argv: list[str]) -> int:
    if argv[:1] == ["run"] and len(argv) == 3 and argv[1] == "--browser" and argv[2]:
        return run(argv[2])
    if argv[:1] == ["restore"] and argv[1:] in ([], ["--cleanup"]):
        ok = restore_desktop()
        if ok and argv[1:] == ["--cleanup"]:
            cleanup_restore_entry()
        return 0 if ok else 1
    print(__doc__, file=sys.stderr)
    return 2
```

- [ ] **Step 4: Run the tests again.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_kiosk_session.py` passes, Task 2's tests included.

- [ ] **Step 5: Smoke test by hand, without GNOME** (on any machine with Python ≥3.10):
  1. Run `KIOSK_DIR=/tmp HOME=$(mktemp -d) python3 kiosk_laptop/installer/kiosk_session.py run --browser /usr/bin/true` in a terminal.
  2. In another terminal, check `curl -s -H 'Host: 127.0.0.1:8092' http://127.0.0.1:8092/waiting | head -5`. The HTML comes back.
  3. Check `curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil:8092' http://127.0.0.1:8092/waiting`. It prints `400`.
  4. Press Ctrl+C. The process exits 0, and `session.log` says "kiosk session ended". Chrome being `/usr/bin/true` shows the watcher reopening it every 2 s in the log.

- [ ] **Step 6: Commit.**

```bash
git add kiosk_laptop/installer/kiosk_session.py kiosk_laptop/installer/tests/test_kiosk_session.py
git commit -m "feat(kiosk-laptop): kiosk session helper server, waiting page, cloud check and Chrome watcher"
```

---

### Task 4: Install, launch and refresh (`launch.sh`, `install.sh`, `update.sh`, README)

**Files:**
- Modify: `kiosk_laptop/installer/launch.sh`
- Modify: `kiosk_laptop/installer/install.sh` (login items, Start Kiosk icon, python3, uninstall)
- Modify: `kiosk_laptop/installer/update.sh` (`refresh_helper`, `refresh_helpers`, header comment)
- Modify: `kiosk_laptop/README.md`
- Test: `kiosk_laptop/installer/tests/test_update_sh.py`, `kiosk_laptop/installer/tests/test_install_sh.py`

**Interfaces:**
- Consumes:
  - from Task 2/3: the file `kiosk_laptop/installer/kiosk_session.py`; its CLI `run --browser PATH` and `restore [--cleanup]`; `start_icon_text(launch)`; the lock file `~/.local/state/serversherpa-kiosk/desktop-lock.json`; the autostart name `serversherpa-kiosk-restore.desktop`.
  - existing `install.sh` functions: `exec_path`, `as_user`, `write_as_user`, `user_home`, `desktop_user`, `fetch_companion`, `install_login_items`, `install_login_items_linux`, `remove_login_items`, `uninstall`, `info`, `warn`.
  - existing `update.sh` functions: `refresh_helper`, `refresh_helpers`, `python_bin`.
  - existing `launch.sh` functions: `browser`, `find_browser`, `wait_for_kiosk`, `open_kiosk`.
- Produces:
  - `launch.sh`: `have_python3`, `session_ready`, `run_session BROWSER`, `restore_session_desktop`; `main` hands off on Linux.
  - `install.sh`: `SESSION_PY`, `START_ICON_FILE`, `RESTORE_AUTOSTART`, `SESSION_STOP_WAIT_S`, `have_python3`, `ensure_python3`, `render_start_icon FILE`, `user_desktop_dir USER HOME`, `install_start_icon USER HOME`, `render_restore_entry PY`, `session_restore USER UID`, `restore_desktop_lock USER HOME`.
  - `update.sh`: `helper_shebang NAME`, `helper_syntax_ok NAME FILE`; `kiosk_session.py` refreshed on Linux.

- [ ] **Step 1: Failing tests.** Append to `kiosk_laptop/installer/tests/test_update_sh.py`:

```python
# ── kiosk lockdown: launch.sh hands off to kiosk_session.py on Linux ──
def test_launch_hands_off_to_the_session_on_linux(tmp_path):
    (tmp_path / "kiosk_session.py").write_text("#!/usr/bin/env python3\n")
    calls = tmp_path / "calls"
    body = (f'have_python3() {{ :; }}; run_session() {{ echo "session $*" >> "{calls}"; }}; '
            f'run_browser() {{ echo "app $*" >> "{calls}"; }}; kiosk_answers() {{ :; }}; OS=Linux; main')
    _launch(tmp_path, body)
    assert calls.read_text().splitlines() == ["session /usr/bin/google-chrome"]


def test_launch_without_the_session_file_keeps_the_app_window(tmp_path):
    calls = tmp_path / "calls"
    body = (f'have_python3() {{ :; }}; run_session() {{ echo "session $*" >> "{calls}"; }}; '
            f'run_browser() {{ echo "app $*" >> "{calls}"; }}; kiosk_answers() {{ :; }}; OS=Linux; main')
    _launch(tmp_path, body)
    assert calls.read_text().splitlines() == ["app /usr/bin/google-chrome --app=http://localhost:8090"]


def test_launch_never_hands_off_on_macos(tmp_path):
    (tmp_path / "kiosk_session.py").write_text("#!/usr/bin/env python3\n")
    calls = tmp_path / "calls"
    body = (f'have_python3() {{ :; }}; run_session() {{ echo "session $*" >> "{calls}"; }}; '
            f'kiosk_answers() {{ :; }}; open() {{ echo "open $*" >> "{calls}"; }}; OS=Darwin; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=/Applications/Google Chrome.app\n")
    assert calls.read_text().splitlines() == ["open -na /Applications/Google Chrome.app --args --app=http://localhost:8090"]


def test_launch_without_a_browser_restores_the_desktop_then_opens_the_default(tmp_path):
    (tmp_path / "kiosk_session.py").write_text("#!/usr/bin/env python3\n")
    calls = tmp_path / "calls"
    body = (f'have_python3() {{ :; }}; find_browser() {{ :; }}; kiosk_answers() {{ :; }}; '
            f'restore_session_desktop() {{ echo restore >> "{calls}"; }}; '
            f'xdg-open() {{ echo "xdg $*" >> "{calls}"; }}; OS=Linux; main')
    _launch(tmp_path, body, config="KIOSK_BROWSER=\n")
    assert calls.read_text().splitlines() == ["restore", "xdg http://localhost:8090"]


# ── kiosk lockdown: update.sh refreshes kiosk_session.py on Linux ─────
GOOD_PY = "#!/usr/bin/env python3\nprint('new session')\n"


def test_session_py_is_refreshed_on_linux(tmp_path):
    r, k = _helpers(tmp_path, {"hostnet.sh": NEW_HOSTNET, "launch.sh": NEW_HOSTNET},
                    {"hostnet.sh": NEW_HOSTNET, "launch.sh": NEW_HOSTNET, "kiosk_session.py": GOOD_PY},
                    body='OS=Linux; refresh_helpers; echo rc=$?')
    assert "rc=0" in r.stdout and "kiosk_session.py: refreshed" in r.stdout
    assert (k / "kiosk_session.py").read_text() == GOOD_PY
    assert oct((k / "kiosk_session.py").stat().st_mode & 0o777) == "0o755"


def test_session_py_is_never_refreshed_on_macos(tmp_path):
    r, k = _helpers(tmp_path, {"hostnet.sh": NEW_HOSTNET, "launch.sh": NEW_HOSTNET},
                    {"hostnet.sh": NEW_HOSTNET, "launch.sh": NEW_HOSTNET, "kiosk_session.py": GOOD_PY},
                    body='OS=Darwin; refresh_helpers; echo rc=$?')
    assert "rc=0" in r.stdout and "kiosk_session.py" not in r.stdout
    assert not (k / "kiosk_session.py").exists()


@pytest.mark.parametrize("bad,why", [
    ("#!/usr/bin/env bash\necho hi\n", "no python3 shebang"),
    ("#!/usr/bin/env python3\ndef broken(:\n", "syntax error"),
])
def test_a_bad_session_py_is_rejected_and_the_old_one_kept(tmp_path, bad, why):
    r, k = _helpers(tmp_path, {"kiosk_session.py": GOOD_PY}, {"kiosk_session.py": bad},
                    body='OS=Linux; refresh_helpers; echo rc=$?')
    assert "rc=0" in r.stdout and f"kiosk_session.py: failed ({why})" in r.stdout
    assert (k / "kiosk_session.py").read_text() == GOOD_PY
```

  Check that `test_update_sh.py` imports `pytest`; add `import pytest` at the top if it doesn't. Then append to `kiosk_laptop/installer/tests/test_install_sh.py`:

```python
# ── kiosk lockdown (Linux) ────────────────────────────────────────────
# A runner with xdg-user-dirs installed would answer for its own HOME.
NO_XDG = 'xdg-user-dir() { return 1; }; '


def _session_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("ks_drift", INSTALL_SH_DIR / "kiosk_session.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("kiosk_dir", ["/opt/serversherpa-kiosk", "/opt/Server Sherpa/50%"])
def test_start_icon_matches_kiosk_session(sh, tmp_path, kiosk_dir):
    f = tmp_path / "icon.desktop"
    sh(f'KIOSK_DIR="{kiosk_dir}"; render_start_icon "{f}"')
    from pathlib import Path
    assert f.read_text() == _session_module().start_icon_text(Path(kiosk_dir) / "launch.sh")


def test_install_login_items_linux_adds_the_session_and_the_start_icon(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    auto = home / ".config" / "autostart"; auto.mkdir(parents=True)
    (auto / "serversherpa-kiosk-restore.desktop").write_text("x")       # left by an earlier uninstall
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    assert (inst / "kiosk_session.py").stat().st_mode & 0o777 == 0o755
    icon = home / "Desktop" / "serversherpa-start-kiosk.desktop"
    assert f"Exec={inst}/launch.sh" in icon.read_text() and "Name=Start Kiosk" in icon.read_text()
    assert icon.stat().st_mode & 0o777 == 0o755
    assert not (auto / "serversherpa-kiosk-restore.desktop").exists()


def test_install_login_items_macos_has_no_session(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + 'OS=Darwin; install_login_items')
    assert not (inst / "kiosk_session.py").exists() and not (home / "Desktop").exists()


def test_ensure_python3_installs_it_when_missing(sh, tmp_path):
    calls = tmp_path / "calls"
    sh(f'have_python3() {{ return 1; }}; apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; ensure_python3')
    assert "install -y python3" in calls.read_text()
    calls.unlink()
    sh(f'have_python3() {{ :; }}; apt-get() {{ echo "apt-get $*" >> "{calls}"; }}; ensure_python3')
    assert not calls.exists()


def _locked(home):
    state = home / ".local" / "state" / "serversherpa-kiosk"; state.mkdir(parents=True)
    (state / "desktop-lock.json").write_text('{"version": 1, "saved": []}')
    return state


def test_remove_login_items_linux_restores_in_the_users_session(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    restore = (f'pkill() {{ echo "pkill $*" >> "{calls}"; }}; SESSION_STOP_WAIT_S=0; '
               f'session_restore() {{ echo "restore $*" >> "{calls}"; rm -f "{state}/desktop-lock.json"; }}; ')
    sh(stubs + NO_XDG + restore + 'OS=Linux; remove_login_items')
    log = calls.read_text()
    assert f"pkill -TERM -u alice -f {inst}/kiosk_session.py" in log and "restore alice 501" in log
    assert not (home / "Desktop" / "serversherpa-start-kiosk.desktop").exists()
    assert not (home / ".config/autostart/serversherpa-kiosk-restore.desktop").exists()


def test_remove_login_items_linux_leaves_a_one_shot_restore_when_signed_out(sh, tmp_path):
    inst, home, calls, stubs = _login_env(tmp_path)
    sh(stubs + NO_XDG + 'OS=Linux; have_python3() { :; }; install_login_items')
    state = _locked(home)
    sh(stubs + NO_XDG + 'pkill() { :; }; SESSION_STOP_WAIT_S=0; have_python3() { :; }; session_restore() { return 1; }; '
               'OS=Linux; remove_login_items')
    entry = (home / ".config/autostart/serversherpa-kiosk-restore.desktop").read_text()
    assert f"Exec=python3 {state}/kiosk_session.py restore --cleanup" in entry
    assert (state / "kiosk_session.py").read_text() == (inst / "kiosk_session.py").read_text()


def test_uninstall_removes_the_session_file(sh, tmp_path):
    inst = tmp_path / "inst"; inst.mkdir()
    (inst / "kiosk_session.py").write_text("x")
    sh(f'KIOSK_DIR="{inst}"; KIOSK_DATA_DIR="{tmp_path / "data"}"; OS=Linux; '
       'remove_login_items() { :; }; remove_label_printer_files() { :; }; check_rm_target() { :; }; uninstall')
    assert not (inst / "kiosk_session.py").exists()
```

  `INSTALL_SH_DIR` is already defined in `test_install_sh.py` (the label-printer block uses it). If it is defined below this point in the file, move these tests after it.

- [ ] **Step 2: Run the tests and watch them fail.** `python3 -m pytest -q kiosk_laptop/installer/tests/test_update_sh.py kiosk_laptop/installer/tests/test_install_sh.py -k "session or start_icon or python3 or restore or hands_off or app_window"` fails.

- [ ] **Step 3: `launch.sh`.**
  - In the header comment, add after the first paragraph:

```bash
# Linux: when kiosk_session.py is installed next to this script and python3 and
# a browser are there, the kiosk session takes over (kiosk_session.py: the
# waiting page, Chrome in --kiosk mode with a watcher, the desktop lock, the
# Esc → PIN exit). Otherwise, and on macOS always, the kiosk opens in an app
# window as before.
```

  - Replace `main` with:

```bash
have_python3() { command -v python3 >/dev/null 2>&1; }
session_ready() { [ -f "$KIOSK_DIR/kiosk_session.py" ] && have_python3; }
# run_session BROWSER: the Linux kiosk session, in place of this script.
run_session() { exec python3 "$KIOSK_DIR/kiosk_session.py" run --browser "$1"; }
# restore_session_desktop: the session can't start, so a desktop lock an
# earlier session left is put back (never leave the shortcuts off).
restore_session_desktop() { python3 "$KIOSK_DIR/kiosk_session.py" restore >/dev/null 2>&1 || true; }

main() {
  local b
  if [ "$OS" = Linux ] && session_ready; then
    b=$(browser)
    [ -n "$b" ] || b=$(find_browser)
    if [ -n "$b" ]; then
      run_session "$b"
      return $?
    fi
    restore_session_desktop
  fi
  wait_for_kiosk || true
  open_kiosk
}
```

- [ ] **Step 4: `update.sh`.**
  - In the header, change "hostnet.sh and launch.sh are refreshed from the ref…" to "hostnet.sh and launch.sh (and, on Linux, kiosk_session.py) are refreshed from the ref…".
  - Above `refresh_helper`, add:

```bash
# helper_shebang NAME: the first line a published helper must have.
helper_shebang() {
  case "$1" in
    *.py) printf '#!/usr/bin/env python3' ;;
    *) printf '#!/usr/bin/env bash' ;;
  esac
}

# helper_syntax_ok NAME FILE: bash -n for a shell script; for a .py, it must
# parse (python3's ast; no python3 counts as a failure).
helper_syntax_ok() {
  local py
  case "$1" in
    *.py)
      py=$(python_bin) || return 1
      "$py" -c 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$2" >/dev/null 2>&1 ;;
    *) bash -n "$2" 2>/dev/null ;;
  esac
}
```

  - In `refresh_helper`, replace the two checks:

```bash
  if [ "$(head -n 1 "$tmp")" != '#!/usr/bin/env bash' ]; then
    rm -f "$tmp"; log "$name: failed (no bash shebang)"; return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"; log "$name: failed (syntax error)"; return 1
  fi
```

  with:

```bash
  want=$(helper_shebang "$name")
  if [ "$(head -n 1 "$tmp")" != "$want" ]; then
    rm -f "$tmp"; log "$name: failed (no ${want##* } shebang)"; return 1
  fi
  if ! helper_syntax_ok "$name" "$tmp"; then
    rm -f "$tmp"; log "$name: failed (syntax error)"; return 1
  fi
```

    Add `want` to its `local` line: `local name="$1" cur="$KIOSK_DIR/$1" tmp inplace=0 want`.
  - Replace the `refresh_helpers` comment and body:

```bash
# refresh_helpers: hostnet.sh and launch.sh, and on Linux kiosk_session.py
# (never update.sh itself). A refreshed hostnet.sh runs once now, so what it
# reports shows up without waiting for its next run; a refreshed
# kiosk_session.py takes effect at the next sign-in. Nothing here changes the
# updater's exit code.
refresh_helpers() {
  HELPER_REF=$(installer_ref)
  log "Refreshing helper scripts (ref $HELPER_REF)"
  refresh_helper launch.sh || true
  if [ "$OS" = Linux ]; then
    refresh_helper kiosk_session.py || true
  fi
  if refresh_helper hostnet.sh; then
    run_hostnet_limited || true
  fi
  return 0
}
```

- [ ] **Step 5: `install.sh`.**
  - Under the `# ── Login items ──` globals (after `MAC_APP_DIR=`), add:

```bash
# Linux kiosk lockdown (kiosk_session.py): the session, the Start Kiosk icon on
# the desktop, and the one-shot restore an uninstall leaves when the desktop
# user isn't signed in.
SESSION_PY='kiosk_session.py'
START_ICON_FILE='serversherpa-start-kiosk.desktop'
RESTORE_AUTOSTART='serversherpa-kiosk-restore.desktop'
SESSION_STOP_WAIT_S="${SESSION_STOP_WAIT_S:-10}"

have_python3() { command -v python3 >/dev/null 2>&1; }

# ensure_python3 (Linux): the kiosk session runs on python3, which every
# Ubuntu desktop has; installed with apt when it is missing.
ensure_python3() {
  have_python3 && return 0
  if command -v apt-get >/dev/null 2>&1 \
     && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y python3 >/dev/null 2>&1 \
     && have_python3; then
    info "Installed python3 (the kiosk lockdown runs on it)."
  else
    warn "python3 isn't installed, so the kiosk opens in a normal window, without the lockdown."
  fi
  return 0
}

# render_start_icon FILE: Start Kiosk on the desktop. kiosk_session.py's
# start_icon_text writes the same text at every session start
# (tests/test_install_sh.py checks they match).
render_start_icon() {
  cat >"$1" <<EOF
[Desktop Entry]
Type=Application
Name=Start Kiosk
Comment=Open the ServerSherpa kiosk
Exec=$(exec_path "$KIOSK_DIR/launch.sh")
Icon=web-browser
Terminal=false
EOF
}

# user_desktop_dir USER HOME: their desktop folder (xdg-user-dir), else ~/Desktop.
user_desktop_dir() {
  local d
  d=$(as_user "$1" xdg-user-dir DESKTOP 2>/dev/null || true)
  if [ -z "$d" ] || [ "$d" = "$2" ]; then d="$2/Desktop"; fi
  printf '%s' "$d"
}

# install_start_icon USER HOME: written as USER, executable, and trusted so the
# desktop launches it on a double-click (best-effort: gio needs their session;
# the kiosk session marks it again when it starts).
install_start_icon() {
  local user="$1" home="$2" d tmp uid
  d=$(user_desktop_dir "$user" "$home")
  tmp=$(mktemp "${TMPDIR:-/tmp}/kiosk-icon.XXXXXX")
  TMP_FILES+=("$tmp")
  render_start_icon "$tmp"
  if ! { as_user "$user" mkdir -p "$d" && write_as_user "$user" "$tmp" "$d/$START_ICON_FILE" \
         && as_user "$user" chmod 755 "$d/$START_ICON_FILE"; }; then
    warn "Couldn't put the Start Kiosk icon on $user's desktop."
    return 0
  fi
  uid=$(id -u "$user" 2>/dev/null || true)
  if [ -n "$uid" ]; then
    as_user "$user" env "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" \
      gio set "$d/$START_ICON_FILE" metadata::trusted true >/dev/null 2>&1 || true
  fi
  return 0
}

# render_restore_entry PY: the one-shot autostart entry that puts the desktop
# shortcuts back at the next sign-in, then deletes itself and PY.
render_restore_entry() {
  printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=ServerSherpa Kiosk desktop restore' \
    "Exec=python3 $(exec_path "$1") restore --cleanup" 'Terminal=false' 'NoDisplay=true' \
    'X-GNOME-Autostart-enabled=true'
}

# session_restore USER UID: kiosk_session.py restore in USER's desktop session
# (its D-Bus), so gsettings reaches their settings.
session_restore() {
  as_user "$1" env "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$2/bus" \
    python3 "$KIOSK_DIR/$SESSION_PY" restore >/dev/null 2>&1
}

# restore_desktop_lock USER HOME (Linux, uninstall): a running kiosk session is
# stopped (SIGTERM: it closes Chrome and puts the GNOME shortcuts back). If they
# are still off, restore runs in the user's session; when they aren't signed
# in, a copy of kiosk_session.py and a one-shot autostart entry do it at their
# next sign-in. Never fails the uninstall.
restore_desktop_lock() {
  local user="$1" home="$2" state lock uid i=0 auto
  state="$home/.local/state/serversherpa-kiosk"
  lock="$state/desktop-lock.json"
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -u "$user" -f "$KIOSK_DIR/$SESSION_PY" >/dev/null 2>&1 || true
  fi
  while [ -f "$lock" ] && [ "$i" -lt "$SESSION_STOP_WAIT_S" ]; do sleep 1; i=$((i + 1)); done
  [ -f "$lock" ] || return 0
  uid=$(id -u "$user" 2>/dev/null || true)
  if [ -n "$uid" ] && [ -f "$KIOSK_DIR/$SESSION_PY" ] && have_python3 \
     && session_restore "$user" "$uid" && [ ! -f "$lock" ]; then
    info "Put $user's desktop shortcuts back."
    return 0
  fi
  [ -f "$KIOSK_DIR/$SESSION_PY" ] || { warn "Couldn't put $user's desktop shortcuts back ($SESSION_PY is missing)."; return 0; }
  auto="$home/.config/autostart/$RESTORE_AUTOSTART"
  if as_user "$user" mkdir -p "$state" "$home/.config/autostart" \
     && write_as_user "$user" "$KIOSK_DIR/$SESSION_PY" "$state/$SESSION_PY" \
     && render_restore_entry "$state/$SESSION_PY" | as_user "$user" tee "$auto" >/dev/null; then
    info "$user's desktop shortcuts come back at their next sign-in."
  else
    warn "Couldn't put $user's desktop shortcuts back. While signed in as $user: python3 $KIOSK_DIR/$SESSION_PY restore"
  fi
  return 0
}
```

  - In `install_login_items`, replace the loop header so Linux also copies the session:

```bash
install_login_items() {
  local f files='update.sh launch.sh hostnet.sh'
  [ "$OS" = Darwin ] || files="$files $SESSION_PY"
  for f in $files; do
    fetch_companion "$f" "$KIOSK_DIR/$f"
    chmod 755 "$KIOSK_DIR/$f"
  done
  if [ "$OS" = Darwin ]; then install_login_items_macos; else install_login_items_linux; fi
}
```

    Also update its comment: `# install_login_items: copy update.sh/launch.sh/hostnet.sh (and on Linux kiosk_session.py) in, then schedule them.`
  - In `install_login_items_linux`:
    - Add `ensure_python3` as the first line after `local …`.
    - After the autostart `for d in …; done` loop, add:

```bash
  install_start_icon "$user" "$home"
  # The kiosk is back: its own session restores; an uninstall's one-shot
  # restore must not race it.
  rm -f "$home/.config/autostart/$RESTORE_AUTOSTART"
```

    - After the existing `info "The kiosk opens when $user signs in…"` line, add:

```bash
  info "Esc then the PIN csg closes the kiosk; Start Kiosk on the desktop opens it again."
```

  - In `remove_login_items`, Linux branch: inside `if [ -n "$user" ]; then`, after `home=$(user_home "$user")`, add:

```bash
      restore_desktop_lock "$user" "$home"
      rm -f "$(user_desktop_dir "$user" "$home")/$START_ICON_FILE"
```

    Keep the existing `rm -f …autostart/$DESKTOP_FILE…` line after these.
  - In `uninstall`, add `"$SESSION_PY"` to the file loop:

```bash
  for f in docker-compose.yml config.env update.sh launch.sh hostnet.sh "$SESSION_PY" install-state.json update-state.json; do
```

- [ ] **Step 6: README.**
  - In `kiosk_laptop/README.md`, in **Updates**, change the helper-refresh bullet's first sentence to: "The nightly update also refreshes the helper scripts (`hostnet` and `launch`, `.sh` or `.ps1`, and on Linux `kiosk_session.py`) from …".
  - Add this section after **Unattended stations**:

```markdown
## Kiosk lockdown (Linux)

On Linux the kiosk takes over the screen. Windows and macOS are unchanged:
the kiosk opens in a Chrome app window there.

- At sign-in a **Connecting to ServerSherpa…** screen shows until the cloud
  answers. It tries every 15 seconds and never gives up, and it shows the time
  of the last try and the network (Wi-Fi name, wired, or no network).
- Then Chrome opens the kiosk full screen (`--kiosk`): no address bar, no
  tabs, and F11 does nothing. If Chrome closes (Alt+F4, a crash), it opens
  again within a few seconds.
- While the kiosk runs, these GNOME shortcuts are off for the desktop user:
  - the Super key and the overview;
  - Alt+Tab and the other window switchers;
  - the Activities hot corner;
  - workspace switching (there is one workspace).
- **Esc** opens a PIN pad (when no dialog is open; Esc closes a dialog
  first). The PIN **csg** closes the kiosk and turns the shortcuts back on.
- **Start Kiosk** on the desktop, signing in again, or a reboot brings the
  kiosk back.
- The kiosk's top bar shows the battery and the Wi-Fi network. Tap the
  network to see the wired connection or join a Wi-Fi network.

How it works:
- `kiosk_session.py` is installed next to `launch.sh`, and `launch.sh` runs
  it as the desktop user at sign-in.
- It serves the waiting page and a small helper on `127.0.0.1:8092`.
  - The helper only answers the kiosk page: the page must come from
    `http://localhost:8090` and carry a token that changes every session.
  - A Wi-Fi password goes to NetworkManager (`nmcli`) and is never logged.
- The kiosk Chrome has its own profile: `~/.local/share/serversherpa-kiosk/chrome`,
  or `~/snap/chromium/common/serversherpa-kiosk` for snap Chromium. The first
  time, sign in to the kiosk again and pick the label printer once.
- The shortcut values from before the lock are saved in
  `~/.local/state/serversherpa-kiosk/desktop-lock.json`. The session's log is
  `session.log`, next to it.

Getting it: run the install command once (an existing laptop's nightly update
can't add a new file). From then on the nightly update keeps `kiosk_session.py`
current.

Not blocked:
- Ctrl+Alt+F1–F12 (text consoles), the power button, and Ctrl+Alt+Del;
- the touchpad's three-finger swipe to the overview.

If the shortcuts stay off: sign in, wait for the kiosk, press Esc and type
`csg`. A crash or power loss can't lose them, because the next session puts
the saved values back on exit. Uninstalling puts them back too: right away if
the desktop user is signed in, otherwise at their next sign-in.
```

- [ ] **Step 7: Run the suites.** All of these pass, shellcheck included (`test_shellcheck_clean`):
  - `python3 -m pytest -q kiosk_laptop/installer/tests`
  - `bash -n kiosk_laptop/installer/*.sh`

- [ ] **Step 8: Commit.**

```bash
git add kiosk_laptop/installer/launch.sh kiosk_laptop/installer/install.sh kiosk_laptop/installer/update.sh \
  kiosk_laptop/installer/tests/test_update_sh.py kiosk_laptop/installer/tests/test_install_sh.py kiosk_laptop/README.md
git commit -m "feat(kiosk-laptop): install, launch and nightly-refresh the Linux kiosk session; Start Kiosk icon; uninstall restore"
```

---

### Task 5: Kiosk web app: helper client, Esc → PIN pad

**Files:**
- Create: `kiosk/src/lib/hostHelper.ts`, `kiosk/src/lib/hostHelper.test.ts`
- Create: `kiosk/src/lib/escapeToPin.ts`, `kiosk/src/lib/escapeToPin.test.ts`
- Create: `kiosk/src/components/lockdown/PinPadModal.tsx`, `kiosk/src/components/lockdown/LockdownLayer.tsx`, `kiosk/src/components/lockdown/LockdownLayer.test.tsx`
- Modify: `kiosk/src/main.tsx`, `kiosk/src/App.tsx`, `kiosk/src/styles/kiosk.css`

**Interfaces:**
- Consumes:
  - `window.__KIOSK_CONFIG__.hostOs` (Task 1);
  - `isLaptop()` from `kiosk/src/lib/platform.ts`;
  - `openTakeovers` from `kiosk/src/lib/takeover.ts`;
  - the helper HTTP contract (plan header);
  - house CSS classes from portal `chrome.css`/`reports.css`/`profile.css`: `modal-scrim`, `modal-card`, `reports-modal-card`, `rgm-card`, `confirm-card`, `modal-head`, `rgm-head-text`, `eyebrow`, `page-hint`, `modal-close`, `modal-body`, `modal-foot`, `pf-form`, `mini-btn`, `btn-solid`;
  - kiosk.css's `form-error`, `form-notice`, and its `.kiosk-shell .modal-card.reports-modal-card.rgm-card.confirm-card` pinned-foot rules.
- Produces:
  - `hostHelper.ts`:
    - `HELPER_ORIGIN = 'http://127.0.0.1:8092'`, `HELPER_TOKEN_KEY = 'ss-kiosk-helper-token'`;
    - `captureHelperToken(): void`, `helperToken(): string | null`, `lockdownAvailable(): boolean`;
    - `class HelperError extends Error { code: string }`;
    - types `HostSystem`, `Wired`, `WifiNetwork`;
    - `getHostSystem(): Promise<HostSystem>`, `getWifiNetworks(): Promise<{networks: WifiNetwork[]; wired: Wired | null}>`, `joinWifi(ssid, password): Promise<{ok: true}>`, `exitKiosk(pin): Promise<{ok: true}>`.
  - `escapeToPin.ts`: `dialogOpen(doc?): boolean`, `installEscapeToPin(onEscape, win?): () => void`.
  - `PinPadModal({ onClose })` (default export).
  - `LockdownLayer()` (default export), mounted once in `App`.
  - CSS `.portal-shell.kiosk-shell.kiosk-pin-host`.

- [ ] **Step 1: Failing tests.** Create `kiosk/src/lib/hostHelper.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureHelperToken, exitKiosk, HELPER_ORIGIN, HELPER_TOKEN_KEY, helperToken, getHostSystem, lockdownAvailable,
} from './hostHelper';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const LINUX = { mode: 'laptop', lanAccess: false, hostOs: 'linux' };

beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { delete window.__KIOSK_CONFIG__; vi.unstubAllGlobals(); });

describe('captureHelperToken', () => {
  it('keeps the token from the fragment and strips it from the address', () => {
    window.history.replaceState(null, '', `/login?next=1#kh=${TOKEN}`);
    captureHelperToken();
    expect(helperToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/login?next=1');
  });

  it('leaves any other fragment alone', () => {
    window.history.replaceState(null, '', '/#section');
    captureHelperToken();
    expect(helperToken()).toBeNull();
    expect(window.location.hash).toBe('#section');
  });
});

describe('lockdownAvailable', () => {
  it('needs a Linux laptop, opened on the laptop itself, holding the token', () => {
    sessionStorage.setItem(HELPER_TOKEN_KEY, TOKEN);
    window.__KIOSK_CONFIG__ = LINUX;
    expect(lockdownAvailable()).toBe(true);
    for (const cfg of [{ ...LINUX, mode: undefined }, { ...LINUX, lanAccess: true },
      { ...LINUX, hostOs: null }, { ...LINUX, hostOs: 'macos' }]) {
      window.__KIOSK_CONFIG__ = cfg;
      expect(lockdownAvailable()).toBe(false);
    }
    window.__KIOSK_CONFIG__ = LINUX;
    sessionStorage.clear();
    expect(lockdownAvailable()).toBe(false);
  });
});

describe('helper calls', () => {
  it('sends the token and JSON, and maps an error body to its code', async () => {
    sessionStorage.setItem(HELPER_TOKEN_KEY, TOKEN);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'wrong_pin' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(exitKiosk('nope')).rejects.toMatchObject({ code: 'wrong_pin' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HELPER_ORIGIN}/v1/exit`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Kiosk-Token']).toBe(TOKEN);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ pin: 'nope' });
  });

  it('is "unreachable" when the helper is not there', async () => {
    sessionStorage.setItem(HELPER_TOKEN_KEY, TOKEN);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(getHostSystem()).rejects.toMatchObject({ code: 'unreachable' });
  });
});
```

  Create `kiosk/src/lib/escapeToPin.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { installEscapeToPin } from './escapeToPin';
import { openTakeovers } from './takeover';

const press = (key = 'Escape') => document.body.dispatchEvent(
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

afterEach(() => { document.body.innerHTML = ''; openTakeovers.length = 0; });

it('opens only when no dialog is open and nothing took the Escape', () => {
  const onEscape = vi.fn();
  const stop = installEscapeToPin(onEscape);
  press();
  expect(onEscape).toHaveBeenCalledTimes(1);

  // a modal that closes itself on this very keydown still counts as open
  const dlg = document.createElement('div');
  dlg.className = 'modal-scrim';
  document.body.append(dlg);
  const closer = (e: KeyboardEvent) => { if (e.key === 'Escape') dlg.remove(); };
  document.addEventListener('keydown', closer);
  press();
  document.removeEventListener('keydown', closer);
  expect(onEscape).toHaveBeenCalledTimes(1);

  // something marked it handled (an open ComboBox list)
  const taker = (e: KeyboardEvent) => e.preventDefault();
  document.addEventListener('keydown', taker);
  press();
  document.removeEventListener('keydown', taker);
  expect(onEscape).toHaveBeenCalledTimes(1);

  // a takeover (the off-move alarm) is up
  openTakeovers.push(document.createElement('div'));
  press();
  openTakeovers.length = 0;
  expect(onEscape).toHaveBeenCalledTimes(1);

  press('Enter');
  expect(onEscape).toHaveBeenCalledTimes(1);
  stop();
  press();
  expect(onEscape).toHaveBeenCalledTimes(1);
});
```

  Create `kiosk/src/components/lockdown/LockdownLayer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  available: true,
  exitKiosk: vi.fn(),
}));
vi.mock('../../lib/hostHelper', async (orig) => ({
  ...(await orig<typeof import('../../lib/hostHelper')>()),
  lockdownAvailable: () => helper.available,
  exitKiosk: helper.exitKiosk,
}));

import { HelperError } from '../../lib/hostHelper';
import LockdownLayer from './LockdownLayer';

beforeEach(() => {
  helper.available = true;
  helper.exitKiosk.mockReset();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const esc = () => act(() => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});

it('Esc opens the PIN pad; a wrong PIN says so; the right one closes the kiosk', async () => {
  render(<LockdownLayer />);
  expect(screen.queryByRole('dialog')).toBeNull();
  esc();
  const dialog = screen.getByRole('dialog', { name: 'Exit the kiosk' });
  expect(dialog.closest('.kiosk-pin-host')).not.toBeNull();
  helper.exitKiosk.mockRejectedValueOnce(new HelperError('wrong_pin'));
  await userEvent.type(screen.getByLabelText('PIN'), 'abc');
  await userEvent.click(screen.getByRole('button', { name: 'Exit kiosk' }));
  expect((await screen.findByRole('alert')).textContent).toBe("That PIN isn't right.");
  expect((screen.getByLabelText('PIN') as HTMLInputElement).value).toBe('');
  helper.exitKiosk.mockResolvedValueOnce({ ok: true });
  await userEvent.type(screen.getByLabelText('PIN'), 'csg');
  await userEvent.click(screen.getByRole('button', { name: 'Exit kiosk' }));
  expect(helper.exitKiosk).toHaveBeenLastCalledWith('csg');
  expect((await screen.findByRole('status')).textContent).toBe('Closing the kiosk…');
});

it('Esc closes the PIN pad instead of opening a second one', () => {
  render(<LockdownLayer />);
  esc();
  esc();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('renders nothing off a Linux laptop', () => {
  helper.available = false;
  render(<LockdownLayer />);
  esc();
  expect(screen.queryByRole('dialog')).toBeNull();
});
```

  The kiosk suite has no jest-dom, so assertions read `textContent`.

- [ ] **Step 2: Run the tests and watch them fail.** `cd kiosk && npx vitest run src/lib/hostHelper.test.ts src/lib/escapeToPin.test.ts src/components/lockdown/LockdownLayer.test.tsx` fails because the modules are missing.

- [ ] **Step 3: Create `kiosk/src/lib/hostHelper.ts`:**

```ts
/**
 * The Linux laptop's kiosk helper (kiosk_laptop/installer/kiosk_session.py),
 * on 127.0.0.1:8092, which the page calls directly. Its waiting page hands
 * this page a per-session token in the URL fragment (#kh=…). The fragment is
 * never sent to the edge; captureHelperToken moves it into sessionStorage and
 * strips it from the address before React renders. The helper answers only
 * this origin (http://localhost:8090) carrying that token.
 *
 * lockdownAvailable() gates every lockdown UI part: a laptop (config.js mode),
 * opened on the laptop itself (not lanAccess), that hostnet.sh reported as
 * Linux (hostOs), holding a token. So Android, iOS, the web kiosk, Mac and
 * Windows laptops, and a phone on the LAN never show any of it.
 */

import { isLaptop } from './platform';

export const HELPER_ORIGIN = 'http://127.0.0.1:8092';
export const HELPER_TOKEN_KEY = 'ss-kiosk-helper-token';
const FRAGMENT = /^#kh=([A-Za-z0-9_-]{20,128})$/;

export function captureHelperToken(): void {
  if (typeof window === 'undefined') return;
  const m = FRAGMENT.exec(window.location.hash);
  if (!m) return;
  try { sessionStorage.setItem(HELPER_TOKEN_KEY, m[1]); } catch { /* storage off: no lockdown UI */ }
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

export function helperToken(): string | null {
  try { return sessionStorage.getItem(HELPER_TOKEN_KEY); } catch { return null; }
}

export function lockdownAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const cfg = window.__KIOSK_CONFIG__;
  return isLaptop() && cfg?.lanAccess !== true && cfg?.hostOs === 'linux' && helperToken() !== null;
}

export interface Wired { connected: boolean; device: string }
export interface HostSystem {
  battery: { percent: number; charging: boolean } | null;
  wifi: { ssid: string; signal: number } | null;
  wired: Wired | null;
  network: 'wifi' | 'wired' | 'none';
}
export interface WifiNetwork { ssid: string; signal: number; secure: boolean; active: boolean }

/** `code`: the helper's error ("wrong_pin", "wrong_password", …), or
 *  "unreachable" when the helper didn't answer, "failed" otherwise. */
export class HelperError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'HelperError';
  }
}

async function call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers: Record<string, string> = { 'X-Kiosk-Token': helperToken() ?? '' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${HELPER_ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    throw new HelperError('unreachable');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new HelperError(typeof data?.error === 'string' ? data.error : 'failed');
  return data as T;
}

export const getHostSystem = () => call<HostSystem>('/v1/system');
export const getWifiNetworks = () => call<{ networks: WifiNetwork[]; wired: Wired | null }>('/v1/wifi', {}, 25_000);
export const joinWifi = (ssid: string, password: string) =>
  call<{ ok: true }>('/v1/wifi/join', { method: 'POST', body: { ssid, password } }, 65_000);
export const exitKiosk = (pin: string) => call<{ ok: true }>('/v1/exit', { method: 'POST', body: { pin } });
```

- [ ] **Step 4: Create `kiosk/src/lib/escapeToPin.ts`:**

```ts
/**
 * Esc → PIN pad, only when nothing else took that Esc. Most modals close on
 * Escape without preventDefault, so by the bubble phase the modal is already
 * gone. A capture-phase listener therefore notes whether a dialog was open
 * when the key went down, and the bubble-phase listener (on window, after
 * every document listener) opens the PIN pad only when none was and nothing
 * called preventDefault.
 */

import { openTakeovers } from './takeover';

const DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal-scrim, .tcx-modal-scrim';

export function dialogOpen(doc: Document = document): boolean {
  return openTakeovers.length > 0 || doc.querySelector(DIALOGS) !== null;
}

export function installEscapeToPin(onEscape: () => void, win: Window = window): () => void {
  let busyAtCapture = false;
  const capture = (e: KeyboardEvent) => {
    if (e.key === 'Escape') busyAtCapture = dialogOpen(win.document);
  };
  const bubble = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const busy = busyAtCapture;
    busyAtCapture = false;
    if (busy || e.defaultPrevented || e.repeat) return;
    onEscape();
  };
  win.addEventListener('keydown', capture, true);
  win.addEventListener('keydown', bubble);
  return () => {
    win.removeEventListener('keydown', capture, true);
    win.removeEventListener('keydown', bubble);
  };
}
```

- [ ] **Step 5: Create `kiosk/src/components/lockdown/PinPadModal.tsx`:**

```tsx
/** Exit the kiosk: the PIN (csg, the same on every Linux laptop: a barrier,
 *  not a secret) tells the laptop's kiosk helper to stop the watcher, close
 *  Chrome and put the desktop shortcuts back. The helper checks the PIN;
 *  this form only sends it. */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { exitKiosk, HelperError } from '../../lib/hostHelper';

export default function PinPadModal({ onClose }: { onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const locked = busy || done;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !locked) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [locked, onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current || !pin) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    exitKiosk(pin).then(
      () => { setBusy(false); setDone(true); },
      (err: unknown) => {
        inFlight.current = false;
        setBusy(false);
        setPin('');
        setError(err instanceof HelperError && err.code === 'wrong_pin'
          ? "That PIN isn't right."
          : "Couldn't reach the kiosk helper on this laptop. Try again.");
      },
    );
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <form className="modal-card reports-modal-card rgm-card confirm-card" role="dialog" aria-modal="true"
            aria-label="Exit the kiosk" onSubmit={submit} noValidate>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">This laptop</div>
            <h3>Exit the kiosk</h3>
            <p className="page-hint">
              Enter the PIN to close the kiosk and go to the desktop. Start Kiosk on the desktop opens it again.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={locked}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <label htmlFor="kiosk-exit-pin">PIN</label>
            {/* "new-password": no "Save password?" offer on a shared station */}
            <input id="kiosk-exit-pin" type="password" autoFocus autoComplete="new-password" spellCheck={false}
                   maxLength={32} value={pin} disabled={locked} onChange={(e) => setPin(e.target.value)} />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {done && <p className="form-notice" role="status">Closing the kiosk…</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" disabled={locked} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-solid" disabled={locked || !pin}>Exit kiosk</button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 6: Create `kiosk/src/components/lockdown/LockdownLayer.tsx`:**

```tsx
/** The Linux laptop's Esc → PIN pad, mounted once at the app root, so it
 *  works on every screen, the sign-in page included. The PIN pad renders in
 *  its own fixed `.portal-shell.kiosk-shell` host on <body>. That gives it the
 *  house tokens and the kiosk's pinned-foot modal rules everywhere, and the
 *  signed-in person's theme when a shell is up (otherwise the system's). */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { installEscapeToPin } from '../../lib/escapeToPin';
import { lockdownAvailable } from '../../lib/hostHelper';
import PinPadModal from './PinPadModal';

function hostAttrs(): { theme: string; accent: string | undefined } {
  const shell = document.querySelector<HTMLElement>('.portal-shell:not(.kiosk-pin-host)');
  const theme = shell?.getAttribute('data-theme')
    ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  return { theme, accent: shell?.getAttribute('data-accent') ?? undefined };
}

export default function LockdownLayer() {
  const enabled = lockdownAvailable();
  const [open, setOpen] = useState(false);
  useEffect(() => (enabled ? installEscapeToPin(() => setOpen(true)) : undefined), [enabled]);
  const close = useCallback(() => setOpen(false), []);
  if (!enabled || !open) return null;
  const { theme, accent } = hostAttrs();
  return createPortal(
    <div className="portal-shell kiosk-shell kiosk-pin-host" data-theme={theme} data-accent={accent}>
      <PinPadModal onClose={close} />
    </div>,
    document.body,
  );
}
```

- [ ] **Step 7: Wire it in.**
  - `kiosk/src/main.tsx`: add `import { captureHelperToken } from './lib/hostHelper';` and call `captureHelperToken();` directly before `installConfigTracking();`, with the comment `// The Linux laptop's kiosk helper token (#kh=…): kept, and off the address bar, before anything reads the URL.`
  - `kiosk/src/App.tsx`: add `import LockdownLayer from './components/lockdown/LockdownLayer';`, and render `<LockdownLayer />` right after `</Routes>` inside `<BrowserRouter>`, with the comment `{/* Linux laptop only: Esc → PIN → desktop (renders nothing elsewhere). */}`.
  - `kiosk/src/styles/kiosk.css`: append

```css
/* ── Linux laptop lockdown: the PIN pad's host ─────────────────────
   A .portal-shell.kiosk-shell of its own on <body> (LockdownLayer), so the
   PIN pad gets the tokens and the pinned-foot .confirm-card rules on every
   screen, the sign-in page included. It covers nothing itself. */
.portal-shell.kiosk-shell.kiosk-pin-host {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: block;
  height: auto;
  background: transparent;
  overflow: visible;
  pointer-events: none;
}
.kiosk-pin-host > * { pointer-events: auto; }
```

- [ ] **Step 8: Run the tests.** All of these pass:
  - `cd kiosk && npx vitest run src/lib/hostHelper.test.ts src/lib/escapeToPin.test.ts src/components/lockdown/LockdownLayer.test.tsx`
  - the whole suite, `npx vitest run`
  - `npm run build:bundle`
  - `npx tsc -b --noEmit` if the worktree has portal deps (CI only runs `build:bundle`; skip tsc if portal's node_modules are missing)

- [ ] **Step 9: Commit.**

```bash
git add kiosk/src/lib/hostHelper.ts kiosk/src/lib/hostHelper.test.ts kiosk/src/lib/escapeToPin.ts \
  kiosk/src/lib/escapeToPin.test.ts kiosk/src/components/lockdown/PinPadModal.tsx \
  kiosk/src/components/lockdown/LockdownLayer.tsx kiosk/src/components/lockdown/LockdownLayer.test.tsx \
  kiosk/src/main.tsx kiosk/src/App.tsx kiosk/src/styles/kiosk.css
git commit -m "feat(kiosk): Linux laptop Esc → PIN pad through the kiosk helper"
```

---

### Task 6: Kiosk web app: top-bar battery and network, Network modal

**Files:**
- Create: `kiosk/src/lib/useHostSystem.ts`, `kiosk/src/components/lockdown/SystemTray.tsx`, `kiosk/src/components/lockdown/NetworkModal.tsx`, `kiosk/src/components/lockdown/SystemTray.test.tsx`
- Modify: `kiosk/src/layout/KioskShell.tsx`, `kiosk/src/styles/kiosk.css`

**Interfaces:**
- Consumes:
  - from Task 5, `kiosk/src/lib/hostHelper.ts`: `lockdownAvailable`, `getHostSystem`, `getWifiNetworks`, `joinWifi`, `HelperError`, `HostSystem`, `Wired`, `WifiNetwork`;
  - `ChoiceCard` from `kiosk/src/components/printers/ChoiceCard.tsx` (props `title`, `description`, `selected`, `onSelect`);
  - the house modal classes (as in Task 5);
  - `.kiosk-name`'s look in kiosk.css;
  - KioskShell's `.kiosk-user` div.
- Produces:
  - `useHostSystem(): { system: HostSystem | null; refresh(): Promise<void> }`, plus `HOST_POLL_MS = 15_000`;
  - `signalBars(signal: number): 0 | 1 | 2 | 3`;
  - `SystemTray()` (default export, rendered first in `.kiosk-user`);
  - `NetworkModal({ onClose, onChanged })` (default export), plus `WIFI_LIST_MS = 15_000`;
  - CSS `.kiosk-sys-item`, `.kiosk-sys-btn`, `.kiosk-sys-icon`, `.kiosk-net-foot`, `.kiosk-wifi-pass`.

- [ ] **Step 1: Failing test.** Create `kiosk/src/components/lockdown/SystemTray.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  available: true,
  getHostSystem: vi.fn(),
  getWifiNetworks: vi.fn(),
  joinWifi: vi.fn(),
}));
vi.mock('../../lib/hostHelper', async (orig) => ({
  ...(await orig<typeof import('../../lib/hostHelper')>()),
  lockdownAvailable: () => helper.available,
  getHostSystem: helper.getHostSystem,
  getWifiNetworks: helper.getWifiNetworks,
  joinWifi: helper.joinWifi,
}));

import { HelperError } from '../../lib/hostHelper';
import SystemTray, { signalBars } from './SystemTray';

const SYSTEM = {
  battery: { percent: 87, charging: true },
  wifi: { ssid: 'CSG-Ops', signal: 72 },
  wired: { connected: false, device: 'enp0s31f6' },
  network: 'wifi' as const,
};
const NETWORKS = {
  networks: [
    { ssid: 'CSG-Ops', signal: 72, secure: true, active: true },
    { ssid: 'Warehouse', signal: 51, secure: true, active: false },
    { ssid: 'Lobby', signal: 40, secure: false, active: false },
  ],
  wired: { connected: false, device: 'enp0s31f6' },
};

beforeEach(() => {
  helper.available = true;
  helper.getHostSystem.mockReset().mockResolvedValue(SYSTEM);
  helper.getWifiNetworks.mockReset().mockResolvedValue(NETWORKS);
  helper.joinWifi.mockReset();
  document.body.innerHTML = '<div class="portal-shell kiosk-shell"></div>';
});
afterEach(() => { cleanup(); });

const renderTray = () => render(<SystemTray />, { container: document.querySelector('.kiosk-shell')! });

it('shows the battery and the Wi-Fi network', async () => {
  renderTray();
  expect(await screen.findByText('87%')).toBeTruthy();
  expect(screen.getByTitle('Battery 87%, charging')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Network: CSG-Ops' })).toBeTruthy();
});

it('the Network modal lists Wi-Fi and the wired status, and joins with the password', async () => {
  renderTray();
  await userEvent.click(await screen.findByRole('button', { name: 'Network: CSG-Ops' }));
  const dialog = await screen.findByRole('dialog', { name: 'Network' });
  expect(dialog.closest('.kiosk-top')).toBeNull();                 // portaled out of the top bar
  expect(await within(dialog).findByText('Not connected (enp0s31f6)')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('radio', { name: /Warehouse/ }));
  helper.joinWifi.mockRejectedValueOnce(new HelperError('wrong_password'));
  await userEvent.type(within(dialog).getByLabelText('Password'), 'nope');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
  expect(helper.joinWifi).toHaveBeenLastCalledWith('Warehouse', 'nope');
  expect((await within(dialog).findByRole('alert')).textContent)
    .toBe("Couldn't join Warehouse. Check the password and try again.");
  expect((within(dialog).getByLabelText('Password') as HTMLInputElement).value).toBe('');
  helper.joinWifi.mockResolvedValueOnce({ ok: true });
  await userEvent.type(within(dialog).getByLabelText('Password'), 'right-one');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Join' }));
  expect((await within(dialog).findByRole('status')).textContent).toBe('Connected to Warehouse.');
});

it('an open network has no password field', async () => {
  renderTray();
  await userEvent.click(await screen.findByRole('button', { name: 'Network: CSG-Ops' }));
  const dialog = await screen.findByRole('dialog', { name: 'Network' });
  await userEvent.click(await within(dialog).findByRole('radio', { name: /Lobby/ }));
  expect(within(dialog).queryByLabelText('Password')).toBeNull();
});

it('renders nothing off a Linux laptop', () => {
  helper.available = false;
  renderTray();
  expect(screen.queryByRole('button')).toBeNull();
  expect(helper.getHostSystem).not.toHaveBeenCalled();
});

it('signal bars', () => {
  expect([0, 1, 33, 34, 66, 67, 100].map(signalBars)).toEqual([0, 1, 1, 2, 2, 3, 3]);
});
```

  Wired text: the modal shows `Connected (dev)`, `Not connected (dev)` or `No wired adapter`. This test asserts `Not connected (enp0s31f6)`.

- [ ] **Step 2: Run the test and watch it fail.** `cd kiosk && npx vitest run src/components/lockdown/SystemTray.test.tsx` fails because the modules are missing.

- [ ] **Step 3: Create `kiosk/src/lib/useHostSystem.ts`:**

```ts
/** The Linux laptop's battery and network from the kiosk helper, polled
 *  while mounted. Off a Linux laptop it never fetches and stays null. A
 *  failed poll keeps the last answer. */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getHostSystem, lockdownAvailable, type HostSystem } from './hostHelper';

export const HOST_POLL_MS = 15_000;   // assumption: the same as EDGE_POLL_MS

export function useHostSystem(): { system: HostSystem | null; refresh: () => Promise<void> } {
  const [system, setSystem] = useState<HostSystem | null>(null);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    if (!lockdownAvailable()) return;
    try {
      const next = await getHostSystem();
      if (live.current) setSystem(next);
    } catch { /* keep the last answer */ }
  }, []);
  useEffect(() => {
    live.current = true;
    if (!lockdownAvailable()) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), HOST_POLL_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [refresh]);
  return { system, refresh };
}
```

- [ ] **Step 4: Create `kiosk/src/components/lockdown/NetworkModal.tsx`:**

```tsx
/** This laptop's network: the wired status, then the Wi-Fi networks to join
 *  (NetworkManager, through the kiosk helper). A secured network takes its
 *  password in the pinned footer, next to Join, so it never scrolls away.
 *  The password goes to the helper and on to nmcli's stdin, nowhere else.
 *  An empty one uses a network the laptop already knows. */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { getWifiNetworks, HelperError, joinWifi, type WifiNetwork, type Wired } from '../../lib/hostHelper';
import { ChoiceCard } from '../printers/ChoiceCard';

export const WIFI_LIST_MS = 15_000;   // assumption

function wiredText(wired: Wired | null): string {
  if (!wired) return 'No wired adapter';
  return `${wired.connected ? 'Connected' : 'Not connected'} (${wired.device})`;
}

function describe(n: WifiNetwork): string {
  return `${n.signal}% signal · ${n.secure ? 'Secured' : 'Open'}${n.active ? ' · Connected' : ''}`;
}

function joinErrorText(code: string, ssid: string): string {
  switch (code) {
    case 'wrong_password': return `Couldn't join ${ssid}. Check the password and try again.`;
    case 'password_required': return `${ssid} needs a password.`;
    case 'not_found': return `${ssid} is out of range.`;
    case 'unreachable': return "Couldn't reach the kiosk helper on this laptop. Try again.";
    default: return `Couldn't join ${ssid}.`;
  }
}

export default function NetworkModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [wired, setWired] = useState<Wired | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const out = await getWifiNetworks();
      if (!live.current) return;
      setNetworks(out.networks);
      setWired(out.wired);
      setListFailed(false);
    } catch {
      if (live.current) setListFailed(true);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => void load(), WIFI_LIST_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const pick = networks?.find((n) => n.ssid === selected) ?? null;

  const choose = (ssid: string) => {
    setSelected(ssid);
    setPassword('');
    setError(null);
    setNote(null);
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (!pick || pick.active || busy) return;
    const ssid = pick.ssid;
    setBusy(true);
    setError(null);
    setNote(null);
    joinWifi(ssid, pick.secure ? password : '').then(
      () => {
        if (!live.current) return;
        setBusy(false);
        setPassword('');
        setNote(`Connected to ${ssid}.`);
        onChanged();
        void load();
      },
      (err: unknown) => {
        if (!live.current) return;
        setBusy(false);
        const code = err instanceof HelperError ? err.code : 'failed';
        if (code === 'wrong_password') setPassword('');   // a refused password isn't worth keeping
        setError(joinErrorText(code, ssid));
      },
    );
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="modal-card reports-modal-card rgm-card confirm-card" role="dialog" aria-modal="true"
            aria-label="Network" onSubmit={join} noValidate>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">This laptop</div>
            <h3>Network</h3>
            <p className="page-hint">Pick a Wi-Fi network to join.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">Wired</div>
          <p className="page-hint">{networks === null && !listFailed ? 'Checking…' : wiredText(wired)}</p>
          <div className="modal-section">Wi-Fi</div>
          {networks === null && !listFailed && <p className="page-hint">Looking for Wi-Fi networks…</p>}
          {listFailed && networks === null && (
            <p className="page-hint">Couldn&apos;t read the Wi-Fi networks. Trying again…</p>
          )}
          {networks?.length === 0 && <p className="page-hint">No Wi-Fi networks found.</p>}
          {networks && networks.length > 0 && (
            <div className="rgm-choice-cards" role="radiogroup" aria-label="Wi-Fi networks">
              {networks.map((n) => (
                <ChoiceCard key={n.ssid} title={n.ssid} description={describe(n)}
                            selected={selected === n.ssid} onSelect={() => choose(n.ssid)} />
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div className="kiosk-net-foot">
            {pick?.secure && !pick.active && (
              <div className="pf-form kiosk-wifi-pass">
                <label htmlFor="kiosk-wifi-pass">Password</label>
                <input id="kiosk-wifi-pass" type="password" autoComplete="new-password" spellCheck={false}
                       maxLength={128} value={password} disabled={busy}
                       onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            {note && <p className="form-notice" role="status">{note}</p>}
          </div>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Close</button>
          <button type="submit" className="btn-solid" disabled={!pick || pick.active || busy}>
            {busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

  Check that `modal-section` exists (ClearSetupModal and PrinterSetupModal use it).

- [ ] **Step 5: Create `kiosk/src/components/lockdown/SystemTray.tsx`:**

```tsx
/** The Linux laptop's battery and network in the kiosk top bar (first in
 *  .kiosk-user). Tapping the network opens the Network modal, portaled into
 *  the shell so the top bar's own button styles don't reach it. Renders
 *  nothing off a Linux laptop, and nothing until the helper first answers. */

import { useState } from 'react';
import { createPortal } from 'react-dom';

import { lockdownAvailable } from '../../lib/hostHelper';
import { useHostSystem } from '../../lib/useHostSystem';
import NetworkModal from './NetworkModal';

export function signalBars(signal: number): 0 | 1 | 2 | 3 {
  if (signal <= 0) return 0;
  if (signal <= 33) return 1;
  if (signal <= 66) return 2;
  return 3;
}

function BatteryIcon({ percent, charging }: { percent: number; charging: boolean }) {
  const fill = Math.round((14 * Math.max(0, Math.min(100, percent))) / 100);
  return (
    <svg className="kiosk-sys-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="21" y="10" width="2" height="4" rx="1" fill="currentColor" />
      <rect x="4" y="9" width={fill} height="6" rx="1" fill="currentColor" opacity={charging ? 0.35 : 1} />
      {charging && <path d="M12.5 7.5 8.5 12.5h3l-1 4 4-5h-3z" fill="currentColor" />}
    </svg>
  );
}

function WifiIcon({ bars }: { bars: 0 | 1 | 2 | 3 }) {
  const on = (n: number) => (bars >= n ? 1 : 0.3);
  return (
    <svg className="kiosk-sys-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 9a14 14 0 0 1 19 0" opacity={on(3)} />
      <path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" opacity={on(2)} />
      <path d="M8.5 16a5 5 0 0 1 7 0" opacity={on(1)} />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" opacity={bars > 0 ? 1 : 0.3} />
    </svg>
  );
}

function WiredIcon() {
  return (
    <svg className="kiosk-sys-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="3" width="12" height="9" rx="1.5" />
      <path d="M9 6v2M12 6v2M15 6v2M12 12v4M6 16h12v5H6z" />
    </svg>
  );
}

export default function SystemTray() {
  const { system, refresh } = useHostSystem();
  const [open, setOpen] = useState(false);
  if (!lockdownAvailable() || !system) return null;
  const { battery, wifi, network } = system;
  const label = network === 'wifi' && wifi ? wifi.ssid : network === 'wired' ? 'Wired' : 'No network';
  const host = document.querySelector('.portal-shell.kiosk-shell:not(.kiosk-pin-host)') ?? document.body;
  return (
    <>
      {battery && (
        <span className="kiosk-sys-item" title={`Battery ${battery.percent}%${battery.charging ? ', charging' : ''}`}>
          <BatteryIcon percent={battery.percent} charging={battery.charging} />
          <span>{battery.percent}%</span>
        </span>
      )}
      <button type="button" className="kiosk-sys-btn" aria-label={`Network: ${label}`}
              title={wifi ? `${wifi.ssid} · ${wifi.signal}% signal` : label} onClick={() => setOpen(true)}>
        {network === 'wired' ? <WiredIcon /> : <WifiIcon bars={wifi ? signalBars(wifi.signal) : 0} />}
        <span>{label}</span>
      </button>
      {open && createPortal(
        <NetworkModal onClose={() => setOpen(false)} onChanged={() => void refresh()} />, host)}
    </>
  );
}
```

- [ ] **Step 6: Wire it in and style it.**
  - `kiosk/src/layout/KioskShell.tsx`: add `import SystemTray from '../components/lockdown/SystemTray';`. Render `<SystemTray />` as the first child of `<div className="kiosk-user">`, before the registration chip, with the comment `{/* Linux laptop only: battery and network (renders nothing elsewhere). */}`.
  - `kiosk/src/styles/kiosk.css`: append (the same look as `.kiosk-name`; tokens only)

```css
/* ── Linux laptop lockdown: top-bar battery and network ───────────── */
.kiosk-sys-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--snow);
  white-space: nowrap;
}
.kiosk-sys-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--snow);
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: .06em;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 8px;
  white-space: nowrap;
  min-width: 0;
  max-width: 22vw;
}
.kiosk-sys-btn:hover { background: var(--ink-2); }
.kiosk-sys-btn > span { overflow: hidden; text-overflow: ellipsis; }
.kiosk-sys-icon { width: 18px; height: 18px; flex: none; }
/* Network modal footer: the password and the message line take the space
   left of Close/Join, which stay put. */
.kiosk-net-foot { margin-right: auto; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.kiosk-net-foot .form-error, .kiosk-net-foot .form-notice { margin: 0; }
.kiosk-wifi-pass { max-width: 260px; }
```

- [ ] **Step 7: Run the tests.** All of these pass:
  - `cd kiosk && npx vitest run src/components/lockdown src/layout/KioskShell.test.tsx`
  - the whole suite, `npx vitest run`
  - `npm run build:bundle`

  The portal guardrails also pass: `portal/src/styles/roundedScrollbars.test.ts` (the Network modal scrolls inside `.modal-card`, which is already on the list) and `modalCorners.test.ts`. Run them with `cd portal && npx vitest run src/styles` if portal deps exist; CI runs the kiosk suite.

- [ ] **Step 8: Commit.**

```bash
git add kiosk/src/lib/useHostSystem.ts kiosk/src/components/lockdown/SystemTray.tsx \
  kiosk/src/components/lockdown/NetworkModal.tsx kiosk/src/components/lockdown/SystemTray.test.tsx \
  kiosk/src/layout/KioskShell.tsx kiosk/src/styles/kiosk.css
git commit -m "feat(kiosk): Linux laptop top bar battery and network, Network modal to join Wi-Fi"
```

---

### Task 7: Full suites and a live check on an Ubuntu laptop

**Files:** none, except fixes the check turns up. Each fix gets its own commit with a test.

**Interfaces:**
- Consumes: everything above.
- Produces: a pass or fail report on each live item below. Facts the stubs couldn't prove are confirmed or fixed.

- [ ] **Step 1: Run the whole suites in the worktree, in the foreground.**
  - `python3 -m pytest -q kiosk_laptop/installer/tests`
  - `cd kiosk_laptop/edge && .venv/bin/pytest -q`
  - `cd kiosk && npx vitest run && npm run build:bundle`
  
  All of them pass.

- [ ] **Step 2: Build the image from the worktree, then install on the Ubuntu 24.04 test laptop.** Use the README "For developers" build, or push nothing and use `KIOSK_IMAGE` with a locally built and loaded image. Run `install.sh` from the worktree checkout with `KIOSK_TEMPLATE_DIR=kiosk_laptop/installer` as the signed-in desktop user via sudo. No `adb`; this is a laptop.

- [ ] **Step 3: Live checklist.** Note pass or fail for each:
  1. Sign out and in with the network unplugged and Wi-Fi off. The waiting page is full screen, and shows `Last attempt HH:MM` (updating about every 15 s) and `Network: No network`. Esc → `csg` reaches the desktop, with the shortcuts working.
  2. Join Wi-Fi from GNOME, then click Start Kiosk. Before that, check the icon launches on a double-click with no "Allow Launching" prompt (`gio info -a metadata::trusted ~/Desktop/serversherpa-start-kiosk.desktop`). The kiosk opens in `--kiosk` (no address bar; F11 does nothing).
  3. Alt+F4 → Chrome is back within about 3 s. Also try Ctrl+Shift+Q.
  4. These do nothing: Super, Super+A, Super+Tab, Alt+Tab, Alt+F1, the top-left hot corner, Super+PageUp/PageDown, and Ctrl+Alt+Left/Right.
  5. Esc on the sign-in page → PIN pad. Inside a modal, Esc closes the modal and shows no PIN pad; a second Esc opens it. A wrong PIN shows the error. `csg` closes Chrome, and every shortcut in item 4 works again. Compare `gsettings get org.gnome.mutter overlay-key` with its value before the install.
  6. Kill the session with `kill -9 <pid of kiosk_session.py>` while locked, then reboot. The kiosk returns locked; `csg` restores the **original** values.
  7. Top bar: battery % and the bolt when charging (plug and unplug, within about 15 s); the Wi-Fi name and bars.
  8. In the Network modal: join a WPA2 network with a wrong and then a right password. While the join runs, check `ps -eo args | grep nmcli` doesn't show the password. Then run `grep -r '<password>' ~/.local/state/serversherpa-kiosk/` and confirm it finds nothing. **This proves `nmcli --ask` reads stdin.** If it doesn't, switch `join_wifi` to `nmcli connection add type wifi … wifi-sec.key-mgmt wpa-psk` followed by `nmcli connection up id <ssid> passwd-file <0600 file in $XDG_RUNTIME_DIR, deleted at once>`, with a test.
  9. Run the join as a **non-admin** desktop user. If polkit refuses, report it; don't change system settings.
  10. Open `http://localhost:8090` in a normal (non-kiosk) Chrome on the laptop: no tray and no PIN. Open `http://<laptop-ip>:8090` from a phone: no tray and no PIN. Run `curl -H 'Host: 127.0.0.1:8092' -H 'Origin: http://evil.test' http://127.0.0.1:8092/v1/system` and get 403.
  11. A new-profile first run: if Chrome shows a first-run or privacy dialog in kiosk mode, note it. Dismiss it once, and confirm it doesn't return.
  12. Snap Chromium laptop, if one is available: the profile lands under `~/snap/chromium/common/serversherpa-kiosk`.
  13. `install.sh --uninstall` while signed in: the shortcuts are back and the icon is gone. While signed out (over SSH): `~/.config/autostart/serversherpa-kiosk-restore.desktop` exists. At the next sign-in the shortcuts are back and the entry and the copy are gone.
  14. macOS (if a test Mac is handy): `launch.sh` still opens `--app`, and `host-network.json` has no `host_os`.

- [ ] **Step 4: Report.** Report the checklist results and the commits for any fixes. Do not update the parity sheet or Harbor Master here; the controller does that after merge.
