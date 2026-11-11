import os
import subprocess
from pathlib import Path

import pytest

INSTALL_SH = Path(__file__).resolve().parents[1] / "install.sh"
# Exercise macOS's bash 3.2 when it is present.
BASH = "/bin/bash" if os.path.exists("/bin/bash") else "bash"


@pytest.fixture
def sh(tmp_path):
    """Run `body` in bash with install.sh sourced in library mode; returns CompletedProcess."""
    def run(body, env=None, check=True):
        full_env = {**os.environ, "KIOSK_INSTALL_LIB": "1", "HOME": str(tmp_path / "home"),
                    "KIOSK_NONINTERACTIVE": "1", "KIOSK_TEMPLATE_DIR": str(INSTALL_SH.parent),
                    **(env or {})}
        (tmp_path / "home").mkdir(exist_ok=True)
        proc = subprocess.run([BASH, "-c", f'source "{INSTALL_SH}"; {body}'],
                              capture_output=True, text=True, env=full_env, cwd=tmp_path)
        if check and proc.returncode != 0:
            raise AssertionError(f"exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}")
        return proc
    return run


# A stateful fake docker that models the image store, for the tag-by-ID
# behavior that differs between stores. mode "containerd" (Docker Desktop's
# containerd image store): an image with no name left can't be found by its
# ID, even while a container runs it. mode "classic": it can (dangling).
# `compose … pull` moves REF to PULLED; `compose … up -d` runs what REF names;
# health is unhealthy for the IDs in BAD. Every call is logged to docker.log.
STORE_DOCKER = r'''#!/bin/sh
D="$(dirname "$0")/store"
echo "$*" >> "$(dirname "$0")/docker.log"
lookup() {
  case "$1" in
    sha256:*)
      if grep -q " $1\$" "$D/tags"; then echo "$1"; return 0; fi
      if [ "$(cat "$D/mode")" = classic ] && grep -qx "$1" "$D/known"; then echo "$1"; return 0; fi
      return 1 ;;
    *) id=$(grep "^$1 " "$D/tags" | tail -n 1 | cut -d' ' -f2)
       [ -n "$id" ] || return 1; echo "$id" ;;
  esac
}
settag() {
  grep -v "^$1 " "$D/tags" > "$D/tags.tmp"; echo "$1 $2" >> "$D/tags.tmp"; mv "$D/tags.tmp" "$D/tags"
  echo "$2" >> "$D/known"
}
last() { for a in "$@"; do l="$a"; done; printf '%s' "$l"; }
case "$1" in
  inspect)
    run=$(cat "$D/running")
    [ -n "$run" ] || { echo "Error: No such object" >&2; exit 1; }
    case "$*" in
      *State.Health*) if grep -qx "$run" "$D/bad"; then echo unhealthy; else echo healthy; fi ;;
      *"{{.Image}}"*) echo "$run" ;;
      *) exit 0 ;;
    esac ;;
  image)
    case "$2" in
      inspect) lookup "$(last "$@")" || { echo "Error: No such image: $(last "$@")" >&2; exit 1; } ;;
      *) exit 0 ;;
    esac ;;
  tag)
    id=$(lookup "$2") || { echo "Error response from daemon: No such image: $2" >&2; exit 1; }
    settag "$3" "$id" ;;
  compose)
    case "$*" in
      *" pull") settag "$(cat "$D/ref")" "$(cat "$D/pulled")" ;;
      *" up -d") id=$(lookup "$(cat "$D/ref")") || exit 1; echo "$id" > "$D/running" ;;
    esac ;;
  *) exit 0 ;;
esac
exit 0
'''


def store_docker(tmp_path, mode, ref, tags, running="", pulled="", bad=()):
    """Write the fake (tmp_path/docker) and its store; returns (fake, tags_of)."""
    d = tmp_path / "store"
    d.mkdir(exist_ok=True)
    (d / "mode").write_text(mode)
    (d / "ref").write_text(ref)
    (d / "pulled").write_text(pulled)
    (d / "running").write_text(running)
    (d / "bad").write_text("".join(f"{b}\n" for b in bad))
    (d / "tags").write_text("".join(f"{n} {i}\n" for n, i in tags.items()))
    (d / "known").write_text("".join(f"{i}\n" for i in set(tags.values()) | {running} if i))
    fake = tmp_path / "docker"
    fake.write_text(STORE_DOCKER)
    fake.chmod(0o755)

    def tags_of():
        out = {}
        for line in (d / "tags").read_text().splitlines():
            n, i = line.split(" ")
            out[n] = i
        return out, (d / "running").read_text().strip()
    return fake, tags_of


# USB label-printer upkeep (the shared block in install.sh and hostnet.sh).
# `lpstat -v` as Ubuntu prints it: two USB Zebras that system-config-printer
# set up, a networked Zebra and a USB office printer (both left alone).
LPSTAT_V = (
    "device for Zebra_Technologies_ZTC_ZD421-203dpi_ZPL: "
    "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J123456789\n"
    "device for ZTC-GK420d: usb://Zebra%20Technologies/ZTC%20GK420d?serial=28J1\n"
    "device for Dock_Zebra: socket://10.10.48.80:9100\n"
    "device for HP_LaserJet: usb://HP/LaserJet%20Pro%20M404?serial=PHB1\n"
)
ZEBRA_QUEUES = ["Zebra_Technologies_ZTC_ZD421-203dpi_ZPL", "ZTC-GK420d"]


def lp_stubs(tmp_path, usblp=True, lpstat=LPSTAT_V, snaps=(), engine=True, raw_usb=False,
             pkg=True, fail="", unit=None, active=False, units=("docker.socket", "docker.service"),
             restart_fails=False):
    """Bash stub functions for the upkeep's tools plus the fake roots, as a
    script prefix. Every call goes to tmp_path/lp.calls. snaps: the installed
    snaps (`snap remove` takes one away). A tool named in `fail` exits 1.
    systemctl: `cat` prints `unit` (fails when None), `is-active` follows
    `active`, `list-unit-files` knows `units`, `restart` fails with
    `restart_fails`."""
    calls = tmp_path / "lp.calls"
    for d in ("udev", "modprobe", "run"):
        (tmp_path / d).mkdir(exist_ok=True)
    (tmp_path / "lp.lpstat").write_text(lpstat)
    (tmp_path / "lp.snaps").write_text("".join(f"{s}\n" for s in snaps))
    dockerd = tmp_path / "dockerd"
    if engine:
        dockerd.write_text("#!/bin/sh\n"); dockerd.chmod(0o755)
    conn = "manual" if raw_usb else "-"
    if unit is not None:
        (tmp_path / "lp.unit").write_text(unit)
    snaps_f = tmp_path / "lp.snaps"

    def tool(name, body="return 0"):
        f = 'return 1' if name in fail.split() else body
        return f'{name}() {{ echo "{name} $*" >> "{calls}"; {f}; }}; '
    return (
        f'LP_UDEV_RULES="{tmp_path}/udev/60-serversherpa-label-printers.rules"; '
        f'LP_MODPROBE_CONF="{tmp_path}/modprobe/serversherpa-no-usblp.conf"; '
        f'LP_DOCKERD_BIN="{dockerd}"; LP_SNAP_MARKER="{tmp_path}/run/serversherpa-kiosk-snap-docker-removed"; '
        + tool("lsmod", f'printf "Module Size Used\\n"; {"echo usblp 28672 0" if usblp else ":"}')
        + tool("modprobe") + tool("udevadm") + tool("lpadmin")
        + tool("lpstat", f'cat "{tmp_path}/lp.lpstat"')
        + tool("systemctl", 'case "$1" in '
                            + ('cat) return 1;; ' if unit is None
                               else f'cat) cat "{tmp_path}/lp.unit";; ')
                            + f'is-active) return {0 if active else 1};; '
                            + f'list-unit-files) case " {" ".join(units)} " in *" $3 "*) echo "$3 enabled";; esac;; '
                            + f'restart) return {1 if restart_fails else 0};; '
                            + 'esac; return 0')
        + tool("apt-get", f'echo "DEBIAN_FRONTEND=${{DEBIAN_FRONTEND:-}}" >> "{calls}"')
        + tool("dpkg-query", f'{"printf \"install ok installed\"" if pkg else "return 1"}')
        + tool("snap", f'case "$1" in '
                       f'list) grep -qx "$2" "{snaps_f}";; '
                       f'remove) grep -vx "$3" "{snaps_f}" > "{snaps_f}.t"; mv "{snaps_f}.t" "{snaps_f}";; '
                       f'connections) printf "Interface Plug Slot Notes\\nraw-usb chromium:raw-usb {":raw-usb" if raw_usb else "-"} {conn}\\nx11 chromium:x11 :x11 -\\n";; '
                       f'esac')
    )


def lp_calls(tmp_path):
    f = tmp_path / "lp.calls"
    return f.read_text().splitlines() if f.exists() else []
