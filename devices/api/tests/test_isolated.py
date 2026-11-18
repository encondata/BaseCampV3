"""Inspection in the limited child process (packages/isolated.py)."""

import sys
import time
import zipfile
from pathlib import Path

import pytest

from serversherpa_devices.packages import PackageError, PackageInfo, inspect_package, isolated
from serversherpa_devices.packages.isolated import FAILED, inspect_package_isolated

from .package_fixtures import (
    gradient_pixels,
    hello_info_plist,
    lying_bomb_apk,
    make_cgbi,
    make_ipa,
    make_provision,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_isolated_inspect_returns_same_info_as_in_process(tmp_path):
    ipa = make_ipa(tmp_path / "Hello.ipa", info=hello_info_plist(), files={
        "Payload/Hello.app/AppIcon60x60@3x.png": make_cgbi(60, 60, gradient_pixels(60, 60)),
        "Payload/Hello.app/embedded.mobileprovision": make_provision(devices=["00008110-0A"]),
    })
    for path in (FIXTURES / "hello-a.apk", ipa):
        isolated_info = inspect_package_isolated(path)
        assert isolated_info == inspect_package(path)
        assert isolated_info.icon_png is not None
    assert inspect_package_isolated(ipa).provision.expires_at.utcoffset().total_seconds() == 0


def test_isolated_inspect_passes_package_errors_through(tmp_path):
    garbage = tmp_path / "x.apk"
    garbage.write_bytes(b"not a zip")
    with pytest.raises(PackageError) as caught:
        inspect_package_isolated(garbage)
    assert caught.value.message == "This isn't an APK or IPA"


def test_isolated_inspect_lying_local_header_bomb_is_package_error(tmp_path):
    # A small APK whose manifest claims 1000 bytes in both headers but
    # inflates far past that: the declared-size gate passes it, and
    # androguard (apkInspector) inflates it with no limit. On Linux the
    # child's 1 GB address-space limit stops it; macOS doesn't enforce
    # RLIMIT_AS, so a 64 MB bomb inflates there and is just an unreadable
    # manifest. Either way the parent survives with a PackageError.
    linux = sys.platform.startswith("linux")
    inflated = (1536 if linux else 64) * 1024 * 1024
    bomb = lying_bomb_apk(tmp_path / "bomb.apk", inflated_bytes=inflated)
    assert bomb.stat().st_size < (2 * 1024 * 1024 if linux else 100 * 1024)
    with zipfile.ZipFile(bomb) as zf:
        assert zf.getinfo("AndroidManifest.xml").file_size == 1000

    try:
        outcome = inspect_package_isolated(bomb)
    except PackageError as err:
        outcome = err
    assert isinstance(outcome, PackageError | PackageInfo)
    if linux:
        assert isinstance(outcome, PackageError) and outcome.message == FAILED


def test_isolated_inspect_timeout(tmp_path, monkeypatch):
    path = FIXTURES / "hello-a.apk"

    def command(script: str):
        return lambda *args, **kwargs: [sys.executable, "-I", "-c", script]

    monkeypatch.setattr(isolated, "_worker_command", command("import time; time.sleep(30)"))
    started = time.monotonic()
    with pytest.raises(PackageError) as caught:
        inspect_package_isolated(path, timeout_seconds=0.5)
    assert caught.value.message == FAILED
    assert time.monotonic() - started < 10

    # Non-zero exits, signals and unexpected output are the same failure.
    for script in ("import sys; sys.exit(3)", "import os, signal; os.kill(os.getpid(), 9)",
                   "raise MemoryError", "print('not json')", "print('[1, 2]')",
                   "print('{\"info\": {\"platform\": \"android\"}}')"):
        monkeypatch.setattr(isolated, "_worker_command", command(script))
        with pytest.raises(PackageError) as caught:
            inspect_package_isolated(path)
        assert caught.value.message == FAILED, script


def test_isolated_output_over_cap_is_package_error(monkeypatch):
    script = "import sys; sys.stdout.write('x' * (17 * 1024 * 1024)); sys.stdout.flush()"
    monkeypatch.setattr(isolated, "_worker_command",
                        lambda *args, **kwargs: [sys.executable, "-I", "-c", script])
    started = time.monotonic()
    with pytest.raises(PackageError) as caught:
        inspect_package_isolated(FIXTURES / "hello-a.apk")
    assert caught.value.message == FAILED
    assert time.monotonic() - started < 10

    # An endless writer is killed at the cap instead of being read forever.
    endless = "import sys\nwhile True: sys.stdout.write('x' * 65536)"
    monkeypatch.setattr(isolated, "_worker_command",
                        lambda *args, **kwargs: [sys.executable, "-I", "-c", endless])
    with pytest.raises(PackageError) as caught:
        inspect_package_isolated(FIXTURES / "hello-a.apk", timeout_seconds=30)
    assert caught.value.message == FAILED
    assert time.monotonic() - started < 20
