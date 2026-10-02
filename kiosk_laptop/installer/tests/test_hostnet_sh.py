"""hostnet.sh: the host-network helper (spec §2.1). Parsers are fed captured
tool output; the file it writes is read back with the edge's own reader."""
import importlib.util
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from conftest import BASH

HOSTNET_SH = Path(__file__).resolve().parents[1] / "hostnet.sh"
EDGE_HOSTNET = Path(__file__).resolve().parents[2] / "edge" / "src" / "edge" / "hostnet.py"


def _edge_reader():
    """The edge's hostnet.py, loaded by path (it only needs the stdlib), so
    the CI job without the edge package installed checks the same contract."""
    spec = importlib.util.spec_from_file_location("edge_hostnet_contract", EDGE_HOSTNET)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hn(tmp_path, body, env=None, stdin=None):
    full = {**os.environ, "KIOSK_HOSTNET_LIB": "1", "KIOSK_DIR": str(tmp_path), **(env or {})}
    return subprocess.run([BASH, "-c", f'source "{HOSTNET_SH}"; {body}'], input=stdin,
                          capture_output=True, text=True, env=full, cwd=tmp_path)


def rows(text):
    return [tuple(line.split("\t")) for line in text.splitlines() if line]


# ── Linux: ip -j -4 addr ──────────────────────────────────────────────
IP_JSON = (
    '[{"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP","LOWER_UP"],"mtu":65536,"qdisc":"noqueue",'
    '"operstate":"UNKNOWN","group":"default","txqlen":1000,"addr_info":[{"family":"inet","local":"127.0.0.1",'
    '"prefixlen":8,"scope":"host","label":"lo","valid_life_time":4294967295,"preferred_life_time":4294967295}]},'
    '{"ifindex":2,"ifname":"enp0s31f6","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"mtu":1500,'
    '"qdisc":"fq_codel","operstate":"UP","group":"default","txqlen":1000,"addr_info":[{"family":"inet",'
    '"local":"10.10.48.57","prefixlen":24,"broadcast":"10.10.48.255","scope":"global","dynamic":true,'
    '"noprefixroute":true,"label":"enp0s31f6","valid_life_time":85000,"preferred_life_time":85000},'
    '{"family":"inet","local":"10.10.50.9","prefixlen":23,"scope":"global","secondary":true,'
    '"label":"enp0s31f6:1","valid_life_time":4294967295,"preferred_life_time":4294967295}]},'
    # Wi-Fi with no carrier: operstate DOWN
    '{"ifindex":3,"ifname":"wlp2s0","flags":["NO-CARRIER","BROADCAST","MULTICAST","UP"],"mtu":1500,'
    '"operstate":"DOWN","altnames":["wlx001122334455"],"addr_info":[{"family":"inet","local":"192.168.1.20","prefixlen":24}]},'
    # ip -j prints an empty object for an interface without IPv4
    '{},'
    '{"ifindex":5,"ifname":"docker0","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"operstate":"UP",'
    '"addr_info":[{"family":"inet","local":"172.17.0.1","prefixlen":16}]},'
    '{"ifindex":6,"ifname":"br-1a2b3c4d","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"operstate":"UP",'
    '"addr_info":[{"family":"inet","local":"172.18.0.1","prefixlen":16}]},'
    '{"ifindex":7,"ifname":"wg0","flags":["POINTOPOINT","NOARP","UP","LOWER_UP"],"operstate":"UNKNOWN",'
    '"addr_info":[{"family":"inet","local":"10.8.0.2","prefixlen":24}]},'
    '{"ifindex":8,"ifname":"tun0","flags":["POINTOPOINT","UP","LOWER_UP"],"operstate":"UNKNOWN",'
    '"addr_info":[{"family":"inet","local":"10.9.0.2","prefixlen":24}]},'
    '{"ifindex":9,"ifname":"enx00e04c","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"operstate":"UP",'
    '"addr_info":[{"family":"inet","local":"169.254.10.10","prefixlen":16}]},'
    # administratively down: no UP flag
    '{"ifindex":10,"ifname":"eth1","flags":["BROADCAST","MULTICAST"],"operstate":"DOWN",'
    '"addr_info":[{"family":"inet","local":"192.168.5.5","prefixlen":24}]},'
    # USB tethering reports UNKNOWN but is up
    '{"ifindex":11,"ifname":"usb0","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"operstate":"UNKNOWN",'
    '"addr_info":[{"family":"inet","local":"192.168.42.10","prefixlen":24,"label":"a\\"b"}]},'
    '{"ifindex":12,"ifname":"veth9f0e1d2","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"operstate":"UP",'
    '"addr_info":[{"family":"inet","local":"172.19.0.5","prefixlen":16}]},'
    '{"ifindex":13,"ifname":"tap0","flags":["BROADCAST","UP","LOWER_UP"],"operstate":"UP",'
    '"addr_info":[{"family":"inet","local":"10.20.0.2","prefixlen":24}]}]\n'
)


def test_parse_linux_keeps_up_interfaces_with_their_addresses(tmp_path):
    r = hn(tmp_path, "parse_linux", stdin=IP_JSON)
    assert r.returncode == 0, r.stderr
    got = rows(r.stdout)
    # up interfaces only (lo and the virtual ones are dropped by usable_only, not here)
    assert ("enp0s31f6", "10.10.48.57", "24") in got
    assert ("enp0s31f6", "10.10.50.9", "23") in got
    assert ("usb0", "192.168.42.10", "24") in got
    assert not [g for g in got if g[0] in ("wlp2s0", "eth1")]


def test_parse_linux_handles_pretty_printed_json(tmp_path):
    pretty = json.dumps(json.loads(IP_JSON), indent=4)
    assert rows(hn(tmp_path, "parse_linux", stdin=pretty).stdout) == rows(hn(tmp_path, "parse_linux", stdin=IP_JSON).stdout)


def test_parse_linux_empty_list(tmp_path):
    r = hn(tmp_path, "parse_linux", stdin="[]\n")
    assert r.returncode == 0 and r.stdout == ""


def test_linux_pipeline_applies_the_exclusions(tmp_path):
    r = hn(tmp_path, "parse_linux | usable_only", stdin=IP_JSON)
    assert rows(r.stdout) == [("enp0s31f6", "10.10.48.57", "24"), ("enp0s31f6", "10.10.50.9", "23"),
                              ("usb0", "192.168.42.10", "24")]


# ── macOS: ifconfig + networksetup -listallhardwareports ──────────────
IFCONFIG = """\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\toptions=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
\tinet 127.0.0.1 netmask 0xff000000
\tinet6 ::1 prefixlen 128
\tnd6 options=201<PERFORMNUD,DAD>
gif0: flags=8010<POINTOPOINT,MULTICAST> mtu 1280
anpi0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether 3e:a6:f6:aa:bb:cc
\tinet 10.99.0.1 netmask 0xffffff00 broadcast 10.99.0.255
\tstatus: active
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
\tether a4:83:e7:11:22:33
\tinet6 fe80::1c8b:2d4e:aa:bb%en0 prefixlen 64 secured scopeid 0xb
\tinet 10.10.48.57 netmask 0xffffff00 broadcast 10.10.48.255
\tinet 10.10.50.9 netmask 0xfffffe00 broadcast 10.10.51.255
\tnd6 options=201<PERFORMNUD,DAD>
\tmedia: autoselect
\tstatus: active
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether a4:83:e7:44:55:66
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
\tmedia: autoselect (none)
\tstatus: inactive
en5: flags=8822<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500
\tether a4:83:e7:77:88:99
\tinet 192.168.7.7 netmask 255.255.255.0 broadcast 192.168.7.255
\tstatus: active
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 169.254.33.4 netmask 0xffff0000 broadcast 169.254.255.255
\tstatus: active
en8: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 172.20.10.3 netmask 255.255.255.240 broadcast 172.20.10.15
\tstatus: active
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.64.1 netmask 0xffffff00 broadcast 192.168.64.255
\tstatus: active
utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
\tinet 10.8.0.2 --> 10.8.0.1 netmask 0xffffff00
"""

PORTS = """\

Hardware Port: Ethernet
Device: en0
Ethernet Address: a4:83:e7:11:22:33

Hardware Port: Wi-Fi
Device: en1
Ethernet Address: a4:83:e7:44:55:66

Hardware Port: USB 10/100/1000 LAN
Device: en5
Ethernet Address: a4:83:e7:77:88:99

Hardware Port: iPhone USB
Device: en8
Ethernet Address: n/a

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 82:00:00:00:00:00

VLAN Configurations
===================
"""


def test_hardware_devices_lists_the_real_adapters(tmp_path):
    r = hn(tmp_path, "hardware_devices", stdin=PORTS)
    assert r.stdout.split() == ["en0", "en1", "en5", "en8", "bridge0"]


def test_parse_macos_keeps_up_active_hardware_ports(tmp_path):
    r = hn(tmp_path, 'parse_macos "en0 en1 en5 en8 bridge0"', stdin=IFCONFIG)
    assert r.returncode == 0, r.stderr
    assert rows(r.stdout) == [
        ("en0", "10.10.48.57", "24"), ("en0", "10.10.50.9", "23"),  # hex netmasks
        ("en8", "172.20.10.3", "28"),                                # dotted netmask
        ("bridge0", "192.168.64.1", "24"),                           # dropped later by name
    ]


def test_parse_macos_without_a_hardware_list_keeps_every_up_interface(tmp_path):
    # networksetup failed: fall back to the name rules alone
    got = rows(hn(tmp_path, 'parse_macos ""', stdin=IFCONFIG).stdout)
    names = [g[0] for g in got]
    assert "anpi0" in names and "utun3" in names and "lo0" in names
    assert "en1" not in names and "en5" not in names   # inactive / not UP


def test_macos_pipeline_applies_the_exclusions(tmp_path):
    r = hn(tmp_path, 'parse_macos "en0 en1 en5 en7 en8 bridge0" | usable_only', stdin=IFCONFIG)
    assert rows(r.stdout) == [("en0", "10.10.48.57", "24"), ("en0", "10.10.50.9", "23"),
                              ("en8", "172.20.10.3", "28")]


# ── Exclusions ────────────────────────────────────────────────────────
@pytest.mark.parametrize("name", ["docker0", "br-abc", "veth12", "vEthernet (WSL)", "utun0", "tun0",
                                  "tap1", "wg0", "bridge100", "Docker0", "WG1"])
def test_usable_only_drops_virtual_adapters(tmp_path, name):
    assert hn(tmp_path, "usable_only", stdin=f"{name}\t10.0.0.5\t24\n").stdout == ""


@pytest.mark.parametrize("ip,prefix", [("127.0.0.1", "8"), ("169.254.1.1", "16"), ("0.0.0.0", "0"),
                                       ("224.0.0.1", "4"), ("239.1.1.1", "8"), ("255.255.255.255", "32"),
                                       ("10.0.0.256", "24"), ("10.0.0", "24"), ("10.0.0.5", "33"),
                                       ("10.0.0.5", "x"), ("a.b.c.d", "24")])
def test_usable_only_drops_unusable_addresses(tmp_path, ip, prefix):
    assert hn(tmp_path, "usable_only", stdin=f"en0\t{ip}\t{prefix}\n").stdout == ""


def test_usable_only_keeps_lan_addresses(tmp_path):
    text = "en0\t10.10.48.57\t24\nwlan0\t192.168.1.20\t32\neth0\t172.16.0.1\t0\n"
    assert hn(tmp_path, "usable_only", stdin=text).stdout == text


# ── JSON and the atomic write ─────────────────────────────────────────
def test_to_json_is_what_the_edge_reads(tmp_path):
    r = hn(tmp_path, 'to_json 2026-10-01T18:00:00Z', stdin="en0\t10.10.48.57\t24\nusb\"0\t192.168.42.10\t24\n")
    data = json.loads(r.stdout)
    assert data == {"updated_at": "2026-10-01T18:00:00Z",
                    "interfaces": [{"name": "en0", "ipv4": "10.10.48.57", "prefix": 24},
                                   {"name": 'usb"0', "ipv4": "192.168.42.10", "prefix": 24}]}


def test_to_json_with_no_interfaces(tmp_path):
    assert json.loads(hn(tmp_path, 'to_json 2026-10-01T18:00:00Z', stdin="").stdout) == \
        {"updated_at": "2026-10-01T18:00:00Z", "interfaces": []}


def test_write_is_atomic_and_mode_644(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    (data / "host-network.json").write_text("old")
    r = hn(tmp_path, f'umask 077; write_host_network "{data}" \'{{"a": 1}}\'; echo rc=$?')
    assert "rc=0" in r.stdout
    assert json.loads((data / "host-network.json").read_text()) == {"a": 1}
    assert (data / "host-network.json").stat().st_mode & 0o777 == 0o644
    assert sorted(p.name for p in data.iterdir()) == ["host-network.json"]   # no temp file left


def test_write_replaces_a_symlink_instead_of_following_it(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    victim = tmp_path / "victim"; victim.write_text("keep")
    (data / "host-network.json").symlink_to(victim)
    hn(tmp_path, f'write_host_network "{data}" "{{}}"')
    assert victim.read_text() == "keep" and not (data / "host-network.json").is_symlink()


def test_write_fails_quietly_when_the_folder_is_missing(tmp_path):
    r = hn(tmp_path, f'write_host_network "{tmp_path}/none" "{{}}"; echo rc=$?')
    assert "rc=1" in r.stdout and r.stderr == ""


def test_write_cleans_up_its_temp_file_when_the_rename_fails(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    r = hn(tmp_path, f'mv() {{ return 1; }}; write_host_network "{data}" "{{}}"; echo rc=$?')
    assert "rc=1" in r.stdout and list(data.iterdir()) == []


# ── Data folder and main ──────────────────────────────────────────────
def test_data_dir_env_then_config_then_default(tmp_path):
    assert hn(tmp_path, "data_dir", env={"KIOSK_DATA_DIR": "/from/env"}).stdout == "/from/env"
    (tmp_path / "config.env").write_text("EDGE_CLOUD_API_URL=x\nKIOSK_DATA_DIR=/from/config\n")
    assert hn(tmp_path, "data_dir", env={"KIOSK_DATA_DIR": ""}).stdout == "/from/config"
    (tmp_path / "config.env").write_text("KIOSK_CHANNEL=stable\n")
    assert hn(tmp_path, "OS=Linux; data_dir", env={"KIOSK_DATA_DIR": ""}).stdout == "/var/lib/serversherpa-kiosk"
    assert hn(tmp_path, "OS=Darwin; data_dir", env={"KIOSK_DATA_DIR": ""}).stdout == "/Users/Shared/ServerSherpaKiosk/data"


def test_main_on_linux_writes_a_file_the_edge_accepts(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    ipj = tmp_path / "ip.json"; ipj.write_text(IP_JSON)
    r = hn(tmp_path, f'OS=Linux; ip() {{ [ "$*" = "-j -4 addr" ] && cat "{ipj}"; }}; main; echo rc=$?',
           env={"KIOSK_DATA_DIR": str(data)})
    assert r.stdout == "rc=0\n" and r.stderr == ""   # prints nothing itself
    edge = _edge_reader()
    found, fresh = edge.read_host_network(data, now=datetime.now(timezone.utc))
    assert fresh and [(i.name, i.ipv4, i.prefix) for i in found] == [
        ("enp0s31f6", "10.10.48.57", 24), ("enp0s31f6", "10.10.50.9", 23), ("usb0", "192.168.42.10", 24)]


def test_main_on_macos_uses_ifconfig_and_networksetup(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    ifc = tmp_path / "ifconfig.txt"; ifc.write_text(IFCONFIG)
    ports = tmp_path / "ports.txt"; ports.write_text(PORTS)
    r = hn(tmp_path, f'OS=Darwin; ifconfig() {{ cat "{ifc}"; }}; '
                     f'networksetup() {{ [ "$1" = -listallhardwareports ] && cat "{ports}"; }}; main; echo rc=$?',
           env={"KIOSK_DATA_DIR": str(data)})
    assert r.stdout == "rc=0\n", r.stderr
    found, fresh = _edge_reader().read_host_network(data)
    assert fresh and [i.ipv4 for i in found] == ["10.10.48.57", "10.10.50.9", "172.20.10.3"]


def test_main_keeps_the_old_file_when_the_tool_fails(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    (data / "host-network.json").write_text("old")
    r = hn(tmp_path, 'OS=Linux; ip() { return 1; }; main; echo rc=$?', env={"KIOSK_DATA_DIR": str(data)})
    assert r.stdout == "rc=1\n" and r.stderr == ""
    assert (data / "host-network.json").read_text() == "old"


def test_main_writes_an_empty_list_when_nothing_is_connected(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    r = hn(tmp_path, 'OS=Linux; ip() { echo "[]"; }; main; echo rc=$?', env={"KIOSK_DATA_DIR": str(data)})
    assert r.stdout == "rc=0\n"
    assert json.loads((data / "host-network.json").read_text())["interfaces"] == []


def test_timestamp_is_utc_iso8601(tmp_path):
    out = hn(tmp_path, "utc_now").stdout.strip()
    stamp = datetime.fromisoformat(out.replace("Z", "+00:00"))
    assert out.endswith("Z") and abs((datetime.now(timezone.utc) - stamp).total_seconds()) < 60


def test_runs_as_a_script_and_prints_nothing(tmp_path):
    data = tmp_path / "data"; data.mkdir()
    bindir = tmp_path / "bin"; bindir.mkdir()
    (bindir / "ip").write_text(f"#!/bin/sh\ncat '{tmp_path / 'ip.json'}'\n"); (bindir / "ip").chmod(0o755)
    (tmp_path / "ip.json").write_text(IP_JSON)
    (bindir / "uname").write_text("#!/bin/sh\necho Linux\n"); (bindir / "uname").chmod(0o755)
    env = {**os.environ, "KIOSK_DIR": str(tmp_path), "KIOSK_DATA_DIR": str(data),
           "PATH": f"{bindir}:{os.environ['PATH']}"}
    r = subprocess.run([BASH, str(HOSTNET_SH)], capture_output=True, text=True, env=env)
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert json.loads((data / "host-network.json").read_text())["interfaces"][0]["ipv4"] == "10.10.48.57"
