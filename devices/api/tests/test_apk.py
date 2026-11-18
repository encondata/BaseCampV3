"""APK inspection against the two signed fixtures (see fixtures/README.md)."""

import io
import random
import re
import struct
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from serversherpa_devices.packages import PackageError, apk, inspect_package
from serversherpa_devices.packages.apk import inspect_apk
from serversherpa_devices.packages.ipa import inspect_ipa

FIXTURES = Path(__file__).parent / "fixtures"
# What `apksigner verify --print-certs` prints for each fixture's signer.
KEY_A_DIGEST = "2eb648de103c7514530f1d0a85f492a5e924ad53e4e94700b0115e19575f1e1f"
KEY_B_DIGEST = "96c8b9d024605bc3455e7779a9b4efe5c57f69a5b3d528d152b2cb7710ca39a4"


def test_apk_reads_identity_and_digest():
    info = inspect_apk(FIXTURES / "hello-a.apk")
    assert info.platform == "android"
    assert info.identifier == "com.example.hello"
    assert info.build == "1"
    assert info.build_sort == 1
    assert info.version_name == "1.0"
    assert info.name == "Hello Fixture"
    assert info.min_os == "26"
    assert info.provision is None
    assert re.fullmatch(r"[0-9a-f]{64}", info.signing_digest)
    assert info.signing_digest == KEY_A_DIGEST
    icon = Image.open(io.BytesIO(info.icon_png))
    assert icon.format == "PNG" and icon.size == (48, 48)


def test_apk_two_keys_differ():
    first = inspect_apk(FIXTURES / "hello-a.apk")
    second = inspect_apk(FIXTURES / "hello-a2.apk")
    assert second.identifier == first.identifier
    assert (second.build, second.build_sort, second.version_name) == ("2", 2, "1.1")
    assert second.signing_digest == KEY_B_DIGEST
    assert second.signing_digest != first.signing_digest


def test_inspect_package_dispatches_apk():
    assert inspect_package(FIXTURES / "hello-a.apk").platform == "android"


def test_garbage_file_raises_package_error(tmp_path):
    garbage = tmp_path / "upload.apk"
    garbage.write_bytes(b"\x00not a zip at all\xff" * 64)
    other_zip = tmp_path / "notes.zip"
    with zipfile.ZipFile(other_zip, "w") as zf:
        zf.writestr("readme.txt", "hello")
    cases = [(garbage, inspect_package), (garbage, inspect_apk), (garbage, inspect_ipa),
             (other_zip, inspect_package), (other_zip, inspect_apk)]
    for path, inspect in cases:
        with pytest.raises(PackageError) as caught:
            inspect(path)
        assert caught.value.message == "This isn't an APK or IPA"
        assert str(caught.value) == "This isn't an APK or IPA"


def test_apk_with_broken_manifest_raises_package_error(tmp_path):
    broken = tmp_path / "broken.apk"
    with zipfile.ZipFile(broken, "w") as zf:
        zf.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00garbage")
    with pytest.raises(PackageError):
        inspect_apk(broken)


def _zip_declaring(path, members: dict[str, bytes], declared: dict[str, int]):
    """A stored zip whose central directory claims `declared` uncompressed
    sizes for some members (what a zip bomb would claim, or lie about)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    raw = bytearray(path.read_bytes())
    at = raw.find(b"PK\x01\x02")
    while at >= 0:
        (name_len,) = struct.unpack("<H", raw[at + 28:at + 30])
        name = raw[at + 46:at + 46 + name_len].decode()
        if name in declared:
            raw[at + 24:at + 28] = struct.pack("<I", declared[name])
        at = raw.find(b"PK\x01\x02", at + 46)
    path.write_bytes(bytes(raw))
    return path


@pytest.mark.parametrize("declared", [
    {"AndroidManifest.xml": 32 * 1024 * 1024 + 1},
    {"resources.arsc": 0x7FFFFFFF},
    {"classes.dex": 0x7FFFFFFF, "classes2.dex": 0x7FFFFFFF},   # over 2 GB in all
])
def test_apk_rejects_oversized_manifest_declared_size(tmp_path, monkeypatch, declared):
    def never(*args, **kwargs):
        raise AssertionError("androguard was handed an oversized APK")

    monkeypatch.setattr(apk, "APK", never)
    members = {"AndroidManifest.xml": b"\x03\x00\x08\x00", "resources.arsc": b"",
               "classes.dex": b"", "classes2.dex": b""}
    path = _zip_declaring(tmp_path / "big.apk", members, declared)
    with zipfile.ZipFile(path) as zf:   # the claim is what zipfile reports
        assert {n: zf.getinfo(n).file_size for n in declared} == declared
    with pytest.raises(PackageError) as caught:
        inspect_apk(path)
    assert caught.value.message == "This APK is too large to inspect."


def test_corrupt_apk_raises_package_error(tmp_path):
    from .package_fixtures import flip_member_bytes, patch_central_directory

    def copy(name):
        path = tmp_path / name
        path.write_bytes((FIXTURES / "hello-a.apk").read_bytes())
        return path

    manifest = flip_member_bytes(copy("manifest.apk"), "AndroidManifest.xml")
    with pytest.raises(PackageError):
        inspect_package(manifest)

    version = patch_central_directory(copy("version.apk"), extract_version=147)
    with pytest.raises(PackageError) as caught:
        inspect_apk(version)
    assert caught.value.message == "This isn't an APK or IPA"

    truncated = copy("truncated.apk")
    truncated.write_bytes(truncated.read_bytes()[:5000])
    with pytest.raises(PackageError):
        inspect_package(truncated)

    seed = (FIXTURES / "hello-a.apk").read_bytes()
    rng = random.Random(11)
    mutant = tmp_path / "mutant.apk"
    for _ in range(300):
        raw = bytearray(seed)
        raw[rng.randrange(len(raw))] = rng.randrange(256)
        mutant.write_bytes(bytes(raw))
        try:
            inspect_package(mutant)
        except PackageError:
            pass


def test_androguard_logging_stays_off_the_root_logger(tmp_path, caplog):
    import logging

    # apkInspector warns through the root logger on damaged zips (and calls
    # logging.basicConfig at import); those records go to a quiet named logger.
    quiet: list[logging.LogRecord] = []

    class Collect(logging.Handler):
        def emit(self, record):
            quiet.append(record)

    collector = Collect()
    logging.getLogger("serversherpa_devices.apkinspector").addHandler(collector)
    root_handlers = logging.getLogger().handlers[:]
    seed = (FIXTURES / "hello-a.apk").read_bytes()
    rng = random.Random(11)
    mutant = tmp_path / "mutant.apk"
    try:
        with caplog.at_level(logging.DEBUG):
            for _ in range(300):
                raw = bytearray(seed)
                raw[rng.randrange(len(raw))] = rng.randrange(256)
                mutant.write_bytes(bytes(raw))
                try:
                    inspect_apk(mutant)
                except PackageError:
                    pass
    finally:
        logging.getLogger("serversherpa_devices.apkinspector").removeHandler(collector)
    assert any("local header" in r.getMessage() for r in quiet)
    # (pytest attaches caplog to non-propagating loggers too, so it sees the
    # quiet logger's records; none may come through the root logger.)
    assert not [r for r in caplog.records if r.name == "root"]
    assert all(r.name == "serversherpa_devices.apkinspector"
               for r in caplog.records if "apkInspector" in r.pathname)
    assert logging.getLogger().handlers == root_handlers
